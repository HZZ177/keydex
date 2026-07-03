from __future__ import annotations

from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from threading import RLock
from typing import Any

from backend.app.core.logger import logger
from backend.app.events import DomainEventType
from backend.app.services.chat_stream_manager import ChatStreamAlreadyRunningError
from backend.app.services.chat_types import ChatRequest
from backend.app.services.thread_task_prompt import build_task_continuation_prompt
from backend.app.storage import (
    THREAD_TASK_RUN_STATUS_CANCELLED,
    THREAD_TASK_RUN_STATUS_FAILED,
    THREAD_TASK_RUN_STATUS_SKIPPED,
    THREAD_TASK_RUN_STATUS_SUCCEEDED,
    THREAD_TASK_STATUS_ACTIVE,
)

THREAD_TASK_SEED_CONTEXT_METADATA_KEY = "seed_turn_context"
_THREAD_TASK_RUNTIME_PARAM_KEYS = {
    "thread_task",
    "threadTask",
    "hide_user_message_for_transcript",
    "hideUserMessageForTranscript",
    "message_context_items",
    "messageContextItems",
}


class ThreadTaskStateLocks:
    """Per-session lock registry shared by task service and runtime."""

    def __init__(self) -> None:
        self._registry_lock = RLock()
        self._locks: dict[str, RLock] = {}

    @contextmanager
    def acquire(self, session_id: str) -> Iterator[None]:
        lock = self._lock_for_session(session_id)
        lock.acquire()
        try:
            yield
        finally:
            lock.release()

    def _lock_for_session(self, session_id: str) -> RLock:
        key = str(session_id or "").strip()
        if not key:
            key = "-"
        with self._registry_lock:
            lock = self._locks.get(key)
            if lock is None:
                lock = RLock()
                self._locks[key] = lock
            return lock


