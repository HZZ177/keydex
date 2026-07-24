from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationError,
    CheckpointMigrationRepository,
    MigrationStatus,
)
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.storage import init_database
from backend.app.storage.db import Database

TARGET_SUFFIX = ".checkpoint-collapse-v1.tmp"
_CHECKPOINT_TABLES = frozenset(
    {
        "checkpoints_v2",
        "checkpoint_writes_v2",
        "checkpoints",
        "writes",
    }
)
_CONTROL_TABLES = frozenset(
    {
        "checkpoint_migration_state",
        "checkpoint_migration_namespaces",
    }
)


@dataclass(frozen=True)
class TableCopyDigest:
    table: str
    row_count: int
    primary_key_digest: str
    content_digest: str


@dataclass(frozen=True)
class CompactTargetResult:
    target_path: Path
    table_digests: tuple[TableCopyDigest, ...]
    source_query_only: bool


class CompactTargetBuilder:
    def __init__(
        self,
        source_database: Database,
        *,
        serializer: KeydexCompressedSerializer | None = None,
    ) -> None:
        self.source_database = source_database
        self.repository = CheckpointMigrationRepository(source_database)
        self.serializer = serializer or KeydexCompressedSerializer()
        self.target_path = Path(f"{source_database.path}{TARGET_SUFFIX}")

    async def build(self) -> CompactTargetResult:
        required = self.repository.ensure_required()
        if required is None:
            raise CheckpointMigrationError(
                "checkpoint_migration_not_required",
                "当前数据库不需要迁移",
            )
        self.repository.update_progress(
            1_000,
            status=MigrationStatus.COPYING_BUSINESS_DATA,
        )
        try:
            await asyncio.to_thread(self._reset_and_initialize_target)
            await self._initialize_official_tables()
            result = await asyncio.to_thread(self._copy_and_verify_business_tables)
        except CheckpointMigrationError:
            self.repository.fail(
                "checkpoint_migration_business_copy_mismatch",
                "business table copy rejected",
            )
            raise
        except Exception as exc:
            self.repository.fail(
                "checkpoint_migration_business_copy_mismatch",
                f"copy error type={type(exc).__name__}",
            )
            raise CheckpointMigrationError(
                "checkpoint_migration_business_copy_mismatch",
                "业务数据复制校验失败",
            ) from exc
        self.repository.update_progress(
            3_000,
            status=MigrationStatus.COLLAPSING_CHECKPOINTS,
        )
        return result

    def _reset_and_initialize_target(self) -> None:
        resolved_source = self.source_database.path.resolve()
        resolved_target = self.target_path.resolve()
        if resolved_target.parent != resolved_source.parent or resolved_target == resolved_source:
            raise CheckpointMigrationError(
                "checkpoint_migration_target_path_invalid",
                "迁移目标路径无效",
            )
        if self.target_path.exists():
            self.target_path.unlink()
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.target_path}{suffix}")
            if sidecar.exists():
                sidecar.unlink()
        target = init_database(self.target_path)
        with closing(target.connect()) as connection:
            connection.commit()

    async def _initialize_official_tables(self) -> None:
        async with aiosqlite.connect(self.target_path) as connection:
            saver = AsyncSqliteSaver(connection, serde=self.serializer)
            await saver.setup()

    def _copy_and_verify_business_tables(self) -> CompactTargetResult:
        source = self._open_read_only_source()
        target_database = Database(self.target_path)
        try:
            source_query_only = bool(source.execute("pragma query_only").fetchone()[0])
            with closing(target_database.connect()) as target:
                target.execute("pragma foreign_keys = off")
                source_tables = self._user_tables(source)
                target_tables = self._user_tables(target)
                source_business = source_tables - _CHECKPOINT_TABLES - _CONTROL_TABLES
                target_business = target_tables - _CHECKPOINT_TABLES - _CONTROL_TABLES
                unknown_source = source_business - target_business
                if unknown_source:
                    raise CheckpointMigrationError(
                        "checkpoint_migration_unknown_business_table",
                        "source contains an unsupported business table",
                    )
                table_names = sorted(source_business)
                plans = [
                    self._copy_columns(source, target, table)
                    for table in table_names
                ]
                target.execute("begin immediate")
                try:
                    for table in reversed(table_names):
                        target.execute(f"delete from {self._quote(table)}")
                    for index, (table, columns) in enumerate(
                        zip(table_names, plans, strict=True),
                        start=1,
                    ):
                        self._copy_table(source, target, table, columns)
                        progress = 1_000 + int(1_800 * index / max(len(table_names), 1))
                        self.repository.update_progress(progress)
                    self._copy_control_tables(source, target)
                    target.commit()
                except Exception:
                    target.rollback()
                    raise
                target.execute("pragma foreign_keys = on")
                foreign_key_errors = target.execute("pragma foreign_key_check").fetchall()
                if foreign_key_errors:
                    raise CheckpointMigrationError(
                        "checkpoint_migration_business_copy_mismatch",
                        "target foreign key validation failed",
                    )
                integrity = target.execute("pragma integrity_check").fetchone()[0]
                if str(integrity).lower() != "ok":
                    raise CheckpointMigrationError(
                        "checkpoint_migration_business_copy_mismatch",
                        "target integrity validation failed",
                    )
                digests = tuple(
                    self._verify_table(source, target, table, columns)
                    for table, columns in zip(table_names, plans, strict=True)
                )
                self._verify_target_indexes(target)
                return CompactTargetResult(
                    target_path=self.target_path,
                    table_digests=digests,
                    source_query_only=source_query_only,
                )
        finally:
            source.close()

    def _open_read_only_source(self) -> sqlite3.Connection:
        uri = f"file:{self.source_database.path.resolve().as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("pragma query_only = on")
        return connection

    @classmethod
    def _copy_columns(
        cls,
        source: sqlite3.Connection,
        target: sqlite3.Connection,
        table: str,
    ) -> tuple[str, ...]:
        source_info = source.execute(
            f"pragma table_info({cls._quote(table)})"
        ).fetchall()
        target_info = target.execute(
            f"pragma table_info({cls._quote(table)})"
        ).fetchall()
        source_columns = tuple(str(row["name"]) for row in source_info)
        target_by_name = {str(row["name"]): row for row in target_info}
        missing = set(source_columns) - set(target_by_name)
        if missing:
            raise CheckpointMigrationError(
                "checkpoint_migration_unknown_business_column",
                "source contains unsupported business columns",
            )
        for row in target_info:
            name = str(row["name"])
            if name in source_columns:
                continue
            if int(row["notnull"]) and row["dflt_value"] is None and not int(row["pk"]):
                raise CheckpointMigrationError(
                    "checkpoint_migration_target_column_unfillable",
                    "target requires a column without a migration default",
                )
        return source_columns

    @classmethod
    def _copy_table(
        cls,
        source: sqlite3.Connection,
        target: sqlite3.Connection,
        table: str,
        columns: tuple[str, ...],
    ) -> None:
        quoted_columns = ", ".join(cls._quote(column) for column in columns)
        placeholders = ", ".join("?" for _ in columns)
        insert_sql = (
            f"insert into {cls._quote(table)} ({quoted_columns}) "
            f"values ({placeholders})"
        )
        cursor = source.execute(
            f"select {quoted_columns} from {cls._quote(table)}"
        )
        while rows := cursor.fetchmany(500):
            target.executemany(
                insert_sql,
                [tuple(row[column] for column in columns) for row in rows],
            )

    @classmethod
    def _copy_control_tables(
        cls,
        source: sqlite3.Connection,
        target: sqlite3.Connection,
    ) -> None:
        for table in (
            "checkpoint_migration_state",
            "checkpoint_migration_namespaces",
        ):
            if table not in cls._user_tables(source):
                continue
            target.execute(f"delete from {cls._quote(table)}")
            columns = cls._copy_columns(source, target, table)
            cls._copy_table(source, target, table, columns)

    @classmethod
    def _verify_table(
        cls,
        source: sqlite3.Connection,
        target: sqlite3.Connection,
        table: str,
        columns: tuple[str, ...],
    ) -> TableCopyDigest:
        source_digest = cls._table_digest(source, table, columns)
        target_digest = cls._table_digest(target, table, columns)
        if source_digest != target_digest:
            raise CheckpointMigrationError(
                "checkpoint_migration_business_copy_mismatch",
                "business table digest mismatch",
            )
        return source_digest

    @classmethod
    def _table_digest(
        cls,
        connection: sqlite3.Connection,
        table: str,
        columns: tuple[str, ...],
    ) -> TableCopyDigest:
        info = connection.execute(
            f"pragma table_info({cls._quote(table)})"
        ).fetchall()
        primary_keys = tuple(
            str(row["name"])
            for row in sorted(info, key=lambda row: int(row["pk"]))
            if int(row["pk"])
        )
        order_columns = primary_keys or columns
        quoted_columns = ", ".join(cls._quote(column) for column in columns)
        order_by = ", ".join(cls._quote(column) for column in order_columns)
        rows = connection.execute(
            f"select {quoted_columns} from {cls._quote(table)} order by {order_by}"
        )
        content = hashlib.sha256()
        primary = hashlib.sha256()
        count = 0
        positions = {column: index for index, column in enumerate(columns)}
        for row in rows:
            count += 1
            values = tuple(row[column] for column in columns)
            cls._update_digest(content, values)
            if primary_keys:
                cls._update_digest(
                    primary,
                    tuple(values[positions[column]] for column in primary_keys),
                )
            else:
                cls._update_digest(primary, values)
        return TableCopyDigest(
            table=table,
            row_count=count,
            primary_key_digest=primary.hexdigest(),
            content_digest=content.hexdigest(),
        )

    @staticmethod
    def _update_digest(digest: Any, values: tuple[Any, ...]) -> None:
        for value in values:
            if value is None:
                digest.update(b"N")
            elif isinstance(value, bytes):
                digest.update(b"B")
                digest.update(value)
            else:
                encoded = str(value).encode("utf-8")
                digest.update(b"T")
                digest.update(encoded)
            digest.update(b"\0")

    @classmethod
    def _verify_target_indexes(cls, target: sqlite3.Connection) -> None:
        missing_index_tables = [
            table
            for table in cls._user_tables(target) - _CHECKPOINT_TABLES - _CONTROL_TABLES
            if target.execute(
                """
                select count(*) from sqlite_master
                where type = 'index' and tbl_name = ?
                """,
                (table,),
            ).fetchone()[0]
            == 0
            and target.execute(
                f"select count(*) from pragma_table_info({cls._quote(table)}) where pk > 0"
            ).fetchone()[0]
            == 0
        ]
        if missing_index_tables:
            raise CheckpointMigrationError(
                "checkpoint_migration_business_copy_mismatch",
                "target schema is missing expected indexes",
            )

    @staticmethod
    def _user_tables(connection: sqlite3.Connection) -> set[str]:
        return {
            str(row["name"])
            for row in connection.execute(
                """
                select name from sqlite_master
                where type = 'table' and name not like 'sqlite_%'
                """
            ).fetchall()
        }

    @staticmethod
    def _quote(identifier: str) -> str:
        return f'"{identifier.replace(chr(34), chr(34) * 2)}"'
