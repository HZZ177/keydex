from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
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
async def test_manual_deep_context_compression_replaces_target_checkpoint(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=100000,
                trigger_fraction=0.5,
                emergency_fraction=0.9,
                retain_rounds=1,
            )
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_manual_deep",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    messages = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
        AIMessage(content="最近回答", id="a2"),
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

    compression_service = FakeCompressionService(l1="手动全量摘要")
    service = ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=compression_service,
        broadcaster=broadcast,
    )

    result = await service.compress(session_id=session.id, mode="deep")

    assert result.success is True
    assert result.mode == "deep"
    assert result.staging_strategy == "full_replacement"
    assert result.source_last_message_id == "a2"
    source = repositories.sessions.get(session.id)
    assert source.active_session_id == result.target_session_id
    assert source.context_compression_epoch == 1
    target = repositories.sessions.get(result.target_session_id)
    assert target is not None
    assert target.parent_session_id == session.id
    assert target.source_checkpoint_id == "ckpt_manual"
    assert target.session_tag == repositories.sessions.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG
    assert result.target_session_id not in {
        record.id for record in repositories.sessions.list(user_id="local-user")
    }
    staging = repositories.compression_staging.get_latest(
        original_session_id=session.id,
        status="pending",
        target_session_id=target.id,
    )
    assert staging is None
    assert [event[2]["stage"] for event in broadcast_events] == [
        "manual_deep_started",
        "manual_deep_completed",
    ]
    assert broadcast_events[-1][2]["context_compression_epoch"] == 1
    assert [record.data["stage"] for record in repositories.message_events.list_by_session(session.id)] == [
        "manual_deep_started",
        "manual_deep_completed",
    ]
    assert compression_service.materials[0].side_event_metadata["mode"] == "manual_deep"
    source_checkpoint = saver.get_tuple(
        {
            "configurable": {
                "thread_id": session.id,
                "checkpoint_ns": "",
                "checkpoint_id": "ckpt_manual",
            }
        }
    )
    target_checkpoint = saver.get_tuple(
        {
            "configurable": {
                "thread_id": target.id,
                "checkpoint_ns": "",
                "checkpoint_id": "ckpt_manual",
            }
        }
    )
    assert source_checkpoint is not None
    assert target_checkpoint is not None
    assert source_checkpoint.checkpoint["channel_values"]["messages"] == messages
    target_messages = _checkpoint_messages(target_checkpoint)
    assert [type(message) for message in target_messages] == [SystemMessage, SystemMessage]
    assert "手动全量摘要" in str(target_messages[1].content)
    assert all("最近问题" not in str(message.content) for message in target_messages)


@pytest.mark.asyncio
async def test_manual_light_context_compression_replaces_target_checkpoint_with_retained_turns(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    save_agent_runtime_settings(
        repositories,
        AgentRuntimeSettings(
            context_compression=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=100000,
                trigger_fraction=0.5,
                emergency_fraction=0.9,
                retain_rounds=2,
            )
        ),
    )
    session = repositories.sessions.create(
        session_id="ses_manual_light",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    messages = [
        HumanMessage(content="第一轮问题", id="h1"),
        AIMessage(content="第一轮回答", id="a1"),
        HumanMessage(content="第二轮问题", id="h2"),
        AIMessage(content="第二轮回答", id="a2"),
        HumanMessage(content="第三轮问题", id="h3"),
        AIMessage(content="第三轮回答", id="a3"),
    ]
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_light", messages),
        {},
        {},
    )

    compression_service = FakeCompressionService(l1="手动轻量摘要")
    service = ManualContextCompressionService(
        repositories,
        checkpointer=saver,
        compression_service=compression_service,
    )

    result = await service.compress(session_id=session.id, mode="light")

    assert result.success is True
    assert result.mode == "light"
    assert result.staging_id is None
    assert result.staging_strategy == "anchor_replacement"
    assert result.anchor_message_id == "h2"
    source = repositories.sessions.get(session.id)
    assert source.active_session_id == result.target_session_id
    assert source.context_compression_epoch == 1
    target = repositories.sessions.get(result.target_session_id)
    assert target is not None
    assert target.session_tag == repositories.sessions.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG
    assert result.target_session_id not in {
        record.id for record in repositories.sessions.list(user_id="local-user")
    }
    staging = repositories.compression_staging.get_latest(
        original_session_id=session.id,
        status="pending",
        target_session_id=target.id,
    )
    assert staging is None
    target_checkpoint = saver.get_tuple(
        {
            "configurable": {
                "thread_id": target.id,
                "checkpoint_ns": "",
                "checkpoint_id": "ckpt_light",
            }
        }
    )
    assert target_checkpoint is not None
    target_messages = _checkpoint_messages(target_checkpoint)
    assert "手动轻量摘要" in str(target_messages[1].content)
    assert [getattr(message, "id", None) for message in target_messages[2:]] == [
        "h2",
        "a2",
        "h3",
        "a3",
    ]
    assert all("第一轮" not in str(message.content) for message in target_messages)


def _checkpoint_messages(checkpoint: object) -> list[BaseMessage]:
    values = getattr(checkpoint, "checkpoint", {}).get("channel_values", {})
    messages = values.get("messages") if isinstance(values, dict) else None
    return [message for message in list(messages or []) if isinstance(message, BaseMessage)]


class FakeCompressionService:
    def __init__(self, *, l1: str, l2: str | None = None) -> None:
        self.l1 = l1
        self.l2 = l2
        self.materials: list = []

    async def generate_compression_result(self, *, material):
        self.materials.append(material)
        return CompressionGenerationResult(
            success=True,
            phase=material.phase,
            new_l1_content=self.l1,
            new_l2_content=self.l2,
        )
