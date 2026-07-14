from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from backend.app.core.time import to_iso_z, utc_now
from backend.app.core.logger import logger
from backend.app.events import DomainEventType
from backend.app.services.thread_task_runtime import ThreadTaskStateLocks
from backend.app.storage import (
    THREAD_TASK_OPEN_STATUSES,
    THREAD_TASK_STATUS_ACTIVE,
    THREAD_TASK_STATUS_BLOCKED,
    THREAD_TASK_STATUS_CANCELLED,
    THREAD_TASK_STATUS_PAUSED,
    THREAD_TASK_TYPE_GOAL,
    THREAD_TASK_TYPES,
    StorageRepositories,
    ThreadTaskRecord,
)

THREAD_TASK_OBJECTIVE_MAX_CHARS = 4000
THREAD_TASK_CONSECUTIVE_FAILURE_LIMIT = 3
THREAD_TASK_OBJECTIVE_LOG_PREVIEW_CHARS = 120
THREAD_TASK_TYPE_LABELS = {
    THREAD_TASK_TYPE_GOAL: "目标",
}
THREAD_TASK_AGENT_STATUSES = frozenset({"complete", "blocked"})
THREAD_TASK_SEED_CONTEXT_METADATA_KEY = "seed_turn_context"
THREAD_TASK_ACTIVE_TIMER_METADATA_KEY = "active_timer"
THREAD_TASK_ACTIVE_STARTED_AT_KEY = "active_started_at"
_CUSTOM_THREAD_TASK_TYPE_PATTERN = re.compile(r"^[a-z][a-z0-9_:-]{0,63}$")
_UNSET = object()


class ThreadTaskServiceError(Exception):
    code = "thread_task_error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class ThreadTaskNotFoundError(ThreadTaskServiceError):
    code = "task_not_found"


class ThreadTaskSessionNotFoundError(ThreadTaskServiceError):
    code = "session_not_found"


class ThreadTaskSessionArchivedError(ThreadTaskServiceError):
    code = "entity_archived"


class ThreadTaskValidationError(ThreadTaskServiceError):
    code = "invalid_task_payload"


class ThreadTaskConflictError(ThreadTaskServiceError):
    code = "task_already_open"


class ThreadTaskTransitionError(ThreadTaskServiceError):
    code = "status_transition_not_allowed"


