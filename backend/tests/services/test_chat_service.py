from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_openai.chat_models._client_utils import StreamChunkTimeoutError
from pydantic import Field

from backend.app.agent import AgentRunner
from backend.app.agent.factory import AgentFactory
from backend.app.agent.state import build_checkpoint_state_graph
from backend.app.command_approval import CommandSettings, save_command_settings
from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.keydex import KeydexCapabilityRuntimeCache
from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CONTEXT_PROTOCOL,
)
from backend.app.keydex.capabilities.skills import SkillsCapability
from backend.app.keydex.registry import KeydexCapabilityRegistry
from backend.app.mcp.tools import (
    MCP_CAPABILITY_DISCOVERY_TOOL_NAME,
    mcp_capability_discovery_tools_from_snapshot,
)
from backend.app.model import ModelSettings
from backend.app.services import ChatCancellationToken, ChatRequest, ChatService
from backend.app.services.archive_lifecycle_service import ArchiveLifecycleError
from backend.app.services.chat_service import _chat_error_retryable, _chat_turn_error
from backend.app.services.session_fork_service import SessionForkService
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)
from backend.app.subagents.models import SubagentRunSnapshot
from backend.app.tools import FunctionTool, ToolExecutionContext, ToolRegistry
from backend.app.tools.factory import create_default_tool_registry
from backend.tests.async_checkpoint import TestAsyncCheckpointStore


class RecordingChatAdapter:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        self.sent.append({"session_id": session_id, "action": action, "data": data})
        return True


class ToolFriendlyFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: list[Any], *, tool_choice: Any = None, **kwargs: Any) -> Any:
        return self


class RecordingToolFriendlyFakeModel(ToolFriendlyFakeModel):
    recorded_messages: list[list[Any]] = Field(default_factory=list)

    def _generate(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        self.recorded_messages.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def test_chat_turn_error_classifies_httpx_read_timeout() -> None:
    code, message, details = _chat_turn_error(httpx.ReadTimeout(""))

    assert code == "llm_read_timeout"
    assert message == "模型响应超时，未收到后续响应数据"
    assert details["exception_type"] == "httpx.ReadTimeout"


def test_chat_turn_error_classifies_stream_chunk_timeout() -> None:
    code, message, details = _chat_turn_error(
        StreamChunkTimeoutError(120.0, model_name="slow-model", chunks_received=0)
    )

    assert code == "llm_stream_chunk_timeout"
    assert message == "模型响应超时，未收到后续响应数据"
    assert details["exception_type"].endswith(".StreamChunkTimeoutError")
    assert details["timeout_seconds"] == 120.0
    assert details["chunks_received"] == 0
    assert details["model"] == "slow-model"


def test_chat_turn_error_keeps_empty_runtime_error_generic() -> None:
    code, message, details = _chat_turn_error(RuntimeError())

    assert code == "runtime_error"
    assert message == "运行失败：RuntimeError"
    assert details["exception_type"] == "builtins.RuntimeError"


def test_chat_turn_error_keeps_safe_provider_bad_request_details() -> None:
    request = httpx.Request("POST", "https://provider.example/v1/chat/completions")
    response = httpx.Response(
        400,
        request=request,
        headers={"x-request-id": "req_anti_probe_123"},
    )
    error = openai.BadRequestError(
        "provider rejected request",
        response=response,
        body={
            "error": {
                "code": "content_anti_probe_blocking",
                "message": "短消息命中测活探针关键词",
                "type": "invalid_request_error",
                "param": None,
            }
        },
    )

    code, message, details = _chat_turn_error(error)

    assert code == "llm_bad_request"
    assert message == "模型请求参数无效"
    assert details["status_code"] == 400
    assert details["provider"] == {
        "code": "content_anti_probe_blocking",
        "message": "短消息命中测活探针关键词",
        "type": "invalid_request_error",
        "param": None,
        "request_id": "req_anti_probe_123",
    }
    assert "raw_message" not in details


def test_chat_turn_error_redacts_provider_secrets() -> None:
    request = httpx.Request("POST", "https://provider.example/v1/chat/completions")
    response = httpx.Response(429, request=request)
    error = openai.RateLimitError(
        "rate limited",
        response=response,
        body={
            "code": "rate_limit",
            "message": "authorization=Bearer should-not-leak",
        },
    )

    code, _, details = _chat_turn_error(error)

    assert code == "llm_rate_limited"
    assert "should-not-leak" not in str(details)
    assert "***REDACTED***" in details["provider"]["message"]


@pytest.mark.parametrize(
    ("error_type", "status", "expected_code", "expected_message", "retryable"),
    [
        (
            openai.AuthenticationError,
            401,
            "llm_authentication_failed",
            "模型服务认证失败，请检查供应商配置",
            False,
        ),
        (
            openai.PermissionDeniedError,
            403,
            "llm_permission_denied",
            "模型服务拒绝访问，请检查账号权限或模型权限",
            False,
        ),
        (
            openai.RateLimitError,
            429,
            "llm_rate_limited",
            "模型服务请求过于频繁",
            True,
        ),
        (
            openai.InternalServerError,
            500,
            "llm_server_error",
            "模型服务返回内部错误",
            True,
        ),
        (
            openai.InternalServerError,
            503,
            "llm_upstream_unavailable",
            "模型服务暂时不可用",
            True,
        ),
    ],
)


def test_chat_turn_error_classifies_provider_status_matrix(
    error_type: type[openai.APIStatusError],
    status: int,
    expected_code: str,
    expected_message: str,
    retryable: bool,
) -> None:
    request = httpx.Request("POST", "https://provider.example/v1/chat/completions")
    response = httpx.Response(status, request=request, headers={"x-request-id": f"req_{status}"})
    error = error_type(
        "provider request failed",
        response=response,
        body={"error": {"code": f"provider_{status}", "message": f"safe failure {status}"}},
    )

    code, message, details = _chat_turn_error(error)

    assert code == expected_code
    assert message == expected_message
    assert _chat_error_retryable(code) is retryable
    assert details["status_code"] == status
    assert details["provider"] == {
        "code": f"provider_{status}",
        "message": f"safe failure {status}",
        "request_id": f"req_{status}",
    }


@pytest.mark.parametrize(
    ("error", "expected_code", "expected_message"),
    [
        (
            openai.APITimeoutError(httpx.Request("POST", "https://provider.example")),
            "llm_request_timeout",
            "模型请求超时，未收到模型服务响应",
        ),
        (
            openai.APIConnectionError(
                request=httpx.Request("POST", "https://provider.example")
            ),
            "llm_connection_error",
            "模型服务连接失败",
        ),
        (
            httpx.ConnectError(
                "connection refused",
                request=httpx.Request("POST", "https://provider.example"),
            ),
            "llm_connection_error",
            "模型服务连接失败",
        ),
    ],
)
def test_chat_turn_error_classifies_timeout_and_connection_matrix(
    error: Exception,
    expected_code: str,
    expected_message: str,
) -> None:
    code, message, details = _chat_turn_error(error)

    assert code == expected_code
    assert message == expected_message
    assert _chat_error_retryable(code) is True
    assert details["exception_type"]


class FakeAgentFactory(AgentFactory):
    def __init__(self, model: ToolFriendlyFakeModel) -> None:
        super().__init__()
        self.model = model
        self.requested_models: list[str] = []
        self.created_tool_counts: list[int] = []
        self.created_tool_names: list[list[str]] = []
        self.created_tool_descriptions: list[dict[str, str]] = []
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
        self.created_tool_descriptions.append(
            {
                str(getattr(tool, "name", "")): str(getattr(tool, "description", "") or "")
                for tool in tools
            }
        )
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


class FakeMcpManager:
    async def execute_tool(self, **_kwargs: Any) -> Any:
        return {"ok": True}


def _service(
    tmp_path: Path,
    model: ToolFriendlyFakeModel,
    registry: ToolRegistry | None = None,
    configure_provider: bool = True,
    settings: AppSettings | None = None,
    mcp_manager: Any | None = None,
) -> tuple[
    ChatService,
    StorageRepositories,
    TestAsyncCheckpointStore,
    FakeAgentFactory,
]:
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
    settings = settings or AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path)
    checkpointer = TestAsyncCheckpointStore(database.path)
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
        ChatService(
            settings=settings,
            repositories=repositories,
            agent_runner=runner,
            keydex_runtime_cache=KeydexCapabilityRuntimeCache(
                system_root=tmp_path / "system-keydex",
                builtin_root=tmp_path / "builtin-keydex",
            ),
            mcp_manager=mcp_manager,
        ),
        repositories,
        checkpointer,
        factory,
    )


