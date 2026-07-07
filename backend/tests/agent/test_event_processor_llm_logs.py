from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langgraph.types import Command

from backend.app.agent.event_processor import process_agent_events
from backend.app.agent.internal_llm_events import INTERNAL_CONTEXT_COMPRESSION_TAG
from backend.app.events import DomainEvent, DomainEventType, EventDispatcher
from backend.app.storage import StorageRepositories, init_database


class NeverCancelled:
    def is_cancelled(self) -> bool:
        return False


class ManualCancellation:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True

    def is_cancelled(self) -> bool:
        return self.cancelled


async def _event_stream(events: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    for event in events:
        yield event


async def _cancel_after_first_stream(token: ManualCancellation) -> AsyncIterator[dict[str, Any]]:
    yield {
        "event": "on_chat_model_stream",
        "run_id": "run_cancel",
        "data": {"chunk": AIMessageChunk(content="半截")},
    }
    token.cancel()
    raise asyncio.CancelledError


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_agent",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_agent",
        session_id="ses_agent",
        active_session_id="ses_agent",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace_agent-root",
    )
    return repositories


@pytest.mark.asyncio
async def test_process_agent_events_collects_usage_without_writing_llm_log(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    result = await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_start",
                    "run_id": "run_1",
                    "name": "ChatOpenAI",
                    "metadata": {
                        "ls_provider": "openai",
                        "ls_model_name": "deepseek-v4-flash",
                        "authorization": "secret",
                    },
                    "data": {"input": {"messages": [["user", "你好"]]}},
                },
                {
                    "event": "on_chat_model_end",
                    "run_id": "run_1",
                    "data": {
                        "output": AIMessage(
                            content="你好，已收到",
                            usage_metadata={
                                "input_tokens": 12,
                                "output_tokens": 8,
                                "total_tokens": 20,
                                "input_token_details": {"cache_read": 5},
                            },
                        )
                    },
                },
            ],
        ),
        dispatcher=EventDispatcher(),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    assert result.chain_token_usage["llm_call_count"] == 1
    assert result.chain_token_usage["input_tokens"] == 12
    assert result.chain_token_usage["output_tokens"] == 8
    assert result.chain_token_usage["cache_read_tokens"] == 5
    assert repositories.llm_request_logs.list()[1] == 0


@pytest.mark.asyncio
async def test_process_agent_events_emits_reasoning_from_model_chunks() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    result = await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            additional_kwargs={"reasoning_content": "先分析"},
                        )
                    },
                },
                {
                    "event": "on_chat_model_end",
                    "run_id": "model_run",
                    "data": {"output": AIMessage(content="最终答案")},
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    reasoning_events = [
        event
        for event in emitted
        if event.event_type
        in {
            DomainEventType.REASONING_STREAM.value,
            DomainEventType.REASONING_FINISHED.value,
        }
    ]
    assert [event.event_type for event in reasoning_events] == [
        DomainEventType.REASONING_STREAM.value,
        DomainEventType.REASONING_FINISHED.value,
    ]
    assert reasoning_events[0].payload["text"] == "先分析"
    assert reasoning_events[0].payload["done"] is False
    assert reasoning_events[1].payload["text"] == "先分析"
    assert reasoning_events[1].payload["done"] is True
    assert result.final_content == "最终答案"


@pytest.mark.asyncio
async def test_process_agent_events_ignores_internal_context_compression_llm_events() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    result = await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "compression_run",
                    "tags": [INTERNAL_CONTEXT_COMPRESSION_TAG],
                    "data": {"chunk": AIMessageChunk(content="<分析>内部</分析>")},
                },
                {
                    "event": "on_chat_model_end",
                    "run_id": "compression_run",
                    "tags": [INTERNAL_CONTEXT_COMPRESSION_TAG],
                    "data": {"output": AIMessage(content="<摘要>内部摘要</摘要>")},
                },
                {
                    "event": "on_chat_model_end",
                    "run_id": "main_run",
                    "data": {"output": AIMessage(content="真正回答")},
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    stream_events = [
        event for event in emitted if event.event_type == DomainEventType.LLM_STREAM.value
    ]
    assert result.final_content == "真正回答"
    assert [event.payload["content"] for event in stream_events] == ["真正回答"]


@pytest.mark.asyncio
async def test_process_agent_events_emits_reasoning_details_from_model_chunks() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            additional_kwargs={"reasoning_details": [{"text": "结构化思考"}]},
                        )
                    },
                },
                {
                    "event": "on_chat_model_end",
                    "run_id": "model_run",
                    "data": {"output": AIMessage(content="最终答案")},
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    reasoning_streams = [
        event
        for event in emitted
        if event.event_type == DomainEventType.REASONING_STREAM.value
    ]
    assert reasoning_streams[0].payload["text"] == "结构化思考"


@pytest.mark.asyncio
async def test_process_agent_events_keeps_partial_output_on_user_task_cancel(tmp_path) -> None:
    _repositories(tmp_path)
    token = ManualCancellation()
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    result = await process_agent_events(
        _cancel_after_first_stream(token),
        dispatcher=EventDispatcher([capture]),
        cancellation=token,
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    assert result.final_content == "半截"
    stream_events = [
        event for event in emitted if event.event_type == DomainEventType.LLM_STREAM.value
    ]
    assert len(stream_events) == 1
    assert stream_events[0].payload["content"] == "半截"


@pytest.mark.asyncio
async def test_process_agent_events_does_not_write_llm_log_on_model_error(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_start",
                    "run_id": "run_error",
                    "name": "ChatOpenAI",
                    "metadata": {},
                    "data": {"input": {"messages": [["user", "你好"]]}},
                },
                {
                    "event": "on_chat_model_error",
                    "run_id": "run_error",
                    "data": {"error": "HTTP 400"},
                },
            ],
        ),
        dispatcher=EventDispatcher(),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    assert repositories.llm_request_logs.list()[1] == 0


