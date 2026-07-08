from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langgraph.types import Command

from backend.app.a2ui.resume_context import build_a2ui_resume_context
from backend.app.core.request_context import (
    reset_a2ui_resume_context,
    reset_request_context,
    set_a2ui_resume_context,
    set_request_context,
)
from backend.app.core.logger import logger
from backend.app.events.completed_aggregator import TurnCompletedAggregator
from backend.app.events.dispatcher import EventDispatcher
from backend.app.events.event_types import DomainEventType
from backend.app.storage import (
    A2UI_RESUME_STATUS_FAILED,
    A2UI_RESUME_STATUS_NOT_STARTED,
    A2UI_RESUME_STATUS_STARTED,
    A2UI_RESUME_STATUS_SUCCEEDED,
    A2UI_STATUS_WAITING_USER_INPUT,
    A2UIInteractionRecord,
    StorageRepositories,
)

DEFAULT_A2UI_RESUME_RECURSION_LIMIT = 99_999


class A2UIResumeServiceError(RuntimeError):
    pass


@dataclass(frozen=True)
class A2UIResumeItem:
    interaction_id: str
    status: str
    tool_call_id: str | None
    render_key: str
    stream_id: str
    submit_request_id: str | None
    cancel_request_id: str | None
    interrupt_id: str | None
    resume_payload: dict[str, Any]


@dataclass(frozen=True)
class A2UIResumeSnapshot:
    interaction_id: str
    session_id: str
    active_session_id: str | None
    trace_id: str | None
    turn_index: int
    status: str
    tool_call_id: str | None
    render_key: str
    stream_id: str
    submit_request_id: str | None
    cancel_request_id: str | None
    langgraph_thread_id: str | None
    checkpoint_ns: str
    checkpoint_id: str | None
    interrupt_id: str | None
    resume_payload: dict[str, Any]
    resume_group_id: str | None
    resume_items: tuple[A2UIResumeItem, ...]


@dataclass(frozen=True)
class A2UIResumeStartResult:
    interaction_id: str
    resume_status: str
    started: bool
    resume_group_id: str | None = None
    pending_count: int = 0
    reason: str | None = None


class _NeverCancelled:
    def is_cancelled(self) -> bool:
        return False


AgentFactory = Callable[[A2UIResumeSnapshot], Any | Awaitable[Any]]
EventProcessor = Callable[..., Awaitable[Any]]
TaskFactory = Callable[[Awaitable[Any]], asyncio.Task[Any]]


