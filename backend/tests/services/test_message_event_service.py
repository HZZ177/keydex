from __future__ import annotations

from backend.app.services import MessageEventService
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_history",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _append(
    repositories: StorageRepositories,
    event_id: str,
    action: str,
    data: dict,
    turn: int = 1,
) -> None:
    repositories.message_events.append(
        event_id=event_id,
        session_id="ses_history",
        turn_index=turn,
        action=action,
        data=data,
    )


def test_message_event_service_aggregates_user_stream_tool_and_completed(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(repositories, "evt_1", "user_message", {"content": "读文件"})
    _append(repositories, "evt_2", "stream_batch", {"content": "我来"})
    _append(repositories, "evt_3", "stream_batch", {"content": "读取"})
    _append(
        repositories,
        "evt_4",
        "tool_start",
        {"tool": "read_file", "params": {"path": "a.py"}, "run_id": "tool_1"},
    )
    _append(
        repositories,
        "evt_5",
        "tool_end",
        {"run_id": "tool_1", "result": "content", "duration_ms": 12},
    )
    _append(
        repositories,
        "evt_6",
        "completed",
        {
            "ghost_footer": {
                "trace_id": "trace_1",
                "latest_llm_token_usage": {"input_tokens": 3, "output_tokens": 4},
                "trace_query_context": {"trace_id": "trace_1"},
            }
        },
    )

    messages = service.get_display_messages("ses_history")

    assert messages[0] == {"role": "user", "content": "读文件", "attachments": []}
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == "我来读取"
    assert messages[1]["ghostStats"] == {
        "traceId": "trace_1",
        "inputTokens": 3,
        "cacheReadTokens": 0,
        "outputTokens": 4,
    }
    assert messages[2]["role"] == "tool"
    assert messages[2]["status"] == "completed"
    assert messages[2]["toolResult"] == "content"


def test_message_event_service_handles_multi_turn_reasoning_error_and_cancel(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(repositories, "evt_1", "stream_batch", {"content": "半截"}, turn=1)
    _append(repositories, "evt_2", "cancelled", {"trace_id": "trace_1"}, turn=1)
    _append(repositories, "evt_3", "reasoning", {"kind": "reasoning", "text": "观察"}, turn=2)
    _append(repositories, "evt_4", "error", {"message": "失败", "trace_id": "trace_2"}, turn=2)

    messages = service.get_display_messages("ses_history")

    assert messages[0] == {"role": "assistant", "content": "半截", "cancelled": True}
    assert messages[1] == {"role": "reasoning", "content": "观察", "reasoningKind": "reasoning"}
    assert messages[2] == {"role": "error", "content": "失败", "traceId": "trace_2"}


def test_message_event_service_pairs_subagent_tools(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_1",
        "subagent_start",
        {"subagent_id": "sub_1", "subagent_name": "worker", "task": "检查"},
    )
    _append(
        repositories,
        "evt_2",
        "tool_start",
        {
            "tool": "search",
            "params": {"q": "x"},
            "run_id": "tool_1",
            "is_subagent": True,
            "subagent_id": "sub_1",
        },
    )
    _append(
        repositories,
        "evt_3",
        "tool_end",
        {"run_id": "tool_1", "result": "ok"},
    )

    messages = service.get_display_messages("ses_history")

    assert messages[0]["role"] == "subagent"
    assert messages[0]["subagentToolCalls"][0]["status"] == "completed"
    assert messages[0]["subagentToolCalls"][0]["toolResult"] == "ok"


def test_completed_events_to_messages_fast_path_applies_ghost_footer() -> None:
    messages = MessageEventService.events_to_messages(
        [
            {"action": "ai_message", "data": {"content": "完成"}},
            {"action": "tool_start", "data": {"tool": "read_file", "run_id": "tool_1"}},
            {"action": "tool_end", "data": {"run_id": "tool_1", "result": "ok"}},
        ],
        user_message={"role": "user", "content": "做事"},
        terminal_data={
            "ghost_footer": {
                "trace_id": "trace_1",
                "latest_llm_token_usage": {"input_tokens": 1, "output_tokens": 2},
            }
        },
    )

    assert messages[0] == {"role": "user", "content": "做事"}
    assert messages[1]["ghostStats"]["traceId"] == "trace_1"
    assert messages[2]["status"] == "completed"