class ThreadTaskService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        state_locks: ThreadTaskStateLocks | None = None,
        event_publisher: Any | None = None,
        task_type_labels: Mapping[str, str] | None = None,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self._repositories = repositories
        self._sessions = repositories.sessions
        self._tasks = repositories.thread_tasks
        self._runs = repositories.thread_task_runs
        self._state_locks = state_locks or ThreadTaskStateLocks()
        self._event_publisher = event_publisher
        self._task_type_labels = self._build_task_type_labels(task_type_labels)
        self._now_provider = now_provider or utc_now

    def set_event_publisher(self, event_publisher: Any | None) -> None:
        self._event_publisher = event_publisher

    def list_tasks(self, session_id: str) -> list[dict[str, Any]]:
        self._require_session(session_id)
        return [self.serialize_task(record) for record in self._tasks.list_by_session(session_id)]

    def list_runs(self, session_id: str, task_id: str) -> list[dict[str, Any]]:
        task = self._require_task(session_id, task_id)
        return [self.serialize_run(record) for record in self._runs.list_by_task(task.id)]

    def get_open_task(self, session_id: str) -> dict[str, Any] | None:
        self._require_session(session_id)
        record = self._tasks.get_open_by_session(session_id)
        return self.serialize_task(record) if record else None

    def list_active_tasks(self) -> list[dict[str, Any]]:
        return [
            self.serialize_task(record)
            for record in self._tasks.list_by_status(THREAD_TASK_STATUS_ACTIVE)
        ]

    def create_task(
        self,
        *,
        session_id: str,
        type: str,
        objective: str,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            session = self._require_session(session_id)
            task_type = self._clean_type(type)
            cleaned_objective = self._clean_objective(objective)
            if self._tasks.get_open_by_session(session_id) is not None:
                raise ThreadTaskConflictError("当前会话已有未结束的长程任务")
            normalized_metadata = self._metadata_for_create(
                metadata,
                context_compression_epoch=session.context_compression_epoch,
                active_started_at=self._now_iso(),
            )
            record = self._tasks.create(
                session_id=session_id,
                type=task_type,
                title=self._clean_optional_text(title),
                objective=cleaned_objective,
                metadata=normalized_metadata,
            )
            self._publish_task_updated(record)
            self._log_task_lifecycle(
                "created",
                record,
                objective=cleaned_objective,
            )
            return self.serialize_task(record)

    def edit_task(
        self,
        *,
        session_id: str,
        task_id: str,
        objective: str,
        title: str | None | object = _UNSET,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            self._ensure_mutable(task)
            update_kwargs: dict[str, Any] = {
                "objective": self._clean_objective(objective),
                "metadata": metadata,
            }
            if title is not _UNSET:
                update_kwargs["title"] = self._clean_optional_text(title)
            if metadata is not None:
                update_kwargs["metadata"] = self._preserve_timer_metadata(task.metadata, metadata)
            updated = self._tasks.update(task.id, **update_kwargs)
            if updated is None:
                raise ThreadTaskNotFoundError(f"任务不存在: {task_id}")
            self._publish_task_updated(updated)
            self._log_task_lifecycle("edited", updated, objective=updated.objective)
            return self.serialize_task(updated)

    def update_task_from_user(
        self,
        *,
        session_id: str,
        task_id: str,
        objective: str | None = None,
        title: str | None | object = _UNSET,
        status: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            result: dict[str, Any] | None = None
            if objective is not None or title is not _UNSET or metadata is not None:
                current = self._require_task(session_id, task_id)
                self._ensure_mutable(current)
                if objective is None:
                    objective = current.objective
                if metadata is not None:
                    metadata = self._preserve_timer_metadata(current.metadata, metadata)
                result = self.edit_task(
                    session_id=session_id,
                    task_id=task_id,
                    objective=objective,
                    title=title,
                    metadata=metadata,
                )
            if status is not None:
                result = self._apply_user_status(
                    session_id=session_id,
                    task_id=task_id,
                    status=status,
                )
            if result is not None:
                return result
            task = self._require_task(session_id, task_id)
            return self.serialize_task(task)

    def update_task_from_agent(
        self,
        *,
        session_id: str,
        task_id: str,
        status: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            if status not in THREAD_TASK_AGENT_STATUSES:
                raise ThreadTaskTransitionError("agent 只能提交 complete 或 blocked")
            task = self._require_task(session_id, task_id)
            if task.status != THREAD_TASK_STATUS_ACTIVE:
                raise ThreadTaskTransitionError("agent 只能更新进行中的任务")
            data = payload or {}
            if status == "complete":
                return self._mark_complete_from_agent(task, data)
            return self._mark_blocked_from_agent(task, data)

    def mark_system_stopped(
        self,
        *,
        session_id: str,
        task_id: str,
        reason: str,
        run_id: str | None = None,
        trace_id: str | None = None,
        failure_count: int | None = None,
    ) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            if task.is_terminal:
                return self.serialize_task(task)
            stopped_reason = self._required_text(reason, "system_stopped 必须包含停止原因")
            metadata = dict(task.metadata)
            elapsed_seconds, metadata = self._settle_active_timer(task, metadata=metadata)
            metadata["system_stop"] = {
                "reason": stopped_reason,
                "run_id": run_id,
                "trace_id": trace_id,
                "failure_count": failure_count,
            }
            updated = self._tasks.update(
                task.id,
                status="system_stopped",
                system_stop_reason=stopped_reason,
                current_run_id=run_id,
                elapsed_seconds=elapsed_seconds,
                metadata=metadata,
            )
            if updated is None:
                raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
            self._publish_task_updated(updated, run_id=run_id, trace_id=trace_id)
            self._log_task_lifecycle(
                "system_stopped",
                updated,
                run_id=run_id,
                trace_id=trace_id,
                reason=stopped_reason,
                failure_count=failure_count,
                level="warning",
            )
            return self.serialize_task(updated)

    def record_system_failure(
        self,
        *,
        session_id: str,
        task_id: str,
        reason: str,
        run_id: str | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            if task.is_terminal:
                return self.serialize_task(task)
            metadata = dict(task.metadata)
            failure_state = metadata.get("system_failures")
            if not isinstance(failure_state, dict):
                failure_state = {}
            previous_reason = str(failure_state.get("reason") or "")
            previous_count = int(failure_state.get("count") or 0) if previous_reason else 0
            cleaned_reason = self._required_text(reason, "系统失败原因不能为空")
            count = previous_count + 1 if previous_reason == cleaned_reason else 1
            if count >= THREAD_TASK_CONSECUTIVE_FAILURE_LIMIT:
                return self.mark_system_stopped(
                    session_id=session_id,
                    task_id=task_id,
                    reason=cleaned_reason,
                    run_id=run_id,
                    trace_id=trace_id,
                    failure_count=count,
                )
            metadata["system_failures"] = {
                "reason": cleaned_reason,
                "count": count,
                "run_id": run_id,
                "trace_id": trace_id,
            }
            updated = self._tasks.update(task.id, metadata=metadata, current_run_id=run_id)
            if updated is None:
                raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
            self._publish_task_updated(updated, run_id=run_id, trace_id=trace_id)
            self._log_task_lifecycle(
                "system_failure_recorded",
                updated,
                run_id=run_id,
                trace_id=trace_id,
                reason=cleaned_reason,
                failure_count=count,
                level="warning",
            )
            return self.serialize_task(updated)

    def pause_task(self, *, session_id: str, task_id: str) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            if task.status == THREAD_TASK_STATUS_PAUSED:
                return self.serialize_task(task)
            if task.status not in {THREAD_TASK_STATUS_ACTIVE, THREAD_TASK_STATUS_BLOCKED}:
                raise ThreadTaskTransitionError("只有进行中或已阻塞任务可以暂停")
            return self._update_user_status(task, THREAD_TASK_STATUS_PAUSED)

    def resume_task(self, *, session_id: str, task_id: str) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            if task.status == THREAD_TASK_STATUS_ACTIVE:
                return self.serialize_task(task)
            if task.status not in {THREAD_TASK_STATUS_PAUSED, THREAD_TASK_STATUS_BLOCKED}:
                raise ThreadTaskTransitionError("只有暂停或阻塞任务可以恢复")
            metadata = self._metadata_with_active_timer(task.metadata, self._now_iso())
            updated = self._tasks.update(
                task.id,
                status=THREAD_TASK_STATUS_ACTIVE,
                blocked_audit={},
                metadata=metadata,
            )
            if updated is None:
                raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
            self._publish_task_updated(updated)
            return self.serialize_task(updated)

    def cancel_task(self, *, session_id: str, task_id: str) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            if task.status == THREAD_TASK_STATUS_CANCELLED:
                return self.serialize_task(task)
            if task.status not in THREAD_TASK_OPEN_STATUSES:
                raise ThreadTaskTransitionError("只有未结束任务可以取消")
            return self._update_user_status(task, THREAD_TASK_STATUS_CANCELLED)

    def _apply_user_status(self, *, session_id: str, task_id: str, status: str) -> dict[str, Any]:
        if status == THREAD_TASK_STATUS_ACTIVE:
            return self.resume_task(session_id=session_id, task_id=task_id)
        if status == THREAD_TASK_STATUS_PAUSED:
            return self.pause_task(session_id=session_id, task_id=task_id)
        if status == THREAD_TASK_STATUS_CANCELLED:
            return self.cancel_task(session_id=session_id, task_id=task_id)
        raise ThreadTaskTransitionError("用户只能恢复、暂停或取消任务")

    def delete_task(self, *, session_id: str, task_id: str) -> dict[str, Any]:
        with self._state_locks.acquire(session_id):
            task = self._require_task(session_id, task_id)
            if task.status in THREAD_TASK_OPEN_STATUSES:
                elapsed_seconds, metadata = self._settle_active_timer(task)
                task = self._tasks.update(
                    task.id,
                    status=THREAD_TASK_STATUS_CANCELLED,
                    elapsed_seconds=elapsed_seconds,
                    metadata=metadata,
                ) or task
            deleted = self._tasks.soft_delete(task.id)
            if deleted is None:
                raise ThreadTaskNotFoundError(f"任务不存在: {task_id}")
            self._publish_task_deleted(deleted)
            self._log_task_lifecycle("deleted", deleted)
            return self.serialize_task(deleted)

    def _update_user_status(self, task: ThreadTaskRecord, status: str) -> dict[str, Any]:
        metadata = dict(task.metadata)
        elapsed_seconds: int | None = None
        if status != THREAD_TASK_STATUS_ACTIVE:
            elapsed_seconds, metadata = self._settle_active_timer(task, metadata=metadata)
        updated = self._tasks.update(
            task.id,
            status=status,
            metadata=metadata,
            elapsed_seconds=elapsed_seconds,
        )
        if updated is None:
            raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
        self._publish_task_updated(updated)
        self._log_task_lifecycle("status_updated", updated)
        return self.serialize_task(updated)

    def _mark_complete_from_agent(
        self,
        task: ThreadTaskRecord,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        summary = self._required_text(payload.get("summary"), "完成摘要不能为空")
        checklist = payload.get("checklist")
        if not isinstance(checklist, list) or not checklist:
            raise ThreadTaskValidationError("complete 必须包含非空 checklist")
        evidence = payload.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise ThreadTaskValidationError("complete 必须包含非空 evidence")
        normalized_evidence = [self._normalize_evidence_item(item) for item in evidence]
        completion_evidence: list[Any] = [
            {
                "type": "completion_summary",
                "summary": summary,
                "checklist": checklist,
            },
            *normalized_evidence,
        ]
        elapsed_seconds, metadata = self._settle_active_timer(task)
        updated = self._tasks.update(
            task.id,
            status="complete",
            evidence=completion_evidence,
            blocked_audit={},
            metadata=metadata,
            elapsed_seconds=elapsed_seconds,
        )
        if updated is None:
            raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
        self._publish_task_updated(updated)
        self._log_task_lifecycle(
            "completed",
            updated,
            evidence_count=len(completion_evidence),
            checklist_count=len(checklist),
        )
        return self.serialize_task(updated)

    def _mark_blocked_from_agent(
        self,
        task: ThreadTaskRecord,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        reason = self._required_text(payload.get("reason"), "blocked 必须包含阻塞原因")
        audit_key = self._required_text(
            payload.get("blocked_audit_key"),
            "blocked 必须包含 blocked_audit_key",
        )
        attempts = payload.get("attempts")
        if not isinstance(attempts, list) or not attempts:
            raise ThreadTaskValidationError("blocked 必须包含非空 attempts")
        previous_key = str(task.blocked_audit.get("key") or "")
        previous_count = int(task.blocked_audit.get("count") or 0) if previous_key else 0
        count = previous_count + 1 if previous_key == audit_key else 1
        audit = {
            "key": audit_key,
            "count": count,
            "reason": reason,
            "attempts": attempts,
        }
        if count < 3:
            updated = self._tasks.update(task.id, blocked_audit=audit)
            if updated is None:
                raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
            self._publish_task_updated(updated)
            raise ThreadTaskTransitionError("blocked 需要同一阻塞条件连续至少三轮")
        elapsed_seconds, metadata = self._settle_active_timer(task)
        updated = self._tasks.update(
            task.id,
            status=THREAD_TASK_STATUS_BLOCKED,
            blocked_audit=audit,
            metadata=metadata,
            elapsed_seconds=elapsed_seconds,
        )
        if updated is None:
            raise ThreadTaskNotFoundError(f"任务不存在: {task.id}")
        self._publish_task_updated(updated)
        self._log_task_lifecycle(
            "blocked",
            updated,
            reason=reason,
            failure_count=count,
            level="warning",
        )
        return self.serialize_task(updated)

    def _require_session(self, session_id: str) -> Any:
        session = self._sessions.get(session_id)
        if session is None:
            if self._sessions.get_archived(session_id) is not None:
                raise ThreadTaskSessionArchivedError(f"会话已归档: {session_id}")
            raise ThreadTaskSessionNotFoundError(f"会话不存在: {session_id}")
        return session

    def _require_task(self, session_id: str, task_id: str) -> ThreadTaskRecord:
        self._require_session(session_id)
        task = self._tasks.get(task_id, include_deleted=True)
        if task is None or task.session_id != session_id or task.deleted_at is not None:
            raise ThreadTaskNotFoundError(f"任务不存在: {task_id}")
        return task

    @staticmethod
    def _ensure_mutable(task: ThreadTaskRecord) -> None:
        if task.is_terminal:
            raise ThreadTaskTransitionError("已结束任务不能直接编辑")

    def _clean_type(self, type: str) -> str:
        cleaned = str(type or "").strip()
        if cleaned not in self._task_type_labels:
            raise ThreadTaskValidationError(
                f"不支持的任务类型: {cleaned or '-'}",
                code="unsupported_task_type",
            )
        return cleaned

    @staticmethod
    def _clean_objective(objective: str) -> str:
        cleaned = str(objective or "").strip()
        if not cleaned:
            raise ThreadTaskValidationError("任务目标不能为空", code="invalid_task_objective")
        if len(cleaned) > THREAD_TASK_OBJECTIVE_MAX_CHARS:
            raise ThreadTaskValidationError(
                f"任务目标不能超过 {THREAD_TASK_OBJECTIVE_MAX_CHARS} 字符",
                code="invalid_task_objective",
            )
        return cleaned

    @staticmethod
    def _clean_optional_text(value: str | None | object) -> str | None:
        if value is None:
            return None
        cleaned = str(value).strip()
        return cleaned or None

    @staticmethod
    def _required_text(value: Any, message: str) -> str:
        cleaned = str(value or "").strip()
        if not cleaned:
            raise ThreadTaskValidationError(message)
        return cleaned

    def _metadata_for_create(
        self,
        metadata: dict[str, Any] | None,
        *,
        context_compression_epoch: int,
        active_started_at: str,
    ) -> dict[str, Any]:
        normalized = dict(metadata or {})
        seed = normalized.get(THREAD_TASK_SEED_CONTEXT_METADATA_KEY)
        if isinstance(seed, dict):
            seed_metadata = dict(seed)
            epoch = max(0, int(context_compression_epoch or 0))
            seed_metadata["created_compression_epoch"] = epoch
            seed_metadata["last_replayed_compression_epoch"] = epoch
            normalized[THREAD_TASK_SEED_CONTEXT_METADATA_KEY] = seed_metadata
        return self._metadata_with_active_timer(normalized, active_started_at)

    @staticmethod
    def _metadata_with_active_timer(metadata: dict[str, Any], active_started_at: str | None) -> dict[str, Any]:
        normalized = dict(metadata or {})
        timer = normalized.get(THREAD_TASK_ACTIVE_TIMER_METADATA_KEY)
        timer = dict(timer) if isinstance(timer, dict) else {}
        if active_started_at:
            timer[THREAD_TASK_ACTIVE_STARTED_AT_KEY] = active_started_at
            normalized[THREAD_TASK_ACTIVE_TIMER_METADATA_KEY] = timer
            return normalized
        timer.pop(THREAD_TASK_ACTIVE_STARTED_AT_KEY, None)
        if timer:
            normalized[THREAD_TASK_ACTIVE_TIMER_METADATA_KEY] = timer
        else:
            normalized.pop(THREAD_TASK_ACTIVE_TIMER_METADATA_KEY, None)
        return normalized

    @staticmethod
    def _preserve_timer_metadata(
        current_metadata: dict[str, Any],
        next_metadata: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = dict(next_metadata or {})
        if THREAD_TASK_ACTIVE_TIMER_METADATA_KEY not in normalized:
            current_timer = current_metadata.get(THREAD_TASK_ACTIVE_TIMER_METADATA_KEY)
            if isinstance(current_timer, dict):
                normalized[THREAD_TASK_ACTIVE_TIMER_METADATA_KEY] = dict(current_timer)
        return normalized

    def _settle_active_timer(
        self,
        task: ThreadTaskRecord,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        next_metadata = dict(task.metadata if metadata is None else metadata)
        elapsed_seconds = self._elapsed_seconds_for_record(task, now=self._now(), metadata=next_metadata)
        return elapsed_seconds, self._metadata_with_active_timer(next_metadata, None)

    def _elapsed_seconds_for_record(
        self,
        record: ThreadTaskRecord,
        *,
        now: datetime | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        persisted = max(0, int(record.elapsed_seconds or 0))
        if record.status != THREAD_TASK_STATUS_ACTIVE:
            return persisted
        started_at = self._active_timer_started_at(record, metadata=metadata)
        if started_at is None:
            return persisted
        resolved_now = now or self._now()
        return persisted + max(0, int((resolved_now - started_at).total_seconds()))

    @staticmethod
    def _active_timer_started_at(
        record: ThreadTaskRecord,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> datetime | None:
        source = record.metadata if metadata is None else metadata
        timer = source.get(THREAD_TASK_ACTIVE_TIMER_METADATA_KEY)
        raw_started_at = ""
        if isinstance(timer, dict):
            raw_started_at = str(timer.get(THREAD_TASK_ACTIVE_STARTED_AT_KEY) or "").strip()
        if not raw_started_at and record.status == THREAD_TASK_STATUS_ACTIVE:
            raw_started_at = str(record.created_at or "").strip()
        return _parse_iso_datetime(raw_started_at)

    def _now(self) -> datetime:
        value = self._now_provider()
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)

    def _now_iso(self) -> str:
        return to_iso_z(self._now())

    @staticmethod
    def _public_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(metadata or {})
        normalized.pop(THREAD_TASK_ACTIVE_TIMER_METADATA_KEY, None)
        return normalized

    @staticmethod
    def _normalize_evidence_item(item: Any) -> dict[str, Any]:
        if isinstance(item, dict):
            if not any(str(item.get(key) or "").strip() for key in ("title", "detail", "summary")):
                raise ThreadTaskValidationError("evidence 条目必须包含 title/detail/summary")
            return dict(item)
        text = str(item or "").strip()
        if not text:
            raise ThreadTaskValidationError("evidence 条目不能为空")
        return {"type": "note", "detail": text}

    def _publish_task_updated(
        self,
        task: ThreadTaskRecord,
        *,
        run_id: str | None = None,
        trace_id: str | None = None,
        turn_index: int | None = None,
    ) -> None:
        if self._event_publisher is None:
            return
        self._event_publisher.publish(
            event_type=DomainEventType.THREAD_TASK_UPDATED,
            session_id=task.session_id,
            payload={
                "task_id": task.id,
                "task": self.serialize_task(task),
                "run_id": run_id or task.current_run_id,
                "trace_id": trace_id,
                "turn_index": turn_index,
            },
            trace_id=trace_id,
            run_id=run_id or task.current_run_id,
            turn_index=turn_index,
        )

    def _publish_task_deleted(self, task: ThreadTaskRecord) -> None:
        if self._event_publisher is None:
            return
        self._event_publisher.publish(
            event_type=DomainEventType.THREAD_TASK_DELETED,
            session_id=task.session_id,
            payload={
                "task_id": task.id,
                "task": self.serialize_task(task),
                "run_id": task.current_run_id,
                "trace_id": None,
                "turn_index": None,
            },
            run_id=task.current_run_id,
        )

    def _log_task_lifecycle(
        self,
        action: str,
        task: ThreadTaskRecord,
        *,
        run_id: str | None = None,
        trace_id: str | None = None,
        reason: str | None = None,
        failure_count: int | None = None,
        objective: str | None = None,
        evidence_count: int | None = None,
        checklist_count: int | None = None,
        level: str = "info",
    ) -> None:
        parts = [
            f"[ThreadTask] {action}",
            f"session_id={task.session_id}",
            f"task_id={task.id}",
            f"type={task.type}",
            f"status={task.status}",
        ]
        if run_id:
            parts.append(f"run_id={run_id}")
        if trace_id:
            parts.append(f"trace_id={trace_id}")
        if reason:
            parts.append(f"reason={_log_value(reason, 160)}")
        if failure_count is not None:
            parts.append(f"failure_count={failure_count}")
        if evidence_count is not None:
            parts.append(f"evidence_count={evidence_count}")
        if checklist_count is not None:
            parts.append(f"checklist_count={checklist_count}")
        if objective is not None:
            parts.append(f"objective_preview={_objective_preview(objective)}")
            parts.append(f"objective_len={len(objective)}")
        log_message = " | ".join(parts)
        if level == "warning":
            logger.warning(log_message)
        else:
            logger.info(log_message)

    def serialize_task(self, record: ThreadTaskRecord) -> dict[str, Any]:
        return {
            "id": record.id,
            "session_id": record.session_id,
            "type": record.type,
            "type_label": self._task_type_labels.get(record.type, "任务"),
            "title": record.title,
            "objective": record.objective,
            "status": record.status,
            "metadata": self._public_metadata(record.metadata),
            "evidence": list(record.evidence),
            "blocked_audit": dict(record.blocked_audit),
            "system_stop_reason": record.system_stop_reason,
            "current_run_id": record.current_run_id,
            "turn_count": record.turn_count,
            "elapsed_seconds": self._elapsed_seconds_for_record(record),
            "token_usage": dict(record.token_usage),
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "deleted_at": record.deleted_at,
            "is_open": record.is_open,
            "is_terminal": record.is_terminal,
        }

    @staticmethod
    def _build_task_type_labels(task_type_labels: Mapping[str, str] | None) -> dict[str, str]:
        labels = dict(THREAD_TASK_TYPE_LABELS)
        for raw_type, raw_label in dict(task_type_labels or {}).items():
            cleaned_type = str(raw_type or "").strip()
            if cleaned_type not in THREAD_TASK_TYPES and not _is_custom_task_type(cleaned_type):
                raise ThreadTaskValidationError(
                    f"不支持的任务类型: {cleaned_type or '-'}",
                    code="unsupported_task_type",
                )
            cleaned_label = str(raw_label or "").strip()
            labels[cleaned_type] = cleaned_label or "任务"
        return labels

    @staticmethod
    def serialize_run(record) -> dict[str, Any]:
        return {
            "id": record.id,
            "task_id": record.task_id,
            "session_id": record.session_id,
            "turn_index": record.turn_index,
            "trace_id": record.trace_id,
            "status": record.status,
            "summary": dict(record.summary),
            "error": dict(record.error),
            "started_at": record.started_at,
            "finished_at": record.finished_at,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "is_running": record.is_running,
        }


def _is_custom_task_type(value: str) -> bool:
    return _CUSTOM_THREAD_TASK_TYPE_PATTERN.fullmatch(value) is not None


def _objective_preview(value: str) -> str:
    return _log_value(value, THREAD_TASK_OBJECTIVE_LOG_PREVIEW_CHARS)


def _log_value(value: str, limit: int) -> str:
    normalized = " ".join(str(value or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[:limit]}..."


def _parse_iso_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)
