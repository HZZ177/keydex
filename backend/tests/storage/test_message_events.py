from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_events",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def test_message_events_append_and_query_by_session_and_turn(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    user_event = repositories.message_events.append(
        event_id="evt_user",
        session_id="ses_events",
        turn_index=1,
        action="user_message",
        data={"content": "你好"},
    )
    stream_event = repositories.message_events.append(
        event_id="evt_stream",
        session_id="ses_events",
        turn_index=1,
        action="stream_batch",
        data={"content": "世界"},
        trace_record_id="trace_1",
    )
    next_turn_event = repositories.message_events.append(
        event_id="evt_next",
        session_id="ses_events",
        turn_index=2,
        action="completed",
        data={"ok": True},
    )

    assert user_event.seq == 1
    assert stream_event.seq == 2
    assert stream_event.trace_record_id == "trace_1"
    assert next_turn_event.seq == 3

    assert [event.id for event in repositories.message_events.list_by_session("ses_events")] == [
        "evt_user",
        "evt_stream",
        "evt_next",
    ]
    assert [event.id for event in repositories.message_events.list_by_turn("ses_events", 1)] == [
        "evt_user",
        "evt_stream",
    ]
    assert repositories.message_events.get_max_seq_and_turn("ses_events") == (3, 2)


def test_message_events_append_many_uses_contiguous_sequences_and_turn_filter(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.message_events.append(
        event_id="evt_existing",
        session_id="ses_events",
        turn_index=1,
        action="user_message",
        data={"content": "已有事件"},
    )

    appended = repositories.message_events.append_many(
        session_id="ses_events",
        events=[
            {
                "event_id": "evt_batch_1",
                "trace_record_id": "trace_1",
                "turn_index": 1,
                "action": "ai_message",
                "data": {"content": "第一轮回复"},
            },
            {
                "event_id": "evt_batch_2",
                "trace_record_id": "trace_2",
                "turn_index": 2,
                "action": "user_message",
                "data": {"content": "第二轮问题"},
            },
        ],
    )

    assert [event.seq for event in appended] == [2, 3]
    assert [event.trace_record_id for event in appended] == ["trace_1", "trace_2"]
    first_turn = repositories.message_events.list_by_session(
        "ses_events",
        limit=None,
        through_turn_index=1,
    )
    assert [event.id for event in first_turn] == ["evt_existing", "evt_batch_1"]
    assert repositories.message_events.get_max_seq_and_turn("ses_events") == (3, 2)


def test_message_events_delete_from_turn_allows_rewriting_rolled_back_turn(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    repositories.message_events.append(
        event_id="evt_user_1",
        session_id="ses_events",
        turn_index=1,
        action="user_message",
        data={"content": "第一轮"},
    )
    repositories.message_events.append(
        event_id="evt_ai_1",
        session_id="ses_events",
        turn_index=1,
        action="ai_message",
        data={"content": "第一轮回复"},
    )
    repositories.message_events.append(
        event_id="evt_user_2_old",
        session_id="ses_events",
        turn_index=2,
        action="user_message",
        data={"content": "旧第二轮"},
    )

    assert repositories.message_events.delete_from_turn("ses_events", 2) == 1

    rewritten = repositories.message_events.append(
        event_id="evt_user_2_new",
        session_id="ses_events",
        turn_index=2,
        action="user_message",
        data={"content": "新第二轮"},
    )

    assert rewritten.seq == 3
    assert repositories.message_events.get("evt_user_2_old", include_deleted=True) is None
    assert [event.id for event in repositories.message_events.list_by_session("ses_events")] == [
        "evt_user_1",
        "evt_ai_1",
        "evt_user_2_new",
    ]


def test_message_events_empty_session_returns_empty(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    assert repositories.message_events.list_by_session("ses_missing") == []
    assert repositories.message_events.list_by_turn("ses_missing", 1) == []
    assert repositories.message_events.get_max_seq_and_turn("ses_missing") == (0, 0)


def test_message_events_limit_and_foreign_key_constraints(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    for index in range(3):
        repositories.message_events.append(
            event_id=f"evt_limited_{index}",
            session_id="ses_events",
            turn_index=1,
            action="stream_batch",
            data={"index": index},
        )

    limited_events = repositories.message_events.list_by_session("ses_events", limit=2)
    assert [event.id for event in limited_events] == [
        "evt_limited_0",
        "evt_limited_1",
    ]

    with pytest.raises(sqlite3.IntegrityError):
        repositories.message_events.append(
            event_id="evt_missing_session",
            session_id="ses_missing",
            turn_index=1,
            action="stream_batch",
            data={"content": "不会落库"},
        )


def test_message_events_concurrent_append_keeps_monotonic_session_sequence(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    def append_event(index: int) -> None:
        repositories.message_events.append(
            event_id=f"evt_{index}",
            session_id="ses_events",
            turn_index=1,
            action="stream_batch",
            data={"index": index},
        )

    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(append_event, range(20)))

    events = repositories.message_events.list_by_session("ses_events")

    assert [event.seq for event in events] == list(range(1, 21))
    assert sorted(event.data["index"] for event in events) == list(range(20))