class ThreadTaskRuntime:
    def __init__(
        self,
        *,
        state_locks: ThreadTaskStateLocks | None = None,
        chat_stream_manager: Any | None = None,
        repositories: Any | None = None,
        thread_task_service: Any | None = None,
        event_publisher: Any | None = None,
    ) -> None:
        self.state_locks = state_locks or ThreadTaskStateLocks()
        self._chat_stream_manager = chat_stream_manager
        self._repositories = repositories or getattr(thread_task_service, "_repositories", None)
        self._thread_task_service = thread_task_service
        self._event_publisher = event_publisher

    def task_state_permit(self, session_id: str) -> AbstractContextManager[None]:
        return self.state_locks.acquire(session_id)

    def bind_chat_stream_manager(self, chat_stream_manager: Any) -> None:
        self._chat_stream_manager = chat_stream_manager

    def set_event_publisher(self, event_publisher: Any | None) -> None:
        self._event_publisher = event_publisher

    async def handle_chat_finished(
        self,
        session_id: str,
        *,
        request: ChatRequest | None = None,
        result: Any | None = None,
        error: BaseException | None = None,
    ) -> dict[str, Any] | None:
        if self._repositories is None:
            return None
        context = self._thread_task_context_from_request(request)
        if context is None:
            return None

        cleaned = str(session_id or "").strip()
        task_id = str(context.get("task_id") or "").strip()
        run_id = str(context.get("run_id") or "").strip()
        if not task_id or not run_id:
            return None

        response: dict[str, Any] | None = None
        finished = None
        event_task = None
        event_trace_id: str | None = None
        event_turn_index: int | None = None
        with self.state_locks.acquire(cleaned):
            run = self._repositories.thread_task_runs.get(run_id)
            if run is None or not run.is_running:
                return None

            trace_id = str(getattr(result, "trace_id", "") or "").strip() or None
            event_trace_id = trace_id
            turn_index = getattr(result, "turn_index", None)
            if turn_index is not None:
                event_turn_index = int(turn_index)
                self._repositories.thread_task_runs.attach_turn(
                    run_id,
                    turn_index=event_turn_index,
                    trace_id=trace_id,
                )

            turn_status = str(getattr(result, "status", "") or "")
            run_status = self._run_status_from_turn(turn_status, error)
            finish_payload = self._finish_payload_from_turn(
                turn_status=turn_status,
                result=result,
                error=error,
            )
            finished = self._repositories.thread_task_runs.finish(
                run_id,
                status=run_status,
                summary=finish_payload["summary"],
                error=finish_payload["error"],
            )
            task = self._repositories.thread_tasks.get(task_id, include_deleted=True)
            if task is None:
                response = {
                    "session_id": cleaned or None,
                    "task_id": task_id,
                    "run_id": run_id,
                    "status": "finished",
                    "run_status": run_status,
                }
            else:
                trace = self._repositories.trace_records.get(trace_id) if trace_id else None
                update_kwargs: dict[str, Any] = {
                    "turn_count": task.turn_count + 1,
                    "token_usage": self._next_token_usage(task.token_usage, trace),
                }
                if task.current_run_id == run_id:
                    update_kwargs["current_run_id"] = None
                self._repositories.thread_tasks.update(task_id, **update_kwargs)

                if (
                    run_status == THREAD_TASK_RUN_STATUS_FAILED
                    and task.status == THREAD_TASK_STATUS_ACTIVE
                ):
                    reason = finish_payload["error"].get("reason") or "turn_failed"
                    if self._thread_task_service is not None:
                        self._thread_task_service.record_system_failure(
                            session_id=cleaned,
                            task_id=task_id,
                            reason=reason,
                            run_id=run_id,
                            trace_id=trace_id,
                        )

                event_task = self._repositories.thread_tasks.get(task_id, include_deleted=True)
                response = {
                    "session_id": cleaned or None,
                    "task_id": task_id,
                    "run_id": run_id,
                    "status": "finished",
                    "run_status": finished.status if finished is not None else run_status,
                }

        if finished is not None:
            self._log_runtime_lifecycle(
                "run_finished",
                session_id=cleaned,
                task_id=task_id,
                run_id=run_id,
                trace_id=event_trace_id,
                turn_index=event_turn_index,
                run_status=finished.status,
                task_status=getattr(event_task, "status", None),
            )
            await self._publish_run_finished(
                run=finished,
                task=event_task,
                trace_id=event_trace_id,
                turn_index=event_turn_index,
            )
        return response

    async def handle_user_cancelled(
        self,
        session_id: str,
        *,
        request: ChatRequest | None = None,
        result: Any | None = None,
        error: BaseException | None = None,
    ) -> dict[str, Any] | None:
        if self._repositories is None or self._thread_task_service is None:
            return None
        cleaned = str(session_id or "").strip()
        if not cleaned:
            return None

        with self.state_locks.acquire(cleaned):
            task = self._repositories.thread_tasks.get_open_by_session(cleaned)
            if task is None:
                return {
                    "session_id": cleaned,
                    "status": "skipped",
                    "reason": "no_open_task",
                }
            if task.status != THREAD_TASK_STATUS_ACTIVE:
                return {
                    "session_id": cleaned,
                    "task_id": task.id,
                    "status": "skipped",
                    "reason": f"task_{task.status}",
                }
            context = self._thread_task_context_from_request(request)
            run_id = str(context.get("run_id") or "").strip() if context else None
            trace_id = str(getattr(result, "trace_id", "") or "").strip() or None
            paused = self._thread_task_service.pause_task(
                session_id=cleaned,
                task_id=task.id,
            )

        self._log_runtime_lifecycle(
            "user_cancel_paused",
            session_id=cleaned,
            task_id=task.id,
            run_id=run_id,
            trace_id=trace_id,
            task_status=paused.get("status"),
            reason=type(error).__name__ if error is not None else "turn_cancelled",
        )
        return {
            "session_id": cleaned,
            "task_id": task.id,
            "status": "paused",
            "task": paused,
        }

    async def continue_if_idle(
        self,
        session_id: str,
        *,
        reason: str = "auto_continue",
    ) -> dict[str, Any]:
        cleaned = str(session_id or "").strip()
        if self._chat_stream_manager is None:
            return {
                "session_id": cleaned or None,
                "status": "skipped",
                "reason": "chat_stream_manager_unbound",
            }

        chat_status = await self._chat_stream_manager.status(cleaned)
        gate_status = str(chat_status.get("status") or "")
        if gate_status != "idle":
            return {
                "session_id": cleaned or None,
                "status": "skipped",
                "reason": gate_status or "not_idle",
                "chat_status": chat_status,
            }

        with self.state_locks.acquire(cleaned):
            if self._repositories is None:
                return {
                    "session_id": cleaned or None,
                    "status": "skipped",
                    "reason": "repositories_unbound",
                    "chat_status": chat_status,
                }
            session = self._repositories.sessions.get(cleaned)
            if session is None:
                return {
                    "session_id": cleaned or None,
                    "status": "skipped",
                    "reason": "session_missing_or_deleted",
                }
            task = self._repositories.thread_tasks.get_open_by_session(cleaned)
            if task is None:
                return {
                    "session_id": cleaned or None,
                    "status": "skipped",
                    "reason": "no_active_task",
                }
            if task.status != THREAD_TASK_STATUS_ACTIVE:
                return {
                    "session_id": cleaned or None,
                    "task_id": task.id,
                    "status": "skipped",
                    "reason": "task_not_active",
                    "task_status": task.status,
                }

            running_run = self._repositories.thread_task_runs.get_running_by_task(task.id)
            if running_run is not None:
                return {
                    "session_id": cleaned or None,
                    "task_id": task.id,
                    "run_id": running_run.id,
                    "status": "skipped",
                    "reason": "task_run_running",
                }

            current_compression_epoch = self._context_compression_epoch(cleaned)
            seed_replay = self._build_seed_context_replay(
                task,
                current_compression_epoch=current_compression_epoch,
            )
            run = self._repositories.thread_task_runs.create_running(
                task_id=task.id,
                session_id=cleaned,
                summary={
                    "reason": reason,
                    "input_summary": task.objective[:200],
                    "seed_context_replayed": bool(seed_replay),
                    "context_compression_epoch": current_compression_epoch,
                },
            )
            updated_task = self._repositories.thread_tasks.update(
                task.id,
                current_run_id=run.id,
            ) or task
            message_injection = []
            request_message = ""
            request_attachments = None
            runtime_params: dict[str, Any] = {
                "thread_task": {
                    "task_id": task.id,
                    "run_id": run.id,
                    "trigger": "task_continue",
                    "type": task.type,
                    "reason": reason,
                    "context_compression_epoch": current_compression_epoch,
                },
            }
            if seed_replay is not None:
                request_attachments = seed_replay["attachments"]
                runtime_params["hide_user_message_for_transcript"] = True
                runtime_params["thread_task"]["seed_context_replayed"] = True
                runtime_params["thread_task"]["hide_user_message_for_transcript"] = True
                runtime_params.update(seed_replay["runtime_params"])
                message_injection.extend(seed_replay["message_injection"])
            message_injection.append(
                {
                    "type": "follow",
                    "role": "HumanMessage",
                    "content": build_task_continuation_prompt(task),
                    "hidden_for_transcript": True,
                    "metadata": {
                        "source": "thread_task",
                        "task_id": task.id,
                        "task_type": task.type,
                        "run_id": run.id,
                        "hidden_for_transcript": True,
                    },
                }
            )
            runtime_params["message_injection"] = message_injection
            request = ChatRequest(
                session_id=cleaned,
                message=request_message,
                provider_id=session.current_model_provider_id or "",
                model=session.current_model or "",
                runtime_params=runtime_params,
                attachments=request_attachments,
            )

        await self._publish_run_started(run=run, task=updated_task, reason=reason)
        self._log_runtime_lifecycle(
            "continuation_started",
            session_id=cleaned,
            task_id=task.id,
            run_id=run.id,
            trigger=reason,
            task_type=task.type,
            objective=task.objective,
        )

        try:
            await self._chat_stream_manager.start_chat(request)
            if seed_replay is not None:
                self._mark_seed_context_replayed(
                    task_id=task.id,
                    task_metadata=task.metadata,
                    compression_epoch=current_compression_epoch,
                    run_id=run.id,
                )
        except ChatStreamAlreadyRunningError:
            finished = self._repositories.thread_task_runs.finish(
                run.id,
                status=THREAD_TASK_RUN_STATUS_SKIPPED,
                summary={"reason": "busy"},
            )
            updated_task = self._repositories.thread_tasks.update(task.id, current_run_id=None)
            await self._publish_run_finished(
                run=finished or self._repositories.thread_task_runs.get(run.id) or run,
                task=updated_task,
            )
            self._log_runtime_lifecycle(
                "continuation_skipped",
                session_id=cleaned,
                task_id=task.id,
                run_id=run.id,
                reason="busy",
                run_status=THREAD_TASK_RUN_STATUS_SKIPPED,
            )
            return {
                "session_id": cleaned or None,
                "task_id": task.id,
                "run_id": run.id,
                "status": "skipped",
                "reason": "busy",
            }
        except Exception as exc:
            failure_reason = f"start_chat failed: {type(exc).__name__}"
            finished = self._repositories.thread_task_runs.finish(
                run.id,
                status=THREAD_TASK_RUN_STATUS_FAILED,
                error={
                    "reason": failure_reason,
                    "message": str(exc),
                },
            )
            if self._thread_task_service is not None:
                self._thread_task_service.record_system_failure(
                    session_id=cleaned,
                    task_id=task.id,
                    reason=failure_reason,
                    run_id=run.id,
                )
            else:
                self._repositories.thread_tasks.update(task.id, current_run_id=None)
            await self._publish_run_finished(
                run=finished or self._repositories.thread_task_runs.get(run.id) or run,
                task=self._repositories.thread_tasks.get(task.id, include_deleted=True),
            )
            logger.opt(exception=True).warning(
                "[ThreadTaskRuntime] 启动续跑失败 | "
                f"session_id={cleaned} | task_id={task.id} | run_id={run.id} | "
                f"reason={failure_reason}"
            )
            self._log_runtime_lifecycle(
                "continuation_failed",
                session_id=cleaned,
                task_id=task.id,
                run_id=run.id,
                reason=failure_reason,
                run_status=THREAD_TASK_RUN_STATUS_FAILED,
                level="warning",
            )
            return {
                "session_id": cleaned or None,
                "task_id": task.id,
                "run_id": run.id,
                "status": "failed",
                "reason": failure_reason,
            }

        return {
            "session_id": cleaned or None,
            "task_id": task.id,
            "run_id": run.id,
            "status": "started",
            "reason": reason,
        }

    @staticmethod
    def _thread_task_context_from_request(request: ChatRequest | None) -> dict[str, Any] | None:
        if request is None or not isinstance(request.runtime_params, dict):
            return None
        raw = request.runtime_params.get("thread_task")
        if raw is None:
            raw = request.runtime_params.get("threadTask")
        return raw if isinstance(raw, dict) else None

    def _context_compression_epoch(self, session_id: str) -> int:
        if self._repositories is None:
            return 0
        getter = getattr(self._repositories.sessions, "get_context_compression_epoch", None)
        if not callable(getter):
            return 0
        return max(0, int(getter(session_id) or 0))

    def _build_seed_context_replay(
        self,
        task: Any,
        *,
        current_compression_epoch: int,
    ) -> dict[str, Any] | None:
        seed = self._seed_context(task)
        if seed is None:
            return None
        last_replayed_epoch = self._int_value(
            seed.get("last_replayed_compression_epoch"),
            default=self._int_value(seed.get("created_compression_epoch"), default=0),
        )
        if current_compression_epoch <= last_replayed_epoch:
            return None

        runtime_params = self._seed_runtime_params(seed)
        message_injection = self._seed_message_injection(
            seed,
            task=task,
            current_compression_epoch=current_compression_epoch,
        )
        attachments = self._seed_attachments(seed)
        if not message_injection and not runtime_params and not attachments:
            return None
        return {
            "message_injection": message_injection,
            "runtime_params": runtime_params,
            "attachments": attachments,
        }

    def _mark_seed_context_replayed(
        self,
        *,
        task_id: str,
        task_metadata: dict[str, Any],
        compression_epoch: int,
        run_id: str,
    ) -> None:
        if self._repositories is None:
            return
        metadata = dict(task_metadata or {})
        seed = metadata.get(THREAD_TASK_SEED_CONTEXT_METADATA_KEY)
        if not isinstance(seed, dict):
            return
        updated_seed = dict(seed)
        updated_seed["last_replayed_compression_epoch"] = max(0, int(compression_epoch or 0))
        history = updated_seed.get("replay_history")
        if not isinstance(history, list):
            history = []
        history = [
            *history[-9:],
            {
                "compression_epoch": updated_seed["last_replayed_compression_epoch"],
                "run_id": run_id,
            },
        ]
        updated_seed["replay_history"] = history
        metadata[THREAD_TASK_SEED_CONTEXT_METADATA_KEY] = updated_seed
        self._repositories.thread_tasks.update(task_id, metadata=metadata)

    @staticmethod
    def _seed_context(task: Any) -> dict[str, Any] | None:
        metadata = getattr(task, "metadata", None)
        if not isinstance(metadata, dict):
            return None
        seed = metadata.get(THREAD_TASK_SEED_CONTEXT_METADATA_KEY)
        return dict(seed) if isinstance(seed, dict) else None

    @classmethod
    def _seed_runtime_params(cls, seed: dict[str, Any]) -> dict[str, Any]:
        raw = seed.get("runtime_params")
        if raw is None:
            raw = seed.get("runtimeParams")
        if not isinstance(raw, dict):
            return {}
        runtime_params: dict[str, Any] = {}
        skill_activation = raw.get("skill_activation")
        if skill_activation is None:
            skill_activation = raw.get("skillActivation")
        if isinstance(skill_activation, dict):
            runtime_params["skill_activation"] = dict(skill_activation)
        for key, value in raw.items():
            if key in _THREAD_TASK_RUNTIME_PARAM_KEYS:
                continue
            if key in {
                "message_injection",
                "messageInjection",
                "skill_activation",
                "skillActivation",
            }:
                continue
            runtime_params[key] = value
        return runtime_params

    @classmethod
    def _seed_message_injection(
        cls,
        seed: dict[str, Any],
        *,
        task: Any,
        current_compression_epoch: int,
    ) -> list[dict[str, Any]]:
        raw_runtime_params = seed.get("runtime_params")
        if raw_runtime_params is None:
            raw_runtime_params = seed.get("runtimeParams")
        if not isinstance(raw_runtime_params, dict):
            return []
        raw_items = raw_runtime_params.get("message_injection")
        if raw_items is None:
            raw_items = raw_runtime_params.get("messageInjection")
        if not isinstance(raw_items, list):
            return []

        items: list[dict[str, Any]] = []
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            content = str(raw_item.get("content") or "").strip()
            if not content:
                continue
            item = dict(raw_item)
            metadata = item.get("metadata")
            metadata = dict(metadata) if isinstance(metadata, dict) else {}
            metadata.update(
                {
                    "source": "thread_task_seed_context",
                    "task_id": getattr(task, "id", ""),
                    "task_type": getattr(task, "type", ""),
                    "context_compression_epoch": current_compression_epoch,
                    "hidden_for_transcript": True,
                }
            )
            item["metadata"] = metadata
            item["hidden_for_transcript"] = True
            items.append(item)
        return items

    @staticmethod
    def _seed_attachments(seed: dict[str, Any]) -> list[dict[str, Any]] | None:
        raw = seed.get("attachments")
        if not isinstance(raw, list):
            return None
        attachments = [dict(item) for item in raw if isinstance(item, dict)]
        return attachments or None

    @staticmethod
    def _int_value(value: Any, *, default: int = 0) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _log_runtime_lifecycle(
        action: str,
        *,
        session_id: str,
        task_id: str | None = None,
        run_id: str | None = None,
        trace_id: str | None = None,
        turn_index: int | None = None,
        trigger: str | None = None,
        task_type: str | None = None,
        task_status: str | None = None,
        run_status: str | None = None,
        reason: str | None = None,
        objective: str | None = None,
        level: str = "info",
    ) -> None:
        parts = [
            f"[ThreadTaskRuntime] {action}",
            f"session_id={session_id}",
        ]
        if task_id:
            parts.append(f"task_id={task_id}")
        if run_id:
            parts.append(f"run_id={run_id}")
        if trace_id:
            parts.append(f"trace_id={trace_id}")
        if turn_index is not None:
            parts.append(f"turn_index={turn_index}")
        if trigger:
            parts.append(f"trigger={_log_value(trigger, 80)}")
        if task_type:
            parts.append(f"type={task_type}")
        if task_status:
            parts.append(f"task_status={task_status}")
        if run_status:
            parts.append(f"run_status={run_status}")
        if reason:
            parts.append(f"reason={_log_value(reason, 160)}")
        if objective is not None:
            parts.append(f"objective_preview={_log_value(objective, 120)}")
            parts.append(f"objective_len={len(objective)}")
        message = " | ".join(parts)
        if level == "warning":
            logger.warning(message)
        else:
            logger.info(message)

    @staticmethod
    def _run_status_from_turn(turn_status: str, error: BaseException | None) -> str:
        if error is not None:
            if type(error).__name__ == "CancelledError":
                return THREAD_TASK_RUN_STATUS_CANCELLED
            return THREAD_TASK_RUN_STATUS_FAILED
        if turn_status == "completed":
            return THREAD_TASK_RUN_STATUS_SUCCEEDED
        if turn_status == "cancelled":
            return THREAD_TASK_RUN_STATUS_CANCELLED
        return THREAD_TASK_RUN_STATUS_FAILED

    @staticmethod
    def _finish_payload_from_turn(
        *,
        turn_status: str,
        result: Any | None,
        error: BaseException | None,
    ) -> dict[str, dict[str, Any]]:
        if error is not None:
            return {
                "summary": {"turn_status": turn_status or "error"},
                "error": {
                    "reason": f"turn_error: {type(error).__name__}",
                    "message": str(error),
                },
            }
        if turn_status == "completed":
            final_content = str(getattr(result, "final_content", "") or "")
            return {
                "summary": {
                    "turn_status": "completed",
                    "final_content_preview": final_content[:200],
                },
                "error": {},
            }
        if turn_status == "cancelled":
            return {
                "summary": {"turn_status": "cancelled"},
                "error": {},
            }
        return {
            "summary": {"turn_status": turn_status or "failed"},
            "error": {
                "reason": "turn_failed",
                "message": str(getattr(result, "error", "") or ""),
            },
        }

    @staticmethod
    def _next_token_usage(current: dict[str, Any], trace: Any | None) -> dict[str, Any]:
        usage = dict(current or {})
        if trace is None:
            return usage
        latest = {
            "input_tokens": int(getattr(trace, "total_input_tokens", 0) or 0),
            "output_tokens": int(getattr(trace, "total_output_tokens", 0) or 0),
            "total_tokens": int(getattr(trace, "total_tokens", 0) or 0),
            "cache_read_tokens": int(getattr(trace, "total_cache_read_tokens", 0) or 0),
            "trace_id": getattr(trace, "trace_id", None),
        }
        usage["latest"] = latest
        usage["total_tokens"] = int(usage.get("total_tokens") or 0) + latest["total_tokens"]
        usage["total_input_tokens"] = (
            int(usage.get("total_input_tokens") or 0) + latest["input_tokens"]
        )
        usage["total_output_tokens"] = (
            int(usage.get("total_output_tokens") or 0) + latest["output_tokens"]
        )
        usage["total_cache_read_tokens"] = (
            int(usage.get("total_cache_read_tokens") or 0) + latest["cache_read_tokens"]
        )
        return usage

    async def _publish_run_started(self, *, run: Any, task: Any, reason: str) -> None:
        await self._publish_task_event(
            event_type=DomainEventType.THREAD_TASK_RUN_STARTED,
            session_id=run.session_id,
            run=run,
            payload={
                "task_id": run.task_id,
                "run_id": run.id,
                "run": self._serialize_run(run),
                "task": self._serialize_task(task),
                "status": run.status,
                "reason": reason,
                "trace_id": run.trace_id,
                "turn_index": run.turn_index,
            },
            trace_id=run.trace_id,
            turn_index=run.turn_index,
        )

    async def _publish_run_finished(
        self,
        *,
        run: Any,
        task: Any | None,
        trace_id: str | None = None,
        turn_index: int | None = None,
    ) -> None:
        resolved_trace_id = trace_id or run.trace_id
        resolved_turn_index = turn_index if turn_index is not None else run.turn_index
        await self._publish_task_event(
            event_type=DomainEventType.THREAD_TASK_RUN_FINISHED,
            session_id=run.session_id,
            run=run,
            payload={
                "task_id": run.task_id,
                "run_id": run.id,
                "run": self._serialize_run(run),
                "task": self._serialize_task(task) if task is not None else None,
                "status": run.status,
                "run_status": run.status,
                "trace_id": resolved_trace_id,
                "turn_index": resolved_turn_index,
            },
            trace_id=resolved_trace_id,
            turn_index=resolved_turn_index,
        )

    async def _publish_task_event(
        self,
        *,
        event_type: DomainEventType,
        session_id: str,
        run: Any,
        payload: dict[str, Any],
        trace_id: str | None,
        turn_index: int | None,
    ) -> None:
        if self._event_publisher is None:
            return
        publish_async = getattr(self._event_publisher, "publish_async", None)
        kwargs = {
            "event_type": event_type,
            "session_id": session_id,
            "payload": payload,
            "trace_id": trace_id,
            "run_id": run.id,
            "turn_index": turn_index,
        }
        if callable(publish_async):
            await publish_async(**kwargs)
            return
        self._event_publisher.publish(**kwargs)

    def _serialize_task(self, task: Any) -> dict[str, Any]:
        serializer = getattr(self._thread_task_service, "serialize_task", None)
        if callable(serializer):
            return serializer(task)
        return {
            "id": task.id,
            "session_id": task.session_id,
            "type": task.type,
            "title": task.title,
            "objective": task.objective,
            "status": task.status,
            "current_run_id": task.current_run_id,
            "turn_count": task.turn_count,
            "elapsed_seconds": task.elapsed_seconds,
            "token_usage": dict(task.token_usage),
            "deleted_at": task.deleted_at,
        }

    def _serialize_run(self, run: Any) -> dict[str, Any]:
        serializer = getattr(self._thread_task_service, "serialize_run", None)
        if callable(serializer):
            return serializer(run)
        return {
            "id": run.id,
            "task_id": run.task_id,
            "session_id": run.session_id,
            "turn_index": run.turn_index,
            "trace_id": run.trace_id,
            "status": run.status,
            "summary": dict(run.summary),
            "error": dict(run.error),
            "started_at": run.started_at,
            "finished_at": run.finished_at,
        }


def _log_value(value: str, limit: int) -> str:
    normalized = " ".join(str(value or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[:limit]}..."
