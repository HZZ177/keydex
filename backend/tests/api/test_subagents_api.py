from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.subagents.models import SubagentRunSnapshot

NOW = datetime(2026, 7, 18, 15, 0, tzinfo=UTC)


def _app(tmp_path):
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system-keydex",
    )
    repositories = app.state.repositories
    parent = repositories.sessions.create(
        session_id="parent-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    other_parent = repositories.sessions.create(
        session_id="parent-2",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    repositories.sessions.create(
        session_id="chat-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="chat",
    )
    child = repositories.sessions.create(
        session_id="child-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-1",
        subagent_role="explorer",
        parent_session_id=parent.id,
        title="Hidden Explorer",
    )
    run = SubagentRunSnapshot(
        run_id="run-1",
        subagent_id=child.subagent_id or "",
        child_session_id=child.id,
        parent_session_id=parent.id,
        parent_trace_id="trace-1",
        parent_tool_call_id="tool-call-1",
        parent_timeline_sequence=0,
        initiated_by="main_agent",
        role="explorer",
        task="inspect",
        state="completed",
        version=3,
        final_report="done",
        created_at=NOW,
        queued_at=NOW,
        started_at=NOW,
        finished_at=NOW,
        updated_at=NOW,
    )
    repositories.subagent_runs.create(run)
    return app, parent, other_parent, run


def test_parent_run_list_and_get_are_complete_ordered_fact_sources(tmp_path) -> None:
    app, parent, _other_parent, run = _app(tmp_path)

    with TestClient(app) as client:
        listed = client.get(f"/api/sessions/{parent.id}/subagents/runs")
        fetched = client.get(f"/api/sessions/{parent.id}/subagents/runs/{run.run_id}")

    assert listed.status_code == 200
    assert listed.json()["list"] == [run.model_dump(mode="json")]
    assert fetched.status_code == 200
    assert fetched.json()["run"] == run.model_dump(mode="json")


def test_run_query_rejects_wrong_parent_and_non_workspace_parent_without_leak(tmp_path) -> None:
    app, _parent, other_parent, run = _app(tmp_path)

    with TestClient(app) as client:
        cross_parent = client.get(
            f"/api/sessions/{other_parent.id}/subagents/runs/{run.run_id}"
        )
        chat_parent = client.get("/api/sessions/chat-1/subagents/runs")

    assert cross_parent.status_code == 404
    assert cross_parent.json()["detail"]["code"] == "RUN_NOT_FOUND"
    assert "child-1" not in cross_parent.text
    assert chat_parent.status_code == 404
    assert chat_parent.json()["detail"]["code"] == "SUBAGENT_PARENT_INVALID"


def test_websocket_parent_snapshot_actions_use_bound_parent_authority(tmp_path) -> None:
    app, parent, other_parent, run = _app(tmp_path)

    with TestClient(app) as client:
        with client.websocket_connect(f"/agent-base/ws/chat?session_id={parent.id}") as ws:
            ws.send_json({"action": "subagent_list_runs", "data": {"session_id": parent.id}})
            listed = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_get_run",
                    "data": {"session_id": parent.id, "run_id": run.run_id},
                }
            )
            fetched = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_list_runs",
                    "data": {"session_id": other_parent.id},
                }
            )
            denied = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_resume",
                    "data": {
                        "session_id": parent.id,
                        "run_id": run.run_id,
                        "subagent_id": run.subagent_id,
                        "child_session_id": run.child_session_id,
                        "expected_version": run.version,
                        "task": "user must not relaunch",
                    },
                }
            )
            forbidden_resume = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_close",
                    "data": {
                        "session_id": parent.id,
                        "run_id": run.run_id,
                        "subagent_id": run.subagent_id,
                        "child_session_id": run.child_session_id,
                        "expected_version": run.version,
                    },
                }
            )
            forbidden_close = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_cancel",
                    "data": {
                        "session_id": parent.id,
                        "run_id": run.run_id,
                        "subagent_id": run.subagent_id,
                        "child_session_id": run.child_session_id,
                        "expected_version": run.version - 1,
                    },
                }
            )
            stale_control = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_cancel",
                    "data": {
                        "session_id": parent.id,
                        "run_id": run.run_id,
                        "subagent_id": run.subagent_id,
                        "child_session_id": run.child_session_id,
                        "expected_version": run.version,
                    },
                }
            )
            controlled = ws.receive_json()

    assert listed["action"] == "subagent_runs_snapshot"
    assert listed["data"]["list"] == [run.model_dump(mode="json")]
    assert fetched["action"] == "subagent_run_snapshot"
    assert fetched["data"]["run"] == run.model_dump(mode="json")
    assert denied["action"] == "error"
    assert denied["data"]["error"]["code"] == "SUBAGENT_PARENT_INVALID"
    assert forbidden_resume["action"] == "error"
    assert forbidden_resume["data"]["error"]["code"] == "SUBAGENT_USER_RELAUNCH_FORBIDDEN"
    assert forbidden_close["action"] == "error"
    assert forbidden_close["data"]["error"]["code"] == "SUBAGENT_USER_CLOSE_FORBIDDEN"
    assert stale_control["action"] == "error"
    assert stale_control["data"]["error"]["code"] == "RUN_VERSION_CONFLICT"
    assert controlled["action"] == "subagent_control_result"
    assert controlled["data"]["operation"] == "cancel"
    assert controlled["data"]["run"]["run_id"] == run.run_id


