from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import httpx
from langchain_core.messages import SystemMessage

from backend.app.a2ui.prompt import build_a2ui_prompt_section
from backend.app.a2ui.registry import build_builtin_a2ui_registry
from backend.app.a2ui.runtime import A2UIRuntime
from backend.app.a2ui.tools import a2ui_registry_to_langchain_tools
from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.langchain_tools import registry_to_langchain_tools, tools_to_langchain_tools
from backend.app.agent.middleware.builder import build_default_middleware
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    default_agent_runtime_settings,
)
from backend.app.agent.state import KeydexAgentState
from backend.app.agent.system_prompt import DEFAULT_SYSTEM_PROMPT
from backend.app.command_approval import load_command_settings
from backend.app.core.logger import logger
from backend.app.keydex.skills import SkillCatalog, build_skill_index
from backend.app.model import ModelSettings
from backend.app.tools import LocalTool, ToolExecutionContext, ToolRegistry
from backend.app.tools.command_runtime.descriptions import command_system_prompt_section
from backend.app.tools.command_runtime.models import CommandRuntime
from backend.app.tools.command_runtime.tools import create_command_tools
from backend.app.tools.skill import load_skill

ModelHttpTransportProvider = Callable[
    [],
    httpx.BaseTransport | httpx.AsyncBaseTransport | None,
]


class AgentAssemblyError(ValueError):
    pass


