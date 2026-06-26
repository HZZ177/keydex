from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable
from typing import Any

from backend.app.core.logger import logger
from backend.app.services.chat_types import ChatCancellationToken, ChatRequest, ChatTurnResult


class AgentRuntimeInitializationError(RuntimeError):
    """Raised when the lazily initialized agent runtime cannot be created."""


class AgentRuntimeProvider:
    def __init__(self, builder: Callable[[], Any]) -> None:
        self._builder = builder
        self._chat_service: Any | None = None
        self._status = "idle"
        self._error: str | None = None
        self._started_at_ms: int | None = None
        self._finished_at_ms: int | None = None
        self._duration_ms: int | None = None
        self._lock = threading.Lock()

    @property
    def status(self) -> str:
        return self._status

    @property
    def error(self) -> str | None:
        return self._error

    def status_payload(self) -> dict[str, Any]:
        return {
            "status": self._status,
            "error": self._error,
            "started_at_ms": self._started_at_ms,
            "finished_at_ms": self._finished_at_ms,
            "duration_ms": self._duration_ms,
        }

    def warmup_sync(self) -> Any:
        return self._ensure_chat_service()

    async def warmup_async(self) -> Any:
        return await asyncio.to_thread(self.warmup_sync)

    async def get_chat_service_async(self) -> Any:
        return await asyncio.to_thread(self._ensure_chat_service)

    def _ensure_chat_service(self) -> Any:
        if self._chat_service is not None:
            return self._chat_service
        if self._status == "failed":
            raise AgentRuntimeInitializationError(self._error or "智能体运行时初始化失败")

        with self._lock:
            if self._chat_service is not None:
                return self._chat_service
            if self._status == "failed":
                raise AgentRuntimeInitializationError(self._error or "智能体运行时初始化失败")

            self._status = "warming"
            self._error = None
            self._started_at_ms = int(time.time() * 1000)
            started = time.perf_counter()
            logger.info("[AgentRuntime] 开始后台预热智能体运行时")
            try:
                self._chat_service = self._builder()
            except Exception as exc:
                self._status = "failed"
                self._error = str(exc) or exc.__class__.__name__
                self._finished_at_ms = int(time.time() * 1000)
                self._duration_ms = int((time.perf_counter() - started) * 1000)
                logger.opt(exception=True).error(
                    "[AgentRuntime] 智能体运行时预热失败 | "
                    f"duration_ms={self._duration_ms} | error={exc}"
                )
                raise AgentRuntimeInitializationError(self._error) from exc

            self._status = "ready"
            self._finished_at_ms = int(time.time() * 1000)
            self._duration_ms = int((time.perf_counter() - started) * 1000)
            logger.info(f"[AgentRuntime] 智能体运行时预热完成 | duration_ms={self._duration_ms}")
            return self._chat_service


class LazyChatService:
    def __init__(self, provider: AgentRuntimeProvider, *, repositories: Any) -> None:
        self.provider = provider
        self.repositories = repositories

    async def handle_chat(
        self,
        request: ChatRequest,
        *,
        chat_adapter: Any | None = None,
        cancellation: ChatCancellationToken | None = None,
    ) -> ChatTurnResult:
        try:
            service = await self.provider.get_chat_service_async()
        except AgentRuntimeInitializationError as exc:
            if chat_adapter is not None and request.session_id:
                await chat_adapter.send(
                    session_id=request.session_id,
                    action="error",
                    data={
                        "session_id": request.session_id,
                        "code": "agent_runtime_initialization_failed",
                        "message": str(exc),
                    },
                )
            raise
        return await service.handle_chat(
            request,
            chat_adapter=chat_adapter,
            cancellation=cancellation,
        )
