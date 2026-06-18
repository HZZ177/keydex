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

    assert first.id == "ses_first"
    assert first.status == "active"
    assert first.active_session_id == "ses_first"
    assert repositories.sessions.get("ses_first") == first

    sessions = repositories.sessions.list(user_id="local-user", scene_id="desktop-agent")
    assert [session.id for session in sessions] == [second.id, first.id]
    assert repositories.sessions.list(status="running") == [second]


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
        status="running",
        active_session_id="ses_active",
    )

    assert updated is not None
    assert updated.title == "新标题"
    assert updated.status == "running"
    assert updated.active_session_id == "ses_active"
    assert updated.updated_at >= session.updated_at

    closed = repositories.sessions.close(session.id)
    assert closed is not None
    assert closed.status == "closed"

    touched = repositories.sessions.touch(session.id)
    assert touched is not None
    assert touched.updated_at >= closed.updated_at


def test_session_repository_filters_soft_deleted_records_and_clamps_limit(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    for index in range(3):
        repositories.sessions.create(
            session_id=f"ses_limit_{index}",
            user_id="local-user",
            scene_id="desktop-agent",
            title=f"会话 {index}",
        )
        time.sleep(0.001)

    with repositories.db.transaction() as conn:
        conn.execute("update sessions set is_deleted = 1 where id = ?", ("ses_limit_1",))

    assert repositories.sessions.get("ses_limit_1") is None
    deleted = repositories.sessions.get("ses_limit_1", include_deleted=True)
    assert deleted is not None
    assert deleted.is_deleted is True

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

    with_deleted = repositories.sessions.list(
        user_id="local-user",
        scene_id="desktop-agent",
        include_deleted=True,
        limit=10,
    )
    assert {session.id for session in with_deleted} == {
        "ses_limit_0",
        "ses_limit_1",
        "ses_limit_2",
    }


def test_session_repository_soft_deletes_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_delete",
        user_id="local-user",
        scene_id="desktop-agent",
        title="待删除",
    )

    deleted = repositories.sessions.soft_delete(session.id)

    assert deleted is not None
    assert deleted.id == session.id
    assert deleted.is_deleted is True
    assert deleted.updated_at >= session.updated_at
    assert repositories.sessions.get(session.id) is None
    assert repositories.sessions.soft_delete(session.id) is None


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
