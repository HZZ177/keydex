from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain.agents.middleware.types import ExtendedModelResponse, ModelRequest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, RemoveMessage

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.context_compression_utils import (
    is_context_compression_summary_message,
)
from backend.app.agent.middleware.context_compression import ContextCompressionMiddleware
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    ContextCompressionRuntimeSettings,
    save_agent_runtime_settings,
)
from backend.app.agent.tool_call_preset_middleware import ToolCallPresetMiddleware
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.events import EventDispatcher
from backend.app.services.context_compression_service import CompressionGenerationResult
from backend.app.services.manual_context_compression_service import (
    ManualContextCompressionService,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _skill_group() -> StructuredUserMessageGroup:
    return StructuredUserMessageGroup.create(
        group_id="group-current",
        root_user_message=build_structured_user_message_member(
            "root_user_message",
            1,
            {
                "content": "继续完成压缩实现",
                "message_id": "current-user",
                "role": "HumanMessage",
            },
            source_id="current-user",
        ),
        members=[
            build_structured_user_message_member(
                "message_injection_follow",
                0,
                {
                    "type": "follow",
                    "role": "HumanMessage",
                    "content": "只修改压缩相关代码",
                    "hidden_for_transcript": True,
                },
                source_id="quote-1",
            ),
            build_structured_user_message_member(
                "skill_activation",
                2,
                {
                    "skill_name": "dev-plan-execute",
                    "source": "workspace",
                    "origin": "slash",
                },
            ),
        ],
    )


def _checkpoint(checkpoint_id: str, messages: list[BaseMessage], group) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-07-17T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {
            "messages": messages,
            "structured_user_message_groups": [group.to_dict()],
        },
        "channel_versions": {},
        "versions_seen": {},
    }


class FakeCompressionService:
    def __init__(self, summary: str = "详细交接摘要") -> None:
        self.summary = summary
        self.calls: list[list[str]] = []

    async def generate_compression_result(self, *, messages, reason, **kwargs):
        self.calls.append([str(message.content) for message in messages])
        return CompressionGenerationResult(
            success=True,
            reason=reason,
            summary=self.summary,
            compression_message_count=len(messages),
            total_message_count=len(messages),
            attempt_count=1,
            boundary_id=str(kwargs.get("boundary_id") or ""),
            requested_max_output_tokens=int(kwargs.get("max_output_tokens") or 0),
        )


class FailedCompressionService:
    async def generate_compression_result(self, *, reason, **_kwargs):
        return CompressionGenerationResult(
            success=False,
            reason=reason,
            failure_reason="llm_error:controlled",
            attempt_count=4,
        )


@pytest.mark.asyncio
async def test_automatic_compression_authorizes_first_request_skill_replay_once(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="session-auto",
        user_id="local-user",
        scene_id="desktop-agent",
        title="auto",
    )
    group = _skill_group()
    compressor = FakeCompressionService()
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        user_id=session.user_id,
        trace_id="trace-auto",
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=50_000,
                trigger_fraction=0.1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=object(),
            compression_service=compressor,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(id="old-user", content="最初任务"),
                    AIMessage(
                        id="old-ai",
                        content="已经完成一部分",
                        usage_metadata={
                            "input_tokens": 44_000,
                            "output_tokens": 1_000,
                            "total_tokens": 45_000,
                        },
                    ),
                    HumanMessage(id="current-user", content="继续完成压缩实现"),
                ],
                "structured_user_message_groups": [group.to_dict()],
            },
            None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    assert isinstance(result["messages"][0], RemoveMessage)
    replacement_messages = result["messages"][1:]
    assert sum(is_context_compression_summary_message(item) for item in replacement_messages) == 1
    assert compressor.calls == [["最初任务", "已经完成一部分"]]
    preset = result["pending_tool_call_preset"]
    assert preset["calls"] == [
        {
            "name": "load_skill",
            "args": {
                "skill_name": "dev-plan-execute",
                "source": "workspace",
            },
        }
    ]
    boundary_id = preset["metadata"]["boundary_id"]
    assert result["structured_user_group_replay_markers"][
        f"{boundary_id}:group-current"
    ]["status"] == "pending"
    assert result["context_compression_diagnostics"]["deferred_replay_reserve"] == 4_000
    assert result["context_compression_diagnostics"]["final_request_estimate_tokens"] < (
        20_000
    )

    async def model_handler(_: ModelRequest) -> AIMessage:
        return AIMessage(content="should not run")

    replay = await ToolCallPresetMiddleware().awrap_model_call(
        ModelRequest(
            model=object(),
            messages=replacement_messages,
            tools=[SimpleNamespace(name="load_skill")],
            state=result,
        ),
        model_handler,
    )
    assert isinstance(replay, ExtendedModelResponse)
    assert replay.model_response.result[0].tool_calls[0]["name"] == "load_skill"
    assert replay.command is not None
    assert replay.command.update["pending_tool_call_preset"] is None
    assert replay.command.update["structured_user_group_replay_markers"][
        f"{boundary_id}:group-current"
    ]["status"] == "consumed"


