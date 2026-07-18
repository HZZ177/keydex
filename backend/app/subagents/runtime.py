from __future__ import annotations

import asyncio
import inspect
import sqlite3
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import datetime
from itertools import count
from threading import RLock
from typing import Any, Protocol, runtime_checkable

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.time import utc_now
from backend.app.services.chat_types import (
    PENDING_INPUT_MODE_QUEUE,
    PENDING_INPUT_MODE_STEER,
    ChatRequest,
)
from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import (
    SubagentHandle,
    SubagentInitiator,
    SubagentInstanceState,
    SubagentInstanceSummary,
    SubagentRole,
    SubagentRunSnapshot,
    SubagentRunState,
    SubagentSpawnRequest,
)
from backend.app.subagents.observability import format_subagent_log
from backend.app.subagents.reporting import extract_subagent_final_report
from backend.app.subagents.roles import (
    DEFAULT_SUBAGENT_ROLE_REGISTRY,
    SubagentRoleRegistry,
)

SubagentRunListener = Callable[[SubagentRunSnapshot], Awaitable[None] | None]


class SubagentWaitCancellation(Protocol):
    def is_cancelled(self) -> bool: ...

    async def wait(self) -> None: ...


class SubagentWaitCancellationToken:
    def __init__(self) -> None:
        self._event = asyncio.Event()

    def cancel(self) -> None:
        self._event.set()

    def is_cancelled(self) -> bool:
        return self._event.is_set()

    async def wait(self) -> None:
        await self._event.wait()


class SubagentSubscription(Protocol):
    def unsubscribe(self) -> None: ...


class _ListenerRegistration:
    def __init__(
        self,
        *,
        listener: SubagentRunListener,
        remove: Callable[[], None],
    ) -> None:
        self.listener = listener
        self._remove = remove
        self._lock = RLock()
        self.active = True
        self.last_version = 0

    def unsubscribe(self) -> None:
        with self._lock:
            if not self.active:
                return
            self.active = False
        self._remove()

    def accept_version(self, version: int) -> bool:
        with self._lock:
            if not self.active or version <= self.last_version:
                return False
            self.last_version = version
            return True


@runtime_checkable
class SubagentRuntimeProtocol(Protocol):
    async def spawn(self, request: SubagentSpawnRequest) -> SubagentHandle: ...

    async def get_run(
        self,
        run_id: str,
        *,
        parent_session_id: str | None = None,
    ) -> SubagentRunSnapshot: ...

    async def wait_terminal(
        self,
        run_id: str,
        *,
        cancellation: SubagentWaitCancellation | asyncio.Event | None = None,
    ) -> SubagentRunSnapshot: ...

    async def steer(
        self,
        run_id: str,
        child_session_id: str,
        message: str,
    ) -> SubagentRunSnapshot: ...

    async def cancel(
        self,
        run_id: str,
        *,
        reason: str | None = None,
    ) -> SubagentRunSnapshot: ...

    async def cancel_by_parent_trace(
        self,
        parent_session_id: str,
        parent_trace_id: str,
        *,
        reason: str | None = None,
    ) -> list[SubagentRunSnapshot]: ...

    async def resume(
        self,
        subagent_id: str,
        task: str,
        *,
        initiated_by: SubagentInitiator = SubagentInitiator.USER,
        parent_session_id: str | None = None,
        parent_trace_id: str | None = None,
        parent_tool_call_id: str | None = None,
    ) -> SubagentHandle: ...

    async def subscribe(
        self,
        run_id: str,
        listener: SubagentRunListener,
    ) -> SubagentSubscription: ...

    async def list_by_parent(
        self,
        parent_session_id: str,
    ) -> list[SubagentRunSnapshot]: ...

    async def close(self, subagent_id: str) -> SubagentInstanceSummary: ...

    async def reconcile_interrupted_runs(self) -> list[SubagentRunSnapshot]: ...

    async def shutdown(self) -> None: ...


