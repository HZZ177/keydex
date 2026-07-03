from __future__ import annotations

import asyncio
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
from langchain_core.messages import AIMessage, BaseMessage, RemoveMessage

try:
    from langchain_core.messages.utils import count_tokens_approximately
except Exception:  # pragma: no cover - 兼容不同 langchain-core 小版本
    count_tokens_approximately = None
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.context_compression_utils import (
    apply_compression_anchor_replacement,
    extract_compression_material,
    split_and_prepare_compression,
)
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
from backend.app.storage import CompressionStagingRecord, StorageRepositories


class ContextCompressionMiddleware(AgentMiddleware):
    """基座同款上下文压缩中间件。

    模型调用前优先消费上一轮后台压缩落库的暂存产物，必要时执行阻塞式紧急压缩；
    代理完成后只判断是否达到常规阈值，并异步生成压缩产物、派生新的活动会话。
    """

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
        self._schedule_task = schedule_task or asyncio.create_task
        self._compression_service = compression_service

    def _service(self) -> ContextCompressionService:
        return self._compression_service or ContextCompressionService(
            self.repositories,
            factory=self.factory,
            http_transport=self.http_transport,
        )

    def _get_retain_rounds(self) -> int:
        return max(0, int(self.settings.retain_rounds))

    def _get_trigger_fraction(self) -> float:
        value = float(self.settings.trigger_fraction)
        if value <= 0 or value >= float(self.settings.emergency_fraction):
            return self.DEFAULT_TRIGGER_FRACTION
        return value

    def _extract_usage_total_tokens(self, messages: list[BaseMessage]) -> int | None:
        for message in reversed(messages):
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
                    return int(total_tokens)
            except (TypeError, ValueError):
                continue
        return None

    def _calculate_token_count(self, messages: list[BaseMessage]) -> int:
        real_token_count = self._extract_usage_total_tokens(messages)
        if real_token_count is not None:
            return real_token_count
        if count_tokens_approximately is not None:
            try:
                token_count = count_tokens_approximately(
                    messages=messages,
                    chars_per_token=2.0,
                    extra_tokens_per_message=3.0,
                    tokens_per_image=85,
                    use_usage_metadata_scaling=True,
                )
                return max(int(token_count), 0)
            except Exception as exc:
                logger.debug(
                    "[ContextCompressionMiddleware] 近似令牌计算失败，使用字符回退 | "
                    f"错误={exc}"
                )
        return max(
            sum(
                int(len(str(getattr(message, "content", "") or "")) / 2) + 3
                for message in messages
            ),
            0,
        )

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
                    "[ContextCompressionMiddleware] 展示用近似令牌计算失败，使用字符回退 | "
                    f"错误={exc}"
                )
        return max(
            sum(
                int(len(str(getattr(message, "content", "") or "")) / 2) + 3
                for message in messages
            ),
            0,
        )

    def _should_schedule_background_compression(
        self,
        fraction_snapshot: dict[str, Any],
        compression_count: int,
    ) -> bool:
        return (
            compression_count > 0
            and float(fraction_snapshot["fraction"]) >= self._get_trigger_fraction()
        )

    def _should_trigger_emergency_compression(
        self,
        fraction_snapshot: dict[str, Any],
        compression_count: int,
    ) -> bool:
        return compression_count > 0 and float(fraction_snapshot["fraction"]) >= float(
            self.settings.emergency_fraction
        )

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
        staging_replacement_applied = False
        latest_staging: CompressionStagingRecord | None = None

        if not messages:
            self._log_skip("abefore_model", "no_messages", original_session_id, active_session_id)
            return None
        if not original_session_id or not active_session_id:
            self._log_skip(
                "abefore_model", "missing_session", original_session_id, active_session_id
            )
            return None

        try:
            latest_staging = self._get_latest_pending_staging(
                original_session_id=original_session_id,
                target_session_id=active_session_id,
            )
            self._log_staging_lookup(
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                staging=latest_staging,
            )
            if latest_staging is not None:
                replacement = apply_compression_anchor_replacement(
                    messages=messages,
                    anchor_message_id=latest_staging.anchor_message_id,
                    l1_content=latest_staging.l1_content or "",
                    l2_content=latest_staging.l2_content,
                )
                if not replacement.applied:
                    self._mark_staging_failed(latest_staging.id, "anchor_not_found")
                    logger.warning(
                        "[ContextCompressionMiddleware] 压缩暂存应用失败 | "
                        f"原始会话ID={original_session_id} | "
                        f"活动会话ID={active_session_id} | "
                        f"暂存记录ID={latest_staging.id} | 原因=未找到锚点"
                    )
                    await self._emit_middleware_progress(
                        stage="staging_failed",
                        original_session_id=original_session_id,
                        active_session_id=active_session_id,
                        staging_id=latest_staging.id,
                        reason="anchor_not_found",
                    )
                else:
                    self._mark_staging_applied(latest_staging.id)
                    messages = replacement.replaced_messages
                    staging_replacement_applied = True
                    context_compression_epoch = self._mark_context_compressed(
                        original_session_id=original_session_id,
                        active_session_id=active_session_id,
                        stage="staging_applied",
                    )
                    logger.info(
                        "[ContextCompressionMiddleware] 压缩暂存应用成功 | "
                        f"原始会话ID={original_session_id} | "
                        f"活动会话ID={active_session_id} | "
                        f"暂存记录ID={latest_staging.id} | "
                        f"压缩代次={context_compression_epoch}"
                    )
                    await self._emit_middleware_progress(
                        stage="staging_applied",
                        original_session_id=original_session_id,
                        active_session_id=active_session_id,
                        staging_id=latest_staging.id,
                        context_compression_epoch=context_compression_epoch,
                    )

            _snapshot, split_result, _anchor_message_id = split_and_prepare_compression(
                messages=messages,
                retain_rounds=self._get_retain_rounds(),
            )
            fraction_snapshot = (
                self._calculate_message_fraction(messages)
                if split_result.compression_zone
                else {
                    "token_count": 0,
                    "context_window": self.settings.context_window_tokens,
                    "fraction": 0.0,
                }
            )
            self._log_fraction_snapshot(
                "abefore_model",
                original_session_id,
                active_session_id,
                fraction_snapshot,
                total_message_count=len(messages),
                compression_count=len(split_result.compression_zone),
                retain_count=len(split_result.retain_zone),
                trigger_fraction=self._get_trigger_fraction(),
                emergency_fraction=float(self.settings.emergency_fraction),
            )

            should_trigger_emergency = self._should_trigger_emergency_compression(
                fraction_snapshot,
                len(split_result.compression_zone),
            )
            self._log_compression_decision(
                hook="abefore_model",
                decision=(
                    "trigger_emergency_compression"
                    if should_trigger_emergency
                    else "skip_emergency_compression"
                ),
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                fraction_snapshot=fraction_snapshot,
                compression_count=len(split_result.compression_zone),
                retain_count=len(split_result.retain_zone),
                trigger_fraction=self._get_trigger_fraction(),
                emergency_fraction=float(self.settings.emergency_fraction),
                reason=(
                    "已达到紧急压缩阈值"
                    if should_trigger_emergency
                    else self._compression_skip_reason(
                        fraction_snapshot=fraction_snapshot,
                        compression_count=len(split_result.compression_zone),
                        threshold=float(self.settings.emergency_fraction),
                    )
                ),
                staging_applied=staging_replacement_applied,
            )
            if not should_trigger_emergency:
                if latest_staging is None:
                    return None
                self._log_compression_decision(
                    hook="abefore_model",
                    decision="return_staging_replaced_context",
                    original_session_id=original_session_id,
                    active_session_id=active_session_id,
                    fraction_snapshot=fraction_snapshot,
                    compression_count=len(split_result.compression_zone),
                    retain_count=len(split_result.retain_zone),
                    trigger_fraction=self._get_trigger_fraction(),
                    emergency_fraction=float(self.settings.emergency_fraction),
                    reason="已应用暂存压缩结果，本次模型调用使用替换后的上下文",
                    staging_applied=staging_replacement_applied,
                )
                return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *messages]}

            logger.warning(
                "[ContextCompressionMiddleware] 命中紧急压缩阈值 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | "
                f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
                f"紧急阈值={self.settings.emergency_fraction:.4f}"
            )
            await self._emit_middleware_progress(
                stage="emergency_triggered",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                token_count=fraction_snapshot["token_count"],
                window_fraction=fraction_snapshot["fraction"],
                trigger_fraction=self.settings.emergency_fraction,
            )
            emergency_messages = await self._run_sync_emergency_compression(
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                messages=messages,
            )
            if emergency_messages is None:
                self._log_compression_decision(
                    hook="abefore_model",
                    decision="emergency_compression_fallback",
                    original_session_id=original_session_id,
                    active_session_id=active_session_id,
                    fraction_snapshot=fraction_snapshot,
                    compression_count=len(split_result.compression_zone),
                    retain_count=len(split_result.retain_zone),
                    trigger_fraction=self._get_trigger_fraction(),
                    emergency_fraction=float(self.settings.emergency_fraction),
                    reason="紧急压缩未生成可替换上下文，回退到当前上下文",
                    staging_applied=staging_replacement_applied,
                )
                if latest_staging is None:
                    return None
                return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *messages]}
            self._log_compression_decision(
                hook="abefore_model",
                decision="return_emergency_compressed_context",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                fraction_snapshot=fraction_snapshot,
                compression_count=len(split_result.compression_zone),
                retain_count=len(split_result.retain_zone),
                trigger_fraction=self._get_trigger_fraction(),
                emergency_fraction=float(self.settings.emergency_fraction),
                reason="紧急压缩完成，本次模型调用使用压缩后的上下文",
                staging_applied=staging_replacement_applied,
            )
            return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *emergency_messages]}
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ContextCompressionMiddleware] 模型调用前压缩异常，降级为原始上下文 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | 错误={exc}"
            )
            if latest_staging is not None and staging_replacement_applied:
                return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *messages]}
            return None

    async def aafter_agent(self, state: Any, runtime: Any) -> dict | None:
        if not self.settings.enabled:
            return None
        original_session_id = get_session_id()
        active_session_id = get_active_session_id()
        messages = _state_messages(state)
        if not messages:
            self._log_skip("aafter_agent", "no_messages", original_session_id, active_session_id)
            return None
        if not original_session_id or not active_session_id:
            self._log_skip(
                "aafter_agent", "missing_session", original_session_id, active_session_id
            )
            return None

        snapshot, split_result, anchor_message_id = split_and_prepare_compression(
            messages=messages,
            retain_rounds=self._get_retain_rounds(),
        )
        fraction_snapshot = (
            self._calculate_message_fraction(messages)
            if split_result.compression_zone
            else {
                "token_count": 0,
                "context_window": self.settings.context_window_tokens,
                "fraction": 0.0,
            }
        )
        self._log_fraction_snapshot(
            "aafter_agent",
            original_session_id,
            active_session_id,
            fraction_snapshot,
            total_message_count=len(messages),
            compression_count=len(split_result.compression_zone),
            retain_count=len(split_result.retain_zone),
            trigger_fraction=self._get_trigger_fraction(),
            emergency_fraction=float(self.settings.emergency_fraction),
        )
        trigger_fraction = self._get_trigger_fraction()
        should_schedule_background = self._should_schedule_background_compression(
            fraction_snapshot,
            len(split_result.compression_zone),
        )
        self._log_compression_decision(
            hook="aafter_agent",
            decision=(
                "schedule_background_compression"
                if should_schedule_background
                else "skip_background_compression"
            ),
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            fraction_snapshot=fraction_snapshot,
            compression_count=len(split_result.compression_zone),
            retain_count=len(split_result.retain_zone),
            trigger_fraction=trigger_fraction,
            emergency_fraction=float(self.settings.emergency_fraction),
            reason=(
                "已达到后台压缩阈值"
                if should_schedule_background
                else self._compression_skip_reason(
                    fraction_snapshot=fraction_snapshot,
                    compression_count=len(split_result.compression_zone),
                    threshold=trigger_fraction,
                )
            ),
        )
        if not should_schedule_background:
            return None

        session = self.repositories.sessions.get(original_session_id)
        if session is None:
            self._log_skip(
                "aafter_agent", "session_not_found", original_session_id, active_session_id
            )
            return None

        material = extract_compression_material(
            snapshot=snapshot,
            split_result=split_result,
            anchor_message_id=anchor_message_id,
            trace_id=get_trace_id(),
            trace_record_id=get_trace_id(),
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            scene_id=session.scene_id,
            scene_version_seq=session.scene_version_seq,
            side_event_metadata=self._build_compression_side_event_metadata(
                mode="background",
                hook="aafter_agent",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
            ),
        )
        logger.info(
            "[ContextCompressionMiddleware] 命中后台压缩阈值 | "
            f"原始会话ID={original_session_id} | "
            f"活动会话ID={active_session_id} | "
            f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
            f"常规阈值={trigger_fraction:.4f}"
        )
        await self._emit_middleware_progress(
            stage="background_triggered",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            token_count=fraction_snapshot["token_count"],
            window_fraction=fraction_snapshot["fraction"],
            trigger_fraction=trigger_fraction,
        )
        task = self._schedule_task(
            self._run_background_compression(
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                material=material,
            )
        )
        logger.debug(
            "[ContextCompressionMiddleware] 已启动后台压缩任务 | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"任务ID={id(task)}"
        )
        return None

    def _get_latest_pending_staging(
        self,
        *,
        original_session_id: str,
        target_session_id: str,
    ) -> CompressionStagingRecord | None:
        return self.repositories.compression_staging.get_latest(
            original_session_id=original_session_id,
            status="pending",
            target_session_id=target_session_id,
        )

    def _mark_staging_applied(self, staging_id: int) -> None:
        self.repositories.compression_staging.mark_status(staging_id, status="applied")

    def _mark_staging_failed(self, staging_id: int, reason: str) -> None:
        self.repositories.compression_staging.mark_status(
            staging_id,
            status="failed",
            failure_reason=reason,
        )

    def _mark_context_compressed(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        stage: str,
    ) -> int:
        increment = getattr(self.repositories.sessions, "increment_context_compression_epoch", None)
        if not callable(increment):
            return 0
        epoch = int(increment(original_session_id) or 0)
        logger.info(
            "[ContextCompressionMiddleware] 上下文压缩代次已递增 | "
            f"阶段={_compression_display_label(stage)} | "
            f"原始会话ID={original_session_id} | "
            f"活动会话ID={active_session_id} | 压缩代次={epoch}"
        )
        return epoch

    async def _run_sync_emergency_compression(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        messages: list[BaseMessage],
    ) -> list[BaseMessage] | None:
        session = self.repositories.sessions.get(original_session_id)
        if session is None:
            return None
        snapshot, split_result, anchor_message_id = split_and_prepare_compression(
            messages=messages,
            retain_rounds=self._get_retain_rounds(),
        )
        if not split_result.compression_zone:
            return None
        logger.debug(
            "[ContextCompressionMiddleware] 开始同步紧急压缩 | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"压缩区消息数={len(split_result.compression_zone)} | "
            f"保留区消息数={len(split_result.retain_zone)} | "
            f"保留轮数={self._get_retain_rounds()}"
        )
        material = extract_compression_material(
            snapshot=snapshot,
            split_result=split_result,
            anchor_message_id=anchor_message_id,
            trace_id=get_trace_id(),
            trace_record_id=get_trace_id(),
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            scene_id=session.scene_id,
            scene_version_seq=session.scene_version_seq,
            side_event_metadata=self._build_compression_side_event_metadata(
                mode="emergency",
                hook="abefore_model",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
            ),
        )
        result = await self._service().generate_compression_result(material=material)
        if not result.success:
            logger.warning(
                "[ContextCompressionMiddleware] 紧急压缩生成失败 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | "
                f"原因={result.failure_reason or '-'}"
            )
            await self._emit_middleware_progress(
                stage="emergency_failed",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                reason=result.failure_reason,
            )
            return None
        replacement = apply_compression_anchor_replacement(
            messages=messages,
            anchor_message_id=material.anchor_message_id,
            l1_content=result.new_l1_content or "",
            l2_content=result.new_l2_content,
        )
        if not replacement.applied:
            logger.warning(
                "[ContextCompressionMiddleware] 紧急压缩替换失败 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | "
                "原因=未找到锚点"
            )
            await self._emit_middleware_progress(
                stage="emergency_replacement_failed",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                reason="anchor_not_found",
            )
            return None
        context_compression_epoch = self._mark_context_compressed(
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            stage="emergency_completed",
        )
        await self._emit_middleware_progress(
            stage="emergency_completed",
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            anchor_message_id=replacement.anchor_message_id,
            context_compression_epoch=context_compression_epoch,
        )
        return replacement.replaced_messages

    async def _run_background_compression(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        material: Any,
    ) -> None:
        try:
            if not material.compression_zone_messages:
                return
            logger.debug(
                "[ContextCompressionMiddleware] 开始后台压缩生成 | "
                f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
                f"压缩区消息数={len(material.compression_zone_messages)} | "
                f"锚点消息ID={material.anchor_message_id or '-'} | 阶段={material.phase}"
            )
            result = await self._service().generate_compression_result(material=material)
            if not result.success:
                logger.warning(
                    "[ContextCompressionMiddleware] 后台压缩生成失败 | "
                    f"原始会话ID={original_session_id} | "
                    f"活动会话ID={active_session_id} | "
                    f"原因={result.failure_reason or '-'}"
                )
                await self._emit_middleware_progress(
                    stage="background_failed",
                    original_session_id=original_session_id,
                    active_session_id=active_session_id,
                    reason=result.failure_reason,
                )
                return

            generation = self.repositories.compression_staging.next_generation(original_session_id)
            new_active_session_id = self._fork_active_session_for_compression(
                original_session_id=original_session_id,
                active_session_id=active_session_id,
            )
            if not new_active_session_id:
                await self._emit_middleware_progress(
                    stage="background_fork_failed",
                    original_session_id=original_session_id,
                    active_session_id=active_session_id,
                    reason="fork_active_session_failed",
                )
                return
            staging = self.repositories.compression_staging.create_with_latest_priority(
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                target_session_id=new_active_session_id,
                generation=generation,
                anchor_message_id=material.anchor_message_id,
                l1_content=result.new_l1_content,
                l2_content=result.new_l2_content,
            )
            self._finalize_background_switch(
                original_session_id=original_session_id,
                previous_active_session_id=active_session_id,
                new_active_session_id=new_active_session_id,
            )
            logger.info(
                "[ContextCompressionMiddleware] 后台压缩完成并切换活动会话 | "
                f"原始会话ID={original_session_id} | "
                f"上一活动会话ID={active_session_id} | "
                f"新活动会话ID={new_active_session_id} | 暂存记录ID={staging.id}"
            )
            await self._emit_middleware_progress(
                stage="background_completed",
                original_session_id=original_session_id,
                active_session_id=new_active_session_id,
                previous_active_session_id=active_session_id,
                new_active_session_id=new_active_session_id,
                staging_id=staging.id,
            )
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ContextCompressionMiddleware] 后台压缩失败 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | 错误={exc}"
            )
            await self._emit_middleware_progress(
                stage="background_failed",
                original_session_id=original_session_id,
                active_session_id=active_session_id,
                reason=str(exc),
            )

    def _fork_active_session_for_compression(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
    ) -> str | None:
        if not self._is_current_active_session(original_session_id, active_session_id):
            logger.info(
                "[ContextCompressionMiddleware] 后台压缩放弃切换 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | "
                "原因=活动会话已变化"
            )
            return None
        latest_checkpoint = self._latest_checkpoint_config(active_session_id)
        if latest_checkpoint is None:
            logger.warning(
                "[ContextCompressionMiddleware] 后台压缩放弃切换 | "
                f"原始会话ID={original_session_id} | "
                f"活动会话ID={active_session_id} | "
                "原因=未找到检查点"
            )
            return None
        previous_session = self.repositories.sessions.get(active_session_id)
        if previous_session is None:
            return None

        new_active_session_id = new_id()
        self.repositories.sessions.create(
            session_id=new_active_session_id,
            user_id=previous_session.user_id,
            scene_id=previous_session.scene_id,
            scene_version_seq=previous_session.scene_version_seq,
            status="active",
            session_tag=previous_session.session_tag,
            active_session_id=new_active_session_id,
            is_debug=previous_session.is_debug,
            workspace_id=previous_session.workspace_id,
            session_type=previous_session.session_type,
            cwd=previous_session.cwd,
            workspace_roots=previous_session.workspace_roots,
            current_model_provider_id=previous_session.current_model_provider_id,
            current_model=previous_session.current_model,
            context_compression_epoch=previous_session.context_compression_epoch,
            title=previous_session.title,
            title_source=previous_session.title_source,
            parent_session_id=active_session_id,
            source_trace_id=get_trace_id() or previous_session.source_trace_id,
            source_active_session_id=active_session_id,
            source_checkpoint_id=latest_checkpoint["checkpoint_id"],
            source_checkpoint_ns=latest_checkpoint["checkpoint_ns"],
        )
        try:
            self.checkpointer.clone_checkpoint_to_thread(
                source_thread_id=active_session_id,
                target_thread_id=new_active_session_id,
                checkpoint_id=str(latest_checkpoint["checkpoint_id"]),
                checkpoint_ns=str(latest_checkpoint["checkpoint_ns"] or ""),
            )
        except Exception:
            self.repositories.sessions.soft_delete(new_active_session_id)
            if hasattr(self.checkpointer, "delete_thread"):
                self.checkpointer.delete_thread(new_active_session_id)
            raise
        return new_active_session_id

    def _latest_checkpoint_config(self, active_session_id: str) -> dict[str, str] | None:
        if self.checkpointer is None or not hasattr(self.checkpointer, "get_tuple"):
            return None
        checkpoint = self.checkpointer.get_tuple(
            {"configurable": {"thread_id": active_session_id, "checkpoint_ns": ""}}
        )
        if checkpoint is None:
            return None
        configurable = checkpoint.config.get("configurable", {})
        checkpoint_id = configurable.get("checkpoint_id")
        if not checkpoint_id:
            return None
        return {
            "checkpoint_id": str(checkpoint_id),
            "checkpoint_ns": str(configurable.get("checkpoint_ns") or ""),
        }

    def _is_current_active_session(self, original_session_id: str, active_session_id: str) -> bool:
        original = self.repositories.sessions.get(original_session_id)
        if original is None:
            return False
        return (original.active_session_id or original.id) == active_session_id

    def _finalize_background_switch(
        self,
        *,
        original_session_id: str,
        previous_active_session_id: str,
        new_active_session_id: str,
    ) -> None:
        original = self.repositories.sessions.get(original_session_id)
        if original is None:
            return
        current_active_session_id = original.active_session_id or original.id
        allowed = {original_session_id, previous_active_session_id, new_active_session_id}
        if current_active_session_id not in allowed:
            logger.info(
                "[ContextCompressionMiddleware] 活动会话切换跳过 | "
                f"原始会话ID={original_session_id} | "
                f"上一活动会话ID={previous_active_session_id} | "
                f"新活动会话ID={new_active_session_id} | "
                f"当前活动会话ID={current_active_session_id} | "
                "原因=活动会话已变化"
            )
            return
        self.repositories.sessions.update(
            original_session_id, active_session_id=new_active_session_id
        )
        self.repositories.sessions.update(
            previous_active_session_id,
            child_session_id=new_active_session_id,
        )
        self.repositories.sessions.update(
            new_active_session_id,
            parent_session_id=previous_active_session_id,
        )

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
            compression_mode = "emergency" if stage.startswith("emergency_") else "background"
            await self.dispatcher.emit_event(
                event_type=DomainEventType.MIDDLEWARE_PROGRESS.value,
                source="context_compression_middleware",
                payload={
                    "middleware": "ContextCompressionMiddleware",
                    "stage": stage,
                    "compression_mode": compression_mode,
                    "notice_id": self._compression_notice_id(
                        stage=stage,
                        original_session_id=original_session_id,
                        active_session_id=active_session_id,
                        trace_id=trace_id,
                        payload=payload,
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
        retain_count: int,
        **extra_payload: Any,
    ) -> None:
        token_count = max(int(fraction_snapshot["token_count"]), 0)
        context_window = max(int(fraction_snapshot["context_window"]), 1)
        window_fraction = float(fraction_snapshot["fraction"])
        trigger_fraction = self._get_trigger_fraction()
        emergency_fraction = float(self.settings.emergency_fraction)
        threshold_token_count = max(int(context_window * trigger_fraction), 1)
        threshold_usage_fraction = token_count / threshold_token_count
        remaining_to_threshold_tokens = threshold_token_count - token_count
        call_phase_label = _compression_display_label(
            str(extra_payload.get("call_phase") or "-")
        )
        call_status_label = _compression_display_label(
            str(extra_payload.get("call_status") or "-")
        )
        token_source_label = _compression_display_label(
            str(extra_payload.get("token_source") or "-")
        )
        logger.debug(
            "[ContextCompressionMiddleware] 上下文窗口状态事件 | "
            f"钩子={_compression_display_label(hook)} | 原始会话ID={original_session_id} | "
            f"活动会话ID={active_session_id} | 令牌数={token_count} | "
            f"上下文窗口={context_window} | 窗口占用比例={window_fraction:.4f} | "
            f"常规阈值={trigger_fraction:.4f} | 常规阈值令牌数={threshold_token_count} | "
            f"阈值进度={threshold_usage_fraction:.4f} | "
            f"距离常规阈值令牌数={remaining_to_threshold_tokens} | "
            f"紧急阈值={emergency_fraction:.4f} | 总消息数={total_message_count} | "
            f"压缩区消息数={compression_count} | 保留区消息数={retain_count} | "
            f"调用阶段={call_phase_label} | "
            f"调用状态={call_status_label} | "
            f"令牌来源={token_source_label}"
        )
        trace_id = get_trace_id()
        timestamp_ms = int(time.time() * 1000)
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
            "emergency_fraction": emergency_fraction,
            "threshold_token_count": threshold_token_count,
            "threshold_usage_fraction": threshold_usage_fraction,
            "remaining_to_threshold_tokens": remaining_to_threshold_tokens,
            "compression_available": compression_count > 0,
            "total_message_count": total_message_count,
            "compression_message_count": compression_count,
            "retain_message_count": retain_count,
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
            logger.debug(
                "[ContextCompressionMiddleware] 上下文窗口状态已持久化 | "
                f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
                f"令牌数={snapshot_payload.get('token_count')} | "
                f"上下文窗口={snapshot_payload.get('context_window')}"
            )
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
            retain_count=len(messages),
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
        payload: dict[str, Any],
    ) -> str:
        if stage.startswith("emergency_"):
            notice_key = trace_id or original_session_id or active_session_id
            return f"context-compression:emergency:{notice_key}"
        return f"context-compression:staging:{payload.get('staging_id') or active_session_id}"

    @staticmethod
    def _build_compression_side_event_metadata(
        *,
        mode: str,
        hook: str,
        original_session_id: str,
        active_session_id: str,
    ) -> dict[str, Any]:
        background = mode == "background"
        metadata = {
            "mode": mode,
            "background": background,
            "hook": hook,
            "staging_strategy": "anchor_replacement",
            "previous_active_session_id": active_session_id,
            "original_session_id": original_session_id,
        }
        if background:
            metadata["background_task"] = "context_compression"
            metadata["background_task_type"] = "context_compression"
        return metadata

    @staticmethod
    def _log_staging_lookup(
        *,
        original_session_id: str,
        active_session_id: str,
        staging: CompressionStagingRecord | None,
    ) -> None:
        if staging is None:
            logger.debug(
                "[ContextCompressionMiddleware] 压缩暂存查询 | "
                f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
                "结果=无待应用暂存"
            )
            return
        logger.debug(
            "[ContextCompressionMiddleware] 压缩暂存查询 | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"结果=命中待应用暂存 | 暂存记录ID={staging.id} | "
            f"代次={staging.generation} | 锚点消息ID={staging.anchor_message_id}"
        )

    @staticmethod
    def _compression_skip_reason(
        *,
        fraction_snapshot: dict[str, Any],
        compression_count: int,
        threshold: float,
    ) -> str:
        if compression_count <= 0:
            return "没有可压缩消息区"
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
        retain_count: int,
        trigger_fraction: float,
        emergency_fraction: float,
        reason: str,
        staging_applied: bool | None = None,
    ) -> None:
        staging_text = "是" if staging_applied else "否"
        if staging_applied is None:
            staging_text = "不适用"
        logger.debug(
            "[ContextCompressionMiddleware] 压缩决策 | "
            f"钩子={_compression_display_label(hook)} | "
            f"决策={_compression_display_label(decision)} | 原因={reason} | "
            f"原始会话ID={original_session_id} | 活动会话ID={active_session_id} | "
            f"令牌数={fraction_snapshot['token_count']} | "
            f"上下文窗口={fraction_snapshot['context_window']} | "
            f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
            f"常规阈值={trigger_fraction:.4f} | 紧急阈值={emergency_fraction:.4f} | "
            f"压缩区消息数={compression_count} | 保留区消息数={retain_count} | "
            f"已应用暂存={staging_text}"
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
        retain_count: int,
        trigger_fraction: float,
        emergency_fraction: float,
    ) -> None:
        logger.debug(
            "[ContextCompressionMiddleware] 窗口占用快照 | "
            f"阶段={_compression_display_label(stage)} | 原始会话ID={original_session_id} | "
            f"活动会话ID={active_session_id} | "
            f"令牌数={fraction_snapshot['token_count']} | "
            f"上下文窗口={fraction_snapshot['context_window']} | "
            f"窗口占用比例={fraction_snapshot['fraction']:.4f} | "
            f"常规阈值={trigger_fraction:.4f} | 紧急阈值={emergency_fraction:.4f} | "
            f"总消息数={total_message_count} | 压缩区消息数={compression_count} | "
            f"保留区消息数={retain_count}"
        )
