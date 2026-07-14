from __future__ import annotations

import os

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileMutationSpec,
)
from backend.app.services.file_history_store import FileHistoryBackup
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


def _track(repositories: StorageRepositories, path: str, *, state: str = "file") -> None:
    repositories.file_history.ensure_session_state("session-1")
    repositories.file_history.upsert_tracked_file(
        FileHistoryTrackedFileRecord(
            session_id="session-1",
            canonical_path=path,
            display_path=path,
            latest_version=0,
            first_snapshot_id=None,
            last_snapshot_id=None,
            last_observed_state=state,
            last_observed_hash=None,
            last_observed_size=None,
            last_observed_mtime_ns=None,
            last_observed_mode=None,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def _snapshot(service: FileHistoryService, workspace, message: str):
    return service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id=f"trace-{message}",
        message_event_id=message,
        workspace_root=workspace,
    )


def test_input_snapshot_reuses_unchanged_version_and_advances_active_cursor(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target = tmp_path / "file.txt"
    target.write_text("same", encoding="utf-8")
    _track(repositories, "file.txt")

    first = _snapshot(service, tmp_path, "message-1")
    os.utime(target, None)
    second = _snapshot(service, tmp_path, "message-2")
    first_entry = repositories.file_history.list_snapshot_entries(first.id)[0]
    second_entry = repositories.file_history.list_snapshot_entries(second.id)[0]
    state = repositories.file_history.get_session_state("session-1")

    assert second.parent_snapshot_id == first.id
    assert second_entry.version == first_entry.version == 1
    assert second_entry.backup_file_name == first_entry.backup_file_name
    assert state is not None and state.active_snapshot_id == second.id
    assert state.next_sequence == 3


def test_input_snapshot_hashes_content_even_when_size_and_mtime_match(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target = tmp_path / "file.txt"
    target.write_text("aaaa", encoding="utf-8")
    _track(repositories, "file.txt")
    first = _snapshot(service, tmp_path, "message-1")
    original_mtime = target.stat().st_mtime_ns
    target.write_text("bbbb", encoding="utf-8")
    os.utime(target, ns=(original_mtime, original_mtime))

    second = _snapshot(service, tmp_path, "message-2")
    first_entry = repositories.file_history.list_snapshot_entries(first.id)[0]
    second_entry = repositories.file_history.list_snapshot_entries(second.id)[0]
    assert first_entry.size == second_entry.size == 4
    assert first_entry.content_hash != second_entry.content_hash
    assert second_entry.version == 2


def test_input_snapshot_hashes_binary_content_even_when_size_and_mtime_match(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target = tmp_path / "binary.bin"
    target.write_bytes(b"\x00aaa\xff")
    _track(repositories, "binary.bin")
    first = _snapshot(service, tmp_path, "message-binary-1")
    original_mtime = target.stat().st_mtime_ns
    target.write_bytes(b"\x00bbb\xff")
    os.utime(target, ns=(original_mtime, original_mtime))

    second = _snapshot(service, tmp_path, "message-binary-2")
    first_entry = repositories.file_history.list_snapshot_entries(first.id)[0]
    second_entry = repositories.file_history.list_snapshot_entries(second.id)[0]

    assert first_entry.size == second_entry.size == 5
    assert first_entry.content_hash != second_entry.content_hash
    assert second_entry.version == 2


def test_input_snapshot_reuses_repeated_missing_marker_and_is_message_idempotent(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _track(repositories, "missing.txt", state="missing")

    first = _snapshot(service, tmp_path, "message-1")
    same = _snapshot(service, tmp_path, "message-1")
    second = _snapshot(service, tmp_path, "message-2")
    first_entry = repositories.file_history.list_snapshot_entries(first.id)[0]
    second_entry = repositories.file_history.list_snapshot_entries(second.id)[0]
    assert same.id == first.id
    assert first_entry.state == "missing"
    assert second_entry.version == first_entry.version == 1


def test_input_snapshot_failure_never_appears_ready(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    (tmp_path / "directory").mkdir()
    _track(repositories, "directory")

    with pytest.raises(FileHistoryError):
        _snapshot(service, tmp_path, "message-1")

    snapshot = repositories.file_history.get_snapshot_by_message("session-1", "message-1")
    assert snapshot is not None
    assert snapshot.status == "failed"
    state = repositories.file_history.get_session_state("session-1")
    assert state is not None and state.active_snapshot_id is None


def test_restore_result_materializes_mixed_disk_and_excludes_old_future(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    first_path = tmp_path / "first.txt"
    second_path = tmp_path / "second.txt"
    first_path.write_text("first-v1", encoding="utf-8")
    second_path.write_text("second-v1", encoding="utf-8")
    _track(repositories, "first.txt")
    _track(repositories, "second.txt")
    target = _snapshot(service, tmp_path, "message-1")

    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=target.id,
        trace_id="trace-message-1",
        turn_index=1,
        workspace_root=tmp_path,
        tool_name="apply_patch",
        tool_call_id="tool-1",
        mutations=(
            FileMutationSpec("first.txt", "update"),
            FileMutationSpec("second.txt", "update"),
        ),
    )
    first_path.write_text("first-v2", encoding="utf-8")
    second_path.write_text("second-v2", encoding="utf-8")
    service.commit_writes(prepared, workspace_root=tmp_path)
    old_future = _snapshot(service, tmp_path, "message-2")

    target_first = {
        item.canonical_path: item
        for item in repositories.file_history.list_snapshot_entries(target.id)
    }["first.txt"]
    service.store.restore_backup(
        session_id="session-1",
        backup=FileHistoryBackup(
            state=target_first.state,
            backup_file_name=target_first.backup_file_name,
            version=target_first.version,
            backup_time=target_first.backup_time,
            size=target_first.size,
            mode=target_first.mode,
            content_hash=target_first.content_hash,
        ),
        destination=first_path,
    )

    result = service.materialize_restore_result(
        session_id="session-1",
        active_session_id="session-1",
        target_snapshot_id=target.id,
        workspace_root=tmp_path,
        trace_id="trace-message-1",
    )
    entries = {
        item.canonical_path: item
        for item in repositories.file_history.list_snapshot_entries(result.id)
    }
    assert result.kind == "restore_result"
    assert result.parent_snapshot_id == target.id
    assert entries["first.txt"].version == 1
    assert entries["second.txt"].version == 2
    assert old_future.id != result.parent_snapshot_id

    continued = _snapshot(service, tmp_path, "message-3")
    assert continued.parent_snapshot_id == result.id
    assert {
        item.canonical_path: item.version
        for item in repositories.file_history.list_snapshot_entries(continued.id)
    } == {"first.txt": 1, "second.txt": 2}
