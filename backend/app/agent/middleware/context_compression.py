from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, RemoveMessage

try:
    from langchain_core.messages.utils import count_tokens_approximately
except Exception:  # pragma: no cover
    count_tokens_approximately = None
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.middleware.common import _compression_display_label, _state_messages
from backend.app.agent.runtime_settings import ContextCompressionRuntimeSettings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import (
    get_active_session_id,
    get_session_id,
    get_trace_id,
    get_user_id,
)
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.services.context_compression_service import ContextCompressionService
from backend.app.storage import StorageRepositories

CURRENT_TURN_MESSAGE_MARKER = "_keydex_current_turn"
INJECTED_MESSAGE_MARKER = "_injected"


class ContextCompressionMiddleware(AgentMiddleware):
    """Unified blocking context compression middleware."""

    DEFAULT_CONTEXT_WINDOW = 128000
    DEFAULT_TRIGGER_FRACTION = 0.75

    def __init__(
        self,
        *,
        settings: ContextCompressionRuntimeSettings,
        repositories: StorageRepositories,
        dispatcher: EventDispatcher,
        checkpointer: Any,
        http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        factory: AgentFactory = agent_factory,
        schedule_task: Callable[[Awaitable[None]], Any] | None = None,
        compression_service: ContextCompressionService | None = None,
    ) -> None:
        self.settings = settings
        self.repositories = repositories
        self.dispatcher = dispatcher
        self.checkpointer = checkpointer
        self.http_transport = http_transport
        self.factory = factory
        self._compression_service = compression_service

    def _service(self) -> ContextCompressionService:
        return self._compression_service or ContextCompressionService(
            self.repositories,
            factory=self.factory,
            http_transport=self.http_transport,
        )

    def _get_trigger_fraction(self) -> float:
        value = float(self.settings.trigger_fraction)
        if value <= 0 or value >= 1:
            return self.DEFAULT_TRIGGER_FRACTION
        return value

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[
            [ModelRequest],
            Awaitable[ModelResponse | ExtendedModelResponse | AIMessage],
        ],
    ) -> ModelResponse | ExtendedModelResponse | AIMessage:
        if not self.settings.enabled:
            return await handler(request)
        original_session_id = get_session_id()
        active_session_id = get_active_session_id()
        if not original_session_id or not active_session_id:
            return await handler(request)

        try:
            response = await handler(request)
        except Exception:
            logger.debug(
                "[ContextCompressionMiddleware] LLM调用失败，跳过上下文窗口用量更新 | "
                f"原始会话={original_session_id} | 活动会话={active_session_id}"
            )
            raise

        response_messages = self._model_response_messages(response)
        usage_total_tokens = self._extract_usage_total_tokens(response_messages)
        if usage_total_tokens is None:
            logger.debug(
                "[ContextCompressionMiddleware] LLM调用后未返回真实usage，跳过上下文窗口用量更新 | "
                f"原始会话={original_session_id} | 活动会话={active_session_id}"
            )
            return response

        request_messages = self._model_request_messages(request)
        await self._emit_model_call_window_snapshot(
            hook="model_call_after",
            call_phase="after",
            call_status="completed",
            token_source="usage_metadata",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            messages=[*request_messages, *response_messages],
            usage_total_tokens=usage_total_tokens,
        )
        return response

    async def abefore_model(self, state: Any, runtime: Any) -> dict | None:
        if not self.settings.enabled:
            return None
        original_session_id = get_session_id()
        active_session_id = get_active_session_id()
        messages = _state_messages(state)
        if not messages:
            self._log_skip("abefore_model", "no_messages", original_session_id, active_session_id)
            return None
        if not original_session_id or not active_session_id:
            self._log_skip(
                "abefore_model", "missing_session", original_session_id, active_session_id
            )
            return None

        session = self.repositories.sessions.get(original_session_id)
        if session is None:
            self._log_skip(
                "abefore_model", "session_not_found", original_session_id, active_session_id
            )
            return None

        compression_messages, continuation_messages = self._split_messages_for_blocking_compression(
            messages
        )
        fraction_snapshot = self._calculate_before_model_fraction(
            messages=messages,
            continuation_messages=continuation_messages,
            session_context_window_usage=session.context_window_usage,
        )
        trigger_fraction = self._get_trigger_fraction()
        await self._emit_context_window_snapshot(
            hook="abefore_model",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            fraction_snapshot=fraction_snapshot,
            total_message_count=len(messages),
            compression_count=len(compression_messages),
            continuation_count=len(continuation_messages),
            call_phase="before",
            call_status="pending",
            token_source=fraction_snapshot["token_source"],
            usage_token_count=fraction_snapshot["usage_token_count"],
            estimated_pending_token_count=fraction_snapshot["estimated_pending_token_count"],
            pending_message_count=fraction_snapshot["pending_message_count"],
            usage_source=fraction_snapshot["usage_source"],
        )
        self._log_fraction_snapshot(
            "abefore_model",
            original_session_id,
            active_session_id,
            fraction_snapshot,
            total_message_count=len(messages),
            compression_count=len(compression_messages),
            continuation_count=len(continuation_messages),
            trigger_fraction=trigger_fraction,
        )
        if not compression_messages:
            self._log_compression_decision(
                hook="abefore_model",
                decision="skip_compression",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                fraction_snapshot=fraction_snapshot,
                compression_count=0,
                continuation_count=len(continuation_messages),
                trigger_fraction=trigger_fraction,
                reason="没有可压缩的历史消息",
            )
            return None
        if float(fraction_snapshot["fraction"]) < trigger_fraction:
            self._log_compression_decision(
                hook="abefore_model",
                decision="skip_compression",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                fraction_snapshot=fraction_snapshot,
                compression_count=len(compression_messages),
                continuation_count=len(continuation_messages),
                trigger_fraction=trigger_fraction,
                reason="窗口占用比例未达到阈值",
            )
            return None

        compression_operation_id = new_id()
        logger.info(
            "[ContextCompressionMiddleware] 触发阻塞式上下文压缩 | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
            f"阈值={trigger_fraction:.4f}"
        )
        await self._emit_middleware_progress(
            stage="compression_started",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            token_count=fraction_snapshot["token_count"],
            window_fraction=fraction_snapshot["fraction"],
            trigger_fraction=trigger_fraction,
            compression_operation_id=compression_operation_id,
        )
        result = await self._service().generate_compression_result(
            session=session,
            messages=compression_messages,
            reason="automatic",
            trace_id=get_trace_id(),
            trace_record_id=get_trace_id(),
            active_session_id=active_session_id,
        )
        if not result.success or not result.replacement_messages:
            failure_reason = result.failure_reason or "generation_failed"
            await self._emit_middleware_progress(
                stage="compression_failed",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                reason=failure_reason,
                compression_operation_id=compression_operation_id,
            )
            raise RuntimeError(f"context_compression_failed:{failure_reason}")

        epoch = self._mark_context_compressed(
            original_session_id=original_session_id,
            active_session_id=active_session_id,
        )
        await self._emit_middleware_progress(
            stage="compression_completed",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            context_compression_epoch=epoch,
            compression_message_count=len(compression_messages),
            total_message_count=len(messages),
            continuation_message_count=len(continuation_messages),
            retain_message_count=len(continuation_messages),
            compression_operation_id=compression_operation_id,
        )
        self._log_compression_decision(
            hook="abefore_model",
            decision="return_compressed_context",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            fraction_snapshot=fraction_snapshot,
            compression_count=len(compression_messages),
            continuation_count=len(continuation_messages),
            trigger_fraction=trigger_fraction,
            reason="阻塞式压缩完成，本次模型调用使用压缩后的上下文",
        )
        return {
            "messages": [
                RemoveMessage(id=REMOVE_ALL_MESSAGES),
                *result.replacement_messages,
                *continuation_messages,
            ]
        }

    async def aafter_agent(self, state: Any, runtime: Any) -> dict | None:
        return None

    def _extract_usage_total_tokens(self, messages: list[BaseMessage]) -> int | None:
        usage = self._latest_usage_total_tokens_with_index(messages)
        return usage[1] if usage is not None else None

    def _calculate_before_model_fraction(
        self,
        *,
        messages: list[BaseMessage],
        continuation_messages: list[BaseMessage],
        session_context_window_usage: dict[str, Any] | None,
    ) -> dict[str, Any]:
        latest_usage = self._latest_usage_total_tokens_with_index(messages)
        usage_source = "missing"
        if latest_usage is not None:
            latest_usage_index, usage_token_count = latest_usage
            pending_messages = messages[latest_usage_index + 1 :]
            usage_source = "message_usage_metadata"
        else:
            usage_token_count = self._usage_total_tokens_from_snapshot(session_context_window_usage)
            pending_messages = continuation_messages
            if usage_token_count is not None:
                usage_source = "persisted_context_window_usage"

        estimated_pending_token_count = self._calculate_approximate_token_count(pending_messages)
        token_count = int(usage_token_count or 0) + estimated_pending_token_count
        context_window = max(int(self.settings.context_window_tokens), 1)
        token_source = (
            "usage_metadata_plus_pending_estimate"
            if usage_token_count is not None
            else "pending_estimate"
        )
        return {
            "token_count": token_count,
            "context_window": context_window,
            "fraction": token_count / context_window,
            "token_source": token_source,
            "usage_token_count": usage_token_count,
            "estimated_pending_token_count": estimated_pending_token_count,
            "pending_message_count": len(pending_messages),
            "usage_source": usage_source,
        }

    @staticmethod
    def _latest_usage_total_tokens_with_index(
        messages: list[BaseMessage],
    ) -> tuple[int, int] | None:
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            usage_metadata = getattr(message, "usage_metadata", None)
            if not usage_metadata:
                continue
            total_tokens = (
                usage_metadata.get("total_tokens")
                if isinstance(usage_metadata, dict)
                else getattr(usage_metadata, "total_tokens", None)
            )
            try:
                if total_tokens is not None and int(total_tokens) > 0:
                    return index, int(total_tokens)
            except (TypeError, ValueError):
                continue
        return None

    @staticmethod
    def _usage_total_tokens_from_snapshot(snapshot: dict[str, Any] | None) -> int | None:
        if not isinstance(snapshot, dict):
            return None
        for key in ("usage_token_count", "base_usage_token_count"):
            value = snapshot.get(key)
            try:
                if value is not None and int(value) > 0:
                    return int(value)
            except (TypeError, ValueError):
                continue
        if snapshot.get("token_source") != "usage_metadata":
            return None
        value = snapshot.get("token_count")
        try:
            if value is not None and int(value) > 0:
                return int(value)
        except (TypeError, ValueError):
            return None
        return None

    def _calculate_token_count(self, messages: list[BaseMessage]) -> int:
        real_token_count = self._extract_usage_total_tokens(messages)
        if real_token_count is not None:
            return real_token_count
        return self._calculate_approximate_token_count(messages)

    def _calculate_message_fraction(self, messages: list[BaseMessage]) -> dict[str, Any]:
        token_count = self._calculate_token_count(messages)
        context_window = max(int(self.settings.context_window_tokens), 1)
        return {
            "token_count": token_count,
            "context_window": context_window,
            "fraction": token_count / context_window,
        }

    def _calculate_display_message_fraction(
        self,
        messages: list[BaseMessage],
        *,
        usage_total_tokens: int | None = None,
    ) -> dict[str, Any]:
        token_count = (
            usage_total_tokens
            if usage_total_tokens is not None and usage_total_tokens > 0
            else self._calculate_approximate_token_count(messages)
        )
        context_window = max(int(self.settings.context_window_tokens), 1)
        return {
            "token_count": max(int(token_count), 0),
            "context_window": context_window,
            "fraction": max(int(token_count), 0) / context_window,
        }

    def _calculate_approximate_token_count(self, messages: list[BaseMessage]) -> int:
        if count_tokens_approximately is not None:
            try:
                token_count = count_tokens_approximately(
                    messages=messages,
                    chars_per_token=2.0,
                    extra_tokens_per_message=3.0,
                    tokens_per_image=85,
                    use_usage_metadata_scaling=False,
                )
                return max(int(token_count), 0)
            except Exception as exc:
                logger.debug(
                    f"[ContextCompressionMiddleware] 近似令牌计算失败，使用字符回退 | 错误={exc}"
                )
        return max(
            sum(
                int(len(str(getattr(message, "content", "") or "")) / 2) + 3 for message in messages
            ),
            0,
        )

    @staticmethod
    def _split_messages_for_blocking_compression(
        messages: list[BaseMessage],
    ) -> tuple[list[BaseMessage], list[BaseMessage]]:
        if not messages:
            return [], []

        current_turn_index: int | None = None
        for index in range(len(messages) - 1, -1, -1):
            if _message_flag(messages[index], CURRENT_TURN_MESSAGE_MARKER):
                current_turn_index = index
                break

        if current_turn_index is None:
            for index in range(len(messages) - 1, -1, -1):
                if isinstance(messages[index], HumanMessage):
                    current_turn_index = index
                    break

        if current_turn_index is None:
            return messages, []

        tail_start = current_turn_index
        while tail_start > 0 and _message_flag(messages[tail_start - 1], INJECTED_MESSAGE_MARKER):
            tail_start -= 1

        # Tool results after the current user message can dominate the next model call.
        # Compress the whole visible state, then replay only the current request.
        if any(
            not _message_flag(message, INJECTED_MESSAGE_MARKER)
            for message in messages[current_turn_index + 1 :]
        ):
            return messages, messages[tail_start : current_turn_index + 1]

        return messages[:tail_start], messages[tail_start:]

    def _mark_context_compressed(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
    ) -> int:
        increment = getattr(self.repositories.sessions, "increment_context_compression_epoch", None)
        if not callable(increment):
            return 0
        epoch = int(increment(original_session_id) or 0)
        logger.info(
            "[ContextCompressionMiddleware] 上下文压缩代次已递增 | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"压缩代次={epoch}"
        )
        return epoch

    async def _emit_middleware_progress(
        self,
        *,
        stage: str,
        original_session_id: str,
        active_session_id: str,
        **payload: Any,
    ) -> None:
        try:
            trace_id = get_trace_id()
            compression_operation_id = str(payload.get("compression_operation_id") or "").strip()
            await self.dispatcher.emit_event(
                event_type=DomainEventType.MIDDLEWARE_PROGRESS.value,
                source="context_compression_middleware",
                payload={
                    "middleware": "ContextCompressionMiddleware",
                    "stage": stage,
                    "compression_mode": "context",
                    "compression_reason": "automatic",
                    "notice_id": self._compression_notice_id(
                        stage=stage,
                        original_session_id=original_session_id,
                        active_session_id=active_session_id,
                        trace_id=trace_id,
                        compression_operation_id=compression_operation_id,
                    ),
                    "session_id": original_session_id,
                    "active_session_id": active_session_id,
                    "trace_id": trace_id,
                    **payload,
                },
                trace_id=trace_id,
                user_id=get_user_id(),
                original_session_id=original_session_id,
                active_session_id=active_session_id,
            )
        except Exception as exc:
            logger.debug(
                "[ContextCompressionMiddleware] 中间件进度事件写入失败 | "
                f"阶段={_compression_display_label(stage)} | 错误={exc}"
            )

    async def _emit_context_window_snapshot(
        self,
        *,
        hook: str,
        original_session_id: str,
        active_session_id: str,
        fraction_snapshot: dict[str, Any],
        total_message_count: int,
        compression_count: int,
        continuation_count: int,
        **extra_payload: Any,
    ) -> None:
        token_count = max(int(fraction_snapshot["token_count"]), 0)
        context_window = max(int(fraction_snapshot["context_window"]), 1)
        window_fraction = float(fraction_snapshot["fraction"])
        trigger_fraction = self._get_trigger_fraction()
        threshold_token_count = max(int(context_window * trigger_fraction), 1)
        threshold_usage_fraction = token_count / threshold_token_count
        remaining_to_threshold_tokens = threshold_token_count - token_count
        timestamp_ms = int(time.time() * 1000)
        trace_id = get_trace_id()
        snapshot_payload = {
            "middleware": "ContextCompressionMiddleware",
            "stage": "context_window_snapshot",
            "compression_mode": "snapshot",
            "session_id": original_session_id,
            "active_session_id": active_session_id,
            "trace_id": trace_id,
            "timestamp_ms": timestamp_ms,
            "snapshot_hook": hook,
            "token_count": token_count,
            "context_window": context_window,
            "window_fraction": window_fraction,
            "trigger_fraction": trigger_fraction,
            "threshold_fraction": trigger_fraction,
            "threshold_token_count": threshold_token_count,
            "threshold_usage_fraction": threshold_usage_fraction,
            "remaining_to_threshold_tokens": remaining_to_threshold_tokens,
            "compression_available": compression_count > 0,
            "total_message_count": total_message_count,
            "compression_message_count": compression_count,
            "continuation_message_count": continuation_count,
            "retain_message_count": continuation_count,
            **extra_payload,
        }
        self._persist_context_window_snapshot(
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            snapshot_payload=snapshot_payload,
        )
        await self._emit_middleware_progress(
            stage="context_window_snapshot",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            compression_mode="snapshot",
            **{
                key: value
                for key, value in snapshot_payload.items()
                if key
                not in {
                    "middleware",
                    "stage",
                    "compression_mode",
                    "session_id",
                    "active_session_id",
                    "trace_id",
                }
            },
        )

    def _persist_context_window_snapshot(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        snapshot_payload: dict[str, Any],
    ) -> None:
        try:
            record = self.repositories.sessions.update_context_window_usage(
                original_session_id,
                snapshot_payload,
            )
            if record is None:
                logger.debug(
                    "[ContextCompressionMiddleware] 上下文窗口状态持久化跳过，会话不存在 | "
                    f"原始会话ID={original_session_id} | 活动会话ID={active_session_id}"
                )
                return
        except Exception as exc:
            logger.debug(
                "[ContextCompressionMiddleware] 上下文窗口状态持久化失败 | "
                f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | 错误={exc}"
            )

    async def _emit_model_call_window_snapshot(
        self,
        *,
        hook: str,
        call_phase: str,
        call_status: str,
        token_source: str,
        original_session_id: str,
        active_session_id: str,
        messages: list[BaseMessage],
        usage_total_tokens: int | None = None,
    ) -> None:
        fraction_snapshot = self._calculate_display_message_fraction(
            messages,
            usage_total_tokens=usage_total_tokens,
        )
        await self._emit_context_window_snapshot(
            hook=hook,
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            fraction_snapshot=fraction_snapshot,
            total_message_count=len(messages),
            compression_count=0,
            continuation_count=len(messages),
            call_phase=call_phase,
            call_status=call_status,
            token_source=token_source,
            usage_token_count=usage_total_tokens,
        )

    @staticmethod
    def _model_request_messages(request: ModelRequest) -> list[BaseMessage]:
        messages: list[BaseMessage] = []
        system_message = getattr(request, "system_message", None)
        if isinstance(system_message, BaseMessage):
            messages.append(system_message)
        for message in getattr(request, "messages", []) or []:
            if isinstance(message, BaseMessage):
                messages.append(message)
        return messages

    @staticmethod
    def _model_response_messages(
        response: ModelResponse | ExtendedModelResponse | AIMessage,
    ) -> list[BaseMessage]:
        if isinstance(response, BaseMessage):
            return [response]
        model_response = getattr(response, "model_response", None)
        if model_response is not None:
            response = model_response
        result = getattr(response, "result", None)
        if not isinstance(result, list):
            return []
        return [message for message in result if isinstance(message, BaseMessage)]

    @staticmethod
    def _compression_notice_id(
        *,
        stage: str,
        original_session_id: str,
        active_session_id: str,
        trace_id: str | None,
        compression_operation_id: str | None = None,
    ) -> str:
        notice_key = trace_id or original_session_id or active_session_id
        if stage == "context_window_snapshot":
            return f"context-window:{notice_key}"
        if compression_operation_id:
            return f"context-compression:{notice_key}:{compression_operation_id}"
        return f"context-compression:{notice_key}"

    @staticmethod
    def _compression_skip_reason(
        *,
        fraction_snapshot: dict[str, Any],
        compression_count: int,
        threshold: float,
    ) -> str:
        if compression_count <= 0:
            return "没有可压缩消息"
        if float(fraction_snapshot["fraction"]) < threshold:
            return "窗口占用比例未达到阈值"
        return "不满足压缩条件"

    @staticmethod
    def _log_compression_decision(
        *,
        hook: str,
        decision: str,
        original_session_id: str,
        active_session_id: str,
        fraction_snapshot: dict[str, Any],
        compression_count: int,
        continuation_count: int,
        trigger_fraction: float,
        reason: str,
    ) -> None:
        logger.debug(
            "[ContextCompressionMiddleware] 压缩决策 | "
            f"钩子={_compression_display_label(hook)} | "
            f"决策={_compression_display_label(decision)} | 原因={reason} | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"令牌数={fraction_snapshot['token_count']} | "
            f"上下文窗口={fraction_snapshot['context_window']} | "
            f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
            f"阈值={trigger_fraction:.4f} | "
            f"压缩消息数={compression_count} | 续接消息数={continuation_count}"
        )

    @staticmethod
    def _log_skip(
        hook: str,
        reason: str,
        original_session_id: str | None,
        active_session_id: str | None,
    ) -> None:
        logger.debug(
            "[ContextCompressionMiddleware] hook 跳过 | "
            f"钩子={_compression_display_label(hook)} | "
            f"原因={_compression_display_label(reason)} | "
            f"原始会话ID={original_session_id or '(空)'} | "
            f"活动会话ID={active_session_id or '(空)'}"
        )

    @staticmethod
    def _log_fraction_snapshot(
        stage: str,
        original_session_id: str,
        active_session_id: str,
        fraction_snapshot: dict[str, Any],
        *,
        total_message_count: int,
        compression_count: int,
        continuation_count: int,
        trigger_fraction: float,
    ) -> None:
        logger.debug(
            "[ContextCompressionMiddleware] 窗口占用快照 | "
            f"阶段={_compression_display_label(stage)} | 原始会话ID={original_session_id} | "
            f"活动会话ID={active_session_id} | "
            f"令牌数={fraction_snapshot['token_count']} | "
            f"上下文窗口={fraction_snapshot['context_window']} | "
            f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
            f"阈值={trigger_fraction:.4f} | "
            f"总消息数={total_message_count} | 压缩消息数={compression_count} | "
            f"续接消息数={continuation_count}"
        )


def _message_flag(message: BaseMessage, key: str) -> bool:
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict) and additional_kwargs.get(key) is True:
        return True
    return bool(getattr(message, key, False) is True)
