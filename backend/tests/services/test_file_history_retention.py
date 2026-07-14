from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from backend.app.services.file_history_service import FileHistoryError, FileHistoryService
from backend.app.storage import FileHistoryTrackedFileRecord, StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


def _service(tmp_path, **kwargs):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
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
    return FileHistoryService(repositories, data_dir=tmp_path / "data", **kwargs), repositories


def _snapshot(service, tmp_path, message):
    return service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id=f"trace-{message}",
        message_event_id=message,
        workspace_root=tmp_path,
    )


def test_cleanup_preserves_all_metadata_references_and_removes_old_orphans(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    (tmp_path / "file.txt").write_text("keep", encoding="utf-8")
    snapshot = _snapshot(service, tmp_path, "message-1")
    entry = repositories.file_history.list_snapshot_entries(snapshot.id)[0]
    referenced = service.store.resolve_backup_path("session-1", entry.backup_file_name or "")
    orphan = service.store.root / "session-1" / "orphan@v99"
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_bytes(b"orphan")
    old = (datetime.now(UTC) - timedelta(days=2)).timestamp()
    os.utime(orphan, (old, old))

    result = service.cleanup_history(orphan_grace_seconds=3600)

    assert referenced.exists()
    assert not orphan.exists()
    assert "session-1/orphan@v99" in result["deleted_artifacts"]


def test_version_and_capacity_limits_fail_explicitly_without_losing_cursor(tmp_path) -> None:
    service, repositories = _service(tmp_path, max_versions_per_file=1)
    target = tmp_path / "file.txt"
    target.write_text("v1", encoding="utf-8")
    first = _snapshot(service, tmp_path, "message-1")
    target.write_text("v2", encoding="utf-8")

    with pytest.raises(FileHistoryError) as error:
        _snapshot(service, tmp_path, "message-2")
    assert error.value.code == "file_history_limit_exceeded"
    state = repositories.file_history.get_session_state("session-1")
    assert state is not None and state.active_snapshot_id == first.id


def test_capacity_limit_fails_before_cursor_advance(tmp_path) -> None:
    service, repositories = _service(tmp_path, max_storage_bytes=3)
    target = tmp_path / "file.txt"
    target.write_bytes(b"four")

    with pytest.raises(FileHistoryError) as error:
        _snapshot(service, tmp_path, "message-capacity")

    assert error.value.code == "file_history_limit_exceeded"
    state = repositories.file_history.get_session_state("session-1")
    assert state is not None and state.active_snapshot_id is None


def test_concurrent_cleanup_and_snapshot_preserve_fresh_referenced_artifact(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target = tmp_path / "file.txt"
    target.write_text("concurrent", encoding="utf-8")
    barrier = threading.Barrier(2)

    def create_snapshot():
        barrier.wait()
        return _snapshot(service, tmp_path, "message-concurrent")

    def cleanup():
        barrier.wait()
        return service.cleanup_history()

    with ThreadPoolExecutor(max_workers=2) as executor:
        snapshot_future = executor.submit(create_snapshot)
        cleanup_future = executor.submit(cleanup)
        snapshot = snapshot_future.result()
        cleanup_future.result()

    entry = repositories.file_history.list_snapshot_entries(snapshot.id)[0]
    artifact = service.store.resolve_backup_path("session-1", entry.backup_file_name or "")
    assert artifact.exists()
    assert artifact.read_bytes() == b"concurrent"


def test_resume_uses_persisted_cursor_and_fork_scope_starts_empty(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    (tmp_path / "file.txt").write_text("v1", encoding="utf-8")
    first = _snapshot(service, tmp_path, "message-1")

    resumed = FileHistoryService(repositories, data_dir=tmp_path / "data")
    assert resumed.active_lineage("session-1")[0].id == first.id

    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('fork-1', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
    assert resumed.active_lineage("fork-1") == []
    assert repositories.file_history.list_tracked_files("fork-1") == []


def test_startup_recovery_compensates_interrupted_file_restore(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target_path = tmp_path / "file.txt"
    target_path.write_text("before", encoding="utf-8")
    _snapshot(service, tmp_path, "message-1")
    target_path.write_text("operation-before", encoding="utf-8")
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    operation, resolved, _ = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="force_conflicts",
        workspace_root=tmp_path,
    )
    claimed = service.claim_operation_request(
        session_id="session-1",
        operation_id=operation.id,
        request_id="request-1",
        mode="code",
        decision="force_conflicts",
    )
    assert claimed.state == "running"
    paths = [
        item.canonical_path
        for item in repositories.file_history.list_operation_files(operation.id)
    ]
    service.create_safety_snapshots(
        operation_id=operation.id,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    service.execute_file_restore(
        operation_id=operation.id,
        target=resolved,
        workspace_root=tmp_path,
        canonical_paths=paths,
        forced_paths=paths,
    )
    assert target_path.read_text(encoding="utf-8") == "before"

    resumed = FileHistoryService(repositories, data_dir=tmp_path / "data")
    recovered = resumed.recover_incomplete_operations()

    assert recovered == ({"operation_id": operation.id, "status": "compensated"},)
    assert target_path.read_text(encoding="utf-8") == "operation-before"


def test_active_lineage_exposes_only_newest_configured_input_points(tmp_path) -> None:
    service, repositories = _service(tmp_path, max_rewind_points=2)
    target = tmp_path / "file.txt"
    snapshots = []
    for index in range(1, 4):
        target.write_text(f"v{index}", encoding="utf-8")
        snapshots.append(_snapshot(service, tmp_path, f"message-{index}"))

    persisted = [repositories.file_history.get_snapshot(item.id) for item in snapshots]
    assert [item.status if item is not None else None for item in persisted] == [
        "superseded",
        "ready",
        "ready",
    ]

    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    assert preview.code_available is False
    assert preview.warnings == ("file_snapshot_not_ready",)


def test_retention_prunes_expired_unpinned_snapshot_and_unreferenced_blob(tmp_path) -> None:
    service, repositories = _service(tmp_path, retention_days=30)
    target = tmp_path / "file.txt"
    target.write_text("v1", encoding="utf-8")
    old_snapshot = _snapshot(service, tmp_path, "message-old")
    old_entry = repositories.file_history.list_snapshot_entries(old_snapshot.id)[0]
    old_artifact = service.store.resolve_backup_path(
        "session-1",
        old_entry.backup_file_name or "",
    )
    target.write_text("v2", encoding="utf-8")
    active_snapshot = _snapshot(service, tmp_path, "message-active")
    old_time = "2026-05-01T00:00:00Z"
    with repositories.db.connect() as conn:
        conn.execute(
            "update file_history_snapshots set created_at = ?, updated_at = ? where id = ?",
            (old_time, old_time, old_snapshot.id),
        )
    old_epoch = datetime(2026, 5, 1, tzinfo=UTC).timestamp()
    os.utime(old_artifact, (old_epoch, old_epoch))

    result = service.cleanup_history(
        orphan_grace_seconds=0,
        now=datetime(2026, 7, 14, tzinfo=UTC),
    )

    assert result["deleted_snapshots"] == 1
    assert repositories.file_history.get_snapshot(old_snapshot.id) is None
    active = repositories.file_history.get_snapshot(active_snapshot.id)
    assert active is not None and active.parent_snapshot_id is None
    assert not old_artifact.exists()


def test_preview_operation_pins_expired_target_until_operation_retention(tmp_path) -> None:
    service, repositories = _service(
        tmp_path,
        retention_days=30,
        max_rewind_points=1,
    )
    target = tmp_path / "file.txt"
    target.write_text("v1", encoding="utf-8")
    pinned_snapshot = _snapshot(service, tmp_path, "message-pinned")
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-pinned",
        workspace_root=tmp_path,
        source={"message_event_id": "message-pinned"},
    )
    target.write_text("v2", encoding="utf-8")
    _snapshot(service, tmp_path, "message-active")
    old_time = "2026-05-01T00:00:00Z"
    with repositories.db.connect() as conn:
        conn.execute(
            "update file_history_snapshots set created_at = ?, updated_at = ? where id = ?",
            (old_time, old_time, pinned_snapshot.id),
        )

    first = service.cleanup_history(
        orphan_grace_seconds=0,
        now=datetime(2026, 7, 14, tzinfo=UTC),
    )
    assert first["deleted_snapshots"] == 0
    assert repositories.file_history.get_snapshot(pinned_snapshot.id) is not None

    with repositories.db.connect() as conn:
        conn.execute(
            """
            update file_history_operations
               set state = 'full', updated_at = ?, completed_at = ?
             where id = ?
            """,
            (old_time, old_time, preview.operation_id),
        )
    second = service.cleanup_history(
        orphan_grace_seconds=0,
        now=datetime(2026, 7, 14, tzinfo=UTC),
    )
    assert second["deleted_operations"] == 1
    assert second["deleted_snapshots"] == 1
    assert repositories.file_history.get_operation(preview.operation_id) is None
    assert repositories.file_history.get_snapshot(pinned_snapshot.id) is None
