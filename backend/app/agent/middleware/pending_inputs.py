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

from backend.app.agent.state import (
    build_pending_tool_call_preset_update,
    build_structured_user_message_groups_update,
)
from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
from backend.app.core.logger import logger
from backend.app.core.request_context import (
    get_event_dispatcher,
    get_session_id,
    get_trace_id,
    get_turn_index,
)
from backend.app.events import EventDispatcher
from backend.app.events.event_types import DomainEventType
from backend.app.services.chat_message_payload import (
    build_user_runtime_message,
    resolve_image_attachments,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    StructuredUserMessageMember,
    build_structured_user_message_member,
)
from backend.app.storage import PendingInputRecord, StorageRepositories

_SLOT_MESSAGE_ID = "keydex_slot_system_fixed"
_INJECTED_MESSAGE_MARKER = "_injected"
_RUNNING_STEER_SYSTEM_PROMPT = (
    "接下来的一条或多条用户消息及其关联上下文，是用户在当前任务执行过程中追加的高优先级引导。"
    "在不违反更高优先级系统或开发者指令的前提下，请优先、认真地遵循这些引导，"
    "结合当前任务已有上下文和有效进展，调整接下来的计划、工具调用和输出，并继续推进当前任务。"
    "不要仅因收到这些消息就结束当前工作、放弃已有进展、重启任务，或把它们当作无关的新任务。"
    "如果多条引导相互冲突，请按发送顺序理解，并以较晚的引导为准。"
    "如果用户明确要求停止、取消、暂停、切换目标或从头开始，应按用户的明确要求执行。"
    "不要向用户复述本系统说明；请直接在后续行动中体现引导。"
)


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
        skill_activations: list[dict[str, str]] = []
        structured_groups: list[dict[str, Any]] = []

        for record in records:
            record_messages, attachment_payloads = self._messages_for_record(
                record,
                user_id=record.user_id or default_user_id,
            )
            if any(getattr(message, "id", None) == _SLOT_MESSAGE_ID for message in record_messages):
                slot_injected = True
            steering_messages.extend(record_messages)
            skill_activation = _pending_skill_activation(record)
            if skill_activation and skill_activation not in skill_activations:
                skill_activations.append(skill_activation)
            structured_groups.append(
                _pending_structured_user_message_group(
                    record,
                    attachment_payloads=attachment_payloads,
                    trace_id=trace_id,
                    turn_index=turn_index,
                ).to_dict()
            )
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

        if not steering_messages:
            return None

        steering_messages = [
            SystemMessage(
                content=_RUNNING_STEER_SYSTEM_PROMPT,
                additional_kwargs={
                    _INJECTED_MESSAGE_MARKER: True,
                    "keydex_delivery_mode": "steer",
                    "keydex_running_steer_instruction": True,
                    "keydex_pending_input_ids": [record.id for record in records],
                },
            ),
            *steering_messages,
        ]

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
        update: dict[str, Any] = {
            "messages": [
                RemoveMessage(id=REMOVE_ALL_MESSAGES),
                *messages,
                *steering_messages,
            ],
        }
        update.update(build_structured_user_message_groups_update(structured_groups))
        if skill_activations:
            preset = ToolCallPreset(
                type="force",
                producer="skill_activation",
                calls=[
                    ToolCallPresetItem(
                        name="load_skill",
                        args={
                            "skill_name": activation["skill_name"],
                            "source": activation["source"],
                        },
                    )
                    for activation in skill_activations
                ],
                metadata={
                    "source": "pending_user_input",
                    "skill_activations": skill_activations,
                },
            )
            update.update(build_pending_tool_call_preset_update(preset.to_dict()))
        return update

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
            _INJECTED_MESSAGE_MARKER: True,
            "keydex_pending_input_id": record.id,
            "keydex_delivery_mode": record.mode,
        }
        messages = _pending_runtime_injection_messages(record, metadata=metadata)
        user_message = build_user_runtime_message(
            record.message,
            image_records,
            data_dir=self._repositories.db.path.parent,
        )
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


