from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.services.file_history_service import (
    FileHistoryError,
    FileMutationSpec,
    FileRestoreDecision,
    FileRestoreMode,
)
from backend.app.services.session_fork_service import SessionForkService
from backend.app.services.session_reverse_service import (
    SessionReverseExecution,
    SessionReverseService,
)


class _CompensationConflictConversation:
    def __init__(self, repositories, project) -> None:
        self.delegate = SessionForkService(repositories)
        self.project = project

    def resolve_reverse_source(self, *, session_id: str, message_event_id: str):
        return self.delegate.resolve_reverse_source(
            session_id=session_id,
            message_event_id=message_event_id,
        )

    def rewind_conversation(self, *, source_session, source):
        _ = source_session, source
        (self.project / "created.txt").write_text(
            "external during compensation\n",
            encoding="utf-8",
        )
        raise RuntimeError("injected conversation failure")


def _case(tmp_path, *, with_file_change: bool = True):
    project = tmp_path / "project"
    project.mkdir()
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "project"},
    ).json()["workspace"]
    session = client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": workspace["id"]},
    ).json()["session"]
    repositories = client.app.state.repositories
    repositories.trace_records.create(
        trace_id="trace-1",
        session_id=session["id"],
        active_session_id=session["id"],
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace-1-root",
        input_checkpoint_id=None,
        input_checkpoint_ns="",
        status="completed",
    )
    repositories.message_events.append(
        event_id="message-1",
        session_id=session["id"],
        trace_record_id="trace-1",
        turn_index=1,
        action="user_message",
        data={"content": "restore this input"},
    )
    history = client.app.state.file_history_service
    if with_file_change:
        snapshot = history.make_input_snapshot(
            session_id=session["id"],
            active_session_id=session["id"],
            trace_id="trace-1",
            message_event_id="message-1",
            workspace_root=project,
        )
        mutations = history.prepare_writes(
            session_id=session["id"],
            active_session_id=session["id"],
            snapshot_id=snapshot.id,
            trace_id="trace-1",
            turn_index=1,
            workspace_root=project,
            tool_name="create_file",
            tool_call_id="call-1",
            mutations=[FileMutationSpec(path="created.txt", kind="create")],
        )
        (project / "created.txt").write_text("created\n", encoding="utf-8")
        history.commit_writes(mutations, workspace_root=project)
    return client, project, session


def _preview(client: TestClient, session_id: str) -> dict:
    response = client.post(
        f"/api/sessions/{session_id}/reverse/preview",
        json={"message_event_id": "message-1"},
    )
    assert response.status_code == 200
    return response.json()


def _execute(client: TestClient, session_id: str, preview: dict, **overrides):
    payload = {
        "message_event_id": "message-1",
        "operation_id": preview["operation_id"],
        "preview_token": preview["preview_token"],
        "request_id": "request-1",
        "mode": "both",
        "decision": "full",
    }
    payload.update(overrides)
    return client.post(f"/api/sessions/{session_id}/reverse", json=payload)


def _append_turn_with_write(
    client: TestClient,
    project,
    session_id: str,
    *,
    index: int,
    path: str,
    content: str,
) -> str:
    repositories = client.app.state.repositories
    trace_id = f"trace-{index}"
    message_id = f"message-{index}"
    repositories.trace_records.create(
        trace_id=trace_id,
        session_id=session_id,
        active_session_id=session_id,
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=index,
        root_node_id=f"{trace_id}-root",
        input_checkpoint_id=None,
        input_checkpoint_ns="",
        status="completed",
    )
    repositories.message_events.append(
        event_id=message_id,
        session_id=session_id,
        trace_record_id=trace_id,
        turn_index=index,
        action="user_message",
        data={"content": f"input {index}"},
    )
    history = client.app.state.file_history_service
    snapshot = history.make_input_snapshot(
        session_id=session_id,
        active_session_id=session_id,
        trace_id=trace_id,
        message_event_id=message_id,
        workspace_root=project,
    )
    target = project / path
    mutations = history.prepare_writes(
        session_id=session_id,
        active_session_id=session_id,
        snapshot_id=snapshot.id,
        trace_id=trace_id,
        turn_index=index,
        workspace_root=project,
        tool_name="write_file",
        tool_call_id=f"call-{index}",
        mutations=[
            FileMutationSpec(path=path, kind="update" if target.exists() else "create")
        ],
    )
    target.write_text(content, encoding="utf-8")
    history.commit_writes(mutations, workspace_root=project)
    return message_id


def test_code_only_restores_files_without_truncating_conversation(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])

    response = _execute(client, session["id"], preview, mode="code")

    assert response.status_code == 200
    assert response.json()["status"] == "full"
    assert response.json()["conversation_rewound"] is False
    assert response.json()["restored_files"] == ["created.txt"]
    assert not (project / "created.txt").exists()
    assert client.app.state.repositories.message_events.get("message-1") is not None


