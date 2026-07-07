from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from langchain_core.messages import BaseMessage

from backend.app.agent.context_compression_utils import (
    CompressionReplacementResult,
    build_context_compression_replacement_messages,
)
from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.internal_llm_events import context_compression_llm_config
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.model import (
    ModelSelectionError,
    ResolvedModelSelection,
    resolve_model_default,
    resolve_model_selection,
)
from backend.app.services.context_compression_prompt_builder import (
    build_compaction_prompt,
    extract_summary_text,
)
from backend.app.storage import MODEL_DEFAULT_CHAT, SessionRecord, StorageRepositories


@dataclass(frozen=True, slots=True)
class CompressionGenerationResult:
    success: bool
    reason: Literal["manual", "automatic"]
    summary: str | None = None
    replacement_messages: list[BaseMessage] | None = None
    failure_reason: str | None = None
    model_provider_id: str | None = None
    model: str | None = None
    compression_message_count: int = 0
    total_message_count: int = 0


@dataclass(frozen=True)
class ContextCompressionOutcome:
    status: str
    reason: str | None = None
    target_session_id: str | None = None
    token_count: int = 0
    context_window_tokens: int = 0
    fraction: float = 0.0


class ContextCompressionService:
    """Generate a unified continuation summary with the current chat model."""

    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        factory: AgentFactory = agent_factory,
        http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.repositories = repositories
        self.factory = factory
        self.http_transport = http_transport

    async def generate_compression_result(
        self,
        *,
        session: SessionRecord,
        messages: list[BaseMessage],
        reason: Literal["manual", "automatic"],
        trace_id: str | None = None,
        trace_record_id: str | None = None,
        active_session_id: str | None = None,
    ) -> CompressionGenerationResult:
        message_list = list(messages)
        if not message_list:
            return CompressionGenerationResult(
                success=False,
                reason=reason,
                failure_reason="no_compressible_messages",
            )
        try:
            resolved = self._resolve_session_model(session)
            llm = self.factory.get_or_create_llm(
                resolved.settings,
                model=resolved.settings.model,
                temperature=0,
                streaming=False,
                http_transport=self.http_transport,
                llm_request_logs=self.repositories.llm_request_logs,
                provider_id=resolved.provider_id,
                provider_name=resolved.provider_name,
            )
        except ModelSelectionError as exc:
            logger.warning(
                "[ContextCompressionService] 获取主模型配置失败 | "
                f"scope={exc.scope} | code={exc.code} | error={exc}"
            )
            return CompressionGenerationResult(
                success=False,
                reason=reason,
                failure_reason=f"model_config_error:{exc.code}",
                total_message_count=len(message_list),
            )
        except Exception as exc:
            logger.warning(f"[ContextCompressionService] 创建主模型失败 | error={exc}")
            return CompressionGenerationResult(
                success=False,
                reason=reason,
                failure_reason=f"model_create_error:{exc}",
                total_message_count=len(message_list),
            )

        prompt = build_compaction_prompt()
        prompt_messages = [*message_list, prompt.human_message]
        side_event_id = new_id()
        started_at_ms = int(time.time() * 1000)
        if trace_id and trace_record_id:
            self._append_side_event(
                trace_id=trace_id,
                trace_record_id=trace_record_id,
                status="running",
                side_event_id=side_event_id,
                session=session,
                active_session_id=active_session_id or session.active_session_id or session.id,
                model=resolved.settings.model,
                reason=reason,
                started_at_ms=started_at_ms,
            )
        try:
            response = await llm.ainvoke(prompt_messages, config=context_compression_llm_config())
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ContextCompressionService] 主模型压缩调用失败 | "
                f"session_id={session.id} | reason={reason} | error={exc}"
            )
            if trace_id and trace_record_id:
                self._append_side_event(
                    trace_id=trace_id,
                    trace_record_id=trace_record_id,
                    status="failed",
                    side_event_id=side_event_id,
                    session=session,
                    active_session_id=active_session_id or session.active_session_id or session.id,
                    model=resolved.settings.model,
                    reason=reason,
                    started_at_ms=started_at_ms,
                    error={"type": type(exc).__name__, "message": str(exc)},
                )
            return CompressionGenerationResult(
                success=False,
                reason=reason,
                failure_reason=f"llm_error:{exc}",
                model_provider_id=resolved.provider_id,
                model=resolved.settings.model,
                total_message_count=len(message_list),
            )

        if getattr(response, "tool_calls", None):
            return CompressionGenerationResult(
                success=False,
                reason=reason,
                failure_reason="tool_call_returned",
                model_provider_id=resolved.provider_id,
                model=resolved.settings.model,
                total_message_count=len(message_list),
            )
        summary = extract_summary_text(getattr(response, "content", response))
        if not summary:
            return CompressionGenerationResult(
                success=False,
                reason=reason,
                failure_reason="empty_summary_output",
                model_provider_id=resolved.provider_id,
                model=resolved.settings.model,
                total_message_count=len(message_list),
            )
        replacement = self._build_replacement(summary=summary, messages=message_list)
        usage = _extract_token_usage(response)
        if trace_id and trace_record_id:
            self._append_side_event(
                trace_id=trace_id,
                trace_record_id=trace_record_id,
                status="completed",
                side_event_id=side_event_id,
                session=session,
                active_session_id=active_session_id or session.active_session_id or session.id,
                model=resolved.settings.model,
                reason=reason,
                usage=usage,
                started_at_ms=started_at_ms,
            )
        return CompressionGenerationResult(
            success=True,
            reason=reason,
            summary=summary,
            replacement_messages=replacement.replaced_messages,
            model_provider_id=resolved.provider_id,
            model=resolved.settings.model,
            compression_message_count=len(message_list),
            total_message_count=len(message_list),
        )

    def _resolve_session_model(self, session: SessionRecord) -> ResolvedModelSelection:
        provider_id = (session.current_model_provider_id or "").strip()
        model = (session.current_model or "").strip()
        if provider_id and model:
            return resolve_model_selection(
                self.repositories,
                provider_id=provider_id,
                model=model,
                scope="chat",
                label="对话模型",
                code_prefix="context_compression_model",
            )
        return resolve_model_default(self.repositories, MODEL_DEFAULT_CHAT)

    @staticmethod
    def _build_replacement(
        *,
        summary: str,
        messages: list[BaseMessage],
    ) -> CompressionReplacementResult:
        return build_context_compression_replacement_messages(
            summary=summary,
            source_messages=messages,
        )

    def _append_side_event(
        self,
        *,
        trace_id: str,
        trace_record_id: str,
        status: str,
        side_event_id: str,
        session: SessionRecord,
        active_session_id: str,
        model: str,
        reason: str,
        usage: dict[str, int] | None = None,
        started_at_ms: int | None = None,
        error: dict[str, str] | None = None,
    ) -> None:
        token_usage = usage or {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cache_read_tokens": 0,
        }
        payload = {
            "side_event_id": side_event_id,
            "event_type": "context_compression.llm",
            "status": status,
            "name": model,
            "session_id": session.id,
            "active_session_id": active_session_id,
            "error": error,
            "input_tokens": token_usage["input_tokens"],
            "cache_read_tokens": token_usage["cache_read_tokens"],
            "output_tokens": token_usage["output_tokens"],
            "total_tokens": token_usage["total_tokens"],
            "metadata": {
                "domain": "context_compression",
                "reason": reason,
                "started_at_ms": started_at_ms,
            },
        }
        try:
            self.repositories.trace_event_logs.append(
                trace_id=trace_id,
                trace_record_id=trace_record_id,
                event_type="context_compression.llm",
                source="context_compression_service",
                idempotency_key=f"{side_event_id}:{status}",
                timestamp_ms=int(time.time() * 1000),
                payload=payload,
                original_session_id=session.id,
                active_session_id=active_session_id,
                tags={"domain": "context_compression", "status": status},
            )
        except Exception as exc:
            logger.debug(f"[ContextCompressionService] 压缩旁路事件记录失败 | error={exc}")


