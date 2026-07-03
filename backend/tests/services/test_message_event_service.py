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

    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == "读文件"
    assert messages[0]["attachments"] == []
    assert isinstance(messages[0]["timestamp"], int)
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == "我来读取"
    assert messages[1]["messageEventId"] == "evt_3"
    assert messages[1]["turnIndex"] == 1
    assert isinstance(messages[1]["timestamp"], int)
    assert messages[1]["ghostStats"] == {
        "traceId": "trace_1",
        "inputTokens": 3,
        "cacheReadTokens": 0,
        "outputTokens": 4,
    }
    assert messages[2]["role"] == "tool"
    assert messages[2]["status"] == "completed"
    assert messages[2]["toolResult"] == "content"
    assert isinstance(messages[2]["timestamp"], int)


def test_message_event_service_splits_thread_task_continuation_turns(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(repositories, "evt_1", "stream_batch", {"content": "第一轮"}, turn=1)
    _append(
        repositories,
        "evt_2",
        "stream_batch",
        {
            "content": "第二轮",
            "thread_task": {
                "task_id": "task-1",
                "run_id": "run-1",
                "trigger": "task_continue",
                "type": "goal",
            },
        },
        turn=2,
    )

    messages = service.get_display_messages("ses_history")

    assert [message["content"] for message in messages] == ["第一轮", "第二轮"]
    assert [message["turnIndex"] for message in messages] == [1, 2]
    assert messages[1]["metadata"]["thread_task"] == {
        "task_id": "task-1",
        "run_id": "run-1",
        "trigger": "task_continue",
        "type": "goal",
    }
    assert messages[1]["metadata"]["runtime_params"]["thread_task"] == {
        "task_id": "task-1",
        "run_id": "run-1",
        "trigger": "task_continue",
        "type": "goal",
    }


def test_message_event_service_restores_llm_retry_notice(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_retrying",
        "middleware_progress",
        {
            "middleware": "LLMRetry",
            "kind": "llm_retry",
            "stage": "retrying",
            "notice_id": "llm-retry:trace-1:run-1",
            "retry_index": 1,
            "max_retries": 3,
            "attempt": 2,
        },
    )
    _append(
        repositories,
        "evt_recovered",
        "middleware_progress",
        {
            "middleware": "LLMRetry",
            "kind": "llm_retry",
            "stage": "recovered",
            "notice_id": "llm-retry:trace-1:run-1",
            "retry_index": 1,
            "max_retries": 3,
            "attempt": 2,
        },
    )

    messages = service.get_display_messages("ses_history")

    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == "LLM 请求重试成功"
    assert messages[0]["messageEventId"] == "evt_recovered"
    assert messages[0]["metadata"]["retry"] == {
        "kind": "llm_retry",
        "stage": "recovered",
        "notice_id": "llm-retry:trace-1:run-1",
        "attempt": 2,
        "retry_index": 1,
        "max_retries": 3,
        "max_attempts": None,
        "retry_after_ms": None,
        "gateway_trace_id": None,
        "error": None,
        "error_type": None,
    }
    assert messages[0]["status"] == "completed"


def test_message_event_service_can_defer_tool_payloads_for_history(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_start",
        "tool_start",
        {
            "tool": "write_file",
            "params": {
                "path": "docs/large.md",
                "content": "x" * 5000,
            },
            "run_id": "tool_large",
            "tool_call_id": "call_large",
        },
    )
    _append(
        repositories,
        "evt_end",
        "tool_end",
        {
            "run_id": "tool_large",
            "tool_call_id": "call_large",
            "result": "large result",
            "duration_ms": 18,
            "files": [
                {
                    "path": "docs/large.md",
                    "operation": "add",
                    "additions": 1,
                    "deletions": 0,
                    "diff": "+x" * 5000,
                }
            ],
            "ui_payload": {"stdout": "x" * 5000},
        },
    )

    messages = service.get_display_messages("ses_history", include_tool_details=False)

    assert messages[0]["role"] == "tool"
    assert messages[0]["toolDetailsDeferred"] is True
    assert messages[0]["messageEventId"] == "evt_start"
    assert messages[0]["toolDetailRef"] == {
        "startEventId": "evt_start",
        "endEventId": "evt_end",
        "runId": "tool_large",
        "toolCallId": "call_large",
    }
    assert messages[0]["toolParams"] == {"path": "docs/large.md"}
    assert "toolResult" not in messages[0]
    assert "uiPayload" not in messages[0]
    assert messages[0]["fileChanges"] == [
        {
            "path": "docs/large.md",
            "operation": "add",
            "added_lines": 1,
            "deleted_lines": 0,
            "removed_lines": 0,
            "additions": 1,
            "deletions": 0,
        }
    ]


def test_message_event_service_keeps_deferred_command_error_preview(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_cmd_start",
        "tool_start",
        {
            "tool": "run_cmd",
            "params": {"command": "pytest backend/tests", "cwd": "D:/repo"},
            "run_id": "tool_cmd",
            "tool_call_id": "call_cmd",
        },
    )
    _append(
        repositories,
        "evt_cmd_end",
        "tool_end",
        {
            "run_id": "tool_cmd",
            "tool_call_id": "call_cmd",
            "result": "x" * 5000,
            "duration_ms": 18,
            "ui_payload": {
                "command": "pytest backend/tests",
                "cwd": "D:/repo",
                "status": "completed",
                "stdout": "x" * 5000,
                "stderr": "ModuleNotFoundError: No module named app\n" + "y" * 5000,
                "exit_code": 1,
                "duration_ms": 18,
                "output_truncated": True,
            },
        },
    )

    messages = service.get_display_messages("ses_history", include_tool_details=False)

    assert messages[0]["role"] == "tool"
    assert messages[0]["toolName"] == "run_cmd"
    assert messages[0]["toolDetailsDeferred"] is True
    assert messages[0]["toolParams"] == {
        "command": "pytest backend/tests",
        "cwd": "D:/repo",
    }
    assert "toolResult" not in messages[0]
    assert messages[0]["uiPayload"]["exit_code"] == 1
    assert messages[0]["uiPayload"]["output_truncated"] is True
    assert messages[0]["uiPayload"]["stderr"].startswith("ModuleNotFoundError")
    assert len(messages[0]["uiPayload"]["stderr"]) <= 1000
    assert "stdout" not in messages[0]["uiPayload"]


def test_message_event_service_keeps_deferred_tool_error_summary(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_start",
        "tool_start",
        {
            "tool": "read_file",
            "params": {"path": "missing.txt"},
            "run_id": "tool_error",
            "tool_call_id": "call_error",
        },
    )
    _append(
        repositories,
        "evt_end",
        "tool_end",
        {
            "run_id": "tool_error",
            "tool_call_id": "call_error",
            "result": (
                '{"code":"file_not_found","message":"文件不存在",'
                '"details":{"path":"missing.txt","content":"' + "x" * 5000 + '"}}'
            ),
            "duration_ms": 12,
        },
    )

    messages = service.get_display_messages("ses_history", include_tool_details=False)

    assert messages[0]["role"] == "tool"
    assert messages[0]["status"] == "error"
    assert messages[0]["toolError"] == "文件不存在"
    assert "toolResult" not in messages[0]


def test_message_event_service_loads_full_deferred_tool_detail(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_start",
        "tool_start",
        {
            "tool": "read_file",
            "params": {"path": "README.md"},
            "run_id": "tool_1",
            "tool_call_id": "call_1",
        },
    )
    _append(
        repositories,
        "evt_end",
        "tool_end",
        {
            "run_id": "tool_1",
            "tool_call_id": "call_1",
            "result": "full content",
            "duration_ms": 21,
            "ui_payload": {"text": "full content"},
        },
    )

    detail = service.get_tool_detail(
        session_id="ses_history",
        start_event_id="evt_start",
        end_event_id="evt_end",
    )

    assert detail is not None
    assert detail["toolName"] == "read_file"
    assert detail["toolParams"] == {"path": "README.md"}
    assert detail["toolResult"] == "full content"
    assert detail["toolDurationMs"] == 21
    assert detail["uiPayload"] == {"text": "full content"}
    assert detail["detailRef"]["startEventId"] == "evt_start"
    assert detail["detailRef"]["endEventId"] == "evt_end"


def test_message_event_service_handles_multi_turn_reasoning_error_and_cancel(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(repositories, "evt_1", "stream_batch", {"content": "半截"}, turn=1)
    _append(repositories, "evt_2", "cancelled", {"trace_id": "trace_1"}, turn=1)
    _append(repositories, "evt_3", "reasoning", {"kind": "reasoning", "text": "观察"}, turn=2)
    _append(repositories, "evt_4", "error", {"message": "失败", "trace_id": "trace_2"}, turn=2)

    messages = service.get_display_messages("ses_history")

    assert messages[0]["role"] == "assistant"
    assert messages[0]["content"] == "半截"
    assert isinstance(messages[0]["timestamp"], int)
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == ""
    assert messages[1]["status"] == "cancelled"
    assert messages[1]["cancelled"] is True
    assert messages[1]["traceId"] == "trace_1"
    assert isinstance(messages[1]["timestamp"], int)
    assert messages[2]["role"] == "reasoning"
    assert messages[2]["content"] == "观察"
    assert messages[2]["reasoningKind"] == "reasoning"
    assert isinstance(messages[2]["timestamp"], int)
    assert messages[3]["role"] == "error"
    assert messages[3]["content"] == "失败"
    assert messages[3]["traceId"] == "trace_2"
    assert isinstance(messages[3]["timestamp"], int)


def test_message_event_service_appends_cancelled_marker_after_tool_only_turn(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_1",
        "tool_start",
        {"tool": "read_file", "params": {"path": "README.md"}, "run_id": "tool_1"},
        turn=1,
    )
    _append(repositories, "evt_2", "cancelled", {"trace_id": "trace_tool"}, turn=1)

    messages = service.get_display_messages("ses_history")

    assert messages[0]["role"] == "tool"
    assert messages[0]["status"] == "cancelled"
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == ""
    assert messages[1]["status"] == "cancelled"
    assert messages[1]["cancelled"] is True
    assert messages[1]["traceId"] == "trace_tool"


def test_message_event_service_restores_message_injection_as_user_context_items(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_injected_file",
        "user_message",
        {
            "content": "用户通过 @ 引用了工作区文件：README.md",
            "source": "message_injection",
            "injectionSource": "follow",
            "injectionRole": "HumanMessage",
            "metadata": {
                "id": "file:readme",
                "kind": "file",
                "label": "README.md",
                "path": "README.md",
                "name": "README.md",
                "fileType": "file",
            },
        },
    )
    _append(repositories, "evt_user", "user_message", {"content": "总结"})
    _append(repositories, "evt_ai", "stream_batch", {"content": "好的"})

    messages = service.get_display_messages("ses_history")

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["content"] == "总结"
    assert messages[0]["contextItems"][0]["type"] == "file"
    assert messages[0]["contextItems"][0]["path"] == "README.md"
    assert messages[1]["content"] == "好的"


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


def test_message_event_service_marks_serialized_tool_error_failed(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_1",
        "tool_start",
        {"tool": "read_file", "params": {"path": "missing.txt"}, "run_id": "tool_1"},
    )
    _append(
        repositories,
        "evt_2",
        "tool_end",
        {
            "run_id": "tool_1",
            "result": (
                '{"code":"file_not_found","message":"文件不存在","details":{"path":"missing.txt"}}'
            ),
        },
    )

    messages = service.get_display_messages("ses_history")

    assert messages[0]["role"] == "tool"
    assert messages[0]["status"] == "error"
    assert messages[0]["toolError"] == "文件不存在"


def test_message_event_service_restores_update_plan_ui_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_plan_start",
        "tool_start",
        {
            "tool": "update_plan",
            "params": {
                "plan": [
                    {"step": "分析入口", "status": "completed"},
                    {"step": "实现胶囊面板", "status": "in_progress"},
                ]
            },
            "run_id": "tool_plan",
        },
    )
    _append(
        repositories,
        "evt_plan_end",
        "tool_end",
        {
            "run_id": "tool_plan",
            "result": "",
            "ui_payload": {
                "explanation": "同步当前计划",
                "entries": [
                    {"content": "分析入口", "status": "completed"},
                    {"content": "实现胶囊面板", "status": "in_progress"},
                ],
            },
        },
    )

    messages = service.get_display_messages("ses_history")

    assert messages[0]["role"] == "tool"
    assert messages[0]["toolName"] == "update_plan"
    assert messages[0]["status"] == "completed"
    assert messages[0]["uiPayload"]["explanation"] == "同步当前计划"
    assert messages[0]["uiPayload"]["entries"][1] == {
        "content": "实现胶囊面板",
        "status": "in_progress",
    }


def test_message_event_service_restores_thread_task_tool_summary_when_details_deferred(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_goal_start",
        "tool_start",
        {
            "tool": "update_thread_task",
            "params": {
                "status": "complete",
                "summary": "三轮测试结果汇总",
                "checklist": [{"content": "完成第三轮验证"}],
                "evidence": [{"detail": "目标自动续跑正常"}],
            },
            "run_id": "tool_goal",
        },
    )
    _append(
        repositories,
        "evt_goal_end",
        "tool_end",
        {
            "run_id": "tool_goal",
            "result": "",
            "ui_payload": {
                "task_id": "task-1",
                "status": "complete",
                "task": {
                    "id": "task-1",
                    "type": "goal",
                    "type_label": "目标",
                    "objective": "验证 goal 功能",
                    "status": "complete",
                    "metadata": {"large": "not needed"},
                },
            },
        },
    )

    messages = service.get_display_messages("ses_history", include_tool_details=False)

    assert messages[0]["role"] == "tool"
    assert messages[0]["toolName"] == "update_thread_task"
    assert messages[0]["toolDetailsDeferred"] is True
    assert messages[0]["toolParams"] == {
        "status": "complete",
        "summary": "三轮测试结果汇总",
        "checklist": [{"content": "完成第三轮验证"}],
        "evidence": [{"detail": "目标自动续跑正常"}],
    }
    assert messages[0]["uiPayload"]["task"] == {
        "id": "task-1",
        "type": "goal",
        "type_label": "目标",
        "objective": "验证 goal 功能",
        "status": "complete",
    }


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
