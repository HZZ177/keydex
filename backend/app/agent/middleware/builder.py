from __future__ import annotations

from typing import Any

import httpx
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents.middleware import AgentMiddleware

from backend.app.agent.keydex_markdown_context_middleware import (
    KeydexMarkdownContextMiddleware,
)
from backend.app.agent.middleware.auto_title import AutoTitleMiddleware
from backend.app.agent.middleware.context_compression import ContextCompressionMiddleware
from backend.app.agent.middleware.duplicate_tool_call_guard import (
    DuplicateToolCallGuardMiddleware,
)
from backend.app.agent.middleware.invalid_tool_call_recovery import (
    InvalidToolCallRecoveryMiddleware,
)
from backend.app.agent.middleware.pending_inputs import PendingUserInputInjectionMiddleware
from backend.app.agent.middleware.tool_error_handling import ToolErrorHandlingMiddleware
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    default_agent_runtime_settings,
)
from backend.app.agent.skill_activation_middleware import SkillActivationInjectionMiddleware
from backend.app.agent.tool_call_preset_middleware import ToolCallPresetMiddleware
from backend.app.core.logger import logger
from backend.app.events import EventDispatcher
from backend.app.storage import StorageRepositories


def build_default_middleware(
    runtime_settings: AgentRuntimeSettings | None = None,
    *,
    repositories: StorageRepositories | None = None,
    dispatcher: EventDispatcher | None = None,
    checkpointer: Any | None = None,
    model_http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
) -> tuple[AgentMiddleware, ...]:
    """按运行时配置装配默认中间件链。"""

    settings = runtime_settings or default_agent_runtime_settings()
    middlewares: list[AgentMiddleware] = [
        PatchToolCallsMiddleware(),
        ToolCallPresetMiddleware(),
        SkillActivationInjectionMiddleware(),
    ]
    if repositories is None:
        logger.warning("[AgentMiddleware] 缺少 repositories，跳过运行中用户输入注入中间件")
    else:
        middlewares.append(
            PendingUserInputInjectionMiddleware(
                repositories=repositories,
                dispatcher=dispatcher,
            )
        )
    if settings.context_compression.enabled:
        if repositories is None or dispatcher is None or checkpointer is None:
            logger.warning("[AgentMiddleware] 上下文压缩已启用但缺少运行时依赖，跳过装配")
        else:
            middlewares.append(
                ContextCompressionMiddleware(
                    settings=settings.context_compression,
                    repositories=repositories,
                    dispatcher=dispatcher,
                    checkpointer=checkpointer,
                    http_transport=model_http_transport,
                )
            )
    middlewares.append(KeydexMarkdownContextMiddleware())
    if settings.auto_title.enabled:
        if repositories is None or dispatcher is None:
            logger.warning("[AgentMiddleware] 自动标题已启用但缺少运行时依赖，跳过装配")
        else:
            middlewares.append(
                AutoTitleMiddleware(
                    settings=settings.auto_title,
                    repositories=repositories,
                    dispatcher=dispatcher,
                    http_transport=model_http_transport,
                )
            )
    middlewares.append(ToolErrorHandlingMiddleware())
    if settings.duplicate_tool_call_guard.enabled:
        middlewares.append(
            DuplicateToolCallGuardMiddleware(
                max_repeats=settings.duplicate_tool_call_guard.max_repeats,
            )
        )
    middlewares.append(InvalidToolCallRecoveryMiddleware())
    return tuple(middlewares)
