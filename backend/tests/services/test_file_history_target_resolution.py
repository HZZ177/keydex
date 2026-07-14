from __future__ import annotations

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileMutationSpec,
)
from backend.app.services.file_history_store import FileHistoryStoreError
from backend.app.storage import FileHistoryTrackedFileRecord, StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


def _service(tmp_path) -> tuple[FileHistoryService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
    return FileHistoryService(repositories, data_dir=tmp_path / "data"), repositories


def _snapshot(service: FileHistoryService, workspace, message: str):
    return service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id=f"trace-{message}",
        message_event_id=message,
        workspace_root=workspace,
    )


def test_target_resolution_uses_first_version_fallback_for_late_tracked_file(tmp_path) -> None:
    service, _ = _service(tmp_path)
    target = _snapshot(service, tmp_path, "message-1")
    current = _snapshot(service, tmp_path, "message-2")
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=current.id,
        trace_id="trace-message-2",
        turn_index=2,
        workspace_root=tmp_path,
        tool_name="create_file",
        tool_call_id="tool-1",
        mutations=(FileMutationSpec("created.txt", "create"),),
    )
    (tmp_path / "created.txt").write_text("created", encoding="utf-8")
    service.commit_writes(prepared, workspace_root=tmp_path)

    resolved = service.resolve_target(
        session_id="session-1",
        message_event_id=target.user_message_event_id or "",
        workspace_root=tmp_path,
    )
    assert len(resolved.files) == 1
    assert resolved.files[0].resolution == "first_version_fallback"
    assert resolved.files[0].entry is not None
    assert resolved.files[0].entry.state == "missing"
    assert resolved.files[0].error_code is None


def test_target_resolution_classifies_missing_backup_without_touching_disk(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target_path = tmp_path / "file.txt"
    target_path.write_text("before", encoding="utf-8")
    repositories.file_history.ensure_session_state("session-1")
    repositories.file_history.upsert_tracked_file(
        FileHistoryTrackedFileRecord(
            session_id="session-1",
            canonical_path="file.txt",
            display_path="file.txt",
            latest_version=0,
            first_snapshot_id=None,
            last_snapshot_id=None,
            last_observed_state="file",
            last_observed_hash=None,
            last_observed_size=None,
            last_observed_mtime_ns=None,
            last_observed_mode=None,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    target = _snapshot(service, tmp_path, "message-1")
    entry = repositories.file_history.list_snapshot_entries(target.id)[0]
    service.store.resolve_backup_path(
        "session-1", entry.backup_file_name or ""
    ).unlink()

    resolved = service.resolve_target(
        session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    assert resolved.files[0].error_code == "backup_missing"
    assert target_path.read_text(encoding="utf-8") == "before"


def test_target_resolution_classifies_corrupt_and_unreadable_backups(tmp_path, monkeypatch) -> None:
    service, repositories = _service(tmp_path)
    target_path = tmp_path / "file.txt"
    target_path.write_text("sensitive bytes", encoding="utf-8")
    repositories.file_history.ensure_session_state("session-1")
    repositories.file_history.upsert_tracked_file(
        FileHistoryTrackedFileRecord(
            session_id="session-1",
            canonical_path="file.txt",
            display_path="file.txt",
            latest_version=0,
            first_snapshot_id=None,
            last_snapshot_id=None,
            last_observed_state="file",
            last_observed_hash=None,
            last_observed_size=None,
            last_observed_mtime_ns=None,
            last_observed_mode=None,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    snapshot = _snapshot(service, tmp_path, "message-corrupt")
    entry = repositories.file_history.list_snapshot_entries(snapshot.id)[0]
    backup = service.store.resolve_backup_path("session-1", entry.backup_file_name or "")
    backup.write_bytes(b"tampered bytes")

    corrupt = service.resolve_target(
        session_id="session-1",
        message_event_id="message-corrupt",
        workspace_root=tmp_path,
    )
    assert corrupt.files[0].error_code == "backup_corrupt"
    assert target_path.read_text(encoding="utf-8") == "sensitive bytes"

    def unreadable(**_kwargs):
        raise FileHistoryStoreError("backup_unreadable", "injected permission failure")

    monkeypatch.setattr(service.store, "verify_backup", unreadable)
    permission = service.resolve_target(
        session_id="session-1",
        message_event_id="message-corrupt",
        workspace_root=tmp_path,
    )
    assert permission.files[0].error_code == "backup_unreadable"


def test_target_resolution_rejects_snapshot_from_abandoned_future(tmp_path) -> None:
    service, _ = _service(tmp_path)
    target = _snapshot(service, tmp_path, "message-1")
    future = _snapshot(service, tmp_path, "message-2")
    service.materialize_restore_result(
        session_id="session-1",
        active_session_id="session-1",
        target_snapshot_id=target.id,
        workspace_root=tmp_path,
    )

    with pytest.raises(FileHistoryError) as error:
        service.resolve_target(
            session_id="session-1",
            message_event_id=future.user_message_event_id or "",
            workspace_root=tmp_path,
        )
    assert error.value.code == "file_snapshot_not_ready"