class A2UIResumeService:
    def __init__(
        self,
        *,
        repositories: StorageRepositories,
        dispatcher: EventDispatcher,
        agent_factory: AgentFactory | None = None,
        event_processor: EventProcessor | None = None,
        task_factory: TaskFactory = asyncio.create_task,
        recursion_limit: int = DEFAULT_A2UI_RESUME_RECURSION_LIMIT,
    ) -> None:
        if event_processor is None:
            from backend.app.agent.event_processor import process_agent_events

            event_processor = process_agent_events
        self.repositories = repositories
        self.dispatcher = dispatcher
        self.agent_factory = agent_factory
        self.event_processor = event_processor
        self.task_factory = task_factory
        self.recursion_limit = recursion_limit

    async def start_resume(
        self,
        interaction_id: str,
        *,
        background: bool = True,
        cancellation: Any | None = None,
        user_id: str = "local-user",
    ) -> A2UIResumeStartResult:
        snapshot, started = self._mark_started_and_snapshot(interaction_id)
        if not started:
            pending_count = self._pending_resume_item_count(snapshot)
            if pending_count:
                result = A2UIResumeStartResult(
                    interaction_id=snapshot.interaction_id,
                    resume_status="deferred",
                    started=False,
                    resume_group_id=snapshot.resume_group_id,
                    pending_count=pending_count,
                    reason="waiting_peer_interactions",
                )
                await self._emit_resume_event(
                    snapshot,
                    event_type=DomainEventType.A2UI_RESUME_DEFERRED,
                    resume_status=result.resume_status,
                    pending_count=pending_count,
                    reason=result.reason,
                )
                return result
            current = self.repositories.a2ui_interactions.get(snapshot.interaction_id)
            return A2UIResumeStartResult(
                interaction_id=snapshot.interaction_id,
                resume_status=(current.resume_status if current else snapshot.status),
                started=False,
                resume_group_id=snapshot.resume_group_id,
                pending_count=0,
                reason="resume_already_active",
            )

        resume_coro = self._run_resume(
            snapshot,
            cancellation=cancellation or _NeverCancelled(),
            user_id=user_id,
            raise_errors=not background,
        )
        self.repositories.sessions.update(snapshot.session_id, status="running")
        if background:
            self.task_factory(resume_coro)
        else:
            await resume_coro

        return A2UIResumeStartResult(
            interaction_id=snapshot.interaction_id,
            resume_status=A2UI_RESUME_STATUS_STARTED,
            started=True,
            resume_group_id=snapshot.resume_group_id,
            pending_count=0,
            reason="all_peer_interactions_closed",
        )

    def _mark_started_and_snapshot(self, interaction_id: str) -> tuple[A2UIResumeSnapshot, bool]:
        interaction = self.repositories.a2ui_interactions.get(interaction_id)
        if interaction is None:
            raise A2UIResumeServiceError(f"A2UI interaction not found: {interaction_id}")
        if not interaction.resume_payload:
            raise A2UIResumeServiceError(f"A2UI interaction missing resume_payload: {interaction_id}")
        resume_group_id = interaction.resume_group_id or _fallback_resume_group_id(interaction)
        peers = self.repositories.a2ui_interactions.list_resume_group_peers(
            resume_group_id=resume_group_id,
            include_interaction_id=interaction.id,
        )
        if not peers:
            peers = [interaction]
        pending = [item for item in peers if item.status == A2UI_STATUS_WAITING_USER_INPUT]
        if pending:
            return self._build_snapshot(interaction, resume_group_id, peers), False

        active_statuses = {
            item.resume_status
            for item in peers
            if item.resume_status != A2UI_RESUME_STATUS_NOT_STARTED
        }
        if active_statuses:
            return self._build_snapshot(interaction, resume_group_id, peers), False

        for item in peers:
            if not item.resume_payload:
                raise A2UIResumeServiceError(
                    f"A2UI interaction missing resume_payload: {item.id}"
                )
        if len(peers) > 1:
            missing_interrupt_ids = [item.id for item in peers if not item.interrupt_id]
            if missing_interrupt_ids:
                raise A2UIResumeServiceError(
                    "A2UI interaction missing interrupt_id: "
                    + ", ".join(missing_interrupt_ids)
                )

        updated_peers = self.repositories.a2ui_interactions.mark_resume_started(
            [item.id for item in peers]
        )
        updated_by_id = {item.id: item for item in updated_peers}
        updated_interaction = updated_by_id.get(interaction.id, interaction)
        ordered_peers = [updated_by_id.get(item.id, item) for item in peers]
        return self._build_snapshot(updated_interaction, resume_group_id, ordered_peers), True

    async def _run_resume(
        self,
        snapshot: A2UIResumeSnapshot,
        *,
        cancellation: Any,
        user_id: str,
        raise_errors: bool,
    ) -> None:
        await self._emit_resume_event(
            snapshot,
            event_type=DomainEventType.A2UI_RESUME_STARTED,
            resume_status=A2UI_RESUME_STATUS_STARTED,
        )
        completed_aggregator = TurnCompletedAggregator()
        clone_with_consumers = getattr(self.dispatcher, "clone_with_consumers", None)
        turn_dispatcher = (
            clone_with_consumers([completed_aggregator.handle])
            if callable(clone_with_consumers)
            else self.dispatcher
        )
        try:
            event_result = await self._execute_resume(
                snapshot,
                cancellation=cancellation,
                user_id=user_id,
                dispatcher=turn_dispatcher,
            )
        except Exception as exc:
            error = str(exc) or exc.__class__.__name__
            self.repositories.a2ui_interactions.mark_resume_failed(
                [item.interaction_id for item in snapshot.resume_items],
                error=error,
            )
            await self._emit_resume_event(
                snapshot,
                event_type=DomainEventType.A2UI_RESUME_FAILED,
                resume_status=A2UI_RESUME_STATUS_FAILED,
                error=error,
            )
            logger.opt(exception=True).error(
                "[A2UIResumeService] resume failed | interaction_id={} | group_id={}",
                snapshot.interaction_id,
                snapshot.resume_group_id or "-",
            )
            if raise_errors:
                raise
            return

        self.repositories.a2ui_interactions.mark_resume_finished(
            [item.interaction_id for item in snapshot.resume_items]
        )
        await self._emit_resume_event(
            snapshot,
            event_type=DomainEventType.A2UI_RESUME_SUCCEEDED,
            resume_status=A2UI_RESUME_STATUS_SUCCEEDED,
        )
        if self.repositories.a2ui_interactions.get_waiting_by_session(snapshot.session_id):
            self.repositories.sessions.update(snapshot.session_id, status="waiting_input")
            return

        await self._emit_completed_event(
            snapshot,
            event_result=event_result,
            completed_aggregator=completed_aggregator,
            user_id=user_id,
        )
        self.repositories.sessions.update(snapshot.session_id, status="active")

    async def _execute_resume(
        self,
        snapshot: A2UIResumeSnapshot,
        *,
        cancellation: Any,
        user_id: str,
        dispatcher: EventDispatcher,
    ) -> Any:
        if self.agent_factory is None:
            raise A2UIResumeServiceError("A2UI resume agent_factory is not configured")
        active_session_id = (
            snapshot.active_session_id
            or snapshot.langgraph_thread_id
            or snapshot.session_id
        )
        context_token = set_request_context(
            trace_id=snapshot.trace_id or "",
            session_id=snapshot.session_id,
            active_session_id=active_session_id,
            user_id=user_id,
            turn_index=snapshot.turn_index,
        )
        resume_context_token = set_a2ui_resume_context(
            build_a2ui_resume_context(
                payloads_by_tool_call_id=_resume_payloads_by_tool_call_id(snapshot),
                payloads_by_render_key=_resume_payloads_by_render_key(snapshot),
            )
        )
        try:
            agent = await _maybe_await(self.agent_factory(snapshot))
            run_config = self._build_run_config(snapshot)
            event_stream = agent.astream_events(
                Command(resume=self._build_command_resume(snapshot)),
                config=run_config,
                version="v2",
            )
            return await self.event_processor(
                event_stream,
                dispatcher=dispatcher,
                cancellation=cancellation,
                session_id=snapshot.session_id,
                trace_id=snapshot.trace_id or "",
                user_id=user_id,
                active_session_id=active_session_id,
                turn_index=snapshot.turn_index,
            )
        finally:
            reset_a2ui_resume_context(resume_context_token)
            reset_request_context(context_token)

    async def _emit_completed_event(
        self,
        snapshot: A2UIResumeSnapshot,
        *,
        event_result: Any,
        completed_aggregator: TurnCompletedAggregator,
        user_id: str,
    ) -> None:
        payload = completed_aggregator.build_completed_data(
            session_id=snapshot.session_id,
            trace_id=snapshot.trace_id or "",
            user_id=user_id,
            chain_token_usage=_result_dict(event_result, "chain_token_usage"),
            latest_llm_token_usage=_result_dict(event_result, "latest_llm_token_usage"),
            final_content=str(getattr(event_result, "final_content", "") or ""),
        )
        await self.dispatcher.emit_event(
            event_type=DomainEventType.TURN_COMPLETED.value,
            source="a2ui_resume_service",
            payload=payload,
            original_session_id=snapshot.session_id,
            active_session_id=(
                snapshot.active_session_id
                or snapshot.langgraph_thread_id
                or snapshot.session_id
            ),
            trace_id=snapshot.trace_id,
            user_id=user_id,
            turn_index=snapshot.turn_index,
        )

    def _build_run_config(self, snapshot: A2UIResumeSnapshot) -> dict[str, Any]:
        configurable = {
            "thread_id": (
                snapshot.langgraph_thread_id
                or snapshot.active_session_id
                or snapshot.session_id
            ),
            "checkpoint_ns": snapshot.checkpoint_ns,
        }
        if snapshot.checkpoint_id:
            configurable["checkpoint_id"] = snapshot.checkpoint_id
        return {
            "configurable": configurable,
            "recursion_limit": self.recursion_limit,
        }

    @staticmethod
    def _build_command_resume(snapshot: A2UIResumeSnapshot) -> Any:
        if len(snapshot.resume_items) <= 1:
            return dict(snapshot.resume_payload)
        return {
            str(item.interrupt_id): dict(item.resume_payload)
            for item in snapshot.resume_items
            if item.interrupt_id
        }

    async def _emit_resume_event(
        self,
        snapshot: A2UIResumeSnapshot,
        *,
        event_type: DomainEventType,
        resume_status: str,
        pending_count: int = 0,
        reason: str | None = None,
        error: str | None = None,
    ) -> None:
        payload = {
            "interaction_id": snapshot.interaction_id,
            "render_key": snapshot.render_key,
            "stream_id": snapshot.stream_id,
            "tool_call_id": snapshot.tool_call_id,
            "status": snapshot.status,
            "resume_status": resume_status,
            "resume_group_id": snapshot.resume_group_id,
            "pending_count": pending_count,
            "reason": reason,
            "error": error,
            "checkpoint": {
                "thread_id": (
                    snapshot.langgraph_thread_id
                    or snapshot.active_session_id
                    or snapshot.session_id
                ),
                "checkpoint_ns": snapshot.checkpoint_ns,
                "checkpoint_id": snapshot.checkpoint_id,
                "interrupt_id": snapshot.interrupt_id,
            },
            "resume_payload": dict(snapshot.resume_payload),
            "resume_items": [self._resume_item_summary(item) for item in snapshot.resume_items],
        }
        await self.dispatcher.emit_event(
            event_type=event_type.value,
            source="a2ui_resume_service",
            payload=payload,
            original_session_id=snapshot.session_id,
            active_session_id=(
                snapshot.active_session_id
                or snapshot.langgraph_thread_id
                or snapshot.session_id
            ),
            trace_id=snapshot.trace_id,
            turn_index=snapshot.turn_index,
            tags={
                "interaction_id": snapshot.interaction_id,
                "resume_group_id": snapshot.resume_group_id,
                "resume_status": resume_status,
            },
        )

    @staticmethod
    def _build_snapshot(
        interaction: A2UIInteractionRecord,
        resume_group_id: str | None,
        peers: list[A2UIInteractionRecord],
    ) -> A2UIResumeSnapshot:
        return A2UIResumeSnapshot(
            interaction_id=interaction.id,
            session_id=interaction.session_id,
            active_session_id=interaction.active_session_id,
            trace_id=interaction.trace_id,
            turn_index=interaction.turn_index,
            status=interaction.status,
            tool_call_id=interaction.tool_call_id,
            render_key=interaction.render_key,
            stream_id=interaction.stream_id,
            submit_request_id=interaction.submit_request_id,
            cancel_request_id=interaction.cancel_request_id,
            langgraph_thread_id=interaction.langgraph_thread_id,
            checkpoint_ns=interaction.checkpoint_ns,
            checkpoint_id=interaction.checkpoint_id,
            interrupt_id=interaction.interrupt_id,
            resume_payload=dict(interaction.resume_payload or {}),
            resume_group_id=resume_group_id,
            resume_items=tuple(_resume_item(item) for item in peers),
        )

    @staticmethod
    def _pending_resume_item_count(snapshot: A2UIResumeSnapshot) -> int:
        return sum(
            1
            for item in snapshot.resume_items
            if item.status == A2UI_STATUS_WAITING_USER_INPUT
        )

    @staticmethod
    def _resume_item_summary(item: A2UIResumeItem) -> dict[str, Any]:
        return {
            "interaction_id": item.interaction_id,
            "status": item.status,
            "render_key": item.render_key,
            "tool_call_id": item.tool_call_id,
            "stream_id": item.stream_id,
            "submit_request_id": item.submit_request_id,
            "cancel_request_id": item.cancel_request_id,
            "interrupt_id": item.interrupt_id,
        }


