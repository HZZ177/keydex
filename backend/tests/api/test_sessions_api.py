from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.core.ids import new_id
from backend.app.main import create_app


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def test_sessions_api_creates_lists_and_reads_detail(tmp_path) -> None:
    client = _client(tmp_path)

    created = client.post(
        "/api/sessions",
        json={"title": "会话一", "scene_id": "desktop-agent"},
    )
    session_id = created.json()["session"]["id"]

    listed = client.get("/api/sessions")
    detail = client.get(f"/api/sessions/{session_id}")

    assert created.status_code == 200
    assert created.json()["session"]["title_source"] == "auto_candidate"
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["list"][0]["id"] == session_id
    assert listed.json()["list"][0]["pinned"] is False
    assert listed.json()["list"][0]["pinned_at"] is None
    assert detail.json()["session"]["title"] == "会话一"


def test_sessions_api_defaults_list_to_chat_tag(tmp_path) -> None:
    client = _client(tmp_path)

    chat = client.post("/api/sessions", json={"title": "普通会话"}).json()["session"]
    transient = client.post(
        "/api/sessions",
        json={"title": "临时会话", "session_tag": "btw"},
    ).json()["session"]

    default_list = client.get("/api/sessions")
    btw_list = client.get("/api/sessions", params={"session_tag": "btw"})
    grouped_default = client.get("/api/sessions/grouped")

    assert chat["session_tag"] == "chat"
    assert transient["session_tag"] == "btw"
    assert [item["id"] for item in default_list.json()["list"]] == [chat["id"]]
    assert [item["id"] for item in btw_list.json()["list"]] == [transient["id"]]
    assert grouped_default.json()["total"] == 1


def test_sessions_api_creates_workspace_session_and_filters(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    client = _client(tmp_path)
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "项目"},
    ).json()["workspace"]

    created = client.post(
        "/api/sessions",
        json={
            "title": "项目会话",
            "session_type": "workspace",
            "workspace_id": workspace["id"],
        },
    )
    chat = client.post(
        "/api/sessions",
        json={"title": "纯聊天", "session_type": "chat"},
    )
    workspace_list = client.get(
        "/api/sessions",
        params={"workspace_id": workspace["id"], "session_type": "workspace"},
    )
    chat_list = client.get("/api/sessions", params={"session_type": "chat"})

    assert created.status_code == 200
    session = created.json()["session"]
    assert session["session_type"] == "workspace"
    assert session["workspace_id"] == workspace["id"]
    assert session["cwd"] == str(project.resolve())
    assert session["workspace_roots"] == [str(project.resolve())]
    assert session["workspace"]["id"] == workspace["id"]
    assert chat.status_code == 200
    assert chat.json()["session"]["workspace_id"] is None
    assert workspace_list.json()["total"] == 1
    assert workspace_list.json()["list"][0]["id"] == session["id"]
    assert chat_list.json()["total"] == 1
    assert chat_list.json()["list"][0]["id"] == chat.json()["session"]["id"]


def test_sessions_api_returns_grouped_sessions(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    client = _client(tmp_path)
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "项目"},
    ).json()["workspace"]
    workspace_session = client.post(
        "/api/sessions",
        json={
            "title": "项目会话",
            "session_type": "workspace",
            "workspace_id": workspace["id"],
        },
    ).json()["session"]
    chat_session = client.post(
        "/api/sessions",
        json={"title": "纯聊天"},
    ).json()["session"]

    grouped = client.get(
        "/api/sessions/grouped",
        params={"current_session_id": workspace_session["id"]},
    )
    workspace_only = client.get(
        "/api/sessions/grouped",
        params={"workspace_id": workspace["id"], "session_type": "workspace"},
    )

    assert grouped.status_code == 200
    payload = grouped.json()
    assert payload["total"] == 2
    assert [group["type"] for group in payload["groups"]] == ["chat", "workspace"]
    assert payload["groups"][0]["list"][0]["id"] == chat_session["id"]
    assert payload["groups"][1]["workspace"]["id"] == workspace["id"]
    assert payload["groups"][1]["list"][0]["is_current"] is True
    assert workspace_only.json()["total"] == 1
    assert workspace_only.json()["groups"][0]["workspace_id"] == workspace["id"]


def test_sessions_api_rejects_invalid_workspace_session_contract(tmp_path) -> None:
    client = _client(tmp_path)

    missing_workspace = client.post(
        "/api/sessions",
        json={"session_type": "workspace"},
    )
    unknown_workspace = client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": "missing"},
    )
    chat_with_workspace = client.post(
        "/api/sessions",
        json={"session_type": "chat", "workspace_id": "ws_any"},
    )

    assert missing_workspace.status_code == 400
    assert missing_workspace.json()["detail"]["code"] == "invalid_session_create"
    assert unknown_workspace.status_code == 404
    assert unknown_workspace.json()["detail"]["code"] == "workspace_not_found"
    assert chat_with_workspace.status_code == 400
    assert chat_with_workspace.json()["detail"]["code"] == "invalid_session_create"


