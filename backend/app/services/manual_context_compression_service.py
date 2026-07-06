from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from langchain_core.messages import BaseMessage

from backend.app.agent.context_compression_utils import (
    apply_compression_anchor_replacement,
    apply_compression_full_replacement,
    extract_compression_material,
    select_last_message_id,
    split_and_prepare_compression,
    split_and_prepare_emergency_compression,
)
from backend.app.agent.factory import AgentFactory, agent_factory
from backend.app.agent.runtime_settings import load_agent_runtime_settings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.services.context_compression_service import ContextCompressionService
from backend.app.storage import StorageRepositories

ManualContextCompressionMode = Literal["light", "deep"]
ManualContextCompressionBroadcaster = Callable[
    [str, str, dict[str, Any]],
    Awaitable[bool],
]


@dataclass(frozen=True, slots=True)
class ManualContextCompressionResult:
    success: bool
    mode: ManualContextCompressionMode
    session_id: str
    active_session_id: str | None = None
    target_session_id: str | None = None
    staging_id: int | None = None
    generation: int | None = None
    staging_strategy: str | None = None
    anchor_message_id: str | None = None
    source_last_message_id: str | None = None
    notice_id: str | None = None
    reason: str | None = None
    compression_message_count: int = 0
    retain_message_count: int = 0
    total_message_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "mode": self.mode,
            "session_id": self.session_id,
            "active_session_id": self.active_session_id,
            "target_session_id": self.target_session_id,
            "staging_id": self.staging_id,
            "generation": self.generation,
            "staging_strategy": self.staging_strategy,
            "anchor_message_id": self.anchor_message_id,
            "source_last_message_id": self.source_last_message_id,
            "notice_id": self.notice_id,
            "reason": self.reason,
            "compression_message_count": self.compression_message_count,
            "retain_message_count": self.retain_message_count,
            "total_message_count": self.total_message_count,
        }


