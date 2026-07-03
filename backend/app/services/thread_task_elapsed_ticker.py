from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from backend.app.core.logger import logger
from backend.app.events.actions import ChatAction


class ThreadTaskElapsedTicker:
    def __init__(
        self,
        *,
        thread_task_service: Any,
        chat_stream_manager: Any,
        interval_seconds: float = 1.0,
    ) -> None:
        self._thread_task_service = thread_task_service
        self._chat_stream_manager = chat_stream_manager
        self._interval_seconds = max(0.25, float(interval_seconds))
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="thread-task-elapsed-ticker")

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    async def publish_once(self) -> int:
        tasks = self._thread_task_service.list_active_tasks()
        sent_count = 0
        for task in tasks:
            session_id = str(task.get("session_id") or "").strip()
            task_id = str(task.get("id") or "").strip()
            if not session_id or not task_id:
                continue
            sent = await self._chat_stream_manager.broadcast(
                session_id=session_id,
                action=ChatAction.TASK_UPDATED.value,
                data={
                    "session_id": session_id,
                    "task_id": task_id,
                    "task": task,
                    "run_id": task.get("current_run_id"),
                    "timer_tick": True,
                },
            )
            if sent:
                sent_count += 1
        return sent_count

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._interval_seconds)
            try:
                await self.publish_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.opt(exception=True).warning(
                    f"[ThreadTaskElapsedTicker] 目标耗时实时推送失败 | error={exc}"
                )
