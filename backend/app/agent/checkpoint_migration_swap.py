from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint_migration import (
    MIGRATION_ID,
    CheckpointMigrationError,
    CheckpointMigrationRepository,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_copy import TARGET_SUFFIX
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.storage.db import Database

BACKUP_SUFFIX = ".checkpoint-collapse-v1.backup"
JOURNAL_SUFFIX = ".checkpoint-collapse-v1.swap.json"


class InjectedSwapCrash(RuntimeError):
    pass


class AtomicCheckpointDatabaseSwap:
    def __init__(
        self,
        active_database: Database,
        *,
        serializer: KeydexCompressedSerializer | None = None,
    ) -> None:
        self.active_database = active_database
        self.repository = CheckpointMigrationRepository(active_database)
        self.active_path = active_database.path
        self.target_path = Path(f"{self.active_path}{TARGET_SUFFIX}")
        self.backup_path = Path(f"{self.active_path}{BACKUP_SUFFIX}")
        self.journal_path = Path(f"{self.active_path}{JOURNAL_SUFFIX}")
        self.serializer = serializer or KeydexCompressedSerializer()

    def prepare_active_path_for_startup(self) -> bool:
        """Repair the active pathname before generic schema initialization opens it."""
        if not self.journal_path.exists():
            return False
        journal = self._read_journal()
        phase = str(journal.get("phase") or "")
        if self.active_path.exists():
            return True
        if phase in {"prepared", "source_backed_up"}:
            if self.target_path.exists() and self.backup_path.exists():
                self._activate_target()
                self._write_journal(
                    "target_active",
                    str(journal.get("source_db_fingerprint") or ""),
                )
                return True
            if self.backup_path.exists():
                os.replace(self.backup_path, self.active_path)
                self._fsync_file(self.active_path)
                self.journal_path.unlink()
                return True
        if phase == "target_active":
            if self.target_path.exists():
                self._activate_target()
                return True
            if self.backup_path.exists():
                os.replace(self.backup_path, self.active_path)
                self._fsync_file(self.active_path)
                self.journal_path.unlink()
                return True
        raise CheckpointMigrationError(
            "checkpoint_migration_recovery_required",
            "数据库切换状态不完整，需要恢复",
        )

    async def swap(self, *, crash_after_phase: str | None = None) -> None:
        record = self.repository.get()
        if record is None:
            raise CheckpointMigrationError(
                "checkpoint_migration_not_required",
                "当前数据库不需要迁移",
            )
        if not self.target_path.exists():
            raise CheckpointMigrationError(
                "checkpoint_migration_target_missing",
                "紧凑目标数据库不存在",
            )
        self.repository.update_progress(
            8_500,
            status=MigrationStatus.READY_TO_SWAP,
        )
        await asyncio.to_thread(self._prepare_files)
        self._write_journal("prepared", record.source_db_fingerprint)
        self._crash_if_requested(crash_after_phase, "prepared")
        # Keep the two pathname mutations on the event-loop thread. They are
        # bounded local filesystem operations, and yielding to the shared worker
        # pool after removing app.db lets unrelated background work recreate an
        # empty SQLite file before the compact target is activated on Windows.
        self._rename_source_to_backup()
        self._write_journal("source_backed_up", record.source_db_fingerprint)
        self._crash_if_requested(crash_after_phase, "source_backed_up")
        self._activate_target()
        self._write_journal("target_active", record.source_db_fingerprint)
        self._crash_if_requested(crash_after_phase, "target_active")
        await self._finish_or_restore()

    async def recover(self) -> bool:
        if not self.journal_path.exists():
            return False
        journal = self._read_journal()
        phase = str(journal.get("phase") or "")
        if phase == "prepared":
            if self.active_path.exists() and self.target_path.exists():
                await asyncio.to_thread(self._rename_source_to_backup)
                self._write_journal(
                    "source_backed_up",
                    str(journal.get("source_db_fingerprint") or ""),
                )
                phase = "source_backed_up"
        if phase == "source_backed_up":
            if (
                not self.active_path.exists()
                and self.backup_path.exists()
                and self.target_path.exists()
            ):
                await asyncio.to_thread(self._activate_target)
                self._write_journal(
                    "target_active",
                    str(journal.get("source_db_fingerprint") or ""),
                )
                phase = "target_active"
        if phase == "target_active":
            await self._finish_or_restore()
            return True
        raise CheckpointMigrationError(
            "checkpoint_migration_recovery_required",
            "数据库切换状态不完整，需要恢复",
        )

    def _prepare_files(self) -> None:
        if self.backup_path.exists():
            self.backup_path.unlink()
        for path in (self.active_path, self.target_path):
            self._checkpoint_and_close(path)
            self._fsync_file(path)
            self._remove_sidecars(path)

    @staticmethod
    def _checkpoint_and_close(path: Path) -> None:
        connection = sqlite3.connect(path, timeout=30.0)
        try:
            connection.execute("pragma wal_checkpoint(truncate)").fetchall()
            connection.commit()
        finally:
            connection.close()

    def _rename_source_to_backup(self) -> None:
        if not self.active_path.exists():
            raise CheckpointMigrationError(
                "checkpoint_migration_swap_failed",
                "active source disappeared before backup",
            )
        os.replace(self.active_path, self.backup_path)
        self._fsync_file(self.backup_path)

    def _activate_target(self) -> None:
        if not self.target_path.exists():
            raise CheckpointMigrationError(
                "checkpoint_migration_swap_failed",
                "verified target disappeared before activation",
            )
        os.replace(self.target_path, self.active_path)
        self._fsync_file(self.active_path)

    async def _finish_or_restore(self) -> None:
        try:
            await self._smoke_check()
            repository = CheckpointMigrationRepository(Database(self.active_path))
            repository.update_progress(
                10_000,
                status=MigrationStatus.COMPLETED,
            )
            await self._smoke_check(require_completed=True)
        except Exception as exc:
            await asyncio.to_thread(self._restore_backup)
            restored = CheckpointMigrationRepository(Database(self.active_path))
            restored.ensure_schema()
            restored.fail(
                "checkpoint_migration_swap_failed",
                f"smoke check error type={type(exc).__name__}",
            )
            raise CheckpointMigrationError(
                "checkpoint_migration_swap_failed",
                "新数据库启动校验失败，已恢复旧数据库",
            ) from exc
        await asyncio.to_thread(self._cleanup_success)

    async def _smoke_check(self, *, require_completed: bool = False) -> None:
        async with aiosqlite.connect(self.active_path) as connection:
            saver = AsyncSqliteSaver(connection, serde=self.serializer)
            await saver.setup()
            integrity = await connection.execute_fetchall("pragma integrity_check")
            if integrity != [("ok",)]:
                raise CheckpointMigrationError(
                    "checkpoint_migration_swap_failed",
                    "active target integrity check failed",
                )
            tables = {
                str(row[0])
                for row in await connection.execute_fetchall(
                    "select name from sqlite_master where type = 'table'"
                )
            }
            compatibility_tables = {
                "checkpoints_v2",
                "checkpoint_writes_v2",
            }
            if compatibility_tables & tables:
                guard_rows = await connection.execute_fetchall(
                    """
                    select required_backend from checkpoint_backend_guard
                    where id = 1
                    """
                ) if "checkpoint_backend_guard" in tables else []
                legacy_payload = await connection.execute_fetchall(
                    """
                    select
                      (select count(*) from checkpoints_v2)
                      + (select count(*) from checkpoint_writes_v2)
                    """
                )
                if (
                    compatibility_tables - tables
                    or guard_rows != [("official_async_sqlite_delta_v1",)]
                    or legacy_payload != [(0,)]
                ):
                    raise CheckpointMigrationError(
                        "checkpoint_migration_swap_failed",
                        "active target still contains legacy checkpoint payload",
                    )
            state_rows = await connection.execute_fetchall(
                """
                select status from checkpoint_migration_state
                where migration_id = ?
                """,
                (MIGRATION_ID,),
            )
            if len(state_rows) != 1:
                raise CheckpointMigrationError(
                    "checkpoint_migration_swap_failed",
                    "active target migration state missing",
                )
            if require_completed and state_rows[0][0] != MigrationStatus.COMPLETED.value:
                raise CheckpointMigrationError(
                    "checkpoint_migration_swap_failed",
                    "active target completion state missing",
                )
            invalid_roots = await connection.execute_fetchall(
                """
                select count(*) from checkpoints
                where parent_checkpoint_id is not null
                """
            )
            if invalid_roots[0][0]:
                raise CheckpointMigrationError(
                    "checkpoint_migration_swap_failed",
                    "active target contains a non-root migrated checkpoint",
                )

    def _restore_backup(self) -> None:
        if not self.backup_path.exists():
            raise CheckpointMigrationError(
                "checkpoint_migration_recovery_required",
                "旧数据库备份不存在",
            )
        if self.active_path.exists():
            if self.target_path.exists():
                self.target_path.unlink()
            os.replace(self.active_path, self.target_path)
        os.replace(self.backup_path, self.active_path)
        self._remove_sidecars(self.active_path)
        if self.journal_path.exists():
            self.journal_path.unlink()

    def _cleanup_success(self) -> None:
        if self.backup_path.exists():
            self.backup_path.unlink()
        if self.target_path.exists():
            self.target_path.unlink()
        self._remove_sidecars(self.active_path)
        self._remove_sidecars(self.target_path)
        self._remove_sidecars(self.backup_path)
        if self.journal_path.exists():
            self.journal_path.unlink()

    def _write_journal(self, phase: str, fingerprint: str) -> None:
        payload = {
            "migration_id": MIGRATION_ID,
            "phase": phase,
            "source_db_fingerprint": fingerprint,
            "active_path": str(self.active_path),
            "target_path": str(self.target_path),
            "backup_path": str(self.backup_path),
        }
        temporary = Path(f"{self.journal_path}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.journal_path)
        self._fsync_file(self.journal_path)

    def _read_journal(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.journal_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CheckpointMigrationError(
                "checkpoint_migration_recovery_required",
                "数据库切换恢复日志损坏",
            ) from exc
        if (
            payload.get("migration_id") != MIGRATION_ID
            or payload.get("active_path") != str(self.active_path)
            or payload.get("target_path") != str(self.target_path)
            or payload.get("backup_path") != str(self.backup_path)
        ):
            raise CheckpointMigrationError(
                "checkpoint_migration_recovery_required",
                "数据库切换恢复日志与当前文件不匹配",
            )
        return payload

    @staticmethod
    def _remove_sidecars(path: Path) -> None:
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{path}{suffix}")
            if sidecar.exists():
                sidecar.unlink()

    @staticmethod
    def _fsync_file(path: Path) -> None:
        # Windows rejects FlushFileBuffers (used by os.fsync) for a read-only
        # handle. Open the SQLite/journal file without truncating it, but with
        # write access so the durability barrier works on every supported OS.
        with path.open("r+b") as handle:
            os.fsync(handle.fileno())

    @staticmethod
    def _crash_if_requested(requested: str | None, phase: str) -> None:
        if requested == phase:
            raise InjectedSwapCrash(phase)
