from __future__ import annotations

import time

import pytest

from backend.app.services import (
    GetHistoryRequest,
    ListSessionsRequest,
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _service(repositories: StorageRepositories) -> SessionService:
    return SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
    )


def _append(
    repositories: StorageRepositories,
    *,
    event_id: str,
    session_id: str,
    action: str,
    data: dict,
    turn: int,
) -> None:
    repositories.message_events.append(
        event_id=event_id,
        session_id=session_id,
        turn_index=turn,
        action=action,
        data=data,
    )


def test_session_service_lists_sessions_with_sort_filter_and_current_marker(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first = repositories.sessions.create(
        session_id="ses_first",
        user_id="local-user",
        scene_id="desktop-agent",
        title="旧会话",
    )
    time.sleep(0.001)
    second = repositories.sessions.create(
        session_id="ses_second",
        user_id="local-user",
        scene_id="desktop-agent",
        title="新会话",
    )
    service = _service(repositories)

    result = service.list_sessions(
        ListSessionsRequest(user_id="local-user", current_session_id=second.id)
    )

    assert result["total"] == 2
    assert [item["id"] for item in result["list"]] == [second.id, first.id]
    assert result["list"][0]["is_current"] is True
    assert result["list"][1]["is_current"] is False

    filtered = service.list_sessions(ListSessionsRequest(title="旧"))
    assert [item["id"] for item in filtered["list"]] == [first.id]


def test_session_service_groups_sessions_by_workspace_and_chat(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()
    workspace_a = repositories.workspaces.create(
        workspace_id="ws_alpha",
        root_path=alpha,
        name="Alpha",
    )
    workspace_b = repositories.workspaces.create(
        workspace_id="ws_beta",
        root_path=beta,
        name="Beta",
    )
    repositories.sessions.create(
        session_id="ses_alpha",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Alpha 会话",
        session_type="workspace",
        workspace_id=workspace_a.id,
        cwd=str(alpha),
        workspace_roots=[str(alpha)],
    )
    time.sleep(0.001)
    repositories.sessions.create(
        session_id="ses_chat",
        user_id="local-user",
        scene_id="desktop-agent",
        title="纯聊天",
    )
    time.sleep(0.001)
    repositories.sessions.create(
        session_id="ses_beta",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Beta 会话",
        session_type="workspace",
        workspace_id=workspace_b.id,
        cwd=str(beta),
        workspace_roots=[str(beta)],
    )
    service = _service(repositories)

    grouped = service.group_sessions(ListSessionsRequest(current_session_id="ses_beta"))

    assert grouped["total"] == 3
    assert [group["title"] for group in grouped["groups"]] == ["Beta", "对话", "Alpha"]
    assert grouped["groups"][0]["workspace_id"] == "ws_beta"
    assert grouped["groups"][0]["workspace"]["id"] == "ws_beta"
    assert grouped["groups"][0]["list"][0]["id"] == "ses_beta"
    assert grouped["groups"][0]["list"][0]["is_current"] is True
    assert grouped["groups"][1]["type"] == "chat"


def test_session_service_get_detail_raises_for_missing_session(tmp_path) -> None:
    service = _service(_repositories(tmp_path))

    with pytest.raises(SessionNotFoundError, match="会话不存在"):
        service.get_session_detail("ses_missing")


def test_session_service_creates_workspace_and_chat_sessions_with_contract(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    service = _service(repositories)

    workspace_session = service.create_session(
        session_id="ses_workspace",
        user_id="local-user",
        scene_id="desktop-agent",
        title="项目会话",
        session_type="workspace",
        workspace_id=workspace.id,
    )
    chat_session = service.create_session(
        session_id="ses_chat",
        user_id="local-user",
        scene_id="desktop-agent",
        title="纯聊天",
        session_type="chat",
    )

    assert workspace_session["session_type"] == "workspace"
    assert workspace_session["workspace_id"] == workspace.id
    assert workspace_session["cwd"] == str(project.resolve())
    assert workspace_session["workspace_roots"] == [str(project.resolve())]
    assert workspace_session["workspace"]["id"] == workspace.id
    assert chat_session["session_type"] == "chat"
    assert chat_session["workspace_id"] is None
    assert chat_session["cwd"] is None
    assert chat_session["workspace"] is None


def test_session_service_touches_workspace_when_project_session_is_created(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()
    alpha_workspace = repositories.workspaces.create(
        workspace_id="ws_alpha",
        root_path=alpha,
        last_opened_at="2000-01-01T00:00:00Z",
    )
    beta_workspace = repositories.workspaces.create(
        workspace_id="ws_beta",
        root_path=beta,
        last_opened_at="2000-01-02T00:00:00Z",
    )
    service = _service(repositories)

    session = service.create_session(
        session_id="ses_alpha",
        user_id="local-user",
        scene_id="desktop-agent",
        title="最近项目",
        session_type="workspace",
        workspace_id=alpha_workspace.id,
    )

    touched = repositories.workspaces.get(alpha_workspace.id)
    assert touched is not None
    assert touched.last_opened_at not in {None, "2000-01-01T00:00:00Z"}
    assert session["workspace"]["last_opened_at"] == touched.last_opened_at
    assert [record.id for record in repositories.workspaces.list()][:2] == [
        alpha_workspace.id,
        beta_workspace.id,
    ]


def test_session_service_rejects_invalid_workspace_session_contract(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    service = _service(repositories)

    with pytest.raises(SessionValidationError, match="必须选择工作区"):
        service.create_session(
            user_id="local-user",
            scene_id="desktop-agent",
            session_type="workspace",
        )
    with pytest.raises(SessionValidationError, match="不能绑定工作区"):
        service.create_session(
            user_id="local-user",
            scene_id="desktop-agent",
            session_type="chat",
            workspace_id=workspace.id,
        )
    with pytest.raises(SessionValidationError, match="不在工作区内"):
        service.create_session(
            user_id="local-user",
            scene_id="desktop-agent",
            session_type="workspace",
            workspace_id=workspace.id,
            cwd=str(outside),
        )


def test_session_service_returns_empty_history_for_session_without_events(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_empty",
        user_id="local-user",
        scene_id="desktop-agent",
        title="空历史",
    )
    service = _service(repositories)

    result = service.get_history(GetHistoryRequest(session_id="ses_empty"))

    assert result["session"]["id"] == "ses_empty"
    assert result["list"] == []
    assert result["total"] == 0
    assert result["event_total"] == 0
    assert result["turn_indexes"] == []


def test_session_service_restores_multi_turn_history_and_turn_filter(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_history",
        user_id="local-user",
        scene_id="desktop-agent",
        title="多轮历史",
    )
    _append(
        repositories,
        event_id="evt_1",
        session_id="ses_history",
        action="user_message",
        data={"content": "第一轮"},
        turn=1,
    )
    _append(
        repositories,
        event_id="evt_2",
        session_id="ses_history",
        action="stream_batch",
        data={"content": "第一轮回答"},
        turn=1,
    )
    _append(
        repositories,
        event_id="evt_3",
        session_id="ses_history",
        action="completed",
        data={"ghost_footer": {"trace_id": "trace_1"}},
        turn=1,
    )
    _append(
        repositories,
        event_id="evt_4",
        session_id="ses_history",
        action="user_message",
        data={"content": "第二轮"},
        turn=2,
    )
    _append(
        repositories,
        event_id="evt_5",
        session_id="ses_history",
        action="reasoning",
        data={"kind": "reasoning", "text": "思考中"},
        turn=2,
    )
    service = _service(repositories)

    full_history = service.get_history(GetHistoryRequest(session_id="ses_history"))

    assert [item["role"] for item in full_history["list"]] == [
        "user",
        "assistant",
        "user",
        "reasoning",
    ]
    assert full_history["list"][1]["traceId"] == "trace_1"
    assert full_history["turn_indexes"] == [1, 2]
    assert full_history["event_total"] == 5

    second_turn = service.get_history(
        GetHistoryRequest(session_id="ses_history", turn_index=2)
    )

    assert [item["content"] for item in second_turn["list"]] == ["第二轮", "思考中"]
    assert second_turn["turn_indexes"] == [2]


def test_session_service_updates_session_terminal_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_status",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    service = _service(repositories)

    assert service.touch_session("ses_status")["status"] == "active"
    assert service.mark_session_failed("ses_status")["status"] == "failed"
    assert service.close_session("ses_status")["status"] == "closed"


def test_session_service_renames_and_deletes_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_mutation",
        user_id="local-user",
        scene_id="desktop-agent",
        title="旧标题",
    )
    service = _service(repositories)

    renamed = service.rename_session("ses_mutation", "  新标题  ")

    assert renamed["title"] == "新标题"
    with pytest.raises(SessionValidationError, match="会话标题不能为空"):
        service.rename_session("ses_mutation", "  ")

    deleted = service.delete_session("ses_mutation")

    assert deleted["id"] == "ses_mutation"
    assert repositories.sessions.get("ses_mutation") is None
    assert service.list_sessions(ListSessionsRequest())["total"] == 0
    with pytest.raises(SessionNotFoundError, match="会话不存在"):
        service.delete_session("ses_mutation")
