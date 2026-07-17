from __future__ import annotations

import os
import hashlib
import json
import secrets
import sqlite3
import stat
import threading
import unicodedata
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime, timedelta
from difflib import unified_diff
from enum import StrEnum
from pathlib import Path
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.security import (
    WorkspacePathError,
    is_relative_to,
    normalize_workspace_root_for_storage,
)
from backend.app.services.file_history_store import (
    FileHistoryBackup,
    FileHistoryStore,
    FileHistoryStoreError,
)
from backend.app.services.file_resources import (
    FileHistoryPath as MultiScopeFileHistoryPath,
    FileHistoryPathError as MultiScopeFileHistoryPathError,
    FileHistoryPathResolver as MultiScopeFileHistoryPathResolver,
    FileResourceIdentity,
    FileResourceScope,
    FileResourceScopeCatalog,
    FileResourceScopeKind,
)
from backend.app.storage import (
    FileHistoryMutationRecord,
    FileHistoryOperationFileRecord,
    FileHistoryOperationRecord,
    FileHistoryPathHeadRecord,
    FileHistorySnapshotEntryRecord,
    FileHistorySnapshotRecord,
    FileHistoryTrackedFileRecord,
    StorageRepositories,
)


class FileSnapshotKind(StrEnum):
    INPUT = "input"
    RESTORE_RESULT = "restore_result"


class FileSnapshotStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    FAILED = "failed"
    SUPERSEDED = "superseded"


class FileHistorySessionStatus(StrEnum):
    READY = "ready"
    DISABLED = "disabled"
    DEGRADED = "degraded"
    BLOCKED = "blocked"


class FileRestoreMode(StrEnum):
    BOTH = "both"
    CODE = "code"
    CONVERSATION = "conversation"


class FileRestoreDecision(StrEnum):
    FULL = "full"
    SAFE_PARTIAL = "safe_partial"
    FORCE_CONFLICTS = "force_conflicts"
    CONVERSATION_ONLY = "conversation_only"
    CANCEL = "cancel"


class FileClassification(StrEnum):
    READY = "ready"
    FORCEABLE_CONFLICT = "forceable_conflict"
    UNRECOVERABLE = "unrecoverable"


class FileOperationStatus(StrEnum):
    PREVIEWED = "previewed"
    RUNNING = "running"
    FULL = "full"
    PARTIAL = "partial"
    CANCELLED = "cancelled"
    FAILED = "failed"
    COMPENSATED = "compensated"
    COMPENSATION_FAILED = "compensation_failed"
    BLOCKED = "blocked"


class FileOperationFileStatus(StrEnum):
    PENDING = "pending"
    RESTORED = "restored"
    FORCED = "forced"
    SKIPPED = "skipped"
    FAILED = "failed"
    COMPENSATED = "compensated"


class FileHistoryErrorCode(StrEnum):
    DISABLED = "file_history_disabled"
    SNAPSHOT_MISSING = "file_snapshot_missing"
    SNAPSHOT_NOT_READY = "file_snapshot_not_ready"
    SNAPSHOT_FAILED = "file_snapshot_failed"
    BACKUP_MISSING = "file_backup_missing"
    BACKUP_CORRUPT = "file_backup_corrupt"
    BACKUP_FAILED = "file_backup_failed"
    WORKSPACE_MISMATCH = "file_workspace_mismatch"
    PATH_UNSAFE = "file_path_unsafe"
    TARGET_UNSUPPORTED = "file_target_unsupported"
    PREVIEW_STALE = "file_preview_stale"
    CONFLICT = "file_restore_conflict"
    UNRECOVERABLE = "file_restore_unrecoverable"
    SESSION_BUSY = "file_restore_session_busy"
    LOCKED = "file_restore_locked"
    TURN_RUNNING = "file_restore_turn_running"
    RESTORE_FAILED = "file_restore_failed"
    CONVERSATION_FAILED = "conversation_restore_failed"
    COMPENSATED = "file_restore_compensated"
    COMPENSATION_FAILED = "file_restore_compensation_failed"
    OPERATION_BLOCKED = "file_restore_blocked"
    REQUEST_CONFLICT = "file_restore_request_conflict"
    INVALID_MODE = "file_restore_invalid_mode"
    INVALID_DECISION = "file_restore_invalid_decision"
    LIMIT_EXCEEDED = "file_history_limit_exceeded"


class FileHistoryError(RuntimeError):
    def __init__(
        self,
        code: FileHistoryErrorCode | str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        http_status: int = 409,
    ) -> None:
        super().__init__(message)
        self.code = str(code)
        self.details = dict(details or {})
        self.http_status = http_status


@dataclass(frozen=True, slots=True)
class FilePreviewItem:
    path: str
    current_state: str
    target_state: str
    classification: FileClassification
    reason_code: str | None = None
    current_hash: str | None = None
    target_hash: str | None = None
    writer_session_id: str | None = None
    binary: bool = False
    truncated: bool = False
    insertions: int = 0
    deletions: int = 0
    diff: str | None = None
    raw_patch: str | None = None
    status: str = "unknown"
    content_kind: str = "text"
    binary_reason: str | None = None
    truncation_state: str = "complete"
    truncation_reason: str | None = None
    can_load_more: bool = False
    patch_direction: str = "current_to_target"
    patch_precision: str = "exact"
    patch_complete: bool = True
    resource_id: str = ""
    scope_kind: str = "workspace"
    scope_identity: str = ""
    scope_label: str = ""
    display_path: str = ""
    absolute_path: str = ""
    requires_full_access: bool = False

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["classification"] = self.classification.value
        return value


@dataclass(frozen=True, slots=True)
class FileRestorePreview:
    operation_id: str
    source: dict[str, Any]
    conversation_available: bool
    code_available: bool
    default_mode: FileRestoreMode
    snapshot_id: str | None
    preview_token: str
    files: tuple[FilePreviewItem, ...] = ()
    insertions: int = 0
    deletions: int = 0
    warnings: tuple[str, ...] = ()
    requires_external_confirmation: bool = False
    external_paths: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "source": dict(self.source),
            "conversation_available": self.conversation_available,
            "code_available": self.code_available,
            "default_mode": self.default_mode.value,
            "snapshot_id": self.snapshot_id,
            "preview_token": self.preview_token,
            "files": [item.to_dict() for item in self.files],
            "insertions": self.insertions,
            "deletions": self.deletions,
            "warnings": list(self.warnings),
            "requires_external_confirmation": self.requires_external_confirmation,
            "external_paths": list(self.external_paths),
        }


@dataclass(frozen=True, slots=True)
class FileRestoreResult:
    operation_id: str
    status: FileOperationStatus
    mode: FileRestoreMode
    decision: FileRestoreDecision
    conversation_rewound: bool
    restored_files: tuple[str, ...] = ()
    skipped_files: tuple[str, ...] = ()
    forced_files: tuple[str, ...] = ()
    failed_files: tuple[str, ...] = ()
    restored_input: str | None = None
    source: dict[str, Any] = field(default_factory=dict)
    error_code: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "status": self.status.value,
            "mode": self.mode.value,
            "decision": self.decision.value,
            "conversation_rewound": self.conversation_rewound,
            "restored_files": list(self.restored_files),
            "skipped_files": list(self.skipped_files),
            "forced_files": list(self.forced_files),
            "failed_files": list(self.failed_files),
            "restored_input": self.restored_input,
            "source": dict(self.source),
            "error_code": self.error_code,
        }


@dataclass(frozen=True, slots=True)
class FileMutationSpec:
    path: str | Path
    kind: str


@dataclass(frozen=True, slots=True)
class ResolvedTargetFile:
    path: FileHistoryPath
    entry: FileHistorySnapshotEntryRecord | None
    resolution: str
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class ResolvedSnapshotTarget:
    snapshot: FileHistorySnapshotRecord
    files: tuple[ResolvedTargetFile, ...]


