from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from langchain_core.messages import RemoveMessage, SystemMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent import AgentRunner
from backend.app.agent.event_processor import AgentEventResult, process_agent_events
from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
from backend.app.command_approval import ApprovalService
from backend.app.core.config import AppSettings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.events import (
    ChatProjection,
    ChatProjectionAdapter,
    DomainEventType,
    EventDispatcher,
    PersistenceProjection,
    TurnCompletedAggregator,
)
from backend.app.keydex import KeydexWorkspaceRuntimeCache
from backend.app.keydex.runtime import KeydexWorkspaceRuntimeSnapshot
from backend.app.keydex.skills import SkillCatalog
from backend.app.services.chat_types import ChatCancellationToken, ChatRequest, ChatTurnResult
from backend.app.services.message_event_service import MessageEventService
from backend.app.services.workspace_service import WorkspaceService
from backend.app.storage import SessionRecord, StorageRepositories
from backend.app.tools import ToolExecutionContext


class NullChatProjectionAdapter:
    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        return False


class MessageInjectionType(StrEnum):
    SLOT = "slot"
    FOLLOW = "follow"


class MessageInjectionRole(StrEnum):
    SYSTEM = "SystemMessage"
    HUMAN = "HumanMessage"
    AI = "AIMessage"


@dataclass(frozen=True)
class InjectedMessage:
    type: MessageInjectionType
    role: MessageInjectionRole
    content: str
    message_time: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class SkillActivationRequest:
    skill_name: str
    source: str = "workspace"
    origin: str | None = None


class SkillActivationError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class AgentLoopOutcome:
    event_result: AgentEventResult
    output_checkpoint_id: str | None
    output_checkpoint_ns: str


_SLOT_MESSAGE_ID = "keydex_slot_system_fixed"


def _build_message_injection_items(runtime_params: dict[str, Any] | None) -> list[InjectedMessage]:
    if not runtime_params:
        return []
    if not isinstance(runtime_params, dict):
        raise ValueError("runtime_params 必须是对象")
    raw_items = runtime_params.get("message_injection")
    if raw_items is None:
        raw_items = runtime_params.get("messageInjection")
    if raw_items is None:
        return []
    if not isinstance(raw_items, list):
        raise ValueError("runtime_params.message_injection 必须是数组")

    items: list[InjectedMessage] = []
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            raise ValueError(f"message_injection[{index}] 必须是对象")
        raw_type = str(raw_item.get("type") or "").strip()
        raw_role = str(raw_item.get("role") or "").strip()
        content = str(raw_item.get("content") or "").strip()
        if not content:
            raise ValueError(f"message_injection[{index}].content 不能为空")
        try:
            injection_type = MessageInjectionType(raw_type)
        except ValueError as exc:
            raise ValueError(f"message_injection[{index}].type 不支持: {raw_type}") from exc
        try:
            role = MessageInjectionRole(raw_role)
        except ValueError as exc:
            raise ValueError(f"message_injection[{index}].role 不支持: {raw_role}") from exc
        metadata = raw_item.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError(f"message_injection[{index}].metadata 必须是对象")
        message_time = raw_item.get("message_time")
        if message_time is None:
            message_time = raw_item.get("messageTime")
        items.append(
            InjectedMessage(
                type=injection_type,
                role=role,
                content=content,
                message_time=str(message_time).strip() if message_time else None,
                metadata=dict(metadata or {}),
            )
        )

    slot_items = [item for item in items if item.type == MessageInjectionType.SLOT]
    if len(slot_items) > 1:
        raise ValueError("同一请求中 type=slot 至多一条")
    if slot_items and slot_items[0].role != MessageInjectionRole.SYSTEM:
        raise ValueError("type=slot 时 role 必须为 SystemMessage")
    return items