def test_chat_session_guard_rejects_send_after_archive(tmp_path) -> None:
    service, repositories, _checkpointer, _factory = _service(
        tmp_path,
        ToolFriendlyFakeModel(responses=[AIMessage(content="unused")]),
    )
    session = repositories.sessions.create(
        session_id="session-archived-send",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.sessions.archive_manual(
        session.id,
        archived_at="2026-07-14T00:00:00Z",
    )

    with pytest.raises(ArchiveLifecycleError) as archived:
        service._ensure_session(
            ChatRequest(
                session_id=session.id,
                message="should not send",
                provider_id="provider-1",
                model="qwen-coder",
            )
        )

    assert archived.value.code == "entity_archived"
    assert repositories.sessions.get_archived(session.id) is not None


def _configure_mcp_tool(
    repositories: StorageRepositories,
    *,
    raw_names: tuple[str, ...] = ("search",),
) -> None:
    repositories.mcp_servers.create(
        server_id="srv_chat_mcp",
        name="Chat MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    repositories.mcp_server_status.upsert("srv_chat_mcp", status="online")
    repositories.mcp_tools.upsert_many(
        "srv_chat_mcp",
        [
            {
                "raw_name": raw_name,
                "model_name": f"mcp__srv_chat_mcp__{raw_name}",
                "callable_namespace": "mcp__srv_chat_mcp",
                "callable_name": raw_name,
                "description": f"{raw_name} MCP data",
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                "schema_hash": f"hash-{raw_name}",
            }
            for raw_name in raw_names
        ],
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
    assert [
        item["action"]
        for item in chat_adapter.sent
        if item["action"] not in {"turn_started", "middleware_progress"}
    ] == ["stream", "completed"]
    history = service.message_event_service.get_display_messages(result.session_id)
    visible_history = [message for message in history if message["role"] != "turn"]
    assert [message["role"] for message in visible_history] == ["user", "assistant"]
    assert visible_history[-1]["content"] == "你好"
    trace = repositories.trace_records.get(result.trace_id)
    assert trace.status == "completed"
    assert trace.output_checkpoint_id
    session = repositories.sessions.get(result.session_id)
    assert session.current_model_provider_id == "provider-1"
    assert session.current_model == "qwen-coder"


@pytest.mark.asyncio
async def test_chat_trace_records_generic_capability_fingerprints_without_content(
    tmp_path: Path,
) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="ok")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    system_root = tmp_path / "generic-system"
    skill_root = system_root / "skills" / "private-skill"
    skill_root.mkdir(parents=True)
    private_marker = "PRIVATE SKILL BODY MUST NOT ENTER TRACE METADATA"
    (skill_root / "SKILL.md").write_text(
        "---\nname: private-skill\ndescription: private\n---\n\n" + private_marker,
        encoding="utf-8",
    )
    service.keydex_runtime_cache = KeydexCapabilityRuntimeCache(
        system_root=system_root,
        registry=KeydexCapabilityRegistry((SkillsCapability(),)),
    )

    result = await service.handle_chat(
        ChatRequest(message="hello", provider_id="provider-1", model="qwen-coder")
    )

    metadata = repositories.trace_records.get(result.trace_id).metadata
    assert metadata["keydex"]["mode"] == "system_only"
    assert metadata["keydex"]["runtime_revision"] == "2"
    assert metadata["keydex"]["scopes"] == ["builtin", "system"]
    fingerprints = metadata["keydex"]["capability_fingerprints"]
    assert set(fingerprints) == {"skills"}
    assert len(fingerprints["skills"]) == 64
    assert private_marker not in json.dumps(metadata, ensure_ascii=False)


def _keydex_context_messages(messages: list[Any]) -> list[HumanMessage]:
    return [
        message
        for message in messages
        if isinstance(message, HumanMessage)
        and message.additional_kwargs.get("protocol") == KEYDEX_MARKDOWN_CONTEXT_PROTOCOL
    ]


@pytest.mark.asyncio
async def test_chat_service_injects_system_keydex_markdown_without_persisting_it(
    tmp_path: Path,
) -> None:
    model = RecordingToolFriendlyFakeModel(responses=[AIMessage(content="system applied")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    (system_root / "keydex.md").write_text("SYSTEM-GUIDANCE", encoding="utf-8")
    service.keydex_runtime_cache = KeydexCapabilityRuntimeCache(
        system_root=system_root,
        builtin_root=tmp_path / "builtin",
    )

    result = await service.handle_chat(
        ChatRequest(message="real request", provider_id="provider-1", model="qwen-coder")
    )

    assert result.status == "completed"
    assert len(model.recorded_messages) == 1
    contexts = _keydex_context_messages(model.recorded_messages[0])
    assert len(contexts) == 1
    assert "SYSTEM-GUIDANCE" in str(contexts[0].content)
    assert contexts[0].additional_kwargs["scopes"] == ["system"]
    real_users = [
        item
        for item in model.recorded_messages[0]
        if isinstance(item, HumanMessage) and item not in contexts
    ]
    assert real_users[-1].content == "real request"
    history = service.message_event_service.get_display_messages(result.session_id)
    assert "<keydex-instructions>" not in json.dumps(history, ensure_ascii=False)
    assert [item["role"] for item in history if item.get("role") != "turn"] == ["user", "assistant"]
    trace = repositories.trace_records.get(result.trace_id)
    assert set(trace.metadata["keydex"]["capability_fingerprints"]) == {
        "skills",
        "keydex_markdown",
    }
    trace_payload = json.dumps(trace.metadata, ensure_ascii=False)
    assert "SYSTEM-GUIDANCE" not in trace_payload
    assert str(system_root) not in trace_payload


@pytest.mark.asyncio
async def test_workspace_chat_injects_system_then_bound_workspace_only(
    tmp_path: Path,
) -> None:
    model = RecordingToolFriendlyFakeModel(responses=[AIMessage(content="workspace applied")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    (system_root / "keydex.md").write_text("SYSTEM-MARKER", encoding="utf-8")
    project = tmp_path / "project-a"
    project_keydex = project / ".keydex"
    project_keydex.mkdir(parents=True)
    (project_keydex / "keydex.md").write_text("PROJECT-A-MARKER", encoding="utf-8")
    other_project = tmp_path / "project-b"
    other_keydex = other_project / ".keydex"
    other_keydex.mkdir(parents=True)
    (other_keydex / "keydex.md").write_text("PROJECT-B-SECRET", encoding="utf-8")
    service.keydex_runtime_cache = KeydexCapabilityRuntimeCache(
        system_root=system_root,
        builtin_root=tmp_path / "builtin",
    )
    workspace = repositories.workspaces.create(workspace_id="ws-a", root_path=project)
    session = repositories.sessions.create(
        session_id="ses-a",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="project request",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    context = _keydex_context_messages(model.recorded_messages[0])[0]
    rendered = str(context.content)
    assert rendered.index("SYSTEM-MARKER") < rendered.index("PROJECT-A-MARKER")
    assert "PROJECT-B-SECRET" not in rendered
    assert context.additional_kwargs["scopes"] == ["system", "workspace"]


@pytest.mark.asyncio
async def test_km25_km29_km30_markdown_is_pinned_for_tool_loop_and_next_turn(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "system-keydex"
    source_root.mkdir()
    source = source_root / "keydex.md"
    source.write_text("GUIDANCE-V1", encoding="utf-8")
    model = RecordingToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": "replace_guidance", "args": {}, "id": "call_replace"}],
            ),
            AIMessage(content="first turn done"),
            AIMessage(content="second turn done"),
        ]
    )
    registry = ToolRegistry()

    def replace_guidance(
        _args: dict[str, Any],
        _context: ToolExecutionContext,
    ) -> dict[str, bool]:
        source.write_text("GUIDANCE-V2", encoding="utf-8")
        return {"changed": True}

    registry.register(
        FunctionTool(
            name="replace_guidance",
            description="Replace the guidance fixture.",
            parameters={"type": "object", "properties": {}},
            handler=replace_guidance,
        )
    )
    service, repositories, _checkpointer, _factory = _service(
        tmp_path,
        model,
        registry,
    )
    service.keydex_runtime_cache = KeydexCapabilityRuntimeCache(
        system_root=source_root,
        builtin_root=tmp_path / "builtin",
    )
    project = tmp_path / "turn-pinning-project"
    project.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-turn-pinning",
        root_path=project,
    )
    session = repositories.sessions.create(
        session_id="ses-turn-pinning",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    first = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="first turn",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )
    second = await service.handle_chat(
        ChatRequest(
            session_id=first.session_id,
            message="second turn",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert first.status == "completed" and second.status == "completed"
    assert len(model.recorded_messages) == 3
    first_context = str(_keydex_context_messages(model.recorded_messages[0])[0].content)
    tool_followup_context = str(_keydex_context_messages(model.recorded_messages[1])[0].content)
    next_turn_context = str(_keydex_context_messages(model.recorded_messages[2])[0].content)
    assert "GUIDANCE-V1" in first_context
    assert "GUIDANCE-V1" in tool_followup_context
    assert "GUIDANCE-V2" not in tool_followup_context
    assert "GUIDANCE-V2" in next_turn_context


@pytest.mark.asyncio
async def test_ki10_forked_session_resolves_fresh_keydex_snapshot_for_new_turn(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    source = system_root / "keydex.md"
    source.write_text("FORK-GUIDANCE-V1", encoding="utf-8")
    model = RecordingToolFriendlyFakeModel(
        responses=[AIMessage(content="source done"), AIMessage(content="fork done")]
    )
    service, repositories, checkpointer, _factory = _service(tmp_path, model)

    first = await service.handle_chat(
        ChatRequest(
            message="source turn",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )
    source_event_id = next(
        message["messageEventId"]
        for message in reversed(
            service.message_event_service.get_display_messages(first.session_id)
        )
        if message.get("role") == "assistant"
    )
    forked = await SessionForkService(
        repositories,
        checkpointer=checkpointer,
    ).fork_session(
        session_id=first.session_id,
        user_id="local-user",
        message_event_id=source_event_id,
    )
    source.write_text("FORK-GUIDANCE-V2", encoding="utf-8")
    service.keydex_runtime_cache.invalidate_system()

    second = await service.handle_chat(
        ChatRequest(
            session_id=forked.session.id,
            message="fork follow-up",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert first.status == "completed" and second.status == "completed"
    assert len(model.recorded_messages) == 2
    source_context = str(_keydex_context_messages(model.recorded_messages[0])[0].content)
    fork_context = str(_keydex_context_messages(model.recorded_messages[1])[0].content)
    assert "FORK-GUIDANCE-V1" in source_context
    assert "FORK-GUIDANCE-V2" in fork_context
    assert model.recorded_messages[1][-1].content == "fork follow-up"


@pytest.mark.asyncio
async def test_ki11_thread_task_continuation_receives_keydex_and_hidden_input(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    (system_root / "keydex.md").write_text(
        "THREAD-TASK-GUIDANCE",
        encoding="utf-8",
    )
    model = RecordingToolFriendlyFakeModel(responses=[AIMessage(content="thread task done")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    session = repositories.sessions.create(
        session_id="ses-keydex-thread-task",
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
                    "task_id": "task-keydex",
                    "run_id": "run-keydex",
                    "trigger": "task_continue",
                    "type": "goal",
                },
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "hidden thread task input",
                        "hidden_for_transcript": True,
                    }
                ],
            },
        )
    )

    assert result.status == "completed"
    messages = model.recorded_messages[0]
    contexts = _keydex_context_messages(messages)
    assert len(contexts) == 1
    assert "THREAD-TASK-GUIDANCE" in str(contexts[0].content)
    assert messages[-1].content == "hidden thread task input"
    history = service.message_event_service.get_display_messages(session.id)
    serialized = json.dumps(history, ensure_ascii=False)
    assert "THREAD-TASK-GUIDANCE" not in serialized
    assert "hidden thread task input" not in serialized


@pytest.mark.asyncio
async def test_chat_service_agent_assembly_does_not_block_event_loop(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, _repositories, _checkpointer, _factory = _service(tmp_path, model)
    runner = BlockingAssemblyRunner(delay_seconds=0.5)
    service.agent_runner = runner  # type: ignore[assignment]
    chat_adapter = RecordingChatAdapter()

    task = asyncio.create_task(
        service.handle_chat(
            ChatRequest(message="测试冷启动", provider_id="provider-1", model="qwen-coder"),
            chat_adapter=chat_adapter,
        )
    )

    deadline = time.perf_counter() + 3.0
    while not runner.started.is_set() and time.perf_counter() < deadline:
        assert not task.done()
        await asyncio.sleep(0.01)
    assert runner.started.is_set()

    blocking_started_at = time.perf_counter()
    await asyncio.sleep(0.05)
    elapsed = time.perf_counter() - blocking_started_at

    assert elapsed < 0.35
    assert not runner.finished.is_set()

    result = await task

    assert result.status == "completed"
    assert result.final_content == "完成"


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
    checkpoint = await build_checkpoint_state_graph(checkpointer).aget_state(
        {"configurable": {"thread_id": first.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.values["messages"]
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
                ],
                "message_context_items": [
                    {
                        "id": "file:readme",
                        "type": "file",
                        "label": "README.md",
                        "content": "工作区文件：README.md",
                        "source": "workspace",
                        "path": "README.md",
                        "metadata": {"id": "file:readme", "kind": "file"},
                    },
                    {
                        "id": "quote:1",
                        "type": "quote",
                        "label": "引用片段",
                        "content": "关键片段",
                        "source": "composer",
                        "metadata": {"id": "quote:1", "kind": "quote"},
                    },
                ],
            },
        )
    )

    history = service.message_event_service.get_display_messages(result.session_id)
    visible_history = [message for message in history if message["role"] != "turn"]
    assert [message["role"] for message in visible_history] == ["user", "assistant"]
    assert visible_history[0]["content"] == "总结一下"
    assert len(visible_history[0]["contextItems"]) == 2
    assert visible_history[0]["contextItems"][0]["type"] == "file"
    assert visible_history[0]["contextItems"][0]["path"] == "README.md"
    assert visible_history[0]["contextItems"][1]["type"] == "quote"
    assert "关键片段" in visible_history[0]["contextItems"][1]["content"]

    checkpoint = await build_checkpoint_state_graph(checkpointer).aget_state(
        {"configurable": {"thread_id": result.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.values["messages"]
    assert [message.content for message in messages[:3]] == [
        "用户通过 @ 引用了工作区文件：README.md",
        "用户添加了以下引用片段作为上下文：\n关键片段",
        "总结一下",
    ]
    groups = checkpoint.values["structured_user_message_groups"]
    assert messages[2].id == groups[0]["root_user_message"]["source_id"]


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
    visible_events = [
        item
        for item in chat_adapter.sent
        if item["action"] not in {"turn_started", "middleware_progress"}
    ]
    assert [item["action"] for item in visible_events] == [
        "tool_start",
        "tool_end",
        "stream",
        "completed",
    ]
    assert visible_events[0]["data"]["tool"] == "read_file"
    assert visible_events[1]["data"]["status"] == "completed"
    assert "文件内容:a.txt" in visible_events[1]["data"]["result"]
    tool_result = json.loads(visible_events[1]["data"]["result"])
    assert tool_result["root"] == str(project.resolve())
    history = service.message_event_service.get_display_messages(result.session_id)
    visible_history = [message for message in history if message["role"] != "turn"]
    assert [message["role"] for message in visible_history] == ["user", "tool", "assistant"]
    assert visible_history[1]["toolName"] == "read_file"
    assert visible_history[2]["content"] == "已读取"


@pytest.mark.asyncio
async def test_chat_service_injects_mcp_runtime_tools_for_workspace_session(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已完成")])
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        mcp_manager=FakeMcpManager(),
    )
    _configure_mcp_tool(repositories, raw_names=("search", "create_ticket"))
    workspace = repositories.workspaces.create(workspace_id="ws_mcp", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_mcp_workspace",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="使用 MCP",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    assert "mcp__srv_chat_mcp__search" in factory.created_tool_names[-1]
    assert "mcp__srv_chat_mcp__create_ticket" in factory.created_tool_names[-1]
    assert factory.created_tool_names[-1].count(MCP_CAPABILITY_DISCOVERY_TOOL_NAME) == 1
    snapshots = repositories.mcp_runtime_snapshots.list_by_session(session.id)
    assert len(snapshots) == 1
    mcp_tool_names = [
        tool_name for tool_name in factory.created_tool_names[-1] if tool_name.startswith("mcp__")
    ]
    assert snapshots[0].session_id == session.id
    assert {tool["model_name"] for tool in snapshots[0].visible_tools} == {
        "mcp__srv_chat_mcp__search",
        "mcp__srv_chat_mcp__create_ticket",
    }
    assert [tool["model_name"] for tool in snapshots[0].visible_tools] == mcp_tool_names
    assert {tool["exposure"] for tool in snapshots[0].visible_tools} == {"direct"}
    assert snapshots[0].policy_summary["availability"] == "direct"
    assert snapshots[0].policy_summary["has_on_demand_catalog"] is False
    assert snapshots[0].direct_available_tools == 2
    assert snapshots[0].on_demand_tools == 0


@pytest.mark.asyncio
async def test_chat_service_large_mcp_toolset_keeps_discovery_and_server_summary(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已完成")])
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        settings=AppSettings(
            data_dir=tmp_path / "data",
            workspace_root=tmp_path,
            mcp_direct_tool_budget=5,
        ),
        mcp_manager=FakeMcpManager(),
    )
    raw_names = tuple(f"tool_{index:02d}" for index in range(59))
    _configure_mcp_tool(repositories, raw_names=raw_names)
    workspace = repositories.workspaces.create(workspace_id="ws_mcp_large", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_mcp_large",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="使用很多 MCP 工具",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    created_tools = factory.created_tool_names[-1]
    direct_mcp_tools = [name for name in created_tools if name.startswith("mcp__")]
    assert direct_mcp_tools == []
    assert MCP_CAPABILITY_DISCOVERY_TOOL_NAME in created_tools
    discovery_description = factory.created_tool_descriptions[-1][
        MCP_CAPABILITY_DISCOVERY_TOOL_NAME
    ]
    assert "Chat MCP" in discovery_description
    assert "59 个工具" in discovery_description
    snapshots = repositories.mcp_runtime_snapshots.list_by_session(session.id)
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    assert len(snapshot.visible_tools) == 59
    assert snapshot.direct_available_tools == 0
    assert snapshot.on_demand_tools == 59
    assert snapshot.policy_summary["availability"] == "with_on_demand_catalog"
    assert snapshot.policy_summary["has_on_demand_catalog"] is True
    assert snapshot.capability_directory == snapshot.policy_summary["capability_directory"]
    assert snapshot.capability_directory[0]["server_name"] == "Chat MCP"
    assert snapshot.capability_directory[0]["available_tool_count"] == 59
    assert snapshot.capability_directory[0]["direct_tool_count"] == 0
    assert snapshot.capability_directory[0]["on_demand_tool_count"] == 59


@pytest.mark.asyncio
async def test_chat_service_deferred_mcp_tools_activate_for_next_turn(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    model = ToolFriendlyFakeModel(
        responses=[AIMessage(content="首轮完成"), AIMessage(content="次轮完成")]
    )
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        settings=AppSettings(
            data_dir=tmp_path / "data",
            workspace_root=tmp_path,
            mcp_direct_tool_budget=1,
        ),
        mcp_manager=FakeMcpManager(),
    )
    _configure_mcp_tool(repositories, raw_names=("target_report", "other_report"))
    workspace = repositories.workspaces.create(workspace_id="ws_mcp_deferred", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_mcp_deferred",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    first = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="查找 deferred MCP 工具",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert first.status == "completed"
    assert MCP_CAPABILITY_DISCOVERY_TOOL_NAME in factory.created_tool_names[-1]
    assert factory.created_tool_names[-1].count(MCP_CAPABILITY_DISCOVERY_TOOL_NAME) == 1
    assert "search_mcp_tools" not in factory.created_tool_names[-1]
    assert "list_mcp_tools" not in factory.created_tool_names[-1]
    assert {name for name in factory.created_tool_names[-1] if name.startswith("mcp__")} == set()
    first_snapshot = repositories.mcp_runtime_snapshots.list_by_session(session.id)[0]
    assert first_snapshot.policy_summary["availability"] == "with_on_demand_catalog"
    assert first_snapshot.policy_summary["direct_available_tools"] == 0
    assert first_snapshot.policy_summary["on_demand_tools"] == 2

    search_tool = mcp_capability_discovery_tools_from_snapshot(
        first_snapshot,
        service.mcp_active_tool_window,
    )[0]
    search_result = await search_tool.run(
        {"query": "target_report"},
        ToolExecutionContext(
            session_id=session.id,
            user_id="local-user",
            workspace_root=project,
            turn_index=1,
        ),
    )

    assert search_result.ok is True
    assert search_result.result["tools"][0]["model_name"] == "mcp__srv_chat_mcp__target_report"
    assert service.mcp_active_tool_window.active_model_names(session.id) == {
        "mcp__srv_chat_mcp__target_report"
    }

    second = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="调用已激活 MCP 工具",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert second.status == "completed"
    assert "mcp__srv_chat_mcp__target_report" in factory.created_tool_names[-1]
    assert "mcp__srv_chat_mcp__other_report" not in factory.created_tool_names[-1]
    assert MCP_CAPABILITY_DISCOVERY_TOOL_NAME in factory.created_tool_names[-1]
    latest_snapshot = repositories.mcp_runtime_snapshots.list_by_session(session.id)[0]
    assert latest_snapshot.policy_summary["direct_available_tools"] == 1
    assert latest_snapshot.policy_summary["on_demand_tools"] == 1


@pytest.mark.asyncio
async def test_chat_service_injects_priority_mcp_tool_when_over_budget(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已完成")])
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        settings=AppSettings(
            data_dir=tmp_path / "data",
            workspace_root=tmp_path,
            mcp_direct_tool_budget=1,
        ),
        mcp_manager=FakeMcpManager(),
    )
    _configure_mcp_tool(
        repositories,
        raw_names=(
            "priority_report",
            "priority_summary",
            "other_report",
            "other_summary",
        ),
    )
    for raw_tool_name in ("priority_report", "priority_summary"):
        repositories.mcp_tool_policies.upsert(
            server_id="srv_chat_mcp",
            raw_tool_name=raw_tool_name,
            priority_available=True,
        )
    workspace = repositories.workspaces.create(
        workspace_id="ws_mcp_priority",
        root_path=project,
    )
    session = repositories.sessions.create(
        session_id="ses_mcp_priority",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="使用优先 MCP 工具",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    assert "mcp__srv_chat_mcp__priority_report" in factory.created_tool_names[-1]
    assert "mcp__srv_chat_mcp__priority_summary" in factory.created_tool_names[-1]
    assert "mcp__srv_chat_mcp__other_report" not in factory.created_tool_names[-1]
    assert "mcp__srv_chat_mcp__other_summary" not in factory.created_tool_names[-1]
    assert MCP_CAPABILITY_DISCOVERY_TOOL_NAME in factory.created_tool_names[-1]
    snapshot = repositories.mcp_runtime_snapshots.list_by_session(session.id)[0]
    assert snapshot.direct_available_tools == 2
    assert snapshot.on_demand_tools == 2
    assert snapshot.policy_summary["priority_available_tools"] == 2


@pytest.mark.asyncio
async def test_chat_service_mcp_discovery_rebuilds_tools_in_same_run(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    (system_root / "keydex.md").write_text(
        "MCP-CONTINUATION-GUIDANCE",
        encoding="utf-8",
    )
    model = RecordingToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": MCP_CAPABILITY_DISCOVERY_TOOL_NAME,
                        "args": {"query": "target_report"},
                        "id": "call_discover_mcp",
                    }
                ],
            ),
            AIMessage(content="已继续"),
        ]
    )
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        settings=AppSettings(
            data_dir=tmp_path / "data",
            workspace_root=tmp_path,
            mcp_direct_tool_budget=1,
        ),
        mcp_manager=FakeMcpManager(),
    )
    _configure_mcp_tool(
        repositories,
        raw_names=("target_report", "other_report", "unused_report"),
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_chat_mcp",
        raw_tool_name="other_report",
        priority_available=True,
    )
    workspace = repositories.workspaces.create(workspace_id="ws_mcp_same_run", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_mcp_same_run",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="查找并调用目标 MCP 工具",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    assert len(factory.created_tool_names) >= 2
    assert MCP_CAPABILITY_DISCOVERY_TOOL_NAME in factory.created_tool_names[0]
    assert "mcp__srv_chat_mcp__target_report" not in factory.created_tool_names[0]
    assert "mcp__srv_chat_mcp__other_report" in factory.created_tool_names[0]
    assert "mcp__srv_chat_mcp__target_report" in factory.created_tool_names[1]
    assert "mcp__srv_chat_mcp__other_report" in factory.created_tool_names[1]
    snapshots = repositories.mcp_runtime_snapshots.list_by_session(session.id)
    assert snapshots[0].direct_available_tools == 2
    assert snapshots[0].on_demand_tools == 1
    assert snapshots[1].direct_available_tools == 1
    assert snapshots[1].on_demand_tools == 2
    assert len(model.recorded_messages) >= 2
    for messages in model.recorded_messages:
        contexts = _keydex_context_messages(messages)
        assert len(contexts) == 1
        assert "MCP-CONTINUATION-GUIDANCE" in str(contexts[0].content)


@pytest.mark.asyncio
async def test_chat_service_does_not_inject_mcp_tools_for_chat_session(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="普通回复")])
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        mcp_manager=FakeMcpManager(),
    )
    _configure_mcp_tool(repositories)

    result = await service.handle_chat(
        ChatRequest(message="只聊天", provider_id="provider-1", model="qwen-coder")
    )

    assert result.status == "completed"
    assert not any(
        tool_name.startswith("mcp__")
        for created_tools in factory.created_tool_names
        for tool_name in created_tools
    )
    assert repositories.mcp_runtime_snapshots.list_by_session(result.session_id) == []


@pytest.mark.asyncio
async def test_chat_service_mcp_disabled_keeps_local_workspace_tools_available(
    tmp_path,
) -> None:
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
            handler=lambda args, context: {"content": "ok"},
        )
    )
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="已完成")])
    service, repositories, _checkpointer, factory = _service(
        tmp_path,
        model,
        registry,
        settings=AppSettings(
            data_dir=tmp_path / "data",
            workspace_root=tmp_path,
            mcp_enabled=False,
        ),
        mcp_manager=FakeMcpManager(),
    )
    _configure_mcp_tool(repositories)
    workspace = repositories.workspaces.create(workspace_id="ws_mcp_disabled", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_mcp_disabled",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="使用本地工具",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    assert "read_file" in factory.created_tool_names[-1]
    assert not any(name.startswith("mcp__") for name in factory.created_tool_names[-1])
    assert repositories.mcp_runtime_snapshots.list_by_session(session.id) == []


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
            {"path": "README.md", "old_string": "old", "new_string": "new"},
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
        item for item in chat_adapter.sent if item["action"] in {"tool_start", "tool_end"}
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
        item for item in chat_adapter.sent if item["action"] in {"tool_start", "tool_end"}
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
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    (system_root / "keydex.md").write_text(
        "SKILL-COEXIST-GUIDANCE",
        encoding="utf-8",
    )
    model = RecordingToolFriendlyFakeModel(responses=[AIMessage(content="已按 Skill 处理")])
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
                "message_context_items": [
                    {
                        "id": "file:des",
                        "type": "file",
                        "label": "DES.md",
                        "content": "工作区文件：DES.md",
                        "source": "workspace",
                        "path": "DES.md",
                        "metadata": {"id": "file:des", "kind": "file"},
                    },
                    {
                        "id": "skill:workspace:dev-plan",
                        "type": "skill",
                        "label": "/dev-plan",
                        "content": "Build a structured development plan.",
                        "source": "workspace",
                        "skill_name": "dev-plan",
                        "description": "Build a structured development plan.",
                        "metadata": {
                            "id": "skill:workspace:dev-plan",
                            "kind": "skill",
                            "source": "workspace",
                        },
                    },
                ],
            },
        ),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert factory.requested_models == ["qwen-coder"]
    assert len(factory.created_tool_names) == 1
    assert "load_skill" in factory.created_tool_names[0]
    assert "<keydex_skills>" in factory.system_prompts[0]
    assert 'load_skill(skill_name="dev-plan")' in factory.system_prompts[0]
    assert "Use the project planning workflow." not in factory.system_prompts[0]
    assert len(model.recorded_messages) == 1
    contexts = _keydex_context_messages(model.recorded_messages[0])
    assert len(contexts) == 1
    assert "SKILL-COEXIST-GUIDANCE" in str(contexts[0].content)
    assert any(
        isinstance(message, SystemMessage)
        and "Use the project planning workflow." in str(message.content)
        for message in model.recorded_messages[0]
    )

    visible_events = [item for item in chat_adapter.sent if item["action"] != "turn_started"]
    actions = [item["action"] for item in visible_events]
    assert actions[-1] == "completed"
    assert actions.index("tool_start") < actions.index("tool_end") < actions.index("completed")
    assert visible_events[0]["data"]["content"] == "Build a structured development plan."
    tool_start_event = next(item for item in visible_events if item["action"] == "tool_start")
    tool_end_event = next(item for item in visible_events if item["action"] == "tool_end")
    assert tool_start_event["data"]["tool"] == "load_skill"
    tool_result = json.loads(tool_end_event["data"]["result"])
    assert tool_result["skill_name"] == "dev-plan"
    assert tool_result["found"] is True
    assert tool_result["loaded"] is True
    assert tool_result["injected"] is True

    checkpoint = await build_checkpoint_state_graph(checkpointer).aget_state(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.values["messages"]
    assert any(
        message.type == "system" and "Use the project planning workflow." in message.content
        for message in messages
    )

    history = service.message_event_service.get_display_messages(result.session_id)
    visible_history = [message for message in history if message["role"] != "turn"]
    assert [message["role"] for message in visible_history] == ["user", "tool", "assistant"]
    assert visible_history[0]["content"] == "拆成开发 issues"
    assert len(visible_history[0]["contextItems"]) == 2
    assert visible_history[0]["contextItems"][0]["type"] == "file"
    assert visible_history[0]["contextItems"][0]["path"] == "DES.md"
    assert visible_history[0]["contextItems"][1]["type"] == "skill"
    assert visible_history[0]["contextItems"][1]["skill_name"] == "dev-plan"
    assert (
        visible_history[0]["contextItems"][1]["description"]
        == "Build a structured development plan."
    )
    assert "Use the project planning workflow." not in str(visible_history[0]["contextItems"])
    assert visible_history[1]["toolName"] == "load_skill"
    assert visible_history[2]["content"] == "已按 Skill 处理"


@pytest.mark.asyncio
async def test_chat_service_forces_skill_from_second_batched_steer_after_tool(
    tmp_path,
) -> None:
    project = tmp_path / "project"
    _write_workspace_skill(
        project,
        name="test-skill",
        description="A batched steer skill.",
        body="Batched steer skill instructions.",
    )
    system_root = tmp_path / "system-keydex"
    system_root.mkdir()
    guidance_source = system_root / "keydex.md"
    guidance_source.write_text("STEER-GUIDANCE-V1", encoding="utf-8")
    registry = ToolRegistry()
    model = RecordingToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "seed_pending_steers",
                        "args": {},
                        "id": "call_seed_pending_steers",
                    }
                ],
            ),
            AIMessage(content="已处理批量引导中的 Skill"),
        ]
    )
    service, repositories, _checkpointer, _factory = _service(tmp_path, model, registry)
    workspace = repositories.workspaces.create(workspace_id="ws_batched", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_batched_steers",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    def seed_pending_steers(
        _args: dict[str, Any],
        _context: ToolExecutionContext,
    ) -> dict[str, Any]:
        guidance_source.write_text("STEER-GUIDANCE-V2", encoding="utf-8")
        repositories.pending_inputs.create_or_get(
            session_id=session.id,
            message="你好",
            mode="steer",
            client_input_id="steer-plain",
        )
        repositories.pending_inputs.create_or_get(
            session_id=session.id,
            message="看看",
            mode="steer",
            client_input_id="steer-skill",
            runtime_params={
                "skill_activation": {
                    "skill_name": "test-skill",
                    "source": "workspace",
                    "origin": "slash",
                },
                "message_context_items": [
                    {
                        "id": "skill:test-skill",
                        "type": "skill",
                        "label": "/test-skill",
                        "content": "A batched steer skill.",
                        "source": "workspace",
                        "skill_name": "test-skill",
                    }
                ],
            },
        )
        return {"seeded": 2}

    registry.register(
        FunctionTool(
            name="seed_pending_steers",
            description="Seed two persisted steer inputs for the next model request.",
            parameters={"type": "object", "properties": {}},
            handler=seed_pending_steers,
        )
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="先执行工具",
            provider_id="provider-1",
            model="qwen-coder",
        ),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    tool_names = [
        item["data"]["tool"] for item in chat_adapter.sent if item["action"] == "tool_start"
    ]
    assert tool_names == ["seed_pending_steers", "load_skill"]
    assert len(model.recorded_messages) == 2
    for messages in model.recorded_messages:
        context = _keydex_context_messages(messages)
        assert len(context) == 1
        assert "STEER-GUIDANCE-V1" in str(context[0].content)
        assert "STEER-GUIDANCE-V2" not in str(context[0].content)
    follow_up_messages = model.recorded_messages[-1]
    steer_frames = [
        message
        for message in follow_up_messages
        if isinstance(message, SystemMessage)
        and message.additional_kwargs.get("keydex_running_steer_instruction") is True
    ]
    assert len(steer_frames) == 1
    steer_frame = steer_frames[0]
    assert "高优先级引导" in str(steer_frame.content)
    assert steer_frame.additional_kwargs["keydex_pending_input_ids"] == [
        repositories.pending_inputs.get_by_client_input_id(
            session.id,
            "steer-plain",
        ).id,
        repositories.pending_inputs.get_by_client_input_id(
            session.id,
            "steer-skill",
        ).id,
    ]
    frame_index = follow_up_messages.index(steer_frame)
    steer_user_messages = [
        message
        for message in follow_up_messages[frame_index + 1 :]
        if isinstance(message, HumanMessage) and message.content in {"你好", "看看"}
    ]
    assert [message.content for message in steer_user_messages] == ["你好", "看看"]
    history = service.message_event_service.get_display_messages(session.id)
    skill_messages = [
        message
        for message in history
        if message.get("role") == "tool" and message.get("toolName") == "load_skill"
    ]
    assert len(skill_messages) == 1
    assert not any(
        message.get("role") == "system" and "高优先级引导" in str(message.get("content") or "")
        for message in history
    )


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
    assert factory.created_tool_counts == [1]
    assert factory.created_tool_names == [["load_skill"]]
    assert [
        item["action"]
        for item in chat_adapter.sent
        if item["action"] not in {"turn_started", "middleware_progress"}
    ] == ["stream", "completed"]


