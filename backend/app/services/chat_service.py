from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from backend.app.agent import AgentRunner
from backend.app.agent.event_processor import AgentEventResult, process_agent_events
from backend.app.core.config import AppSettings
from backend.app.core.ids import IdPrefix, new_id
from backend.app.events import (
    ChatProjection,
    ChatProjectionAdapter,
    DomainEventType,
    EventDispatcher,
    PersistenceProjection,
    TurnCompletedAggregator,
)
from backend.app.services.message_event_service import MessageEventService
from backend.app.storage import SessionRecord, StorageRepositories
from backend.app.tools import ToolExecutionContext


class ChatCancellationToken:
    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def is_cancelled(self) -> bool:
        return self._cancelled


class NullChatProjectionAdapter:
    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        return False


@dataclass(frozen=True)
class ChatRequest:
    message: str
    session_id: str | None = None
    user_id: str | None = None
    scene_id: str | None = None
    model: str = ""
    system_prompt: str | None = None


@dataclass(frozen=True)
class ChatTurnResult:
    session_id: str
    trace_id: str
    turn_index: int
    status: str
    final_content: str = ""
    error: str | None = None


@dataclass(frozen=True)
class AgentLoopOutcome:
    event_result: AgentEventResult
    output_checkpoint_id: str | None
    output_checkpoint_ns: str


