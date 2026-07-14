from __future__ import annotations

import time

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def test_session_repository_create_get_and_list(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    first = repositories.sessions.create(
        session_id="ses_first",
        user_id="local-user",
        scene_id="desktop-agent",
        title="第一轮",
    )
    time.sleep(0.001)
    second = repositories.sessions.create(
        session_id="ses_second",
        user_id="local-user",
        scene_id="desktop-agent",
        title="第二轮",
        status="running",
    )
    waiting = repositories.sessions.create(
        session_id="ses_waiting_input",
        user_id="local-user",
        scene_id="desktop-agent",
        title="等待输入",
        status="waiting_input",
    )

    assert first.id == "ses_first"
    assert first.status == "active"
    assert first.active_session_id == "ses_first"
    assert first.session_type == "chat"
    assert first.title_source == "auto_candidate"
    assert first.pinned_at is None
    assert first.workspace_id is None
    assert first.cwd is None
    assert first.workspace_roots == []
    assert repositories.sessions.get("ses_first") == first

    sessions = repositories.sessions.list(user_id="local-user", scene_id="desktop-agent")
    assert [session.id for session in sessions] == [waiting.id, second.id, first.id]
    assert repositories.sessions.list(status="running") == [second]
    assert repositories.sessions.list(status="waiting_input") == [waiting]


def test_session_repository_hides_internal_context_compression_sessions_by_default(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    visible = repositories.sessions.create(
        session_id="ses_visible",
        user_id="local-user",
        scene_id="desktop-agent",
        title="可见会话",
    )
    internal = repositories.sessions.create(
        session_id="ses_internal",
        user_id="local-user",
        scene_id="desktop-agent",
        title="压缩分支",
        session_tag=repositories.sessions.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG,
    )
    legacy_internal = repositories.sessions.create(
        session_id="ses_legacy_internal",
        user_id="local-user",
        scene_id="desktop-agent",
        title="旧压缩分支",
        active_session_id="ses_legacy_internal",
        parent_session_id=visible.id,
        source_active_session_id=visible.id,
        source_checkpoint_id="ckpt_legacy",
        source_checkpoint_ns="",
    )

    assert repositories.sessions.get(internal.id) == internal
    assert repositories.sessions.get(legacy_internal.id) == legacy_internal
    assert repositories.sessions.list(user_id="local-user", scene_id="desktop-agent") == [visible]
    all_session_ids = {
        record.id
        for record in repositories.sessions.list(
            user_id="local-user",
            scene_id="desktop-agent",
            include_internal=True,
        )
    }
    assert all_session_ids == {visible.id, internal.id, legacy_internal.id}
    assert repositories.sessions.list(
        session_tag=repositories.sessions.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG,
    ) == [internal]


def test_session_repository_pins_sessions_without_touching_updated_at(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    old = repositories.sessions.create(
        session_id="ses_old",
        user_id="local-user",
        scene_id="desktop-agent",
        title="旧会话",
    )
    time.sleep(0.001)
    new = repositories.sessions.create(
        session_id="ses_new",
        user_id="local-user",
        scene_id="desktop-agent",
        title="新会话",
    )

    pinned = repositories.sessions.set_pinned(old.id, True)

    assert pinned is not None
    assert pinned.pinned_at is not None
    assert pinned.updated_at == old.updated_at
    assert [session.id for session in repositories.sessions.list()] == [old.id, new.id]

    unpinned = repositories.sessions.set_pinned(old.id, False)

    assert unpinned is not None
    assert unpinned.pinned_at is None
    assert [session.id for session in repositories.sessions.list()] == [new.id, old.id]


def test_session_repository_persists_workspace_runtime_fields(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into workspaces (
              id, name, root_path, normalized_root_path, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?)
            """,
            (
                "ws_project",
                "demo",
                "D:/Projects/demo",
                "d:/projects/demo",
                "2026-06-18T00:00:00Z",
                "2026-06-18T00:00:00Z",
            ),
        )

    workspace_session = repositories.sessions.create(
        session_id="ses_workspace",
        user_id="local-user",
        scene_id="desktop-agent",
        title="项目会话",
        workspace_id="ws_project",
        session_type="workspace",
        cwd="D:/Projects/demo",
        workspace_roots=["D:/Projects/demo"],
    )
    chat_session = repositories.sessions.create(
        session_id="ses_chat",
        user_id="local-user",
        scene_id="desktop-agent",
        title="纯聊天",
    )

    assert workspace_session.workspace_id == "ws_project"
    assert workspace_session.session_type == "workspace"
    assert workspace_session.cwd == "D:/Projects/demo"
    assert workspace_session.workspace_roots == ["D:/Projects/demo"]
    assert chat_session.session_type == "chat"
    assert chat_session.workspace_id is None

    assert repositories.sessions.get("ses_workspace") == workspace_session
    assert repositories.sessions.list(workspace_id="ws_project") == [workspace_session]
    assert repositories.sessions.list(session_type="workspace") == [workspace_session]
    assert repositories.sessions.list(session_type="chat") == [chat_session]


def test_session_repository_update_status_title_and_touch(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_update",
        user_id="local-user",
        scene_id="desktop-agent",
        title="旧标题",
    )

    updated = repositories.sessions.update(
        session.id,
        title="新标题",
        status="waiting_input",
        active_session_id="ses_active",
    )

    assert updated is not None
    assert updated.title == "新标题"
    assert updated.status == "waiting_input"
    assert updated.active_session_id == "ses_active"
    assert updated.updated_at >= session.updated_at

    closed = repositories.sessions.close(session.id)
    assert closed is not None
    assert closed.status == "closed"

    touched = repositories.sessions.touch(session.id)
    assert touched is not None
    assert touched.updated_at >= closed.updated_at


def test_session_repository_persists_context_window_usage(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_context_usage",
        user_id="local-user",
        scene_id="desktop-agent",
        title="上下文窗口",
    )
    snapshot = {
        "middleware": "ContextCompressionMiddleware",
        "stage": "context_window_snapshot",
        "session_id": session.id,
        "active_session_id": session.id,
        "token_count": 5371,
        "context_window": 200000,
        "threshold_token_count": 160000,
        "threshold_usage_fraction": 5371 / 160000,
        "token_source": "usage_metadata",
    }

    updated = repositories.sessions.update_context_window_usage(session.id, snapshot)

    assert updated is not None
    assert updated.context_window_usage == snapshot
    assert updated.updated_at >= session.updated_at
    assert repositories.sessions.get(session.id).context_window_usage == snapshot


def test_session_repository_auto_title_write_respects_title_source(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    auto_session = repositories.sessions.create(
        session_id="ses_auto_title",
        user_id="local-user",
        scene_id="desktop-agent",
        title="默认标题",
    )
    manual_session = repositories.sessions.create(
        session_id="ses_manual_title",
        user_id="local-user",
        scene_id="desktop-agent",
        title="默认标题",
    )
    repositories.sessions.update(manual_session.id, title="手动标题", title_source="manual")

    updated = repositories.sessions.update_title_if_auto_allowed(
        auto_session.id,
        title="自动标题",
        only_when_default_title=True,
    )
    blocked = repositories.sessions.update_title_if_auto_allowed(
        manual_session.id,
        title="不应覆盖",
        only_when_default_title=False,
    )
    blocked_second_update = repositories.sessions.update_title_if_auto_allowed(
        auto_session.id,
        title="二次自动标题",
        only_when_default_title=True,
    )

    assert updated is not None
    assert updated.title == "自动标题"
    assert updated.title_source == "auto"
    assert blocked is None
    assert repositories.sessions.get(manual_session.id).title == "手动标题"
    assert blocked_second_update is None
    assert repositories.sessions.get(auto_session.id).title == "自动标题"


def test_session_repository_filters_archived_records_and_clamps_limit(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    for index in range(3):
        repositories.sessions.create(
            session_id=f"ses_limit_{index}",
            user_id="local-user",
            scene_id="desktop-agent",
            title=f"会话 {index}",
        )
        time.sleep(0.001)

    repositories.sessions.archive_manual(
        "ses_limit_1",
        archived_at="2026-07-14T12:00:00Z",
    )

    assert repositories.sessions.get("ses_limit_1") is None
    archived = repositories.sessions.get_archived("ses_limit_1")
    assert archived is not None
    assert archived.archive_origin == "manual"

    visible_ids = [
        session.id
        for session in repositories.sessions.list(
            user_id="local-user",
            scene_id="desktop-agent",
            limit=10,
        )
    ]
    assert visible_ids == ["ses_limit_2", "ses_limit_0"]

    limited = repositories.sessions.list(user_id="local-user", scene_id="desktop-agent", limit=1)
    assert [session.id for session in limited] == ["ses_limit_2"]

    archived_page = repositories.sessions.list_archived(
        query="会话 1",
        exclude_archived_workspaces=False,
    )
    assert [item.session.id for item in archived_page.items] == ["ses_limit_1"]


def test_session_repository_archives_and_restores_session_idempotently(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_delete",
        user_id="local-user",
        scene_id="desktop-agent",
        title="待删除",
    )

    archived = repositories.sessions.archive_manual(
        session.id,
        archived_at="2026-07-14T12:00:00Z",
    )

    assert archived.record is not None
    assert archived.record.id == session.id
    assert archived.record.archive_origin == "manual"
    assert archived.record.updated_at == session.updated_at
    assert repositories.sessions.get(session.id) is None
    assert repositories.sessions.archive_manual(
        session.id,
        archived_at="2026-07-14T13:00:00Z",
    ).changed is False

    restored = repositories.sessions.restore(session.id)
    assert restored.changed is True
    assert restored.record is not None
    assert restored.record.archived_at is None
    assert repositories.sessions.get(session.id) is not None


def test_session_repository_rejects_invalid_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    with pytest.raises(ValueError, match="不支持的 session 状态"):
        repositories.sessions.create(
            session_id="ses_invalid",
            user_id="local-user",
            scene_id="desktop-agent",
            status="paused",
        )

    repositories.sessions.create(
        session_id="ses_valid",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    with pytest.raises(ValueError, match="不支持的 session 状态"):
        repositories.sessions.update("ses_valid", status="paused")

    with pytest.raises(ValueError, match="不支持的 session 类型"):
        repositories.sessions.create(
            session_id="ses_invalid_type",
            user_id="local-user",
            scene_id="desktop-agent",
            session_type="project",
        )
