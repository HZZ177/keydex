from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileMutationSpec,
    FileRestoreDecision,
    FileRestoreMode,
)
from backend.app.services.session_fork_service import SessionReverseSource
from backend.app.services.session_reverse_service import (
    SessionReverseExecution,
    SessionReverseService,
)
from backend.app.storage import StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


class FailingConversation:
    def __init__(self, workspace: Path, *, create_conflict: bool = False) -> None:
        self.workspace = workspace
        self.create_conflict = create_conflict

    def resolve_reverse_source(self, *, session_id: str, message_event_id: str):
        return SessionReverseSource(
            session_id=session_id,
            active_session_id=session_id,
            checkpoint_id=None,
            checkpoint_ns="",
            trace_id="trace-1",
            turn_index=1,
            message_event_id=message_event_id,
        )

    def rewind_conversation(self, *, source_session, source):
        _ = source_session, source
        if self.create_conflict:
            (self.workspace / "created.txt").write_text(
                "external after restore\n",
                encoding="utf-8",
            )
        raise RuntimeError("injected conversation transaction failure")


def _case(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (
                id, user_id, scene_id, status, active_session_id,
                session_type, cwd, created_at, updated_at
            ) values ('session-1', 'user-1', 'scene-1', 'active', 'session-1',
                      'workspace', ?, ?, ?)
            """,
            (str(tmp_path), NOW, NOW),
        )
    repositories.trace_records.create(
        trace_id="trace-1",
        session_id="session-1",
        active_session_id="session-1",
        scene_id="desktop-agent",
        user_id="user-1",
        turn_index=1,
        root_node_id="trace-root",
        input_checkpoint_id=None,
        input_checkpoint_ns="",
        status="completed",
    )
    repositories.message_events.append(
        event_id="message-1",
        session_id="session-1",
        trace_record_id="trace-1",
        turn_index=1,
        action="user_message",
        data={"content": "restore me"},
    )
    history = FileHistoryService(repositories, data_dir=tmp_path / "data")
    snapshot = history.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    mutations = history.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=tmp_path,
        tool_name="create_file",
        tool_call_id="call-1",
        mutations=[FileMutationSpec(path="created.txt", kind="create")],
    )
    (tmp_path / "created.txt").write_text("created\n", encoding="utf-8")
    history.commit_writes(mutations, workspace_root=tmp_path)
    preview = history.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    return repositories, history, preview


def _request(preview) -> SessionReverseExecution:
    return SessionReverseExecution(
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        request_id="request-1",
        message_event_id="message-1",
        mode=FileRestoreMode.BOTH,
        decision=FileRestoreDecision.FULL,
    )


def test_conversation_failure_compensates_files_and_cursor(tmp_path) -> None:
    repositories, history, preview = _case(tmp_path)
    before = repositories.file_history.get_session_state("session-1")
    service = SessionReverseService(
        repositories,
        file_history=history,
        conversation=FailingConversation(tmp_path),
    )

    with pytest.raises(FileHistoryError) as error:
        service.execute(
            session_id="session-1",
            workspace_root=tmp_path,
            request=_request(preview),
        )

    assert error.value.code == "conversation_restore_failed"
    assert error.value.details["compensated"] is True
    assert (tmp_path / "created.txt").read_text(encoding="utf-8") == "created\n"
    operation = repositories.file_history.get_operation(preview.operation_id)
    after = repositories.file_history.get_session_state("session-1")
    assert operation is not None and operation.state == "compensated"
    assert operation.compensation_state == "complete"
    assert before is not None and after is not None
    assert after.active_snapshot_id == before.active_snapshot_id
    assert repositories.message_events.get("message-1") is not None

    retry_preview = history.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    retry = SessionReverseService(repositories, file_history=history).execute(
        session_id="session-1",
        workspace_root=tmp_path,
        request=SessionReverseExecution(
            operation_id=retry_preview.operation_id,
            preview_token=retry_preview.preview_token,
            request_id="request-retry",
            message_event_id="message-1",
            mode=FileRestoreMode.CODE,
            decision=FileRestoreDecision.FULL,
        ),
    )
    assert retry.status == "full"
    assert not (tmp_path / "created.txt").exists()


def test_compensation_conflict_blocks_session_and_preserves_external_change(tmp_path) -> None:
    repositories, history, preview = _case(tmp_path)
    service = SessionReverseService(
        repositories,
        file_history=history,
        conversation=FailingConversation(tmp_path, create_conflict=True),
    )

    with pytest.raises(FileHistoryError) as error:
        service.execute(
            session_id="session-1",
            workspace_root=tmp_path,
            request=_request(preview),
        )

    assert error.value.code == "file_restore_compensation_failed"
    assert (tmp_path / "created.txt").read_text(encoding="utf-8") == "external after restore\n"
    operation = repositories.file_history.get_operation(preview.operation_id)
    state = repositories.file_history.get_session_state("session-1")
    assert operation is not None and operation.state == "compensation_failed"
    assert state is not None and state.state == "blocked"
    assert state.blocked_reason == preview.operation_id


def test_full_rejects_conflict_and_force_is_explicitly_audited(tmp_path) -> None:
    repositories, history, preview = _case(tmp_path)
    (tmp_path / "created.txt").write_text("external before preview\n", encoding="utf-8")
    preview = history.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    assert preview.files[0].classification == "forceable_conflict"
    service = SessionReverseService(repositories, file_history=history)
    full = SessionReverseExecution(
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        request_id="request-full",
        message_event_id="message-1",
        mode=FileRestoreMode.CODE,
        decision=FileRestoreDecision.FULL,
    )

    with pytest.raises(FileHistoryError) as error:
        service.execute(session_id="session-1", workspace_root=tmp_path, request=full)
    assert error.value.code == "file_restore_conflict"
    assert (tmp_path / "created.txt").exists()

    force_preview = history.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    force = SessionReverseExecution(
        operation_id=force_preview.operation_id,
        preview_token=force_preview.preview_token,
        request_id="request-force",
        message_event_id="message-1",
        mode=FileRestoreMode.CODE,
        decision=FileRestoreDecision.FORCE_CONFLICTS,
    )
    result = service.execute(session_id="session-1", workspace_root=tmp_path, request=force)

    assert result.status == "full"
    assert result.forced_files == ("created.txt",)
    assert not (tmp_path / "created.txt").exists()
    file_result = repositories.file_history.list_operation_files(force_preview.operation_id)[0]
    assert file_result.user_authorized is True


def test_safe_partial_restores_ready_file_and_skips_conflict(tmp_path) -> None:
    repositories, history, _preview = _case(tmp_path)
    snapshot = repositories.file_history.get_snapshot_by_message("session-1", "message-1")
    assert snapshot is not None
    mutations = history.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=tmp_path,
        tool_name="create_file",
        tool_call_id="call-ready",
        mutations=[FileMutationSpec(path="ready.txt", kind="create")],
    )
    (tmp_path / "ready.txt").write_text("ready\n", encoding="utf-8")
    history.commit_writes(mutations, workspace_root=tmp_path)
    (tmp_path / "created.txt").write_text("external\n", encoding="utf-8")
    preview = history.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    request = SessionReverseExecution(
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        request_id="request-partial",
        message_event_id="message-1",
        mode=FileRestoreMode.CODE,
        decision=FileRestoreDecision.SAFE_PARTIAL,
    )

    result = SessionReverseService(repositories, file_history=history).execute(
        session_id="session-1",
        workspace_root=tmp_path,
        request=request,
    )

    assert result.status == "partial"
    assert result.restored_files == ("ready.txt",)
    assert result.skipped_files == ("created.txt",)
    assert not (tmp_path / "ready.txt").exists()
    assert (tmp_path / "created.txt").read_text(encoding="utf-8") == "external\n"


def test_cancel_has_zero_side_effect(tmp_path) -> None:
    repositories, history, preview = _case(tmp_path)
    before = repositories.file_history.get_session_state("session-1")
    request = SessionReverseExecution(
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        request_id="request-cancel",
        message_event_id="message-1",
        mode=FileRestoreMode.CODE,
        decision=FileRestoreDecision.CANCEL,
    )

    result = SessionReverseService(repositories, file_history=history).execute(
        session_id="session-1",
        workspace_root=tmp_path,
        request=request,
    )

    after = repositories.file_history.get_session_state("session-1")
    assert result.status == "cancelled"
    assert (tmp_path / "created.txt").read_text(encoding="utf-8") == "created\n"
    assert repositories.message_events.get("message-1") is not None
    assert before is not None and after is not None
    assert after.active_snapshot_id == before.active_snapshot_id


def test_both_second_decision_can_choose_conversation_only(tmp_path) -> None:
    repositories, history, preview = _case(tmp_path)
    before = repositories.file_history.get_session_state("session-1")
    request = SessionReverseExecution(
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        request_id="request-conversation-only",
        message_event_id="message-1",
        mode=FileRestoreMode.BOTH,
        decision=FileRestoreDecision.CONVERSATION_ONLY,
    )

    result = SessionReverseService(repositories, file_history=history).execute(
        session_id="session-1",
        workspace_root=tmp_path,
        request=request,
    )

    after = repositories.file_history.get_session_state("session-1")
    assert result.status == "full"
    assert result.conversation_rewound is True
    assert result.restored_input == "restore me"
    assert (tmp_path / "created.txt").read_text(encoding="utf-8") == "created\n"
    assert before is not None and after is not None
    assert after.active_snapshot_id == before.active_snapshot_id
