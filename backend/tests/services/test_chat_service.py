from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

from backend.app.agent import AgentRunner
from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.factory import AgentFactory
from backend.app.agent.middleware.common import ToolCallLimitExceededError
from backend.app.command_approval import CommandSettings, save_command_settings
from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.model import ModelSettings
from backend.app.services import ChatCancellationToken, ChatRequest, ChatService
from backend.app.services.chat_service import _chat_turn_error
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)
from backend.app.tools import FunctionTool, ToolRegistry
from backend.app.tools.factory import create_default_tool_registry


class RecordingChatAdapter:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        self.sent.append({"session_id": session_id, "action": action, "data": data})
        return True


class ToolFriendlyFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: list[Any], *, tool_choice: Any = None, **kwargs: Any) -> Any:
        return self


def test_chat_turn_error_classifies_httpx_read_timeout() -> None:
    code, message, details = _chat_turn_error(httpx.ReadTimeout(""))

    assert code == "llm_read_timeout"
    assert message == "模型响应超时，未收到后续响应数据"
    assert details["exception_type"] == "httpx.ReadTimeout"


def test_chat_turn_error_keeps_empty_runtime_error_generic() -> None:
    code, message, details = _chat_turn_error(RuntimeError())

    assert code == "runtime_error"
    assert message == "运行失败：RuntimeError"
    assert details["exception_type"] == "builtins.RuntimeError"


class FakeAgentFactory(AgentFactory):
    def __init__(self, model: ToolFriendlyFakeModel) -> None:
        super().__init__()
        self.model = model
        self.requested_models: list[str] = []
        self.created_tool_counts: list[int] = []
        self.created_tool_names: list[list[str]] = []
        self.system_prompts: list[str] = []

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

    def create_agent(
        self,
        *,
        model: Any,
        tools: list[Any],
        system_prompt: Any,
        checkpointer: Any,
        middleware: tuple[Any, ...] = (),
        state_schema: type[Any] | None = None,
        name: str = "desktop_agent",
    ) -> Any:
        self.created_tool_counts.append(len(tools))
        self.created_tool_names.append([str(getattr(tool, "name", "")) for tool in tools])
        self.system_prompts.append(str(getattr(system_prompt, "content", system_prompt) or ""))
        return super().create_agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            checkpointer=checkpointer,
            middleware=middleware,
            state_schema=state_schema,
            name=name,
        )


class ToolLimitFailingAgent:
    async def astream_events(self, *_args, **_kwargs):
        if False:
            yield {}
        raise ToolCallLimitExceededError(max_tool_calls=1, attempted_count=2)


class ToolLimitFailingRunner:
    def create_agent(self, **_kwargs) -> ToolLimitFailingAgent:
        return ToolLimitFailingAgent()


class CancellableStreamingAgent:
    def __init__(self, user_message: str) -> None:
        self.stream_started = asyncio.Event()
        self.state_messages: list[Any] = [HumanMessage(content=user_message)]
        self.updated_messages: list[Any] = []

    async def astream_events(self, *_args: Any, **_kwargs: Any):
        self.stream_started.set()
        yield {
            "event": "on_chat_model_stream",
            "run_id": "run_cancel",
            "data": {"chunk": AIMessageChunk(content="半截")},
        }
        await asyncio.Event().wait()

    async def aget_state(self, _config: dict[str, Any]) -> Any:
        return SimpleNamespace(values={"messages": list(self.state_messages)})

    async def aupdate_state(self, _config: dict[str, Any], update: dict[str, Any]) -> None:
        self.updated_messages = [
            message
            for message in update.get("messages", [])
            if getattr(message, "type", "") != "remove"
        ]
        self.state_messages = list(self.updated_messages)


class CancellableStreamingRunner:
    def __init__(self, agent: CancellableStreamingAgent) -> None:
        self.agent = agent

    def create_agent(self, **_kwargs: Any) -> CancellableStreamingAgent:
        return self.agent

    async def get_latest_checkpoint_config(
        self,
        *,
        thread_id: str,
        checkpoint_ns: str = "",
    ) -> dict[str, str | None]:
        return {
            "checkpoint_id": "ckpt_cancelled" if self.agent.updated_messages else None,
            "checkpoint_ns": checkpoint_ns,
        }