@pytest.mark.asyncio
async def test_chat_service_fails_loudly_when_request_omits_model_selection(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, factory = _service(tmp_path, model)
    observed_terminal_statuses: list[str] = []

    class TerminalStatusRecordingAdapter(RecordingChatAdapter):
        async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
            if action == "error":
                observed_terminal_statuses.append(repositories.sessions.get(session_id).status)
            return await super().send(session_id=session_id, action=action, data=data)

    chat_adapter = TerminalStatusRecordingAdapter()

    result = await service.handle_chat(
        ChatRequest(message="你好"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.code == "chat_model_required"
    assert result.error.message == "对话模型必须显式指定供应商和模型"
    assert factory.requested_models == []
    assert chat_adapter.sent[-1]["action"] == "error"
    assert chat_adapter.sent[-1]["data"]["error"] == {
        "schema_version": 1,
        "code": "chat_model_required",
        "message": "对话模型必须显式指定供应商和模型",
        "details": {"scope": "chat", "provider_id": None, "model": None},
        "retryable": False,
    }
    assert not ({"message", "code", "details"} & chat_adapter.sent[-1]["data"].keys())
    assert observed_terminal_statuses == ["failed"]
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
    assert result.error is not None
    assert result.error.code == "chat_model_provider_not_found"
    assert result.error.message == "对话模型供应商不存在"
    assert factory.requested_models == []
    assert chat_adapter.sent[-1]["action"] == "error"
    assert chat_adapter.sent[-1]["data"]["error"] == {
        "schema_version": 1,
        "code": "chat_model_provider_not_found",
        "message": "对话模型供应商不存在",
        "details": {"scope": "chat", "provider_id": "provider-1"},
        "retryable": False,
    }
    assert not ({"message", "code", "details"} & chat_adapter.sent[-1]["data"].keys())
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
    await asyncio.wait_for(agent.stream_started.wait(), timeout=3)
    for _ in range(50):
        if any(item["action"] == "stream" for item in chat_adapter.sent):
            break
        await asyncio.sleep(0.01)

    cancellation.cancel()
    task.cancel()
    result = await asyncio.wait_for(task, timeout=3)

    assert result.status == "cancelled"
    visible_events = [
        item
        for item in chat_adapter.sent
        if item["action"] not in {"turn_started", "llm_first_token"}
    ]
    assert [item["action"] for item in visible_events] == ["stream", "cancelled"]
    assert visible_events[0]["data"]["content"] == "半截"
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
    await asyncio.wait_for(agent.stream_started.wait(), timeout=3)
    for _ in range(50):
        if any(item["action"] == "stream" for item in chat_adapter.sent):
            break
        await asyncio.sleep(0.01)

    cancellation.cancel()
    task.cancel()
    result = await asyncio.wait_for(task, timeout=3)

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


@pytest.mark.asyncio
async def test_workspace_turn_persists_message_anchored_input_file_snapshot(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="完成")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    workspace = repositories.workspaces.create(workspace_id="ws_history", root_path=project)
    session = repositories.sessions.create(
        session_id="session-history",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="记录文件快照",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    snapshots = repositories.file_history.list_snapshots(session.id)
    user_events = [
        event
        for event in repositories.message_events.list_by_session(session.id, limit=100)
        if event.action == "user_message"
    ]
    trace = repositories.trace_records.get(result.trace_id)
    assert result.status == "completed"
    assert len(snapshots) == len(user_events) == 1
    assert snapshots[0].user_message_event_id == user_events[0].id
    assert trace is not None
    assert trace.input_file_snapshot_id == snapshots[0].id
    assert trace.input_file_snapshot_status == "ready"


@pytest.mark.asyncio
async def test_subagent_turn_inherits_parent_file_snapshot_without_child_lineage(
    tmp_path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="done")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    workspace = repositories.workspaces.create(
        workspace_id="ws_subagent_history",
        root_path=project,
    )
    parent = repositories.sessions.create(
        session_id="parent-history",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
        current_model_provider_id="provider-1",
        current_model="qwen-coder",
    )
    repositories.trace_records.create(
        trace_id="parent-trace",
        session_id=parent.id,
        active_session_id=parent.id,
        scene_id=parent.scene_id,
        user_id=parent.user_id,
        turn_index=1,
        root_node_id="parent-root",
    )
    snapshot = service.file_history_service.make_input_snapshot(
        session_id=parent.id,
        active_session_id=parent.id,
        trace_id="parent-trace",
        message_event_id="parent-message",
        workspace_root=project,
    )
    repositories.trace_records.set_input_file_snapshot(
        "parent-trace",
        snapshot_id=snapshot.id,
        status="ready",
    )
    child = repositories.sessions.create(
        session_id="child-history",
        user_id=parent.user_id,
        scene_id=parent.scene_id,
        session_type="workspace",
        session_tag="subagent",
        workspace_id=workspace.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-history",
        subagent_role="worker",
        parent_session_id=parent.id,
        cwd=str(project),
        workspace_roots=[str(project)],
        current_model_provider_id="provider-1",
        current_model="qwen-coder",
    )
    now = utc_now()
    repositories.subagent_runs.create(
        SubagentRunSnapshot(
            run_id="run-history",
            subagent_id="subagent-history",
            child_session_id=child.id,
            parent_session_id=parent.id,
            parent_trace_id="parent-trace",
            parent_tool_call_id="delegate-call",
            parent_timeline_sequence=0,
            initiated_by="main_agent",
            role="worker",
            task="edit files",
            state="running",
            version=2,
            created_at=now,
            queued_at=now,
            started_at=now,
            updated_at=now,
        )
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=child.id,
            message="edit files",
            user_id=child.user_id,
            scene_id=child.scene_id,
            provider_id="provider-1",
            model="qwen-coder",
            subagent_run_id="run-history",
            subagent_parent_session_id=parent.id,
        )
    )

    assert result.status == "completed"
    child_trace = repositories.trace_records.get(result.trace_id)
    assert child_trace is not None
    assert child_trace.input_file_snapshot_id == snapshot.id
    assert child_trace.metadata["file_history_owner"] == {
        "session_id": parent.id,
        "trace_id": "parent-trace",
        "turn_index": 1,
        "input_snapshot_id": snapshot.id,
    }
    assert repositories.file_history.list_snapshots(child.id) == []


@pytest.mark.asyncio
async def test_disabled_file_history_allows_chat_but_records_disabled_snapshot_status(
    tmp_path,
) -> None:
    project = tmp_path / "project-disabled"
    project.mkdir()
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="只聊天")])
    service, repositories, _checkpointer, _factory = _service(tmp_path, model)
    service.file_history_service.enabled = False
    workspace = repositories.workspaces.create(
        workspace_id="ws_history_disabled",
        root_path=project,
    )
    session = repositories.sessions.create(
        session_id="session-history-disabled",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="不修改文件",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    trace = repositories.trace_records.get(result.trace_id)
    assert result.status == "completed"
    assert repositories.file_history.list_snapshots(session.id) == []
    assert trace is not None
    assert trace.input_file_snapshot_id is None
    assert trace.input_file_snapshot_status == "disabled"