@pytest.mark.asyncio
async def test_manual_compression_atomically_persists_authorized_replay_state(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(enabled=True)
        ),
    )
    session = repositories.sessions.create(
        session_id="session-manual-state",
        user_id="local-user",
        scene_id="desktop-agent",
        title="manual",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    group = _skill_group()
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint(
            "checkpoint-manual",
            [
                HumanMessage(id="old-user", content="最初任务"),
                AIMessage(id="old-ai", content="已完成一部分"),
                HumanMessage(id="current-user", content="继续完成压缩实现"),
            ],
            group,
        ),
        {},
        {},
    )

    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=FakeCompressionService(),
    ).compress(session_id=session.id)

    assert result.success is True
    checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert checkpoint is not None
    values = checkpoint.checkpoint["channel_values"]
    assert sum(
        is_context_compression_summary_message(item) for item in values["messages"]
    ) == 1
    assert [item["group_id"] for item in values["structured_user_message_groups"]] == [
        "group-current"
    ]
    boundary_id = values["pending_tool_call_preset"]["metadata"]["boundary_id"]
    assert values["structured_user_group_replay_markers"][
        f"{boundary_id}:group-current"
    ]["status"] == "pending"
    assert values["context_compression_diagnostics"]["boundary_id"] == boundary_id
    assert values["context_compression_diagnostics"]["replacement_actual_tokens"] > 0


@pytest.mark.asyncio
async def test_automatic_failure_leaves_epoch_and_structured_state_uncommitted(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="session-auto-failure",
        user_id="local-user",
        scene_id="desktop-agent",
        title="auto failure",
    )
    group = _skill_group()
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        user_id=session.user_id,
        trace_id="trace-auto-failure",
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=50_000,
                trigger_fraction=0.1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=object(),
            compression_service=FailedCompressionService(),
        )
        with pytest.raises(RuntimeError, match="context_compression_failed"):
            await middleware.abefore_model(
                {
                    "messages": [
                        HumanMessage(id="old-user", content="最初任务"),
                        AIMessage(
                            id="old-ai",
                            content="已经完成一部分",
                            usage_metadata={
                                "input_tokens": 44_000,
                                "output_tokens": 1_000,
                                "total_tokens": 45_000,
                            },
                        ),
                        HumanMessage(id="current-user", content="继续完成压缩实现"),
                    ],
                    "structured_user_message_groups": [group.to_dict()],
                },
                None,
            )
    finally:
        reset_request_context(token)

    assert repositories.sessions.get_context_compression_epoch(session.id) == 0


@pytest.mark.asyncio
async def test_three_automatic_compactions_replace_summary_and_advance_boundary_once_each(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="session-three-compactions",
        user_id="local-user",
        scene_id="desktop-agent",
        title="three compactions",
    )
    group = _skill_group()
    compressor = FakeCompressionService()
    middleware = ContextCompressionMiddleware(
        settings=ContextCompressionRuntimeSettings(
            enabled=True,
            context_window_tokens=50_000,
            trigger_fraction=0.1,
        ),
        repositories=repositories,
        dispatcher=EventDispatcher(),
        checkpointer=object(),
        compression_service=compressor,
    )
    state: dict = {
        "messages": [
            HumanMessage(id="old-user", content="最初任务"),
            AIMessage(
                id="old-ai",
                content="已经完成一部分",
                usage_metadata={
                    "input_tokens": 44_000,
                    "output_tokens": 1_000,
                    "total_tokens": 45_000,
                },
            ),
            HumanMessage(id="current-user", content="继续完成压缩实现"),
        ],
        "structured_user_message_groups": [group.to_dict()],
    }
    boundaries: list[str] = []
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        user_id=session.user_id,
        trace_id="trace-three-compactions",
    )
    try:
        for index in range(3):
            update = await middleware.abefore_model(state, None)
            assert update is not None
            replacement = [
                message for message in update["messages"] if not isinstance(message, RemoveMessage)
            ]
            assert sum(is_context_compression_summary_message(item) for item in replacement) == 1
            boundary = update["context_compression_diagnostics"]["boundary_id"]
            assert boundary not in boundaries
            boundaries.append(boundary)
            assert len(update["structured_user_message_groups"]["groups"]) == 1
            if index < 2:
                state = {
                    **update,
                    "messages": [
                        *replacement,
                        AIMessage(
                            id=f"long-tail-{index}",
                            content="x" * 20_000,
                            usage_metadata={
                                "input_tokens": 44_000,
                                "output_tokens": 1_000,
                                "total_tokens": 45_000,
                            },
                        ),
                    ],
                    "structured_user_message_groups": update[
                        "structured_user_message_groups"
                    ]["groups"],
                }
    finally:
        reset_request_context(token)

    assert len(compressor.calls) == 3
    assert repositories.sessions.get_context_compression_epoch(session.id) == 3