def test_sessions_api_returns_empty_history(tmp_path) -> None:
    client = _client(tmp_path)
    session_id = client.post("/api/sessions", json={}).json()["session"]["id"]

    response = client.get(f"/api/sessions/{session_id}/messages")

    assert response.status_code == 200
    assert response.json()["list"] == []
    assert response.json()["event_total"] == 0
    assert response.json()["turn_indexes"] == []


def test_sessions_api_returns_aggregated_messages(tmp_path) -> None:
    client = _client(tmp_path)
    app = client.app
    session_id = client.post("/api/sessions", json={"title": "历史"}).json()["session"]["id"]
    app.state.repositories.message_events.append(
        event_id=new_id(),
        session_id=session_id,
        turn_index=1,
        action="user_message",
        data={"content": "你好"},
    )
    app.state.repositories.message_events.append(
        event_id=new_id(),
        session_id=session_id,
        turn_index=1,
        action="stream_batch",
        data={"content": "收到"},
    )

    response = client.get(f"/api/sessions/{session_id}/history")

    assert response.status_code == 200
    messages = response.json()["list"]
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == "你好"
    assert messages[0]["attachments"] == []
    assert isinstance(messages[0]["timestamp"], int)
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == "收到"
    assert isinstance(messages[1]["timestamp"], int)
    assert response.json()["event_total"] == 2
    assert response.json()["turn_indexes"] == [1]


def test_sessions_api_defers_tool_payloads_and_loads_details(tmp_path) -> None:
    client = _client(tmp_path)
    app = client.app
    session_id = client.post("/api/sessions", json={"title": "工具历史"}).json()["session"]["id"]
    app.state.repositories.message_events.append(
        event_id="evt_tool_start",
        session_id=session_id,
        turn_index=1,
        action="tool_start",
        data={
            "tool": "read_file",
            "params": {"path": "README.md", "content": "x" * 5000},
            "run_id": "run_tool",
            "tool_call_id": "call_tool",
        },
    )
    app.state.repositories.message_events.append(
        event_id="evt_tool_end",
        session_id=session_id,
        turn_index=1,
        action="tool_end",
        data={
            "run_id": "run_tool",
            "tool_call_id": "call_tool",
            "result": "full file content",
            "duration_ms": 33,
            "ui_payload": {"text": "full file content"},
        },
    )

    history = client.get(f"/api/sessions/{session_id}/history")

    assert history.status_code == 200
    tool = history.json()["list"][0]
    assert tool["role"] == "tool"
    assert tool["toolDetailsDeferred"] is True
    assert tool["toolParams"] == {"path": "README.md"}
    assert "content" not in tool["toolParams"]
    assert "toolResult" not in tool
    assert tool["toolDetailRef"]["startEventId"] == "evt_tool_start"
    assert tool["toolDetailRef"]["endEventId"] == "evt_tool_end"

    detail = client.get(
        f"/api/sessions/{session_id}/tool-details",
        params={
            "start_event_id": "evt_tool_start",
            "end_event_id": "evt_tool_end",
        },
    )

    assert detail.status_code == 200
    payload = detail.json()["detail"]
    assert payload["toolName"] == "read_file"
    assert payload["toolParams"] == {"path": "README.md", "content": "x" * 5000}
    assert payload["toolResult"] == "full file content"
    assert payload["uiPayload"] == {"text": "full file content"}


def test_sessions_api_filters_turn_history(tmp_path) -> None:
    client = _client(tmp_path)
    app = client.app
    session_id = client.post("/api/sessions", json={}).json()["session"]["id"]
    app.state.repositories.message_events.append(
        event_id=new_id(),
        session_id=session_id,
        turn_index=1,
        action="user_message",
        data={"content": "第一轮"},
    )
    app.state.repositories.message_events.append(
        event_id=new_id(),
        session_id=session_id,
        turn_index=2,
        action="user_message",
        data={"content": "第二轮"},
    )

    response = client.get(f"/api/sessions/{session_id}/messages?turn_index=2")

    assert response.status_code == 200
    assert response.json()["list"][0]["content"] == "第二轮"
    assert response.json()["turn_indexes"] == [2]


def test_sessions_api_can_return_all_turn_history(tmp_path) -> None:
    client = _client(tmp_path)
    app = client.app
    session_id = client.post("/api/sessions", json={}).json()["session"]["id"]
    for turn in range(1, 7):
        app.state.repositories.message_events.append(
            event_id=f"evt_all_{turn}",
            session_id=session_id,
            turn_index=turn,
            action="user_message",
            data={"content": f"第 {turn} 轮"},
        )

    response = client.get(f"/api/sessions/{session_id}/history?all_turns=true")

    assert response.status_code == 200
    assert response.json()["turn_indexes"] == [1, 2, 3, 4, 5, 6]
    assert response.json()["has_more_older"] is False
    assert response.json()["next_cursor"] is None


