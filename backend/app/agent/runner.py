from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from langchain_core.messages import SystemMessage

from backend.app.agent.factory import AgentFactory, agent_factory, load_system_prompt
from backend.app.agent.langchain_tools import registry_to_langchain_tools
from backend.app.agent.middleware import build_default_middleware
from backend.app.core.logger import logger
from backend.app.model import ModelSettings
from backend.app.tools import ToolExecutionContext, ToolRegistry

DEFAULT_SYSTEM_PROMPT_PATH = Path(__file__).with_name("system_prompt.md")
DEFAULT_SYSTEM_PROMPT = load_system_prompt(DEFAULT_SYSTEM_PROMPT_PATH)
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
        model_http_transport_provider: ModelHttpTransportProvider | None = None,
        default_system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        factory: AgentFactory = agent_factory,
    ) -> None:
        self._model_settings_provider = model_settings_provider
        self._model_http_transport_provider = model_http_transport_provider or (
            lambda: None
        )
        self.checkpointer = checkpointer
        self.tool_registry = tool_registry
        self.default_system_prompt = default_system_prompt
        self.factory = factory

    @property
    def model_settings(self) -> ModelSettings:
        return self._model_settings_provider()

    def create_agent(
        self,
        *,
        model: str,
        system_prompt: str | None,
        tool_context: ToolExecutionContext,
        enable_tools: bool = True,
    ) -> Any:
        if self.checkpointer is None:
            logger.error("[AgentRunner] checkpointer 未配置，无法创建 agent")
            raise AgentAssemblyError("checkpointer 未配置")

        settings = self.model_settings
        llm = self.factory.get_or_create_llm(
            settings,
            model=model,
            http_transport=self._model_http_transport_provider(),
        )
        tools = (
            registry_to_langchain_tools(
                self.tool_registry,
                context_factory=lambda: tool_context,
            )
            if enable_tools
            else []
        )
        resolved_system_prompt = (
            system_prompt if system_prompt is not None else self.default_system_prompt
        )
        prompt = resolved_system_prompt.strip() if resolved_system_prompt else ""
        logger.info(
            f"[AgentRunner] 组装 agent | model={model} | tools={len(tools)} | "
            f"tools_enabled={enable_tools} | prompt_len={len(prompt)} | "
            f"workspace_root={tool_context.workspace_root}"
        )
        return self.factory.create_agent(
            model=llm,
            tools=tools,
            system_prompt=SystemMessage(content=prompt) if prompt else "",
            checkpointer=self.checkpointer,
            middleware=build_default_middleware(),
            name="desktop_agent",
        )

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