class SingleResponseAgent:
    async def astream_events(self, *_args: Any, **_kwargs: Any):
        yield {
            "event": "on_chat_model_end",
            "run_id": "run_single_response",
            "data": {"output": AIMessage(content="完成")},
        }


class BlockingAssemblyRunner:
    def __init__(self, delay_seconds: float = 0.3) -> None:
        self.delay_seconds = delay_seconds
        self.started = threading.Event()
        self.finished = threading.Event()

    def create_agent(self, **_kwargs: Any) -> SingleResponseAgent:
        self.started.set()
        time.sleep(self.delay_seconds)
        self.finished.set()
        return SingleResponseAgent()

    async def get_latest_checkpoint_config(
        self,
        *,
        thread_id: str,
        checkpoint_ns: str = "",
    ) -> dict[str, str | None]:
        return {"checkpoint_id": None, "checkpoint_ns": checkpoint_ns}


def _service(
    tmp_path: Path,
    model: ToolFriendlyFakeModel,
    registry: ToolRegistry | None = None,
    configure_provider: bool = True,
) -> tuple[ChatService, StorageRepositories, SQLiteCheckpointSaver, FakeAgentFactory]:
    database = init_database(tmp_path / "app.db")
    repositories = StorageRepositories(database)
    if configure_provider:
        now = to_iso_z(utc_now())
        provider = ModelProviderRecord(
            id="provider-1",
            name="测试模型服务",
            base_url="http://model.test/v1",
            api_key="test-key",
            enabled=True,
            models=["qwen-coder", "qwen3-coder", "fake-default"],
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
        tool_registry=registry or ToolRegistry(),
        default_system_prompt="系统提示",
        factory=factory,
    )
    return (
        ChatService(settings=settings, repositories=repositories, agent_runner=runner),
        repositories,
        checkpointer,
        factory,
    )


def _write_workspace_skill(
    workspace: Path,
    name: str = "dev-plan",
    description: str = "Build a structured development plan.",
    body: str = "Skill body marker.",
) -> None:
    skill_dir = workspace / ".keydex" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                f"description: {description}",
                "---",
                "",
                f"# {name}",
                body,
            ]
        ),
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_chat_service_uses_langchain_agent_and_persists_history(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="你好")])
    service, repositories, _checkpointer, factory = _service(tmp_path, model)
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="你好", provider_id="provider-1", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert result.final_content == "你好"
    assert factory.requested_models == ["qwen-coder"]
    assert [item["action"] for item in chat_adapter.sent] == ["stream", "completed"]
    history = service.message_event_service.get_display_messages(result.session_id)
    assert [message["role"] for message in history] == ["user", "assistant"]
    assert history[-1]["content"] == "你好"
    trace = repositories.trace_records.get(result.trace_id)
    assert trace.status == "completed"
    assert trace.output_checkpoint_id
    session = repositories.sessions.get(result.session_id)
    assert session.current_model_provider_id == "provider-1"
    assert session.current_model == "qwen-coder"