def _build_skill_activation_request(
    runtime_params: dict[str, Any] | None,
) -> SkillActivationRequest | None:
    if not runtime_params:
        return None
    if not isinstance(runtime_params, dict):
        raise SkillActivationError("skill_activation_invalid", "runtime_params must be an object")
    if "tool_call_preset" in runtime_params or "toolCallPreset" in runtime_params:
        raise SkillActivationError(
            "skill_activation_invalid",
            "runtime_params.tool_call_preset is not supported",
        )
    raw_activation = runtime_params.get("skill_activation")
    if raw_activation is None:
        raw_activation = runtime_params.get("skillActivation")
    if raw_activation is None:
        return None
    if not isinstance(raw_activation, dict):
        raise SkillActivationError(
            "skill_activation_invalid",
            "runtime_params.skill_activation must be an object",
        )

    raw_skill_name = raw_activation.get("skill_name")
    if raw_skill_name is None:
        raw_skill_name = raw_activation.get("skillName")
    skill_name = str(raw_skill_name or "").strip()
    if not skill_name:
        raise SkillActivationError(
            "skill_activation_invalid",
            "runtime_params.skill_activation.skill_name must not be empty",
        )

    source = str(raw_activation.get("source") or "workspace").strip() or "workspace"
    if source != "workspace":
        raise SkillActivationError(
            "skill_source_unsupported",
            "System-level Skills are not enabled yet",
            {"source": source},
        )
    raw_origin = raw_activation.get("origin")
    origin = str(raw_origin).strip() if raw_origin else None
    return SkillActivationRequest(skill_name=skill_name, source=source, origin=origin)


def _build_skill_activation_preset(
    activation: SkillActivationRequest | None,
) -> ToolCallPreset | None:
    if activation is None:
        return None
    metadata: dict[str, Any] = {"source": activation.source}
    if activation.origin:
        metadata["origin"] = activation.origin
    return ToolCallPreset(
        type="force",
        producer="skill_activation",
        calls=[
            ToolCallPresetItem(
                name="load_skill",
                args={"skill_name": activation.skill_name},
            )
        ],
        metadata=metadata,
    )


def _chat_turn_error(exc: Exception) -> tuple[str | int, str, dict[str, Any]]:
    if isinstance(exc, SkillActivationError):
        return exc.code, exc.message, exc.details
    return 500, str(exc), {}


def _runtime_role_for_injection(role: MessageInjectionRole) -> str:
    if role == MessageInjectionRole.SYSTEM:
        return "system"
    if role == MessageInjectionRole.HUMAN:
        return "user"
    return "assistant"


def _to_runtime_message(item: InjectedMessage) -> dict[str, Any]:
    return {
        "role": _runtime_role_for_injection(item.role),
        "content": item.content,
        "_injected": True,
    }


def _message_created_event_type_for_role(role: str) -> DomainEventType:
    if role == "system":
        return DomainEventType.MESSAGE_SYSTEM_CREATED
    if role == "assistant":
        return DomainEventType.MESSAGE_AI_CREATED
    return DomainEventType.MESSAGE_USER_CREATED


async def _sync_slot_to_checkpoint(graph: Any, config: dict[str, Any], content: str) -> bool:
    if not content.strip():
        return False
    if not hasattr(graph, "aget_state") or not hasattr(graph, "aupdate_state"):
        logger.debug("[MessageInjection] graph 不支持 checkpoint slot patch，跳过 slot 同步")
        return False

    snapshot = await graph.aget_state(config)
    values = snapshot.values or {}
    state_messages = list(values.get("messages") or []) if isinstance(values, dict) else []
    existing_slot = next(
        (
            message
            for message in state_messages
            if (
                isinstance(message, SystemMessage)
                and getattr(message, "id", None) == _SLOT_MESSAGE_ID
            )
        ),
        None,
    )
    if existing_slot is not None and str(existing_slot.content or "") == content:
        return False

    rebuilt = [
        message
        for message in state_messages
        if not (
            isinstance(message, SystemMessage)
            and getattr(message, "id", None) == _SLOT_MESSAGE_ID
        )
    ]
    rebuilt.insert(0, SystemMessage(content=content, id=_SLOT_MESSAGE_ID))
    await graph.aupdate_state(
        config,
        {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *rebuilt]},
    )
    return True


