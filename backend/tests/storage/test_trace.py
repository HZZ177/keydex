from __future__ import annotations

import sqlite3

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_trace",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def test_trace_record_create_update_and_list_by_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    created = repositories.trace_records.create(
        trace_id="trace_1",
        session_id="ses_trace",
        active_session_id="ses_trace",
        scene_id="desktop-agent",
        scene_name="Keydex",
        user_id="local-user",
        turn_index=1,
        root_node_id="node_root",
        user_message_preview="请读取文件",
        metadata={"mode": "chat"},
    )

    assert created.status == "running"
    assert created.metadata == {"mode": "chat"}
    assert repositories.trace_records.get("trace_1") == created

    finished = repositories.trace_records.finish(
        "trace_1",
        status="completed",
        duration_ms=123,
        total_input_tokens=10,
        total_output_tokens=7,
        total_cache_read_tokens=3,
        output_checkpoint_id="checkpoint_1",
        metadata={"done": True},
    )

    assert finished is not None
    assert finished.status == "completed"
    assert finished.duration_ms == 123
    assert finished.total_input_tokens == 10
    assert finished.total_output_tokens == 7
    assert finished.total_tokens == 17
    assert finished.total_cache_read_tokens == 3
    assert finished.output_checkpoint_id == "checkpoint_1"
    assert finished.metadata == {"done": True}
    assert repositories.trace_records.list_by_session("ses_trace") == [finished]


def test_trace_finish_preserves_metadata_when_not_supplied(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_meta",
        session_id="ses_trace",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="node_root",
        metadata={"thread_task": {"task_id": "task-1", "run_id": "run-1"}},
    )

    finished = repositories.trace_records.finish("trace_meta", status="completed")

    assert finished is not None
    assert finished.metadata == {"thread_task": {"task_id": "task-1", "run_id": "run-1"}}


def test_trace_event_log_append_and_query_by_trace_record(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_2",
        session_id="ses_trace",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=2,
        root_node_id="node_root",
    )

    first = repositories.trace_event_logs.append(
        trace_id="trace_2",
        trace_record_id="trace_2",
        event_type="turn.started",
        source="chat_service",
        idempotency_key="trace_2:1",
        timestamp_ms=1,
        sequence_no=1,
        payload={"turn_index": 2},
        tags={"phase": "start"},
    )
    second = repositories.trace_event_logs.append(
        trace_id="trace_2",
        trace_record_id="trace_2",
        event_type="turn.completed",
        source="event_handler",
        idempotency_key="trace_2:2",
        timestamp_ms=2,
        sequence_no=2,
        payload={"status": "completed"},
    )

    assert first.id < second.id
    assert first.payload == {"turn_index": 2}
    assert first.tags == {"phase": "start"}
    event_types = [
        event.event_type for event in repositories.trace_event_logs.list_by_trace_record("trace_2")
    ]
    assert event_types == [
        "turn.started",
        "turn.completed",
    ]


def test_trace_event_log_rejects_duplicate_idempotency_key(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_idempotent",
        session_id="ses_trace",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=4,
        root_node_id="node_root",
    )

    repositories.trace_event_logs.append(
        trace_id="trace_idempotent",
        trace_record_id="trace_idempotent",
        event_type="turn.started",
        source="chat_service",
        idempotency_key="trace_idempotent:1",
        timestamp_ms=1,
        sequence_no=1,
        payload={"turn_index": 4},
    )

    with pytest.raises(sqlite3.IntegrityError):
        repositories.trace_event_logs.append(
            trace_id="trace_idempotent",
            trace_record_id="trace_idempotent",
            event_type="turn.started",
            source="chat_service",
            idempotency_key="trace_idempotent:1",
            timestamp_ms=2,
            sequence_no=2,
            payload={"turn_index": 4},
        )

    events = repositories.trace_event_logs.list_by_trace_record("trace_idempotent")
    assert [event.idempotency_key for event in events] == ["trace_idempotent:1"]


def test_trace_record_failed_status_and_validation(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_failed",
        session_id="ses_trace",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="node_root",
    )

    failed = repositories.trace_records.finish("trace_failed", status="failed")
    assert failed is not None
    assert failed.status == "failed"
    assert failed.end_time is not None

    with pytest.raises(ValueError, match="不支持的 trace 状态"):
        repositories.trace_records.finish("trace_failed", status="paused")


def test_trace_record_allows_waiting_input_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_waiting_input",
        session_id="ses_trace",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="node_root",
    )

    waiting = repositories.trace_records.finish("trace_waiting_input", status="waiting_input")

    assert waiting is not None
    assert waiting.status == "waiting_input"
    assert waiting.end_time is not None