def test_websocket_child_session_requires_controlled_parent_run_binding(tmp_path) -> None:
    app, parent, _other_parent, run = _app(tmp_path)

    with TestClient(app) as client:
        with client.websocket_connect(f"/agent-base/ws/chat?session_id={parent.id}") as ws:
            ws.send_json(
                {"action": "bind_session", "data": {"session_id": run.child_session_id}}
            )
            ordinary = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_bind_session",
                    "data": {
                        "parent_session_id": parent.id,
                        "run_id": "wrong-run",
                        "child_session_id": run.child_session_id,
                    },
                }
            )
            wrong_run = ws.receive_json()
            ws.send_json(
                {
                    "action": "subagent_bind_session",
                    "data": {
                        "parent_session_id": parent.id,
                        "run_id": run.run_id,
                        "child_session_id": run.child_session_id,
                    },
                }
            )
            controlled = ws.receive_json()

        with client.websocket_connect(
            f"/agent-base/ws/chat?session_id={run.child_session_id}"
        ) as hidden_ws:
            hidden_ws.send_json(
                {"action": "subagent_list_runs", "data": {"session_id": run.child_session_id}}
            )
            hidden_query = hidden_ws.receive_json()

    assert ordinary["action"] == "error"
    assert ordinary["data"]["error"]["code"] == "session_not_found"
    assert wrong_run["action"] == "error"
    assert wrong_run["data"]["error"]["code"] == "RUN_NOT_FOUND"
    assert controlled == {
        "action": "bind_ok",
        "data": {
            "session_id": run.child_session_id,
            "parent_session_id": parent.id,
            "run_id": run.run_id,
            "internal": True,
        },
    }
    assert hidden_query["action"] == "error"
    assert hidden_query["data"]["error"]["code"] == "SUBAGENT_PARENT_INVALID"


def test_controlled_child_session_load_requires_exact_parent_run_relationship(tmp_path) -> None:
    app, parent, other_parent, run = _app(tmp_path)

    with TestClient(app) as client:
        normal_detail = client.get(f"/api/sessions/{run.child_session_id}")
        normal_history = client.get(f"/api/sessions/{run.child_session_id}/history")
        controlled = client.get(
            f"/api/sessions/{parent.id}/subagents/runs/{run.run_id}/session"
        )
        wrong_parent = client.get(
            f"/api/sessions/{other_parent.id}/subagents/runs/{run.run_id}/session"
        )
        wrong_run = client.get(
            f"/api/sessions/{parent.id}/subagents/runs/other-run/session"
        )

    assert normal_detail.status_code == 404
    assert normal_history.status_code == 404
    assert controlled.status_code == 200
    payload = controlled.json()
    assert payload["session"] == payload["history"]["session"]
    assert payload["session"]["id"] == run.child_session_id
    assert payload["session"]["visibility"] == "internal"
    assert payload["session"]["agent_kind"] == "subagent"
    assert payload["history"]["list"] == []
    assert wrong_parent.status_code == 404
    assert wrong_parent.json()["detail"]["code"] == "RUN_NOT_FOUND"
    assert "Hidden Explorer" not in wrong_parent.text
    assert wrong_run.status_code == 404
    assert wrong_run.json()["detail"]["code"] == "RUN_NOT_FOUND"


def test_user_control_protocol_allows_only_steer_and_cancel(tmp_path) -> None:
    app, parent, _other_parent, run = _app(tmp_path)
    address = {
        "subagent_id": run.subagent_id,
        "child_session_id": run.child_session_id,
        "expected_version": run.version,
    }
    with TestClient(app) as client:
        stale = client.post(
            f"/api/sessions/{parent.id}/subagents/runs/{run.run_id}/cancel",
            json={**address, "expected_version": run.version - 1},
        )
        forged = client.post(
            f"/api/sessions/{parent.id}/subagents/runs/{run.run_id}/cancel",
            json={**address, "child_session_id": "other-child"},
        )
        resumed = client.post(
            f"/api/sessions/{parent.id}/subagents/runs/{run.run_id}/resume",
            json={**address, "task": "continue with context"},
        )
        old_close = client.post(
            f"/api/sessions/{parent.id}/subagents/runs/{run.run_id}/close",
            json=address,
        )
        listed_after_forbidden_controls = client.get(
            f"/api/sessions/{parent.id}/subagents/runs"
        )

    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "RUN_VERSION_CONFLICT"
    assert forged.status_code == 409
    assert forged.json()["detail"]["code"] == "CHILD_SESSION_ACCESS_DENIED"
    assert resumed.status_code == 403
    assert resumed.json()["detail"]["code"] == "SUBAGENT_USER_RELAUNCH_FORBIDDEN"
    assert old_close.status_code == 403
    assert old_close.json()["detail"]["code"] == "SUBAGENT_USER_CLOSE_FORBIDDEN"
    assert listed_after_forbidden_controls.json()["list"] == [run.model_dump(mode="json")]