def _resume_item(interaction: A2UIInteractionRecord) -> A2UIResumeItem:
    return A2UIResumeItem(
        interaction_id=interaction.id,
        status=interaction.status,
        tool_call_id=interaction.tool_call_id,
        render_key=interaction.render_key,
        stream_id=interaction.stream_id,
        submit_request_id=interaction.submit_request_id,
        cancel_request_id=interaction.cancel_request_id,
        interrupt_id=interaction.interrupt_id,
        resume_payload=dict(interaction.resume_payload or {}),
    )


def _resume_payloads_by_tool_call_id(
    snapshot: A2UIResumeSnapshot,
) -> dict[str, dict[str, Any]]:
    return {
        str(item.tool_call_id): dict(item.resume_payload or {})
        for item in snapshot.resume_items
        if str(item.tool_call_id or "").strip()
    }


def _resume_payloads_by_render_key(
    snapshot: A2UIResumeSnapshot,
) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in snapshot.resume_items:
        render_key = str(item.render_key or "").strip()
        if not render_key:
            continue
        grouped.setdefault(render_key, []).append(dict(item.resume_payload or {}))
    return grouped


def _result_dict(event_result: Any, attr: str) -> dict[str, Any]:
    value = getattr(event_result, attr, None)
    return dict(value) if isinstance(value, dict) else {}


def _fallback_resume_group_id(interaction: A2UIInteractionRecord) -> str:
    return ":".join(
        [
            interaction.session_id,
            interaction.langgraph_thread_id or interaction.active_session_id or interaction.session_id,
            interaction.checkpoint_ns,
            interaction.checkpoint_id or "",
            interaction.trace_id or "",
            str(interaction.turn_index),
        ]
    )


async def _maybe_await(value: Any) -> Any:
    if isinstance(value, Awaitable):
        return await value
    return value
