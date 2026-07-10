from __future__ import annotations

import time
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
)
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
from backend.app.core.logger import logger
from backend.app.core.request_context import (
    get_event_dispatcher,
    get_session_id,
    get_trace_id,
    get_turn_index,
    set_tool_call_preset,
)
from backend.app.events import EventDispatcher
from backend.app.events.event_types import DomainEventType
from backend.app.services.chat_message_payload import (
    build_user_runtime_message,
    resolve_image_attachments,
)
from backend.app.storage import PendingInputRecord, StorageRepositories

_SLOT_MESSAGE_ID = "keydex_slot_system_fixed"


class PendingUserInputInjectionMiddleware(AgentMiddleware):
    """Inject persisted steer inputs before the current turn's next model request."""

    def __init__(
        self,
        *,
        repositories: StorageRepositories,
        dispatcher: EventDispatcher | None = None,
        max_batch_size: int = 20,
    ) -> None:
        self._repositories = repositories
        self._dispatcher = dispatcher
        self._max_batch_size = max(1, min(int(max_batch_size), 100))

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        session_id = get_session_id().strip()
        trace_id = get_trace_id().strip()
        turn_index = get_turn_index()
        if not session_id or turn_index is None:
            return None

        records = self._repositories.pending_inputs.claim_pending_steers(
            session_id,
            turn_index=turn_index,
            trace_id=trace_id,
            lock_owner=f"middleware:{trace_id}:{turn_index}",
            limit=self._max_batch_size,
        )
        if not records:
            return None

        session = self._repositories.sessions.get(session_id)
        default_user_id = str(getattr(session, "user_id", "") or "")
        dispatcher = self._dispatcher or get_event_dispatcher()
        steering_messages: list[BaseMessage] = []
        slot_injected = False
        skill_names: list[str] = []

        for record in records:
            record_messages, attachment_payloads = self._messages_for_record(
                record,
                user_id=record.user_id or default_user_id,
            )
            if any(getattr(message, "id", None) == _SLOT_MESSAGE_ID for message in record_messages):
                slot_injected = True
            steering_messages.extend(record_messages)
            skill_name = _pending_skill_name(record)
            if skill_name and skill_name not in skill_names:
                skill_names.append(skill_name)
            await self._emit_user_message_event(
                dispatcher,
                record=record,
                trace_id=trace_id,
                turn_index=turn_index,
                attachments=attachment_payloads,
            )
            await self._emit_delivered_event(
                dispatcher,
                record=record,
                trace_id=trace_id,
                turn_index=turn_index,
            )

        if skill_names:
            set_tool_call_preset(
                ToolCallPreset(
                    type="force",
                    producer="skill_activation",
                    calls=[
                        ToolCallPresetItem(name="load_skill", args={"skill_name": skill_name})
                        for skill_name in skill_names
                    ],
                    metadata={"source": "pending_user_input"},
                )
            )

        if not steering_messages:
            return None

        messages = list((state or {}).get("messages") or [])
        if slot_injected:
            messages = [
                message
                for message in messages
                if getattr(message, "id", None) != _SLOT_MESSAGE_ID
            ]
        logger.info(
            "[PendingUserInputInjectionMiddleware] 注入运行中引导消息 | "
            f"session_id={session_id} | turn_index={turn_index} | "
            f"inputs={len(records)} | messages={len(steering_messages)}"
        )
        return {
            "messages": [
                RemoveMessage(id=REMOVE_ALL_MESSAGES),
                *messages,
                *steering_messages,
            ],
        }

    def _messages_for_record(
        self,
        record: PendingInputRecord,
        *,
        user_id: str,
    ) -> tuple[list[BaseMessage], list[dict[str, Any]]]:
        image_records, attachment_payloads = resolve_image_attachments(
            self._repositories,
            list(record.attachments or []),
            session_id=record.session_id,
            user_id=user_id,
        )
        metadata = {
            "keydex_pending_input_id": record.id,
            "keydex_delivery_mode": record.mode,
        }
        messages = _pending_runtime_injection_messages(record, metadata=metadata)
        user_message = build_user_runtime_message(record.message, image_records)
        if user_message is not None:
            messages.append(
                HumanMessage(
                    content=user_message["content"],
                    additional_kwargs=metadata,
                )
            )
        return messages, attachment_payloads

    @staticmethod
    async def _emit_user_message_event(
        dispatcher: EventDispatcher | None,
        *,
        record: PendingInputRecord,
        trace_id: str,
        turn_index: int,
        attachments: list[dict[str, Any]],
    ) -> None:
        if dispatcher is None:
            return
        context_items = _pending_context_items(record)
        await dispatcher.emit_event(
            event_type=DomainEventType.MESSAGE_USER_CREATED.value,
            source="pending_input_middleware",
            payload={
                "content": record.message,
                "attachments": attachments,
                "contextItems": context_items,
                "context_items": context_items,
                "delivery_mode": record.mode,
                "pending_input_id": record.id,
                "session_id": record.session_id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "messageTimeMs": int(time.time() * 1000),
            },
            trace_id=trace_id,
            user_id=record.user_id,
            original_session_id=record.session_id,
            active_session_id=record.session_id,
            turn_index=turn_index,
        )

    @staticmethod
    async def _emit_delivered_event(
        dispatcher: EventDispatcher | None,
        *,
        record: PendingInputRecord,
        trace_id: str,
        turn_index: int,
    ) -> None:
        if dispatcher is None:
            return
        payload = record.to_dict()
        payload["pending_input"] = record.to_dict()
        try:
            await dispatcher.emit_event(
                event_type=DomainEventType.PENDING_INPUT_DELIVERED.value,
                source="pending_input_middleware",
                payload=payload,
                trace_id=trace_id,
                user_id=record.user_id,
                original_session_id=record.session_id,
                active_session_id=record.session_id,
                turn_index=turn_index,
            )
        except Exception as exc:
            logger.opt(exception=True).warning(
                "[PendingUserInputInjectionMiddleware] pending input delivered 事件发送失败 | "
                f"session_id={record.session_id} | pending_input_id={record.id} | error={exc}"
            )


