from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.agent.checkpoint import (
    create_legacy_checkpoint_serializer,
    decode_legacy_checkpoint_metadata,
)
from backend.app.agent.checkpoint_migration import (
    MIGRATION_ID,
    CheckpointMigrationError,
    CheckpointMigrationRepository,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_copy import TARGET_SUFFIX
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import Database


@dataclass(frozen=True)
class NamespaceCollapseResult:
    thread_id: str
    checkpoint_ns: str
    root_checkpoint_id: str
    source_checkpoint_count: int
    source_write_count: int
    preserved_head_write_count: int
    source_head_digest: str
    target_root_digest: str
    hydrate_digest: str


@dataclass(frozen=True)
class CollapseResult:
    namespaces: tuple[NamespaceCollapseResult, ...]
    discarded_checkpoints: int
    discarded_writes: int


class NamespaceCollapseMigrator:
    def __init__(
        self,
        source_database: Database,
        *,
        serializer: KeydexCompressedSerializer | None = None,
    ) -> None:
        self.source_database = source_database
        self.repository = CheckpointMigrationRepository(source_database)
        self.target_path = Path(f"{source_database.path}{TARGET_SUFFIX}")
        self.serializer = serializer or KeydexCompressedSerializer()
        self.legacy_serializer = create_legacy_checkpoint_serializer()

    def collapse(self) -> CollapseResult:
        if not self.target_path.exists():
            raise CheckpointMigrationError(
                "checkpoint_migration_target_missing",
                "紧凑目标数据库不存在",
            )
        source = self._open_read_only_source()
        target = Database(self.target_path).connect()
        try:
            namespaces = source.execute(
                """
                select thread_id, checkpoint_ns
                from checkpoints_v2
                group by thread_id, checkpoint_ns
                order by thread_id, checkpoint_ns
                """
            ).fetchall()
            results: list[NamespaceCollapseResult] = []
            for index, namespace in enumerate(namespaces, start=1):
                result = self._collapse_namespace(
                    source,
                    target,
                    thread_id=str(namespace["thread_id"]),
                    checkpoint_ns=str(namespace["checkpoint_ns"]),
                )
                results.append(result)
                self._persist_source_detail(result)
                self.repository.update_progress(
                    3_000 + int(4_500 * index / max(len(namespaces), 1)),
                    status=MigrationStatus.COLLAPSING_CHECKPOINTS,
                )
            self._apply_lineage_boundaries(target, results)
            discarded_checkpoints = sum(
                item.source_checkpoint_count - 1 for item in results
            )
            discarded_writes = sum(
                item.source_write_count - item.preserved_head_write_count
                for item in results
            )
            self._persist_aggregate(
                target,
                results,
                discarded_checkpoints,
                discarded_writes,
            )
            self.repository.update_progress(
                7_500,
                status=MigrationStatus.VERIFYING_TARGET,
            )
            self._sync_source_state_to_target(target)
            return CollapseResult(
                namespaces=tuple(results),
                discarded_checkpoints=discarded_checkpoints,
                discarded_writes=discarded_writes,
            )
        except CheckpointMigrationError as exc:
            self.repository.fail(
                exc.code,
                "namespace collapse validation failed",
            )
            raise
        except Exception as exc:
            self.repository.fail(
                "checkpoint_migration_hydrate_failed",
                f"collapse error type={type(exc).__name__}",
            )
            raise CheckpointMigrationError(
                "checkpoint_migration_hydrate_failed",
                "checkpoint 迁移根校验失败",
            ) from exc
        finally:
            target.close()
            source.close()

    def _collapse_namespace(
        self,
        source: sqlite3.Connection,
        target: sqlite3.Connection,
        *,
        thread_id: str,
        checkpoint_ns: str,
    ) -> NamespaceCollapseResult:
        rows = source.execute(
            """
            select checkpoint_id, parent_checkpoint_id, type,
                   checkpoint_blob, metadata, created_at
            from checkpoints_v2
            where thread_id = ? and checkpoint_ns = ?
            order by created_at desc, checkpoint_id desc
            """,
            (thread_id, checkpoint_ns),
        ).fetchall()
        if not rows:
            raise CheckpointMigrationError(
                "checkpoint_migration_head_missing",
                "checkpoint namespace head missing",
            )
        head = rows[0]
        self._validate_chain(rows, head_id=str(head["checkpoint_id"]))
        head_writes = source.execute(
            """
            select task_id, idx, channel, type, value_blob
            from checkpoint_writes_v2
            where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
            order by task_id, idx
            """,
            (thread_id, checkpoint_ns, head["checkpoint_id"]),
        ).fetchall()
        source_write_count = int(
            source.execute(
                """
                select count(*) from checkpoint_writes_v2
                where thread_id = ? and checkpoint_ns = ?
                """,
                (thread_id, checkpoint_ns),
            ).fetchone()[0]
        )
        try:
            checkpoint = self.legacy_serializer.loads_typed(
                (str(head["type"]), bytes(head["checkpoint_blob"]))
            )
            metadata = decode_legacy_checkpoint_metadata(
                head["metadata"],
                self.legacy_serializer,
            )
            checkpoint_type, checkpoint_payload = self.serializer.dumps_typed(checkpoint)
            encoded_writes = []
            for row in head_writes:
                value = self.legacy_serializer.loads_typed(
                    (str(row["type"]), bytes(row["value_blob"] or b""))
                )
                value_type, value_payload = self.serializer.dumps_typed(value)
                encoded_writes.append(
                    (
                        str(row["task_id"]),
                        int(row["idx"]),
                        str(row["channel"]),
                        value_type,
                        value_payload,
                    )
                )
        except Exception as exc:
            raise CheckpointMigrationError(
                "checkpoint_serializer_rejected",
                "legacy checkpoint contains an unsupported value",
            ) from exc
        metadata_payload = json.dumps(
            metadata,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        source_digest = self._semantic_digest(checkpoint)
        result = self._write_and_verify_root(
            target,
            thread_id=thread_id,
            checkpoint_ns=checkpoint_ns,
            head=head,
            checkpoint_type=checkpoint_type,
            checkpoint_payload=checkpoint_payload,
            metadata_payload=metadata_payload,
            encoded_writes=encoded_writes,
            source_digest=source_digest,
            source_checkpoint_count=len(rows),
            source_write_count=source_write_count,
        )
        return result

    def _write_and_verify_root(
        self,
        target: sqlite3.Connection,
        *,
        thread_id: str,
        checkpoint_ns: str,
        head: sqlite3.Row,
        checkpoint_type: str,
        checkpoint_payload: bytes,
        metadata_payload: bytes,
        encoded_writes: list[tuple[str, int, str, str, bytes]],
        source_digest: str,
        source_checkpoint_count: int,
        source_write_count: int,
    ) -> NamespaceCollapseResult:
        now = to_iso_z(utc_now())
        target.execute("begin immediate")
        try:
            target.execute(
                "delete from writes where thread_id = ? and checkpoint_ns = ?",
                (thread_id, checkpoint_ns),
            )
            target.execute(
                "delete from checkpoints where thread_id = ? and checkpoint_ns = ?",
                (thread_id, checkpoint_ns),
            )
            target.execute(
                """
                insert into checkpoints (
                  thread_id, checkpoint_ns, checkpoint_id,
                  parent_checkpoint_id, type, checkpoint, metadata
                ) values (?, ?, ?, null, ?, ?, ?)
                """,
                (
                    thread_id,
                    checkpoint_ns,
                    head["checkpoint_id"],
                    checkpoint_type,
                    checkpoint_payload,
                    metadata_payload,
                ),
            )
            target.executemany(
                """
                insert into writes (
                  thread_id, checkpoint_ns, checkpoint_id,
                  task_id, idx, channel, type, value
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        thread_id,
                        checkpoint_ns,
                        head["checkpoint_id"],
                        *write,
                    )
                    for write in encoded_writes
                ],
            )
            row = target.execute(
                """
                select type, checkpoint, parent_checkpoint_id
                from checkpoints
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                """,
                (thread_id, checkpoint_ns, head["checkpoint_id"]),
            ).fetchone()
            if row is None or row["parent_checkpoint_id"] is not None:
                raise CheckpointMigrationError(
                    "checkpoint_migration_hydrate_failed",
                    "target root missing",
                )
            loaded = self.serializer.loads_typed(
                (str(row["type"]), bytes(row["checkpoint"]))
            )
            target_digest = self._semantic_digest(loaded)
            if target_digest != source_digest:
                raise CheckpointMigrationError(
                    "checkpoint_migration_hydrate_failed",
                    "target root digest mismatch",
                )
            self._upsert_target_detail(
                target,
                thread_id=thread_id,
                checkpoint_ns=checkpoint_ns,
                root_checkpoint_id=str(head["checkpoint_id"]),
                source_checkpoint_count=source_checkpoint_count,
                source_write_count=source_write_count,
                preserved_write_count=len(encoded_writes),
                digest=source_digest,
                now=now,
            )
            target.commit()
        except Exception:
            target.rollback()
            raise
        return NamespaceCollapseResult(
            thread_id=thread_id,
            checkpoint_ns=checkpoint_ns,
            root_checkpoint_id=str(head["checkpoint_id"]),
            source_checkpoint_count=source_checkpoint_count,
            source_write_count=source_write_count,
            preserved_head_write_count=len(encoded_writes),
            source_head_digest=source_digest,
            target_root_digest=target_digest,
            hydrate_digest=target_digest,
        )

    @staticmethod
    def _upsert_target_detail(
        target: sqlite3.Connection,
        *,
        thread_id: str,
        checkpoint_ns: str,
        root_checkpoint_id: str,
        source_checkpoint_count: int,
        source_write_count: int,
        preserved_write_count: int,
        digest: str,
        now: str,
    ) -> None:
        target.execute(
            """
            insert into checkpoint_migration_namespaces (
              migration_id, thread_id, checkpoint_ns, status,
              source_checkpoint_count, source_write_count,
              root_checkpoint_id, preserved_head_write_count,
              discarded_checkpoint_count, discarded_write_count,
              source_head_digest, target_root_digest, hydrate_digest,
              completed_at, updated_at
            ) values (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(migration_id, thread_id, checkpoint_ns) do update set
              status = 'completed',
              source_checkpoint_count = excluded.source_checkpoint_count,
              source_write_count = excluded.source_write_count,
              root_checkpoint_id = excluded.root_checkpoint_id,
              preserved_head_write_count = excluded.preserved_head_write_count,
              discarded_checkpoint_count = excluded.discarded_checkpoint_count,
              discarded_write_count = excluded.discarded_write_count,
              source_head_digest = excluded.source_head_digest,
              target_root_digest = excluded.target_root_digest,
              hydrate_digest = excluded.hydrate_digest,
              error_code = null, error_detail = null,
              completed_at = excluded.completed_at,
              updated_at = excluded.updated_at
            """,
            (
                MIGRATION_ID,
                thread_id,
                checkpoint_ns,
                source_checkpoint_count,
                source_write_count,
                root_checkpoint_id,
                preserved_write_count,
                source_checkpoint_count - 1,
                source_write_count - preserved_write_count,
                digest,
                digest,
                digest,
                now,
                now,
            ),
        )

    def _apply_lineage_boundaries(
        self,
        target: sqlite3.Connection,
        results: list[NamespaceCollapseResult],
    ) -> None:
        roots = {
            (item.thread_id, item.checkpoint_ns): item.root_checkpoint_id
            for item in results
        }
        sessions = target.execute(
            "select id, active_session_id from sessions order by id"
        ).fetchall()
        now = to_iso_z(utc_now())
        target.execute("begin immediate")
        try:
            for session in sessions:
                thread_id = str(session["active_session_id"] or session["id"])
                root_id = roots.get((thread_id, ""))
                history = target.execute(
                    """
                    select count(*) as event_count,
                           coalesce(max(turn_index), -1) + 1 as history_floor
                    from message_events
                    where session_id = ? and is_deleted = 0
                    """,
                    (session["id"],),
                ).fetchone()
                target.execute(
                    """
                    update sessions
                    set checkpoint_lineage_epoch = case
                          when checkpoint_migration_id = ?
                            then checkpoint_lineage_epoch
                          else checkpoint_lineage_epoch + 1
                        end,
                        checkpoint_history_floor_turn_index = ?,
                        checkpoint_root_id = ?,
                        checkpoint_collapsed_at = ?,
                        checkpoint_migration_id = ?
                    where id = ?
                    """,
                    (
                        MIGRATION_ID,
                        int(history["history_floor"]),
                        root_id,
                        now,
                        MIGRATION_ID,
                        session["id"],
                    ),
                )
            target.commit()
        except Exception:
            target.rollback()
            raise

    def _persist_source_detail(self, result: NamespaceCollapseResult) -> None:
        now = to_iso_z(utc_now())
        with self.source_database.transaction() as connection:
            connection.execute(
                """
                update checkpoint_migration_namespaces
                set status = 'completed', root_checkpoint_id = ?,
                    preserved_head_write_count = ?,
                    discarded_checkpoint_count = ?,
                    discarded_write_count = ?,
                    source_head_digest = ?, target_root_digest = ?,
                    hydrate_digest = ?, error_code = null, error_detail = null,
                    completed_at = coalesce(completed_at, ?), updated_at = ?
                where migration_id = ? and thread_id = ? and checkpoint_ns = ?
                """,
                (
                    result.root_checkpoint_id,
                    result.preserved_head_write_count,
                    result.source_checkpoint_count - 1,
                    result.source_write_count - result.preserved_head_write_count,
                    result.source_head_digest,
                    result.target_root_digest,
                    result.hydrate_digest,
                    now,
                    now,
                    MIGRATION_ID,
                    result.thread_id,
                    result.checkpoint_ns,
                ),
            )

    def _persist_aggregate(
        self,
        target: sqlite3.Connection,
        results: list[NamespaceCollapseResult],
        discarded_checkpoints: int,
        discarded_writes: int,
    ) -> None:
        values = (
            len(results),
            len(results),
            sum(item.preserved_head_write_count for item in results),
            discarded_checkpoints,
            discarded_writes,
            to_iso_z(utc_now()),
            MIGRATION_ID,
        )
        query = """
            update checkpoint_migration_state
            set migrated_namespaces = ?, created_roots = ?,
                preserved_head_writes = ?, discarded_checkpoints = ?,
                discarded_writes = ?, updated_at = ?
            where migration_id = ?
        """
        target.execute(query, values)
        target.commit()
        with self.source_database.transaction() as source:
            source.execute(query, values)

    def _sync_source_state_to_target(self, target: sqlite3.Connection) -> None:
        with self.source_database.connect() as source:
            row = source.execute(
                """
                select status, progress_basis_points, progress_updated_at,
                       updated_at, error_code, error_detail
                from checkpoint_migration_state where migration_id = ?
                """,
                (MIGRATION_ID,),
            ).fetchone()
        target.execute(
            """
            update checkpoint_migration_state
            set status = ?, progress_basis_points = ?,
                progress_updated_at = ?, updated_at = ?,
                error_code = ?, error_detail = ?
            where migration_id = ?
            """,
            (*tuple(row), MIGRATION_ID),
        )
        target.commit()

    def _semantic_digest(self, value: Any) -> str:
        type_tag, payload = self.serializer.dumps_typed(value)
        digest = hashlib.sha256()
        digest.update(type_tag.encode("utf-8"))
        digest.update(b"\0")
        digest.update(payload)
        return digest.hexdigest()

    @staticmethod
    def _validate_chain(rows: list[sqlite3.Row], *, head_id: str) -> None:
        parents = {
            str(row["checkpoint_id"]): (
                str(row["parent_checkpoint_id"])
                if row["parent_checkpoint_id"] is not None
                else None
            )
            for row in rows
        }
        seen: set[str] = set()
        checkpoint_id: str | None = head_id
        while checkpoint_id is not None:
            if checkpoint_id in seen:
                raise CheckpointMigrationError(
                    "checkpoint_chain_broken",
                    "legacy checkpoint chain contains a cycle",
                )
            seen.add(checkpoint_id)
            if checkpoint_id not in parents:
                raise CheckpointMigrationError(
                    "checkpoint_chain_broken",
                    "legacy checkpoint parent is missing",
                )
            checkpoint_id = parents[checkpoint_id]

    def _open_read_only_source(self) -> sqlite3.Connection:
        uri = f"file:{self.source_database.path.resolve().as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("pragma query_only = on")
        return connection