def _pending_skill_activation(record: PendingInputRecord) -> dict[str, str] | None:
    runtime_params = record.runtime_params if isinstance(record.runtime_params, dict) else {}
    activation = runtime_params.get("skill_activation")
    if activation is None:
        activation = runtime_params.get("skillActivation")
    if not isinstance(activation, dict):
        return None
    skill_name = str(
        activation.get("skill_name") or activation.get("skillName") or ""
    ).strip()
    if not skill_name:
        return None
    source = str(activation.get("source") or "workspace").strip() or "workspace"
    return {"skill_name": skill_name, "source": source}


def _pending_structured_user_message_group(
    record: PendingInputRecord,
    *,
    attachment_payloads: list[dict[str, Any]],
    trace_id: str,
    turn_index: int,
) -> StructuredUserMessageGroup:
    members: list[StructuredUserMessageMember] = []
    order = 0
    members.append(
        build_structured_user_message_member(
            "pending_user_input_context",
            order,
            {
                "pending_input_id": record.id,
                "client_input_id": record.client_input_id,
                "delivery_mode": record.mode,
                "status": record.status,
            },
            source_id=record.id,
        )
    )
    order += 1

    runtime_params = record.runtime_params if isinstance(record.runtime_params, dict) else {}
    raw_injections = runtime_params.get("message_injection")
    if raw_injections is None:
        raw_injections = runtime_params.get("messageInjection")
    if isinstance(raw_injections, list):
        for index, raw in enumerate(raw_injections):
            if not isinstance(raw, dict):
                continue
            content = str(raw.get("content") or "").strip()
            if not content:
                continue
            injection_type = str(raw.get("type") or "follow").strip()
            role = str(raw.get("role") or "HumanMessage").strip()
            members.append(
                build_structured_user_message_member(
                    (
                        "message_injection_slot"
                        if injection_type == "slot"
                        else "message_injection_follow"
                    ),
                    order,
                    {
                        "type": "slot" if injection_type == "slot" else "follow",
                        "role": (
                            role
                            if role in {"SystemMessage", "HumanMessage", "AIMessage"}
                            else "HumanMessage"
                        ),
                        "content": content,
                        "message_time": raw.get("message_time", raw.get("messageTime")),
                        "metadata": dict(raw.get("metadata") or {}),
                        "hidden_for_transcript": bool(
                            raw.get("hidden_for_transcript", raw.get("hiddenForTranscript", False))
                        ),
                    },
                    source_id=f"{record.id}:injection:{index}",
                )
            )
            order += 1

    activation = _pending_skill_activation(record)
    if activation is not None:
        members.append(
            build_structured_user_message_member(
                "skill_activation",
                order,
                activation,
                source_id=f"{record.id}:skill",
            )
        )
        order += 1

    for index, item in enumerate(_pending_context_items(record)):
        payload = {
            key: item[key]
            for key in (
                "id",
                "type",
                "label",
                "content",
                "role",
                "source",
                "metadata",
                "path",
                "name",
                "description",
                "locator",
            )
            if key in item
        }
        if "file_type" in item or "fileType" in item:
            payload["file_type"] = item.get("file_type", item.get("fileType"))
        if "skill_name" in item or "skillName" in item:
            payload["skill_name"] = item.get("skill_name", item.get("skillName"))
        members.append(
            build_structured_user_message_member(
                "message_context_item",
                order,
                payload,
                source_id=str(item.get("id") or f"{record.id}:context:{index}"),
            )
        )
        order += 1

    root = build_structured_user_message_member(
        "root_user_message",
        order,
        {
            "content": record.message,
            "message_id": record.id,
            "role": "HumanMessage",
            "hidden_for_transcript": False,
        },
        source_id=record.id,
    )
    order += 1

    for index, item in enumerate(attachment_payloads):
        attachment_id = str(item.get("attachment_id") or item.get("id") or "").strip()
        members.append(
            build_structured_user_message_member(
                "image_attachment" if str(item.get("type") or "") == "image" else "attachment",
                order,
                {
                    **{
                        key: item[key]
                        for key in ("type", "source", "name", "mime_type", "size")
                        if item.get(key) is not None
                    },
                    "attachment_id": attachment_id,
                    "order": index,
                },
                source_id=attachment_id,
            )
        )
        order += 1

    return StructuredUserMessageGroup.create(
        group_id=f"sug-pending-{record.id}",
        root_user_message=root,
        members=members,
        source_session_id=record.session_id,
        trace_id=trace_id,
        turn_index=turn_index,
        message_event_id=record.id,
    )
