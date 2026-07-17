from __future__ import annotations

from collections.abc import Iterable

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

from backend.app.agent.context_compression_utils import (
    is_context_compression_summary_message,
    stringify_message_content,
)
from backend.app.services.chat_types import ChatRequest
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)
from backend.app.storage import MessageEventRecord, StorageRepositories, TraceRecord


def is_legacy_compact_summary_message(message: BaseMessage) -> bool:
    if is_context_compression_summary_message(message):
        return True
    metadata = dict(getattr(message, "additional_kwargs", {}) or {})
    compression_metadata = metadata.get("keydex_context_compression")
    if isinstance(compression_metadata, dict) and compression_metadata.get("kind") == "summary":
        return True
    if metadata.get("is_compact_summary") is True or metadata.get("isCompactSummary") is True:
        return True
    content = stringify_message_content(message.content).lstrip()
    return isinstance(message, SystemMessage) and content.startswith(
        "<keydex_context_compression"
    )


class LegacyUserGroupReconstructor:
    def __init__(self, repositories: StorageRepositories) -> None:
        self._repositories = repositories

    def reconstruct_session(
        self,
        session_id: str,
        *,
        existing_groups: Iterable[StructuredUserMessageGroup] = (),
    ) -> list[StructuredUserMessageGroup]:
        existing_trace_ids = {
            group.trace_id for group in existing_groups if group.trace_id is not None
        }
        events = self._repositories.message_events.list_by_session(session_id, limit=5000)
        events_by_trace: dict[str, list[MessageEventRecord]] = {}
        for event in events:
            trace_id = str(event.trace_record_id or "").strip()
            if trace_id:
                events_by_trace.setdefault(trace_id, []).append(event)

        groups: list[StructuredUserMessageGroup] = []
        for trace in self._repositories.trace_records.list_by_session(session_id):
            if trace.trace_id in existing_trace_ids:
                continue
            group = self._reconstruct_trace(trace, events_by_trace.get(trace.trace_id, []))
            if group is not None:
                groups.append(group)
        return groups

    def reconstruct_messages(
        self,
        messages: Iterable[BaseMessage],
        *,
        session_id: str | None = None,
    ) -> list[StructuredUserMessageGroup]:
        groups: list[StructuredUserMessageGroup] = []
        for index, message in enumerate(messages):
            if not isinstance(message, HumanMessage) or is_legacy_compact_summary_message(message):
                continue
            content = stringify_message_content(message.content)
            root = build_structured_user_message_member(
                "root_user_message",
                0,
                {
                    "content": content,
                    "message_id": str(getattr(message, "id", "") or f"legacy-{index}"),
                    "role": "HumanMessage",
                    "metadata": {
                        key: value
                        for key, value in dict(message.additional_kwargs or {}).items()
                        if key not in {"runtime_params", "runtimeParams"}
                    },
                },
                source_id=str(getattr(message, "id", "") or "") or None,
            )
            groups.append(
                StructuredUserMessageGroup.create(
                    group_id=f"legacy-message-{getattr(message, 'id', None) or index}",
                    root_user_message=root,
                    completeness="incomplete",
                    incomplete_reasons=["legacy_message_only"],
                    source_session_id=session_id,
                    message_event_id=str(getattr(message, "id", "") or "") or None,
                )
            )
        return groups

    def _reconstruct_trace(
        self,
        trace: TraceRecord,
        events: list[MessageEventRecord],
    ) -> StructuredUserMessageGroup | None:
        metadata = dict(trace.metadata or {})
        runtime_params = metadata.get("runtime_params")
        runtime_params = dict(runtime_params) if isinstance(runtime_params, dict) else {}
        user_events = [event for event in events if event.action == "user_message"]
        user_event = user_events[-1] if user_events else None
        event_data = dict(user_event.data or {}) if user_event is not None else {}
        content = (
            str(event_data.get("content") or "")
            if user_event is not None
            else str(trace.user_message_preview or "")
        )
        if user_event is None and not content and not runtime_params:
            return None

        request = ChatRequest(
            message=content,
            session_id=trace.session_id,
            user_id=trace.user_id,
            runtime_params=runtime_params,
            attachments=list(event_data.get("attachments") or []),
        )
        try:
            from backend.app.services.chat_service import (
                _build_initial_thread_task_context,
                _build_message_context_items,
                _build_message_injection_items,
                _build_skill_activation_request,
                _build_structured_user_message_group,
                _build_thread_task_runtime_context,
            )

            injections = _build_message_injection_items(runtime_params)
            context_items = _build_message_context_items(runtime_params)
            if not context_items and isinstance(event_data.get("context_items"), list):
                context_items = [
                    dict(item)
                    for item in event_data["context_items"]
                    if isinstance(item, dict)
                ]
            group = _build_structured_user_message_group(
                request=request,
                message_injection=injections,
                message_context_items=context_items,
                skill_activation=_build_skill_activation_request(runtime_params),
                attachment_payloads=[
                    dict(item)
                    for item in event_data.get("attachments") or []
                    if isinstance(item, dict)
                ],
                thread_task_context=(
                    _build_thread_task_runtime_context(runtime_params)
                    or _build_initial_thread_task_context(runtime_params)
                ),
                session_id=trace.session_id,
                trace_id=trace.trace_id,
                turn_index=trace.turn_index,
                message_event_id=(
                    user_event.id if user_event is not None else f"legacy-{trace.trace_id}"
                ),
            )
        except (TypeError, ValueError):
            return self._fallback_incomplete_group(
                trace,
                content=content,
                message_event_id=user_event.id if user_event is not None else None,
                reason="legacy_payload_invalid",
            )

        if user_event is not None:
            return group
        return StructuredUserMessageGroup.create(
            group_id=group.group_id,
            root_user_message=group.root_user_message,
            members=group.members,
            completeness="incomplete",
            incomplete_reasons=["missing_user_message_event"],
            source_session_id=group.source_session_id,
            trace_id=group.trace_id,
            turn_index=group.turn_index,
            message_event_id=group.message_event_id,
        )

    @staticmethod
    def _fallback_incomplete_group(
        trace: TraceRecord,
        *,
        content: str,
        message_event_id: str | None,
        reason: str,
    ) -> StructuredUserMessageGroup:
        root = build_structured_user_message_member(
            "root_user_message",
            0,
            {
                "content": content,
                "message_id": message_event_id or f"legacy-{trace.trace_id}",
                "role": "HumanMessage",
            },
            source_id=message_event_id,
        )
        return StructuredUserMessageGroup.create(
            group_id=f"sug-{trace.trace_id}",
            root_user_message=root,
            completeness="incomplete",
            incomplete_reasons=[reason],
            source_session_id=trace.session_id,
            trace_id=trace.trace_id,
            turn_index=trace.turn_index,
            message_event_id=message_event_id,
        )
