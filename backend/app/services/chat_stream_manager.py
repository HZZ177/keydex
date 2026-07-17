from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable
from dataclasses import dataclass, replace
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.events import ChatProjectionAdapter
from backend.app.events.actions import ChatAction
from backend.app.services.chat_types import (
    PENDING_INPUT_MODE_QUEUE,
    PENDING_INPUT_MODE_STEER,
    PENDING_INPUT_MODES,
    ChatCancellationToken,
    ChatRequest,
)
from backend.app.tools.command_runtime import command_process_manager


class ChatStreamError(Exception):
    """Base error for background chat stream management."""


class ChatStreamAlreadyRunningError(ChatStreamError):
    """Raised when a session already has a running turn."""


class ChatStreamMissingSessionError(ChatStreamError):
    """Raised when a background chat request has no session id."""


@dataclass(slots=True)
class ChatStreamRun:
    session_id: str
    request: ChatRequest | None
    task: asyncio.Task
    cancellation: ChatCancellationToken
    started_at_ms: int
    kind: str = "chat"


class BroadcastChatAdapter:
    def __init__(self, manager: ChatStreamManager, session_id: str) -> None:
        self._manager = manager
        self._session_id = session_id

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        return await self._manager.broadcast(
            session_id=session_id or self._session_id,
            action=action,
            data=data,
        )