@pytest.mark.asyncio
async def test_chat_service_agent_assembly_does_not_block_event_loop(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, _repositories, _checkpointer, _factory = _service(tmp_path, model)
    runner = BlockingAssemblyRunner(delay_seconds=0.5)
    service.agent_runner = runner  # type: ignore[assignment]
    chat_adapter = RecordingChatAdapter()

    started_at = time.perf_counter()
    task = asyncio.create_task(
        service.handle_chat(
            ChatRequest(message="测试冷启动", provider_id="provider-1", model="qwen-coder"),
            chat_adapter=chat_adapter,
        )
    )

    await asyncio.sleep(0.05)
    elapsed = time.perf_counter() - started_at

    assert elapsed < 0.35
    assert runner.started.is_set()
    assert not runner.finished.is_set()

    result = await task

    assert result.status == "completed"
    assert result.final_content == "完成"


@pytest.mark.asyncio
async def test_chat_service_projects_tool_call_limit_as_turn_failure(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不会输出")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    service.agent_runner = ToolLimitFailingRunner()
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="请连续调用工具", provider_id="provider-1", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "failed"
    assert result.error == "本轮工具调用已达到上限 1 次，已阻止第 2 次工具调用"
    assert repositories.sessions.get(result.session_id).status == "failed"
    error_events = [item for item in chat_adapter.sent if item["action"] == "error"]
    assert error_events
    assert error_events[-1]["data"]["code"] == "tool_call_limit_exceeded"
    assert error_events[-1]["data"]["message"] == result.error
    assert error_events[-1]["data"]["details"] == {
        "max_tool_calls": 1,
        "attempted_count": 2,
    }


@pytest.mark.asyncio
async def test_chat_service_uses_checkpoint_as_model_context(tmp_path) -> None:
    model = ToolFriendlyFakeModel(
        responses=[
            AIMessage(content="第一轮回答"),
            AIMessage(content="第二轮回答"),
        ]
    )
    service, _repositories, checkpointer, _factory = _service(tmp_path, model)

    first = await service.handle_chat(
        ChatRequest(message="第一轮", provider_id="provider-1", model="qwen-coder")
    )
    second = await service.handle_chat(
        ChatRequest(
            session_id=first.session_id,
            message="第二轮",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert first.turn_index == 1
    assert second.turn_index == 2
    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": first.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.type for message in messages] == ["human", "ai", "human", "ai"]
    assert [message.content for message in messages] == [
        "第一轮",
        "第一轮回答",
        "第二轮",
        "第二轮回答",
    ]


@pytest.mark.asyncio
async def test_chat_service_injects_follow_messages_and_restores_context_items(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已参考")])
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
                    },
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "用户添加了以下引用片段作为上下文：\n关键片段",
                        "metadata": {
                            "id": "quote:1",
                            "kind": "quote",
                            "label": "引用片段",
                            "preview": "关键片段",
                        },
                    },
                ]
            },
        )
    )

    history = service.message_event_service.get_display_messages(result.session_id)
    assert [message["role"] for message in history] == ["user", "assistant"]
    assert history[0]["content"] == "总结一下"
    assert history[0]["contextItems"][0]["type"] == "file"
    assert history[0]["contextItems"][0]["path"] == "README.md"
    assert history[0]["contextItems"][1]["type"] == "quote"
    assert "关键片段" in history[0]["contextItems"][1]["content"]

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": result.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.content for message in messages[:3]] == [
        "用户通过 @ 引用了工作区文件：README.md",
        "用户添加了以下引用片段作为上下文：\n关键片段",
        "总结一下",
    ]


@pytest.mark.asyncio
async def test_chat_service_routes_langchain_tool_events(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="read_file",
            description="读取文件",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=lambda args, context: {
                "content": f"文件内容:{args['path']}",
                "root": str(context.workspace_root),
            },
        )
    )
    model = ToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "read_file",
                        "args": {"path": "a.txt"},
                        "id": "call_read",
                    }
                ],
            ),
            AIMessage(content="已读取"),
        ]
    )
    service, repositories, _checkpointer, _factory = _service(tmp_path, model, registry)
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id, message="读文件", provider_id="provider-1", model="qwen-coder"
        ),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert [item["action"] for item in chat_adapter.sent] == [
        "tool_start",
        "tool_end",
        "stream",
        "completed",
    ]
    assert chat_adapter.sent[0]["data"]["tool"] == "read_file"
    assert chat_adapter.sent[1]["data"]["status"] == "completed"
    assert "文件内容:a.txt" in chat_adapter.sent[1]["data"]["result"]
    tool_result = json.loads(chat_adapter.sent[1]["data"]["result"])
    assert tool_result["root"] == str(project.resolve())
    history = service.message_event_service.get_display_messages(result.session_id)
    assert [message["role"] for message in history] == ["user", "tool", "assistant"]
    assert history[1]["toolName"] == "read_file"
    assert history[2]["content"] == "已读取"