def test_sessions_api_updates_title_and_archives_session(tmp_path) -> None:
    client = _client(tmp_path)
    session_id = client.post("/api/sessions", json={"title": "旧标题"}).json()["session"]["id"]

    renamed = client.patch(f"/api/sessions/{session_id}", json={"title": "新标题"})
    listed_before_archive = client.get("/api/sessions")
    archived = client.post(
        f"/api/sessions/{session_id}/archive",
        json={"request_id": "req-session-api-archive", "stop_if_active": False},
    )
    listed_after_archive = client.get("/api/sessions")
    detail_after_archive = client.get(f"/api/sessions/{session_id}")

    assert renamed.status_code == 200
    assert renamed.json()["session"]["title"] == "新标题"
    assert renamed.json()["session"]["title_source"] == "manual"
    assert listed_before_archive.json()["total"] == 1
    assert archived.status_code == 200
    assert archived.json()["archive_origin"] == "manual"
    assert listed_after_archive.json()["total"] == 0
    assert detail_after_archive.status_code == 409
    assert detail_after_archive.json()["detail"]["code"] == "session_archived"


def test_sessions_api_updates_pinned_state(tmp_path) -> None:
    client = _client(tmp_path)
    old_id = client.post("/api/sessions", json={"title": "旧会话"}).json()["session"]["id"]
    new_id = client.post("/api/sessions", json={"title": "新会话"}).json()["session"]["id"]

    pinned = client.patch(f"/api/sessions/{old_id}", json={"pinned": True})
    listed_pinned = client.get("/api/sessions")
    unpinned = client.patch(f"/api/sessions/{old_id}", json={"pinned": False})

    assert pinned.status_code == 200
    assert pinned.json()["session"]["pinned"] is True
    assert pinned.json()["session"]["pinned_at"]
    assert [item["id"] for item in listed_pinned.json()["list"]] == [old_id, new_id]
    assert unpinned.status_code == 200
    assert unpinned.json()["session"]["pinned"] is False
    assert unpinned.json()["session"]["pinned_at"] is None


def test_sessions_api_rejects_empty_title_and_legacy_archived_patch(tmp_path) -> None:
    client = _client(tmp_path)
    session_id = client.post("/api/sessions", json={"title": "旧标题"}).json()["session"]["id"]

    empty_title = client.patch(f"/api/sessions/{session_id}", json={"title": "  "})
    archived_patch = client.patch(f"/api/sessions/{session_id}", json={"archived": True})

    assert empty_title.status_code == 400
    assert empty_title.json()["detail"]["code"] == "invalid_session_patch"
    assert archived_patch.status_code == 422
    assert client.get("/api/sessions").json()["total"] == 1


def test_sessions_api_returns_404_for_missing_session(tmp_path) -> None:
    client = _client(tmp_path)

    detail = client.get("/api/sessions/missing")
    messages = client.get("/api/sessions/missing/messages")
    rename = client.patch("/api/sessions/missing", json={"title": "新标题"})
    legacy_delete = client.delete("/api/sessions/missing")

    assert detail.status_code == 404
    assert detail.json()["detail"]["code"] == "session_not_found"
    assert messages.status_code == 404
    assert rename.status_code == 404
    assert legacy_delete.status_code == 405


def test_sessions_api_never_exposes_or_mutates_internal_subagent_session(tmp_path) -> None:
    client = _client(tmp_path)
    repositories = client.app.state.repositories
    parent = repositories.sessions.create(
        session_id="parent-visible",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Visible parent",
        session_type="workspace",
    )
    child = repositories.sessions.create(
        session_id="child-internal",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Hidden child",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-api",
        subagent_role="explorer",
    )

    default_list = client.get("/api/sessions")
    forged_internal = client.get("/api/sessions", params={"include_internal": "true"})
    forged_tag = client.get("/api/sessions", params={"session_tag": "subagent"})
    search = client.get("/api/sessions", params={"title": "Hidden child"})
    detail = client.get(f"/api/sessions/{child.id}")
    history = client.get(f"/api/sessions/{child.id}/history")
    pin = client.patch(f"/api/sessions/{child.id}", json={"pinned": True})
    archive = client.post(
        f"/api/sessions/{child.id}/archive",
        json={"request_id": "archive-hidden-child", "stop_if_active": False},
    )

    assert [item["id"] for item in default_list.json()["list"]] == [parent.id]
    assert default_list.json()["total"] == 1
    assert [item["id"] for item in forged_internal.json()["list"]] == [parent.id]
    assert forged_internal.json()["total"] == 1
    assert forged_tag.json()["list"] == []
    assert search.json()["list"] == []
    assert detail.status_code == 404
    assert history.status_code == 404
    assert pin.status_code == 404
    assert archive.status_code == 404
    internal = repositories.sessions.get(child.id, include_internal=True)
    assert internal is not None
    assert internal.pinned_at is None
    assert internal.archived_at is None
