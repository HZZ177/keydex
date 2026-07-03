from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from backend.app.agent import AgentRunner
from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.factory import AgentFactory
from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.model import ModelSettings
from backend.app.services import ChatRequest, ChatService
from backend.app.services.chat_service import (
    _build_initial_thread_task_context,
    _build_message_context_items,
    _build_message_injection_items,
    _build_thread_task_runtime_context,
)
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)
from backend.app.tools import ToolRegistry


class ToolFriendlyFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: list[Any], *, tool_choice: Any = None, **kwargs: Any) -> Any:
        return self


class FakeAgentFactory(AgentFactory):
    def __init__(self, model: ToolFriendlyFakeModel) -> None:
        super().__init__()
        self.model = model
        self.requested_models: list[str] = []

    def get_or_create_llm(
        self,
        settings: ModelSettings,
        *,
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        streaming: bool = True,
        **kwargs: Any,
    ) -> ToolFriendlyFakeModel:
        self.requested_models.append(model)
        return self.model


def _service(
    tmp_path: Path,
    model: ToolFriendlyFakeModel,
) -> tuple[ChatService, StorageRepositories, SQLiteCheckpointSaver, FakeAgentFactory]:
    database = init_database(tmp_path / "app.db")
    repositories = StorageRepositories(database)
    now = to_iso_z(utc_now())
    provider = ModelProviderRecord(
        id="provider-1",
        name="测试模型服务",
        base_url="http://model.test/v1",
        api_key="test-key",
        enabled=True,
        models=["qwen-coder", "fake-default"],
        model_enabled={},
        health={},
        created_at=now,
        updated_at=now,
    )
    repositories.model_providers.upsert(provider)
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id=provider.id,
        model="fake-default",
    )
    settings = AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path)
    checkpointer = SQLiteCheckpointSaver(database)
    factory = FakeAgentFactory(model)
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="fake-default",
        ),
        checkpointer=checkpointer,
        tool_registry=ToolRegistry(),
        default_system_prompt="系统提示",
        factory=factory,
    )
    return (
        ChatService(settings=settings, repositories=repositories, agent_runner=runner),
        repositories,
        checkpointer,
        factory,
    )


def _chat_messages(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [message for message in history if message.get("role") != "turn"]


def test_message_injection_parser_accepts_hidden_for_transcript() -> None:
    items = _build_message_injection_items(
        {
            "message_injection": [
                {
                    "type": "follow",
                    "role": "HumanMessage",
                    "content": "hidden task context",
                    "hidden_for_transcript": True,
                    "metadata": {"source": "thread_task"},
                }
            ]
        }
    )

    assert len(items) == 1
    assert items[0].hidden_for_transcript is True
    assert items[0].metadata == {"source": "thread_task"}


def test_message_injection_parser_accepts_metadata_hidden_for_transcript() -> None:
    items = _build_message_injection_items(
        {
            "message_injection": [
                {
                    "type": "follow",
                    "role": "HumanMessage",
                    "content": "hidden task context",
                    "metadata": {
                        "source": "thread_task",
                        "hidden_for_transcript": True,
                    },
                }
            ]
        }
    )

    assert items[0].hidden_for_transcript is True
    assert items[0].metadata["source"] == "thread_task"


def test_message_injection_parser_rejects_invalid_hidden_for_transcript() -> None:
    with pytest.raises(ValueError, match="hidden_for_transcript"):
        _build_message_injection_items(
            {
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "hidden task context",
                        "hidden_for_transcript": "yes",
                    }
                ]
            }
        )


def test_message_injection_parser_rejects_invalid_metadata_hidden_for_transcript() -> None:
    with pytest.raises(ValueError, match="hidden_for_transcript"):
        _build_message_injection_items(
            {
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "hidden task context",
                        "metadata": {"hidden_for_transcript": "yes"},
                    }
                ]
            }
        )


def test_message_context_item_parser_accepts_goal_marker() -> None:
    items = _build_message_context_items(
        {
            "message_context_items": [
                {
                    "id": "goal:123",
                    "type": "goal",
                    "label": "目标",
                    "content": "完成目标",
                    "source": "goal",
                    "metadata": {"kind": "goal", "objective": "完成目标"},
                }
            ]
        }
    )

    assert items == [
        {
            "id": "goal:123",
            "type": "goal",
            "label": "目标",
            "content": "完成目标",
            "role": "HumanMessage",
            "source": "goal",
            "metadata": {"kind": "goal", "objective": "完成目标"},
        }
    ]


