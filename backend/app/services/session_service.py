from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.app.core.ids import IdPrefix, new_id
from backend.app.services.message_event_service import MessageEventService
from backend.app.storage import MessageEventRecord, SessionRecord


class SessionServiceError(Exception):
    """Session service base error."""


class SessionNotFoundError(SessionServiceError):
    """Raised when a requested session does not exist."""


class SessionValidationError(SessionServiceError):
    """Raised when a session mutation payload is invalid."""


@dataclass(frozen=True)
class ListSessionsRequest:
    user_id: str | None = None
    scene_id: str | None = None
    status: str | None = None
    session_tag: str | None = None
    title: str | None = None
    current_session_id: str | None = None
    page: int = 1
    page_size: int = 20


@dataclass(frozen=True)
class GetHistoryRequest:
    session_id: str
    turn_index: int | None = None
    page: int = 1
    page_size: int = 50
    order: str = "asc"


class SessionService:
    """Desktop session facade aligned with the kt session/history contract."""

    def __init__(
        self,
        sessions_repository,
        message_events_repository,
        message_event_service: MessageEventService | None = None,
    ) -> None:
        self._sessions = sessions_repository
        self._message_events = message_events_repository
        self._message_event_service = message_event_service or MessageEventService(
            message_events_repository
        )

    def create_session(
        self,
        *,
        user_id: str,
        scene_id: str,
        title: str | None = None,
        session_tag: str = "chat",
        session_id: str | None = None,
    ) -> dict[str, Any]:
        record = self._sessions.create(
            session_id=session_id or new_id(IdPrefix.SESSION),
            user_id=user_id,
            scene_id=scene_id,
            title=title,
            session_tag=session_tag,
        )
        return self._serialize_session(record)

    def list_sessions(self, request: ListSessionsRequest) -> dict[str, Any]:
        page = max(1, int(request.page or 1))
        page_size = min(max(1, int(request.page_size or 20)), 100)
        records = self._sessions.list(
            user_id=request.user_id,
            scene_id=request.scene_id,
            status=request.status,
            session_tag=request.session_tag,
            limit=500,
        )
        if request.title:
            keyword = request.title.strip().lower()
            records = [
                record
                for record in records
                if keyword in str(record.title or "").lower()
            ]

        total = len(records)
        start = (page - 1) * page_size
        page_records = records[start : start + page_size]
        return {
            "list": [
                self._serialize_session(record, current_session_id=request.current_session_id)
                for record in page_records
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def get_session_detail(
        self,
        session_id: str,
        *,
        current_session_id: str | None = None,
    ) -> dict[str, Any]:
        record = self._require_session(session_id)
        return self._serialize_session(record, current_session_id=current_session_id)

    def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        self._require_session(session_id)
        cleaned = title.strip()
        if not cleaned:
            raise SessionValidationError("会话标题不能为空")
        record = self._sessions.update(session_id, title=cleaned)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return self._serialize_session(record)

    def delete_session(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.soft_delete(session_id)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return self._serialize_session(record)

    def get_history(self, request: GetHistoryRequest) -> dict[str, Any]:
        session = self._require_session(request.session_id)
        page = max(1, int(request.page or 1))
        page_size = min(max(1, int(request.page_size or 50)), 100)
        order = request.order if request.order in {"asc", "desc"} else "asc"

        if request.turn_index is None:
            messages = self._message_event_service.get_display_messages(request.session_id)
            event_total = len(self._message_events.list_by_session(request.session_id))
            turn_indexes = self._turn_indexes(request.session_id)
        else:
            messages = self._message_event_service.get_turn_messages(
                request.session_id,
                request.turn_index,
            )
            event_total = len(
                self._message_events.list_by_turn(request.session_id, request.turn_index)
            )
            turn_indexes = [request.turn_index] if event_total else []

        if order == "desc":
            messages = list(reversed(messages))

        total = len(messages)
        start = (page - 1) * page_size
        return {
            "list": messages[start : start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "session": self._serialize_session(session),
            "event_total": event_total,
            "turn_indexes": turn_indexes,
        }

    def close_session(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.close(session_id)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return self._serialize_session(record)

    def mark_session_failed(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.update(session_id, status="failed")
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return self._serialize_session(record)

    def touch_session(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.touch(session_id)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return self._serialize_session(record)

    def _require_session(self, session_id: str) -> SessionRecord:
        record = self._sessions.get(session_id)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return record

    def _turn_indexes(self, session_id: str) -> list[int]:
        events = self._message_events.list_by_session(session_id)
        return sorted({event.turn_index for event in events})

    @staticmethod
    def _serialize_session(
        record: SessionRecord,
        *,
        current_session_id: str | None = None,
    ) -> dict[str, Any]:
        return {
            "id": record.id,
            "user_id": record.user_id,
            "scene_id": record.scene_id,
            "status": record.status,
            "title": record.title,
            "session_tag": record.session_tag,
            "active_session_id": record.active_session_id,
            "parent_session_id": record.parent_session_id,
            "child_session_id": record.child_session_id,
            "source_trace_id": record.source_trace_id,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "is_debug": record.is_debug,
            "is_scheduled": record.is_scheduled,
            "is_current": record.id == current_session_id if current_session_id else False,
        }


def terminal_turn_indexes(events: list[MessageEventRecord]) -> list[int]:
    terminal_actions = {"completed", "cancelled", "error", "scheduled_task_result"}
    return sorted({event.turn_index for event in events if event.action in terminal_actions})
