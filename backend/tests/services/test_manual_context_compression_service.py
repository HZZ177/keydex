from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.agent.context_compression_utils import (
    build_context_compression_replacement_messages,
    is_context_compression_summary_message,
)
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    ContextCompressionRuntimeSettings,
    save_agent_runtime_settings,
)
from backend.app.agent.state import (
    CHECKPOINT_STATE_UPDATE_NODE,
    build_checkpoint_state_graph,
)
from backend.app.services.context_compression_service import CompressionGenerationResult
from backend.app.services.manual_context_compression_service import ManualContextCompressionService
from backend.app.storage import StorageRepositories, init_database


@pytest.fixture
async def checkpoint_env(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    runtime = CheckpointRuntime(repositories.db.path)
    assert await runtime.start() is True
    graph = build_checkpoint_state_graph(runtime.require_store())
    yield repositories, runtime, runtime.require_store(), graph
    await runtime.close()


async def _seed_messages(
    graph: Any,
    *,
    thread_id: str,
    messages: list[BaseMessage],
) -> dict[str, Any]:
    return await graph.aupdate_state(
        {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}},
        {"messages": messages},
        as_node=CHECKPOINT_STATE_UPDATE_NODE,
    )


def _enable_compression(
    repositories: StorageRepositories,
    *,
    context_window_tokens: int = 200_000,
) -> None:
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=context_window_tokens,
                trigger_fraction=0.5,
            )
        ),
    )


