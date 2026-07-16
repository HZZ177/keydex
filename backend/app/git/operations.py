from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Generic, Literal, TypeVar

from backend.app.core.logger import redact_sensitive

from .runner import redact_git_output

T = TypeVar("T")
GitQueuedOperationState = Literal[
    "queued", "running", "cancelling", "succeeded", "failed", "cancelled"
]


@dataclass(frozen=True)
class GitOperationSnapshot:
    operation_id: str
    repository_id: str
    idempotency_key: str
    state: GitQueuedOperationState
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    error_code: str | None = None
    error_details: dict[str, Any] | None = None
    retryable: bool = False


@dataclass(frozen=True)
class GitOperationContext:
    operation_id: str
    repository_id: str
    cancel_event: asyncio.Event


class GitOperationHandle(Generic[T]):
    def __init__(
        self,
        queue: GitOperationQueue,
        operation_id: str,
        task: asyncio.Task[T | None],
    ) -> None:
        self._queue = queue
        self.operation_id = operation_id
        self._task = task

    @property
    def snapshot(self) -> GitOperationSnapshot:
        return self._queue.snapshot(self.operation_id)

    async def result(self) -> T | None:
        return await self._task

    def cancel(self) -> bool:
        return self._queue.cancel(self.operation_id)


class GitOperationQueue:
    def __init__(self) -> None:
        self._repository_locks: dict[str, asyncio.Lock] = {}
        self._snapshots: dict[str, GitOperationSnapshot] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._tasks: dict[str, asyncio.Task[object | None]] = {}
        self._idempotency: dict[tuple[str, str], str] = {}
        self._listeners: set[Callable[[GitOperationSnapshot], None]] = set()

    def submit(
        self,
        *,
        repository_id: str,
        idempotency_key: str,
        operation: Callable[[GitOperationContext], Awaitable[T]],
    ) -> GitOperationHandle[T]:
        if not repository_id.strip():
            raise ValueError("repository_id is required")
        if len(idempotency_key.strip()) < 8:
            raise ValueError("idempotency_key must contain at least 8 characters")
        dedupe_key = (repository_id, idempotency_key)
        existing_id = self._idempotency.get(dedupe_key)
        if existing_id is not None:
            return GitOperationHandle(
                self,
                existing_id,
                self._tasks[existing_id],  # type: ignore[arg-type]
            )

        operation_id = str(uuid.uuid4())
        cancel_event = asyncio.Event()
        snapshot = GitOperationSnapshot(
            operation_id=operation_id,
            repository_id=repository_id,
            idempotency_key=idempotency_key,
            state="queued",
            created_at=_now(),
        )
        self._snapshots[operation_id] = snapshot
        self._cancel_events[operation_id] = cancel_event
        self._idempotency[dedupe_key] = operation_id
        task: asyncio.Task[T | None] = asyncio.create_task(
            self._execute(snapshot, cancel_event, operation)
        )
        self._tasks[operation_id] = task  # type: ignore[assignment]
        self._publish(snapshot)
        return GitOperationHandle(self, operation_id, task)

    def subscribe(self, listener: Callable[[GitOperationSnapshot], None]) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    def snapshot(self, operation_id: str) -> GitOperationSnapshot:
        try:
            return self._snapshots[operation_id]
        except KeyError as exc:
            raise KeyError(f"Unknown Git operation: {operation_id}") from exc

    def cancel(self, operation_id: str) -> bool:
        snapshot = self.snapshot(operation_id)
        if snapshot.state in {"succeeded", "failed", "cancelled"}:
            return False
        self._cancel_events[operation_id].set()
        self._update(operation_id, state="cancelling")
        return True

    async def _execute(
        self,
        snapshot: GitOperationSnapshot,
        cancel_event: asyncio.Event,
        operation: Callable[[GitOperationContext], Awaitable[T]],
    ) -> T | None:
        lock = self._repository_locks.setdefault(snapshot.repository_id, asyncio.Lock())
        async with lock:
            if cancel_event.is_set():
                self._update(snapshot.operation_id, state="cancelled", finished_at=_now())
                return None
            self._update(snapshot.operation_id, state="running", started_at=_now())
            context = GitOperationContext(
                operation_id=snapshot.operation_id,
                repository_id=snapshot.repository_id,
                cancel_event=cancel_event,
            )
            try:
                result = await operation(context)
            except asyncio.CancelledError:
                self._update(snapshot.operation_id, state="cancelled", finished_at=_now())
                raise
            except Exception as exc:
                payload = getattr(exc, "payload", None)
                message = redact_git_output(str(getattr(payload, "message", exc)))
                self._update(
                    snapshot.operation_id,
                    state="failed",
                    finished_at=_now(),
                    error=message,
                    error_code=getattr(payload, "code", None),
                    error_details=redact_sensitive(
                        dict(getattr(payload, "details", {}) or {})
                    ),
                    retryable=bool(getattr(payload, "retryable", False)),
                )
                return None
            if cancel_event.is_set():
                self._update(snapshot.operation_id, state="cancelled", finished_at=_now())
            else:
                self._update(snapshot.operation_id, state="succeeded", finished_at=_now())
            return result

    def _update(self, operation_id: str, **changes: object) -> None:
        snapshot = replace(self._snapshots[operation_id], **changes)
        self._snapshots[operation_id] = snapshot
        self._publish(snapshot)

    def _publish(self, snapshot: GitOperationSnapshot) -> None:
        for listener in tuple(self._listeners):
            listener(snapshot)


def _now() -> str:
    return datetime.now(UTC).isoformat()