class ChatService:
    def __init__(
        self,
        *,
        settings: AppSettings,
        repositories: StorageRepositories,
        agent_runner: AgentRunner,
    ) -> None:
        self.settings = settings
        self.repositories = repositories
        self.agent_runner = agent_runner
        self.message_event_service = MessageEventService(repositories.message_events)

    async def handle_chat(
        self,
        request: ChatRequest,
        *,
        chat_adapter: ChatProjectionAdapter | None = None,
        cancellation: ChatCancellationToken | None = None,
    ) -> ChatTurnResult:
        if not request.message.strip():
            raise ValueError("用户消息不能为空")

        token = cancellation or ChatCancellationToken()
        session = self._ensure_session(request)
        _, max_turn = self.repositories.message_events.get_max_seq_and_turn(session.id)
        turn_index = max_turn + 1
        trace_id = new_id("trace")
        root_node_id = f"{trace_id}-root"
        started_at = time.perf_counter()

        self.repositories.sessions.update(session.id, status="running")
        self.repositories.trace_records.create(
            trace_id=trace_id,
            session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            scene_id=request.scene_id or session.scene_id,
            scene_name=self.settings.default_scene_name,
            user_id=request.user_id or session.user_id,
            turn_index=turn_index,
            root_node_id=root_node_id,
            user_message_preview=request.message[:200],
            metadata={"runtime": "desktop", "agent_runtime": "langchain"},
        )

        aggregator = TurnCompletedAggregator()
        dispatcher = self._build_turn_dispatcher(
            session_id=session.id,
            turn_index=turn_index,
            chat_adapter=chat_adapter,
            aggregator=aggregator,
        )

        try:
            if not request.model.strip():
                raise ValueError("模型不能为空")

            await self._emit_turn_started(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
            )
            await self._emit_user_message(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                turn_index=turn_index,
            )

            outcome = await self._run_agent_loop(
                request=request,
                session=session,
                trace_id=trace_id,
                turn_index=turn_index,
                dispatcher=dispatcher,
                cancellation=token,
            )

            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            if token.is_cancelled():
                payload = aggregator.build_cancelled_data(
                    session_id=session.id,
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    scene_id=request.scene_id or session.scene_id,
                    reason="user",
                )
                await dispatcher.emit_event(
                    event_type=DomainEventType.TURN_CANCELLED.value,
                    source="chat_service",
                    payload=payload,
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    original_session_id=session.id,
                    active_session_id=session.active_session_id or session.id,
                    turn_index=turn_index,
                )
                self._finish_trace(
                    trace_id,
                    status="cancelled",
                    duration_ms=duration_ms,
                    output_checkpoint_id=outcome.output_checkpoint_id,
                    output_checkpoint_ns=outcome.output_checkpoint_ns,
                )
                self.repositories.sessions.update(session.id, status="active")
                return ChatTurnResult(
                    session_id=session.id,
                    trace_id=trace_id,
                    turn_index=turn_index,
                    status="cancelled",
                    final_content=payload.get("final_content", ""),
                )

            completed_payload = aggregator.build_completed_data(
                session_id=session.id,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                scene_id=request.scene_id or session.scene_id,
                chain_token_usage=outcome.event_result.chain_token_usage,
                latest_llm_token_usage=outcome.event_result.latest_llm_token_usage,
                final_content=outcome.event_result.final_content,
            )
            await dispatcher.emit_event(
                event_type=DomainEventType.TURN_COMPLETED.value,
                source="chat_service",
                payload=completed_payload,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                original_session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                turn_index=turn_index,
            )
            self._finish_trace_from_usage(
                trace_id,
                status="completed",
                usage=outcome.event_result.latest_llm_token_usage,
                duration_ms=duration_ms,
                output_checkpoint_id=outcome.output_checkpoint_id,
                output_checkpoint_ns=outcome.output_checkpoint_ns,
            )
            self.repositories.sessions.update(session.id, status="active")
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="completed",
                final_content=completed_payload.get("final_content", ""),
            )
        except Exception as exc:
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            error_message = str(exc)
            try:
                await dispatcher.emit_event(
                    event_type=DomainEventType.TURN_FAILED.value,
                    source="chat_service",
                    payload={
                        "session_id": session.id,
                        "trace_id": trace_id,
                        "message": error_message,
                        "error": error_message,
                        "code": 500,
                    },
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    original_session_id=session.id,
                    active_session_id=session.active_session_id or session.id,
                    turn_index=turn_index,
                )
            finally:
                self._finish_trace(trace_id, status="failed", duration_ms=duration_ms)
                self.repositories.sessions.update(session.id, status="failed")
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="failed",
                error=error_message,
            )

    async def _run_agent_loop(
        self,
        *,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
        dispatcher: EventDispatcher,
        cancellation: ChatCancellationToken,
    ) -> AgentLoopOutcome:
        active_session_id = session.active_session_id or session.id
        tool_context = ToolExecutionContext(
            session_id=session.id,
            user_id=request.user_id or session.user_id,
            workspace_root=self.settings.workspace_root,
            turn_index=turn_index,
            trace_id=trace_id,
        )
        agent = self.agent_runner.create_agent(
            model=request.model.strip(),
            system_prompt=request.system_prompt,
            tool_context=tool_context,
        )
        run_config = {
            "configurable": {
                "thread_id": active_session_id,
                "checkpoint_ns": "",
            },
            "recursion_limit": max(4, self.settings.max_tool_calls * 2 + 4),
        }
        event_stream = agent.astream_events(
            {"messages": [{"role": "user", "content": request.message}]},
            config=run_config,
            version="v2",
        )
        event_result = await process_agent_events(
            event_stream,
            dispatcher=dispatcher,
            cancellation=cancellation,
            session_id=session.id,
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            active_session_id=active_session_id,
            turn_index=turn_index,
        )
        checkpoint_config = await self.agent_runner.get_latest_checkpoint_config(
            thread_id=active_session_id,
            checkpoint_ns="",
        )
        return AgentLoopOutcome(
            event_result=event_result,
            output_checkpoint_id=checkpoint_config.get("checkpoint_id"),
            output_checkpoint_ns=str(checkpoint_config.get("checkpoint_ns") or ""),
        )

    def _build_turn_dispatcher(
        self,
        *,
        session_id: str,
        turn_index: int,
        chat_adapter: ChatProjectionAdapter | None,
        aggregator: TurnCompletedAggregator,
    ) -> EventDispatcher:
        dispatcher = EventDispatcher()
        dispatcher.register_projection(ChatProjection(chat_adapter or NullChatProjectionAdapter()))
        dispatcher.register_projection(
            PersistenceProjection(
                repository=self.repositories.message_events,
                session_id=session_id,
                turn_index=turn_index,
            )
        )
        dispatcher.register_projection(aggregator)
        return dispatcher

    async def _emit_turn_started(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
    ) -> None:
        await dispatcher.emit_event(
            event_type=DomainEventType.TURN_STARTED.value,
            source="chat_service",
            payload={
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "session_id": session.id,
                "scene_id": request.scene_id or session.scene_id,
                "scene_name": self.settings.default_scene_name,
                "root_node_id": root_node_id,
                "turn_index": turn_index,
                "user_id": request.user_id or session.user_id,
                "user_message": request.message,
                "agent_name": "desktop_agent",
                "model": request.model.strip(),
                "start_time": int(time.time() * 1000),
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
        )

    async def _emit_user_message(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
    ) -> None:
        await dispatcher.emit_event(
            event_type=DomainEventType.MESSAGE_USER_CREATED.value,
            source="chat_service",
            payload={
                "content": request.message,
                "session_id": session.id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "messageTimeMs": int(time.time() * 1000),
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
        )

    def _ensure_session(self, request: ChatRequest) -> SessionRecord:
        if request.session_id:
            existing = self.repositories.sessions.get(request.session_id)
            if existing is not None:
                return existing
        return self.repositories.sessions.create(
            session_id=request.session_id or new_id(IdPrefix.SESSION),
            user_id=request.user_id or self.settings.default_user_id,
            scene_id=request.scene_id or self.settings.default_scene_id,
            title=_title_from_message(request.message),
            session_tag="chat",
        )

    def _finish_trace_from_usage(
        self,
        trace_id: str,
        *,
        status: str,
        usage: dict[str, Any],
        duration_ms: int,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
    ) -> None:
        self.repositories.trace_records.finish(
            trace_id,
            status=status,
            duration_ms=duration_ms,
            total_input_tokens=int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
            total_output_tokens=int(
                usage.get("output_tokens") or usage.get("completion_tokens") or 0
            ),
            total_cache_read_tokens=int(usage.get("cache_read_tokens") or 0),
            output_checkpoint_id=output_checkpoint_id,
            output_checkpoint_ns=output_checkpoint_ns,
        )

    def _finish_trace(
        self,
        trace_id: str,
        *,
        status: str,
        duration_ms: int,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
    ) -> None:
        self.repositories.trace_records.finish(
            trace_id,
            status=status,
            duration_ms=duration_ms,
            output_checkpoint_id=output_checkpoint_id,
            output_checkpoint_ns=output_checkpoint_ns,
        )


def _title_from_message(message: str) -> str:
    normalized = " ".join(message.split())
    return normalized[:40] or "新对话"