def test_conversation_only_restores_input_without_touching_files_or_cursor(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])
    before = client.app.state.repositories.file_history.get_session_state(session["id"])

    response = _execute(client, session["id"], preview, mode="conversation")

    assert response.status_code == 200
    payload = response.json()
    assert payload["conversation_rewound"] is True
    assert payload["restored_input"] == "restore this input"
    assert (project / "created.txt").read_text(encoding="utf-8") == "created\n"
    after = client.app.state.repositories.file_history.get_session_state(session["id"])
    assert after is not None and before is not None
    assert after.active_snapshot_id == before.active_snapshot_id
    assert client.app.state.repositories.message_events.get("message-1") is None


def test_both_restores_file_and_conversation_then_replays_idempotently(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])

    response = _execute(client, session["id"], preview)
    replay = _execute(client, session["id"], preview)

    assert response.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == response.json()
    assert response.json()["conversation_rewound"] is True
    assert response.json()["restored_input"] == "restore this input"
    assert not (project / "created.txt").exists()
    state = client.app.state.repositories.file_history.get_session_state(session["id"])
    assert state is not None
    active = client.app.state.repositories.file_history.get_snapshot(state.active_snapshot_id)
    assert active is not None and active.kind == "restore_result"


def test_execute_rejects_stale_preview_without_file_or_message_side_effect(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])
    (project / "created.txt").write_text("changed after preview\n", encoding="utf-8")

    response = _execute(client, session["id"], preview)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "file_preview_stale"
    assert (project / "created.txt").read_text(encoding="utf-8") == "changed after preview\n"
    assert client.app.state.repositories.message_events.get("message-1") is not None


def test_legacy_conversation_reverse_contract_remains_supported(tmp_path) -> None:
    client, _project, session = _case(tmp_path, with_file_change=False)

    response = client.post(
        f"/api/sessions/{session['id']}/reverse",
        json={"message_event_id": "message-1"},
    )

    assert response.status_code == 200
    assert "session" in response.json()
    assert response.json()["source"]["message_event_id"] == "message-1"


def test_rewind_then_new_edit_then_rewind_does_not_drift_cursor_or_disk(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    first = _preview(client, session["id"])
    first_result = _execute(
        client,
        session["id"],
        first,
        mode="code",
        request_id="request-first",
    )
    assert first_result.status_code == 200
    assert not (project / "created.txt").exists()

    repositories = client.app.state.repositories
    history = client.app.state.file_history_service
    SQLiteCheckpointSaver(repositories.db).put(
        {"configurable": {"thread_id": session["id"], "checkpoint_ns": ""}},
        {
            "v": 1,
            "id": "checkpoint-before-turn-2",
            "ts": "2026-07-14T00:00:00+00:00",
            "channel_values": {"messages": []},
            "channel_versions": {},
            "versions_seen": {},
        },
        {"step": 1},
        {},
    )
    repositories.trace_records.create(
        trace_id="trace-2",
        session_id=session["id"],
        active_session_id=session["id"],
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=2,
        root_node_id="trace-2-root",
        input_checkpoint_id="checkpoint-before-turn-2",
        input_checkpoint_ns="",
        status="completed",
    )
    repositories.message_events.append(
        event_id="message-2",
        session_id=session["id"],
        trace_record_id="trace-2",
        turn_index=2,
        action="user_message",
        data={"content": "second input"},
    )
    second_snapshot = history.make_input_snapshot(
        session_id=session["id"],
        active_session_id=session["id"],
        trace_id="trace-2",
        message_event_id="message-2",
        workspace_root=project,
    )
    mutations = history.prepare_writes(
        session_id=session["id"],
        active_session_id=session["id"],
        snapshot_id=second_snapshot.id,
        trace_id="trace-2",
        turn_index=2,
        workspace_root=project,
        tool_name="create_file",
        tool_call_id="call-2",
        mutations=[FileMutationSpec(path="second.txt", kind="create")],
    )
    (project / "second.txt").write_text("second\n", encoding="utf-8")
    history.commit_writes(mutations, workspace_root=project)

    second = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-2"},
    ).json()
    second_result = client.post(
        f"/api/sessions/{session['id']}/reverse",
        json={
            "message_event_id": "message-2",
            "operation_id": second["operation_id"],
            "preview_token": second["preview_token"],
            "request_id": "request-second",
            "mode": "code",
            "decision": "full",
        },
    )

    assert second_result.status_code == 200
    assert not (project / "created.txt").exists()
    assert not (project / "second.txt").exists()
    state = repositories.file_history.get_session_state(session["id"])
    assert state is not None
    active = repositories.file_history.get_snapshot(state.active_snapshot_id)
    assert active is not None and active.kind == "restore_result"


def test_operation_status_returns_persisted_terminal_result_without_private_paths(tmp_path) -> None:
    client, _project, session = _case(tmp_path)
    preview = _preview(client, session["id"])
    executed = _execute(client, session["id"], preview, mode="code")

    status = client.get(f"/api/sessions/{session['id']}/reverse/{preview['operation_id']}")

    assert executed.status_code == 200
    assert status.status_code == 200
    payload = status.json()
    assert payload["status"] == "full"
    assert payload["result"] == executed.json()
    assert payload["blocked_paths"] == []
    serialized = status.text.lower()
    assert "backup_file_name" not in serialized
    assert str(client.app.state.settings.data_dir).lower() not in serialized


