from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.services.file_history_service import FileMutationSpec


def _workspace_session(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "project"},
    ).json()["workspace"]
    session = client.post(
        "/api/sessions",
        json={
            "session_type": "workspace",
            "workspace_id": workspace["id"],
        },
    ).json()["session"]
    return client, project, session


def _message_anchor(client, session_id: str, message_id: str, trace_id: str, *, running=False):
    repositories = client.app.state.repositories
    repositories.trace_records.create(
        trace_id=trace_id,
        session_id=session_id,
        active_session_id=session_id,
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id=f"{trace_id}-root",
        input_checkpoint_id=None,
        input_checkpoint_ns="",
        status="running" if running else "completed",
    )
    repositories.message_events.append(
        event_id=message_id,
        session_id=session_id,
        trace_record_id=trace_id,
        turn_index=1,
        action="user_message",
        data={"content": "rewind me"},
    )


def test_reverse_preview_returns_real_diff_and_persisted_token(tmp_path) -> None:
    client, project, session = _workspace_session(tmp_path)
    _message_anchor(client, session["id"], "message-1", "trace-1")
    history = client.app.state.file_history_service
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

    response = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-1"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["conversation_available"] is True
    assert payload["code_available"] is True
    assert payload["default_mode"] == "both"
    assert payload["files"][0]["path"] == "created.txt"
    assert payload["files"][0]["target_state"] == "missing"
    operation = client.app.state.repositories.file_history.get_operation(
        payload["operation_id"]
    )
    assert operation is not None and operation.preview_token == payload["preview_token"]


def test_reverse_preview_legacy_message_is_conversation_only(tmp_path) -> None:
    client, _project, session = _workspace_session(tmp_path)
    _message_anchor(client, session["id"], "message-old", "trace-old")

    response = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-old"},
    )

    assert response.status_code == 200
    assert response.json()["code_available"] is False
    assert response.json()["default_mode"] == "conversation"
    assert response.json()["snapshot_id"] is None


def test_reverse_preview_rejects_running_session_with_stable_error(tmp_path) -> None:
    client, _project, session = _workspace_session(tmp_path)
    _message_anchor(
        client,
        session["id"],
        "message-running",
        "trace-running",
        running=True,
    )

    response = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-running"},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "file_restore_turn_running"


def test_reverse_preview_rejects_cross_session_missing_and_non_user_anchors(tmp_path) -> None:
    client, _project, session = _workspace_session(tmp_path)
    other = client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": session["workspace_id"]},
    ).json()["session"]
    _message_anchor(client, other["id"], "message-other", "trace-other")
    repositories = client.app.state.repositories
    repositories.message_events.append(
        event_id="message-assistant",
        session_id=session["id"],
        trace_record_id=None,
        turn_index=1,
        action="assistant_message",
        data={"content": "not a rewind anchor"},
    )

    cross = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-other"},
    )
    missing = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "missing"},
    )
    wrong_role = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-assistant"},
    )

    assert cross.status_code == 404
    assert missing.status_code == 404
    assert wrong_role.status_code == 400
    assert cross.json()["detail"]["code"] == "message_event_not_found"
    assert wrong_role.json()["detail"]["code"] == "reverse_source_must_be_user_message"
