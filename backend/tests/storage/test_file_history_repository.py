from __future__ import annotations

import sqlite3
from dataclasses import replace

import pytest

from backend.app.storage import (
    FileHistoryOperationFileRecord,
    FileHistoryOperationRecord,
    FileHistorySnapshotEntryRecord,
    FileHistorySnapshotRecord,
    FileHistoryTrackedFileRecord,
    StorageRepositories,
    init_database,
)

NOW = "2026-07-14T00:00:00Z"


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
    return repositories


def _snapshot(sequence: int, *, kind: str = "input") -> FileHistorySnapshotRecord:
    return FileHistorySnapshotRecord(
        id=f"snapshot-{sequence}",
        session_id="session-1",
        active_session_id="session-1",
        trace_id=f"trace-{sequence}",
        user_message_event_id=f"message-{sequence}" if kind == "input" else None,
        parent_snapshot_id=f"snapshot-{sequence - 1}" if sequence > 1 else None,
        kind=kind,
        sequence=sequence,
        workspace_root="C:/workspace",
        workspace_identity="c:/workspace",
        status="ready",
        error_code=None,
        created_at=NOW,
        updated_at=NOW,
    )


def test_file_history_repository_round_trip_and_stable_order(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repo = repositories.file_history
    state = repo.ensure_session_state("session-1")
    assert state.active_snapshot_id is None

    first_entry = FileHistorySnapshotEntryRecord(
        snapshot_id="snapshot-1",
        canonical_path="src/a.txt",
        display_path="src/a.txt",
        state="file",
        backup_file_name="hash@v1",
        version=1,
        backup_time=NOW,
        size=3,
        mode=0o644,
        content_hash="aaa",
    )
    repo.create_snapshot(_snapshot(1), [first_entry], set_active=True)
    repo.create_snapshot(_snapshot(2, kind="restore_result"), [], set_active=True)

    snapshots = repo.list_snapshots("session-1")
    assert [item.id for item in snapshots] == ["snapshot-2", "snapshot-1"]
    assert repo.get_snapshot_by_message("session-1", "message-1") == _snapshot(1)
    assert repo.list_snapshot_entries("snapshot-1") == [first_entry]
    assert repo.get_session_state("session-1").active_snapshot_id == "snapshot-2"  # type: ignore[union-attr]


def test_file_history_repository_external_transaction_and_operation_mapping(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repo = repositories.file_history
    repo.ensure_session_state("session-1")

    tracked = FileHistoryTrackedFileRecord(
        session_id="session-1",
        canonical_path="src/a.txt",
        display_path="src/a.txt",
        latest_version=1,
        first_snapshot_id=None,
        last_snapshot_id=None,
        last_observed_state="file",
        last_observed_hash="aaa",
        last_observed_size=3,
        last_observed_mtime_ns=1,
        last_observed_mode=0o644,
        created_at=NOW,
        updated_at=NOW,
    )
    with pytest.raises(RuntimeError):
        with repositories.db.transaction() as conn:
            repo.upsert_tracked_file(tracked, conn=conn)
            raise RuntimeError("rollback")
    assert repo.list_tracked_files("session-1") == []

    operation = FileHistoryOperationRecord(
        id="operation-1",
        request_id="request-1",
        session_id="session-1",
        active_session_id="session-1",
        target_snapshot_id=None,
        target_trace_id="trace-1",
        target_message_event_id="message-1",
        workspace_identity="c:/workspace",
        mode="both",
        decision="full",
        state="previewed",
        preview_token="token",
        preview_revision=1,
        conversation_rewound=False,
        active_snapshot_before=None,
        active_snapshot_after=None,
        restored_count=0,
        skipped_count=0,
        forced_count=0,
        error_code=None,
        error_detail={"safe": True},
        compensation_state="not_needed",
        created_at=NOW,
        updated_at=NOW,
    )
    operation_file = FileHistoryOperationFileRecord(
        operation_id="operation-1",
        canonical_path="src/a.txt",
        display_path="src/a.txt",
        preview_current_state="file",
        preview_current_hash="current",
        target_state="missing",
        target_backup_file_name=None,
        target_hash=None,
        target_size=None,
        target_mode=None,
        classification="forceable_conflict",
        reason_code="other_session_write",
        writer_session_id="session-2",
        user_authorized=False,
        result_state="pending",
        error_code=None,
        safety_state=None,
        safety_backup_file_name=None,
        safety_hash=None,
        safety_size=None,
        safety_mode=None,
        updated_at=NOW,
    )
    repo.create_operation(operation, [operation_file])

    assert repo.get_operation_by_request("session-1", "request-1") == operation
    assert repo.list_operation_files("operation-1") == [operation_file]


def test_file_history_repository_enforces_foreign_keys_unique_keys_and_cursor_cas(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repo = repositories.file_history
    state = repo.ensure_session_state("session-1")

    assert repo.update_session_state(
        "session-1",
        next_sequence=2,
        expected_revision=state.revision + 1,
    ) is None
    assert repo.get_session_state("session-1") == state

    with pytest.raises(sqlite3.IntegrityError):
        repo.create_snapshot(_snapshot(2))

    repo.create_snapshot(_snapshot(1))
    duplicate_message = replace(
        _snapshot(2),
        id="snapshot-duplicate-message",
        user_message_event_id="message-1",
    )
    with pytest.raises(sqlite3.IntegrityError):
        repo.create_snapshot(duplicate_message)
