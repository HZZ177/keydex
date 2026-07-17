from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from langchain_core.messages import AIMessage, BaseMessage

from backend.app.agent.compact_runtime_attachments import (
    build_current_text_reader,
    build_latest_plan_attachment,
    build_recent_read_attachments,
)
from backend.app.agent.context_compression_input import build_compression_prefix_input
from backend.app.agent.context_compression_replacement import (
    build_compression_replacement,
    plan_compression_budget,
)
from backend.app.agent.context_compression_selection import (
    POST_COMPACTION_NORMAL_CEILING_TOKENS,
    select_recent_execution_segment,
    select_structured_user_message_groups,
)
from backend.app.agent.context_compression_utils import (
    is_context_compression_protocol_message,
)
from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.runtime_settings import load_agent_runtime_settings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.services.context_compression_service import ContextCompressionService
from backend.app.services.legacy_user_group_reconstructor import LegacyUserGroupReconstructor
from backend.app.services.structured_user_group_materializer import (
    build_current_attachment_resolver,
)
from backend.app.services.structured_user_message_group import StructuredUserMessageGroup
from backend.app.storage import StorageRepositories

ManualContextCompressionBroadcaster = Callable[
    [str, str, dict[str, Any]],
    Awaitable[bool],
]


@dataclass(frozen=True, slots=True)
class ManualContextCompressionResult:
    success: bool
    session_id: str
    active_session_id: str | None = None
    notice_id: str | None = None
    reason: str | None = None
    context_compression_epoch: int | None = None
    compression_message_count: int = 0
    total_message_count: int = 0
    selection_report: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "session_id": self.session_id,
            "active_session_id": self.active_session_id,
            "notice_id": self.notice_id,
            "reason": self.reason,
            "context_compression_epoch": self.context_compression_epoch,
            "compression_message_count": self.compression_message_count,
            "total_message_count": self.total_message_count,
            "selection_report": self.selection_report,
        }