class ManualContextCompressionService:
    """Runs an explicit user-triggered context compression workflow.

    The workflow mirrors background compression's session isolation: summary
    generation happens from a checkpoint snapshot, then a new active session is
    forked and its checkpoint is immediately rewritten with the compressed
    message window.
    """

    VALID_MODES = {"light", "deep"}

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

    async def compress(
        self,
        *,
        session_id: str,
        mode: ManualContextCompressionMode,
    ) -> ManualContextCompressionResult:
        cleaned_session_id = session_id.strip()
        if mode not in self.VALID_MODES:
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=cleaned_session_id,
                reason="invalid_compression_mode",
            )
        notice_id = f"context-compression:manual:{mode}:{cleaned_session_id}:{new_id()}"
        session = self.repositories.sessions.get(cleaned_session_id)
        if session is None:
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=cleaned_session_id,
                notice_id=notice_id,
                reason="session_not_found",
            )
        if session.status in {"running", "waiting_approval"}:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                notice_id=notice_id,
                mode=mode,
                reason="session_busy",
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                notice_id=notice_id,
                reason="session_busy",
            )
        settings = load_agent_runtime_settings(self.repositories).context_compression
        if not settings.enabled:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                notice_id=notice_id,
                mode=mode,
                reason="context_compression_disabled",
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                notice_id=notice_id,
                reason="context_compression_disabled",
            )

        active_session_id = session.active_session_id or session.id
        latest_checkpoint = self._latest_checkpoint(active_session_id)
        if latest_checkpoint is None:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason="checkpoint_not_found",
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_not_found",
            )

        messages = self._checkpoint_messages(latest_checkpoint)
        if mode == "light":
            snapshot, split_result, anchor_message_id = split_and_prepare_compression(
                messages=messages,
                retain_rounds=settings.retain_rounds,
            )
            staging_strategy = "anchor_replacement"
            source_last_message_id = None
        else:
            snapshot, split_result, anchor_message_id = split_and_prepare_emergency_compression(
                messages=messages,
            )
            staging_strategy = "full_replacement"
            source_last_message_id = select_last_message_id(split_result.compression_zone)

        total_message_count = len(messages)
        compression_count = len(split_result.compression_zone)
        retain_count = len(split_result.retain_zone)
        if not split_result.compression_zone:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason="no_compressible_messages",
                total_message_count=total_message_count,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="no_compressible_messages",
                compression_message_count=compression_count,
                retain_message_count=retain_count,
                total_message_count=total_message_count,
            )
        if mode == "deep" and not source_last_message_id:
            await self._emit_progress(
                stage="manual_deep_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason="source_boundary_missing",
                total_message_count=total_message_count,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="source_boundary_missing",
                compression_message_count=compression_count,
                retain_message_count=retain_count,
                total_message_count=total_message_count,
            )

        await self._emit_progress(
            stage=f"manual_{mode}_started",
            session_id=session.id,
            active_session_id=active_session_id,
            notice_id=notice_id,
            mode=mode,
            staging_strategy=staging_strategy,
            total_message_count=total_message_count,
            compression_message_count=compression_count,
            retain_message_count=retain_count,
        )
        material = extract_compression_material(
            snapshot=snapshot,
            split_result=split_result,
            anchor_message_id=anchor_message_id,
            original_session_id=session.id,
            active_session_id=active_session_id,
            scene_id=session.scene_id,
            scene_version_seq=session.scene_version_seq,
            side_event_metadata={
                "mode": f"manual_{mode}",
                "manual": True,
                "staging_strategy": staging_strategy,
                "previous_active_session_id": active_session_id,
                "original_session_id": session.id,
            },
        )
        generation_result = await self.compression_service.generate_compression_result(
            material=material
        )
        if not generation_result.success:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason=generation_result.failure_reason or "generation_failed",
                staging_strategy=staging_strategy,
                total_message_count=total_message_count,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason=generation_result.failure_reason or "generation_failed",
                compression_message_count=compression_count,
                retain_message_count=retain_count,
                total_message_count=total_message_count,
            )

        replacement = (
            apply_compression_anchor_replacement(
                messages=messages,
                anchor_message_id=anchor_message_id,
                l1_content=generation_result.new_l1_content,
                l2_content=generation_result.new_l2_content,
            )
            if mode == "light"
            else apply_compression_full_replacement(
                l1_content=generation_result.new_l1_content,
                l2_content=generation_result.new_l2_content,
            )
        )
        if not replacement.applied:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason="anchor_not_found",
                staging_strategy=staging_strategy,
                total_message_count=total_message_count,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="anchor_not_found",
                staging_strategy=staging_strategy,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
                total_message_count=total_message_count,
            )

        checkpoint_config = self._checkpoint_config(latest_checkpoint)
        try:
            target_session_id = self._fork_active_session(
                original_session_id=session.id,
                active_session_id=active_session_id,
                checkpoint_config=checkpoint_config,
            )
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ManualContextCompressionService] 主动压缩 fork 检查点失败 | "
                f"mode={mode} | session_id={session.id} | active_session_id={active_session_id} | "
                f"error={exc}"
            )
            target_session_id = None
        if not target_session_id:
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason="fork_active_session_failed",
                staging_strategy=staging_strategy,
                total_message_count=total_message_count,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="fork_active_session_failed",
                compression_message_count=compression_count,
                retain_message_count=retain_count,
                total_message_count=total_message_count,
            )

        try:
            self._replace_target_checkpoint_messages(
                target_session_id=target_session_id,
                checkpoint_config=checkpoint_config,
                messages=replacement.replaced_messages,
            )
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ManualContextCompressionService] 主动压缩写入目标 checkpoint 失败 | "
                f"mode={mode} | session_id={session.id} | target_active={target_session_id} | "
                f"error={exc}"
            )
            self._discard_forked_session(target_session_id)
            await self._emit_progress(
                stage=f"manual_{mode}_failed",
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                mode=mode,
                reason="checkpoint_replacement_failed",
                staging_strategy=staging_strategy,
                total_message_count=total_message_count,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
            )
            return ManualContextCompressionResult(
                success=False,
                mode=mode,
                session_id=session.id,
                active_session_id=active_session_id,
                notice_id=notice_id,
                reason="checkpoint_replacement_failed",
                staging_strategy=staging_strategy,
                compression_message_count=compression_count,
                retain_message_count=retain_count,
                total_message_count=total_message_count,
            )

        context_compression_epoch = self._mark_context_compressed(
            original_session_id=session.id,
            active_session_id=target_session_id,
            mode=mode,
        )
        self._finalize_active_session_switch(
            original_session_id=session.id,
            previous_active_session_id=active_session_id,
            new_active_session_id=target_session_id,
        )
        await self._emit_progress(
            stage=f"manual_{mode}_completed",
            session_id=session.id,
            active_session_id=target_session_id,
            notice_id=notice_id,
            mode=mode,
            staging_strategy=staging_strategy,
            anchor_message_id=anchor_message_id,
            source_last_message_id=source_last_message_id,
            previous_active_session_id=active_session_id,
            new_active_session_id=target_session_id,
            context_compression_epoch=context_compression_epoch,
            total_message_count=total_message_count,
            compression_message_count=compression_count,
            retain_message_count=retain_count,
        )
        logger.info(
            "[ManualContextCompressionService] 主动压缩完成 | "
            f"mode={mode} | session_id={session.id} | previous_active={active_session_id} | "
            f"target_active={target_session_id} | strategy={staging_strategy}"
        )
        return ManualContextCompressionResult(
            success=True,
            mode=mode,
            session_id=session.id,
            active_session_id=target_session_id,
            target_session_id=target_session_id,
            staging_strategy=staging_strategy,
            anchor_message_id=anchor_message_id,
            source_last_message_id=source_last_message_id,
            notice_id=notice_id,
            compression_message_count=compression_count,
            retain_message_count=retain_count,
            total_message_count=total_message_count,
        )

    def _latest_checkpoint(self, active_session_id: str) -> Any | None:
        if self.checkpointer is None or not hasattr(self.checkpointer, "get_tuple"):
            return None
        return self.checkpointer.get_tuple(
            {"configurable": {"thread_id": active_session_id, "checkpoint_ns": ""}}
        )

    @staticmethod
    def _checkpoint_config(checkpoint: Any) -> dict[str, str] | None:
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

    def _fork_active_session(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        checkpoint_config: dict[str, str] | None,
    ) -> str | None:
        if checkpoint_config is None:
            return None
        if not self._is_current_active_session(original_session_id, active_session_id):
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
            session_tag=self.repositories.sessions.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG,
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
            source_trace_id=previous_session.source_trace_id,
            source_active_session_id=active_session_id,
            source_checkpoint_id=checkpoint_config["checkpoint_id"],
            source_checkpoint_ns=checkpoint_config["checkpoint_ns"],
        )
        try:
            self.checkpointer.clone_checkpoint_to_thread(
                source_thread_id=active_session_id,
                target_thread_id=new_active_session_id,
                checkpoint_id=checkpoint_config["checkpoint_id"],
                checkpoint_ns=checkpoint_config["checkpoint_ns"],
            )
        except Exception:
            self.repositories.sessions.soft_delete(new_active_session_id)
            if hasattr(self.checkpointer, "delete_thread"):
                self.checkpointer.delete_thread(new_active_session_id)
            raise
        return new_active_session_id

    def _replace_target_checkpoint_messages(
        self,
        *,
        target_session_id: str,
        checkpoint_config: dict[str, str] | None,
        messages: list[BaseMessage],
    ) -> None:
        if checkpoint_config is None:
            raise ValueError("checkpoint_config is required")
        replace_checkpoint_messages = getattr(self.checkpointer, "replace_checkpoint_messages", None)
        if not callable(replace_checkpoint_messages):
            raise RuntimeError("checkpointer does not support checkpoint message replacement")
        replace_checkpoint_messages(
            thread_id=target_session_id,
            checkpoint_id=checkpoint_config["checkpoint_id"],
            checkpoint_ns=checkpoint_config["checkpoint_ns"],
            messages=messages,
        )

    def _discard_forked_session(self, session_id: str) -> None:
        self.repositories.sessions.soft_delete(session_id)
        if hasattr(self.checkpointer, "delete_thread"):
            self.checkpointer.delete_thread(session_id)

    def _mark_context_compressed(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        mode: ManualContextCompressionMode,
    ) -> int:
        increment = getattr(self.repositories.sessions, "increment_context_compression_epoch", None)
        if not callable(increment):
            return 0
        epoch = int(increment(original_session_id) or 0)
        logger.info(
            "[ManualContextCompressionService] 上下文压缩代次已递增 | "
            f"mode={mode} | session_id={original_session_id} | "
            f"active_session_id={active_session_id} | context_compression_epoch={epoch}"
        )
        return epoch

    def _is_current_active_session(self, original_session_id: str, active_session_id: str) -> bool:
        original = self.repositories.sessions.get(original_session_id)
        if original is None:
            return False
        return (original.active_session_id or original.id) == active_session_id

    def _finalize_active_session_switch(
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
        if current_active_session_id not in {
            original_session_id,
            previous_active_session_id,
            new_active_session_id,
        }:
            return
        self.repositories.sessions.update(
            original_session_id,
            active_session_id=new_active_session_id,
        )
        self.repositories.sessions.update(
            previous_active_session_id,
            child_session_id=new_active_session_id,
        )
        self.repositories.sessions.update(
            new_active_session_id,
            parent_session_id=previous_active_session_id,
        )

    async def _emit_progress(
        self,
        *,
        stage: str,
        session_id: str,
        active_session_id: str,
        notice_id: str,
        mode: ManualContextCompressionMode,
        **payload: Any,
    ) -> None:
        data = {
            "middleware": "ContextCompressionMiddleware",
            "stage": stage,
            "compression_mode": f"manual_{mode}",
            "manual_mode": mode,
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