class SessionBackedSubagentRuntime:
    """Addressable async runtime; invocation WAIT policy lives outside this class."""

    def __init__(
        self,
        *,
        repositories: Any,
        chat_stream_manager: Any,
        role_registry: SubagentRoleRegistry = DEFAULT_SUBAGENT_ROLE_REGISTRY,
        event_publisher: Any | None = None,
        id_factory: Callable[[], str] = new_id,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.repositories = repositories
        self.chat_stream_manager = chat_stream_manager
        self.role_registry = role_registry
        self.event_publisher = event_publisher
        self.id_factory = id_factory
        self.clock = clock
        self._listeners_lock = RLock()
        self._listeners: dict[str, dict[int, _ListenerRegistration]] = {}
        self._listener_ids = count(1)
        self._run_control_locks_guard = RLock()
        self._run_control_locks: dict[str, asyncio.Lock] = {}
        add_lifecycle_observer = getattr(
            self.chat_stream_manager,
            "add_run_lifecycle_observer",
            None,
        )
        self._chat_lifecycle_subscription = (
            add_lifecycle_observer(self.handle_chat_finished)
            if callable(add_lifecycle_observer)
            else None
        )

    async def spawn(self, request: SubagentSpawnRequest) -> SubagentHandle:
        operation_started = time.monotonic()
        parent = self.repositories.sessions.get(request.parent_session_id)
        self._validate_parent(parent, request.parent_session_id)
        self.role_registry.resolve(request.role)

        subagent_id = self._next_id("subagent")
        child_session_id = self._next_id("subagent-session")
        run_id = self._next_id("subagent-run")
        now = self.clock()
        with self.repositories.db.transaction(immediate=True) as conn:
            parent_row = conn.execute(
                """
                select id from sessions
                where id = ?
                  and archived_at is null
                  and visibility = 'visible'
                  and agent_kind = 'main'
                  and session_type = 'workspace'
                """,
                (request.parent_session_id,),
            ).fetchone()
            if parent_row is None:
                raise SubagentError(
                    SubagentErrorCode.SUBAGENT_PARENT_INVALID,
                    "parent Session is no longer an active visible Workspace main Session",
                    details={"parent_session_id": request.parent_session_id},
                )
            sequence = self.repositories.subagent_runs.next_parent_sequence(
                request.parent_session_id,
                connection=conn,
            )
            self.repositories.sessions.create(
                session_id=child_session_id,
                user_id=request.user_id,
                scene_id=parent.scene_id,
                title=f"{request.role.value}: {request.task[:80]}",
                status="active",
                session_tag="subagent",
                scene_version_seq=parent.scene_version_seq,
                workspace_id=parent.workspace_id,
                session_type="workspace",
                visibility="internal",
                agent_kind="subagent",
                subagent_id=subagent_id,
                subagent_role=request.role.value,
                cwd=parent.cwd,
                workspace_roots=list(parent.workspace_roots),
                current_model_provider_id=parent.current_model_provider_id,
                current_model=parent.current_model,
                parent_session_id=request.parent_session_id,
                connection=conn,
            )
            queued = SubagentRunSnapshot(
                run_id=run_id,
                subagent_id=subagent_id,
                child_session_id=child_session_id,
                parent_session_id=request.parent_session_id,
                parent_trace_id=request.parent_trace_id,
                parent_tool_call_id=request.parent_tool_call_id,
                parent_timeline_sequence=sequence,
                initiated_by=request.initiated_by,
                role=request.role,
                task=request.task,
                state=SubagentRunState.QUEUED,
                version=1,
                created_at=now,
                queued_at=now,
                updated_at=now,
            )
            persisted = self.repositories.subagent_runs.create(
                queued,
                connection=conn,
            ).to_snapshot()

        handle = SubagentHandle(
            subagent_id=subagent_id,
            run_id=run_id,
            child_session_id=child_session_id,
            parent_session_id=request.parent_session_id,
            role=request.role,
            initial_snapshot=persisted,
        )
        await self._publish_snapshot(persisted)
        try:
            await self.chat_stream_manager.start_chat(
                ChatRequest(
                    message=request.task,
                    session_id=child_session_id,
                    user_id=request.user_id,
                    scene_id=parent.scene_id,
                    provider_id=parent.current_model_provider_id or "",
                    model=parent.current_model or "",
                    subagent_run_id=run_id,
                    subagent_parent_session_id=request.parent_session_id,
                )
            )
        except Exception as exc:
            failed = self.repositories.subagent_runs.transition(
                run_id,
                SubagentRunState.FAILED.value,
                expected_version=persisted.version,
                now=self.clock(),
                error_code=SubagentErrorCode.SUBAGENT_START_FAILED.value,
                error_message=str(exc).strip() or type(exc).__name__,
            ).to_snapshot()
            self.repositories.sessions.update(child_session_id, status="failed")
            await self._publish_snapshot(failed)
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_START_FAILED,
                "Sub-Agent chat scheduling failed after persistence",
                details={
                    "subagent_id": subagent_id,
                    "run_id": run_id,
                    "child_session_id": child_session_id,
                },
            ) from exc
        running = await self._ensure_running(run_id)
        logger.info(
            format_subagent_log(
                "spawn",
                running,
                duration_ms=int((time.monotonic() - operation_started) * 1000),
            )
        )
        return handle

    async def handle_chat_finished(
        self,
        session_id: str,
        *,
        request: ChatRequest | None = None,
        result: Any | None = None,
        error: BaseException | None = None,
        cancelled: bool = False,
    ) -> SubagentRunSnapshot | None:
        if request is None or not request.subagent_run_id:
            return None
        if not request.subagent_parent_session_id:
            return None
        record = self.repositories.subagent_runs.get(
            request.subagent_run_id,
            parent_session_id=request.subagent_parent_session_id,
        )
        if record is None or record.child_session_id != session_id:
            logger.warning(
                "[SubagentRuntime] ignored lifecycle callback outside exact run ownership | "
                f"run_id={request.subagent_run_id} | child_session_id={session_id}"
            )
            return None

        async with self._run_control_lock(request.subagent_run_id):
            current = await self._ensure_running(request.subagent_run_id)
            if current.is_terminal:
                return current

            result_status = str(getattr(result, "status", "") or "").strip().lower()
            if (
                cancelled
                or isinstance(error, asyncio.CancelledError)
                or result_status == "cancelled"
            ):
                return await self._finish_run(
                    current,
                    SubagentRunState.CANCELLED,
                )

            result_error = getattr(result, "error", None)
            if (
                error is not None
                or result_status in {"failed", "error"}
                or result_error is not None
            ):
                error_code = str(getattr(result_error, "code", "") or "").strip()
                error_message = str(
                    getattr(result_error, "message", "") or ""
                ).strip()
                if error is not None:
                    error_message = str(error).strip() or type(error).__name__
                return await self._finish_run(
                    current,
                    SubagentRunState.FAILED,
                    error_code=(
                        error_code or SubagentErrorCode.SUBAGENT_RUN_FAILED.value
                    ),
                    error_message=error_message or "Sub-Agent chat execution failed",
                )

            final_report = extract_subagent_final_report(result)
            if not final_report:
                return await self._finish_run(
                    current,
                    SubagentRunState.FAILED,
                    error_code=SubagentErrorCode.MISSING_FINAL_REPORT.value,
                    error_message="Sub-Agent completed without a non-empty final report",
                )
            return await self._finish_run(
                current,
                SubagentRunState.COMPLETED,
                final_report=final_report,
            )

    async def get_run(
        self,
        run_id: str,
        *,
        parent_session_id: str | None = None,
    ) -> SubagentRunSnapshot:
        cleaned_run_id = str(run_id or "").strip()
        record = self.repositories.subagent_runs.get(
            cleaned_run_id,
            parent_session_id=(
                str(parent_session_id).strip()
                if parent_session_id is not None
                else None
            ),
        )
        if record is None:
            raise SubagentError(
                SubagentErrorCode.RUN_NOT_FOUND,
                "the requested Sub-Agent Run does not exist in the parent scope",
                details={
                    "run_id": cleaned_run_id,
                    **(
                        {"parent_session_id": str(parent_session_id).strip()}
                        if parent_session_id is not None
                        else {}
                    ),
                },
            )
        return record.to_snapshot()

    async def wait_terminal(
        self,
        run_id: str,
        *,
        cancellation: SubagentWaitCancellation | asyncio.Event | None = None,
    ) -> SubagentRunSnapshot:
        operation_started = time.monotonic()
        current = await self.get_run(run_id)
        if current.is_terminal:
            logger.info(
                format_subagent_log(
                    "wait",
                    current,
                    duration_ms=int((time.monotonic() - operation_started) * 1000),
                )
            )
            return current
        if self._wait_is_cancelled(cancellation):
            raise asyncio.CancelledError

        terminal_event = asyncio.Event()

        def listener(snapshot: SubagentRunSnapshot) -> None:
            if snapshot.is_terminal:
                terminal_event.set()

        subscription = await self.subscribe(run_id, listener)
        terminal_task: asyncio.Task[bool] | None = None
        cancellation_task: asyncio.Task[Any] | None = None
        try:
            current = await self.get_run(run_id)
            if current.is_terminal:
                return current
            if self._wait_is_cancelled(cancellation):
                raise asyncio.CancelledError

            terminal_task = asyncio.create_task(terminal_event.wait())
            wait_tasks: set[asyncio.Task[Any]] = {terminal_task}
            if cancellation is not None:
                cancellation_task = asyncio.create_task(
                    self._wait_for_cancellation(cancellation)
                )
                wait_tasks.add(cancellation_task)
            while True:
                await asyncio.wait(wait_tasks, return_when=asyncio.FIRST_COMPLETED)
                current = await self.get_run(run_id)
                if current.is_terminal:
                    return current
                if self._wait_is_cancelled(cancellation):
                    raise asyncio.CancelledError
                terminal_event.clear()
                terminal_task = asyncio.create_task(terminal_event.wait())
                wait_tasks = {terminal_task}
                if cancellation_task is not None:
                    wait_tasks.add(cancellation_task)
        finally:
            subscription.unsubscribe()
            for task in (terminal_task, cancellation_task):
                if task is not None and not task.done():
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            latest = await self.get_run(run_id)
            logger.info(
                format_subagent_log(
                    "wait",
                    latest,
                    duration_ms=int((time.monotonic() - operation_started) * 1000),
                )
            )

    async def steer(
        self,
        run_id: str,
        child_session_id: str,
        message: str,
        *,
        parent_session_id: str | None = None,
        expected_version: int | None = None,
    ) -> SubagentRunSnapshot:
        operation_started = time.monotonic()
        cleaned_message = str(message or "").strip()
        if not cleaned_message:
            raise SubagentError(
                SubagentErrorCode.STEER_NOT_ALLOWED,
                "steer message must not be blank",
                details={"run_id": str(run_id or "").strip()},
            )
        cleaned_run_id = str(run_id or "").strip()
        async with self._run_control_lock(cleaned_run_id):
            controlled = await self._steer_locked(
                cleaned_run_id,
                child_session_id,
                cleaned_message,
                parent_session_id=parent_session_id,
                expected_version=expected_version,
            )
        logger.info(
            format_subagent_log(
                "steer",
                controlled,
                duration_ms=int((time.monotonic() - operation_started) * 1000),
            )
        )
        return controlled

    async def _steer_locked(
        self,
        run_id: str,
        child_session_id: str,
        message: str,
        *,
        parent_session_id: str | None = None,
        expected_version: int | None = None,
    ) -> SubagentRunSnapshot:
        current = await self.get_run(run_id)
        self._validate_control_snapshot(
            current,
            parent_session_id=parent_session_id,
            expected_version=expected_version,
        )
        cleaned_child_session_id = str(child_session_id or "").strip()
        if current.child_session_id != cleaned_child_session_id:
            raise SubagentError(
                SubagentErrorCode.STEER_NOT_ALLOWED,
                "the requested child Session does not own this Run",
                details={
                    "run_id": current.run_id,
                    "child_session_id": cleaned_child_session_id,
                },
            )
        child = self.repositories.sessions.get_internal_for_parent(
            child_session_id=current.child_session_id,
            parent_session_id=current.parent_session_id,
            run_id=current.run_id,
        )
        if child is None:
            raise SubagentError(
                SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED,
                "the internal child Session is not available in this parent Run scope",
                details={
                    "run_id": current.run_id,
                    "child_session_id": current.child_session_id,
                },
            )
        if current.state not in {SubagentRunState.QUEUED, SubagentRunState.RUNNING}:
            raise SubagentError(
                SubagentErrorCode.RUN_TERMINAL,
                "only queued or running Runs accept steering",
                details={"run_id": current.run_id, "state": current.state.value},
            )

        queued = current.state is SubagentRunState.QUEUED
        submission = await self.chat_stream_manager.submit_input(
            ChatRequest(
                message=message,
                session_id=current.child_session_id,
                user_id=child.user_id,
                scene_id=child.scene_id,
                provider_id=child.current_model_provider_id or "",
                model=child.current_model or "",
                delivery_mode=(
                    PENDING_INPUT_MODE_QUEUE if queued else PENDING_INPUT_MODE_STEER
                ),
                subagent_run_id=current.run_id,
                subagent_parent_session_id=current.parent_session_id,
            ),
            force_pending=queued,
        )
        latest = await self.get_run(current.run_id)
        if latest.is_terminal:
            pending_input = submission.get("pending_input")
            pending_input_id = (
                str(pending_input.get("id") or "").strip()
                if isinstance(pending_input, dict)
                else ""
            )
            if pending_input_id:
                await self.chat_stream_manager.cancel_pending_input(
                    session_id=current.child_session_id,
                    pending_input_id=pending_input_id,
                    reason="run_became_terminal_during_steer",
                )
            raise SubagentError(
                SubagentErrorCode.RUN_TERMINAL,
                "the Run reached a terminal state before steering committed",
                details={"run_id": latest.run_id, "state": latest.state.value},
            )
        return latest

    async def cancel(
        self,
        run_id: str,
        *,
        reason: str | None = None,
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        expected_version: int | None = None,
    ) -> SubagentRunSnapshot:
        operation_started = time.monotonic()
        cleaned_run_id = str(run_id or "").strip()
        async with self._run_control_lock(cleaned_run_id):
            controlled = await self._cancel_locked(
                cleaned_run_id,
                reason=reason,
                parent_session_id=parent_session_id,
                child_session_id=child_session_id,
                expected_version=expected_version,
            )
        logger.info(
            format_subagent_log(
                "cancel",
                controlled,
                duration_ms=int((time.monotonic() - operation_started) * 1000),
            )
        )
        return controlled

    async def _cancel_locked(
        self,
        run_id: str,
        *,
        reason: str | None,
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        expected_version: int | None = None,
    ) -> SubagentRunSnapshot:
        current = await self.get_run(run_id)
        self._validate_control_snapshot(
            current,
            parent_session_id=parent_session_id,
            expected_version=expected_version,
        )
        if (
            child_session_id is not None
            and current.child_session_id != str(child_session_id or "").strip()
        ):
            raise SubagentError(
                SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED,
                "the requested child Session does not own this Run",
                details={"run_id": current.run_id},
            )
        if current.is_terminal:
            return current
        cancelled_in_memory = await self.chat_stream_manager.cancel(
            current.child_session_id
        )
        if not cancelled_in_memory:
            self.repositories.pending_inputs.pause_active_for_session(
                current.child_session_id,
                reason=str(reason or "subagent_cancelled").strip(),
            )
        latest = await self.get_run(current.run_id)
        return await self._finish_run(latest, SubagentRunState.CANCELLED)

    async def cancel_by_parent_trace(
        self,
        parent_session_id: str,
        parent_trace_id: str,
        *,
        reason: str | None = None,
    ) -> list[SubagentRunSnapshot]:
        cleaned_parent_id = str(parent_session_id or "").strip()
        cleaned_trace_id = str(parent_trace_id or "").strip()
        if not cleaned_parent_id or not cleaned_trace_id:
            return []
        candidates = self.repositories.subagent_runs.list_active_by_parent_trace(
            cleaned_parent_id,
            cleaned_trace_id,
        )
        if not candidates:
            return []
        return list(
            await asyncio.gather(
                *(
                    self.cancel(
                        candidate.run_id,
                        reason=reason or "parent_trace_cancelled",
                    )
                    for candidate in candidates
                )
            )
        )

    async def resume(
        self,
        subagent_id: str,
        task: str,
        *,
        initiated_by: SubagentInitiator = SubagentInitiator.USER,
        parent_session_id: str | None = None,
        parent_trace_id: str | None = None,
        parent_tool_call_id: str | None = None,
        child_session_id: str | None = None,
        previous_run_id: str | None = None,
        expected_version: int | None = None,
    ) -> SubagentHandle:
        operation_started = time.monotonic()
        cleaned_subagent_id = str(subagent_id or "").strip()
        cleaned_task = str(task or "").strip()
        if not cleaned_task:
            raise SubagentError(
                SubagentErrorCode.RUN_TRANSITION_INVALID,
                "resume task must not be blank",
                details={"subagent_id": cleaned_subagent_id},
            )
        try:
            initiated_by = SubagentInitiator(initiated_by)
        except ValueError as exc:
            raise SubagentError(
                SubagentErrorCode.RUN_TRANSITION_INVALID,
                "resume initiator is invalid",
                details={"initiated_by": str(initiated_by)},
            ) from exc
        cleaned_parent_session_id = str(parent_session_id or "").strip() or None
        cleaned_parent_trace_id = str(parent_trace_id or "").strip() or None
        cleaned_parent_tool_call_id = str(parent_tool_call_id or "").strip() or None
        if (
            initiated_by is SubagentInitiator.MAIN_AGENT
            and (cleaned_parent_session_id is None or cleaned_parent_tool_call_id is None)
        ):
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_PARENT_INVALID,
                "main Agent continuation requires the current parent Session and tool_call_id",
                details={
                    "parent_session_id": cleaned_parent_session_id,
                    "parent_tool_call_id": cleaned_parent_tool_call_id,
                },
            )
        child = self.repositories.sessions.get_subagent(cleaned_subagent_id)
        if child is None:
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_NOT_FOUND,
                "the requested Sub-Agent instance does not exist",
                details={"subagent_id": cleaned_subagent_id},
            )
        if child_session_id is not None and child.id != str(child_session_id or "").strip():
            raise SubagentError(
                SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED,
                "the requested child Session does not own this Sub-Agent instance",
                details={"subagent_id": cleaned_subagent_id},
            )
        if (
            cleaned_parent_session_id is not None
            and child.parent_session_id != cleaned_parent_session_id
        ):
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_NOT_FOUND,
                "the requested Sub-Agent instance does not exist in the parent scope",
                details={"subagent_id": cleaned_subagent_id},
            )
        if child.subagent_closed_at is not None:
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_CLOSED,
                "a closed Sub-Agent instance cannot be resumed",
                details={"subagent_id": cleaned_subagent_id},
            )
        parent = self.repositories.sessions.get(child.parent_session_id or "")
        self._validate_parent(parent, child.parent_session_id or "")
        active = self.repositories.subagent_runs.get_active(
            cleaned_subagent_id,
            parent_session_id=child.parent_session_id,
        )
        if active is not None:
            raise SubagentError(
                SubagentErrorCode.RUN_ALREADY_ACTIVE,
                "the Sub-Agent instance already has an active Run",
                details={"subagent_id": cleaned_subagent_id, "run_id": active.run_id},
            )

        run_id = self._next_id("subagent-run")
        now = self.clock()
        role = SubagentRole(child.subagent_role)
        try:
            with self.repositories.db.transaction(immediate=True) as conn:
                child_row = conn.execute(
                    """
                    select id from sessions
                    where id = ?
                      and subagent_id = ?
                      and visibility = 'internal'
                      and agent_kind = 'subagent'
                      and subagent_closed_at is null
                      and archived_at is null
                    """,
                    (child.id, cleaned_subagent_id),
                ).fetchone()
                if child_row is None:
                    raise SubagentError(
                        SubagentErrorCode.SUBAGENT_CLOSED,
                        "the Sub-Agent instance closed before resume committed",
                        details={"subagent_id": cleaned_subagent_id},
                    )
                parent_row = conn.execute(
                    """
                    select id from sessions
                    where id = ?
                      and archived_at is null
                      and visibility = 'visible'
                      and agent_kind = 'main'
                      and session_type = 'workspace'
                    """,
                    (child.parent_session_id,),
                ).fetchone()
                if parent_row is None:
                    raise SubagentError(
                        SubagentErrorCode.SUBAGENT_PARENT_INVALID,
                        "parent Session is no longer available for resume",
                        details={"parent_session_id": child.parent_session_id},
                    )
                active_row = conn.execute(
                    """
                    select run_id from subagent_run
                    where subagent_id = ? and state in ('queued', 'running')
                    """,
                    (cleaned_subagent_id,),
                ).fetchone()
                if active_row is not None:
                    raise SubagentError(
                        SubagentErrorCode.RUN_ALREADY_ACTIVE,
                        "the Sub-Agent instance already has an active Run",
                        details={"run_id": active_row["run_id"]},
                    )
                previous_row = conn.execute(
                    """
                    select run_id, version, state
                    from subagent_run
                    where subagent_id = ? and parent_session_id = ?
                    order by parent_timeline_sequence desc, created_at desc
                    limit 1
                    """,
                    (cleaned_subagent_id, child.parent_session_id),
                ).fetchone()
                if previous_run_id is not None:
                    if previous_row is None or previous_row["run_id"] != str(
                        previous_run_id or ""
                    ).strip():
                        raise SubagentError(
                            SubagentErrorCode.RUN_VERSION_CONFLICT,
                            "resume control no longer targets the latest Run",
                            details={"previous_run_id": str(previous_run_id or "").strip()},
                        )
                    if (
                        expected_version is not None
                        and int(previous_row["version"]) != expected_version
                    ):
                        raise SubagentError(
                            SubagentErrorCode.RUN_VERSION_CONFLICT,
                            "resume control uses a stale Run version",
                            details={
                                "expected_version": expected_version,
                                "actual_version": int(previous_row["version"]),
                            },
                        )
                sequence = self.repositories.subagent_runs.next_parent_sequence(
                    child.parent_session_id or "",
                    connection=conn,
                )
                queued = SubagentRunSnapshot(
                    run_id=run_id,
                    subagent_id=cleaned_subagent_id,
                    child_session_id=child.id,
                    parent_session_id=child.parent_session_id or "",
                    parent_trace_id=(
                        cleaned_parent_trace_id
                        if initiated_by is SubagentInitiator.MAIN_AGENT
                        else None
                    ),
                    parent_tool_call_id=(
                        cleaned_parent_tool_call_id
                        if initiated_by is SubagentInitiator.MAIN_AGENT
                        else None
                    ),
                    parent_timeline_sequence=sequence,
                    initiated_by=initiated_by,
                    role=role,
                    task=cleaned_task,
                    state=SubagentRunState.QUEUED,
                    version=1,
                    created_at=now,
                    queued_at=now,
                    updated_at=now,
                )
                persisted = self.repositories.subagent_runs.create(
                    queued,
                    connection=conn,
                ).to_snapshot()
                conn.execute(
                    "update sessions set status = 'active', updated_at = ? where id = ?",
                    (now.isoformat().replace("+00:00", "Z"), child.id),
                )
        except sqlite3.IntegrityError as exc:
            active = self.repositories.subagent_runs.get_active(cleaned_subagent_id)
            if active is not None:
                raise SubagentError(
                    SubagentErrorCode.RUN_ALREADY_ACTIVE,
                    "a concurrent resume already created the active Run",
                    details={"run_id": active.run_id},
                ) from exc
            raise

        handle = SubagentHandle(
            subagent_id=cleaned_subagent_id,
            run_id=run_id,
            child_session_id=child.id,
            parent_session_id=child.parent_session_id or "",
            role=role,
            initial_snapshot=persisted,
        )
        await self._publish_snapshot(persisted)
        try:
            await self.chat_stream_manager.start_chat(
                ChatRequest(
                    message=cleaned_task,
                    session_id=child.id,
                    user_id=child.user_id,
                    scene_id=child.scene_id,
                    provider_id=child.current_model_provider_id or "",
                    model=child.current_model or "",
                    subagent_run_id=run_id,
                    subagent_parent_session_id=child.parent_session_id,
                )
            )
        except Exception as exc:
            failed = self.repositories.subagent_runs.transition(
                run_id,
                SubagentRunState.FAILED.value,
                expected_version=persisted.version,
                now=self.clock(),
                error_code=SubagentErrorCode.SUBAGENT_START_FAILED.value,
                error_message=str(exc).strip() or type(exc).__name__,
            ).to_snapshot()
            self.repositories.sessions.update(child.id, status="failed")
            await self._publish_snapshot(failed)
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_START_FAILED,
                "Sub-Agent resume scheduling failed after persistence",
                details={"subagent_id": cleaned_subagent_id, "run_id": run_id},
            ) from exc
        running = await self._ensure_running(run_id)
        logger.info(
            format_subagent_log(
                "resume",
                running,
                duration_ms=int((time.monotonic() - operation_started) * 1000),
            )
        )
        return handle

    async def subscribe(
        self,
        run_id: str,
        listener: SubagentRunListener,
    ) -> SubagentSubscription:
        cleaned_run_id = str(run_id or "").strip()
        await self.get_run(cleaned_run_id)
        listener_id = next(self._listener_ids)

        def remove() -> None:
            with self._listeners_lock:
                registrations = self._listeners.get(cleaned_run_id)
                if registrations is None:
                    return
                registrations.pop(listener_id, None)
                if not registrations:
                    self._listeners.pop(cleaned_run_id, None)

        registration = _ListenerRegistration(listener=listener, remove=remove)
        with self._listeners_lock:
            self._listeners.setdefault(cleaned_run_id, {})[listener_id] = registration
        latest = await self.get_run(cleaned_run_id)
        await self._dispatch_registration(registration, latest)
        return registration

    async def list_by_parent(
        self,
        parent_session_id: str,
    ) -> list[SubagentRunSnapshot]:
        cleaned_parent_id = str(parent_session_id or "").strip()
        if not cleaned_parent_id:
            return []
        return [
            record.to_snapshot()
            for record in self.repositories.subagent_runs.list_by_parent(
                cleaned_parent_id
            )
        ]

    async def close(
        self,
        subagent_id: str,
        *,
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        control_run_id: str | None = None,
        expected_version: int | None = None,
    ) -> SubagentInstanceSummary:
        cleaned_subagent_id = str(subagent_id or "").strip()
        child = self.repositories.sessions.get_subagent(cleaned_subagent_id)
        if child is None:
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_NOT_FOUND,
                "the requested Sub-Agent instance does not exist",
                details={"subagent_id": cleaned_subagent_id},
            )
        if child_session_id is not None and child.id != str(child_session_id or "").strip():
            raise SubagentError(
                SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED,
                "the requested child Session does not own this Sub-Agent instance",
            )
        if (
            parent_session_id is not None
            and child.parent_session_id != str(parent_session_id or "").strip()
        ):
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_NOT_FOUND,
                "the requested Sub-Agent instance does not exist in the parent scope",
            )
        for _ in range(3):
            active = self.repositories.subagent_runs.get_active(cleaned_subagent_id)
            if active is not None:
                if control_run_id is not None and active.run_id != str(
                    control_run_id or ""
                ).strip():
                    raise SubagentError(
                        SubagentErrorCode.RUN_VERSION_CONFLICT,
                        "close control no longer targets the active Run",
                        details={"active_run_id": active.run_id},
                    )
                await self.cancel(
                    active.run_id,
                    reason="subagent_instance_close",
                    parent_session_id=parent_session_id,
                    expected_version=expected_version,
                )
            elif control_run_id is not None:
                controlled = await self.get_run(
                    control_run_id,
                    parent_session_id=parent_session_id,
                )
                self._validate_control_snapshot(
                    controlled,
                    parent_session_id=parent_session_id,
                    expected_version=expected_version,
                )
                history = self.repositories.subagent_runs.list_by_subagent(
                    cleaned_subagent_id
                )
                latest = history[-1] if history else None
                if latest is None or latest.run_id != controlled.run_id:
                    raise SubagentError(
                        SubagentErrorCode.RUN_VERSION_CONFLICT,
                        "close control no longer targets the latest Run",
                        details={"control_run_id": controlled.run_id},
                    )
                if controlled.subagent_id != cleaned_subagent_id:
                    raise SubagentError(
                        SubagentErrorCode.SUBAGENT_NOT_FOUND,
                        "close control Run does not belong to this Sub-Agent instance",
                    )
            try:
                closed = self.repositories.sessions.close_subagent_instance(
                    cleaned_subagent_id,
                    closed_at=self.clock(),
                )
            except SubagentError as exc:
                if exc.code is SubagentErrorCode.SUBAGENT_CLOSE_REQUIRES_CANCEL:
                    continue
                raise
            closed_at = datetime.fromisoformat(
                str(closed.subagent_closed_at).replace("Z", "+00:00")
            )
            return SubagentInstanceSummary(
                subagent_id=cleaned_subagent_id,
                child_session_id=closed.id,
                parent_session_id=closed.parent_session_id or "",
                role=SubagentRole(closed.subagent_role),
                state=SubagentInstanceState.CLOSED,
                closed_at=closed_at,
            )
        raise SubagentError(
            SubagentErrorCode.SUBAGENT_CLOSE_REQUIRES_CANCEL,
            "the Sub-Agent instance remained active during close orchestration",
            details={"subagent_id": cleaned_subagent_id},
        )

    @staticmethod
    def _validate_control_snapshot(
        snapshot: SubagentRunSnapshot,
        *,
        parent_session_id: str | None,
        expected_version: int | None,
    ) -> None:
        if (
            parent_session_id is not None
            and snapshot.parent_session_id != str(parent_session_id or "").strip()
        ):
            raise SubagentError(
                SubagentErrorCode.RUN_NOT_FOUND,
                "the requested Sub-Agent Run does not exist in the parent scope",
                details={"run_id": snapshot.run_id},
            )
        if expected_version is not None and snapshot.version != expected_version:
            raise SubagentError(
                SubagentErrorCode.RUN_VERSION_CONFLICT,
                "Sub-Agent control uses a stale Run version",
                details={
                    "run_id": snapshot.run_id,
                    "expected_version": expected_version,
                    "actual_version": snapshot.version,
                },
            )

    async def reconcile_interrupted_runs(self) -> list[SubagentRunSnapshot]:
        reconciled: list[SubagentRunSnapshot] = []
        owns_active_run = getattr(
            self.chat_stream_manager,
            "owns_active_run",
            None,
        )
        candidates = self.repositories.subagent_runs.list_reconciliation_candidates()
        for candidate in candidates:
            if callable(owns_active_run) and await owns_active_run(
                candidate.child_session_id
            ):
                continue
            current = await self.get_run(candidate.run_id)
            if current.is_terminal:
                continue
            try:
                interrupted = self.repositories.subagent_runs.transition(
                    current.run_id,
                    SubagentRunState.INTERRUPTED.value,
                    expected_version=current.version,
                    now=self.clock(),
                ).to_snapshot()
            except SubagentError as exc:
                if exc.code is SubagentErrorCode.RUN_VERSION_CONFLICT:
                    latest = await self.get_run(current.run_id)
                    if latest.is_terminal:
                        continue
                raise
            self.repositories.pending_inputs.pause_active_for_session(
                interrupted.child_session_id,
                reason="backend_restarted",
            )
            self.repositories.sessions.update(
                interrupted.child_session_id,
                status="active",
            )
            await self._publish_snapshot(interrupted)
            logger.info(format_subagent_log("reconcile", interrupted))
            reconciled.append(interrupted)
        return reconciled

    async def shutdown(self) -> None:
        lifecycle_subscription = self._chat_lifecycle_subscription
        self._chat_lifecycle_subscription = None
        if lifecycle_subscription is not None:
            lifecycle_subscription.unsubscribe()
        with self._listeners_lock:
            registrations = [
                registration
                for run_registrations in self._listeners.values()
                for registration in run_registrations.values()
            ]
            self._listeners.clear()
        for registration in registrations:
            registration.active = False
        with self._run_control_locks_guard:
            self._run_control_locks.clear()
        return None

    async def _ensure_running(self, run_id: str) -> SubagentRunSnapshot:
        for _ in range(3):
            current = await self.get_run(run_id)
            if current.state is not SubagentRunState.QUEUED:
                return current
            try:
                running = self.repositories.subagent_runs.transition(
                    run_id,
                    SubagentRunState.RUNNING.value,
                    expected_version=current.version,
                    now=self.clock(),
                ).to_snapshot()
            except SubagentError as exc:
                if exc.code is SubagentErrorCode.RUN_VERSION_CONFLICT:
                    continue
                raise
            await self._publish_snapshot(running)
            return running
        return await self.get_run(run_id)

    async def _finish_run(
        self,
        current: SubagentRunSnapshot,
        state: SubagentRunState,
        *,
        final_report: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> SubagentRunSnapshot:
        for _ in range(3):
            if current.is_terminal:
                return current
            try:
                terminal = self.repositories.subagent_runs.transition(
                    current.run_id,
                    state.value,
                    expected_version=current.version,
                    now=self.clock(),
                    final_report=final_report,
                    error_code=error_code,
                    error_message=error_message,
                ).to_snapshot()
            except SubagentError as exc:
                if exc.code is not SubagentErrorCode.RUN_VERSION_CONFLICT:
                    raise
                current = await self.get_run(current.run_id)
                continue
            await self._publish_snapshot(terminal)
            return terminal
        return await self.get_run(current.run_id)

    def _next_id(self, prefix: str) -> str:
        return f"{prefix}-{self.id_factory()}"

    def _run_control_lock(self, run_id: str) -> asyncio.Lock:
        with self._run_control_locks_guard:
            return self._run_control_locks.setdefault(run_id, asyncio.Lock())

    @staticmethod
    def _validate_parent(parent: Any | None, parent_session_id: str) -> None:
        if (
            parent is None
            or parent.visibility != "visible"
            or parent.agent_kind != "main"
            or parent.session_type != "workspace"
        ):
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_PARENT_INVALID,
                "parent must be an active visible Workspace main Session",
                details={"parent_session_id": parent_session_id},
            )

    async def _publish_snapshot(self, snapshot: SubagentRunSnapshot) -> None:
        logger.info(format_subagent_log("transition", snapshot))
        publisher = self.event_publisher
        if publisher is not None:
            callback = (
                publisher if callable(publisher) else getattr(publisher, "publish", None)
            )
            if callable(callback):
                try:
                    result = callback(snapshot)
                    if inspect.isawaitable(result):
                        await result
                except Exception as exc:
                    logger.opt(exception=True).error(
                        "[SubagentRuntime] snapshot publish failed after durable commit | "
                        f"run_id={snapshot.run_id} | error={exc}"
                    )
        with self._listeners_lock:
            registrations = tuple(self._listeners.get(snapshot.run_id, {}).values())
        if registrations:
            await asyncio.gather(
                *(
                    self._dispatch_registration(registration, snapshot)
                    for registration in registrations
                )
            )

    @staticmethod
    def _wait_is_cancelled(
        cancellation: SubagentWaitCancellation | asyncio.Event | None,
    ) -> bool:
        if cancellation is None:
            return False
        if isinstance(cancellation, asyncio.Event):
            return cancellation.is_set()
        return cancellation.is_cancelled()

    @staticmethod
    async def _wait_for_cancellation(
        cancellation: SubagentWaitCancellation | asyncio.Event,
    ) -> None:
        await cancellation.wait()

    @staticmethod
    async def _dispatch_registration(
        registration: _ListenerRegistration,
        snapshot: SubagentRunSnapshot,
    ) -> None:
        if not registration.accept_version(snapshot.version):
            return
        try:
            result = registration.listener(snapshot)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            logger.opt(exception=True).error(
                "[SubagentRuntime] listener failed | "
                f"run_id={snapshot.run_id} | version={snapshot.version} | error={exc}"
            )
