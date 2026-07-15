from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.side_task_model import create_side_task_llm
from backend.app.core.logger import logger
from backend.app.model import resolve_model_default
from backend.app.services.session_title_service import (
    SESSION_TITLE_LLM_MAX_TOKENS,
    SESSION_TITLE_LLM_TEMPERATURE,
)
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    MODEL_DEFAULT_FAST,
    StorageRepositories,
)


@dataclass(frozen=True)
class DefaultModelWarmupResult:
    warmed_scopes: tuple[str, ...]
    skipped_scopes: tuple[str, ...]


def warmup_default_models(
    repositories: StorageRepositories,
    *,
    factory: AgentFactory = agent_factory,
    http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
) -> DefaultModelWarmupResult:
    """Populate the existing LLM instance cache for the two configured defaults."""

    started = time.perf_counter()
    warmed: list[str] = []
    skipped: list[str] = []

    for scope, warmup in (
        (
            MODEL_DEFAULT_CHAT,
            lambda: _warmup_default_chat_model(
                repositories,
                factory=factory,
                http_transport=http_transport,
            ),
        ),
        (
            MODEL_DEFAULT_FAST,
            lambda: _warmup_fast_model(
                repositories,
                factory=factory,
                http_transport=http_transport,
            ),
        ),
    ):
        try:
            provider_id, model = warmup()
        except Exception as exc:
            skipped.append(scope)
            log = (
                logger.info
                if getattr(exc, "code", None) == "model_default_not_configured"
                else logger.warning
            )
            log(
                "[LLMWarmup] 默认模型缓存预热跳过 | "
                f"scope={scope} | code={getattr(exc, 'code', exc.__class__.__name__)} | "
                f"error={exc}"
            )
            continue
        warmed.append(scope)
        logger.info(
            "[LLMWarmup] 默认模型缓存预热完成 | "
            f"scope={scope} | provider_id={provider_id} | model={model}"
        )

    duration_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "[LLMWarmup] 默认模型缓存预热结束 | "
        f"warmed={','.join(warmed) or '-'} | skipped={','.join(skipped) or '-'} | "
        f"duration_ms={duration_ms}"
    )
    return DefaultModelWarmupResult(
        warmed_scopes=tuple(warmed),
        skipped_scopes=tuple(skipped),
    )


def _warmup_default_chat_model(
    repositories: StorageRepositories,
    *,
    factory: AgentFactory,
    http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None,
) -> tuple[str, str]:
    resolved = resolve_model_default(repositories, MODEL_DEFAULT_CHAT)
    # Keep this invocation aligned with AgentRunner.create_agent so the first chat hits it.
    factory.get_or_create_llm(
        resolved.settings,
        model=resolved.settings.model,
        http_transport=http_transport,
        llm_request_logs=repositories.llm_request_logs,
    )
    return resolved.provider_id, resolved.settings.model


def _warmup_fast_model(
    repositories: StorageRepositories,
    *,
    factory: AgentFactory,
    http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None,
) -> tuple[str, str]:
    # The fast default currently serves session-title generation; use the same cache profile.
    side_task = create_side_task_llm(
        repositories,
        factory=factory,
        http_transport=http_transport,
        temperature=SESSION_TITLE_LLM_TEMPERATURE,
        max_tokens=SESSION_TITLE_LLM_MAX_TOKENS,
    )
    return side_task.provider_id, side_task.model