class ChatStreamManager:
    """Owns chat task lifecycle independently from individual websocket connections."""

    def __init__(self, chat_service: Any) -> None:
        self._chat_service = chat_service
        self._runs: dict[str, ChatStreamRun] = {}
        self._subscribers: dict[str, set[ChatProjectionAdapter]] = {}
        self._lock = asyncio.Lock()
        self._thread_task_runtime: Any | None = None
        self._after_run_finished_callback: Any | None = None

    def set_thread_task_runtime(self, runtime: Any | None) -> None:
        self._thread_task_runtime = runtime
        bind = getattr(runtime, "bind_chat_stream_manager", None)
        if callable(bind):
            bind(self)

    def set_after_run_finished_callback(self, callback: Any | None) -> None:
        self._after_run_finished_callback = callback

    async def subscribe(self, session_id: str, adapter: ChatProjectionAdapter) -> None:
        cleaned = session_id.strip()
        if not cleaned:
            return
        async with self._lock:
            self._subscribers.setdefault(cleaned, set()).add(adapter)
        logger.debug(f"[ChatStreamManager] 订阅会话流 | session_id={cleaned}")

    async def unsubscribe(self, session_id: str, adapter: ChatProjectionAdapter) -> None:
        cleaned = session_id.strip()
        if not cleaned:
            return
        async with self._lock:
            subscribers = self._subscribers.get(cleaned)
            if subscribers is None:
                return
            subscribers.discard(adapter)
            if not subscribers:
                self._subscribers.pop(cleaned, None)
        logger.debug(f"[ChatStreamManager] 退订会话流 | session_id={cleaned}")

    async def unsubscribe_all(self, adapter: ChatProjectionAdapter) -> None:
        async with self._lock:
            empty_sessions: list[str] = []
            for session_id, subscribers in self._subscribers.items():
                subscribers.discard(adapter)
                if not subscribers:
                    empty_sessions.append(session_id)
            for session_id in empty_sessions:
                self._subscribers.pop(session_id, None)
        logger.debug("[ChatStreamManager] 退订连接的全部会话流")

    async def has_subscribers(self, session_id: str) -> bool:
        cleaned = session_id.strip()
        if not cleaned:
            return False
        async with self._lock:
            return bool(self._subscribers.get(cleaned))

    async def start_chat(self, request: ChatRequest) -> str:
        session_id = (request.session_id or "").strip()
        if not session_id:
            raise ChatStreamMissingSessionError("后台流式对话必须指定 session_id")

        async with self._lock:
            existing = self._runs.get(session_id)
            if existing is not None and not existing.task.done():
                raise ChatStreamAlreadyRunningError("当前会话已有对话正在执行")

            cancellation = ChatCancellationToken()
            task = asyncio.create_task(self._run_chat(request, cancellation))
            self._runs[session_id] = ChatStreamRun(
                session_id=session_id,
                request=request,
                task=task,
                cancellation=cancellation,
                started_at_ms=int(time.time() * 1000),
            )
            task.add_done_callback(lambda done_task: self._schedule_finish(session_id, done_task))

        logger.info(f"[ChatStreamManager] 后台对话已启动 | session_id={session_id}")
        return session_id

    async def start_managed_run(
        self,
        *,
        session_id: str,
        awaitable: Awaitable[Any],
        cancellation: ChatCancellationToken,
        kind: str,
    ) -> asyncio.Task[Any]:
        """Register a continuation under the same per-session task lifecycle as chat."""
        cleaned = session_id.strip()
        if not cleaned:
            self._close_unstarted_awaitable(awaitable)
            raise ChatStreamMissingSessionError("Background runs require a session_id")

        async with self._lock:
            existing = self._runs.get(cleaned)
            if existing is not None and not existing.task.done():
                self._close_unstarted_awaitable(awaitable)
                raise ChatStreamAlreadyRunningError("A run is already active for this session")

            task = asyncio.create_task(awaitable)
            self._runs[cleaned] = ChatStreamRun(
                session_id=cleaned,
                request=None,
                task=task,
                cancellation=cancellation,
                started_at_ms=int(time.time() * 1000),
                kind=str(kind or "managed"),
            )
            task.add_done_callback(lambda done_task: self._schedule_finish(cleaned, done_task))

        logger.info(
            "[ChatStreamManager] Managed background run started | "
            f"session_id={cleaned} | kind={kind or 'managed'}"
        )
        return task

    async def submit_input(self, request: ChatRequest) -> dict[str, Any]:
        session_id = (request.session_id or "").strip()
        if not session_id:
            raise ChatStreamMissingSessionError("后台流式对话必须指定 session_id")
        delivery_mode = self._normalize_delivery_mode(request.delivery_mode)
        request = replace(request, session_id=session_id, delivery_mode=delivery_mode)

        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            await self.start_chat(request)
            return {
                "session_id": session_id,
                "status": "started",
                "delivery_mode": "direct",
            }

        running = await self._is_running(session_id)
        waiting_input = self._is_waiting_input(session_id)
        has_queue = repositories.pending_inputs.has_active_queue(session_id)
        if running or waiting_input or has_queue:
            mode = self._pending_mode_for_submit(
                delivery_mode,
                running=running,
                waiting_input=waiting_input,
                has_queue=has_queue,
            )
            record, created = repositories.pending_inputs.create_or_get(
                session_id=session_id,
                message=request.message,
                mode=mode,
                client_input_id=request.client_input_id,
                user_id=request.user_id,
                scene_id=request.scene_id,
                provider_id=request.provider_id,
                model=request.model,
                runtime_params=request.runtime_params,
                attachments=request.attachments,
            )
            if created:
                await self._emit_pending_input_event(
                    session_id,
                    ChatAction.PENDING_INPUT_SUBMITTED.value,
                    record,
                )
            else:
                await self.broadcast(
                    session_id=session_id,
                    action=ChatAction.PENDING_INPUT_SUBMITTED.value,
                    data=self._pending_input_payload(record, duplicate=True),
                )
            if not running and not waiting_input:
                await self._drain_next_pending_input(session_id)
            return {
                "session_id": session_id,
                "status": "pending",
                "pending_input": record.to_dict(),
                "duplicate": not created,
            }

        try:
            await self.start_chat(request)
        except ChatStreamAlreadyRunningError:
            record, created = repositories.pending_inputs.create_or_get(
                session_id=session_id,
                message=request.message,
                mode=self._pending_mode_for_submit(
                    delivery_mode,
                    running=True,
                    waiting_input=False,
                    has_queue=False,
                ),
                client_input_id=request.client_input_id,
                user_id=request.user_id,
                scene_id=request.scene_id,
                provider_id=request.provider_id,
                model=request.model,
                runtime_params=request.runtime_params,
                attachments=request.attachments,
            )
            if created:
                await self._emit_pending_input_event(
                    session_id,
                    ChatAction.PENDING_INPUT_SUBMITTED.value,
                    record,
                )
            return {
                "session_id": session_id,
                "status": "pending",
                "pending_input": record.to_dict(),
                "duplicate": not created,
            }
        return {
            "session_id": session_id,
            "status": "started",
            "delivery_mode": "direct",
        }

    async def update_pending_input(
        self,
        *,
        session_id: str,
        pending_input_id: str,
        message: str | None = None,
        mode: str | None = None,
        runtime_params: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        provider_id: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any] | None:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            return None
        record = repositories.pending_inputs.update_pending(
            pending_input_id,
            message=message,
            mode=mode,
            runtime_params=runtime_params,
            attachments=attachments,
            provider_id=provider_id,
            model=model,
        )
        if record is None or record.session_id != session_id:
            return None
        await self._emit_pending_input_event(
            session_id,
            ChatAction.PENDING_INPUT_UPDATED.value,
            record,
        )
        return record.to_dict()

    async def reorder_pending_inputs(
        self,
        *,
        session_id: str,
        pending_input_ids: list[str],
    ) -> list[dict[str, Any]] | None:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            return None
        records = repositories.pending_inputs.reorder_pending(
            session_id,
            pending_input_ids,
        )
        if records is None:
            return None
        payload = {
            "session_id": session_id,
            "pending_inputs": [record.to_dict() for record in records],
        }
        if hasattr(repositories, "message_events"):
            try:
                repositories.message_events.append(
                    event_id=new_id(),
                    session_id=session_id,
                    turn_index=0,
                    action="pending_inputs_reordered",
                    data=payload,
                )
            except Exception as exc:
                logger.opt(exception=True).warning(
                    "[ChatStreamManager] pending inputs 重排事件持久化失败 | "
                    f"session_id={session_id} | error={exc}"
                )
        await self.broadcast(
            session_id=session_id,
            action="pending_inputs_reordered",
            data=payload,
        )
        return payload["pending_inputs"]

    async def cancel_pending_input(
        self,
        *,
        session_id: str,
        pending_input_id: str,
        reason: str | None = None,
    ) -> dict[str, Any] | None:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            return None
        record = repositories.pending_inputs.cancel(pending_input_id, reason=reason)
        if record is None or record.session_id != session_id:
            return None
        await self._emit_pending_input_event(
            session_id,
            ChatAction.PENDING_INPUT_CANCELLED.value,
            record,
        )
        return record.to_dict()

    async def resume_pending_inputs(
        self,
        *,
        session_id: str,
        pending_input_id: str | None = None,
        mode: str | None = None,
    ) -> list[dict[str, Any]] | None:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            return None
        cleaned_id = str(pending_input_id or "").strip() or None
        cleaned_mode = self._normalize_delivery_mode(mode) if mode is not None else None
        if cleaned_id:
            current = repositories.pending_inputs.get(cleaned_id)
            if current is None or current.session_id != session_id:
                return None
            cleaned_mode = current.mode
        if cleaned_mode is None:
            return None

        running = await self._is_running(session_id)
        if cleaned_mode == PENDING_INPUT_MODE_STEER and not running:
            resumed = repositories.pending_inputs.resume_steers_as_new_turn(
                session_id,
                pending_input_id=cleaned_id,
            )
        else:
            resumed = repositories.pending_inputs.resume_paused(
                session_id,
                pending_input_id=cleaned_id,
                mode=cleaned_mode,
            )
        if not resumed:
            return None
        for record in resumed:
            await self._emit_pending_input_event(
                session_id,
                ChatAction.PENDING_INPUT_RESUMED.value,
                record,
            )
        if not running:
            await self._drain_next_pending_input(session_id)
        return [record.to_dict() for record in resumed]

    async def cancel(self, session_id: str | None = None) -> bool:
        cleaned = (session_id or "").strip()
        if not cleaned:
            return False
        paused_records: list[Any] = []
        async with self._lock:
            run = self._runs.get(cleaned)
            if run is None or run.task.done():
                run = None
            else:
                repositories = getattr(self._chat_service, "repositories", None)
                if repositories is not None and hasattr(repositories, "pending_inputs"):
                    paused_records = repositories.pending_inputs.pause_active_for_session(
                        cleaned,
                        reason="user_stopped",
                    )
                killed = command_process_manager.terminate_session(cleaned, reason="turn_cancelled")
                run.cancellation.cancel()
                run.task.cancel()
        if run is None:
            await self.recover_interrupted_sessions(session_id=cleaned)
            return False
        for record in paused_records:
            await self._emit_pending_input_event(
                cleaned,
                ChatAction.PENDING_INPUT_PAUSED.value,
                record,
            )
        logger.info(
            "[ChatStreamManager] 已请求强制取消后台对话 | "
            f"session_id={cleaned} | killed_commands={killed}"
        )
        return True

    async def recover_interrupted_sessions(
        self,
        *,
        session_id: str | None = None,
    ) -> list[str]:
        """Reconcile persisted running sessions whose owning process no longer exists."""
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "sessions"):
            return []

        cleaned = (session_id or "").strip()
        recovered: list[str] = []
        async with self._lock:
            if cleaned:
                record = repositories.sessions.get(cleaned)
                candidates = [record] if record is not None and record.status == "running" else []
            else:
                candidates = repositories.sessions.list(
                    status="running",
                    include_internal=True,
                    limit=500,
                )

            for record in candidates:
                run = self._runs.get(record.id)
                if run is not None and not run.task.done():
                    continue
                updated = repositories.sessions.update(record.id, status="active")
                if updated is None:
                    continue
                if hasattr(repositories, "pending_inputs"):
                    repositories.pending_inputs.pause_active_for_session(
                        record.id,
                        reason="backend_restarted",
                    )
                if hasattr(repositories, "command_approvals"):
                    repositories.command_approvals.cancel_pending_for_session(record.id)
                recovered.append(record.id)

        if recovered:
            logger.warning(
                "[ChatStreamManager] 已恢复后端重启遗留的运行中会话 | "
                f"count={len(recovered)} | session_ids={','.join(recovered)}"
            )
        return recovered

    async def broadcast(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        cleaned = session_id.strip()
        if not cleaned:
            return False
        async with self._lock:
            subscribers = list(self._subscribers.get(cleaned, set()))

        if not subscribers:
            return False

        sent = False
        failed: list[ChatProjectionAdapter] = []
        for subscriber in subscribers:
            try:
                if await subscriber.send(session_id=cleaned, action=action, data=data):
                    sent = True
            except Exception as exc:
                failed.append(subscriber)
                logger.warning(
                    f"[ChatStreamManager] 推送订阅者失败，将退订 | session_id={cleaned} | "
                    f"action={action} | error={exc}"
                )

        if failed:
            async with self._lock:
                current = self._subscribers.get(cleaned)
                if current is not None:
                    for subscriber in failed:
                        current.discard(subscriber)
                    if not current:
                        self._subscribers.pop(cleaned, None)
        return sent

    async def broadcast_all(self, *, action: str, data: dict[str, Any]) -> int:
        async with self._lock:
            session_ids = sorted(self._subscribers)
        delivered = 0
        for session_id in session_ids:
            if await self.broadcast(session_id=session_id, action=action, data=data):
                delivered += 1
        return delivered

    async def status(self, session_id: str | None = None) -> dict[str, Any]:
        async with self._lock:
            running = {key: run for key, run in self._runs.items() if not run.task.done()}
        cleaned = (session_id or "").strip()
        repositories = getattr(self._chat_service, "repositories", None)
        pending = (
            repositories.command_approvals.list_pending(session_id=cleaned or None)
            if repositories is not None and hasattr(repositories, "command_approvals")
            else []
        )
        waiting_input_records = (
            repositories.sessions.list(status="waiting_input")
            if repositories is not None and hasattr(repositories, "sessions")
            else []
        )
        waiting_session_ids = sorted({approval.session_id for approval in pending})
        waiting_input_session_ids = sorted(
            {
                record.id
                for record in waiting_input_records
                if not cleaned or record.id == cleaned
            }
        )
        running = {
            key: run
            for key, run in running.items()
            if key not in set(waiting_input_session_ids)
        }
        status = "idle"
        if cleaned and cleaned in waiting_input_session_ids:
            status = "waiting_input"
        elif cleaned and cleaned in waiting_session_ids:
            status = "waiting_approval"
        elif cleaned and cleaned in running:
            status = "running"
        return {
            "session_id": cleaned or None,
            "status": status,
            "running_sessions": [
                {"session_id": key, "started_at_ms": run.started_at_ms}
                for key, run in sorted(running.items())
            ],
            "waiting_approval_sessions": [{"session_id": key} for key in waiting_session_ids],
            "waiting_input_sessions": [
                {"session_id": key} for key in waiting_input_session_ids
            ],
            "pending_approvals": [
                {
                    "session_id": approval.session_id,
                    "approval_id": approval.id,
                    "status": approval.status,
                }
                for approval in pending
            ],
            "pending_inputs": [
                record.to_dict()
                for record in (
                    repositories.pending_inputs.list_active_by_session(cleaned)
                    if cleaned
                    and repositories is not None
                    and hasattr(repositories, "pending_inputs")
                    else []
                )
            ],
        }

    async def _run_chat(self, request: ChatRequest, cancellation: ChatCancellationToken) -> Any:
        session_id = (request.session_id or "").strip()
        return await self._chat_service.handle_chat(
            request,
            chat_adapter=BroadcastChatAdapter(self, session_id),
            cancellation=cancellation,
        )

    def _schedule_finish(self, session_id: str, task: asyncio.Task) -> None:
        try:
            asyncio.create_task(self._finish_run(session_id, task))
        except RuntimeError:
            logger.opt(exception=True).warning(
                f"[ChatStreamManager] 无法调度后台对话清理 | session_id={session_id}"
            )

    async def _finish_run(self, session_id: str, task: asyncio.Task) -> None:
        removed_current = False
        finished_run: ChatStreamRun | None = None
        async with self._lock:
            current = self._runs.get(session_id)
            if current is not None and current.task is task:
                self._runs.pop(session_id, None)
                removed_current = True
                finished_run = current

        result: Any | None = None
        error: BaseException | None = None
        cancelled = bool(
            finished_run is not None and finished_run.cancellation.is_cancelled()
        )
        try:
            result = task.result()
        except asyncio.CancelledError as exc:
            error = exc
            cancelled = True
        except Exception as exc:
            error = exc
            logger.opt(exception=True).error(
                f"[ChatStreamManager] 后台对话 task 异常 | session_id={session_id} | error={exc}"
            )
        else:
            cancelled = cancelled or self._is_cancelled_completion(result=result, error=error)

        if cancelled:
            logger.info(f"[ChatStreamManager] 后台对话 task 已取消 | session_id={session_id}")
        elif error is None:
            logger.info(f"[ChatStreamManager] 后台对话 task 完成 | session_id={session_id}")

        if removed_current:
            await self._notify_after_run_finished(
                session_id,
                request=finished_run.request if finished_run is not None else None,
                result=result,
                error=error,
                cancelled=cancelled,
            )

    @staticmethod
    def _close_unstarted_awaitable(awaitable: Awaitable[Any]) -> None:
        close = getattr(awaitable, "close", None)
        if callable(close):
            close()

    async def _notify_after_run_finished(
        self,
        session_id: str,
        *,
        request: ChatRequest | None = None,
        result: Any | None = None,
        error: BaseException | None = None,
        cancelled: bool = False,
    ) -> None:
        runtime = self._thread_task_runtime
        if runtime is not None:
            handle_finished = getattr(runtime, "handle_chat_finished", None)
            if callable(handle_finished):
                try:
                    finish_result = handle_finished(
                        session_id,
                        request=request,
                        result=result,
                        error=error,
                    )
                    if inspect.isawaitable(finish_result):
                        await finish_result
                except Exception as exc:
                    logger.opt(exception=True).warning(
                        "[ChatStreamManager] ThreadTaskRuntime finish 收尾失败 | "
                        f"session_id={session_id} | error={exc}"
                    )
            if cancelled:
                handle_cancelled = getattr(runtime, "handle_user_cancelled", None)
                if callable(handle_cancelled):
                    try:
                        cancel_result = handle_cancelled(
                            session_id,
                            request=request,
                            result=result,
                            error=error,
                        )
                        if inspect.isawaitable(cancel_result):
                            await cancel_result
                    except Exception as exc:
                        logger.opt(exception=True).warning(
                            "[ChatStreamManager] ThreadTaskRuntime cancel 收尾失败 | "
                            f"session_id={session_id} | error={exc}"
                        )

        callback = self._after_run_finished_callback
        if callback is not None:
            try:
                result = callback(session_id)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                logger.opt(exception=True).warning(
                    "[ChatStreamManager] after_run_finished 回调失败 | "
                    f"session_id={session_id} | error={exc}"
                )

        if cancelled:
            logger.info(
                "[ChatStreamManager] 用户取消后跳过长程任务自动续跑 | "
                f"session_id={session_id}"
            )
            return

        await self._convert_pending_steers(session_id)
        if await self._drain_next_pending_input(session_id):
            return

        if runtime is None:
            return
        continue_if_idle = getattr(runtime, "continue_if_idle", None)
        if not callable(continue_if_idle):
            return
        try:
            result = continue_if_idle(session_id, reason="run_finished")
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[ChatStreamManager] ThreadTaskRuntime idle 检查失败 | "
                f"session_id={session_id} | error={exc}"
            )

    @staticmethod
    def _is_cancelled_completion(
        *,
        result: Any | None = None,
        error: BaseException | None = None,
    ) -> bool:
        if isinstance(error, asyncio.CancelledError):
            return True
        if error is not None and type(error).__name__ == "CancelledError":
            return True
        return str(getattr(result, "status", "") or "") == "cancelled"

    async def _is_running(self, session_id: str) -> bool:
        async with self._lock:
            run = self._runs.get(session_id)
            return bool(run is not None and not run.task.done())

    def _is_waiting_input(self, session_id: str) -> bool:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None:
            return False
        session = (
            repositories.sessions.get(session_id)
            if hasattr(repositories, "sessions")
            else None
        )
        if getattr(session, "status", "") == "waiting_input":
            return True
        waiting = (
            repositories.a2ui_interactions.get_waiting_by_session(session_id)
            if hasattr(repositories, "a2ui_interactions")
            else []
        )
        return bool(waiting)

    async def _convert_pending_steers(self, session_id: str) -> None:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            return
        converted = repositories.pending_inputs.convert_pending_steers_to_queue(session_id)
        for record in converted:
            await self._emit_pending_input_event(
                session_id,
                ChatAction.PENDING_INPUT_CONVERTED.value,
                record,
            )

    async def _drain_next_pending_input(self, session_id: str) -> bool:
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is None or not hasattr(repositories, "pending_inputs"):
            return False
        if await self._is_running(session_id) or self._is_waiting_input(session_id):
            return False
        record = repositories.pending_inputs.claim_next_queued(
            session_id,
            lock_owner=f"stream:{id(self)}",
        )
        if record is None:
            return False
        request = self._request_from_pending_input(record)
        try:
            await self.start_chat(request)
        except ChatStreamAlreadyRunningError:
            repositories.pending_inputs.release_to_queue(record.id)
            return True
        except Exception as exc:
            failed = repositories.pending_inputs.mark_failed(
                record.id,
                error_code="pending_input_start_failed",
                error_message=str(exc),
            )
            if failed is not None:
                await self._emit_pending_input_event(
                    session_id,
                    ChatAction.PENDING_INPUT_FAILED.value,
                    failed,
                )
            logger.opt(exception=True).warning(
                "[ChatStreamManager] 队列 pending input 启动失败 | "
                f"session_id={session_id} | pending_input_id={record.id} | error={exc}"
            )
            return False

        delivered = repositories.pending_inputs.mark_delivered(record.id)
        if delivered is not None:
            await self._emit_pending_input_event(
                session_id,
                ChatAction.PENDING_INPUT_DELIVERED.value,
                delivered,
            )
        return True

    @staticmethod
    def _request_from_pending_input(record: Any) -> ChatRequest:
        return ChatRequest(
            session_id=record.session_id,
            message=record.message,
            user_id=record.user_id,
            scene_id=record.scene_id,
            provider_id=record.provider_id,
            model=record.model,
            runtime_params=dict(record.runtime_params or {}),
            attachments=list(record.attachments or []),
            delivery_mode=PENDING_INPUT_MODE_QUEUE,
            client_input_id=record.client_input_id,
            pending_input_id=record.id,
        )

    @staticmethod
    def _normalize_delivery_mode(mode: str | None) -> str:
        cleaned = str(mode or "").strip() or PENDING_INPUT_MODE_STEER
        return cleaned if cleaned in PENDING_INPUT_MODES else PENDING_INPUT_MODE_STEER

    @staticmethod
    def _pending_mode_for_submit(
        delivery_mode: str,
        *,
        running: bool,
        waiting_input: bool,
        has_queue: bool,
    ) -> str:
        if delivery_mode == PENDING_INPUT_MODE_QUEUE or waiting_input:
            return PENDING_INPUT_MODE_QUEUE
        if running:
            return PENDING_INPUT_MODE_STEER
        return PENDING_INPUT_MODE_QUEUE if has_queue else PENDING_INPUT_MODE_STEER

    async def _emit_pending_input_event(
        self,
        session_id: str,
        action: str,
        record: Any,
    ) -> None:
        payload = self._pending_input_payload(record)
        repositories = getattr(self._chat_service, "repositories", None)
        if repositories is not None and hasattr(repositories, "message_events"):
            try:
                repositories.message_events.append(
                    event_id=new_id(),
                    session_id=session_id,
                    turn_index=(
                        record.promoted_turn_index
                        or record.target_turn_index
                        or 0
                    ),
                    action=action,
                    data=payload,
                    trace_record_id=record.promoted_trace_id or record.target_trace_id,
                )
            except Exception as exc:
                logger.opt(exception=True).warning(
                    "[ChatStreamManager] pending input 事件持久化失败 | "
                    f"session_id={session_id} | action={action} | "
                    f"pending_input_id={record.id} | error={exc}"
                )
        await self.broadcast(session_id=session_id, action=action, data=payload)

    @staticmethod
    def _pending_input_payload(record: Any, *, duplicate: bool = False) -> dict[str, Any]:
        payload = record.to_dict()
        payload["pending_input"] = record.to_dict()
        if duplicate:
            payload["duplicate"] = True
        return payload
