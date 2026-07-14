from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileOperationStatus,
)
from backend.app.storage import FileHistoryTrackedFileRecord, StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


def _preview(tmp_path):
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
    service = FileHistoryService(repositories, data_dir=tmp_path / "data")
    path = tmp_path / "file.txt"
    path.write_text("before", encoding="utf-8")
    service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    path.write_text("after!", encoding="utf-8")
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    return service, repositories, path, preview


def test_preview_token_persists_bound_file_state_and_preflight_revalidates(tmp_path) -> None:
    service, repositories, _, preview = _preview(tmp_path)
    operation = repositories.file_history.get_operation(preview.operation_id)
    files = repositories.file_history.list_operation_files(preview.operation_id)

    assert operation is not None
    assert operation.preview_token == preview.preview_token
    assert len(preview.preview_token) >= 32
    assert len(files) == 1
    assert files[0].preview_current_hash == preview.files[0].current_hash

    _, target, current = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=tmp_path,
    )
    assert target.snapshot.id == preview.snapshot_id
    assert current[0].path == "file.txt"


def test_preflight_rejects_forged_token_and_same_size_same_mtime_change(tmp_path) -> None:
    service, _, path, preview = _preview(tmp_path)
    with pytest.raises(FileHistoryError) as forged:
        service.preflight_preview(
            session_id="session-1",
            operation_id=preview.operation_id,
            preview_token="forged-token",
            mode="code",
            decision="full",
            workspace_root=tmp_path,
        )
    assert forged.value.code == "file_preview_stale"

    mtime = path.stat().st_mtime_ns
    path.write_text("change", encoding="utf-8")
    os.utime(path, ns=(mtime, mtime))
    with pytest.raises(FileHistoryError) as stale:
        service.preflight_preview(
            session_id="session-1",
            operation_id=preview.operation_id,
            preview_token=preview.preview_token,
            mode="code",
            decision="full",
            workspace_root=tmp_path,
        )
    assert stale.value.code == "file_preview_stale"


def test_conversation_only_preflight_does_not_bind_unmodified_file_execution(tmp_path) -> None:
    service, _, path, preview = _preview(tmp_path)
    path.write_text("changed after preview", encoding="utf-8")

    _, _, files = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="conversation",
        decision="full",
        workspace_root=tmp_path,
    )
    assert files == ()


def test_safety_snapshot_captures_current_bytes_before_restore(tmp_path) -> None:
    service, repositories, path, preview = _preview(tmp_path)
    service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=tmp_path,
    )
    captured = service.create_safety_snapshots(
        operation_id=preview.operation_id,
        workspace_root=tmp_path,
    )
    assert len(captured) == 1
    assert captured[0].safety_state == "file"
    safety_path = service.store.resolve_artifact_path(
        "session-1", captured[0].safety_backup_file_name or ""
    )
    assert safety_path.read_bytes() == path.read_bytes() == b"after!"
    assert repositories.file_history.list_operation_files(preview.operation_id)[
        0
    ].safety_hash == captured[0].safety_hash


def test_safety_snapshot_failure_commits_no_safety_metadata(tmp_path) -> None:
    service, repositories, path, preview = _preview(tmp_path)
    path.unlink()
    path.mkdir()
    with pytest.raises(RuntimeError):
        service.create_safety_snapshots(
            operation_id=preview.operation_id,
            workspace_root=tmp_path,
        )
    operation_file = repositories.file_history.list_operation_files(preview.operation_id)[0]
    assert operation_file.safety_state is None
    assert operation_file.safety_backup_file_name is None


def test_operation_request_claim_is_idempotent_and_rejects_double_click_race(tmp_path) -> None:
    service, _, _, preview = _preview(tmp_path)
    first = service.claim_operation_request(
        session_id="session-1",
        operation_id=preview.operation_id,
        request_id="request-1",
        mode="code",
        decision="full",
    )
    repeated = service.claim_operation_request(
        session_id="session-1",
        operation_id=preview.operation_id,
        request_id="request-1",
        mode="code",
        decision="full",
    )
    assert first.id == repeated.id
    assert repeated.state == "running"

    with pytest.raises(FileHistoryError) as conflict:
        service.claim_operation_request(
            session_id="session-1",
            operation_id=preview.operation_id,
            request_id="request-2",
            mode="code",
            decision="full",
        )
    assert conflict.value.code == "file_restore_request_conflict"

    completed = service.complete_operation(
        preview.operation_id,
        status=FileOperationStatus.FULL,
        conversation_rewound=False,
        active_snapshot_after=preview.snapshot_id,
    )
    terminal_repeat = service.claim_operation_request(
        session_id="session-1",
        operation_id=preview.operation_id,
        request_id="request-1",
        mode="code",
        decision="full",
    )
    assert completed.state == terminal_repeat.state == "full"


def test_request_id_cannot_be_reused_for_another_operation(tmp_path) -> None:
    service, _, _, first_preview = _preview(tmp_path)
    second_preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    service.claim_operation_request(
        session_id="session-1",
        operation_id=first_preview.operation_id,
        request_id="request-shared",
        mode="code",
        decision="full",
    )
    with pytest.raises(FileHistoryError) as conflict:
        service.claim_operation_request(
            session_id="session-1",
            operation_id=second_preview.operation_id,
            request_id="request-shared",
            mode="code",
            decision="full",
        )
    assert conflict.value.code == "file_restore_request_conflict"


def test_reverse_012_concurrent_request_claim_has_exactly_one_winner(tmp_path) -> None:
    service, repositories, _, preview = _preview(tmp_path)
    barrier = threading.Barrier(2)

    def claim(request_id: str):
        barrier.wait()
        try:
            operation = service.claim_operation_request(
                session_id="session-1",
                operation_id=preview.operation_id,
                request_id=request_id,
                mode="code",
                decision="full",
            )
            return ("won", operation.request_id)
        except FileHistoryError as exc:
            return ("lost", exc.code)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(claim, "request-a"),
            executor.submit(claim, "request-b"),
        ]
        results = sorted(future.result() for future in futures)

    assert [status for status, _ in results] == ["lost", "won"]
    assert dict(results)["lost"] == "file_restore_request_conflict"
    operation = repositories.file_history.get_operation(preview.operation_id)
    assert operation is not None and operation.state == "running"
    assert operation.request_id in {"request-a", "request-b"}