def test_execute_rejects_mode_specific_invalid_decision_and_extra_fields(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])

    invalid = _execute(
        client,
        session["id"],
        preview,
        mode="code",
        decision="conversation_only",
    )
    extra = client.post(
        f"/api/sessions/{session['id']}/reverse",
        json={
            "message_event_id": "message-1",
            "operation_id": preview["operation_id"],
            "preview_token": preview["preview_token"],
            "request_id": "request-extra",
            "mode": "code",
            "decision": "full",
            "force_paths": ["not-authorized.txt"],
        },
    )

    assert invalid.status_code == 409
    assert invalid.json()["detail"]["code"] == "file_restore_invalid_decision"
    assert extra.status_code == 422
    assert (project / "created.txt").read_text(encoding="utf-8") == "created\n"
    assert client.app.state.repositories.message_events.get("message-1") is not None


def test_cancel_and_cross_session_token_have_zero_file_side_effects(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])
    workspace_id = session["workspace_id"]
    other = client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": workspace_id},
    ).json()["session"]

    cross_session = _execute(
        client,
        other["id"],
        preview,
        mode="code",
        request_id="request-cross-session",
    )
    cancelled = _execute(
        client,
        session["id"],
        preview,
        mode="code",
        decision="cancel",
        request_id="request-cancel",
    )

    assert cross_session.status_code == 404
    assert cross_session.json()["detail"]["code"] == "file_snapshot_missing"
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert (project / "created.txt").read_text(encoding="utf-8") == "created\n"


def test_both_rewind_then_new_message_edit_then_both_rewind_has_no_drift(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    first_preview = _preview(client, session["id"])
    first = _execute(
        client,
        session["id"],
        first_preview,
        mode="both",
        request_id="request-both-1",
    )
    assert first.status_code == 200
    assert not (project / "created.txt").exists()
    assert client.app.state.repositories.message_events.get("message-1") is None

    second_message = _append_turn_with_write(
        client,
        project,
        session["id"],
        index=2,
        path="second.txt",
        content="second branch\n",
    )
    second_preview = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": second_message},
    ).json()
    second = _execute(
        client,
        session["id"],
        second_preview,
        message_event_id=second_message,
        mode="both",
        request_id="request-both-2",
    )

    assert second.status_code == 200
    assert second.json()["conversation_rewound"] is True
    assert not (project / "created.txt").exists()
    assert not (project / "second.txt").exists()
    assert client.app.state.repositories.message_events.get(second_message) is None


def test_conversation_rewind_then_new_write_code_rewind_anchors_kept_disk(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    first_preview = _preview(client, session["id"])
    conversation = _execute(
        client,
        session["id"],
        first_preview,
        mode="conversation",
        request_id="request-conversation-1",
    )
    assert conversation.status_code == 200
    assert (project / "created.txt").read_text(encoding="utf-8") == "created\n"

    second_message = _append_turn_with_write(
        client,
        project,
        session["id"],
        index=2,
        path="created.txt",
        content="updated on new branch\n",
    )
    second_preview = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": second_message},
    ).json()
    code = _execute(
        client,
        session["id"],
        second_preview,
        message_event_id=second_message,
        mode="code",
        request_id="request-code-2",
    )

    assert code.status_code == 200
    assert code.json()["conversation_rewound"] is False
    assert (project / "created.txt").read_text(encoding="utf-8") == "created\n"
    assert client.app.state.repositories.message_events.get(second_message) is not None


def test_blocked_operation_status_exposes_relative_paths_and_operation_id(tmp_path) -> None:
    client, project, session = _case(tmp_path)
    preview = _preview(client, session["id"])
    repositories = client.app.state.repositories
    service = SessionReverseService(
        repositories,
        file_history=client.app.state.file_history_service,
        conversation=_CompensationConflictConversation(repositories, project),
    )

    with pytest.raises(FileHistoryError) as failure:
        service.execute(
            session_id=session["id"],
            workspace_root=project,
            request=SessionReverseExecution(
                operation_id=preview["operation_id"],
                preview_token=preview["preview_token"],
                request_id="request-blocked",
                message_event_id="message-1",
                mode=FileRestoreMode.BOTH,
                decision=FileRestoreDecision.FULL,
            ),
        )
    assert failure.value.code == "file_restore_compensation_failed"

    status = client.get(f"/api/sessions/{session['id']}/reverse/{preview['operation_id']}")

    assert status.status_code == 200
    payload = status.json()
    assert payload["operation_id"] == preview["operation_id"]
    assert payload["status"] == "compensation_failed"
    assert payload["blocked_paths"] == ["created.txt"]
    assert all(not path.startswith(("/", "C:")) for path in payload["blocked_paths"])