@pytest.mark.asyncio
async def test_manual_context_compression_appends_successor_without_mutating_source(
    checkpoint_env,
) -> None:
    repositories, _runtime, saver, graph = checkpoint_env
    _enable_compression(repositories, context_window_tokens=100_000)
    session = repositories.sessions.create(
        session_id="ses_manual",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    repositories.sessions.update_context_window_usage(
        session.id,
        {
            "stage": "context_window_snapshot",
            "token_count": 900,
            "context_window": 1000,
        },
    )
    messages = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
    ]
    source_config = await _seed_messages(graph, thread_id=session.id, messages=messages)
    source_checkpoint = await saver.aget_tuple(source_config)
    assert source_checkpoint is not None
    source_payload = source_checkpoint.checkpoint
    source_metadata = source_checkpoint.metadata
    broadcast_events: list[tuple[str, str, dict]] = []

    async def broadcast(session_id: str, action: str, data: dict) -> bool:
        broadcast_events.append((session_id, action, data))
        return True

    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        checkpoint_state_graph=graph,
        compression_service=FakeCompressionService(summary="手动摘要"),
        broadcaster=broadcast,
    ).compress(session_id=session.id)

    assert result.success is True
    assert result.active_session_id == session.id
    assert result.context_compression_epoch == 1
    source = repositories.sessions.get(session.id)
    assert source is not None
    assert source.active_session_id == session.id
    assert source.context_compression_epoch == 1
    assert source.context_window_usage is None
    assert [record.id for record in repositories.sessions.list(user_id="local-user")] == [
        session.id
    ]
    assert [event[2]["stage"] for event in broadcast_events] == [
        "compression_started",
        "compression_completed",
    ]
    assert [
        record.data["stage"] for record in repositories.message_events.list_by_session(session.id)
    ] == ["compression_started", "compression_completed"]

    latest = await graph.aget_state(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert latest.config is not None
    assert latest.config["configurable"]["checkpoint_id"] != (
        source_config["configurable"]["checkpoint_id"]
    )
    assert latest.parent_config == source_config
    target_messages = _checkpoint_messages(latest)
    assert [type(message) for message in target_messages] == [HumanMessage, HumanMessage]
    assert is_context_compression_summary_message(target_messages[0]) is True
    assert "手动摘要" in str(target_messages[0].content)
    assert "最近问题" not in str(target_messages[0].content)
    assert target_messages[1].content == "最近问题"

    unchanged_source = await saver.aget_tuple(source_config)
    assert unchanged_source is not None
    assert unchanged_source.checkpoint == source_payload
    assert unchanged_source.metadata == source_metadata


@pytest.mark.asyncio
async def test_manual_context_compression_detects_checkpoint_conflict(checkpoint_env) -> None:
    repositories, _runtime, saver, graph = checkpoint_env
    _enable_compression(repositories)
    session = repositories.sessions.create(
        session_id="ses_conflict",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    source_config = await _seed_messages(
        graph,
        thread_id=session.id,
        messages=[
            HumanMessage(content="旧问题", id="h1"),
            AIMessage(content="旧回答", id="a1"),
        ],
    )
    compression_service = FakeCompressionService(
        summary="会冲突的摘要",
        mutate_graph=graph,
    )

    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        checkpoint_state_graph=graph,
        compression_service=compression_service,
    ).compress(session_id=session.id)

    assert result.success is False
    assert result.reason == "checkpoint_conflict"
    latest = await graph.aget_state(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert latest.config is not None
    assert latest.config["configurable"]["checkpoint_id"] != (
        source_config["configurable"]["checkpoint_id"]
    )
    assert [message.content for message in _checkpoint_messages(latest)] == [
        "旧问题",
        "旧回答",
        "新消息",
    ]


@pytest.mark.asyncio
async def test_manual_generation_failure_keeps_checkpoint_and_epoch_unchanged(
    checkpoint_env,
) -> None:
    repositories, _runtime, saver, graph = checkpoint_env
    _enable_compression(repositories)
    session = repositories.sessions.create(
        session_id="ses_generation_failure",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    original = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
    ]
    source_config = await _seed_messages(graph, thread_id=session.id, messages=original)

    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        checkpoint_state_graph=graph,
        compression_service=FailedCompressionService("llm_error:temporary"),
    ).compress(session_id=session.id)

    assert result.success is False
    assert result.reason == "llm_error:temporary"
    latest = await graph.aget_state(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert latest.config is not None
    assert latest.config == source_config
    assert [message.model_dump() for message in _checkpoint_messages(latest)] == [
        message.model_dump() for message in original
    ]
    assert repositories.sessions.get_context_compression_epoch(session.id) == 0


@pytest.mark.asyncio
async def test_manual_checkpoint_write_failure_returns_no_partial_replacement(
    checkpoint_env,
    monkeypatch,
) -> None:
    repositories, _runtime, saver, graph = checkpoint_env
    _enable_compression(repositories)
    session = repositories.sessions.create(
        session_id="ses_checkpoint_failure",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    original = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
    ]
    source_config = await _seed_messages(graph, thread_id=session.id, messages=original)

    async def fail_write(*_args, **_kwargs):
        raise OSError("controlled checkpoint write failure")

    monkeypatch.setattr(graph, "aupdate_state", fail_write)
    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        checkpoint_state_graph=graph,
        compression_service=FakeCompressionService(summary="不会提交的摘要"),
    ).compress(session_id=session.id)

    assert result.success is False
    assert result.reason == "checkpoint_replacement_failed"
    latest = await graph.aget_state(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert latest.config is not None
    assert latest.config == source_config
    assert [message.model_dump() for message in _checkpoint_messages(latest)] == [
        message.model_dump() for message in original
    ]
    assert repositories.sessions.get_context_compression_epoch(session.id) == 0


@pytest.mark.asyncio
async def test_manual_crash_after_successor_write_leaves_recoverable_compact_head(
    checkpoint_env,
    monkeypatch,
) -> None:
    repositories, runtime, saver, graph = checkpoint_env
    _enable_compression(repositories)
    session = repositories.sessions.create(
        session_id="ses_after_write_crash",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    await _seed_messages(
        graph,
        thread_id=session.id,
        messages=[
            HumanMessage(content="旧问题", id="h1"),
            AIMessage(content="旧回答", id="a1"),
            HumanMessage(content="最近问题", id="h2"),
        ],
    )
    service = ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        checkpoint_state_graph=graph,
        compression_service=FakeCompressionService(summary="已原子写入的摘要"),
    )

    def crash_after_write(_session_id: str) -> int:
        raise RuntimeError("controlled crash after checkpoint write")

    monkeypatch.setattr(service, "_mark_context_compressed", crash_after_write)
    with pytest.raises(RuntimeError, match="controlled crash"):
        await service.compress(session_id=session.id)

    await runtime.close()
    restarted = CheckpointRuntime(repositories.db.path)
    assert await restarted.start() is True
    try:
        restarted_graph = build_checkpoint_state_graph(restarted.require_store())
        checkpoint = await restarted_graph.aget_state(
            {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
        )
        assert checkpoint.config is not None
        messages = _checkpoint_messages(checkpoint)
        assert sum(is_context_compression_summary_message(message) for message in messages) == 1
        assert repositories.sessions.get_context_compression_epoch(session.id) == 0
    finally:
        await restarted.close()


def _checkpoint_messages(checkpoint: object) -> list[BaseMessage]:
    values = getattr(checkpoint, "values", None)
    if not isinstance(values, dict):
        values = getattr(checkpoint, "checkpoint", {}).get("channel_values", {})
    messages = values.get("messages") if isinstance(values, dict) else None
    return [message for message in list(messages or []) if isinstance(message, BaseMessage)]


class FakeCompressionService:
    def __init__(
        self,
        *,
        summary: str,
        mutate_graph: Any | None = None,
    ) -> None:
        self.summary = summary
        self.mutate_graph = mutate_graph

    async def generate_compression_result(self, *, session, messages, reason, **_kwargs):
        if self.mutate_graph is not None:
            await self.mutate_graph.aupdate_state(
                {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
                {"messages": [HumanMessage(content="新消息", id="h3")]},
                as_node=CHECKPOINT_STATE_UPDATE_NODE,
            )
        replacement = build_context_compression_replacement_messages(
            summary=self.summary,
            source_messages=messages,
        )
        return CompressionGenerationResult(
            success=True,
            reason=reason,
            summary=self.summary,
            replacement_messages=replacement.replaced_messages,
            compression_message_count=len(messages),
            total_message_count=len(messages),
        )


class FailedCompressionService:
    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def generate_compression_result(self, *, reason, **_kwargs):
        return CompressionGenerationResult(
            success=False,
            reason=reason,
            failure_reason=self.reason,
            attempt_count=4,
        )
