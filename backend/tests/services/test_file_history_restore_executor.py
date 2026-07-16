from __future__ import annotations

import pytest

from backend.app.services.file_history_service import FileHistoryError, FileHistoryService
from backend.app.storage import FileHistoryTrackedFileRecord, StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


def _case(tmp_path, initial: dict[str, bytes | None], current: dict[str, bytes | None]):
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
    for path, content in initial.items():
        if content is not None:
            (tmp_path / path).write_bytes(content)
        repositories.file_history.upsert_tracked_file(
            FileHistoryTrackedFileRecord(
                session_id="session-1",
                canonical_path=path,
                display_path=path,
                latest_version=0,
                first_snapshot_id=None,
                last_snapshot_id=None,
                last_observed_state="file" if content is not None else "missing",
                last_observed_hash=None,
                last_observed_size=None,
                last_observed_mtime_ns=None,
                last_observed_mode=None,
                created_at=NOW,
                updated_at=NOW,
            )
        )
    service = FileHistoryService(repositories, data_dir=tmp_path / "data")
    service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    for path, content in current.items():
        target = tmp_path / path
        if content is None:
            target.unlink(missing_ok=True)
        else:
            target.write_bytes(content)
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    operation, target, files = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="force_conflicts",
        workspace_root=tmp_path,
    )
    canonical_paths = [
        item.canonical_path
        for item in repositories.file_history.list_operation_files(operation.id)
    ]
    service.create_safety_snapshots(
        operation_id=operation.id,
        workspace_root=tmp_path,
        canonical_paths=canonical_paths,
    )
    return service, repositories, preview, target, files, canonical_paths


def test_restore_executor_restores_update_create_and_delete_targets(tmp_path) -> None:
    service, repositories, preview, target, _, paths = _case(
        tmp_path,
        {
            "updated.txt": b"before",
            "created.txt": None,
            "deleted.txt": b"restore me",
        },
        {
            "updated.txt": b"after!",
            "created.txt": b"new file",
            "deleted.txt": None,
        },
    )
    restored = service.execute_file_restore(
        operation_id=preview.operation_id,
        target=target,
        workspace_root=tmp_path,
        canonical_paths=paths,
        forced_paths=paths,
    )

    assert (tmp_path / "updated.txt").read_bytes() == b"before"
    assert not (tmp_path / "created.txt").exists()
    assert (tmp_path / "deleted.txt").read_bytes() == b"restore me"
    assert len(restored) == 3
    assert all(item.result_state == "forced" for item in restored)
    assert all(
        item.error_code is None
        for item in repositories.file_history.list_operation_files(preview.operation_id)
    )


def test_restore_executor_stops_at_first_runtime_failure(tmp_path, monkeypatch) -> None:
    service, repositories, preview, target, _, paths = _case(
        tmp_path,
        {"a.txt": b"a-before", "b.txt": b"b-before"},
        {"a.txt": b"a-after!", "b.txt": b"b-after!"},
    )
    original = service.store.restore_backup
    calls = 0

    def fail_second(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected restore failure")
        return original(**kwargs)

    monkeypatch.setattr(service.store, "restore_backup", fail_second)
    with pytest.raises(FileHistoryError) as error:
        service.execute_file_restore(
            operation_id=preview.operation_id,
            target=target,
            workspace_root=tmp_path,
            canonical_paths=paths,
        )

    assert error.value.code == "file_restore_failed"
    assert (tmp_path / "a.txt").read_bytes() == b"a-before"
    assert (tmp_path / "b.txt").read_bytes() == b"b-after!"
    states = {
        item.display_path: item.result_state
        for item in repositories.file_history.list_operation_files(preview.operation_id)
    }
    assert states == {"a.txt": "restored", "b.txt": "restored"}

    compensated = service.compensate_operation(
        operation_id=preview.operation_id,
        workspace_root=tmp_path,
    )
    assert {item.display_path for item in compensated} == {"a.txt", "b.txt"}
    assert (tmp_path / "a.txt").read_bytes() == b"a-after!"
    operation = repositories.file_history.get_operation(preview.operation_id)
    state = repositories.file_history.get_session_state("session-1")
    assert operation is not None and operation.state == "compensated"
    assert operation.compensation_state == "complete"
    assert state is not None and state.state == "ready"
    assert state.active_snapshot_id == operation.active_snapshot_before


def test_e2e_restore_failure_marker_fails_once_then_is_consumed(tmp_path, monkeypatch) -> None:
    service, _, preview, target, _, paths = _case(
        tmp_path,
        {"a.txt": b"a-before", "b.txt": b"b-before"},
        {"a.txt": b"a-after!", "b.txt": b"b-after!"},
    )
    monkeypatch.setenv("KEYDEX_E2E_MODEL_TRANSPORT", "true")
    marker = service.store.root / "e2e-restore-fail-once"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("1", encoding="utf-8")

    with pytest.raises(FileHistoryError) as error:
        service.execute_file_restore(
            operation_id=preview.operation_id,
            target=target,
            workspace_root=tmp_path,
            canonical_paths=paths,
        )

    assert error.value.code == "file_restore_failed"
    assert not marker.exists()
    assert (tmp_path / "a.txt").read_bytes() == b"a-before"
    assert (tmp_path / "b.txt").read_bytes() == b"b-after!"


def test_compensation_refuses_to_overwrite_new_external_change_and_blocks_session(
    tmp_path,
) -> None:
    service, repositories, preview, target, _, paths = _case(
        tmp_path,
        {"a.txt": b"a-before", "b.txt": b"b-before"},
        {"a.txt": b"a-after!", "b.txt": b"b-after!"},
    )
    service.execute_file_restore(
        operation_id=preview.operation_id,
        target=target,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    (tmp_path / "a.txt").write_bytes(b"external-new")

    with pytest.raises(FileHistoryError) as blocked:
        service.compensate_operation(
            operation_id=preview.operation_id,
            workspace_root=tmp_path,
        )
    assert blocked.value.code == "file_restore_compensation_failed"
    assert (tmp_path / "a.txt").read_bytes() == b"external-new"
    operation = repositories.file_history.get_operation(preview.operation_id)
    state = repositories.file_history.get_session_state("session-1")
    assert operation is not None and operation.state == "compensation_failed"
    assert state is not None and state.state == "blocked"
    assert state.blocked_reason == preview.operation_id
