from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import BinaryIO

from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import CHECKPOINT_MIGRATION_SCHEMA_SQL, Database

MIGRATION_ID = "checkpoint-v2-collapse-to-official-v1"
SOURCE_SCHEMA = "keydex-checkpoint-v2"
TARGET_SCHEMA = "langgraph-sqlite-3.1.0-collapse-v1"
LOCK_SUFFIX = ".checkpoint-collapse-v1.lock"
MIN_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024


class MigrationStatus(StrEnum):
    PENDING = "pending"
    PREFLIGHTING = "preflighting"
    COPYING_BUSINESS_DATA = "copying_business_data"
    COLLAPSING_CHECKPOINTS = "collapsing_checkpoints"
    VERIFYING_TARGET = "verifying_target"
    READY_TO_SWAP = "ready_to_swap"
    SWAPPING = "swapping"
    SMOKE_CHECKING = "smoke_checking"
    COMPLETED = "completed"
    FAILED = "failed"


class CheckpointMigrationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class MigrationRecord:
    migration_id: str
    status: MigrationStatus
    source_db_fingerprint: str
    progress_basis_points: int
    source_checkpoint_count: int
    source_write_count: int
    ui_acknowledged_at: str | None
    error_code: str | None
    started_at: str | None
    completed_at: str | None
    updated_at: str

    @property
    def user_percent(self) -> int:
        if self.status is MigrationStatus.COMPLETED:
            return 100
        return min(self.progress_basis_points, 9_900) // 100


@dataclass(frozen=True)
class MigrationInventory:
    thread_count: int
    namespace_count: int
    checkpoint_count: int
    write_count: int
    session_count: int
    message_count: int
    trace_count: int
    fork_count: int
    subagent_count: int
    orphan_write_count: int
    broken_parent_count: int
    running_trace_count: int
    active_subagent_count: int
    approval_count: int
    pending_input_count: int
    empty_history_session_count: int
    max_history_floor: int
    shared_active_thread_count: int
    changed_active_thread_count: int
    source_db_bytes: int
    source_wal_bytes: int
    page_count: int
    freelist_count: int
    estimated_target_bytes: int
    free_disk_bytes: int

    def to_safe_dict(self) -> dict[str, int]:
        return {
            field: int(getattr(self, field))
            for field in self.__dataclass_fields__
        }


class MigrationFileLock:
    """Non-blocking OS lock; lock-file existence alone never means ownership."""

    def __init__(self, database_path: Path | str) -> None:
        self.path = Path(f"{Path(database_path)}{LOCK_SUFFIX}")
        self._handle: BinaryIO | None = None

    @property
    def acquired(self) -> bool:
        return self._handle is not None

    def acquire(self) -> bool:
        if self._handle is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
            os.fsync(handle.fileno())
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self._handle = handle
        return True

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
            self._handle = None

    def __enter__(self) -> MigrationFileLock:
        if not self.acquire():
            raise CheckpointMigrationError(
                "checkpoint_migration_locked",
                "另一个 Keydex 进程正在迁移会话数据",
            )
        return self

    def __exit__(self, *_args: object) -> None:
        self.release()


class CheckpointMigrationRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    def ensure_schema(self) -> None:
        with self.database.connect() as connection:
            connection.executescript(CHECKPOINT_MIGRATION_SCHEMA_SQL)
            if self._table_exists(connection, "sessions"):
                for name, definition in (
                    ("checkpoint_lineage_epoch", "integer not null default 0"),
                    (
                        "checkpoint_history_floor_turn_index",
                        "integer not null default 0",
                    ),
                    ("checkpoint_root_id", "text"),
                    ("checkpoint_collapsed_at", "text"),
                    ("checkpoint_migration_id", "text"),
                ):
                    Database._ensure_column(connection, "sessions", name, definition)

    def get(self) -> MigrationRecord | None:
        self.ensure_schema()
        with self.database.connect() as connection:
            row = connection.execute(
                """
                select *
                from checkpoint_migration_state
                where migration_id = ?
                """,
                (MIGRATION_ID,),
            ).fetchone()
        return self._record(row) if row is not None else None

    def ensure_required(self) -> MigrationRecord | None:
        self.ensure_schema()
        existing = self.get()
        with self.database.connect() as connection:
            if self._table_exists(connection, "checkpoint_backend_guard"):
                return existing
            checkpoint_count = self._count(connection, "checkpoints_v2")
            write_count = self._count(connection, "checkpoint_writes_v2")
            if checkpoint_count == 0 and write_count == 0:
                return existing
            fingerprint = self._source_fingerprint(connection)
            now = to_iso_z(utc_now())
            if existing is not None:
                if (
                    existing.status is not MigrationStatus.COMPLETED
                    and existing.source_db_fingerprint != fingerprint
                ):
                    self.fail(
                        "checkpoint_migration_source_changed",
                        "source fingerprint changed",
                    )
                    return self.get()
                return existing
            connection.execute(
                """
                insert into checkpoint_migration_state (
                  migration_id, source_schema, target_schema, status,
                  source_db_fingerprint, source_checkpoint_count,
                  source_write_count, updated_at
                ) values (?, ?, ?, 'pending', ?, ?, ?, ?)
                """,
                (
                    MIGRATION_ID,
                    SOURCE_SCHEMA,
                    TARGET_SCHEMA,
                    fingerprint,
                    checkpoint_count,
                    write_count,
                    now,
                ),
            )
            connection.commit()
        return self.get()

    def preflight(
        self,
        *,
        free_disk_bytes: int | None = None,
    ) -> tuple[MigrationRecord, MigrationInventory]:
        required = self.ensure_required()
        if required is None:
            raise CheckpointMigrationError(
                "checkpoint_migration_not_required",
                "当前数据库不需要迁移",
            )
        if required.status is MigrationStatus.COMPLETED:
            return required, self.inventory(free_disk_bytes=free_disk_bytes)
        self._update_status(
            MigrationStatus.PREFLIGHTING,
            started=True,
            error_code=None,
            error_detail=None,
        )
        inventory = self.inventory(free_disk_bytes=free_disk_bytes)
        if inventory.orphan_write_count:
            self.fail(
                "checkpoint_migration_orphan_writes",
                f"orphan_write_count={inventory.orphan_write_count}",
            )
        elif inventory.broken_parent_count:
            self.fail(
                "checkpoint_migration_broken_parent",
                f"broken_parent_count={inventory.broken_parent_count}",
            )
        elif (
            inventory.free_disk_bytes
            < inventory.estimated_target_bytes + MIN_FREE_SPACE_RESERVE_BYTES
        ):
            self.fail(
                "checkpoint_migration_insufficient_space",
                "target estimate exceeds safe free space",
            )
        failed = self.get()
        assert failed is not None
        if failed.status is MigrationStatus.FAILED:
            raise CheckpointMigrationError(
                failed.error_code or "checkpoint_migration_preflight_failed",
                "checkpoint migration preflight failed",
            )
        self._persist_inventory(inventory)
        self._seed_namespace_details()
        self.update_progress(500, status=MigrationStatus.PREFLIGHTING)
        record = self.get()
        assert record is not None
        return record, inventory

    def inventory(self, *, free_disk_bytes: int | None = None) -> MigrationInventory:
        with self.database.connect() as connection:
            checkpoint_count = self._count(connection, "checkpoints_v2")
            write_count = self._count(connection, "checkpoint_writes_v2")
            namespace_count = self._scalar(
                connection,
                """
                select count(*) from (
                  select thread_id, checkpoint_ns from checkpoints_v2
                  group by thread_id, checkpoint_ns
                )
                """,
            )
            thread_count = self._scalar(
                connection,
                "select count(distinct thread_id) from checkpoints_v2",
            )
            orphan_write_count = self._scalar(
                connection,
                """
                select count(*)
                from checkpoint_writes_v2 as w
                left join checkpoints_v2 as c
                  on c.thread_id = w.thread_id
                 and c.checkpoint_ns = w.checkpoint_ns
                 and c.checkpoint_id = w.checkpoint_id
                where c.checkpoint_id is null
                """,
            )
            broken_parent_count = self._scalar(
                connection,
                """
                select count(*)
                from checkpoints_v2 as child
                left join checkpoints_v2 as parent
                  on parent.thread_id = child.thread_id
                 and parent.checkpoint_ns = child.checkpoint_ns
                 and parent.checkpoint_id = child.parent_checkpoint_id
                where child.parent_checkpoint_id is not null
                  and parent.checkpoint_id is null
                """,
            )
            floor_rows = self._rows_if_table(
                connection,
                """
                select s.id, coalesce(max(m.turn_index), -1) + 1 as history_floor
                from sessions as s
                left join message_events as m
                  on m.session_id = s.id and m.is_deleted = 0
                group by s.id
                """,
                required_tables=("sessions", "message_events"),
            )
            page_count = self._scalar(connection, "pragma page_count")
            freelist_count = self._scalar(connection, "pragma freelist_count")
            source_db_bytes = (
                self.database.path.stat().st_size if self.database.path.exists() else 0
            )
            wal_path = Path(f"{self.database.path}-wal")
            source_wal_bytes = wal_path.stat().st_size if wal_path.exists() else 0
            estimated_target_bytes = self._estimate_target_bytes(
                connection,
                source_db_bytes=source_db_bytes,
            )
            disk_free = (
                int(free_disk_bytes)
                if free_disk_bytes is not None
                else shutil.disk_usage(self.database.path.parent).free
            )
            return MigrationInventory(
                thread_count=thread_count,
                namespace_count=namespace_count,
                checkpoint_count=checkpoint_count,
                write_count=write_count,
                session_count=self._count(connection, "sessions"),
                message_count=self._count(connection, "message_events"),
                trace_count=self._count(connection, "trace_record"),
                fork_count=self._count(connection, "session_forks"),
                subagent_count=self._count(connection, "subagent_run"),
                orphan_write_count=orphan_write_count,
                broken_parent_count=broken_parent_count,
                running_trace_count=self._count_where(
                    connection,
                    "trace_record",
                    "status in ('running', 'started', 'streaming')",
                ),
                active_subagent_count=self._count_where(
                    connection,
                    "subagent_run",
                    "state in ('queued', 'running')",
                ),
                approval_count=self._count_where(
                    connection,
                    "command_approval_requests",
                    "status in ('pending', 'waiting') and is_deleted = 0",
                ),
                pending_input_count=self._count_where(
                    connection,
                    "session_pending_inputs",
                    "status in ('pending_steer', 'queued', 'starting', 'running')",
                ),
                empty_history_session_count=sum(
                    1 for row in floor_rows if int(row["history_floor"]) == 0
                ),
                max_history_floor=max(
                    (int(row["history_floor"]) for row in floor_rows),
                    default=0,
                ),
                shared_active_thread_count=self._shared_active_thread_count(connection),
                changed_active_thread_count=self._count_where(
                    connection,
                    "sessions",
                    "active_session_id is not null and active_session_id <> id",
                ),
                source_db_bytes=source_db_bytes,
                source_wal_bytes=source_wal_bytes,
                page_count=page_count,
                freelist_count=freelist_count,
                estimated_target_bytes=estimated_target_bytes,
                free_disk_bytes=disk_free,
            )

    def retry(self) -> MigrationRecord:
        record = self.get()
        if record is None:
            required = self.ensure_required()
            if required is None:
                raise CheckpointMigrationError(
                    "checkpoint_migration_not_required",
                    "当前数据库不需要迁移",
                )
            return required
        if record.status is not MigrationStatus.FAILED:
            return record
        self._update_status(
            MigrationStatus.PENDING,
            error_code=None,
            error_detail=None,
        )
        retried = self.get()
        assert retried is not None
        return retried

    def resume_interrupted(self) -> MigrationRecord:
        """Return an interrupted non-terminal migration to its idempotent boundary."""
        record = self.get()
        if record is None:
            required = self.ensure_required()
            if required is None:
                raise CheckpointMigrationError(
                    "checkpoint_migration_not_required",
                    "当前数据库不需要迁移",
                )
            return required
        if record.status in {
            MigrationStatus.PENDING,
            MigrationStatus.FAILED,
            MigrationStatus.COMPLETED,
        }:
            return record
        self._update_status(
            MigrationStatus.PENDING,
            error_code=None,
            error_detail=None,
        )
        resumed = self.get()
        assert resumed is not None
        return resumed

    def acknowledge(self) -> MigrationRecord:
        record = self.get()
        if record is None or record.status is not MigrationStatus.COMPLETED:
            raise CheckpointMigrationError(
                "checkpoint_migration_not_completed",
                "迁移完成后才能确认",
            )
        if record.ui_acknowledged_at is None:
            now = to_iso_z(utc_now())
            with self.database.connect() as connection:
                connection.execute(
                    """
                    update checkpoint_migration_state
                    set ui_acknowledged_at = ?, updated_at = ?
                    where migration_id = ? and status = 'completed'
                    """,
                    (now, now, MIGRATION_ID),
                )
                connection.commit()
        acknowledged = self.get()
        assert acknowledged is not None
        return acknowledged

    def update_progress(
        self,
        basis_points: int,
        *,
        status: MigrationStatus | None = None,
    ) -> MigrationRecord:
        record = self.get()
        if record is None:
            raise CheckpointMigrationError(
                "checkpoint_migration_not_required",
                "当前数据库不需要迁移",
            )
        resolved_status = status or record.status
        candidate = max(record.progress_basis_points, int(basis_points))
        candidate = (
            10_000
            if resolved_status is MigrationStatus.COMPLETED
            else min(candidate, 9_900)
        )
        now = to_iso_z(utc_now())
        with self.database.connect() as connection:
            connection.execute(
                """
                update checkpoint_migration_state
                set status = ?, progress_basis_points = ?,
                    progress_updated_at = ?, updated_at = ?,
                    completed_at = case when ? = 'completed'
                      then coalesce(completed_at, ?) else completed_at end
                where migration_id = ?
                """,
                (
                    resolved_status.value,
                    candidate,
                    now,
                    now,
                    resolved_status.value,
                    now,
                    MIGRATION_ID,
                ),
            )
            connection.commit()
        updated = self.get()
        assert updated is not None
        return updated

    def fail(self, code: str, safe_detail: str) -> MigrationRecord:
        self._update_status(
            MigrationStatus.FAILED,
            error_code=code,
            error_detail=safe_detail[:500],
        )
        failed = self.get()
        assert failed is not None
        return failed

    def _persist_inventory(self, inventory: MigrationInventory) -> None:
        now = to_iso_z(utc_now())
        with self.database.connect() as connection:
            connection.execute(
                """
                update checkpoint_migration_state
                set source_db_bytes = ?, source_wal_bytes = ?,
                    source_page_count = ?, source_freelist_count = ?,
                    estimated_target_bytes = ?, free_disk_bytes = ?,
                    source_checkpoint_count = ?, source_write_count = ?,
                    inventory_json = ?, updated_at = ?
                where migration_id = ?
                """,
                (
                    inventory.source_db_bytes,
                    inventory.source_wal_bytes,
                    inventory.page_count,
                    inventory.freelist_count,
                    inventory.estimated_target_bytes,
                    inventory.free_disk_bytes,
                    inventory.checkpoint_count,
                    inventory.write_count,
                    json.dumps(
                        inventory.to_safe_dict(),
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    ),
                    now,
                    MIGRATION_ID,
                ),
            )
            connection.commit()

    def _seed_namespace_details(self) -> None:
        now = to_iso_z(utc_now())
        with self.database.connect() as connection:
            rows = connection.execute(
                """
                select c.thread_id, c.checkpoint_ns,
                       count(distinct c.checkpoint_id) as checkpoint_count,
                       count(w.idx) as write_count
                from checkpoints_v2 as c
                left join checkpoint_writes_v2 as w
                  on w.thread_id = c.thread_id
                 and w.checkpoint_ns = c.checkpoint_ns
                 and w.checkpoint_id = c.checkpoint_id
                group by c.thread_id, c.checkpoint_ns
                order by c.thread_id, c.checkpoint_ns
                """
            ).fetchall()
            for row in rows:
                connection.execute(
                    """
                    insert into checkpoint_migration_namespaces (
                      migration_id, thread_id, checkpoint_ns, status,
                      source_checkpoint_count, source_write_count, updated_at
                    ) values (?, ?, ?, 'pending', ?, ?, ?)
                    on conflict(migration_id, thread_id, checkpoint_ns) do update set
                      source_checkpoint_count = excluded.source_checkpoint_count,
                      source_write_count = excluded.source_write_count,
                      updated_at = excluded.updated_at
                    """,
                    (
                        MIGRATION_ID,
                        row["thread_id"],
                        row["checkpoint_ns"],
                        row["checkpoint_count"],
                        row["write_count"],
                        now,
                    ),
                )
            connection.commit()

    def _source_fingerprint(self, connection: sqlite3.Connection) -> str:
        digest = hashlib.sha256()
        digest.update(str(self.database.path.resolve()).encode("utf-8"))
        for table, columns in (
            (
                "checkpoints_v2",
                "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, "
                "type, checkpoint_blob, metadata",
            ),
            (
                "checkpoint_writes_v2",
                "thread_id, checkpoint_ns, checkpoint_id, task_id, idx, "
                "channel, type, value_blob",
            ),
        ):
            if not self._table_exists(connection, table):
                continue
            rows = connection.execute(
                f"select {columns} from {table} order by 1, 2, 3, 4, 5"
            )
            for row in rows:
                for value in row:
                    if isinstance(value, bytes):
                        digest.update(value)
                    else:
                        digest.update(str(value).encode("utf-8"))
                    digest.update(b"\0")
        return digest.hexdigest()

    def _estimate_target_bytes(
        self,
        connection: sqlite3.Connection,
        *,
        source_db_bytes: int,
    ) -> int:
        legacy_bytes = self._scalar(
            connection,
            """
            select coalesce(sum(length(checkpoint_blob)) + sum(length(metadata)), 0)
            from checkpoints_v2
            """,
        )
        legacy_bytes += self._scalar(
            connection,
            "select coalesce(sum(length(value_blob)), 0) from checkpoint_writes_v2",
        )
        head_bytes = self._scalar(
            connection,
            """
            select coalesce(sum(length(head.checkpoint_blob)) + sum(length(head.metadata)), 0)
            from checkpoints_v2 as head
            where head.rowid in (
              select (
                select candidate.rowid
                from checkpoints_v2 as candidate
                where candidate.thread_id = grouped.thread_id
                  and candidate.checkpoint_ns = grouped.checkpoint_ns
                order by candidate.created_at desc, candidate.checkpoint_id desc
                limit 1
              )
              from checkpoints_v2 as grouped
              group by grouped.thread_id, grouped.checkpoint_ns
            )
            """,
        )
        business_bytes = max(source_db_bytes - legacy_bytes, 0)
        return max(1_048_576, int((business_bytes + head_bytes) * 1.20))

    def _shared_active_thread_count(self, connection: sqlite3.Connection) -> int:
        if not self._table_exists(connection, "sessions"):
            return 0
        return self._scalar(
            connection,
            """
            select count(*) from (
              select active_session_id
              from sessions
              where active_session_id is not null
              group by active_session_id
              having count(*) > 1
            )
            """,
        )

    def _update_status(
        self,
        status: MigrationStatus,
        *,
        started: bool = False,
        error_code: str | None,
        error_detail: str | None,
    ) -> None:
        now = to_iso_z(utc_now())
        with self.database.connect() as connection:
            connection.execute(
                """
                update checkpoint_migration_state
                set status = ?, error_code = ?, error_detail = ?,
                    started_at = case when ? then coalesce(started_at, ?) else started_at end,
                    updated_at = ?
                where migration_id = ?
                """,
                (
                    status.value,
                    error_code,
                    error_detail,
                    int(started),
                    now,
                    now,
                    MIGRATION_ID,
                ),
            )
            connection.commit()

    @staticmethod
    def _record(row: sqlite3.Row) -> MigrationRecord:
        return MigrationRecord(
            migration_id=str(row["migration_id"]),
            status=MigrationStatus(str(row["status"])),
            source_db_fingerprint=str(row["source_db_fingerprint"]),
            progress_basis_points=int(row["progress_basis_points"]),
            source_checkpoint_count=int(row["source_checkpoint_count"] or 0),
            source_write_count=int(row["source_write_count"] or 0),
            ui_acknowledged_at=row["ui_acknowledged_at"],
            error_code=row["error_code"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            updated_at=str(row["updated_at"]),
        )

    @staticmethod
    def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
        return (
            connection.execute(
                "select 1 from sqlite_master where type = 'table' and name = ?",
                (table,),
            ).fetchone()
            is not None
        )

    @classmethod
    def _count(cls, connection: sqlite3.Connection, table: str) -> int:
        if not cls._table_exists(connection, table):
            return 0
        return cls._scalar(connection, f"select count(*) from {table}")

    @classmethod
    def _count_where(
        cls,
        connection: sqlite3.Connection,
        table: str,
        where: str,
    ) -> int:
        if not cls._table_exists(connection, table):
            return 0
        return cls._scalar(connection, f"select count(*) from {table} where {where}")

    @staticmethod
    def _scalar(connection: sqlite3.Connection, query: str) -> int:
        row = connection.execute(query).fetchone()
        return int(row[0] or 0) if row is not None else 0

    @classmethod
    def _rows_if_table(
        cls,
        connection: sqlite3.Connection,
        query: str,
        *,
        required_tables: tuple[str, ...],
    ) -> list[sqlite3.Row]:
        if not all(cls._table_exists(connection, table) for table in required_tables):
            return []
        return list(connection.execute(query).fetchall())


class CheckpointMigrationCoordinator:
    def __init__(self, database: Database) -> None:
        self.repository = CheckpointMigrationRepository(database)
        self.file_lock = MigrationFileLock(database.path)

    def inspect(self) -> MigrationRecord | None:
        return self.repository.ensure_required()

    def start(
        self,
        *,
        free_disk_bytes: int | None = None,
    ) -> MigrationRecord:
        current = self.repository.ensure_required()
        if current is None:
            raise CheckpointMigrationError(
                "checkpoint_migration_not_required",
                "当前数据库不需要迁移",
            )
        if current.status not in {MigrationStatus.PENDING, MigrationStatus.FAILED}:
            return current
        with self.file_lock:
            if current.status is MigrationStatus.FAILED:
                self.repository.retry()
            record, _inventory = self.repository.preflight(
                free_disk_bytes=free_disk_bytes
            )
            return record

    def retry(
        self,
        *,
        free_disk_bytes: int | None = None,
    ) -> MigrationRecord:
        current = self.repository.retry()
        if current.status is not MigrationStatus.PENDING:
            return current
        return self.start(free_disk_bytes=free_disk_bytes)

    def acknowledge(self) -> MigrationRecord:
        return self.repository.acknowledge()
