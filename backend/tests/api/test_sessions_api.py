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
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["list"][0]["id"] == session_id
    assert detail.json()["session"]["title"] == "会话一"


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


def test_sessions_api_updates_title_and_soft_deletes_session(tmp_path) -> None:
    client = _client(tmp_path)
    session_id = client.post("/api/sessions", json={"title": "旧标题"}).json()["session"]["id"]

    renamed = client.patch(f"/api/sessions/{session_id}", json={"title": "新标题"})
    listed_before_delete = client.get("/api/sessions")
    deleted = client.delete(f"/api/sessions/{session_id}")
    listed_after_delete = client.get("/api/sessions")
    detail_after_delete = client.get(f"/api/sessions/{session_id}")

    assert renamed.status_code == 200
    assert renamed.json()["session"]["title"] == "新标题"
    assert listed_before_delete.json()["total"] == 1
    assert deleted.status_code == 204
    assert listed_after_delete.json()["total"] == 0
    assert detail_after_delete.status_code == 404


def test_sessions_api_rejects_empty_title_and_archives_from_patch(tmp_path) -> None:
    client = _client(tmp_path)
    session_id = client.post("/api/sessions", json={"title": "旧标题"}).json()["session"]["id"]

    empty_title = client.patch(f"/api/sessions/{session_id}", json={"title": "  "})
    archived = client.patch(f"/api/sessions/{session_id}", json={"archived": True})

    assert empty_title.status_code == 400
    assert empty_title.json()["detail"]["code"] == "invalid_session_patch"
    assert archived.status_code == 200
    assert client.get("/api/sessions").json()["total"] == 0


def test_sessions_api_returns_404_for_missing_session(tmp_path) -> None:
    client = _client(tmp_path)

    detail = client.get("/api/sessions/missing")
    messages = client.get("/api/sessions/missing/messages")
    rename = client.patch("/api/sessions/missing", json={"title": "新标题"})
    delete = client.delete("/api/sessions/missing")

    assert detail.status_code == 404
    assert detail.json()["detail"]["code"] == "session_not_found"
    assert messages.status_code == 404
    assert rename.status_code == 404
    assert delete.status_code == 404
