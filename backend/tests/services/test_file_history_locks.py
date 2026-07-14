from __future__ import annotations

import threading

import pytest

from backend.app.services.file_history_service import FileHistoryError, FileHistoryService
from backend.app.storage import FileHistoryTrackedFileRecord, StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


def _operation(tmp_path):
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
    (tmp_path / "file.txt").write_text("before", encoding="utf-8")
    service = FileHistoryService(repositories, data_dir=tmp_path / "data")
    service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    (tmp_path / "file.txt").write_text("after", encoding="utf-8")
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    return service, repositories, preview.operation_id


def test_restore_lease_rejects_running_turn_and_releases_local_lock(tmp_path) -> None:
    service, repositories, operation_id = _operation(tmp_path)
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into trace_record (
              trace_id, session_id, scene_id, user_id, turn_index, root_node_id,
              status, start_time, created_at, updated_at
            ) values ('running-trace', 'session-1', 'scene-1', 'user-1', 1,
                      'root-1', 'running', ?, ?, ?)
            """,
            (NOW, NOW, NOW),
        )

    with pytest.raises(FileHistoryError) as error:
        with service.restore_lease(
            session_id="session-1",
            workspace_root=tmp_path,
            operation_id=operation_id,
        ):
            pass
    assert error.value.code == "file_restore_turn_running"

    with repositories.db.connect() as conn:
        conn.execute("update trace_record set status = 'completed'")
    with service.restore_lease(
        session_id="session-1",
        workspace_root=tmp_path,
        operation_id=operation_id,
    ):
        pass


def test_restore_lease_excludes_same_workspace_write_and_always_cleans_db(tmp_path) -> None:
    service, repositories, operation_id = _operation(tmp_path)
    result: list[str] = []

    def try_write() -> None:
        try:
            with service.controlled_write_lease(
                session_id="session-1",
                workspace_root=tmp_path,
            ):
                result.append("entered")
        except FileHistoryError as exc:
            result.append(exc.code)

    with pytest.raises(RuntimeError, match="injected"):
        with service.restore_lease(
            session_id="session-1",
            workspace_root=tmp_path,
            operation_id=operation_id,
        ):
            thread = threading.Thread(target=try_write)
            thread.start()
            thread.join(timeout=2)
            raise RuntimeError("injected")

    assert result == ["file_restore_locked"]
    with repositories.db.connect() as conn:
        assert conn.execute("select count(*) from file_history_locks").fetchone()[0] == 0


def test_restore_lease_rejects_blocked_session(tmp_path) -> None:
    service, repositories, operation_id = _operation(tmp_path)
    state = repositories.file_history.get_session_state("session-1")
    assert state is not None
    repositories.file_history.update_session_state(
        "session-1",
        state="blocked",
        blocked_reason=operation_id,
        expected_revision=state.revision,
    )

    with pytest.raises(FileHistoryError) as error:
        with service.restore_lease(
            session_id="session-1",
            workspace_root=tmp_path,
            operation_id=operation_id,
        ):
            pass
    assert error.value.code == "file_restore_blocked"