class ManualContextCompressionService:
    """Runs explicit user-triggered context compression on the active checkpoint."""

    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        checkpointer: Any,
        compression_service: ContextCompressionService | None = None,
        factory: AgentFactory = agent_factory,
        http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        broadcaster: ManualContextCompressionBroadcaster | None = None,
    ) -> None:
        self.repositories = repositories
        self.checkpointer = checkpointer
        self.compression_service = compression_service or ContextCompressionService(
            repositories,
            factory=factory,
            http_transport=http_transport,
        )
        self.broadcaster = broadcaster

    async def compress(self, *, session_id: str) -> ManualContextCompressionResult:
        cleaned_session_id = session_id.strip()
        notice_id = f"context-compression:manual:{cleaned_session_id}:{new_id()}"
        session = self.repositories.sessions.get(cleaned_session_id)
        if session is None:
            return ManualContextCompressionResult(
                success=False,
                session_id=cleaned_session_id,
                notice_id=notice_id,
                reason="session_not_found",
            )
        active_session_id = session.active_session_id or session.id
        if session.status in {"running", "waiting_approval"}:
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="session_busy",
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="session_busy",
            )
        settings = load_agent_runtime_settings(self.repositories).context_compression
        if not settings.enabled:
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="context_compression_disabled",
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="context_compression_disabled",
            )

        checkpoint = self._latest_checkpoint(active_session_id)
        checkpoint_config = self._checkpoint_config(checkpoint)
        if checkpoint is None or checkpoint_config is None:
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_not_found",
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_not_found",
            )

        messages = self._checkpoint_messages(checkpoint)
        if not messages:
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="no_compressible_messages",
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="no_compressible_messages",
            )

        recent_execution = select_recent_execution_segment(messages)
        if recent_execution.failure_reason:
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=f"invalid_protocol_history:{recent_execution.failure_reason}",
                total_message_count=len(messages),
            )
        prefix_input = build_compression_prefix_input(messages, recent_execution)
        compression_messages = list(prefix_input.messages)
        if not compression_messages or not any(
            not is_context_compression_protocol_message(message)
            for message in compression_messages
        ):
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="no_compressible_messages",
                total_message_count=len(messages),
            )
        groups = self._checkpoint_structured_groups(checkpoint)
        if not groups:
            groups = LegacyUserGroupReconstructor(self.repositories).reconstruct_session(
                session.id
            )
        if not groups:
            groups = LegacyUserGroupReconstructor(self.repositories).reconstruct_messages(
                messages,
                session_id=session.id,
            )
        group_selection = select_structured_user_message_groups(groups)
        tail_tool_call_ids = _tool_call_ids(recent_execution.messages)
        plan_attachment = build_latest_plan_attachment(
            messages,
            tail_tool_call_ids=tail_tool_call_ids,
        )
        budget_plan = plan_compression_budget(
            group_selection=group_selection,
            recent_execution=recent_execution,
            plan_attachment=plan_attachment,
        )

        await self._emit_progress(
            stage="compression_started",
            session_id=session.id,
            active_session_id=active_session_id,
            notice_id=notice_id,
            total_message_count=len(messages),
            compression_message_count=len(compression_messages),
        )
        generation_result = await self.compression_service.generate_compression_result(
            session=session,
            messages=compression_messages,
            reason="manual",
            active_session_id=active_session_id,
            boundary_id=notice_id,
            selected_group_ids=group_selection.mandatory_group_ids,
            tail_message_count=len(recent_execution.messages),
            max_output_tokens=budget_plan.requested_summary_max_tokens,
        )
        if not generation_result.success or not generation_result.summary:
            reason = generation_result.failure_reason or "generation_failed"
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=reason,
                total_message_count=len(messages),
                compression_message_count=len(compression_messages),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=reason,
                compression_message_count=len(compression_messages),
                total_message_count=len(messages),
            )

        recent_attachments = build_recent_read_attachments(
            messages,
            available_tokens=POST_COMPACTION_NORMAL_CEILING_TOKENS,
            read_current=build_current_text_reader(
                self.repositories,
                session=session,
                user_id=session.user_id,
            ),
            tail_tool_call_ids=tail_tool_call_ids,
        )
        replacement = build_compression_replacement(
            summary=generation_result.summary,
            boundary_id=notice_id,
            prefix_messages=compression_messages,
            all_groups=groups,
            group_selection=group_selection,
            recent_execution=recent_execution,
            plan_attachment=plan_attachment,
            recent_attachments=recent_attachments.attachments,
            pre_dropped_components=recent_attachments.dropped,
            attachment_resolver=build_current_attachment_resolver(
                self.repositories,
                session_id=session.id,
                user_id=session.user_id,
            ),
            provider_hard_window_tokens=max(int(settings.context_window_tokens), 1),
        )
        if not replacement.success:
            reason = replacement.failure_reason or "replacement_build_failed"
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=reason,
                selection_report=replacement.report.to_safe_dict(),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=reason,
                compression_message_count=len(compression_messages),
                total_message_count=len(messages),
                selection_report=replacement.report.to_safe_dict(),
            )

        if not self._is_current_active_checkpoint(
            original_session_id=session.id,
            active_session_id=active_session_id,
            expected_checkpoint_id=checkpoint_config["checkpoint_id"],
            expected_checkpoint_ns=checkpoint_config["checkpoint_ns"],
        ):
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_conflict",
                total_message_count=len(messages),
                compression_message_count=len(compression_messages),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_conflict",
                compression_message_count=len(compression_messages),
                total_message_count=len(messages),
            )

        try:
            self._replace_checkpoint_state(
                active_session_id=active_session_id,
                checkpoint_config=checkpoint_config,
                messages=list(replacement.messages),
                state_update=replacement.state_update,
            )
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ManualContextCompressionService] 主动压缩替换 checkpoint 失败 | "
                f"session_id={session.id} | active_session_id={active_session_id} | error={exc}"
            )
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_replacement_failed",
                total_message_count=len(messages),
                compression_message_count=len(compression_messages),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_replacement_failed",
                compression_message_count=len(compression_messages),
                total_message_count=len(messages),
            )

        epoch = self._mark_context_compressed(session.id)
        await self._emit_progress(
            stage="compression_completed",
            session_id=session.id,
            active_session_id=active_session_id,
            notice_id=notice_id,
            context_compression_epoch=epoch,
            total_message_count=len(messages),
            compression_message_count=len(compression_messages),
            selection_report=replacement.report.to_safe_dict(),
        )
        logger.info(
            "[ManualContextCompressionService] 主动压缩完成 | "
            f"session_id={session.id} | active_session_id={active_session_id} | epoch={epoch}"
        )
        return ManualContextCompressionResult(
            success=True,
            session_id=session.id,
            active_session_id=active_session_id,
            notice_id=notice_id,
            context_compression_epoch=epoch,
            compression_message_count=len(compression_messages),
            total_message_count=len(messages),
            selection_report=replacement.report.to_safe_dict(),
        )

    def _latest_checkpoint(self, active_session_id: str) -> Any | None:
        if self.checkpointer is None or not hasattr(self.checkpointer, "get_tuple"):
            return None
        return self.checkpointer.get_tuple(
            {"configurable": {"thread_id": active_session_id, "checkpoint_ns": ""}}
        )

    @staticmethod
    def _checkpoint_config(checkpoint: Any | None) -> dict[str, str] | None:
        if checkpoint is None:
            return None
        configurable = getattr(checkpoint, "config", {}).get("configurable", {})
        checkpoint_id = configurable.get("checkpoint_id")
        if not checkpoint_id:
            return None
        return {
            "checkpoint_id": str(checkpoint_id),
            "checkpoint_ns": str(configurable.get("checkpoint_ns") or ""),
        }

    @staticmethod
    def _checkpoint_messages(checkpoint: Any) -> list[BaseMessage]:
        values = getattr(checkpoint, "checkpoint", {}).get("channel_values", {})
        messages = values.get("messages") if isinstance(values, dict) else None
        return [message for message in list(messages or []) if isinstance(message, BaseMessage)]

    @staticmethod
    def _checkpoint_structured_groups(checkpoint: Any) -> list[StructuredUserMessageGroup]:
        values = getattr(checkpoint, "checkpoint", {}).get("channel_values", {})
        raw_groups = (
            values.get("structured_user_message_groups")
            if isinstance(values, dict)
            else []
        )
        groups: list[StructuredUserMessageGroup] = []
        for raw in list(raw_groups or []):
            try:
                groups.append(StructuredUserMessageGroup.from_dict(raw))
            except (TypeError, ValueError):
                continue
        return groups

    def _is_current_active_checkpoint(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        expected_checkpoint_id: str,
        expected_checkpoint_ns: str,
    ) -> bool:
        original = self.repositories.sessions.get(original_session_id)
        if original is None or (original.active_session_id or original.id) != active_session_id:
            return False
        latest = self._latest_checkpoint(active_session_id)
        latest_config = self._checkpoint_config(latest)
        return latest_config == {
            "checkpoint_id": expected_checkpoint_id,
            "checkpoint_ns": expected_checkpoint_ns,
        }

    def _replace_checkpoint_state(
        self,
        *,
        active_session_id: str,
        checkpoint_config: dict[str, str],
        messages: list[BaseMessage],
        state_update: dict[str, Any],
    ) -> None:
        replace_checkpoint_state = getattr(self.checkpointer, "replace_checkpoint_state", None)
        if not callable(replace_checkpoint_state):
            raise RuntimeError("checkpointer does not support atomic checkpoint state replacement")
        channel_values = {"messages": list(messages)}
        channel_values.update(_checkpoint_channel_values_from_state_update(state_update))
        replace_checkpoint_state(
            thread_id=active_session_id,
            checkpoint_id=checkpoint_config["checkpoint_id"],
            checkpoint_ns=checkpoint_config["checkpoint_ns"],
            channel_values=channel_values,
        )

    def _mark_context_compressed(self, session_id: str) -> int:
        increment = getattr(self.repositories.sessions, "increment_context_compression_epoch", None)
        if not callable(increment):
            return 0
        return int(increment(session_id) or 0)

    async def _emit_progress(
        self,
        *,
        stage: str,
        session_id: str,
        active_session_id: str,
        notice_id: str,
        **payload: Any,
    ) -> None:
        data = {
            "middleware": "ContextCompressionMiddleware",
            "stage": stage,
            "compression_mode": "context",
            "compression_reason": "manual",
            "notice_id": notice_id,
            "session_id": session_id,
            "active_session_id": active_session_id,
            "timestamp_ms": int(time.time() * 1000),
            **payload,
        }
        try:
            _max_seq, max_turn = self.repositories.message_events.get_max_seq_and_turn(session_id)
            self.repositories.message_events.append(
                event_id=new_id(),
                session_id=session_id,
                turn_index=max_turn,
                action="middleware_progress",
                data=data,
            )
        except Exception as exc:
            logger.debug(
                "[ManualContextCompressionService] 主动压缩进度持久化失败 | "
                f"session_id={session_id} | stage={stage} | error={exc}"
            )
        if self.broadcaster is not None:
            try:
                await self.broadcaster(session_id, "middleware_progress", data)
            except Exception as exc:
                logger.debug(
                    "[ManualContextCompressionService] 主动压缩进度推送失败 | "
                    f"session_id={session_id} | stage={stage} | error={exc}"
                )


def _tool_call_ids(messages: tuple[BaseMessage, ...]) -> set[str]:
    result: set[str] = set()
    for message in messages:
        if not isinstance(message, AIMessage):
            continue
        result.update(
            str(call.get("id") or "")
            for call in message.tool_calls
            if str(call.get("id") or "")
        )
    return result


def _checkpoint_channel_values_from_state_update(
    state_update: dict[str, Any],
) -> dict[str, Any]:
    channels: dict[str, Any] = {}
    for key in (
        "structured_user_message_groups",
        "structured_user_group_replay_markers",
        "pending_tool_call_preset",
        "context_compression_diagnostics",
    ):
        if key not in state_update:
            continue
        value = state_update[key]
        if key == "structured_user_message_groups" and isinstance(value, dict):
            if value.get("mode") == "replace":
                value = list(value.get("groups") or [])
        channels[key] = value
    return channels