@pytest.mark.asyncio
async def test_process_agent_events_marks_serialized_local_tool_error_failed() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    result = await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "tool_error",
                    "name": "read_file",
                    "data": {"input": {"path": "missing.txt"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_error",
                    "name": "read_file",
                    "data": {
                        "output": (
                            '{"code":"file_not_found","message":"文件不存在",'
                            '"details":{"path":"missing.txt"}}'
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    tool_events = [event for event in emitted if event.run_id == "tool_error"]
    assert [event.event_type for event in tool_events] == [
        DomainEventType.LLM_TOOL_STARTED.value,
        DomainEventType.LLM_TOOL_FAILED.value,
    ]
    assert tool_events[1].payload["status"] == "failed"
    assert "file_not_found" in tool_events[1].payload["error"]
    assert result.final_content == ""


@pytest.mark.asyncio
async def test_process_agent_events_emits_tool_progress_from_model_chunks() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_patch",
                                    "index": 0,
                                    "name": "apply_patch",
                                    "args": (
                                        '{"patch":"*** Begin Patch\\n'
                                        "*** Update File: src/app.py\\n"
                                        '@@\\n-old\\n+one"}'
                                    ),
                                }
                            ],
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    progress_events = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_PROGRESS.value
    ]
    assert len(progress_events) == 1
    assert progress_events[0].payload["tool"] == "apply_patch"
    assert progress_events[0].payload["tool_call_id"] == "call_patch"
    assert progress_events[0].payload["files"][0]["path"] == "src/app.py"
    assert progress_events[0].payload["files"][0]["operation"] == "update"
    assert progress_events[0].payload["files"][0]["added_lines"] == 1


@pytest.mark.asyncio
async def test_process_agent_events_emits_tool_progress_for_streamed_apply_patch_move() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_patch",
                                    "index": 0,
                                    "name": "apply_patch",
                                    "args": (
                                        '{"patch":"*** Begin Patch\\n'
                                        "*** Update File: docs/old.md\\n"
                                        "*** Move to: docs/new.md\\n"
                                        '@@\\n-old\\n+new\\n*** End Patch"}'
                                    ),
                                }
                            ],
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    progress_events = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_PROGRESS.value
    ]
    assert len(progress_events) == 1
    file_change = progress_events[0].payload["files"][0]
    assert file_change["operation"] == "update"
    assert file_change["change_type"] == "move"
    assert file_change["old_path"] == "docs/old.md"
    assert file_change["new_path"] == "docs/new.md"
    assert file_change["added_lines"] == 1
    assert file_change["deleted_lines"] == 1


@pytest.mark.asyncio
async def test_process_agent_events_classifies_streamed_write_file_by_tool_name() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_write",
                                    "index": 0,
                                    "name": "write_file",
                                    "args": '{"path":"docs/note.md","content":"new\\n"}',
                                }
                            ],
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    progress_events = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_PROGRESS.value
    ]
    assert len(progress_events) == 1
    file_change = progress_events[0].payload["files"][0]
    assert file_change["operation"] == "add"
    assert "+new" in file_change["diff"]


