from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from langchain_core.messages import BaseMessage

from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.runtime_settings import load_agent_runtime_settings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.services.context_compression_service import ContextCompressionService
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

        await self._emit_progress(
            stage="compression_started",
            session_id=session.id,
            active_session_id=active_session_id,
            notice_id=notice_id,
            total_message_count=len(messages),
            compression_message_count=len(messages),
        )
        generation_result = await self.compression_service.generate_compression_result(
            session=session,
            messages=messages,
            reason="manual",
            active_session_id=active_session_id,
        )
        if not generation_result.success or not generation_result.replacement_messages:
            reason = generation_result.failure_reason or "generation_failed"
            await self._emit_progress(
                stage="compression_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=reason,
                total_message_count=len(messages),
                compression_message_count=len(messages),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=reason,
                compression_message_count=len(messages),
                total_message_count=len(messages),
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
                compression_message_count=len(messages),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_conflict",
                compression_message_count=len(messages),
                total_message_count=len(messages),
            )

        try:
            self._replace_checkpoint_messages(
                active_session_id=active_session_id,
                checkpoint_config=checkpoint_config,
                messages=generation_result.replacement_messages,
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
                compression_message_count=len(messages),
            )
            return ManualContextCompressionResult(
                success=False,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_replacement_failed",
                compression_message_count=len(messages),
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
            compression_message_count=len(messages),
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
            compression_message_count=len(messages),
            total_message_count=len(messages),
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

    def _replace_checkpoint_messages(
        self,
        *,
        active_session_id: str,
        checkpoint_config: dict[str, str],
        messages: list[BaseMessage],
    ) -> None:
        replace_checkpoint_messages = getattr(
            self.checkpointer, "replace_checkpoint_messages", None
        )
        if not callable(replace_checkpoint_messages):
            raise RuntimeError("checkpointer does not support checkpoint message replacement")
        replace_checkpoint_messages(
            thread_id=active_session_id,
            checkpoint_id=checkpoint_config["checkpoint_id"],
            checkpoint_ns=checkpoint_config["checkpoint_ns"],
            messages=messages,
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
