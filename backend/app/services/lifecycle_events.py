from __future__ import annotations

import asyncio
from typing import Any

from backend.app.core.logger import logger


LIFECYCLE_EVENT_TYPES = frozenset(
    {
        "session_archived",
        "session_restored",
        "session_purged",
        "workspace_archived",
        "workspace_restored",
        "workspace_purged",
    }
)


class LifecycleEventPublisher:
    def __init__(self, chat_stream_manager: Any) -> None:
        self._chat_stream_manager = chat_stream_manager

    def publish(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type") or "")
        if event_type not in LIFECYCLE_EVENT_TYPES:
            raise ValueError(f"unsupported lifecycle event: {event_type}")
        safe_event = self._validate(event)

        async def run() -> None:
            await self._chat_stream_manager.broadcast_all(
                action=event_type,
                data=safe_event,
            )

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(run())
            return
        task = loop.create_task(run())
        task.add_done_callback(self._log_failure)

    @staticmethod
    def _validate(event: dict[str, Any]) -> dict[str, Any]:
        forbidden = {"title", "name", "root_path", "message", "session_ids"}
        if forbidden & set(event):
            raise ValueError("lifecycle event contains forbidden business content")
        required = {"type", "operation_id", "request_id", "occurred_at", "revision", "changed"}
        missing = required - set(event)
        if missing:
            raise ValueError(f"lifecycle event is missing fields: {sorted(missing)}")
        entity_field = "session_id" if event["type"].startswith("session_") else "workspace_id"
        if not isinstance(event.get(entity_field), str) or not event[entity_field]:
            raise ValueError(f"lifecycle event is missing entity field: {entity_field}")
        return dict(event)

    @staticmethod
    def _log_failure(task: asyncio.Task) -> None:
        try:
            task.result()
        except Exception as exc:
            logger.opt(exception=True).warning(
                f"[LifecycleEventPublisher] 生命周期事件发送失败 | error={exc}"
            )
