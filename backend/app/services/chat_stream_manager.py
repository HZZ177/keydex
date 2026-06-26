from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from backend.app.core.logger import logger
from backend.app.events import ChatProjectionAdapter
from backend.app.services.chat_types import ChatCancellationToken, ChatRequest


class ChatStreamError(Exception):
    """Base error for background chat stream management."""


class ChatStreamAlreadyRunningError(ChatStreamError):
    """Raised when a session already has a running turn."""


class ChatStreamMissingSessionError(ChatStreamError):
    """Raised when a background chat request has no session id."""


@dataclass(slots=True)
class ChatStreamRun:
    session_id: str
    task: asyncio.Task
    cancellation: ChatCancellationToken
    started_at_ms: int


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
                task=task,
                cancellation=cancellation,
                started_at_ms=int(time.time() * 1000),
            )
            task.add_done_callback(lambda done_task: self._schedule_finish(session_id, done_task))

        logger.info(f"[ChatStreamManager] 后台对话已启动 | session_id={session_id}")
        return session_id

    async def cancel(self, session_id: str | None = None) -> bool:
        cleaned = (session_id or "").strip()
        if not cleaned:
            return False
        async with self._lock:
            run = self._runs.get(cleaned)
            if run is None or run.task.done():
                return False
            run.cancellation.cancel()
            run.task.cancel()
        logger.info(f"[ChatStreamManager] 已请求强制取消后台对话 | session_id={cleaned}")
        return True

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

    async def status(self, session_id: str | None = None) -> dict[str, Any]:
        async with self._lock:
            running = {
                key: run
                for key, run in self._runs.items()
                if not run.task.done()
            }
        cleaned = (session_id or "").strip()
        repositories = getattr(self._chat_service, "repositories", None)
        pending = (
            repositories.command_approvals.list_pending(session_id=cleaned or None)
            if repositories is not None and hasattr(repositories, "command_approvals")
            else []
        )
        waiting_session_ids = sorted({approval.session_id for approval in pending})
        status = "idle"
        if cleaned and cleaned in waiting_session_ids:
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
            "waiting_approval_sessions": [
                {"session_id": key}
                for key in waiting_session_ids
            ],
            "pending_approvals": [
                {
                    "session_id": approval.session_id,
                    "approval_id": approval.id,
                    "status": approval.status,
                }
                for approval in pending
            ],
        }

    async def _run_chat(self, request: ChatRequest, cancellation: ChatCancellationToken) -> None:
        session_id = (request.session_id or "").strip()
        await self._chat_service.handle_chat(
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
        async with self._lock:
            current = self._runs.get(session_id)
            if current is not None and current.task is task:
                self._runs.pop(session_id, None)

        try:
            task.result()
        except asyncio.CancelledError:
            logger.info(f"[ChatStreamManager] 后台对话 task 已取消 | session_id={session_id}")
        except Exception as exc:
            logger.opt(exception=True).error(
                f"[ChatStreamManager] 后台对话 task 异常 | session_id={session_id} | error={exc}"
            )
        else:
            logger.info(f"[ChatStreamManager] 后台对话 task 完成 | session_id={session_id}")