@pytest.mark.parametrize(
    ("tool_name", "tool_args"),
    [
        ("read_file", {"path": "README.md"}),
        ("list_dir", {"path": "."}),
        ("search_text", {"query": "README", "path": "."}),
        ("search_files", {"query": "README", "path": "."}),
        ("grep_files", {"query": "README", "regex": False, "path": "."}),
        ("create_file", {"path": "test.txt", "content": "hello"}),
        (
            "edit_file",
            {
                "patch": (
                    "*** Begin Patch\n"
                    "*** Update File: README.md\n"
                    "@@\n"
                    "-old\n"
                    "+new\n"
                    "*** End Patch"
                )
            },
        ),
    ],
)
@pytest.mark.asyncio
async def test_file_access_blocked_tools_emit_failed_tool_events(
    tmp_path,
    tool_name: str,
    tool_args: dict[str, Any],
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "README.md").write_text("old\n", encoding="utf-8")
    model = ToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": tool_name,
                        "args": tool_args,
                        "id": f"call_{tool_name}",
                    }
                ],
            ),
            AIMessage(content="工具失败已处理"),
        ]
    )
    service, repositories, _checkpointer, _factory = _service(
        tmp_path,
        model,
        create_default_tool_registry(),
    )
    save_command_settings(
        repositories,
        CommandSettings(file_access_mode="no_file_access"),
    )
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id=f"ses_{tool_name}",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message=f"调用 {tool_name}",
            provider_id="provider-1",
            model="qwen-coder",
        ),
        chat_adapter=chat_adapter,
    )

    tool_events = [
        item
        for item in chat_adapter.sent
        if item["action"] in {"tool_start", "tool_end"}
    ]
    assert [item["action"] for item in tool_events] == ["tool_start", "tool_end"]
    assert tool_events[0]["data"]["tool"] == tool_name
    assert tool_events[1]["data"]["tool"] == tool_name
    assert tool_events[1]["data"]["status"] == "failed"
    assert "file_access_disabled" in tool_events[1]["data"]["result"]
    assert result.status == "completed"

    history = service.message_event_service.get_display_messages(result.session_id)
    tool_messages = [message for message in history if message["role"] == "tool"]
    assert len(tool_messages) == 1
    assert tool_messages[0]["toolName"] == tool_name
    assert tool_messages[0]["status"] == "error"
    assert "文件访问权限已关闭" in str(tool_messages[0].get("toolError") or "")


@pytest.mark.asyncio
async def test_file_access_blocked_sequential_tools_each_emit_failed_events(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "README.md").write_text("old\n", encoding="utf-8")
    model = ToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "search_files",
                        "args": {"query": "README", "path": "."},
                        "id": "call_search_files",
                    }
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "create_file",
                        "args": {"path": "test.txt", "content": "hello"},
                        "id": "call_create_file",
                    }
                ],
            ),
            AIMessage(content="工具失败已处理"),
        ]
    )
    service, repositories, _checkpointer, _factory = _service(
        tmp_path,
        model,
        create_default_tool_registry(),
    )
    save_command_settings(
        repositories,
        CommandSettings(file_access_mode="no_file_access"),
    )
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_blocked_sequential_file_tools",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="连续调用 search_files 和 create_file",
            provider_id="provider-1",
            model="qwen-coder",
        ),
        chat_adapter=chat_adapter,
    )

    tool_events = [
        item
        for item in chat_adapter.sent
        if item["action"] in {"tool_start", "tool_end"}
    ]
    assert [item["action"] for item in tool_events] == [
        "tool_start",
        "tool_end",
        "tool_start",
        "tool_end",
    ]
    assert [item["data"]["tool"] for item in tool_events] == [
        "search_files",
        "search_files",
        "create_file",
        "create_file",
    ]
    assert [
        tool_events[1]["data"]["status"],
        tool_events[3]["data"]["status"],
    ] == ["failed", "failed"]
    assert "file_access_disabled" in tool_events[1]["data"]["result"]
    assert "file_access_disabled" in tool_events[3]["data"]["result"]
    assert result.status == "completed"

    history = service.message_event_service.get_display_messages(result.session_id)
    tool_messages = [message for message in history if message["role"] == "tool"]
    assert [message["toolName"] for message in tool_messages] == ["search_files", "create_file"]
    assert [message["status"] for message in tool_messages] == ["error", "error"]