def test_thread_task_runtime_context_accepts_task_continue_payload() -> None:
    context = _build_thread_task_runtime_context(
        {
            "thread_task": {
                "task_id": "task-1",
                "run_id": "run-1",
                "trigger": "task_continue",
                "type": "goal",
            }
        }
    )

    assert context == {
        "task_id": "task-1",
        "run_id": "run-1",
        "trigger": "task_continue",
        "type": "goal",
    }


def test_thread_task_runtime_context_requires_task_continue_trigger() -> None:
    with pytest.raises(ValueError, match="trigger"):
        _build_thread_task_runtime_context(
            {
                "thread_task": {
                    "task_id": "task-1",
                    "run_id": "run-1",
                    "trigger": "user_message",
                }
            }
        )


def test_initial_thread_task_context_accepts_task_start_payload() -> None:
    context = _build_initial_thread_task_context(
        {
            "initial_thread_task": {
                "task_id": "task-1",
                "trigger": "task_start",
                "type": "goal",
            }
        }
    )

    assert context == {
        "task_id": "task-1",
        "trigger": "task_start",
        "type": "goal",
    }


def test_initial_thread_task_context_rejects_task_continue_trigger() -> None:
    with pytest.raises(ValueError, match="task_start"):
        _build_initial_thread_task_context(
            {
                "initial_thread_task": {
                    "task_id": "task-1",
                    "trigger": "task_continue",
                    "type": "goal",
                }
            }
        )


@pytest.mark.asyncio
async def test_initial_thread_task_prompt_enters_first_goal_turn_without_transcript(
    tmp_path: Path,
) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="首轮完成目标")])
    service, repositories, checkpointer, _factory = _service(tmp_path, model)
    session = repositories.sessions.create(
        session_id="ses-task",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id=session.id,
        type="goal",
        objective="整理目标方案",
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="请整理目标方案",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "initial_thread_task": {
                    "task_id": task.id,
                    "trigger": "task_start",
                    "type": "goal",
                },
                "message_context_items": [
                    {
                        "id": "goal:abc",
                        "type": "goal",
                        "label": "目标",
                        "content": "整理目标方案",
                        "source": "goal",
                    }
                ],
            },
        )
    )

    assert result.status == "completed"
    history = _chat_messages(service.message_event_service.get_display_messages(session.id))
    assert [message["role"] for message in history] == ["user", "assistant"]
    assert history[0]["content"] == "请整理目标方案"
    assert history[0]["contextItems"][0]["type"] == "goal"

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert "用户刚创建的长程目标任务" in messages[0].content
    assert "必须调用 update_thread_task 并设置 status=complete" in messages[0].content
    assert [message.content for message in messages[1:3]] == [
        "请整理目标方案",
        "首轮完成目标",
    ]

    trace = repositories.trace_records.get(result.trace_id)
    assert trace is not None
    assert trace.metadata["initial_thread_task"] == {
        "task_id": task.id,
        "trigger": "task_start",
        "type": "goal",
    }
    assert "thread_task" not in trace.metadata


@pytest.mark.asyncio
async def test_hidden_thread_task_injection_enters_model_without_transcript(
    tmp_path: Path,
) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="继续处理目标")])
    service, repositories, checkpointer, factory = _service(tmp_path, model)
    session = repositories.sessions.create(
        session_id="ses-task",
        user_id="local-user",
        scene_id="desktop-agent",
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "thread_task": {
                    "task_id": "task-1",
                    "run_id": "run-1",
                    "trigger": "task_continue",
                    "type": "goal",
                },
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "hidden task context",
                        "hidden_for_transcript": True,
                        "metadata": {
                            "source": "thread_task",
                            "task_id": "task-1",
                            "run_id": "run-1",
                        },
                    }
                ],
            },
        )
    )

    assert result.status == "completed"
    assert factory.requested_models == ["qwen-coder"]
    history = _chat_messages(service.message_event_service.get_display_messages(session.id))
    assert [message["role"] for message in history] == ["assistant"]
    assert history[0]["content"] == "继续处理目标"

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.content for message in messages[:2]] == [
        "hidden task context",
        "继续处理目标",
    ]

    trace = repositories.trace_records.get(result.trace_id)
    assert trace is not None
    assert trace.user_message_preview == ""
    assert trace.metadata["thread_task"] == {
        "task_id": "task-1",
        "run_id": "run-1",
        "trigger": "task_continue",
        "type": "goal",
    }