@pytest.mark.asyncio
async def test_process_agent_events_binds_streamed_tool_call_to_real_tool_run() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_write",
                                    "index": 0,
                                    "name": "write_file",
                                    "args": '{"path":"docs/note.md","content":"new\\n"}',
                                }
                            ],
                        )
                    },
                },
                {
                    "event": "on_tool_start",
                    "run_id": "tool_write",
                    "name": "write_file",
                    "data": {"input": {"path": "docs/note.md", "content": "new\n"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_write",
                    "name": "write_file",
                    "data": {
                        "output": (
                            '{"files":[{"path":"docs/note.md","operation":"add",'
                            '"added_lines":1,"deleted_lines":0}]}'
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    progress = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_PROGRESS.value
    ][0]
    started = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_STARTED.value
    ][0]
    finished = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_FINISHED.value
    ][0]

    assert progress.run_id == "call_write"
    assert progress.payload["tool_call_id"] == "call_write"
    assert started.run_id == "tool_write"
    assert started.payload["tool_call_id"] == "call_write"
    assert finished.run_id == "tool_write"
    assert finished.payload["tool_call_id"] == "call_write"
    assert finished.payload["files"][0]["operation"] == "add"


@pytest.mark.asyncio
async def test_process_agent_events_includes_structured_tool_files_on_tool_end() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "tool_1",
                    "name": "apply_patch",
                    "data": {"input": {"patch": "*** Begin Patch"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_1",
                    "name": "apply_patch",
                    "data": {
                        "output": ToolMessage(
                            content=(
                                '{"files":[{"path":"src/app.py","added_lines":2,'
                                '"deleted_lines":1}]}'
                            ),
                            tool_call_id="call_patch",
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    finished = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_FINISHED.value
    ][0]
    assert finished.payload["files"][0] == {
        "path": "src/app.py",
        "added_lines": 2,
        "deleted_lines": 1,
        "removed_lines": 1,
        "additions": 2,
        "deletions": 1,
    }
    assert finished.payload["ui_payload"]["files"][0]["path"] == "src/app.py"
    assert finished.payload["output_data"]["result"]["files"][0]["added_lines"] == 2


@pytest.mark.asyncio
async def test_process_agent_events_preserves_mcp_tool_metadata() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    mcp_metadata = {
        "kind": "mcp_tool",
        "snapshot_id": "snap-1",
        "server_id": "srv-1",
        "server_name": "Ticket MCP",
        "raw_tool_name": "search",
        "model_tool_name": "mcp__srv_1__search",
    }
    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "tool_mcp",
                    "name": "mcp__srv_1__search",
                    "metadata": {"mcp": mcp_metadata},
                    "data": {"input": {"query": "MCP"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_mcp",
                    "name": "mcp__srv_1__search",
                    "data": {
                        "output": ToolMessage(
                            content=json.dumps(
                                {
                                    "call_id": "call-mcp",
                                    "status": "success",
                                    "content": [{"type": "text", "text": "ok"}],
                                    "metadata": {"mcp": mcp_metadata},
                                },
                                ensure_ascii=False,
                            ),
                            tool_call_id="call-mcp",
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    started = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_STARTED.value
    ][0]
    finished = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_FINISHED.value
    ][0]
    assert started.payload["kind"] == "mcp_tool"
    assert started.payload["server_id"] == "srv-1"
    assert started.payload["server_name"] == "Ticket MCP"
    assert started.payload["raw_tool_name"] == "search"
    assert started.payload["model_tool_name"] == "mcp__srv_1__search"
    assert started.payload["snapshot_id"] == "snap-1"
    assert finished.payload["kind"] == "mcp_tool"
    assert finished.payload["tool_call_id"] == "call-mcp"
    assert finished.payload["metadata"]["mcp"]["raw_tool_name"] == "search"


@pytest.mark.asyncio
async def test_process_agent_events_projects_command_tool_message_without_private_update() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "tool_skill",
                    "name": "load_skill",
                    "data": {"input": {"skill_name": "dev-plan"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_skill",
                    "name": "load_skill",
                    "data": {
                        "output": Command(
                            update={
                                "messages": [
                                    ToolMessage(
                                        content=(
                                            '{"skill_name":"dev-plan","found":true,'
                                            '"loaded":true,"injected":true}'
                                        ),
                                        tool_call_id="call_skill",
                                        name="load_skill",
                                    )
                                ],
                                "pending_skill_activations": [
                                    {
                                        "skill_name": "dev-plan",
                                        "content": "PRIVATE SKILL BODY",
                                    }
                                ],
                            }
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
    )

    finished = [
        event for event in emitted if event.event_type == DomainEventType.LLM_TOOL_FINISHED.value
    ][0]
    assert finished.payload["tool_call_id"] == "call_skill"
    assert finished.payload["result"] == (
        '{"skill_name":"dev-plan","found":true,"loaded":true,"injected":true}'
    )
    assert finished.payload["output_data"]["result"]["skill_name"] == "dev-plan"
    assert "PRIVATE SKILL BODY" not in str(finished.payload)