@pytest.mark.asyncio
async def test_chat_service_runs_skill_activation_chain_with_message_injection(
    tmp_path,
) -> None:
    project = tmp_path / "project"
    _write_workspace_skill(project, body="Use the project planning workflow.")
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已按 Skill 处理")])
    service, repositories, checkpointer, factory = _service(tmp_path, model)
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="拆成开发 issues",
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={
                "skill_activation": {
                    "skill_name": "dev-plan",
                    "origin": "slash",
                },
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "用户通过 @ 引用了工作区文件：DES.md",
                        "metadata": {
                            "id": "file:des",
                            "kind": "file",
                            "label": "DES.md",
                            "path": "DES.md",
                        },
                    }
                ],
            },
        ),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert factory.requested_models == ["qwen-coder"]
    assert factory.created_tool_names == [["load_skill"]]
    assert "<keydex_skills>" in factory.system_prompts[0]
    assert 'load_skill(skill_name="dev-plan")' in factory.system_prompts[0]
    assert "Use the project planning workflow." not in factory.system_prompts[0]

    actions = [item["action"] for item in chat_adapter.sent]
    assert actions == ["system_message", "tool_start", "tool_end", "stream", "completed"]
    assert chat_adapter.sent[0]["data"]["content"] == "Build a structured development plan."
    assert chat_adapter.sent[1]["data"]["tool"] == "load_skill"
    tool_result = json.loads(chat_adapter.sent[2]["data"]["result"])
    assert tool_result["skill_name"] == "dev-plan"
    assert tool_result["found"] is True
    assert tool_result["loaded"] is True
    assert tool_result["injected"] is True

    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert any(
        message.type == "system" and "Use the project planning workflow." in message.content
        for message in messages
    )

    history = service.message_event_service.get_display_messages(result.session_id)
    assert [message["role"] for message in history] == ["user", "tool", "assistant"]
    assert history[0]["content"] == "拆成开发 issues"
    assert history[0]["contextItems"][0]["type"] == "file"
    assert history[0]["contextItems"][0]["path"] == "DES.md"
    assert history[0]["contextItems"][1]["type"] == "skill"
    assert history[0]["contextItems"][1]["skill_name"] == "dev-plan"
    assert history[0]["contextItems"][1]["description"] == "Build a structured development plan."
    assert "Use the project planning workflow." not in str(history[0]["contextItems"])
    assert history[1]["toolName"] == "load_skill"
    assert history[2]["content"] == "已按 Skill 处理"


@pytest.mark.asyncio
async def test_chat_service_disables_project_tools_for_chat_session(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="read_file",
            description="读取文件",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=lambda args, context: {"content": "不应执行"},
        )
    )
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="普通回复")])
    service, _repositories, _checkpointer, factory = _service(tmp_path, model, registry)
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="只聊天", provider_id="provider-1", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert factory.created_tool_counts == [0]
    assert [item["action"] for item in chat_adapter.sent] == ["stream", "completed"]


