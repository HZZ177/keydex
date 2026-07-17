from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.context_compression_utils import (
    build_context_compression_replacement_messages,
    is_context_compression_summary_message,
)
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    ContextCompressionRuntimeSettings,
    save_agent_runtime_settings,
)
from backend.app.services.context_compression_service import CompressionGenerationResult
from backend.app.services.manual_context_compression_service import ManualContextCompressionService
from backend.app.storage import StorageRepositories, init_database


def _checkpoint(checkpoint_id: str, messages: list) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-06-28T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {"messages": messages},
        "channel_versions": {},
        "versions_seen": {},
    }


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


@pytest.mark.asyncio
async def test_manual_context_compression_replaces_active_checkpoint_in_place(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=100000,
                trigger_fraction=0.5,
            )
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_manual",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    messages = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
    ]
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_manual", messages),
        {},
        {},
    )
    broadcast_events: list[tuple[str, str, dict]] = []

    async def broadcast(session_id: str, action: str, data: dict) -> bool:
        broadcast_events.append((session_id, action, data))
        return True

    service = ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=FakeCompressionService(summary="手动摘要"),
        broadcaster=broadcast,
    )

    result = await service.compress(session_id=session.id)

    assert result.success is True
    assert result.active_session_id == session.id
    assert result.context_compression_epoch == 1
    source = repositories.sessions.get(session.id)
    assert source is not None
    assert source.active_session_id == session.id
    assert source.context_compression_epoch == 1
    assert [record.id for record in repositories.sessions.list(user_id="local-user")] == [
        session.id
    ]
    assert [event[2]["stage"] for event in broadcast_events] == [
        "compression_started",
        "compression_completed",
    ]
    persisted_stages = [
        record.data["stage"] for record in repositories.message_events.list_by_session(session.id)
    ]
    assert persisted_stages == ["compression_started", "compression_completed"]

    checkpoint = saver.get_tuple(
        {
            "configurable": {
                "thread_id": session.id,
                "checkpoint_ns": "",
                "checkpoint_id": "ckpt_manual",
            }
        }
    )
    assert checkpoint is not None
    target_messages = _checkpoint_messages(checkpoint)
    assert [type(message) for message in target_messages] == [
        HumanMessage,
        AIMessage,
        HumanMessage,
    ]
    assert is_context_compression_summary_message(target_messages[0]) is True
    summary_content = str(target_messages[0].content)
    assert "手动摘要" in summary_content
    assert "最近问题" not in summary_content
    assert target_messages[1].content == "旧回答"
    assert target_messages[2].content == "最近问题"


@pytest.mark.asyncio
async def test_manual_context_compression_detects_checkpoint_conflict(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(enabled=True)
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_conflict",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint(
            "ckpt_1",
            [
                HumanMessage(content="旧问题", id="h1"),
                AIMessage(content="旧回答", id="a1"),
            ],
        ),
        {},
        {},
    )
    compression_service = FakeCompressionService(summary="会冲突的摘要", mutate_checkpoint=saver)
    service = ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=compression_service,
    )

    result = await service.compress(session_id=session.id)

    assert result.success is False
    assert result.reason == "checkpoint_conflict"
    checkpoint = saver.get_tuple({"configurable": {"thread_id": session.id, "checkpoint_ns": ""}})
    assert checkpoint is not None
    assert checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_2"


@pytest.mark.asyncio
async def test_manual_generation_failure_keeps_checkpoint_and_epoch_unchanged(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(enabled=True)
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_generation_failure",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    original = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
    ]
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_failure", original),
        {},
        {},
    )

    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=FailedCompressionService("llm_error:temporary"),
    ).compress(session_id=session.id)

    assert result.success is False
    assert result.reason == "llm_error:temporary"
    checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert checkpoint is not None
    assert [message.model_dump() for message in _checkpoint_messages(checkpoint)] == [
        message.model_dump() for message in original
    ]
    assert repositories.sessions.get_context_compression_epoch(session.id) == 0


@pytest.mark.asyncio
async def test_manual_checkpoint_write_failure_returns_no_partial_replacement(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(enabled=True)
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_checkpoint_failure",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    original = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
    ]
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_write_failure", original),
        {},
        {},
    )

    def fail_write(**_kwargs) -> None:
        raise OSError("controlled checkpoint write failure")

    monkeypatch.setattr(saver, "replace_checkpoint_state", fail_write)
    result = await ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=FakeCompressionService(summary="不会提交的摘要"),
    ).compress(session_id=session.id)

    assert result.success is False
    assert result.reason == "checkpoint_replacement_failed"
    checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert checkpoint is not None
    assert [message.model_dump() for message in _checkpoint_messages(checkpoint)] == [
        message.model_dump() for message in original
    ]
    assert repositories.sessions.get_context_compression_epoch(session.id) == 0


@pytest.mark.asyncio
async def test_manual_crash_after_atomic_checkpoint_write_leaves_recoverable_compact_state(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(enabled=True)
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_after_write_crash",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint(
            "ckpt_after_write",
            [
                HumanMessage(content="旧问题", id="h1"),
                AIMessage(content="旧回答", id="a1"),
                HumanMessage(content="最近问题", id="h2"),
            ],
        ),
        {},
        {},
    )
    service = ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=FakeCompressionService(summary="已原子写入的摘要"),
    )

    def crash_after_write(_session_id: str) -> int:
        raise RuntimeError("controlled crash after checkpoint write")

    monkeypatch.setattr(service, "_mark_context_compressed", crash_after_write)
    with pytest.raises(RuntimeError, match="controlled crash"):
        await service.compress(session_id=session.id)

    restarted = SQLiteCheckpointSaver(repositories.db)
    checkpoint = restarted.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert checkpoint is not None
    messages = _checkpoint_messages(checkpoint)
    assert sum(is_context_compression_summary_message(message) for message in messages) == 1
    assert repositories.sessions.get_context_compression_epoch(session.id) == 0


def _checkpoint_messages(checkpoint: object) -> list[BaseMessage]:
    values = getattr(checkpoint, "checkpoint", {}).get("channel_values", {})
    messages = values.get("messages") if isinstance(values, dict) else None
    return [message for message in list(messages or []) if isinstance(message, BaseMessage)]


class FakeCompressionService:
    def __init__(
        self,
        *,
        summary: str,
        mutate_checkpoint: SQLiteCheckpointSaver | None = None,
    ) -> None:
        self.summary = summary
        self.mutate_checkpoint = mutate_checkpoint

    async def generate_compression_result(self, *, session, messages, reason, **_kwargs):
        if self.mutate_checkpoint is not None:
            self.mutate_checkpoint.put(
                {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
                _checkpoint("ckpt_2", [HumanMessage(content="新消息", id="h2")]),
                {},
                {},
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