@pytest.mark.asyncio
async def test_hidden_thread_task_seed_message_enters_model_without_transcript(
    tmp_path: Path,
) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="继续处理目标")])
    service, repositories, checkpointer, _factory = _service(tmp_path, model)
    session = repositories.sessions.create(
        session_id="ses-task",
        user_id="local-user",
        scene_id="desktop-agent",
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="用户开启目标时的原始输入",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "hide_user_message_for_transcript": True,
                "thread_task": {
                    "task_id": "task-1",
                    "run_id": "run-1",
                    "trigger": "task_continue",
                    "type": "goal",
                    "hide_user_message_for_transcript": True,
                },
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "hidden task context",
                        "hidden_for_transcript": True,
                    }
                ],
            },
        )
    )

    assert result.status == "completed"
    history = _chat_messages(service.message_event_service.get_display_messages(session.id))
    assert [message["role"] for message in history] == ["assistant"]

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.content for message in messages[:3]] == [
        "hidden task context",
        "用户开启目标时的原始输入",
        "继续处理目标",
    ]


@pytest.mark.asyncio
async def test_chat_service_attaches_thread_task_run_to_turn(tmp_path: Path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="继续处理目标")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    session = repositories.sessions.create(
        session_id="ses-task",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id=session.id,
        type="goal",
        objective="目标",
    )
    repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task.id,
        session_id=session.id,
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "thread_task": {
                    "task_id": task.id,
                    "run_id": "run-1",
                    "trigger": "task_continue",
                    "type": "goal",
                },
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "hidden task context",
                        "hidden_for_transcript": True,
                    }
                ],
            },
        )
    )

    run = repositories.thread_task_runs.get("run-1")
    assert run is not None
    assert run.turn_index == result.turn_index
    assert run.trace_id == result.trace_id


@pytest.mark.asyncio
async def test_visible_message_injection_still_restores_context_item(
    tmp_path: Path,
) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已参考上下文")])
    service, _repositories, checkpointer, _factory = _service(tmp_path, model)

    result = await service.handle_chat(
        ChatRequest(
            message="总结一下",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "用户通过 @ 引用了工作区文件：README.md",
                        "metadata": {
                            "id": "file:readme",
                            "kind": "file",
                            "label": "README.md",
                            "path": "README.md",
                            "name": "README.md",
                            "fileType": "file",
                        },
                    }
                ]
            },
        )
    )

    history = _chat_messages(service.message_event_service.get_display_messages(result.session_id))
    assert [message["role"] for message in history] == ["user", "assistant"]
    assert history[0]["content"] == "总结一下"
    assert history[0]["contextItems"][0]["type"] == "file"
    assert history[0]["contextItems"][0]["path"] == "README.md"

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": result.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.content for message in messages[:3]] == [
        "用户通过 @ 引用了工作区文件：README.md",
        "总结一下",
        "已参考上下文",
    ]


@pytest.mark.asyncio
async def test_message_context_items_restore_history_without_entering_model(
    tmp_path: Path,
) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已记录目标")])
    service, _repositories, checkpointer, _factory = _service(tmp_path, model)

    result = await service.handle_chat(
        ChatRequest(
            message="开启目标",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "message_context_items": [
                    {
                        "id": "goal:abc",
                        "type": "goal",
                        "label": "目标",
                        "content": "完成目标",
                        "source": "goal",
                        "metadata": {
                            "kind": "goal",
                            "title": "目标",
                            "objective": "完成目标",
                        },
                    }
                ]
            },
        )
    )

    history = _chat_messages(service.message_event_service.get_display_messages(result.session_id))
    assert [message["role"] for message in history] == ["user", "assistant"]
    assert history[0]["content"] == "开启目标"
    assert history[0]["contextItems"][0] == {
        "id": "goal:abc",
        "type": "goal",
        "label": "目标",
        "content": "完成目标",
        "role": "HumanMessage",
        "source": "goal",
        "timestamp": history[0]["contextItems"][0]["timestamp"],
        "metadata": {
            "id": "goal:abc",
            "kind": "goal",
            "label": "目标",
            "title": "目标",
            "objective": "完成目标",
        },
    }

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": result.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.content for message in messages[:2]] == [
        "开启目标",
        "已记录目标",
    ]


@pytest.mark.asyncio
async def test_empty_message_without_injection_still_fails(tmp_path: Path) -> None:
    service, _repositories, _checkpointer, _factory = _service(
        tmp_path,
        ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")]),
    )

    with pytest.raises(ValueError, match="用户消息不能为空"):
        await service.handle_chat(ChatRequest(message="", provider_id="provider-1"))