@pytest.mark.asyncio
async def test_chat_service_fails_loudly_when_request_omits_model_selection(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, factory = _service(tmp_path, model)
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="你好"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "failed"
    assert result.error == "对话模型必须显式指定供应商和模型"
    assert factory.requested_models == []
    assert chat_adapter.sent[-1]["action"] == "error"
    assert chat_adapter.sent[-1]["data"]["message"] == "对话模型必须显式指定供应商和模型"
    assert chat_adapter.sent[-1]["data"]["code"] == "chat_model_required"
    assert repositories.sessions.get(result.session_id).status == "failed"


@pytest.mark.asyncio
async def test_chat_service_fails_loudly_when_provider_is_missing(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, factory = _service(
        tmp_path, model, configure_provider=False
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="你好", provider_id="provider-1", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "failed"
    assert result.error == "对话模型供应商不存在"
    assert factory.requested_models == []
    assert chat_adapter.sent[-1]["action"] == "error"
    assert chat_adapter.sent[-1]["data"]["message"] == "对话模型供应商不存在"
    assert chat_adapter.sent[-1]["data"]["code"] == "chat_model_provider_not_found"
    assert repositories.sessions.get(result.session_id).status == "failed"


@pytest.mark.asyncio
async def test_chat_service_converts_task_cancel_to_cancelled_turn(tmp_path, monkeypatch) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    chat_adapter = RecordingChatAdapter()

    async def raise_cancelled(**_kwargs: Any):
        raise asyncio.CancelledError

    monkeypatch.setattr(service, "_run_agent_loop", raise_cancelled)

    result = await service.handle_chat(
        ChatRequest(message="取消这轮", provider_id="provider-1", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "cancelled"
    assert chat_adapter.sent[-1]["action"] == "cancelled"
    assert repositories.trace_records.get(result.trace_id).status == "cancelled"
    assert repositories.sessions.get(result.session_id).status == "active"


@pytest.mark.asyncio
async def test_chat_service_patches_cancelled_partial_output_into_checkpoint(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    agent = CancellableStreamingAgent("取消这轮")
    service.agent_runner = CancellableStreamingRunner(agent)  # type: ignore[assignment]
    chat_adapter = RecordingChatAdapter()
    cancellation = ChatCancellationToken()

    task = asyncio.create_task(
        service.handle_chat(
            ChatRequest(
                message="取消这轮",
                provider_id="provider-1",
                model="qwen-coder",
            ),
            chat_adapter=chat_adapter,
            cancellation=cancellation,
        )
    )
    await asyncio.wait_for(agent.stream_started.wait(), timeout=1)
    for _ in range(50):
        if any(item["action"] == "stream" for item in chat_adapter.sent):
            break
        await asyncio.sleep(0.01)

    cancellation.cancel()
    task.cancel()
    result = await asyncio.wait_for(task, timeout=1)

    assert result.status == "cancelled"
    assert [item["action"] for item in chat_adapter.sent] == ["stream", "cancelled"]
    assert chat_adapter.sent[0]["data"]["content"] == "半截"
    assert [message.type for message in agent.updated_messages] == ["human", "ai"]
    assert [message.content for message in agent.updated_messages] == [
        "取消这轮",
        "半截\n\n[用户在此处取消]",
    ]
    trace = repositories.trace_records.get(result.trace_id)
    assert trace.status == "cancelled"
    assert trace.output_checkpoint_id == "ckpt_cancelled"


@pytest.mark.asyncio
async def test_chat_service_closes_pending_tool_call_when_cancelled(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    agent = CancellableStreamingAgent("终止命令")
    agent.state_messages = [
        HumanMessage(content="终止命令"),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "run_cmd",
                    "args": {"command": "ping 127.0.0.1"},
                    "id": "call_command",
                }
            ],
        ),
    ]
    service.agent_runner = CancellableStreamingRunner(agent)  # type: ignore[assignment]
    chat_adapter = RecordingChatAdapter()
    cancellation = ChatCancellationToken()

    task = asyncio.create_task(
        service.handle_chat(
            ChatRequest(
                message="终止命令",
                provider_id="provider-1",
                model="qwen-coder",
            ),
            chat_adapter=chat_adapter,
            cancellation=cancellation,
        )
    )
    await asyncio.wait_for(agent.stream_started.wait(), timeout=1)
    for _ in range(50):
        if any(item["action"] == "stream" for item in chat_adapter.sent):
            break
        await asyncio.sleep(0.01)

    cancellation.cancel()
    task.cancel()
    result = await asyncio.wait_for(task, timeout=1)

    assert result.status == "cancelled"
    assert [message.type for message in agent.updated_messages] == ["human", "ai", "tool", "ai"]
    assert [message.content for message in agent.updated_messages if message.type == "human"] == [
        "终止命令"
    ]
    tool_message = agent.updated_messages[2]
    assert isinstance(tool_message, ToolMessage)
    assert tool_message.tool_call_id == "call_command"
    assert json.loads(str(tool_message.content)) == {
        "status": "cancelled",
        "message": "用户终止了该工具调用，本轮对话已取消。",
        "tool": "run_cmd",
    }
    assert agent.updated_messages[3].content == "半截\n\n[用户在此处取消]"