class FileHistoryPathError(ValueError):
    def __init__(self, code: str, message: str, *, path: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.path = path


@dataclass(frozen=True, slots=True)
class FileHistoryPath:
    absolute_path: Path
    workspace_root: Path
    workspace_identity: str
    canonical_path: str
    display_path: str


class FileHistoryPathResolver:
    """Canonicalizes file-history paths and rejects link/reparse traversal.

    The display path is for UI only. All persistence keys and safety comparisons
    use ``workspace_identity + canonical_path``.
    """

    def __init__(self, workspace_root: str | Path) -> None:
        raw_root = Path(workspace_root).expanduser()
        try:
            resolved_root = raw_root.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise FileHistoryPathError(
                "workspace_not_found",
                "文件回溯工作区不存在或无法解析",
                path=str(workspace_root),
            ) from exc
        if not resolved_root.is_dir():
            raise FileHistoryPathError(
                "workspace_not_directory",
                "文件回溯工作区不是目录",
                path=str(workspace_root),
            )
        self.workspace_root = resolved_root
        self.workspace_identity = normalize_workspace_root_for_storage(resolved_root)

    def resolve(self, raw_path: str | Path) -> FileHistoryPath:
        raw_text = str(raw_path)
        if not raw_text.strip():
            raise FileHistoryPathError("path_empty", "文件回溯路径不能为空")
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = self.workspace_root / candidate
        if os.name == "nt":
            self._reject_windows_segments(candidate)
        try:
            absolute = candidate.resolve(strict=False)
        except (OSError, RuntimeError) as exc:
            raise FileHistoryPathError(
                "path_unresolvable",
                "文件回溯路径无法解析",
                path=raw_text,
            ) from exc
        if not is_relative_to(absolute, self.workspace_root):
            raise FileHistoryPathError(
                "path_outside_workspace",
                "文件回溯路径不在工作区内",
                path=raw_text,
            )
        self._reject_reparse_components(candidate)
        relative = absolute.relative_to(self.workspace_root)
        display = relative.as_posix() or "."
        canonical = unicodedata.normalize("NFC", display)
        if os.name == "nt":
            canonical = canonical.casefold()
        return FileHistoryPath(
            absolute_path=absolute,
            workspace_root=self.workspace_root,
            workspace_identity=self.workspace_identity,
            canonical_path=canonical,
            display_path=display,
        )

    def resolve_stored(self, display_path: str, canonical_path: str) -> FileHistoryPath:
        resolved = self.resolve(display_path)
        expected = unicodedata.normalize("NFC", str(canonical_path).replace("\\", "/"))
        if os.name == "nt":
            expected = expected.casefold()
        if resolved.canonical_path != expected:
            raise FileHistoryPathError(
                "canonical_path_mismatch",
                "文件回溯路径身份与已存记录不一致",
                path=display_path,
            )
        return resolved

    def revalidate(self, path: FileHistoryPath) -> FileHistoryPath:
        if path.workspace_identity != self.workspace_identity:
            raise FileHistoryPathError(
                "workspace_mismatch",
                "文件回溯工作区身份已变化",
                path=path.display_path,
            )
        return self.resolve_stored(path.display_path, path.canonical_path)

    def _reject_reparse_components(self, candidate: Path) -> None:
        """Reject existing symlink/junction/reparse components before restore.

        ``Path.resolve`` prevents a simple escape but would otherwise make an
        in-root symlink look like a regular target. File history intentionally
        does not snapshot link identity, so every reparse component is unsafe.
        """

        try:
            lexical = candidate.absolute()
            lexical.relative_to(self.workspace_root)
        except (OSError, ValueError) as exc:
            raise FileHistoryPathError(
                "path_outside_workspace",
                "文件回溯路径不在工作区内",
                path=str(candidate),
            ) from exc
        current = self.workspace_root
        for part in lexical.relative_to(self.workspace_root).parts:
            current = current / part
            if not current.exists() and not current.is_symlink():
                continue
            try:
                metadata = current.lstat()
            except OSError as exc:
                raise FileHistoryPathError(
                    "path_metadata_unreadable",
                    "文件回溯路径元数据无法读取",
                    path=str(current),
                ) from exc
            file_attributes = int(getattr(metadata, "st_file_attributes", 0) or 0)
            is_reparse = bool(file_attributes & 0x400)
            if stat.S_ISLNK(metadata.st_mode) or is_reparse:
                raise FileHistoryPathError(
                    "path_link_unsafe",
                    "文件回溯不支持符号链接或 Junction 路径",
                    path=str(current),
                )

    def _reject_windows_segments(self, candidate: Path) -> None:
        try:
            relative = candidate.absolute().relative_to(self.workspace_root)
        except (OSError, ValueError):
            return
        reserved_names = {"CON", "PRN", "AUX", "NUL"}
        reserved_names.update({f"COM{index}" for index in range(1, 10)})
        reserved_names.update({f"LPT{index}" for index in range(1, 10)})
        invalid_characters = set('<>:"|?*')
        for segment in relative.parts:
            base_name = segment.split(".", 1)[0].upper()
            if (
                segment.endswith((" ", "."))
                or base_name in reserved_names
                or any(
                    character in invalid_characters or ord(character) < 32
                    for character in segment
                )
            ):
                raise FileHistoryPathError(
                    "path_invalid_windows_name",
                    "文件回溯路径包含 Windows 不允许的名称",
                    path=str(candidate),
                )


# Public compatibility names now point at the multi-scope domain model. Keeping
# the original implementation above temporarily avoids a flag-day rewrite for
# callers that import this module while all service methods use the new globals.
FileHistoryPath = MultiScopeFileHistoryPath
FileHistoryPathError = MultiScopeFileHistoryPathError
FileHistoryPathResolver = MultiScopeFileHistoryPathResolver


def workspace_path_error_code(exc: WorkspacePathError) -> str:
    """Stable adapter for legacy workspace resolution failures."""

    message = str(exc)
    if "不能为空" in message:
        return "path_empty"
    if "不在工作区" in message:
        return "path_outside_workspace"
    return "path_unresolvable"


class FileHistoryService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        data_dir: str | Path,
        enabled: bool = True,
        max_storage_bytes: int = 1_073_741_824,
        max_versions_per_file: int = 1_000,
        max_rewind_points: int = 100,
        retention_days: int = 30,
    ) -> None:
        self.repositories = repositories
        self.repository = repositories.file_history
        self.store = FileHistoryStore(data_dir)
        self.enabled = bool(enabled)
        self.max_storage_bytes = max(1, int(max_storage_bytes))
        self.max_versions_per_file = max(1, int(max_versions_per_file))
        self.max_rewind_points = max(1, min(100, int(max_rewind_points)))
        self.retention_days = max(1, int(retention_days))
        self._snapshot_locks_guard = threading.Lock()
        self._session_locks: dict[str, threading.RLock] = {}
        self._workspace_locks: dict[str, threading.RLock] = {}
        self._resource_locks: dict[str, threading.RLock] = {}

    def _path_resolver(
        self,
        workspace_root: str | Path,
        *,
        allow_external: bool = True,
    ) -> FileHistoryPathResolver:
        catalog = FileResourceScopeCatalog.from_workspaces(
            self.repositories.workspaces.list(limit=500)
        )
        return catalog.resolver(workspace_root, allow_external=allow_external)

    def resolve_resource_keys(
        self,
        workspace_root: str | Path,
        paths: Sequence[str | Path],
    ) -> tuple[str, ...]:
        resolver = self._path_resolver(workspace_root)
        return tuple(sorted({resolver.resolve(path).resource_key for path in paths}))

    def cleanup_history(
        self,
        *,
        orphan_grace_seconds: int = 86_400,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Apply metadata retention, then remove unreferenced artifacts and leases."""

        retention = self._prune_history_metadata(now=now or utc_now())
        referenced = self.repository.list_referenced_artifacts()
        deleted = self.store.cleanup_orphans(
            referenced,
            orphan_grace_seconds=orphan_grace_seconds,
        )
        expired_locks = self.repository.delete_expired_locks()
        return {
            "deleted_artifacts": deleted,
            "expired_locks": expired_locks,
            "usage_bytes": self.store.usage_bytes(),
            **retention,
        }

    def recover_incomplete_operations(self) -> tuple[dict[str, Any], ...]:
        """Recover operations left running by a previous process.

        A running operation that already changed files is compensated from its
        safety snapshot. A running operation with no changed file is closed as
        failed without touching the workspace.
        """

        recovered: list[dict[str, Any]] = []
        for operation in self.repository.list_operations(states=(FileOperationStatus.RUNNING,)):
            files = self.repository.list_operation_files(operation.id)
            changed = [
                item
                for item in files
                if item.result_state
                in (FileOperationFileStatus.RESTORED, FileOperationFileStatus.FORCED)
            ]
            if not changed:
                self.repository.update_operation(
                    operation.id,
                    state=FileOperationStatus.FAILED,
                    error_code="interrupted_before_file_restore",
                    error_detail={"recovered_on_startup": True},
                    completed=True,
                )
                recovered.append({"operation_id": operation.id, "status": "failed"})
                continue
            snapshot_id = operation.target_snapshot_id or operation.active_snapshot_before
            snapshot = self.repository.get_snapshot(snapshot_id) if snapshot_id else None
            if snapshot is None:
                self._block_recovery(
                    operation.id,
                    operation.session_id,
                    "recovery_snapshot_missing",
                )
                recovered.append({"operation_id": operation.id, "status": "blocked"})
                continue
            try:
                self.compensate_operation(
                    operation_id=operation.id,
                    workspace_root=snapshot.workspace_root,
                )
                recovered.append({"operation_id": operation.id, "status": "compensated"})
            except FileHistoryError:
                recovered.append({"operation_id": operation.id, "status": "blocked"})
        return tuple(recovered)

    @contextmanager
    def controlled_write_lease(
        self,
        *,
        session_id: str,
        workspace_root: str | Path,
        resource_keys: Sequence[str] = (),
    ) -> Iterator[None]:
        """Exclude controlled writes from restore execution in this process."""

        resolver = self._path_resolver(workspace_root)
        keys_and_locks = self._coordination_locks(
            session_id=session_id,
            workspace_identity=resolver.workspace_identity,
            resource_keys=resource_keys,
        )
        acquired = self._acquire_local_locks(keys_and_locks)
        if not acquired:
            raise FileHistoryError(
                FileHistoryErrorCode.LOCKED,
                "文件恢复正在占用当前会话或工作区",
                details={"session_id": session_id},
            )
        try:
            self._assert_session_available(session_id, reject_running=False)
            yield
        finally:
            self._release_local_locks(keys_and_locks)

    @contextmanager
    def restore_lease(
        self,
        *,
        session_id: str,
        workspace_root: str | Path,
        operation_id: str,
    ) -> Iterator[None]:
        """Hold Session and Workspace restore leases for the mutation phase only."""

        resolver = self._path_resolver(workspace_root)
        operation_files = self.repository.list_operation_files(operation_id)
        resource_keys = tuple(
            FileResourceIdentity(
                item.scope_kind, item.scope_identity, item.canonical_path
            ).resource_key
            for item in operation_files
        )
        keys_and_locks = self._coordination_locks(
            session_id=session_id,
            workspace_identity=resolver.workspace_identity,
            resource_keys=resource_keys,
        )
        if not self._acquire_local_locks(keys_and_locks):
            raise FileHistoryError(
                FileHistoryErrorCode.LOCKED,
                "文件恢复正在占用当前会话或工作区",
                details={"session_id": session_id},
            )
        lock_keys = tuple(key for key, _ in keys_and_locks)
        persistent_acquired = False
        try:
            self._assert_session_available(session_id, reject_running=True)
            with self.repositories.db.transaction(immediate=True) as conn:
                persistent_acquired = self.repository.acquire_operation_locks(
                    operation_id,
                    lock_keys,
                    conn=conn,
                )
            if not persistent_acquired:
                raise FileHistoryError(
                    FileHistoryErrorCode.LOCKED,
                    "文件恢复锁已被其他操作占用",
                    details={"session_id": session_id},
                )
            yield
        finally:
            if persistent_acquired:
                with self.repositories.db.transaction(immediate=True) as conn:
                    self.repository.release_operation_locks(
                        operation_id,
                        lock_keys,
                        conn=conn,
                    )
            self._release_local_locks(keys_and_locks)

    def make_input_snapshot(
        self,
        *,
        session_id: str,
        active_session_id: str | None,
        trace_id: str | None,
        message_event_id: str,
        workspace_root: str | Path,
    ) -> FileHistorySnapshotRecord:
        """Create the awaited, message-anchored sparse input snapshot."""

        lock = self._snapshot_lock(session_id)
        with lock:
            self._assert_session_available(session_id, reject_running=False)
            existing = self.repository.get_snapshot_by_message(session_id, message_event_id)
            if existing is not None:
                if existing.status != FileSnapshotStatus.READY:
                    raise FileHistoryError(
                        FileHistoryErrorCode.SNAPSHOT_NOT_READY,
                        "该消息的文件快照不可用",
                        details={"snapshot_id": existing.id, "status": existing.status},
                    )
                self._enforce_active_rewind_limit(session_id)
                return existing

            resolver = self._path_resolver(workspace_root)
            snapshot = self._reserve_input_snapshot(
                session_id=session_id,
                active_session_id=active_session_id,
                trace_id=trace_id,
                message_event_id=message_event_id,
                resolver=resolver,
            )
            try:
                entries, tracked_records = self._capture_tracked_state(snapshot, resolver)
                with self.repositories.db.transaction(immediate=True) as conn:
                    self.repository.replace_snapshot_entries(snapshot.id, entries, conn=conn)
                    for tracked in tracked_records:
                        self.repository.upsert_tracked_file(tracked, conn=conn)
                    ready = self.repository.update_snapshot(
                        snapshot.id,
                        status=FileSnapshotStatus.READY,
                        error_code=None,
                        conn=conn,
                    )
                    state = self.repository.get_session_state(session_id, conn=conn)
                    if state is None:
                        raise RuntimeError("file history session state is missing")
                    updated = self.repository.update_session_state(
                        session_id,
                        active_snapshot_id=snapshot.id,
                        state=FileHistorySessionStatus.READY,
                        blocked_reason=None,
                        expected_revision=state.revision,
                        conn=conn,
                    )
                    if ready is None or updated is None:
                        raise RuntimeError("file history snapshot finalize conflict")
            except Exception as exc:
                self.repository.update_snapshot(
                    snapshot.id,
                    status=FileSnapshotStatus.FAILED,
                    error_code=_snapshot_error_code(exc),
                )
                if isinstance(exc, FileHistoryError):
                    raise
                raise FileHistoryError(
                    FileHistoryErrorCode.SNAPSHOT_FAILED,
                    "创建输入前文件快照失败",
                    details={"snapshot_id": snapshot.id, "reason": _snapshot_error_code(exc)},
                ) from exc
            self._enforce_active_rewind_limit(session_id)
            return ready

    def active_lineage(
        self,
        session_id: str,
        *,
        limit: int = 1000,
    ) -> list[FileHistorySnapshotRecord]:
        state = self.repository.get_session_state(session_id)
        if state is None or state.active_snapshot_id is None:
            return []
        lineage: list[FileHistorySnapshotRecord] = []
        visited: set[str] = set()
        current_id: str | None = state.active_snapshot_id
        while current_id and len(lineage) < max(1, limit):
            if current_id in visited:
                raise FileHistoryError(
                    FileHistoryErrorCode.SNAPSHOT_FAILED,
                    "文件快照父链存在循环",
                )
            visited.add(current_id)
            snapshot = self.repository.get_snapshot(current_id)
            if snapshot is None or snapshot.session_id != session_id:
                raise FileHistoryError(
                    FileHistoryErrorCode.SNAPSHOT_MISSING,
                    "活动文件快照链不完整",
                    details={"snapshot_id": current_id},
                )
            lineage.append(snapshot)
            current_id = snapshot.parent_snapshot_id
        if current_id is not None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_FAILED,
                "文件快照父链超过安全上限",
            )
        return lineage

    def _enforce_active_rewind_limit(self, session_id: str) -> int:
        """Permanently retire input anchors older than the newest configured points."""

        lineage = self.active_lineage(session_id, limit=100_000)
        ready_inputs = [
            item
            for item in lineage
            if item.kind == FileSnapshotKind.INPUT and item.status == FileSnapshotStatus.READY
        ]
        retired = 0
        for snapshot in ready_inputs[self.max_rewind_points :]:
            updated = self.repository.update_snapshot(
                snapshot.id,
                status=FileSnapshotStatus.SUPERSEDED,
                error_code="rewind_point_limit",
            )
            if updated is not None:
                retired += 1
        return retired

    def _prune_history_metadata(self, *, now: datetime) -> dict[str, int]:
        normalized_now = now.astimezone(UTC) if now.tzinfo else now.replace(tzinfo=UTC)
        cutoff = normalized_now - timedelta(days=self.retention_days)
        prunable_operation_states = {
            FileOperationStatus.PREVIEWED,
            FileOperationStatus.FULL,
            FileOperationStatus.PARTIAL,
            FileOperationStatus.CANCELLED,
            FileOperationStatus.FAILED,
            FileOperationStatus.COMPENSATED,
        }
        operations = self.repository.list_operations()
        operation_ids = [
            item.id
            for item in operations
            if item.state in prunable_operation_states
            and _parse_timestamp(item.updated_at) < cutoff
        ]
        with self.repositories.db.transaction(immediate=True) as conn:
            deleted_operations = self.repository.delete_operations(operation_ids, conn=conn)
            pinned_targets = self.repository.list_operation_target_snapshot_ids(conn=conn)
            snapshots_by_session = {
                state.session_id: self.repository.list_snapshots(
                    state.session_id,
                    limit=100_000,
                    conn=conn,
                )
                for state in self.repository.list_session_states(conn=conn)
            }
            protected: set[str] = set(pinned_targets)
            for state in self.repository.list_session_states(conn=conn):
                snapshots = snapshots_by_session.get(state.session_id, [])
                by_id = {item.id: item for item in snapshots}
                current_id = state.active_snapshot_id
                is_active = True
                ready_points = 0
                visited: set[str] = set()
                while current_id and current_id not in visited:
                    visited.add(current_id)
                    snapshot = by_id.get(current_id)
                    if snapshot is None:
                        break
                    created_at = _parse_timestamp(snapshot.created_at)
                    if not is_active and created_at < cutoff:
                        break
                    if snapshot.kind == FileSnapshotKind.INPUT:
                        if snapshot.status == FileSnapshotStatus.SUPERSEDED:
                            break
                        if snapshot.status == FileSnapshotStatus.READY:
                            if ready_points >= self.max_rewind_points:
                                break
                            ready_points += 1
                    protected.add(snapshot.id)
                    current_id = snapshot.parent_snapshot_id
                    is_active = False

            snapshot_ids: list[str] = []
            for snapshots in snapshots_by_session.values():
                for snapshot in snapshots:
                    if snapshot.id in protected:
                        continue
                    if (
                        snapshot.status == FileSnapshotStatus.SUPERSEDED
                        or _parse_timestamp(snapshot.updated_at) < cutoff
                    ):
                        snapshot_ids.append(snapshot.id)
            deleted_snapshots = self.repository.delete_snapshots(snapshot_ids, conn=conn)
        return {
            "deleted_operations": deleted_operations,
            "deleted_snapshots": deleted_snapshots,
        }

    def resolve_target(
        self,
        *,
        session_id: str,
        message_event_id: str,
        workspace_root: str | Path,
    ) -> ResolvedSnapshotTarget:
        target = self.repository.get_snapshot_by_message(session_id, message_event_id)
        if target is None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "该消息没有文件快照",
                details={"message_event_id": message_event_id},
                http_status=404,
            )
        if target.status != FileSnapshotStatus.READY:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_NOT_READY,
                "该消息的文件快照不可用",
                details={"snapshot_id": target.id, "status": target.status},
            )
        resolver = self._path_resolver(workspace_root)
        if (
            target.workspace_identity != resolver.workspace_identity
            and normalize_workspace_root_for_storage(target.workspace_root)
            != normalize_workspace_root_for_storage(resolver.workspace_root)
        ):
            raise FileHistoryError(
                FileHistoryErrorCode.WORKSPACE_MISMATCH,
                "文件快照属于其他工作区",
            )
        lineage = self.active_lineage(session_id)
        try:
            target_index = next(index for index, item in enumerate(lineage) if item.id == target.id)
        except StopIteration as exc:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_NOT_READY,
                "该文件快照位于已废弃的未来分支",
                details={"snapshot_id": target.id},
            ) from exc
        active_segment = list(reversed(lineage[: target_index + 1]))
        entries_by_snapshot = {
            item.id: {
                FileResourceIdentity(
                    entry.scope_kind, entry.scope_identity, entry.canonical_path
                ).resource_key: entry
                for entry in self.repository.list_snapshot_entries(item.id)
            }
            for item in active_segment
        }
        target_entries = entries_by_snapshot[target.id]
        tracked = {
            FileResourceIdentity(
                item.scope_kind, item.scope_identity, item.canonical_path
            ).resource_key: item
            for item in self.repository.list_tracked_files(session_id)
        }
        resource_keys = sorted(set(tracked) | set(target_entries))
        resolved_files: list[ResolvedTargetFile] = []
        for resource_key in resource_keys:
            entry = target_entries.get(resource_key)
            resolution = "snapshot"
            if entry is None:
                resolution = "first_version_fallback"
                for snapshot in active_segment:
                    candidate = entries_by_snapshot[snapshot.id].get(resource_key)
                    if candidate is not None and candidate.version == 1:
                        entry = candidate
                        break
            locator = entry if entry is not None else tracked[resource_key]
            display_path = locator.display_path
            try:
                path = resolver.resolve_stored(
                    display_path,
                    locator.canonical_path,
                    scope_kind=locator.scope_kind,
                    scope_identity=locator.scope_identity,
                    scope_root=locator.scope_root,
                    scope_label=locator.scope_label,
                )
            except FileHistoryPathError:
                unsafe_path = FileHistoryPath(
                    absolute_path=Path(locator.scope_root) / display_path,
                    scope_root=Path(locator.scope_root),
                    scope_kind=locator.scope_kind,
                    scope_identity=locator.scope_identity,
                    canonical_path=locator.canonical_path,
                    display_path=display_path,
                    scope_label=locator.scope_label,
                )
                resolved_files.append(
                    ResolvedTargetFile(
                        path=unsafe_path,
                        entry=entry,
                        resolution=resolution,
                        error_code="path_unsafe",
                    )
                )
                continue
            error_code: str | None = None
            if entry is None:
                error_code = "target_backup_unresolved"
            elif entry.state == "file":
                if (
                    entry.backup_file_name is None
                    or entry.content_hash is None
                    or entry.size is None
                ):
                    error_code = "backup_metadata_invalid"
                else:
                    try:
                        self.store.verify_backup(
                            session_id=session_id,
                            backup_file_name=entry.backup_file_name,
                            expected_hash=entry.content_hash,
                            expected_size=entry.size,
                        )
                    except FileHistoryStoreError as exc:
                        error_code = exc.code
            resolved_files.append(
                ResolvedTargetFile(
                    path=path,
                    entry=entry,
                    resolution=resolution,
                    error_code=error_code,
                )
            )
        return ResolvedSnapshotTarget(target, tuple(resolved_files))

    def diff_target(
        self,
        target: ResolvedSnapshotTarget,
    ) -> tuple[tuple[FilePreviewItem, ...], int, int]:
        previews: list[FilePreviewItem] = []
        total_insertions = 0
        total_deletions = 0
        for resolved in target.files:
            preview = self._diff_target_file(target.snapshot.session_id, resolved)
            if preview is None:
                continue
            preview = replace(
                preview,
                resource_id=resolved.path.resource_id,
                scope_kind=resolved.path.scope_kind,
                scope_identity=resolved.path.scope_identity,
                scope_label=resolved.path.scope_label,
                display_path=resolved.path.display_path,
                absolute_path=str(resolved.path.absolute_path),
                requires_full_access=resolved.path.requires_full_access,
            )
            previews.append(preview)
            total_insertions += preview.insertions
            total_deletions += preview.deletions
        return tuple(previews), total_insertions, total_deletions

    def classify_conflicts(
        self,
        *,
        session_id: str,
        target: ResolvedSnapshotTarget,
        files: Sequence[FilePreviewItem],
    ) -> tuple[FilePreviewItem, ...]:
        classified: list[FilePreviewItem] = []
        resolved_by_resource = {item.path.resource_id: item for item in target.files}
        head_records = self.repository.get_path_heads(
            [
                (
                    resolved_by_resource[item.resource_id].path.scope_kind,
                    resolved_by_resource[item.resource_id].path.scope_identity,
                    resolved_by_resource[item.resource_id].path.canonical_path,
                )
                for item in files
                if item.classification == FileClassification.READY
            ]
        )
        heads = {
            (item.scope_kind, item.scope_identity, item.canonical_path): item
            for item in head_records
        }
        for item in files:
            if item.classification != FileClassification.READY:
                classified.append(item)
                continue
            resolved = resolved_by_resource[item.resource_id]
            head = heads.get(
                (
                    resolved.path.scope_kind,
                    resolved.path.scope_identity,
                    resolved.path.canonical_path,
                )
            )
            if head is None:
                classified.append(
                    replace(
                        item,
                        classification=FileClassification.FORCEABLE_CONFLICT,
                        reason_code="external_drift",
                    )
                )
                continue
            head_matches_disk = (
                head.state == item.current_state and head.content_hash == item.current_hash
            )
            if not head_matches_disk:
                classified.append(
                    replace(
                        item,
                        classification=FileClassification.FORCEABLE_CONFLICT,
                        reason_code="external_drift",
                        writer_session_id=head.session_id,
                    )
                )
                continue
            if head.session_id != session_id:
                classified.append(
                    replace(
                        item,
                        classification=FileClassification.FORCEABLE_CONFLICT,
                        reason_code="other_session_write",
                        writer_session_id=head.session_id,
                    )
                )
                continue
            classified.append(replace(item, writer_session_id=head.session_id))
        return tuple(classified)

    def create_preview(
        self,
        *,
        session_id: str,
        active_session_id: str | None,
        message_event_id: str,
        workspace_root: str | Path,
        source: dict[str, Any],
        file_access_mode: str = "workspace_trusted",
    ) -> FileRestorePreview:
        try:
            target = self.resolve_target(
                session_id=session_id,
                message_event_id=message_event_id,
                workspace_root=workspace_root,
            )
        except FileHistoryError as exc:
            if exc.code not in {
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                FileHistoryErrorCode.SNAPSHOT_NOT_READY,
                FileHistoryErrorCode.SNAPSHOT_FAILED,
            }:
                raise
            return self._create_conversation_only_preview(
                session_id=session_id,
                active_session_id=active_session_id,
                message_event_id=message_event_id,
                workspace_root=workspace_root,
                source=source,
                warning=exc.code,
            )
        raw_files, insertions, deletions = self.diff_target(target)
        files = self.classify_conflicts(
            session_id=session_id,
            target=target,
            files=raw_files,
        )
        operation_id = new_id()
        token = secrets.token_urlsafe(32)
        state = self.repository.get_session_state(session_id)
        now = to_iso_z(utc_now())
        operation = FileHistoryOperationRecord(
            id=operation_id,
            request_id=f"preview:{operation_id}",
            session_id=session_id,
            active_session_id=active_session_id,
            target_snapshot_id=target.snapshot.id,
            target_trace_id=target.snapshot.trace_id,
            target_message_event_id=message_event_id,
            workspace_identity=target.snapshot.workspace_identity,
            mode=None,
            decision=None,
            state=FileOperationStatus.PREVIEWED,
            preview_token=token,
            preview_revision=1,
            conversation_rewound=False,
            active_snapshot_before=state.active_snapshot_id if state else None,
            active_snapshot_after=None,
            restored_count=0,
            skipped_count=0,
            forced_count=0,
            error_code=None,
            error_detail={
                "policy_fingerprint": _restore_policy_fingerprint(
                    file_access_mode, target.files
                ),
                "resource_ids": sorted(item.path.resource_id for item in target.files),
            },
            compensation_state="not_needed",
            created_at=now,
            updated_at=now,
        )
        resolved_by_resource = {item.path.resource_id: item for item in target.files}
        operation_files: list[FileHistoryOperationFileRecord] = []
        for preview in files:
            resolved = resolved_by_resource[preview.resource_id]
            entry = resolved.entry
            current_state = preview.current_state
            if current_state not in {"file", "missing"}:
                current_state = "file" if preview.current_hash is not None else "missing"
            target_state = entry.state if entry is not None else "missing"
            operation_files.append(
                FileHistoryOperationFileRecord(
                    operation_id=operation_id,
                    canonical_path=resolved.path.canonical_path,
                    display_path=preview.path,
                    preview_current_state=current_state,
                    preview_current_hash=preview.current_hash,
                    target_state=target_state,
                    target_backup_file_name=entry.backup_file_name if entry else None,
                    target_hash=entry.content_hash if entry else None,
                    target_size=entry.size if entry else None,
                    target_mode=entry.mode if entry else None,
                    classification=preview.classification,
                    reason_code=preview.reason_code,
                    writer_session_id=preview.writer_session_id,
                    user_authorized=False,
                    result_state=FileOperationFileStatus.PENDING,
                    error_code=None,
                    safety_state=None,
                    safety_backup_file_name=None,
                    safety_hash=None,
                    safety_size=None,
                    safety_mode=None,
                    updated_at=now,
                    scope_kind=resolved.path.scope_kind,
                    scope_identity=resolved.path.scope_identity,
                    scope_root=str(resolved.path.scope_root),
                    scope_label=resolved.path.scope_label,
                )
            )
        self.repository.create_operation(operation, operation_files)
        code_available = bool(files)
        warnings = (
            ("file_conflicts_detected",)
            if any(item.classification == FileClassification.FORCEABLE_CONFLICT for item in files)
            else ()
        )
        external_paths = tuple(
            sorted(item.absolute_path for item in files if item.requires_full_access)
        )
        return FileRestorePreview(
            operation_id=operation_id,
            source=dict(source),
            conversation_available=True,
            code_available=code_available,
            default_mode=(FileRestoreMode.BOTH if code_available else FileRestoreMode.CONVERSATION),
            snapshot_id=target.snapshot.id,
            preview_token=token,
            files=files,
            insertions=insertions,
            deletions=deletions,
            warnings=warnings,
            requires_external_confirmation=bool(external_paths),
            external_paths=external_paths,
        )

    def assert_preview_available(self, session_id: str) -> None:
        self._assert_session_available(session_id, reject_running=True)

    def _create_conversation_only_preview(
        self,
        *,
        session_id: str,
        active_session_id: str | None,
        message_event_id: str,
        workspace_root: str | Path,
        source: dict[str, Any],
        warning: str,
    ) -> FileRestorePreview:
        resolver = self._path_resolver(workspace_root)
        operation_id = new_id()
        token = secrets.token_urlsafe(32)
        state = self.repository.get_session_state(session_id)
        now = to_iso_z(utc_now())
        self.repository.create_operation(
            FileHistoryOperationRecord(
                id=operation_id,
                request_id=f"preview:{operation_id}",
                session_id=session_id,
                active_session_id=active_session_id,
                target_snapshot_id=None,
                target_trace_id=str(source.get("trace_id") or "") or None,
                target_message_event_id=message_event_id,
                workspace_identity=resolver.workspace_identity,
                mode=None,
                decision=None,
                state=FileOperationStatus.PREVIEWED,
                preview_token=token,
                preview_revision=1,
                conversation_rewound=False,
                active_snapshot_before=state.active_snapshot_id if state else None,
                active_snapshot_after=None,
                restored_count=0,
                skipped_count=0,
                forced_count=0,
                error_code=None,
                error_detail={},
                compensation_state="not_needed",
                created_at=now,
                updated_at=now,
            )
        )
        return FileRestorePreview(
            operation_id=operation_id,
            source=dict(source),
            conversation_available=True,
            code_available=False,
            default_mode=FileRestoreMode.CONVERSATION,
            snapshot_id=None,
            preview_token=token,
            warnings=(warning,),
        )

    def preflight_preview(
        self,
        *,
        session_id: str,
        operation_id: str,
        preview_token: str,
        mode: FileRestoreMode | str,
        decision: FileRestoreDecision | str,
        workspace_root: str | Path,
        file_access_mode: str = "workspace_trusted",
        confirm_external_paths: bool = False,
    ) -> tuple[
        FileHistoryOperationRecord,
        ResolvedSnapshotTarget | None,
        tuple[FilePreviewItem, ...],
    ]:
        operation = self.repository.get_operation(operation_id)
        if operation is None or operation.session_id != session_id:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "回溯预览 operation 不存在",
                http_status=404,
            )
        if operation.state != FileOperationStatus.PREVIEWED:
            raise FileHistoryError(
                FileHistoryErrorCode.PREVIEW_STALE,
                "回溯预览已被使用或失效",
                details={"operation_id": operation_id, "state": operation.state},
            )
        if not operation.preview_token or not secrets.compare_digest(
            operation.preview_token,
            str(preview_token),
        ):
            raise FileHistoryError(
                FileHistoryErrorCode.PREVIEW_STALE,
                "回溯预览 token 无效",
                details={"operation_id": operation_id},
            )
        parsed_mode, parsed_decision = _validate_mode_decision(mode, decision)
        message_event_id = operation.target_message_event_id
        if not message_event_id:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "回溯预览缺少消息锚点",
            )
        if parsed_mode == FileRestoreMode.CONVERSATION or (
            parsed_decision == FileRestoreDecision.CONVERSATION_ONLY
        ):
            if operation.target_snapshot_id is None:
                return operation, None, ()
            target = self.resolve_target(
                session_id=session_id,
                message_event_id=message_event_id,
                workspace_root=workspace_root,
            )
            if target.snapshot.id != operation.target_snapshot_id:
                raise FileHistoryError(
                    FileHistoryErrorCode.PREVIEW_STALE,
                    "回溯目标快照已变化",
                )
            return operation, target, ()
        target = self.resolve_target(
            session_id=session_id,
            message_event_id=message_event_id,
            workspace_root=workspace_root,
        )
        if target.snapshot.id != operation.target_snapshot_id:
            raise FileHistoryError(
                FileHistoryErrorCode.PREVIEW_STALE,
                "回溯目标快照已变化",
            )
        expected_policy = str(operation.error_detail.get("policy_fingerprint") or "")
        current_policy = _restore_policy_fingerprint(file_access_mode, target.files)
        if not expected_policy or not secrets.compare_digest(expected_policy, current_policy):
            raise FileHistoryError(
                "file_restore_permission_changed",
                "文件访问策略或恢复资源集合在预览后发生变化，请重新预览",
                details={"operation_id": operation_id},
            )
        external_ids = sorted(
            item.path.resource_id for item in target.files if item.path.requires_full_access
        )
        if external_ids and file_access_mode != "full_access":
            raise FileHistoryError(
                "file_restore_full_access_required",
                "恢复工作区外文件需要当前保持完全访问权限",
                details={"resource_ids": external_ids},
            )
        if external_ids and not confirm_external_paths:
            raise FileHistoryError(
                "file_restore_external_confirmation_required",
                "恢复工作区外文件需要显式确认绝对路径",
                details={"resource_ids": external_ids},
            )
        persisted = self.repository.list_operation_files(operation_id)
        raw_files, _, _ = self.diff_target(target)
        current_files = self.classify_conflicts(
            session_id=session_id,
            target=target,
            files=raw_files,
        )
        current_signatures = {_preview_signature(item.resource_id, item) for item in current_files}
        persisted_signatures = {
            (
                FileResourceIdentity(
                    item.scope_kind, item.scope_identity, item.canonical_path
                ).resource_id,
                item.preview_current_state,
                item.preview_current_hash,
                item.target_state,
                item.target_hash,
                item.classification,
                item.reason_code,
            )
            for item in persisted
        }
        if current_signatures != persisted_signatures:
            raise FileHistoryError(
                FileHistoryErrorCode.PREVIEW_STALE,
                "文件在预览后发生变化，请重新预览",
                details={"operation_id": operation_id},
            )
        return operation, target, current_files

    def create_safety_snapshots(
        self,
        *,
        operation_id: str,
        workspace_root: str | Path,
        canonical_paths: Sequence[str] | None = None,
    ) -> list[FileHistoryOperationFileRecord]:
        operation = self.repository.get_operation(operation_id)
        if operation is None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "文件恢复 operation 不存在",
                http_status=404,
            )
        resolver = self._path_resolver(workspace_root)
        if operation.workspace_identity != resolver.workspace_identity:
            raise FileHistoryError(
                FileHistoryErrorCode.WORKSPACE_MISMATCH,
                "恢复前安全快照的工作区不一致",
            )
        selected = set(canonical_paths or ())
        operation_files = [
            item
            for item in self.repository.list_operation_files(operation_id)
            if not selected
            or item.canonical_path in selected
            or item.display_path in selected
            or FileResourceIdentity(
                item.scope_kind, item.scope_identity, item.canonical_path
            ).resource_id
            in selected
        ]
        captured: list[tuple[FileHistoryOperationFileRecord, FileHistoryBackup]] = []
        for item in operation_files:
            path = resolver.resolve_stored(
                item.display_path,
                item.canonical_path,
                scope_kind=item.scope_kind,
                scope_identity=item.scope_identity,
                scope_root=item.scope_root,
                scope_label=item.scope_label,
            )
            backup = self.store.create_safety_backup(
                operation_id=operation_id,
                resource_key=path.resource_key,
                source_path=path.absolute_path,
            )
            if (
                backup.state != item.preview_current_state
                or backup.content_hash != item.preview_current_hash
            ):
                raise FileHistoryError(
                    FileHistoryErrorCode.PREVIEW_STALE,
                    "文件在 safety snapshot 前发生变化",
                    details={"path": item.display_path},
                )
            captured.append((item, backup))
        updated: list[FileHistoryOperationFileRecord] = []
        with self.repositories.db.transaction(immediate=True) as conn:
            for item, backup in captured:
                persisted = self.repository.update_operation_file(
                    operation_id,
                    item.canonical_path,
                    scope_kind=item.scope_kind,
                    scope_identity=item.scope_identity,
                    safety_state=backup.state,
                    safety_backup_file_name=backup.backup_file_name,
                    safety_hash=backup.content_hash,
                    safety_size=backup.size,
                    safety_mode=backup.mode,
                    conn=conn,
                )
                if persisted is None:
                    raise RuntimeError("operation file disappeared during safety snapshot")
                updated.append(persisted)
        return updated

    def claim_operation_request(
        self,
        *,
        session_id: str,
        operation_id: str,
        request_id: str,
        mode: FileRestoreMode | str,
        decision: FileRestoreDecision | str,
    ) -> FileHistoryOperationRecord:
        request_id = str(request_id).strip()
        if not request_id:
            raise FileHistoryError(
                FileHistoryErrorCode.REQUEST_CONFLICT,
                "文件回溯 request_id 不能为空",
            )
        parsed_mode, parsed_decision = _validate_mode_decision(mode, decision)
        try:
            with self.repositories.db.transaction(immediate=True) as conn:
                existing = self.repository.get_operation_by_request(
                    session_id,
                    request_id,
                    conn=conn,
                )
                if existing is not None:
                    if existing.id != operation_id:
                        raise FileHistoryError(
                            FileHistoryErrorCode.REQUEST_CONFLICT,
                            "request_id 已用于其他回溯 operation",
                            details={"operation_id": existing.id},
                        )
                    return existing
                operation = self.repository.get_operation(operation_id, conn=conn)
                if operation is None or operation.session_id != session_id:
                    raise FileHistoryError(
                        FileHistoryErrorCode.SNAPSHOT_MISSING,
                        "文件回溯 operation 不存在",
                        http_status=404,
                    )
                if operation.state != FileOperationStatus.PREVIEWED:
                    raise FileHistoryError(
                        FileHistoryErrorCode.REQUEST_CONFLICT,
                        "文件回溯 operation 已由其他请求占用",
                        details={"operation_id": operation_id, "state": operation.state},
                    )
                claimed = self.repository.claim_operation(
                    operation_id,
                    request_id=request_id,
                    mode=parsed_mode,
                    decision=parsed_decision,
                    conn=conn,
                )
                if claimed is None:
                    raise FileHistoryError(
                        FileHistoryErrorCode.REQUEST_CONFLICT,
                        "文件回溯 operation 并发占用失败",
                    )
                return claimed
        except sqlite3.IntegrityError as exc:
            raise FileHistoryError(
                FileHistoryErrorCode.REQUEST_CONFLICT,
                "文件回溯 request_id 冲突",
            ) from exc

    def complete_operation(
        self,
        operation_id: str,
        *,
        status: FileOperationStatus,
        conversation_rewound: bool,
        active_snapshot_after: str | None,
    ) -> FileHistoryOperationRecord:
        files = self.repository.list_operation_files(operation_id)
        restored_count = sum(
            item.result_state
            in {FileOperationFileStatus.RESTORED, FileOperationFileStatus.FORCED}
            for item in files
        )
        skipped_count = sum(
            item.result_state == FileOperationFileStatus.SKIPPED for item in files
        )
        forced_count = sum(
            item.result_state == FileOperationFileStatus.FORCED for item in files
        )
        completed = self.repository.update_operation(
            operation_id,
            state=status,
            conversation_rewound=conversation_rewound,
            active_snapshot_after=active_snapshot_after,
            restored_count=restored_count,
            skipped_count=skipped_count,
            forced_count=forced_count,
            error_code=None,
            completed=True,
        )
        if completed is None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "文件回溯 operation 不存在",
            )
        return completed

    def execute_file_restore(
        self,
        *,
        operation_id: str,
        target: ResolvedSnapshotTarget,
        workspace_root: str | Path,
        canonical_paths: Sequence[str],
        forced_paths: Sequence[str] = (),
        mode: FileRestoreMode = FileRestoreMode.CODE,
    ) -> list[FileHistoryOperationFileRecord]:
        operation = self.repository.get_operation(operation_id)
        if operation is None or operation.target_snapshot_id != target.snapshot.id:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "文件恢复 operation 与目标不匹配",
            )
        resolver = self._path_resolver(workspace_root)
        resolved_by_resource = {
            item.path.resource_id: item for item in target.files
        }
        operation_file_records = self.repository.list_operation_files(operation_id)
        operation_files = {
            FileResourceIdentity(
                item.scope_kind, item.scope_identity, item.canonical_path
            ).resource_id: item
            for item in operation_file_records
        }
        legacy_candidates: dict[str, set[str]] = {}
        for resource_id, item in operation_files.items():
            legacy_candidates.setdefault(item.canonical_path, set()).add(resource_id)
            legacy_candidates.setdefault(item.display_path, set()).add(resource_id)

        def normalize_identifiers(values: Sequence[str]) -> set[str]:
            normalized: set[str] = set()
            for value in values:
                if value in operation_files:
                    normalized.add(value)
                    continue
                candidates = legacy_candidates.get(value, set())
                if len(candidates) == 1:
                    normalized.update(candidates)
                    continue
                normalized.add(value)
            return normalized

        selected = normalize_identifiers(canonical_paths)
        forced = normalize_identifiers(forced_paths)
        restored: list[FileHistoryOperationFileRecord] = []
        restore_plan: list[
            tuple[str, FileHistoryOperationFileRecord, ResolvedTargetFile]
        ] = []
        for resource_id in sorted(selected):
            item = operation_files.get(resource_id)
            resolved = resolved_by_resource.get(resource_id)
            if item is None or resolved is None or resolved.entry is None:
                error = "target_backup_unresolved"
                if item is not None:
                    self.repository.update_operation_file(
                        operation_id,
                        item.canonical_path,
                        scope_kind=item.scope_kind,
                        scope_identity=item.scope_identity,
                        result_state=FileOperationFileStatus.FAILED,
                        error_code=error,
                    )
                self.repository.update_operation(
                    operation_id,
                    state=FileOperationStatus.FAILED,
                    error_code=error,
                )
                raise FileHistoryError(
                    FileHistoryErrorCode.RESTORE_FAILED,
                    "文件恢复目标无法解析",
                    details={
                        "resource_id": resource_id,
                        "restored_resource_ids": [
                            FileResourceIdentity(
                                value.scope_kind, value.scope_identity, value.canonical_path
                            ).resource_id
                            for value in restored
                        ],
                    },
                )
            restore_plan.append((resource_id, item, resolved))

        planned: dict[str, FileHistoryOperationFileRecord] = {}
        with self.repositories.db.transaction(immediate=True) as conn:
            self.repository.update_operation(
                operation_id,
                state=FileOperationStatus.RUNNING,
                mode=mode,
                conn=conn,
            )
            for resource_id, item, _resolved in restore_plan:
                result_state = (
                    FileOperationFileStatus.FORCED
                    if resource_id in forced
                    else FileOperationFileStatus.RESTORED
                )
                persisted = self.repository.update_operation_file(
                    operation_id,
                    item.canonical_path,
                    scope_kind=item.scope_kind,
                    scope_identity=item.scope_identity,
                    result_state=result_state,
                    user_authorized=resource_id in forced,
                    error_code=None,
                    conn=conn,
                )
                if persisted is None:
                    raise RuntimeError("operation file disappeared before restore")
                planned[resource_id] = persisted

        for resource_id, item, resolved in restore_plan:
            try:
                path = resolver.resolve_stored(
                    item.display_path,
                    item.canonical_path,
                    scope_kind=item.scope_kind,
                    scope_identity=item.scope_identity,
                    scope_root=item.scope_root,
                    scope_label=item.scope_label,
                )
                entry = resolved.entry
                self._inject_e2e_restore_failure_once()
                changed = self.store.restore_backup(
                    session_id=operation.session_id,
                    backup=FileHistoryBackup(
                        state=entry.state,
                        backup_file_name=entry.backup_file_name,
                        version=entry.version,
                        backup_time=entry.backup_time,
                        size=entry.size,
                        mode=entry.mode,
                        content_hash=entry.content_hash,
                    ),
                    destination=path.absolute_path,
                )
                restored.append(planned[resource_id])
                if not changed:
                    continue
            except Exception as exc:
                error_code = str(getattr(exc, "code", None) or "restore_failed")
                self.repository.update_operation_file(
                    operation_id,
                    item.canonical_path,
                    scope_kind=item.scope_kind,
                    scope_identity=item.scope_identity,
                    error_code=error_code,
                )
                self.repository.update_operation(
                    operation_id,
                    state=FileOperationStatus.FAILED,
                    error_code=error_code,
                    error_detail={
                        "path": item.display_path,
                        "restored_paths": [value.display_path for value in restored],
                    },
                )
                raise FileHistoryError(
                    FileHistoryErrorCode.RESTORE_FAILED,
                    "文件恢复执行失败",
                    details={
                        "path": item.display_path,
                        "restored_resource_ids": [
                            FileResourceIdentity(
                                value.scope_kind, value.scope_identity, value.canonical_path
                            ).resource_id
                            for value in restored
                        ],
                        "reason": error_code,
                    },
                ) from exc
        return [planned[resource_id] for resource_id, _item, _resolved in restore_plan]

    def _inject_e2e_restore_failure_once(self) -> None:
        """Provide a one-shot restore failure only to the isolated E2E runtime.

        The marker is unreachable in normal product runs because the controlled
        model transport must be explicitly enabled. A positive integer skips
        that many restore writes; zero fails the next write and consumes the
        marker. Compensation deliberately does not call this hook.
        """

        if os.getenv("KEYDEX_E2E_MODEL_TRANSPORT", "").strip().lower() not in {
            "1",
            "true",
            "yes",
            "on",
        }:
            return
        marker = self.store.root / "e2e-restore-fail-once"
        try:
            remaining = int(marker.read_text(encoding="utf-8").strip())
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            marker.unlink(missing_ok=True)
            return
        if remaining > 0:
            marker.write_text(str(remaining - 1), encoding="utf-8")
            return
        marker.unlink(missing_ok=True)
        raise OSError("controlled e2e file restore failure")

    def compensate_operation(
        self,
        *,
        operation_id: str,
        workspace_root: str | Path,
    ) -> list[FileHistoryOperationFileRecord]:
        operation = self.repository.get_operation(operation_id)
        if operation is None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "待补偿的文件恢复 operation 不存在",
                http_status=404,
            )
        resolver = self._path_resolver(workspace_root)
        if operation.workspace_identity != resolver.workspace_identity:
            raise FileHistoryError(
                FileHistoryErrorCode.WORKSPACE_MISMATCH,
                "文件补偿工作区不一致",
            )
        candidates = [
            item
            for item in self.repository.list_operation_files(operation_id)
            if item.result_state
            in {FileOperationFileStatus.RESTORED, FileOperationFileStatus.FORCED}
        ]
        self.repository.update_operation(
            operation_id,
            compensation_state="pending",
        )
        compensated: list[FileHistoryOperationFileRecord] = []
        failures: list[dict[str, str]] = []
        for item in reversed(candidates):
            try:
                path = resolver.resolve_stored(
                    item.display_path,
                    item.canonical_path,
                    scope_kind=item.scope_kind,
                    scope_identity=item.scope_identity,
                    scope_root=item.scope_root,
                    scope_label=item.scope_label,
                )
                current = self._observe(path.absolute_path)
                already_safe = (
                    current.state == item.safety_state
                    and current.content_hash == item.safety_hash
                )
                if (
                    not already_safe
                    and (
                        current.state != item.target_state
                        or current.content_hash != item.target_hash
                    )
                ):
                    raise FileHistoryError(
                        FileHistoryErrorCode.COMPENSATION_FAILED,
                        "补偿前文件已被其他来源再次修改",
                        details={"path": item.display_path, "reason": "compensation_conflict"},
                    )
                if item.safety_state is None:
                    raise FileHistoryError(
                        FileHistoryErrorCode.COMPENSATION_FAILED,
                        "文件补偿缺少 safety snapshot",
                        details={"path": item.display_path},
                    )
                if not already_safe:
                    self.store.restore_backup(
                        session_id=operation.session_id,
                        backup=FileHistoryBackup(
                            state=item.safety_state,
                            backup_file_name=item.safety_backup_file_name,
                            version=1,
                            backup_time=operation.created_at,
                            size=item.safety_size,
                            mode=item.safety_mode,
                            content_hash=item.safety_hash,
                        ),
                        destination=path.absolute_path,
                    )
                with self.repositories.db.transaction(immediate=True) as conn:
                    restored = self.repository.update_operation_file(
                        operation_id,
                        item.canonical_path,
                        scope_kind=item.scope_kind,
                        scope_identity=item.scope_identity,
                        result_state=FileOperationFileStatus.COMPENSATED,
                        error_code=None,
                        conn=conn,
                    )
                    if item.writer_session_id and item.reason_code != "external_drift":
                        self.repository.upsert_path_head(
                            FileHistoryPathHeadRecord(
                                workspace_identity=operation.workspace_identity
                                or resolver.workspace_identity,
                                canonical_path=item.canonical_path,
                                display_path=item.display_path,
                                session_id=item.writer_session_id,
                                trace_id=None,
                                mutation_id=None,
                                state=item.safety_state,
                                content_hash=item.safety_hash,
                                revision=1,
                                updated_at=to_iso_z(utc_now()),
                                scope_kind=item.scope_kind,
                                scope_identity=item.scope_identity,
                                scope_root=item.scope_root,
                                scope_label=item.scope_label,
                            ),
                            conn=conn,
                        )
                if restored is None:
                    raise RuntimeError("operation file disappeared during compensation")
                compensated.append(restored)
            except Exception as exc:
                reason = str(getattr(exc, "code", None) or "compensation_failed")
                failures.append({"path": item.display_path, "reason": reason})
                self.repository.update_operation_file(
                    operation_id,
                    item.canonical_path,
                    scope_kind=item.scope_kind,
                    scope_identity=item.scope_identity,
                    error_code=reason,
                )
        if failures:
            self.repository.update_operation(
                operation_id,
                state=FileOperationStatus.COMPENSATION_FAILED,
                error_code=FileHistoryErrorCode.COMPENSATION_FAILED,
                error_detail={"files": failures},
                compensation_state="failed",
                completed=True,
            )
            state = self.repository.get_session_state(operation.session_id)
            if state is not None:
                self.repository.update_session_state(
                    operation.session_id,
                    state=FileHistorySessionStatus.BLOCKED,
                    blocked_reason=operation_id,
                )
            raise FileHistoryError(
                FileHistoryErrorCode.COMPENSATION_FAILED,
                "文件回溯补偿失败，需要人工处理",
                details={"operation_id": operation_id, "files": failures},
            )
        state = self.repository.get_session_state(operation.session_id)
        if state is not None:
            allowed_cursors = {
                operation.active_snapshot_before,
                operation.active_snapshot_after,
            }
            if state.active_snapshot_id not in allowed_cursors:
                self.repository.update_session_state(
                    operation.session_id,
                    state=FileHistorySessionStatus.BLOCKED,
                    blocked_reason=operation_id,
                )
                raise FileHistoryError(
                    FileHistoryErrorCode.COMPENSATION_FAILED,
                    "补偿期间 active cursor 已被其他操作推进",
                    details={"operation_id": operation_id},
                )
            self.repository.update_session_state(
                operation.session_id,
                active_snapshot_id=operation.active_snapshot_before,
                state=FileHistorySessionStatus.READY,
                blocked_reason=None,
            )
        self.repository.update_operation(
            operation_id,
            state=FileOperationStatus.COMPENSATED,
            error_code=FileHistoryErrorCode.COMPENSATED,
            error_detail={},
            compensation_state="complete",
            completed=True,
        )
        return compensated

    def _diff_target_file(
        self,
        session_id: str,
        resolved: ResolvedTargetFile,
    ) -> FilePreviewItem | None:
        entry = resolved.entry
        if resolved.error_code is not None or entry is None:
            return FilePreviewItem(
                path=resolved.path.display_path,
                current_state="unknown",
                target_state=entry.state if entry is not None else "unknown",
                classification=FileClassification.UNRECOVERABLE,
                reason_code=resolved.error_code or "target_backup_unresolved",
                target_hash=entry.content_hash if entry is not None else None,
            )
        try:
            current = self._observe(resolved.path.absolute_path)
        except FileHistoryError as exc:
            return FilePreviewItem(
                path=resolved.path.display_path,
                current_state="unknown",
                target_state=entry.state,
                classification=FileClassification.UNRECOVERABLE,
                reason_code=exc.code,
                target_hash=entry.content_hash,
            )
        if (
            current.state == entry.state
            and current.content_hash == entry.content_hash
            and (entry.state == "missing" or current.mode == entry.mode)
        ):
            return None
        current_bytes = (
            _read_preview_bytes(resolved.path.absolute_path)
            if current.state == "file"
            else _PreviewBytes(b"", False)
        )
        target_bytes = _PreviewBytes(b"", False)
        if entry.state == "file":
            if (
                entry.backup_file_name is None
                or entry.content_hash is None
                or entry.size is None
            ):
                return FilePreviewItem(
                    path=resolved.path.display_path,
                    current_state=current.state,
                    target_state=entry.state,
                    classification=FileClassification.UNRECOVERABLE,
                    reason_code="backup_metadata_invalid",
                    current_hash=current.content_hash,
                    target_hash=entry.content_hash,
                )
            try:
                backup_path = self.store.verify_backup(
                    session_id=session_id,
                    backup_file_name=entry.backup_file_name,
                    expected_hash=entry.content_hash,
                    expected_size=entry.size,
                )
            except FileHistoryStoreError as exc:
                return FilePreviewItem(
                    path=resolved.path.display_path,
                    current_state=current.state,
                    target_state=entry.state,
                    classification=FileClassification.UNRECOVERABLE,
                    reason_code=exc.code,
                    current_hash=current.content_hash,
                    target_hash=entry.content_hash,
                )
            target_bytes = _read_preview_bytes(backup_path)
        truncated = current_bytes.truncated or target_bytes.truncated
        truncation_reason = "preview_read_limit" if truncated else None
        binary = _looks_binary(current_bytes.data) or _looks_binary(target_bytes.data)
        insertions = 0
        deletions = 0
        diff: str | None = None
        if not binary and not truncated:
            current_text = current_bytes.data.decode("utf-8")
            target_text = target_bytes.data.decode("utf-8")
            current_lines = current_text.splitlines(keepends=True)
            target_lines = target_text.splitlines(keepends=True)
            changes = list(
                unified_diff(
                    current_lines,
                    target_lines,
                    fromfile=f"a/{resolved.path.display_path}",
                    tofile=f"b/{resolved.path.display_path}",
                )
            )
            for line in changes[2:]:
                if line.startswith("+") and not line.startswith("+++"):
                    insertions += 1
                elif line.startswith("-") and not line.startswith("---"):
                    deletions += 1
            rendered = "".join(changes)
            diff = rendered[:100_000]
            if len(rendered) > len(diff):
                truncated = True
                truncation_reason = "render_limit"
                diff = None
        status = (
            "added"
            if current.state == "missing" and entry.state == "file"
            else "deleted"
            if current.state == "file" and entry.state == "missing"
            else "modified"
        )
        return FilePreviewItem(
            path=resolved.path.display_path,
            current_state=current.state,
            target_state=entry.state,
            classification=FileClassification.READY,
            current_hash=current.content_hash,
            target_hash=entry.content_hash,
            binary=binary,
            truncated=truncated,
            insertions=insertions,
            deletions=deletions,
            diff=diff,
            raw_patch=diff,
            status=status,
            content_kind="binary" if binary else "text",
            binary_reason="binary_content" if binary else None,
            truncation_state="unrecoverable" if truncated else "complete",
            truncation_reason=truncation_reason,
            can_load_more=False,
            patch_direction="current_to_target",
            patch_precision="exact",
            patch_complete=not truncated,
        )

    def prepare_writes(
        self,
        *,
        session_id: str,
        active_session_id: str | None,
        snapshot_id: str,
        trace_id: str | None,
        turn_index: int | None,
        workspace_root: str | Path,
        tool_name: str,
        tool_call_id: str | None,
        mutations: Sequence[FileMutationSpec],
        batch_id: str | None = None,
    ) -> list[FileHistoryMutationRecord]:
        self._assert_enabled()
        if not mutations:
            return []
        resolver = self._path_resolver(workspace_root)
        lock = self._snapshot_lock(session_id)
        with lock:
            snapshot = self.repository.get_snapshot(snapshot_id)
            state = self.repository.get_session_state(session_id)
            if (
                snapshot is None
                or snapshot.session_id != session_id
                or snapshot.status != FileSnapshotStatus.READY
            ):
                raise FileHistoryError(
                    FileHistoryErrorCode.SNAPSHOT_NOT_READY,
                    "受控文件写入缺少可用的输入快照",
                    details={"snapshot_id": snapshot_id},
                )
            if state is None or state.active_snapshot_id != snapshot_id:
                raise FileHistoryError(
                    FileHistoryErrorCode.PREVIEW_STALE,
                    "受控文件写入的文件历史基线已变化",
                    details={"snapshot_id": snapshot_id},
                )
            if snapshot.workspace_identity != resolver.workspace_identity:
                raise FileHistoryError(
                    FileHistoryErrorCode.WORKSPACE_MISMATCH,
                    "受控文件写入的工作区与快照不一致",
                )

            resolved_specs: dict[str, tuple[FileMutationSpec, FileHistoryPath]] = {}
            for spec in mutations:
                path = resolver.resolve(spec.path)
                resolved_specs.setdefault(path.resource_key, (spec, path))
            snapshot_entries = {
                FileResourceIdentity(
                    item.scope_kind, item.scope_identity, item.canonical_path
                ).resource_key: item
                for item in self.repository.list_snapshot_entries(snapshot_id)
            }
            mutations_by_resource = {
                FileResourceIdentity(
                    item.scope_kind, item.scope_identity, item.canonical_path
                ).resource_key: item
                for item in self.repository.list_mutations(snapshot_id=snapshot_id)
            }
            tracked_by_resource = {
                FileResourceIdentity(
                    item.scope_kind, item.scope_identity, item.canonical_path
                ).resource_key: item
                for item in self.repository.list_tracked_files(session_id)
            }
            prepared: list[FileHistoryMutationRecord] = []
            new_entries: list[FileHistorySnapshotEntryRecord] = []
            tracked_updates: list[FileHistoryTrackedFileRecord] = []
            now = to_iso_z(utc_now())
            for resource_key, (spec, path) in resolved_specs.items():
                existing = mutations_by_resource.get(resource_key)
                if existing is not None:
                    prepared.append(existing)
                    continue
                entry = snapshot_entries.get(resource_key)
                tracked = tracked_by_resource.get(resource_key)
                if entry is None:
                    version = (tracked.latest_version if tracked else 0) + 1
                    self._assert_backup_capacity(
                        session_id=session_id,
                        canonical_path=resource_key,
                        source_path=path.absolute_path,
                        version=version,
                    )
                    backup = self.store.create_backup(
                        session_id=session_id,
                        resource_key=resource_key,
                        source_path=path.absolute_path,
                        version=version,
                    )
                    entry = _entry_from_backup(snapshot_id, path, backup)
                    new_entries.append(entry)
                    tracked_updates.append(
                        FileHistoryTrackedFileRecord(
                            session_id=session_id,
                            canonical_path=path.canonical_path,
                            display_path=path.display_path,
                            latest_version=version,
                            first_snapshot_id=(tracked.first_snapshot_id if tracked else None)
                            or snapshot_id,
                            last_snapshot_id=snapshot_id,
                            last_observed_state=entry.state,
                            last_observed_hash=entry.content_hash,
                            last_observed_size=entry.size,
                            last_observed_mtime_ns=(
                                path.absolute_path.stat().st_mtime_ns
                                if entry.state == "file"
                                else None
                            ),
                            last_observed_mode=entry.mode,
                            created_at=tracked.created_at if tracked else now,
                            updated_at=now,
                            scope_kind=path.scope_kind,
                            scope_identity=path.scope_identity,
                            scope_root=str(path.scope_root),
                            scope_label=path.scope_label,
                        )
                    )
                prepared.append(
                    FileHistoryMutationRecord(
                        id=new_id(),
                        session_id=session_id,
                        active_session_id=active_session_id,
                        trace_id=trace_id,
                        turn_index=turn_index,
                        snapshot_id=snapshot_id,
                        workspace_identity=path.scope_identity,
                        canonical_path=path.canonical_path,
                        display_path=path.display_path,
                        tool_name=tool_name,
                        tool_call_id=tool_call_id,
                        batch_id=batch_id,
                        mutation_kind=spec.kind,
                        before_state=entry.state,
                        before_hash=entry.content_hash,
                        after_state=None,
                        after_hash=None,
                        status="prepared",
                        error_code=None,
                        created_at=now,
                        updated_at=now,
                        scope_kind=path.scope_kind,
                        scope_identity=path.scope_identity,
                        scope_root=str(path.scope_root),
                        scope_label=path.scope_label,
                    )
                )

            with self.repositories.db.transaction(immediate=True) as conn:
                current_state = self.repository.get_session_state(session_id, conn=conn)
                if current_state is None or current_state.active_snapshot_id != snapshot_id:
                    raise FileHistoryError(
                        FileHistoryErrorCode.PREVIEW_STALE,
                        "文件写入前历史基线被并发改变",
                    )
                for entry in new_entries:
                    self.repository.upsert_snapshot_entry(entry, conn=conn)
                for tracked in tracked_updates:
                    self.repository.upsert_tracked_file(tracked, conn=conn)
                persisted_mutations = {
                    FileResourceIdentity(
                        item.scope_kind, item.scope_identity, item.canonical_path
                    ).resource_key: item
                    for item in self.repository.list_mutations(
                        snapshot_id=snapshot_id,
                        conn=conn,
                    )
                }
                committed: list[FileHistoryMutationRecord] = []
                for mutation in prepared:
                    resource_key = FileResourceIdentity(
                        mutation.scope_kind,
                        mutation.scope_identity,
                        mutation.canonical_path,
                    ).resource_key
                    existing = persisted_mutations.get(resource_key)
                    if existing is not None:
                        committed.append(existing)
                    else:
                        created = self.repository.create_mutation(mutation, conn=conn)
                        persisted_mutations[resource_key] = created
                        committed.append(created)
            return committed

    def commit_writes(
        self,
        mutations: Sequence[FileHistoryMutationRecord],
        *,
        workspace_root: str | Path,
    ) -> list[FileHistoryMutationRecord]:
        if not mutations:
            return []
        resolver = self._path_resolver(workspace_root)
        observations: list[tuple[FileHistoryMutationRecord, _ObservedFile]] = []
        for mutation in mutations:
            path = resolver.resolve_stored(
                mutation.display_path,
                mutation.canonical_path,
                scope_kind=mutation.scope_kind,
                scope_identity=mutation.scope_identity,
                scope_root=mutation.scope_root,
                scope_label=mutation.scope_label,
            )
            observations.append((mutation, self._observe(path.absolute_path)))
        committed: list[FileHistoryMutationRecord] = []
        with self.repositories.db.transaction(immediate=True) as conn:
            head_updates: list[FileHistoryPathHeadRecord] = []
            for mutation, observed in observations:
                current = self.repository.get_mutation(mutation.id, conn=conn)
                if current is None:
                    raise RuntimeError("file history mutation disappeared")
                if current.status == "committed":
                    committed.append(current)
                    continue
                if current.status != "prepared":
                    raise FileHistoryError(
                        FileHistoryErrorCode.REQUEST_CONFLICT,
                        "文件历史 mutation 已终止，不能再次提交",
                        details={"mutation_id": mutation.id, "status": current.status},
                    )
                updated = self.repository.update_mutation(
                    mutation.id,
                    status="committed",
                    after_state=observed.state,
                    after_hash=observed.content_hash,
                    error_code=None,
                    conn=conn,
                )
                if updated is None:
                    raise RuntimeError("file history mutation disappeared")
                head_updates.append(
                    FileHistoryPathHeadRecord(
                        workspace_identity=mutation.workspace_identity,
                        canonical_path=mutation.canonical_path,
                        display_path=mutation.display_path,
                        session_id=mutation.session_id,
                        trace_id=mutation.trace_id,
                        mutation_id=mutation.id,
                        state=observed.state,
                        content_hash=observed.content_hash,
                        revision=1,
                        updated_at=to_iso_z(utc_now()),
                        scope_kind=mutation.scope_kind,
                        scope_identity=mutation.scope_identity,
                        scope_root=mutation.scope_root,
                        scope_label=mutation.scope_label,
                    )
                )
                committed.append(updated)
            self.repository.upsert_path_heads(head_updates, conn=conn)
        return committed

    def abort_writes(
        self,
        mutations: Sequence[FileHistoryMutationRecord],
        *,
        error_code: str = "tool_write_aborted",
    ) -> None:
        with self.repositories.db.transaction(immediate=True) as conn:
            for mutation in mutations:
                current = self.repository.get_mutation(mutation.id, conn=conn)
                if current is None:
                    continue
                if current.status != "prepared":
                    continue
                self.repository.update_mutation(
                    mutation.id,
                    status="aborted",
                    error_code=error_code,
                    conn=conn,
                )

    def compensate_writes(
        self,
        mutations: Sequence[FileHistoryMutationRecord],
        *,
        workspace_root: str | Path,
        error_code: str = "file_history_commit_compensated",
    ) -> tuple[str, ...]:
        """Restore prepared preimages after a post-write history failure."""

        resolver = self._path_resolver(workspace_root)
        restored: list[str] = []
        failures: list[dict[str, str]] = []
        for mutation in reversed(tuple(mutations)):
            try:
                if not mutation.snapshot_id:
                    raise FileHistoryError(
                        FileHistoryErrorCode.BACKUP_MISSING,
                        "写入补偿缺少输入快照",
                    )
                entry = self.repository.get_snapshot_entry(
                    mutation.snapshot_id,
                    mutation.canonical_path,
                    scope_kind=mutation.scope_kind,
                    scope_identity=mutation.scope_identity,
                )
                if entry is None:
                    raise FileHistoryError(
                        FileHistoryErrorCode.BACKUP_MISSING,
                        "写入补偿缺少写前状态",
                    )
                path = resolver.resolve_stored(
                    mutation.display_path,
                    mutation.canonical_path,
                    scope_kind=mutation.scope_kind,
                    scope_identity=mutation.scope_identity,
                    scope_root=mutation.scope_root,
                    scope_label=mutation.scope_label,
                )
                self.store.restore_backup(
                    session_id=mutation.session_id,
                    backup=FileHistoryBackup(
                        state=entry.state,
                        backup_file_name=entry.backup_file_name,
                        version=entry.version,
                        backup_time=entry.backup_time,
                        size=entry.size,
                        mode=entry.mode,
                        content_hash=entry.content_hash,
                    ),
                    destination=path.absolute_path,
                )
                restored.append(path.resource_id)
            except Exception as exc:
                failures.append(
                    {
                        "resource_id": FileResourceIdentity(
                            mutation.scope_kind,
                            mutation.scope_identity,
                            mutation.canonical_path,
                        ).resource_id,
                        "reason": str(getattr(exc, "code", None) or type(exc).__name__),
                    }
                )

        blocked_reason = f"history-write:{mutations[0].batch_id or mutations[0].id}" if mutations else None
        with self.repositories.db.transaction(immediate=True) as conn:
            for mutation in mutations:
                self.repository.update_mutation(
                    mutation.id,
                    status="dirty" if failures else "aborted",
                    error_code=(
                        "file_history_compensation_failed"
                        if failures
                        else error_code
                    ),
                    conn=conn,
                )
            if failures and mutations:
                state = self.repository.get_session_state(mutations[0].session_id, conn=conn)
                if state is not None:
                    self.repository.update_session_state(
                        mutations[0].session_id,
                        state=FileHistorySessionStatus.BLOCKED,
                        blocked_reason=blocked_reason,
                        expected_revision=state.revision,
                        conn=conn,
                    )
        if failures:
            raise FileHistoryError(
                "file_history_compensation_failed",
                "文件历史提交失败，且磁盘补偿未能完整完成；会话已阻塞",
                details={"failures": failures, "restored_resource_ids": restored},
            )
        return tuple(restored)

    def materialize_restore_result(
        self,
        *,
        session_id: str,
        active_session_id: str | None,
        target_snapshot_id: str,
        workspace_root: str | Path,
        trace_id: str | None = None,
        changed_canonical_paths: Sequence[str] = (),
    ) -> FileHistorySnapshotRecord:
        """Persist the actual post-restore disk state and advance the active cursor."""

        resolver = self._path_resolver(workspace_root)
        lock = self._snapshot_lock(session_id)
        with lock:
            target = self.repository.get_snapshot(target_snapshot_id)
            if target is None or target.session_id != session_id or target.status != "ready":
                raise FileHistoryError(
                    FileHistoryErrorCode.SNAPSHOT_NOT_READY,
                    "文件回溯目标快照不可用",
                    details={"snapshot_id": target_snapshot_id},
                )
            if target.workspace_identity != resolver.workspace_identity:
                raise FileHistoryError(
                    FileHistoryErrorCode.WORKSPACE_MISMATCH,
                    "文件回溯目标快照属于其他工作区",
                )
            now = to_iso_z(utc_now())
            with self.repositories.db.transaction(immediate=True) as conn:
                state = self.repository.ensure_session_state(session_id, conn=conn)
                result = FileHistorySnapshotRecord(
                    id=new_id(),
                    session_id=session_id,
                    active_session_id=active_session_id,
                    trace_id=trace_id,
                    user_message_event_id=None,
                    parent_snapshot_id=target_snapshot_id,
                    kind=FileSnapshotKind.RESTORE_RESULT,
                    sequence=state.next_sequence,
                    workspace_root=str(resolver.workspace_root),
                    workspace_identity=resolver.workspace_identity,
                    status=FileSnapshotStatus.PENDING,
                    error_code=None,
                    created_at=now,
                    updated_at=now,
                )
                advanced = self.repository.update_session_state(
                    session_id,
                    next_sequence=state.next_sequence + 1,
                    expected_revision=state.revision,
                    conn=conn,
                )
                if advanced is None:
                    raise FileHistoryError(
                        FileHistoryErrorCode.SESSION_BUSY,
                        "恢复结果快照序号被并发占用",
                    )
                self.repository.create_snapshot(result, conn=conn)
            try:
                read_conn = self.repositories.db.connect()
                try:
                    entries, tracked_records = self._capture_materialized_state(
                        result,
                        resolver,
                        conn=read_conn,
                    )
                finally:
                    read_conn.close()
                entries_by_resource = {
                    FileResourceIdentity(
                        entry.scope_kind,
                        entry.scope_identity,
                        entry.canonical_path,
                    ).resource_id: entry
                    for entry in entries
                }
                legacy_entries: dict[str, list[FileHistorySnapshotEntryRecord]] = {}
                for entry in entries:
                    legacy_entries.setdefault(entry.canonical_path, []).append(entry)
                    legacy_entries.setdefault(entry.display_path, []).append(entry)
                with self.repositories.db.transaction(immediate=True) as conn:
                    self.repository.replace_snapshot_entries(result.id, entries, conn=conn)
                    for tracked in tracked_records:
                        self.repository.upsert_tracked_file(tracked, conn=conn)
                    head_updates: list[FileHistoryPathHeadRecord] = []
                    for resource_id in changed_canonical_paths:
                        entry = entries_by_resource.get(resource_id)
                        if entry is None:
                            candidates = legacy_entries.get(resource_id, [])
                            unique_candidates = {
                                FileResourceIdentity(
                                    candidate.scope_kind,
                                    candidate.scope_identity,
                                    candidate.canonical_path,
                                ).resource_id: candidate
                                for candidate in candidates
                            }
                            if len(unique_candidates) == 1:
                                entry = next(iter(unique_candidates.values()))
                        if entry is None:
                            raise RuntimeError(
                                "restored resource is missing from materialized snapshot"
                            )
                        head_updates.append(
                            FileHistoryPathHeadRecord(
                                workspace_identity=resolver.workspace_identity,
                                canonical_path=entry.canonical_path,
                                display_path=entry.display_path,
                                session_id=session_id,
                                trace_id=trace_id,
                                mutation_id=None,
                                state=entry.state,
                                content_hash=entry.content_hash,
                                revision=1,
                                updated_at=now,
                                scope_kind=entry.scope_kind,
                                scope_identity=entry.scope_identity,
                                scope_root=entry.scope_root,
                                scope_label=entry.scope_label,
                            )
                        )
                    self.repository.upsert_path_heads(head_updates, conn=conn)
                    ready = self.repository.update_snapshot(
                        result.id,
                        status=FileSnapshotStatus.READY,
                        error_code=None,
                        conn=conn,
                    )
                    state = self.repository.get_session_state(session_id, conn=conn)
                    if state is None:
                        raise RuntimeError("file history session state is missing")
                    cursor = self.repository.update_session_state(
                        session_id,
                        active_snapshot_id=result.id,
                        state=FileHistorySessionStatus.READY,
                        blocked_reason=None,
                        expected_revision=state.revision,
                        conn=conn,
                    )
                    if ready is None or cursor is None:
                        raise RuntimeError("restore result cursor update conflict")
                return ready
            except Exception as exc:
                self.repository.update_snapshot(
                    result.id,
                    status=FileSnapshotStatus.FAILED,
                    error_code=_snapshot_error_code(exc),
                )
                raise FileHistoryError(
                    FileHistoryErrorCode.SNAPSHOT_FAILED,
                    "物化恢复后的文件状态失败",
                    details={"snapshot_id": result.id},
                ) from exc

    def _reserve_input_snapshot(
        self,
        *,
        session_id: str,
        active_session_id: str | None,
        trace_id: str | None,
        message_event_id: str,
        resolver: FileHistoryPathResolver,
    ) -> FileHistorySnapshotRecord:
        now = to_iso_z(utc_now())
        with self.repositories.db.transaction(immediate=True) as conn:
            state = self.repository.ensure_session_state(session_id, conn=conn)
            snapshot = FileHistorySnapshotRecord(
                id=new_id(),
                session_id=session_id,
                active_session_id=active_session_id,
                trace_id=trace_id,
                user_message_event_id=message_event_id,
                parent_snapshot_id=state.active_snapshot_id,
                kind=FileSnapshotKind.INPUT,
                sequence=state.next_sequence,
                workspace_root=str(resolver.workspace_root),
                workspace_identity=resolver.workspace_identity,
                status=FileSnapshotStatus.PENDING,
                error_code=None,
                created_at=now,
                updated_at=now,
            )
            updated = self.repository.update_session_state(
                session_id,
                next_sequence=state.next_sequence + 1,
                expected_revision=state.revision,
                conn=conn,
            )
            if updated is None:
                raise FileHistoryError(
                    FileHistoryErrorCode.SESSION_BUSY,
                    "文件快照序号被并发占用",
                )
            self.repository.create_snapshot(snapshot, conn=conn)
        return snapshot

    def _capture_tracked_state(
        self,
        snapshot: FileHistorySnapshotRecord,
        resolver: FileHistoryPathResolver,
    ) -> tuple[list[FileHistorySnapshotEntryRecord], list[FileHistoryTrackedFileRecord]]:
        tracked_files = self.repository.list_tracked_files(snapshot.session_id)
        parent_entries = {
            FileResourceIdentity(
                item.scope_kind, item.scope_identity, item.canonical_path
            ).resource_key: item
            for item in (
                self.repository.list_snapshot_entries(snapshot.parent_snapshot_id)
                if snapshot.parent_snapshot_id
                else []
            )
        }
        entries: list[FileHistorySnapshotEntryRecord] = []
        updated_tracked: list[FileHistoryTrackedFileRecord] = []
        now = to_iso_z(utc_now())
        for tracked in tracked_files:
            path = (
                resolver.resolve(tracked.display_path)
                if tracked.scope_identity.startswith("legacy:")
                else resolver.resolve_stored(
                    tracked.display_path,
                    tracked.canonical_path,
                    scope_kind=tracked.scope_kind,
                    scope_identity=tracked.scope_identity,
                    scope_root=tracked.scope_root,
                    scope_label=tracked.scope_label,
                )
            )
            observed = self._observe(path.absolute_path)
            previous = parent_entries.get(path.resource_key)
            if _can_reuse_entry(previous, observed):
                entry = FileHistorySnapshotEntryRecord(
                    snapshot_id=snapshot.id,
                    canonical_path=tracked.canonical_path,
                    display_path=path.display_path,
                    state=previous.state,
                    backup_file_name=previous.backup_file_name,
                    version=previous.version,
                    backup_time=previous.backup_time,
                    size=previous.size,
                    mode=previous.mode,
                    content_hash=previous.content_hash,
                    scope_kind=path.scope_kind,
                    scope_identity=path.scope_identity,
                    scope_root=str(path.scope_root),
                    scope_label=path.scope_label,
                )
                latest_version = max(tracked.latest_version, previous.version)
            else:
                latest_version = tracked.latest_version + 1
                self._assert_backup_capacity(
                    session_id=snapshot.session_id,
                    canonical_path=path.resource_key,
                    source_path=path.absolute_path,
                    version=latest_version,
                )
                backup = self.store.create_backup(
                    session_id=snapshot.session_id,
                    resource_key=path.resource_key,
                    source_path=path.absolute_path,
                    version=latest_version,
                )
                entry = _entry_from_backup(snapshot.id, path, backup)
            entries.append(entry)
            updated_tracked.append(
                FileHistoryTrackedFileRecord(
                    session_id=tracked.session_id,
                    canonical_path=tracked.canonical_path,
                    display_path=path.display_path,
                    latest_version=latest_version,
                    first_snapshot_id=tracked.first_snapshot_id or snapshot.id,
                    last_snapshot_id=snapshot.id,
                    last_observed_state=observed.state,
                    last_observed_hash=observed.content_hash,
                    last_observed_size=observed.size,
                    last_observed_mtime_ns=observed.mtime_ns,
                    last_observed_mode=observed.mode,
                    created_at=tracked.created_at,
                    updated_at=now,
                    scope_kind=path.scope_kind,
                    scope_identity=path.scope_identity,
                    scope_root=str(path.scope_root),
                    scope_label=path.scope_label,
                )
            )
        return entries, updated_tracked

    def _capture_materialized_state(
        self,
        snapshot: FileHistorySnapshotRecord,
        resolver: FileHistoryPathResolver,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> tuple[list[FileHistorySnapshotEntryRecord], list[FileHistoryTrackedFileRecord]]:
        tracked_files = self.repository.list_tracked_files(snapshot.session_id)
        entries: list[FileHistorySnapshotEntryRecord] = []
        tracked_updates: list[FileHistoryTrackedFileRecord] = []
        now = to_iso_z(utc_now())
        for tracked in tracked_files:
            path = (
                resolver.resolve(tracked.display_path)
                if tracked.scope_identity.startswith("legacy:")
                else resolver.resolve_stored(
                    tracked.display_path,
                    tracked.canonical_path,
                    scope_kind=tracked.scope_kind,
                    scope_identity=tracked.scope_identity,
                    scope_root=tracked.scope_root,
                    scope_label=tracked.scope_label,
                )
            )
            observed = self._observe(path.absolute_path)
            reusable = self.repository.find_reusable_entry(
                snapshot.session_id,
                tracked.canonical_path,
                scope_kind=tracked.scope_kind,
                scope_identity=tracked.scope_identity,
                state=observed.state,
                content_hash=observed.content_hash,
                mode=observed.mode,
                conn=conn,
            )
            if reusable is not None:
                entry = FileHistorySnapshotEntryRecord(
                    snapshot_id=snapshot.id,
                    canonical_path=tracked.canonical_path,
                    display_path=path.display_path,
                    state=reusable.state,
                    backup_file_name=reusable.backup_file_name,
                    version=reusable.version,
                    backup_time=reusable.backup_time,
                    size=reusable.size,
                    mode=reusable.mode,
                    content_hash=reusable.content_hash,
                    scope_kind=path.scope_kind,
                    scope_identity=path.scope_identity,
                    scope_root=str(path.scope_root),
                    scope_label=path.scope_label,
                )
                latest_version = max(tracked.latest_version, reusable.version)
            else:
                latest_version = tracked.latest_version + 1
                self._assert_backup_capacity(
                    session_id=snapshot.session_id,
                    canonical_path=path.resource_key,
                    source_path=path.absolute_path,
                    version=latest_version,
                )
                backup = self.store.create_backup(
                    session_id=snapshot.session_id,
                    resource_key=path.resource_key,
                    source_path=path.absolute_path,
                    version=latest_version,
                )
                entry = _entry_from_backup(snapshot.id, path, backup)
            entries.append(entry)
            tracked_updates.append(
                FileHistoryTrackedFileRecord(
                    session_id=tracked.session_id,
                    canonical_path=tracked.canonical_path,
                    display_path=path.display_path,
                    latest_version=latest_version,
                    first_snapshot_id=tracked.first_snapshot_id or snapshot.id,
                    last_snapshot_id=snapshot.id,
                    last_observed_state=observed.state,
                    last_observed_hash=observed.content_hash,
                    last_observed_size=observed.size,
                    last_observed_mtime_ns=observed.mtime_ns,
                    last_observed_mode=observed.mode,
                    created_at=tracked.created_at,
                    updated_at=now,
                    scope_kind=path.scope_kind,
                    scope_identity=path.scope_identity,
                    scope_root=str(path.scope_root),
                    scope_label=path.scope_label,
                )
            )
        return entries, tracked_updates

    @staticmethod
    def _observe(path: Path) -> _ObservedFile:
        try:
            metadata = path.stat()
        except FileNotFoundError:
            return _ObservedFile("missing", None, None, None, None)
        except OSError as exc:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_FAILED,
                "无法读取文件快照目标",
                details={"reason": "source_metadata_unreadable"},
            ) from exc
        if not stat.S_ISREG(metadata.st_mode):
            raise FileHistoryError(
                FileHistoryErrorCode.TARGET_UNSUPPORTED,
                "文件快照目标不是普通文件",
            )
        content_hash, size = FileHistoryStore.hash_file(path)
        return _ObservedFile(
            "file",
            content_hash,
            size,
            metadata.st_mtime_ns,
            stat.S_IMODE(metadata.st_mode),
        )

    def _snapshot_lock(self, session_id: str) -> threading.RLock:
        with self._snapshot_locks_guard:
            return self._session_locks.setdefault(session_id, threading.RLock())

    def _coordination_locks(
        self,
        *,
        session_id: str,
        workspace_identity: str,
        resource_keys: Sequence[str] = (),
    ) -> tuple[tuple[str, threading.RLock], ...]:
        with self._snapshot_locks_guard:
            session_lock = self._session_locks.setdefault(session_id, threading.RLock())
            workspace_lock = self._workspace_locks.setdefault(
                workspace_identity,
                threading.RLock(),
            )
            resource_locks = tuple(
                (
                    f"resource:{resource_key}",
                    self._resource_locks.setdefault(resource_key, threading.RLock()),
                )
                for resource_key in sorted(set(resource_keys))
            )
        scope_locks = resource_locks or ((f"workspace:{workspace_identity}", workspace_lock),)
        return tuple(
            sorted(
                ((f"session:{session_id}", session_lock), *scope_locks),
                key=lambda item: item[0],
            )
        )

    @staticmethod
    def _acquire_local_locks(
        keys_and_locks: Sequence[tuple[str, threading.RLock]],
    ) -> bool:
        acquired: list[threading.RLock] = []
        for _, lock in keys_and_locks:
            if not lock.acquire(blocking=False):
                for held in reversed(acquired):
                    held.release()
                return False
            acquired.append(lock)
        return True

    @staticmethod
    def _release_local_locks(
        keys_and_locks: Sequence[tuple[str, threading.RLock]],
    ) -> None:
        for _, lock in reversed(keys_and_locks):
            lock.release()

    def _assert_session_available(self, session_id: str, *, reject_running: bool) -> None:
        self._assert_enabled()
        state = self.repository.get_session_state(session_id)
        if state is not None and state.state == FileHistorySessionStatus.BLOCKED:
            raise FileHistoryError(
                FileHistoryErrorCode.OPERATION_BLOCKED,
                "当前会话的文件历史已阻塞，需要先人工恢复",
                details={"operation_id": state.blocked_reason},
            )
        if reject_running and self.repository.is_session_turn_running(session_id):
            raise FileHistoryError(
                FileHistoryErrorCode.TURN_RUNNING,
                "当前会话仍有消息或工具正在运行，不能回溯",
                details={"session_id": session_id},
            )

    def _assert_enabled(self) -> None:
        if not self.enabled:
            raise FileHistoryError(
                FileHistoryErrorCode.DISABLED,
                "文件历史已在设置中禁用；为避免静默失去恢复能力，受控代码修改不可用",
            )

    def _assert_backup_capacity(
        self,
        *,
        session_id: str,
        canonical_path: str,
        source_path: Path,
        version: int,
    ) -> None:
        if version > self.max_versions_per_file:
            raise FileHistoryError(
                FileHistoryErrorCode.LIMIT_EXCEEDED,
                "文件历史版本数量已达到上限",
                details={
                    "limit": self.max_versions_per_file,
                    "path": canonical_path,
                },
            )
        backup_name = self.store.backup_file_name(canonical_path, version)
        if self.store.resolve_backup_path(session_id, backup_name).exists():
            return
        try:
            additional_size = source_path.stat().st_size
        except FileNotFoundError:
            additional_size = 0
        except OSError as exc:
            raise FileHistoryError(
                FileHistoryErrorCode.BACKUP_FAILED,
                "无法检查文件历史存储容量",
                details={"path": canonical_path},
            ) from exc
        current_size = self.store.usage_bytes()
        if current_size + additional_size > self.max_storage_bytes:
            raise FileHistoryError(
                FileHistoryErrorCode.LIMIT_EXCEEDED,
                "文件历史存储容量已达到上限",
                details={
                    "limit_bytes": self.max_storage_bytes,
                    "usage_bytes": current_size,
                    "required_bytes": additional_size,
                },
            )

    def _block_recovery(self, operation_id: str, session_id: str, reason: str) -> None:
        with self.repositories.db.transaction(immediate=True) as conn:
            self.repository.update_operation(
                operation_id,
                state=FileOperationStatus.BLOCKED,
                error_code=reason,
                error_detail={"recovered_on_startup": True},
                completed=True,
                conn=conn,
            )
            state = self.repository.get_session_state(session_id, conn=conn)
            if state is not None:
                self.repository.update_session_state(
                    session_id,
                    state=FileHistorySessionStatus.BLOCKED,
                    blocked_reason=operation_id,
                    expected_revision=state.revision,
                    conn=conn,
                )


@dataclass(frozen=True, slots=True)
class _ObservedFile:
    state: str
    content_hash: str | None
    size: int | None
    mtime_ns: int | None
    mode: int | None


@dataclass(frozen=True, slots=True)
class _PreviewBytes:
    data: bytes
    truncated: bool


def _can_reuse_entry(
    previous: FileHistorySnapshotEntryRecord | None,
    observed: _ObservedFile,
) -> bool:
    if previous is None or previous.state != observed.state:
        return False
    if observed.state == "missing":
        return True
    return (
        previous.content_hash == observed.content_hash
        and previous.size == observed.size
        and previous.mode == observed.mode
    )


def _entry_from_backup(
    snapshot_id: str,
    path: FileHistoryPath,
    backup: FileHistoryBackup,
) -> FileHistorySnapshotEntryRecord:
    return FileHistorySnapshotEntryRecord(
        snapshot_id=snapshot_id,
        canonical_path=path.canonical_path,
        display_path=path.display_path,
        state=backup.state,
        backup_file_name=backup.backup_file_name,
        version=backup.version,
        backup_time=backup.backup_time,
        size=backup.size,
        mode=backup.mode,
        content_hash=backup.content_hash,
        scope_kind=path.scope_kind,
        scope_identity=path.scope_identity,
        scope_root=str(path.scope_root),
        scope_label=path.scope_label,
    )


def _snapshot_error_code(exc: Exception) -> str:
    code = getattr(exc, "code", None)
    return str(code or "snapshot_failed")


def _restore_policy_fingerprint(
    file_access_mode: str,
    files: Sequence[ResolvedTargetFile],
) -> str:
    payload = {
        "file_access_mode": str(file_access_mode),
        "resources": sorted(
            [
                {
                "resource_id": item.path.resource_id,
                "scope_root": normalize_workspace_root_for_storage(item.path.scope_root),
                "absolute_path": normalize_workspace_root_for_storage(
                    item.path.absolute_path
                ),
                }
                for item in files
            ],
            key=lambda item: item["resource_id"],
        ),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _parse_timestamp(value: str) -> datetime:
    normalized = str(value).strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _read_preview_bytes(path: Path, *, limit: int = 2 * 1024 * 1024) -> _PreviewBytes:
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    return _PreviewBytes(data[:limit], len(data) > limit)


def _looks_binary(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def _validate_mode_decision(
    mode: FileRestoreMode | str,
    decision: FileRestoreDecision | str,
) -> tuple[FileRestoreMode, FileRestoreDecision]:
    try:
        parsed_mode = FileRestoreMode(mode)
    except ValueError as exc:
        raise FileHistoryError(
            FileHistoryErrorCode.INVALID_MODE,
            "回溯模式无效",
        ) from exc
    try:
        parsed_decision = FileRestoreDecision(decision)
    except ValueError as exc:
        raise FileHistoryError(
            FileHistoryErrorCode.INVALID_DECISION,
            "回溯二次决策无效",
        ) from exc
    if parsed_mode == FileRestoreMode.CONVERSATION and parsed_decision not in {
        FileRestoreDecision.FULL,
        FileRestoreDecision.CANCEL,
    }:
        raise FileHistoryError(
            FileHistoryErrorCode.INVALID_DECISION,
            "仅回溯对话不接受文件决策",
        )
    if parsed_decision == FileRestoreDecision.CONVERSATION_ONLY and (
        parsed_mode != FileRestoreMode.BOTH
    ):
        raise FileHistoryError(
            FileHistoryErrorCode.INVALID_DECISION,
            "仅同时回溯模式可以在二次确认中改为仅对话",
        )
    return parsed_mode, parsed_decision


def _preview_signature(path: str, item: FilePreviewItem) -> tuple[Any, ...]:
    current_state = item.current_state
    if current_state not in {"file", "missing"}:
        current_state = "file" if item.current_hash is not None else "missing"
    target_state = item.target_state
    if target_state not in {"file", "missing"}:
        target_state = "file" if item.target_hash is not None else "missing"
    return (
        path,
        current_state,
        item.current_hash,
        target_state,
        item.target_hash,
        item.classification,
        item.reason_code,
    )