def _response_usage(response: Any) -> Any:
    usage = getattr(response, "usage_metadata", None)
    if usage:
        return usage
    if isinstance(response, dict):
        return response.get("usage_metadata")
    generations = getattr(response, "generations", None)
    if generations:
        for generation_list in generations:
            for generation in generation_list:
                message = getattr(generation, "message", None)
                usage = getattr(message, "usage_metadata", None)
                if usage:
                    return usage
    return None


def _extract_token_usage(response: Any, fallback: dict[str, int] | None = None) -> dict[str, int]:
    usage = _response_usage(response)
    if usage:
        return _extract_token_usage_from_metadata(usage)
    return fallback or {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
    }


def _extract_token_usage_from_metadata(usage: Any) -> dict[str, int]:
    if isinstance(usage, dict):
        details = usage.get("input_token_details") or {}
        return {
            "input_tokens": int(usage.get("input_tokens", 0) or 0),
            "output_tokens": int(usage.get("output_tokens", 0) or 0),
            "total_tokens": int(usage.get("total_tokens", 0) or 0),
            "cache_read_tokens": int(details.get("cache_read", 0) or 0)
            if isinstance(details, dict)
            else 0,
        }
    details = getattr(usage, "input_token_details", None)
    cache_read_tokens = 0
    if isinstance(details, dict):
        cache_read_tokens = int(details.get("cache_read", 0) or 0)
    elif details is not None:
        cache_read_tokens = int(getattr(details, "cache_read", 0) or 0)
    return {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
        "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
        "cache_read_tokens": cache_read_tokens,
    }