def _pending_runtime_injection_messages(
    record: PendingInputRecord,
    *,
    metadata: dict[str, Any],
) -> list[BaseMessage]:
    runtime_params = record.runtime_params if isinstance(record.runtime_params, dict) else {}
    raw_items = runtime_params.get("message_injection")
    if raw_items is None:
        raw_items = runtime_params.get("messageInjection")
    if not isinstance(raw_items, list):
        return []

    messages: list[BaseMessage] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        content = str(raw_item.get("content") or "").strip()
        if not content:
            continue
        role = str(raw_item.get("role") or "HumanMessage").strip()
        injection_type = str(raw_item.get("type") or "follow").strip()
        if role == "SystemMessage":
            messages.append(
                SystemMessage(
                    content=content,
                    id=_SLOT_MESSAGE_ID if injection_type == "slot" else None,
                    additional_kwargs=metadata,
                )
            )
        elif role == "AIMessage":
            messages.append(AIMessage(content=content, additional_kwargs=metadata))
        else:
            messages.append(HumanMessage(content=content, additional_kwargs=metadata))
    return messages


def _pending_context_items(record: PendingInputRecord) -> list[dict[str, Any]]:
    runtime_params = record.runtime_params if isinstance(record.runtime_params, dict) else {}
    raw_items = runtime_params.get("message_context_items")
    if raw_items is None:
        raw_items = runtime_params.get("messageContextItems")
    if not isinstance(raw_items, list):
        return []
    return [dict(item) for item in raw_items if isinstance(item, dict)]


def _pending_skill_name(record: PendingInputRecord) -> str:
    runtime_params = record.runtime_params if isinstance(record.runtime_params, dict) else {}
    activation = runtime_params.get("skill_activation")
    if activation is None:
        activation = runtime_params.get("skillActivation")
    if not isinstance(activation, dict):
        return ""
    return str(activation.get("skill_name") or activation.get("skillName") or "").strip()