class ChatService:
    def __init__(
        self,
        *,
        settings: AppSettings,
        repositories: StorageRepositories,
        agent_runner: AgentRunner,
        keydex_runtime_cache: KeydexWorkspaceRuntimeCache | None = None,
    ) -> None:
        self.settings = settings
        self.repositories = repositories
        self.agent_runner = agent_runner
        self.keydex_runtime_cache = keydex_runtime_cache or KeydexWorkspaceRuntimeCache()
        self.message_event_service = MessageEventService(repositories.message_events)
        self.workspace_service = WorkspaceService(repositories.workspaces)

    async def handle_chat(
        self,
        request: ChatRequest,
        *,
        chat_adapter: ChatProjectionAdapter | None = None,
        cancellation: ChatCancellationToken | None = None,
    ) -> ChatTurnResult:
        message_injection_items = _build_message_injection_items(request.runtime_params)
        skill_activation = _build_skill_activation_request(request.runtime_params)
        if not request.message.strip() and not message_injection_items:
            if skill_activation is not None:
                raise ValueError("请输入要使用该 Skill 处理的内容")
            raise ValueError("用户消息不能为空")

        token = cancellation or ChatCancellationToken()
        session = self._ensure_session(request)
        skill_activation_snapshot: KeydexWorkspaceRuntimeSnapshot | None = None
        _, max_turn = self.repositories.message_events.get_max_seq_and_turn(session.id)
        turn_index = max_turn + 1
        trace_id = new_id()
        root_node_id = f"{trace_id}-root"
        started_at = time.perf_counter()
        active_session_id = session.active_session_id or session.id
        context_token = set_request_context(
            trace_id=trace_id,
            session_id=session.id,
            active_session_id=active_session_id,
            user_id=request.user_id or session.user_id,
        )
        runtime_metadata = {"runtime": "desktop", "agent_runtime": "langchain"}
        if request.runtime_params:
            runtime_metadata["runtime_params"] = request.runtime_params

        logger.info(
            f"[ChatTurn] 开始处理对话 | session_id={session.id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | model={request.model or '-'} | "
            f"message_len={len(request.message)}"
        )

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
            metadata=runtime_metadata,
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
                logger.warning(
                    f"[ChatTurn] 模型为空，终止本轮 | session_id={session.id} | "
                    f"turn_index={turn_index} | trace_id={trace_id}"
                )
                raise ValueError("模型不能为空")

            skill_activation_snapshot = self._validate_skill_activation(skill_activation, session)
            await self._emit_turn_started(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
            )
            injected_runtime_messages, _slot_updated = await self._apply_message_injection(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                message_injection=message_injection_items,
            )
            await self._emit_skill_activation_context(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                skill_activation=skill_activation,
                keydex_snapshot=skill_activation_snapshot,
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
                injected_runtime_messages=injected_runtime_messages,
                skill_activation=skill_activation,
                keydex_snapshot=skill_activation_snapshot,
            )

            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            if token.is_cancelled():
                logger.info(
                    f"[ChatTurn] 用户取消本轮 | session_id={session.id} | "
                    f"turn_index={turn_index} | trace_id={trace_id} | duration_ms={duration_ms}"
                )
                await ApprovalService(
                    repositories=self.repositories,
                    dispatcher=dispatcher,
                ).cancel_pending_for_session(
                    session.id,
                    user_id=request.user_id or session.user_id,
                )
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
                logger.info(
                    f"[ChatTurn] 取消处理完成 | session_id={session.id} | "
                    f"turn_index={turn_index} | trace_id={trace_id}"
                )
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
            usage = outcome.event_result.latest_llm_token_usage
            logger.info(
                f"[ChatTurn] 对话完成 | session_id={session.id} | turn_index={turn_index} | "
                f"trace_id={trace_id} | duration_ms={duration_ms} | "
                f"input_tokens={usage.get('input_tokens', 0) or 0} | "
                f"output_tokens={usage.get('output_tokens', 0) or 0} | "
                f"final_content_len={len(completed_payload.get('final_content', ''))}"
            )
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="completed",
                final_content=completed_payload.get("final_content", ""),
            )
        except asyncio.CancelledError:
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            token.cancel()
            logger.info(
                f"[ChatTurn] 对话任务被强制取消 | session_id={session.id} | "
                f"turn_index={turn_index} | trace_id={trace_id} | duration_ms={duration_ms}"
            )
            payload = aggregator.build_cancelled_data(
                session_id=session.id,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                scene_id=request.scene_id or session.scene_id,
                reason="user",
            )
            try:
                await ApprovalService(
                    repositories=self.repositories,
                    dispatcher=dispatcher,
                ).cancel_pending_for_session(
                    session.id,
                    user_id=request.user_id or session.user_id,
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
            finally:
                self._finish_trace(trace_id, status="cancelled", duration_ms=duration_ms)
                self.repositories.sessions.update(session.id, status="active")
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="cancelled",
                final_content=payload.get("final_content", ""),
            )
        except Exception as exc:
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            error_code, error_message, error_details = _chat_turn_error(exc)
            logger.opt(exception=True).error(
                f"[ChatTurn] 对话失败 | session_id={session.id} | turn_index={turn_index} | "
                f"trace_id={trace_id} | duration_ms={duration_ms} | error={error_message}"
            )
            try:
                await dispatcher.emit_event(
                    event_type=DomainEventType.TURN_FAILED.value,
                    source="chat_service",
                    payload={
                        "session_id": session.id,
                        "trace_id": trace_id,
                        "message": error_message,
                        "error": error_message,
                        "code": error_code,
                        "details": error_details,
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
        finally:
            reset_request_context(context_token)

    async def _run_agent_loop(
        self,
        *,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
        dispatcher: EventDispatcher,
        cancellation: ChatCancellationToken,
        injected_runtime_messages: list[dict[str, Any]] | None = None,
        skill_activation: SkillActivationRequest | None = None,
        keydex_snapshot: KeydexWorkspaceRuntimeSnapshot | None = None,
    ) -> AgentLoopOutcome:
        active_session_id = session.active_session_id or session.id
        tool_context, enable_tools = self._build_tool_context(
            request=request,
            session=session,
            trace_id=trace_id,
            turn_index=turn_index,
            keydex_snapshot=keydex_snapshot,
        )
        tool_context.metadata["repositories"] = self.repositories
        tool_context.metadata["dispatcher"] = dispatcher
        workspace_root_label = str(tool_context.workspace_root) if enable_tools else "-"
        logger.info(
            f"[AgentLoop] 创建 agent | session_id={session.id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | model={request.model.strip()} | "
            f"session_type={session.session_type} | tools_enabled={enable_tools} | "
            f"workspace_root={workspace_root_label}"
        )
        agent_context_token = self._set_agent_runtime_context(
            tool_context=tool_context,
            skill_activation=skill_activation,
        )
        try:
            agent = self.agent_runner.create_agent(
                model=request.model.strip(),
                system_prompt=request.system_prompt,
                tool_context=tool_context,
                enable_tools=enable_tools,
            )
            run_config = {
                "configurable": {
                    "thread_id": active_session_id,
                    "checkpoint_ns": "",
                },
                "recursion_limit": max(4, self.settings.max_tool_calls * 2 + 4),
            }
            slot_items = [
                item
                for item in _build_message_injection_items(request.runtime_params)
                if item.type == MessageInjectionType.SLOT
            ]
            if slot_items:
                await _sync_slot_to_checkpoint(
                    agent,
                    {"configurable": {"thread_id": active_session_id, "checkpoint_ns": ""}},
                    slot_items[0].content,
                )
            messages_to_send = list(injected_runtime_messages or [])
            if request.message.strip():
                messages_to_send.append({"role": "user", "content": request.message})
            if not messages_to_send:
                messages_to_send.append(
                    {"role": "user", "content": "请根据已附加的上下文继续处理。"}
                )
            event_stream = agent.astream_events(
                {"messages": messages_to_send},
                config=run_config,
                version="v2",
            )
            logger.info(
                f"[AgentLoop] 开始事件流 | session_id={session.id} | turn_index={turn_index} | "
                f"trace_id={trace_id} | active_session_id={active_session_id}"
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
                model=request.model.strip(),
                llm_request_logs=self.repositories.llm_request_logs,
            )
        finally:
            reset_request_context(agent_context_token)
        checkpoint_config = await self.agent_runner.get_latest_checkpoint_config(
            thread_id=active_session_id,
            checkpoint_ns="",
        )
        logger.info(
            f"[AgentLoop] 事件流完成 | session_id={session.id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | llm_call_count="
            f"{event_result.chain_token_usage.get('llm_call_count', 0)} | "
            f"final_content_len={len(event_result.final_content)} | "
            f"checkpoint_id={checkpoint_config.get('checkpoint_id') or '-'}"
        )
        return AgentLoopOutcome(
            event_result=event_result,
            output_checkpoint_id=checkpoint_config.get("checkpoint_id"),
            output_checkpoint_ns=str(checkpoint_config.get("checkpoint_ns") or ""),
        )

    def _build_tool_context(
        self,
        *,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
        keydex_snapshot: KeydexWorkspaceRuntimeSnapshot | None = None,
    ) -> tuple[ToolExecutionContext, bool]:
        if session.session_type == "workspace":
            workspace_context = self.workspace_service.runtime_context_for_session(session)
            resolved_keydex_snapshot = keydex_snapshot or self.keydex_runtime_cache.get_snapshot(
                workspace_context.workspace.root_path
            )
            return (
                ToolExecutionContext(
                    session_id=session.id,
                    user_id=request.user_id or session.user_id,
                    workspace_root=workspace_context.cwd,
                    turn_index=turn_index,
                    trace_id=trace_id,
                    metadata={
                        "workspace_id": workspace_context.workspace_id,
                        "workspace_roots": [
                            str(root) for root in workspace_context.workspace_roots
                        ],
                        "keydex_snapshot": resolved_keydex_snapshot,
                        "keydex_profile": resolved_keydex_snapshot.keydex_profile,
                        "skill_catalog": resolved_keydex_snapshot.skill_catalog,
                        "keydex_fingerprint": resolved_keydex_snapshot.fingerprint,
                    },
                ),
                True,
            )
        if session.session_type == "chat":
            return (
                ToolExecutionContext(
                    session_id=session.id,
                    user_id=request.user_id or session.user_id,
                    workspace_root=self.settings.data_dir,
                    turn_index=turn_index,
                    trace_id=trace_id,
                    metadata={"tools_enabled": False},
                ),
                False,
            )
        raise ValueError(f"不支持的 session 类型: {session.session_type}")

    def _validate_skill_activation(
        self,
        activation: SkillActivationRequest | None,
        session: SessionRecord,
    ) -> KeydexWorkspaceRuntimeSnapshot | None:
        if activation is None:
            return None
        if session.session_type != "workspace":
            raise SkillActivationError(
                "skill_session_unsupported",
                "Workspace Skills can only be used in workspace sessions",
                {"session_type": session.session_type},
            )
        workspace_context = self.workspace_service.runtime_context_for_session(session)
        snapshot = self.keydex_runtime_cache.get_snapshot(workspace_context.workspace.root_path)
        if activation.skill_name not in snapshot.skill_catalog.skills:
            raise SkillActivationError(
                "skill_not_found",
                "Skill does not exist or has been deleted",
                {"skill_name": activation.skill_name},
            )
        return snapshot

    def _set_agent_runtime_context(
        self,
        *,
        tool_context: ToolExecutionContext,
        skill_activation: SkillActivationRequest | None,
    ):
        skill_catalog = tool_context.metadata.get("skill_catalog")
        if not isinstance(skill_catalog, SkillCatalog):
            skill_catalog = None
        keydex_snapshot = tool_context.metadata.get("keydex_snapshot")
        if not isinstance(keydex_snapshot, KeydexWorkspaceRuntimeSnapshot):
            keydex_snapshot = None
        return set_request_context(
            tool_call_preset=_build_skill_activation_preset(skill_activation),
            skill_catalog=skill_catalog,
            keydex_snapshot=keydex_snapshot,
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
                "runtime_params": request.runtime_params,
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

    async def _apply_message_injection(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        message_injection: list[InjectedMessage],
    ) -> tuple[list[dict[str, Any]], bool]:
        follow_messages = [
            item for item in message_injection if item.type == MessageInjectionType.FOLLOW
        ]
        slot_messages = [
            item for item in message_injection if item.type == MessageInjectionType.SLOT
        ]
        if not follow_messages and not slot_messages:
            return [], False

        injected_runtime_messages: list[dict[str, Any]] = []
        for slot_item in slot_messages:
            await self._emit_injected_message(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                item=slot_item,
            )

        for follow_item in follow_messages:
            runtime_message = _to_runtime_message(follow_item)
            injected_runtime_messages.append(runtime_message)
            await self._emit_injected_message(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                item=follow_item,
            )

        logger.info(
            f"[MessageInjection] 注入消息完成 | session_id={session.id} | "
            f"turn_index={turn_index} | "
            f"slot_count={len(slot_messages)} | follow_count={len(follow_messages)}"
        )
        return injected_runtime_messages, bool(slot_messages)

    async def _emit_injected_message(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        item: InjectedMessage,
    ) -> None:
        role = _runtime_role_for_injection(item.role)
        await dispatcher.emit_event(
            event_type=_message_created_event_type_for_role(role),
            source="message_injection",
            payload={
                "content": item.content,
                "session_id": session.id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "root_node_id": root_node_id,
                "messageTimeMs": int(time.time() * 1000),
                "source": "message_injection",
                "injectionSource": item.type.value,
                "injectionRole": item.role.value,
                "slotMessageId": (
                    _SLOT_MESSAGE_ID if item.type == MessageInjectionType.SLOT else None
                ),
                "metadata": item.metadata or {},
                "fallbackUserMessage": request.message,
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
            tags={"messageTimeMs": int(time.time() * 1000)},
        )

    async def _emit_skill_activation_context(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        skill_activation: SkillActivationRequest | None,
        keydex_snapshot: KeydexWorkspaceRuntimeSnapshot | None,
    ) -> None:
        if skill_activation is None or keydex_snapshot is None:
            return
        skill = keydex_snapshot.skill_catalog.skills.get(skill_activation.skill_name)
        if skill is None:
            return
        label = f"/{skill.name}"
        await dispatcher.emit_event(
            event_type=DomainEventType.MESSAGE_SYSTEM_CREATED.value,
            source="skill_activation",
            payload={
                "id": f"skill:{skill.name}",
                "content": skill.description,
                "session_id": session.id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "root_node_id": root_node_id,
                "messageTimeMs": int(time.time() * 1000),
                "source": "skill_activation",
                "skill_name": skill.name,
                "skillName": skill.name,
                "skill_source": skill.source,
                "skillSource": skill.source,
                "label": label,
                "description": skill.description,
                "origin": skill_activation.origin,
                "metadata": {
                    "id": f"skill:{skill.name}",
                    "type": "skill",
                    "label": label,
                    "skill_name": skill.name,
                    "skillName": skill.name,
                    "source": skill.source,
                    "description": skill.description,
                    "origin": skill_activation.origin,
                },
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
            tags={"messageTimeMs": int(time.time() * 1000)},
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
                logger.debug(f"[Session] 复用已有会话 | session_id={existing.id}")
                return existing
        created = self.repositories.sessions.create(
            session_id=request.session_id or new_id(),
            user_id=request.user_id or self.settings.default_user_id,
            scene_id=request.scene_id or self.settings.default_scene_id,
            title=_title_from_message(request.message),
            session_tag="chat",
        )
        logger.info(
            f"[Session] 创建新会话 | session_id={created.id} | "
            f"user_id={created.user_id} | scene_id={created.scene_id}"
        )
        return created

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