class AgentRunner:
    """LangChain agent assembly entrypoint used by runtime chat."""

    def __init__(
        self,
        *,
        model_settings_provider: Callable[[], ModelSettings],
        checkpointer: Any,
        tool_registry: ToolRegistry,
        runtime_settings_provider: Callable[[], AgentRuntimeSettings] | None = None,
        model_http_transport_provider: ModelHttpTransportProvider | None = None,
        default_system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        factory: AgentFactory = agent_factory,
    ) -> None:
        self._model_settings_provider = model_settings_provider
        self._runtime_settings_provider = (
            runtime_settings_provider or default_agent_runtime_settings
        )
        self._model_http_transport_provider = model_http_transport_provider or (lambda: None)
        self.checkpointer = checkpointer
        self.tool_registry = tool_registry
        self.default_system_prompt = default_system_prompt
        self.factory = factory

    @property
    def model_settings(self) -> ModelSettings:
        return self._model_settings_provider()

    def model_http_transport(self) -> httpx.BaseTransport | httpx.AsyncBaseTransport | None:
        return self._model_http_transport_provider()

    def create_agent(
        self,
        *,
        model: str,
        model_settings: ModelSettings | None = None,
        system_prompt: str | None,
        tool_context: ToolExecutionContext,
        enable_tools: bool = True,
        runtime_tools: Sequence[LocalTool] | None = None,
    ) -> Any:
        if self.checkpointer is None:
            logger.error("[AgentRunner] checkpointer 未配置，无法创建 agent")
            raise AgentAssemblyError("checkpointer 未配置")

        settings = model_settings or self.model_settings
        model_http_transport = self.model_http_transport()
        repositories = tool_context.metadata.get("repositories")
        llm = self.factory.get_or_create_llm(
            settings,
            model=model,
            http_transport=model_http_transport,
            llm_request_logs=getattr(repositories, "llm_request_logs", None),
        )
        command_settings = None
        command_runtime: CommandRuntime | None = None
        runtime_settings = self._runtime_settings_provider()
        a2ui_registry = None
        tools = []
        if enable_tools:
            tools = registry_to_langchain_tools(
                self.tool_registry,
                context_factory=lambda: tool_context,
            )
            if repositories is not None:
                command_settings = load_command_settings(repositories)
                command_runtime = CommandRuntime.from_settings(command_settings)
                command_registry = ToolRegistry()
                for tool in create_command_tools(command_settings):
                    command_registry.register(tool)
                tools.extend(
                    registry_to_langchain_tools(
                        command_registry,
                        context_factory=lambda: tool_context,
                    )
                )
            if runtime_tools:
                tools.extend(
                    tools_to_langchain_tools(
                        runtime_tools,
                        context_factory=lambda: tool_context,
                    )
                )
            dispatcher = tool_context.metadata.get("dispatcher")
            if runtime_settings.a2ui.enabled and repositories is not None and dispatcher is not None:
                reserved_tool_names = {
                    str(getattr(tool, "name", "") or "")
                    for tool in tools
                    if str(getattr(tool, "name", "") or "")
                }
                try:
                    a2ui_registry = build_builtin_a2ui_registry(
                        reserved_tool_names=reserved_tool_names
                    )
                except ValueError as exc:
                    raise AgentAssemblyError(str(exc)) from exc
                a2ui_runtime = A2UIRuntime(
                    repositories=repositories,
                    dispatcher=dispatcher,
                    registry=a2ui_registry,
                )
                tools.extend(
                    a2ui_registry_to_langchain_tools(
                        a2ui_registry,
                        context_factory=lambda: tool_context,
                        handler=a2ui_runtime.handle_tool_call,
                    )
                )
        if enable_tools and isinstance(tool_context.metadata.get("skill_catalog"), SkillCatalog):
            tools.append(load_skill)
        resolved_system_prompt = (
            system_prompt if system_prompt is not None else self.default_system_prompt
        )
        prompt = resolved_system_prompt.strip() if resolved_system_prompt else ""
        skill_index = self._skill_index_from_context(tool_context)
        if skill_index:
            prompt = f"{prompt}\n\n{skill_index}" if prompt else skill_index
        command_prompt = command_system_prompt_section(
            command_runtime if enable_tools else None,
            command_settings if enable_tools else None,
        )
        prompt = f"{prompt}\n\n{command_prompt}" if prompt else command_prompt
        a2ui_prompt = build_a2ui_prompt_section(
            enabled=bool(enable_tools and runtime_settings.a2ui.enabled and a2ui_registry),
            registry=a2ui_registry,
        )
        if a2ui_prompt:
            prompt = f"{prompt}\n\n{a2ui_prompt}" if prompt else a2ui_prompt
        logger.info(
            f"[AgentRunner] 组装 agent | model={model} | tools={len(tools)} | "
            f"tools_enabled={enable_tools} | prompt_len={len(prompt)} | "
            f"skill_index_len={len(skill_index)} | workspace_root={tool_context.workspace_root}"
        )
        return self.factory.create_agent(
            model=llm,
            tools=tools,
            system_prompt=SystemMessage(content=prompt) if prompt else "",
            checkpointer=self.checkpointer,
            middleware=build_default_middleware(
                runtime_settings,
                repositories=repositories,
                dispatcher=tool_context.metadata.get("dispatcher"),
                checkpointer=self.checkpointer,
                model_http_transport=model_http_transport,
            ),
            state_schema=KeydexAgentState,
            name="desktop_agent",
        )

    @staticmethod
    def _skill_index_from_context(tool_context: ToolExecutionContext) -> str:
        catalog = tool_context.metadata.get("skill_catalog")
        if not isinstance(catalog, SkillCatalog):
            return ""
        return build_skill_index(catalog)

    async def get_latest_checkpoint_config(
        self,
        *,
        thread_id: str,
        checkpoint_ns: str = "",
    ) -> dict[str, str | None]:
        if self.checkpointer is None:
            logger.debug("[AgentRunner] checkpointer 未配置，跳过读取 checkpoint")
            return {"checkpoint_id": None, "checkpoint_ns": checkpoint_ns}
        checkpoint = await self.checkpointer.aget_tuple(
            {"configurable": {"thread_id": thread_id, "checkpoint_ns": checkpoint_ns}}
        )
        if checkpoint is None:
            logger.debug(
                f"[AgentRunner] 未找到 checkpoint | thread_id={thread_id} | "
                f"checkpoint_ns={checkpoint_ns}"
            )
            return {"checkpoint_id": None, "checkpoint_ns": checkpoint_ns}
        configurable = checkpoint.config.get("configurable", {})
        logger.debug(
            f"[AgentRunner] 读取最新 checkpoint | thread_id={thread_id} | "
            f"checkpoint_id={configurable.get('checkpoint_id') or '-'}"
        )
        return {
            "checkpoint_id": configurable.get("checkpoint_id"),
            "checkpoint_ns": configurable.get("checkpoint_ns", checkpoint_ns) or "",
        }
