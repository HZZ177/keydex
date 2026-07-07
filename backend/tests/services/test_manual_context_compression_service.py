from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.context_compression_utils import (
    LATEST_USER_MESSAGE_SNAPSHOT_TAG,
    build_context_compression_replacement_messages,
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
    assert [type(message) for message in target_messages] == [SystemMessage]
    summary_content = str(target_messages[0].content)
    assert "手动摘要" in summary_content
    assert LATEST_USER_MESSAGE_SNAPSHOT_TAG in summary_content
    assert "最近问题" in summary_content


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
        _checkpoint("ckpt_1", [HumanMessage(content="旧问题", id="h1")]),
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
