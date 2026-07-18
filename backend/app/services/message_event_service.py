from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from pydantic import ValidationError

from backend.app.a2ui.schemas import a2ui_object_from_record
from backend.app.core.errors import normalize_error_envelope
from backend.app.events.actions import CompletedEventItemAction, ReplayAction
from backend.app.storage import A2UIInteractionsRepository, MessageEventRecord
from backend.app.web.ui_payload import WebActivityPayload

_TOOL_PREVIEW_TEXT_LIMIT = 1000


class MessageEventService:
    def __init__(self, repository, a2ui_interactions_repository=None) -> None:
        self._repository = repository
        self._a2ui_interactions_repository = (
            a2ui_interactions_repository
            or self._derive_a2ui_interactions_repository(repository)
        )

    def get_display_messages(
        self,
        session_id: str,
        *,
        include_tool_details: bool = True,
    ) -> list[dict[str, Any]]:
        messages = self._aggregate_events(
            self._repository.list_by_session(session_id),
            include_tool_details=include_tool_details,
        )
        return self._enrich_a2ui_messages(messages)

    def get_turn_messages(
        self,
        session_id: str,
        turn_index: int,
        *,
        include_tool_details: bool = True,
    ) -> list[dict[str, Any]]:
        messages = self._aggregate_events(
            self._repository.list_by_turn(session_id, turn_index),
            include_tool_details=include_tool_details,
        )
        return self._enrich_a2ui_messages(messages)

    def get_tool_detail(
        self,
        *,
        session_id: str,
        start_event_id: str | None = None,
        end_event_id: str | None = None,
    ) -> dict[str, Any] | None:
        start_event = self._load_tool_event(
            session_id,
            start_event_id,
            expected_action=ReplayAction.TOOL_START.value,
        )
        end_event = self._load_tool_event(
            session_id,
            end_event_id,
            expected_action=ReplayAction.TOOL_END.value,
        )
        if start_event is None and end_event is None:
            return None
        if start_event is not None and end_event is not None:
            start_data = self._visible_data(start_event)
            end_data = self._visible_data(end_event)
            if not _same_tool_call(start_data, end_data):
                return None
        return self._tool_detail_from_events(start_event, end_event)

    def _aggregate_events(
        self,
        events: list[MessageEventRecord],
        *,
        include_tool_details: bool,
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        active_subagents: dict[str, int] = {}
        tool_run_map: dict[str, tuple[int, int | None]] = {}
        approval_message_map: dict[str, int] = {}
        compression_message_map: dict[str, int] = {}
        pending_context_items: list[dict[str, Any]] = []

        for event in events:
            action = self._canonical_action(event)
            data = self._visible_data(event)

            if action in {
                ReplayAction.USER_MESSAGE.value,
                ReplayAction.SYSTEM_MESSAGE.value,
                ReplayAction.AI_MESSAGE.value,
            }:
                if self._is_message_injection_event(event, data):
                    pending_context_items.append(
                        self._context_item_from_injected_message(event, data, action)
                    )
                    continue
                if self._is_skill_activation_event(event, data):
                    pending_context_items.append(
                        self._context_item_from_skill_activation(event, data)
                    )
                    continue
                if self._is_message_context_item_event(event, data):
                    pending_context_items.append(
                        self._context_item_from_message_context_item(event, data)
                    )
                    continue

            if action == ReplayAction.USER_MESSAGE.value:
                message = {
                    "role": "user",
                    "content": data.get("content", ""),
                    "attachments": data.get("attachments", []),
                    "timestamp": self._event_timestamp_ms(event),
                    "messageEventId": event.id,
                    "turnIndex": event.turn_index,
                }
                pending_input_id = str(data.get("pending_input_id") or "").strip()
                delivery_mode = str(data.get("delivery_mode") or "").strip()
                if pending_input_id:
                    message["pendingInputId"] = pending_input_id
                if delivery_mode in {"steer", "queue"}:
                    message["deliveryMode"] = delivery_mode
                context_items = self._merge_context_items(
                    pending_context_items,
                    self._context_items_from_user_message(data),
                )
                if context_items:
                    message["contextItems"] = context_items
                pending_context_items = []
                messages.append(message)
                continue

            if action == ReplayAction.TURN_STARTED.value:
                messages.append(
                    {
                        "role": "turn",
                        "content": "",
                        "timestamp": self._event_timestamp_ms(event),
                        "messageEventId": event.id,
                        "turnIndex": event.turn_index,
                        "traceId": data.get("trace_id"),
                        "metadata": {
                            "kind": "turn_started",
                            "source": data.get("source") or "user",
                            "source_label": data.get("source_label") or "",
                            "thread_task": data.get("thread_task"),
                        },
                    }
                )
                continue

            if action == ReplayAction.SYSTEM_MESSAGE.value:
                if self._is_hidden_internal_system_message(data):
                    continue
                messages.append(
                    {
                        "role": "system",
                        "content": data.get("content", ""),
                        "timestamp": self._event_timestamp_ms(event),
                        "messageEventId": event.id,
                        "turnIndex": event.turn_index,
                    }
                )
                continue

            if action == ReplayAction.THREAD_TASK_STATUS.value:
                messages.append(
                    {
                        "role": "thread_task",
                        "content": "",
                        "timestamp": self._event_timestamp_ms(event),
                        "messageEventId": event.id,
                        "turnIndex": event.turn_index,
                        "traceId": data.get("trace_id"),
                        "toolName": "update_thread_task",
                        "toolParams": data.get("payload") or {},
                        "uiPayload": data.get("ui_payload") or {"task": data.get("task")},
                        "status": "completed",
                        "metadata": {
                            "kind": "thread_task_status",
                            "task_id": data.get("task_id"),
                            "run_id": data.get("run_id"),
                            "status": data.get("status"),
                            "summary": data.get("summary"),
                        },
                    }
                )
                continue

            if action == ReplayAction.AI_MESSAGE.value:
                message = {
                    "role": "assistant",
                    "content": data.get("content", ""),
                    "timestamp": self._event_timestamp_ms(event),
                    "messageEventId": event.id,
                    "turnIndex": event.turn_index,
                }
                self._apply_thread_task_metadata(message, data)
                messages.append(message)
                continue

            if action == ReplayAction.STREAM_BATCH.value:
                self._append_stream_batch(
                    messages,
                    active_subagents,
                    event,
                    data,
                    self._event_timestamp_ms(event),
                )
                continue

            if action == ReplayAction.TOOL_START.value:
                self._append_tool_start(
                    messages,
                    active_subagents,
                    tool_run_map,
                    event,
                    data,
                    self._event_timestamp_ms(event),
                    include_tool_details=include_tool_details,
                )
                continue

            if action == ReplayAction.TOOL_END.value:
                self._apply_tool_end(
                    messages,
                    tool_run_map,
                    event,
                    data,
                    include_tool_details=include_tool_details,
                )
                continue

            if action == ReplayAction.A2UI_CREATED.value:
                messages.append(self._build_a2ui_message(event, data))
                continue

            if action == ReplayAction.WAITING_INPUT.value:
                self._apply_a2ui_waiting_input(messages, data)
                continue

            if action == ReplayAction.APPROVAL_REQUESTED.value:
                self._append_or_update_approval(
                    messages,
                    approval_message_map,
                    data,
                    self._event_timestamp_ms(event),
                )
                continue

            if action == ReplayAction.APPROVAL_RESOLVED.value:
                self._append_or_update_approval(
                    messages,
                    approval_message_map,
                    data,
                    self._event_timestamp_ms(event),
                )
                continue

            if action == ReplayAction.SUBAGENT_START.value:
                subagent_id = str(data.get("subagent_id") or "")
                messages.append(
                    {
                        "role": "subagent",
                        "content": "",
                        "subagentName": data.get("agent", data.get("subagent_name", "")),
                        "subagentId": subagent_id,
                        "subagentTask": data.get("task", ""),
                        "subagentToolCalls": [],
                        "timestamp": self._event_timestamp_ms(event),
                    }
                )
                if subagent_id:
                    active_subagents[subagent_id] = len(messages) - 1
                continue

            if action == ReplayAction.SUBAGENT_END.value:
                active_subagents.pop(str(data.get("subagent_id") or ""), None)
                continue

            if action == ReplayAction.SUBAGENT_ERROR.value:
                subagent_id = str(data.get("subagent_id") or "")
                error = str(data.get("error") or "")
                if subagent_id in active_subagents:
                    idx = active_subagents.pop(subagent_id)
                    content = str(messages[idx].get("content", "") or "")
                    messages[idx]["content"] = f"{content}\n\n[错误: {error}]"
                continue

            if action == ReplayAction.REASONING.value:
                message = {
                    "role": "reasoning",
                    "content": str(data.get("text", data.get("content", "")) or ""),
                    "reasoningKind": data.get("kind", "reasoning"),
                    "timestamp": self._event_timestamp_ms(event),
                    "messageEventId": event.id,
                    "turnIndex": event.turn_index,
                }
                duration_ms = _non_negative_duration_ms(data.get("duration_ms"))
                if duration_ms is not None:
                    message["reasoningDurationMs"] = duration_ms
                messages.append(message)
                continue

            if action == ReplayAction.MIDDLEWARE_PROGRESS.value:
                if _is_visible_llm_retry_progress(data):
                    notice_id = _llm_retry_notice_id_from_data(data)
                    message = {
                        "role": "system",
                        "content": _llm_retry_progress_content(data),
                        "timestamp": self._event_timestamp_ms(event),
                        "messageEventId": event.id,
                        "turnIndex": event.turn_index,
                        "metadata": {
                            "retry": _llm_retry_metadata(data),
                        },
                        "status": _llm_retry_status(data),
                    }
                    if notice_id in compression_message_map:
                        messages[compression_message_map[notice_id]].update(message)
                    else:
                        compression_message_map[notice_id] = len(messages)
                        messages.append(message)
                    continue
                if _is_visible_context_compression_progress(data):
                    notice_id = _context_compression_notice_id_from_data(data)
                    message = {
                        "role": "system",
                        "content": _context_compression_progress_content(data),
                        "timestamp": self._event_timestamp_ms(event),
                        "messageEventId": event.id,
                        "turnIndex": event.turn_index,
                        "metadata": {
                            "compression": _context_compression_metadata(data),
                        },
                        "status": _context_compression_status(data),
                    }
                    if notice_id in compression_message_map:
                        messages[compression_message_map[notice_id]].update(message)
                    else:
                        compression_message_map[notice_id] = len(messages)
                        messages.append(message)
                continue

            if action == ReplayAction.COMPLETED.value:
                self._apply_turn_duration_to_latest_assistant(
                    messages,
                    terminal_timestamp=self._event_timestamp_ms(event),
                    turn_index=event.turn_index,
                    data=data,
                )
                self._apply_ghost_footer_to_latest_assistant(messages, data)
                continue

            if action == ReplayAction.CANCELLED.value:
                self._apply_turn_duration_to_latest_assistant(
                    messages,
                    terminal_timestamp=self._event_timestamp_ms(event),
                    turn_index=event.turn_index,
                    data=data,
                )
                self._append_cancelled_marker(messages, data, self._event_timestamp_ms(event))
                continue

            if action == ReplayAction.ERROR.value:
                self._apply_turn_duration_to_latest_assistant(
                    messages,
                    terminal_timestamp=self._event_timestamp_ms(event),
                    turn_index=event.turn_index,
                    data=data,
                )
                turn_error = normalize_error_envelope(
                    data,
                    fallback_message="运行时错误",
                ).to_public_dict()
                trace_id = data.get("trace_id")
                messages.append(
                    {
                        "role": "error",
                        "content": turn_error["message"],
                        "traceId": trace_id,
                        "timestamp": self._event_timestamp_ms(event),
                        "messageEventId": event.id,
                        "turnIndex": event.turn_index,
                        "metadata": {
                            "turnError": turn_error,
                            "errorContext": {
                                "traceId": trace_id,
                                "messageEventId": event.id,
                                "turnIndex": event.turn_index,
                            },
                        },
                    }
                )

        return messages

    @staticmethod
    def events_to_messages(
        events: list[dict[str, Any]],
        user_message: dict[str, Any] | None = None,
        terminal_data: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        tool_run_map: dict[str, int] = {}
        if user_message:
            messages.append(dict(user_message))

        ghost_footer = MessageEventService._extract_ghost_footer(terminal_data or {})
        for event in events:
            action = event.get("action", "")
            data = event.get("data") or {}
            if action == CompletedEventItemAction.AI_MESSAGE.value:
                messages.append({"role": "assistant", "content": data.get("content", "")})
                continue
            if action == CompletedEventItemAction.TOOL_START.value:
                run_id = str(data.get("run_id") or "")
                tool_run_map[run_id] = len(messages)
                messages.append(
                    {
                        "role": "tool",
                        "content": "",
                        "toolName": data.get("tool", data.get("tool_name", "")),
                        "toolParams": data.get("params"),
                        "runId": run_id,
                        "status": "running",
                    }
                )
                continue
            if action == CompletedEventItemAction.TOOL_END.value:
                run_id = str(data.get("run_id") or "")
                if run_id in tool_run_map:
                    target = messages[tool_run_map[run_id]]
                    MessageEventService._apply_tool_payload_to_message(target, data)
                continue
            if action == CompletedEventItemAction.REASONING_MESSAGE.value:
                message = {
                    "role": "reasoning",
                    "content": str(data.get("text", data.get("content", "")) or ""),
                    "reasoningKind": data.get("kind", "reasoning"),
                }
                duration_ms = _non_negative_duration_ms(data.get("duration_ms"))
                if duration_ms is not None:
                    message["reasoningDurationMs"] = duration_ms
                messages.append(message)

        MessageEventService._apply_ghost_footer_to_latest_assistant(messages, ghost_footer)
        return messages

    @staticmethod
    def _canonical_action(event: MessageEventRecord) -> str:
        canonical = event.data.get("_canonical")
        if isinstance(canonical, dict) and canonical.get("action"):
            return str(canonical["action"])
        return event.action

    @staticmethod
    def _visible_data(event: MessageEventRecord) -> dict[str, Any]:
        data = dict(event.data or {})
        data.pop("_canonical", None)
        return data

    @staticmethod
    def _derive_a2ui_interactions_repository(repository):
        db = getattr(repository, "db", None)
        if db is None:
            return None
        return A2UIInteractionsRepository(db)

    def _enrich_a2ui_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self._a2ui_interactions_repository is None:
            return messages
        for message in self._iter_a2ui_messages(messages):
            a2ui = message["a2ui"]
            interaction_id = self._a2ui_interaction_id(a2ui)
            if not interaction_id:
                continue
            interaction = self._a2ui_interactions_repository.get(interaction_id)
            if interaction is None:
                current = dict(a2ui.get("interaction") or {})
                current.update(
                    {
                        "interaction_id": interaction_id,
                        "status": "missing",
                        "can_submit": False,
                        "error": "interaction_not_found",
                    }
                )
                a2ui["interaction"] = current
                continue
            enriched = a2ui_object_from_record(interaction).model_dump(mode="json")
            a2ui.update(enriched)
        return messages

    @staticmethod
    def _build_a2ui_message(
        event: MessageEventRecord,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        a2ui = dict(data.get("a2ui") or {})
        interaction = data.get("interaction")
        if isinstance(interaction, dict) and "interaction" not in a2ui:
            a2ui["interaction"] = dict(interaction)
        for key in ("render_key", "mode", "stream_id", "tool_call_id", "trace_id", "turn_index"):
            if key in data and key not in a2ui:
                a2ui[key] = data.get(key)
        message = {
            "role": "a2ui",
            "content": "",
            "contentType": "a2ui",
            "content_type": "a2ui",
            "a2ui": a2ui,
            "timestamp": MessageEventService._event_timestamp_ms(event),
            "messageEventId": event.id,
            "turnIndex": event.turn_index,
        }
        trace_id = str(data.get("trace_id") or a2ui.get("trace_id") or "").strip()
        if trace_id:
            message["traceId"] = trace_id
        return message

    @staticmethod
    def _iter_a2ui_messages(messages: list[dict[str, Any]]):
        for message in messages:
            if message.get("role") == "a2ui" and isinstance(message.get("a2ui"), dict):
                yield message

    @staticmethod
    def _a2ui_interaction_id(a2ui: dict[str, Any]) -> str:
        interaction = a2ui.get("interaction")
        if isinstance(interaction, dict):
            interaction_id = str(interaction.get("interaction_id") or "").strip()
            if interaction_id:
                return interaction_id
        return str(a2ui.get("interaction_id") or "").strip()

    @staticmethod
    def _apply_a2ui_waiting_input(
        messages: list[dict[str, Any]],
        data: dict[str, Any],
    ) -> None:
        interaction_id = str(data.get("interaction_id") or "").strip()
        if not interaction_id:
            return
        for message in reversed(messages):
            if message.get("role") != "a2ui" or not isinstance(message.get("a2ui"), dict):
                continue
            a2ui = message["a2ui"]
            if MessageEventService._a2ui_interaction_id(a2ui) != interaction_id:
                continue
            interaction = dict(a2ui.get("interaction") or {})
            interaction["interaction_id"] = interaction_id
            interaction["status"] = interaction.get("status") or "waiting_user_input"
            interaction["can_submit"] = True
            a2ui["interaction"] = interaction
            a2ui["waiting_input"] = {
                "reason": data.get("reason"),
                "checkpoint": data.get("checkpoint") or {},
            }
            return

    @staticmethod
    def _canonical_source(event: MessageEventRecord) -> str:
        canonical = event.data.get("_canonical")
        if isinstance(canonical, dict) and canonical.get("source"):
            return str(canonical["source"])
        return str((event.data or {}).get("source") or "")

    @staticmethod
    def _is_message_injection_event(event: MessageEventRecord, data: dict[str, Any]) -> bool:
        return (
            data.get("source") == "message_injection"
            or MessageEventService._canonical_source(event) == "message_injection"
        )

    @staticmethod
    def _is_skill_activation_event(event: MessageEventRecord, data: dict[str, Any]) -> bool:
        return (
            data.get("source") == "skill_activation"
            or MessageEventService._canonical_source(event) == "skill_activation"
        )

    @staticmethod
    def _is_message_context_item_event(event: MessageEventRecord, data: dict[str, Any]) -> bool:
        return (
            data.get("source") == "message_context_item"
            or MessageEventService._canonical_source(event) == "message_context_item"
        )

    @staticmethod
    def _context_item_from_injected_message(
        event: MessageEventRecord,
        data: dict[str, Any],
        action: str,
    ) -> dict[str, Any]:
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        item_type = str(
            metadata.get("kind") or metadata.get("type") or data.get("injectionSource") or "follow"
        )
        content = str(data.get("content") or "")
        item: dict[str, Any] = {
            "id": str(metadata.get("id") or f"injection:{event.id}"),
            "type": item_type,
            "label": str(metadata.get("label") or _default_context_label(item_type, content)),
            "content": content,
            "role": str(data.get("injectionRole") or _role_from_replay_action(action)),
            "source": str(data.get("injectionSource") or "follow"),
            "timestamp": MessageEventService._event_timestamp_ms(event),
            "metadata": dict(metadata),
        }
        for key in ("path", "name", "fileType", "file_type"):
            if metadata.get(key) is not None:
                item[key] = metadata.get(key)
        return item

    @staticmethod
    def _context_item_from_message_context_item(
        event: MessageEventRecord,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        item_type = str(
            data.get("context_type")
            or data.get("contextType")
            or metadata.get("kind")
            or metadata.get("type")
            or "follow"
        )
        label = str(
            data.get("label")
            or metadata.get("label")
            or _default_context_label(item_type, "")
        )
        item: dict[str, Any] = {
            "id": str(data.get("id") or metadata.get("id") or f"context:{event.id}"),
            "type": item_type,
            "label": label,
            "content": str(data.get("content") or ""),
            "role": str(data.get("role") or "HumanMessage"),
            "source": str(data.get("item_source") or data.get("itemSource") or "runtime"),
            "timestamp": MessageEventService._event_timestamp_ms(event),
            "metadata": dict(metadata),
        }
        for key in (
            "path",
            "name",
            "fileType",
            "file_type",
            "skill_name",
            "skillName",
            "description",
            "locator",
        ):
            if data.get(key) is not None:
                item[key] = data.get(key)
        return item

    @staticmethod
    def _context_item_from_skill_activation(
        event: MessageEventRecord,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        skill_name = str(
            data.get("skill_name")
            or data.get("skillName")
            or metadata.get("skill_name")
            or metadata.get("skillName")
            or ""
        ).strip()
        label = str(data.get("label") or metadata.get("label") or f"/{skill_name}").strip()
        description = str(data.get("description") or metadata.get("description") or "").strip()
        raw_skill_source = str(
            data.get("skill_source")
            or data.get("skillSource")
            or metadata.get("source")
            or "workspace"
        ).strip()
        skill_source = (
            raw_skill_source
            if raw_skill_source in {"builtin", "system", "workspace"}
            else "workspace"
        )
        locator = str(data.get("locator") or metadata.get("locator") or "").strip()
        origin = str(data.get("origin") or metadata.get("origin") or "").strip() or None
        item_id = (
            f"skill:{skill_source}:{skill_name}"
            if skill_name
            else str(data.get("id") or metadata.get("id") or f"skill:{event.id}")
        )
        normalized_metadata = {
            **dict(metadata),
            "id": item_id,
            "type": "skill",
            "label": label,
            "skill_name": skill_name,
            "skillName": skill_name,
            "source": skill_source,
            "description": description,
            "locator": locator,
            "origin": origin,
        }
        return {
            "id": item_id,
            "type": "skill",
            "label": label,
            "content": description,
            "skill_name": skill_name,
            "skillName": skill_name,
            "source": skill_source,
            "description": description,
            "locator": locator,
            "origin": origin,
            "timestamp": MessageEventService._event_timestamp_ms(event),
            "metadata": normalized_metadata,
        }

    @staticmethod
    def _context_items_from_user_message(data: dict[str, Any]) -> list[dict[str, Any]]:
        raw_items = data.get("contextItems")
        if not isinstance(raw_items, list):
            raw_items = data.get("context_items")
        if not isinstance(raw_items, list):
            return []
        return [dict(item) for item in raw_items if isinstance(item, dict)]

    @staticmethod
    def _merge_context_items(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[tuple[str, ...]] = set()
        for group in groups:
            for item in group:
                identity = MessageEventService._context_item_identity(item)
                if identity in seen:
                    continue
                seen.add(identity)
                merged.append(item)
        return merged

    @staticmethod
    def _context_item_identity(item: dict[str, Any]) -> tuple[str, ...]:
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        item_id = str(item.get("id") or metadata.get("id") or "").strip()
        if item_id:
            return ("id", item_id)
        return (
            "shape",
            str(item.get("type") or metadata.get("kind") or "").strip(),
            str(
                item.get("skill_name")
                or item.get("skillName")
                or metadata.get("skill_name")
                or metadata.get("skillName")
                or ""
            ).strip(),
            str(item.get("path") or metadata.get("path") or "").strip(),
            str(item.get("label") or metadata.get("label") or "").strip(),
            str(item.get("content") or "").strip(),
            str(item.get("source") or metadata.get("source") or "").strip(),
        )

    @staticmethod
    def _is_hidden_internal_system_message(data: dict[str, Any]) -> bool:
        if data.get("internal") is True:
            return True
        return str(data.get("content", "") or "").startswith("【用户上传的附件文档：")

    @staticmethod
    def _append_stream_batch(
        messages: list[dict[str, Any]],
        active_subagents: dict[str, int],
        event: MessageEventRecord,
        data: dict[str, Any],
        timestamp: int,
    ) -> None:
        content = str(data.get("content") or "")
        subagent_id = str(data.get("subagent_id") or "")
        if data.get("is_subagent") and subagent_id in active_subagents:
            messages[active_subagents[subagent_id]]["content"] += content
            return
        if (
            messages
            and messages[-1].get("role") == "assistant"
            and not messages[-1].get("cancelled")
            and messages[-1].get("status") != "cancelled"
            and messages[-1].get("turnIndex") == event.turn_index
        ):
            messages[-1]["content"] += content
            messages[-1]["messageEventId"] = event.id
            messages[-1]["turnIndex"] = event.turn_index
            MessageEventService._apply_thread_task_metadata(messages[-1], data)
            return
        message = {
            "role": "assistant",
            "content": content,
            "timestamp": timestamp,
            "messageEventId": event.id,
            "turnIndex": event.turn_index,
        }
        MessageEventService._apply_thread_task_metadata(message, data)
        messages.append(message)

    @staticmethod
    def _append_tool_start(
        messages: list[dict[str, Any]],
        active_subagents: dict[str, int],
        tool_run_map: dict[str, tuple[int, int | None]],
        event: MessageEventRecord,
        data: dict[str, Any],
        timestamp: int,
        *,
        include_tool_details: bool,
    ) -> None:
        run_id = str(data.get("run_id") or "")
        tool_call_id = str(data.get("tool_call_id") or "")
        tool_name = data.get("tool", data.get("tool_name", ""))
        detail_ref = {
            "startEventId": event.id,
            "endEventId": None,
            "runId": run_id,
            "toolCallId": tool_call_id,
        }
        tool_call = {
            "id": f"tool:{event.id}",
            "messageEventId": event.id,
            "toolName": tool_name,
            "runId": run_id,
            "status": "running",
            "timestamp": timestamp,
            "toolCallId": tool_call_id or None,
            "toolDetailRef": detail_ref,
            "toolSummary": MessageEventService._tool_start_summary(data),
        }
        metadata = MessageEventService._tool_metadata(data)
        if metadata:
            tool_call["metadata"] = metadata
        if include_tool_details:
            tool_call["toolParams"] = data.get("params")
        else:
            summary_params = MessageEventService._tool_params_summary(data)
            if summary_params:
                tool_call["toolParams"] = summary_params
            tool_call["toolDetailsDeferred"] = True
        start_ui_payload = MessageEventService._tool_web_activity_summary(
            MessageEventService._tool_ui_payload(data)
        )
        if start_ui_payload:
            tool_call["uiPayload"] = start_ui_payload
        subagent_id = str(data.get("subagent_id") or "")
        if data.get("is_subagent") and subagent_id in active_subagents:
            msg_idx = active_subagents[subagent_id]
            messages[msg_idx].setdefault("subagentToolCalls", [])
            tool_idx = len(messages[msg_idx]["subagentToolCalls"])
            messages[msg_idx]["subagentToolCalls"].append(tool_call)
            tool_run_map[run_id] = (msg_idx, tool_idx)
            return
        messages.append({"role": "tool", "content": "", **tool_call})
        tool_run_map[run_id] = (len(messages) - 1, None)

    @staticmethod
    def _apply_tool_end(
        messages: list[dict[str, Any]],
        tool_run_map: dict[str, tuple[int, int | None]],
        event: MessageEventRecord,
        data: dict[str, Any],
        *,
        include_tool_details: bool,
    ) -> None:
        run_id = str(data.get("run_id") or "")
        if run_id not in tool_run_map:
            return
        msg_idx, tool_idx = tool_run_map[run_id]
        target = (
            messages[msg_idx]["subagentToolCalls"][tool_idx]
            if tool_idx is not None
            else messages[msg_idx]
        )
        detail_ref = target.setdefault("toolDetailRef", {})
        if isinstance(detail_ref, dict):
            detail_ref["endEventId"] = event.id
            detail_ref["runId"] = detail_ref.get("runId") or run_id
            detail_ref["toolCallId"] = detail_ref.get("toolCallId") or data.get("tool_call_id")
        MessageEventService._apply_tool_payload_to_message(
            target,
            data,
            include_tool_details=include_tool_details,
        )

    @staticmethod
    def _apply_tool_payload_to_message(
        target: dict[str, Any],
        data: dict[str, Any],
        *,
        include_tool_details: bool = True,
    ) -> None:
        target["toolDurationMs"] = data.get("duration_ms")
        ui_payload = MessageEventService._tool_ui_payload(data)
        tool_name = str(target.get("toolName") or data.get("tool") or data.get("tool_name") or "")
        if tool_name in {"web_search", "web_fetch"}:
            ui_payload = MessageEventService._tool_web_activity_summary(ui_payload)
        error = MessageEventService._tool_error_summary(data, ui_payload)
        structured_error = MessageEventService._tool_error_envelope(data)
        web_status = str(ui_payload.get("status") or "") if ui_payload else ""
        target["status"] = (
            "cancelled"
            if web_status == "cancelled"
            else "error"
            if error or web_status == "failed"
            else "completed"
        )
        metadata = MessageEventService._tool_metadata(data)
        if metadata:
            target["metadata"] = MessageEventService._merge_metadata(
                target.get("metadata"),
                metadata,
            )
        if error:
            target["toolError"] = error
        if structured_error:
            target["error"] = structured_error
        if include_tool_details:
            target["toolResult"] = data.get("result", "")
            if ui_payload:
                target["uiPayload"] = ui_payload
            files = MessageEventService._tool_files(data, ui_payload)
            if files:
                target["fileChanges"] = files
            return

        target["toolDetailsDeferred"] = True
        if tool_name == "update_plan" and ui_payload:
            target["uiPayload"] = MessageEventService._tool_plan_summary(ui_payload)
        elif tool_name == "load_skill" and ui_payload:
            target["uiPayload"] = MessageEventService._tool_skill_summary(ui_payload)
        elif tool_name in {"update_thread_task", "get_thread_task"} and ui_payload:
            target["uiPayload"] = MessageEventService._tool_thread_task_summary(ui_payload)
        elif tool_name in {"run_git_bash", "run_cmd", "run_powershell"} and ui_payload:
            command_summary = MessageEventService._tool_command_summary(ui_payload)
            if command_summary:
                target["uiPayload"] = command_summary
        elif tool_name in {"web_search", "web_fetch"} and ui_payload:
            target["uiPayload"] = ui_payload
        files = MessageEventService._tool_file_summaries(
            MessageEventService._tool_files(data, ui_payload)
        )
        if files:
            target["fileChanges"] = files

    @staticmethod
    def _append_or_update_approval(
        messages: list[dict[str, Any]],
        approval_message_map: dict[str, int],
        data: dict[str, Any],
        timestamp: int,
    ) -> None:
        approval = data.get("approval")
        if not isinstance(approval, dict):
            return
        approval_id = str(approval.get("id") or "")
        if not approval_id:
            return
        content = MessageEventService._approval_content(approval)
        message = {
            "role": "approval",
            "content": content,
            "approval": approval,
            "status": approval.get("status", "pending"),
            "timestamp": timestamp,
        }
        idx = approval_message_map.get(approval_id)
        if idx is None:
            for index, item in enumerate(messages):
                item_approval = item.get("approval")
                if isinstance(item_approval, dict) and item_approval.get("id") == approval_id:
                    idx = index
                    break
        if idx is None:
            approval_message_map[approval_id] = len(messages)
            messages.append(message)
            return
        approval_message_map[approval_id] = idx
        messages[idx].update(message)

    @staticmethod
    def _approval_content(approval: dict[str, Any]) -> str:
        status = str(approval.get("status") or "pending")
        details = approval.get("details") if isinstance(approval.get("details"), dict) else {}
        command = str(details.get("command") or "").strip()
        if status == "approved":
            prefix = "已允许执行命令"
        elif status == "rejected":
            prefix = "已拒绝执行命令"
        elif status == "cancelled":
            prefix = "已取消命令审批"
        elif status == "expired":
            prefix = "命令审批已超时"
        else:
            prefix = str(approval.get("title") or "等待确认命令执行")
        return f"{prefix}: {command}" if command else prefix

    @staticmethod
    def _tool_ui_payload(data: dict[str, Any]) -> dict[str, Any] | None:
        direct = data.get("ui_payload")
        if isinstance(direct, dict):
            return direct
        output_data = data.get("output_data")
        if isinstance(output_data, dict) and isinstance(output_data.get("result"), dict):
            return output_data["result"]
        result = data.get("result")
        if isinstance(result, dict):
            return result
        if isinstance(result, str):
            try:
                parsed = json.loads(result)
            except json.JSONDecodeError:
                return None
            return parsed if isinstance(parsed, dict) else None
        return None

    @staticmethod
    def _tool_web_activity_summary(
        ui_payload: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not isinstance(ui_payload, dict):
            return None
        if ui_payload.get("kind") != "web_activity":
            return None
        try:
            payload = WebActivityPayload.model_validate(ui_payload)
        except ValidationError:
            return None
        return payload.model_dump(mode="json")

    @staticmethod
    def _tool_metadata(data: dict[str, Any]) -> dict[str, Any] | None:
        existing = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        metadata = dict(existing)
        existing_mcp = existing.get("mcp") if isinstance(existing.get("mcp"), dict) else {}
        mcp_fields = {
            key: data.get(key)
            for key in (
                "kind",
                "snapshot_id",
                "server_id",
                "server_name",
                "raw_tool_name",
                "model_tool_name",
                "model_name",
                "approval_mode",
                "exposure",
                "call_id",
            )
            if data.get(key) is not None
        }
        mcp = {**existing_mcp, **mcp_fields}
        if mcp.get("kind") == "mcp_tool" or (
            mcp.get("server_id") and mcp.get("raw_tool_name") and mcp.get("model_tool_name")
        ):
            mcp.setdefault("kind", "mcp_tool")
            metadata["mcp"] = mcp
        return metadata or None

    @staticmethod
    def _merge_metadata(existing: Any, incoming: dict[str, Any]) -> dict[str, Any]:
        base = dict(existing) if isinstance(existing, dict) else {}
        merged = {**base, **incoming}
        base_mcp = base.get("mcp") if isinstance(base.get("mcp"), dict) else {}
        incoming_mcp = incoming.get("mcp") if isinstance(incoming.get("mcp"), dict) else {}
        if base_mcp or incoming_mcp:
            merged["mcp"] = {**base_mcp, **incoming_mcp}
        return merged

    @staticmethod
    def _tool_files(
        data: dict[str, Any],
        ui_payload: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        source = data.get("files")
        if not isinstance(source, list) and ui_payload:
            source = ui_payload.get("files") or ui_payload.get("changes")
        if not isinstance(source, list):
            return []
        files: list[dict[str, Any]] = []
        for item in source:
            if not isinstance(item, dict):
                continue
            files.append(MessageEventService._normalize_file_change(item))
        return files

    @staticmethod
    def _tool_file_summaries(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        summaries: list[dict[str, Any]] = []
        for file in files:
            summary: dict[str, Any] = {}
            for key in (
                "path",
                "operation",
                "change_type",
                "added_lines",
                "deleted_lines",
                "removed_lines",
                "additions",
                "deletions",
                "old_path",
                "new_path",
                "diff",
                "applied",
                "rejected",
            ):
                if file.get(key) is not None:
                    summary[key] = file.get(key)
            if summary:
                summaries.append(summary)
        return summaries

    @staticmethod
    def _tool_start_summary(data: dict[str, Any]) -> dict[str, Any]:
        params = MessageEventService._params_record(data)
        tool_name = str(data.get("tool") or data.get("tool_name") or "")
        target = _tool_target(params)
        summary: dict[str, Any] = {}
        if target:
            summary["target"] = target
        summary_keys = (
            "path",
            "file",
            "query",
            "pattern",
            "command",
            "cwd",
            "skill_name",
            "skillName",
            "resource_path",
            "resourcePath",
        )
        if tool_name == "load_skill":
            summary_keys += ("source",)
        if tool_name == "delegate_subagent":
            summary_keys += ("type",)
        for key in summary_keys:
            value = params.get(key)
            if isinstance(value, str) and value.strip():
                summary[key] = value
        if tool_name == "delegate_subagent" and isinstance(params.get("task"), str):
            summary["task"] = _preview_text(params["task"], limit=512)
        for key in ("timeout_seconds", "timeoutSeconds", "regex"):
            value = params.get(key)
            if isinstance(value, bool | int | float | str):
                summary[key] = value
        return summary

    @staticmethod
    def _tool_params_summary(data: dict[str, Any]) -> dict[str, Any]:
        params = MessageEventService._params_record(data)
        tool_name = str(data.get("tool") or data.get("tool_name") or "")
        if tool_name == "update_thread_task":
            return MessageEventService._tool_thread_task_params_summary(params)
        summary: dict[str, Any] = {}
        summary_keys = (
            "path",
            "file",
            "query",
            "pattern",
            "command",
            "cwd",
            "skill_name",
            "skillName",
            "resource_path",
            "resourcePath",
            "timeout_seconds",
            "timeoutSeconds",
            "regex",
        )
        if tool_name == "load_skill":
            summary_keys += ("source",)
        if tool_name == "delegate_subagent":
            summary_keys += ("type",)
        for key in summary_keys:
            if key in params and _is_summary_value(params[key]):
                summary[key] = params[key]
        if tool_name == "delegate_subagent" and isinstance(params.get("task"), str):
            summary["task"] = _preview_text(params["task"], limit=512)
        target = _tool_target(params)
        has_explicit_target = any(
            key in summary for key in ("path", "file", "command", "query", "pattern")
        )
        if target and not has_explicit_target:
            summary["path"] = target
        return summary

    @staticmethod
    def _params_record(data: dict[str, Any]) -> dict[str, Any]:
        params = data.get("params")
        if isinstance(params, dict):
            return params
        input_data = data.get("input_data")
        if isinstance(input_data, dict):
            args = input_data.get("args")
            if isinstance(args, dict):
                return args
            return input_data
        return {}

    @staticmethod
    def _tool_plan_summary(ui_payload: dict[str, Any]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        entries = ui_payload.get("entries")
        if isinstance(entries, list):
            summary["entries"] = entries
        explanation = ui_payload.get("explanation")
        if isinstance(explanation, str):
            summary["explanation"] = explanation
        return summary

    @staticmethod
    def _tool_skill_summary(ui_payload: dict[str, Any]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        for key in (
            "skill_name",
            "skillName",
            "resource_path",
            "resourcePath",
            "entry_file",
            "entryFile",
            "locator",
            "skill_root",
            "skillRoot",
            "source",
            "loaded",
            "injected",
            "message",
        ):
            value = ui_payload.get(key)
            if _is_summary_value(value):
                summary[key] = value
        metadata = ui_payload.get("metadata")
        if isinstance(metadata, dict):
            locator = metadata.get("locator")
            if isinstance(locator, str) and locator.strip():
                summary["metadata"] = {"locator": locator}
        return summary

    @staticmethod
    def _tool_thread_task_params_summary(params: dict[str, Any]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        for key in (
            "status",
            "summary",
            "reason",
            "blocked_reason",
            "checklist",
            "evidence",
            "attempts",
            "attempted_actions",
        ):
            value = params.get(key)
            if _is_summary_value(value) or isinstance(value, list):
                summary[key] = value
        return summary

    @staticmethod
    def _tool_thread_task_summary(ui_payload: dict[str, Any]) -> dict[str, Any]:
        task = ui_payload.get("task")
        if not isinstance(task, dict):
            return dict(ui_payload)
        summary_task: dict[str, Any] = {}
        for key in (
            "id",
            "type",
            "type_label",
            "objective",
            "status",
            "turn_count",
            "elapsed_seconds",
            "system_stop_reason",
        ):
            value = task.get(key)
            if _is_summary_value(value):
                summary_task[key] = value
        summary = dict(ui_payload)
        summary["task"] = summary_task
        return summary

    @staticmethod
    def _tool_command_summary(ui_payload: dict[str, Any]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        for key in (
            "command",
            "cwd",
            "status",
            "exit_code",
            "exitCode",
            "duration_ms",
            "durationMs",
            "timed_out",
            "timedOut",
            "truncated",
            "output_truncated",
            "output_bytes",
            "output_path",
            "timeout_seconds",
            "timeoutSeconds",
        ):
            value = ui_payload.get(key)
            if _is_summary_value(value):
                summary[key] = value

        approval = ui_payload.get("approval")
        if isinstance(approval, dict):
            approval_summary: dict[str, Any] = {}
            for key in ("trusted_rule_id", "reject_message", "decision", "status"):
                value = approval.get(key)
                if _is_summary_value(value):
                    approval_summary[key] = value
            if approval_summary:
                summary["approval"] = approval_summary

        error_text = MessageEventService._command_preview_error(ui_payload)
        if error_text:
            summary["stderr"] = error_text

        execution_error = ui_payload.get("execution_error")
        if isinstance(execution_error, dict):
            execution_summary: dict[str, Any] = {}
            for key in ("type", "message"):
                value = execution_error.get(key)
                if _is_summary_value(value):
                    execution_summary[key] = value
            if execution_summary:
                summary["execution_error"] = execution_summary

        tool_summary = ui_payload.get("tool_summary")
        if isinstance(tool_summary, str) and tool_summary.strip():
            summary["tool_summary"] = _preview_text(tool_summary)

        return summary

    @staticmethod
    def _command_preview_error(ui_payload: dict[str, Any]) -> str:
        status = str(ui_payload.get("status") or "").strip()
        exit_code = ui_payload.get("exit_code", ui_payload.get("exitCode"))
        failed_status = status in {
            "failed",
            "error",
            "timed_out",
            "disabled",
            "rejected",
            "shell_not_available",
            "failed_to_start",
            "output_limit_exceeded",
        }
        failed_exit = (
            isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code != 0
        )
        if not failed_status and not failed_exit:
            return ""

        stderr = str(ui_payload.get("stderr") or "").strip()
        if stderr:
            return _preview_text(stderr)

        execution_error = ui_payload.get("execution_error")
        if isinstance(execution_error, dict):
            error_type = str(execution_error.get("type") or "").strip()
            message = str(execution_error.get("message") or "").strip()
            text = ": ".join(part for part in (error_type, message) if part)
            if text:
                return _preview_text(text)

        if failed_exit:
            return f"命令退出码 {exit_code}"
        if status == "timed_out":
            return "命令执行超时"
        if status == "disabled":
            return "命令行工具已禁用"
        if status == "rejected":
            approval = ui_payload.get("approval")
            if isinstance(approval, dict):
                reject_message = str(approval.get("reject_message") or "").strip()
                if reject_message:
                    return _preview_text(reject_message)
            return "命令审批已拒绝"
        if status == "shell_not_available":
            return "命令执行环境不可用"
        if status == "output_limit_exceeded":
            return "命令输出超过上限"
        return "命令执行失败"

    def _load_tool_event(
        self,
        session_id: str,
        event_id: str | None,
        *,
        expected_action: str,
    ) -> MessageEventRecord | None:
        if not event_id:
            return None
        event = self._repository.get(event_id)
        if event is None or event.session_id != session_id:
            return None
        if self._canonical_action(event) != expected_action:
            return None
        return event

    @staticmethod
    def _tool_detail_from_events(
        start_event: MessageEventRecord | None,
        end_event: MessageEventRecord | None,
    ) -> dict[str, Any]:
        start_data = MessageEventService._visible_data(start_event) if start_event else {}
        end_data = MessageEventService._visible_data(end_event) if end_event else {}
        data = {**start_data, **end_data}
        ui_payload = MessageEventService._tool_ui_payload(end_data)
        tool_name = str(data.get("tool") or data.get("tool_name") or "")
        if tool_name in {"web_search", "web_fetch"}:
            ui_payload = MessageEventService._tool_web_activity_summary(ui_payload)
        files = MessageEventService._tool_files(end_data, ui_payload)
        error = MessageEventService._tool_error_summary(end_data, ui_payload)
        structured_error = MessageEventService._tool_error_envelope(end_data)
        detail_ref = {
            "startEventId": start_event.id if start_event else None,
            "endEventId": end_event.id if end_event else None,
            "runId": data.get("run_id"),
            "toolCallId": data.get("tool_call_id"),
        }
        status = end_data.get("status") or start_data.get("status") or "completed"
        if not end_event and status == "completed":
            status = "running"
        detail: dict[str, Any] = {
            "detailRef": detail_ref,
            "runId": data.get("run_id"),
            "toolCallId": data.get("tool_call_id"),
            "toolName": tool_name,
            "toolParams": start_data.get("params", start_data.get("input_data")),
            "toolResult": end_data.get("result", ""),
            "toolDurationMs": end_data.get("duration_ms"),
            "toolError": error or None,
            "error": structured_error,
            "toolErrorType": end_data.get("error_type"),
            "status": (
                "cancelled"
                if ui_payload and ui_payload.get("status") == "cancelled"
                else "error"
                if error or (ui_payload and ui_payload.get("status") == "failed")
                else status
            ),
            "uiPayload": ui_payload,
            "fileChanges": files,
            "metadata": MessageEventService._tool_metadata(data),
        }
        return {key: value for key, value in detail.items() if value is not None}

    @staticmethod
    def _tool_error_envelope(data: dict[str, Any]) -> dict[str, Any] | None:
        value = data.get("error")
        if value is None:
            return None
        return normalize_error_envelope(
            value,
            fallback_code="tool_execution_failed",
            fallback_message="工具执行失败",
        ).to_public_dict()

    @staticmethod
    def _normalize_file_change(item: dict[str, Any]) -> dict[str, Any]:
        added = int(item.get("added_lines") or item.get("additions") or 0)
        deleted = int(
            item.get("deleted_lines") or item.get("removed_lines") or item.get("deletions") or 0
        )
        return {
            **item,
            "added_lines": max(0, added),
            "deleted_lines": max(0, deleted),
            "removed_lines": max(0, deleted),
            "additions": max(0, added),
            "deletions": max(0, deleted),
        }

    @staticmethod
    def _tool_result_error(result: Any) -> str:
        if isinstance(result, dict):
            return MessageEventService._tool_error_message(result)
        if not isinstance(result, str):
            return ""
        try:
            parsed = json.loads(result)
        except json.JSONDecodeError:
            return ""
        if not isinstance(parsed, dict):
            return ""
        return MessageEventService._tool_error_message(parsed)

    @staticmethod
    def _tool_error_message(payload: dict[str, Any]) -> str:
        code = payload.get("code")
        message = payload.get("message")
        if isinstance(code, str) and code.strip() and isinstance(message, str):
            if message.strip():
                return message
            details = payload.get("details")
            if isinstance(details, dict) and details:
                return json.dumps(details, ensure_ascii=False)
        return ""

    @staticmethod
    def _tool_error_summary(
        data: dict[str, Any],
        ui_payload: dict[str, Any] | None,
    ) -> str:
        for value in (data.get("error"), data.get("message")):
            error = MessageEventService._tool_error_text(value, allow_plain_text=True)
            if error:
                return _preview_text(error)
        for value in (ui_payload, data.get("result")):
            error = MessageEventService._tool_error_text(value, allow_plain_text=False)
            if error:
                return _preview_text(error)
        return ""

    @staticmethod
    def _tool_error_text(value: Any, *, allow_plain_text: bool) -> str:
        if isinstance(value, dict):
            message = MessageEventService._tool_error_message(value)
            if message:
                return message
            nested = value.get("error")
            if nested is not value:
                return MessageEventService._tool_error_text(
                    nested,
                    allow_plain_text=allow_plain_text,
                )
            return ""
        if not isinstance(value, str):
            return ""
        stripped = value.strip()
        if not stripped:
            return ""
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return stripped if allow_plain_text else ""
        parsed_error = MessageEventService._tool_error_text(
            parsed,
            allow_plain_text=allow_plain_text,
        )
        if parsed_error:
            return parsed_error
        return stripped if allow_plain_text else ""

    @staticmethod
    def _append_cancelled_marker(
        messages: list[dict[str, Any]],
        data: dict[str, Any],
        timestamp: int,
    ) -> None:
        for message in messages:
            if message.get("role") == "tool" and message.get("status") == "running":
                message["status"] = "cancelled"
            for tool in message.get("subagentToolCalls", []) or []:
                if tool.get("status") == "running":
                    tool["status"] = "cancelled"

        if messages and messages[-1].get("role") == "assistant" and messages[-1].get("cancelled"):
            return

        marker: dict[str, Any] = {
            "role": "assistant",
            "content": "",
            "timestamp": timestamp,
            "status": "cancelled",
            "cancelled": True,
        }
        trace_id = str(data.get("trace_id") or "").strip()
        if trace_id:
            marker["traceId"] = trace_id
        messages.append(marker)

    @staticmethod
    def _extract_ghost_footer(data: dict[str, Any]) -> dict[str, Any]:
        ghost_footer = data.get("ghost_footer")
        return ghost_footer if isinstance(ghost_footer, dict) else data

    @staticmethod
    def _apply_ghost_footer_to_latest_assistant(
        messages: list[dict[str, Any]],
        data: dict[str, Any],
    ) -> None:
        ghost_footer = MessageEventService._extract_ghost_footer(data)
        if not ghost_footer:
            return
        for message in reversed(messages):
            if (
                message.get("role") != "assistant"
                or message.get("cancelled")
                or message.get("status") == "cancelled"
            ):
                continue
            trace_id = str(ghost_footer.get("trace_id") or "").strip()
            latest_usage = ghost_footer.get("latest_llm_token_usage") or {}
            chain_usage = ghost_footer.get("chain_token_usage") or {}
            token_usage = latest_usage or chain_usage
            if trace_id or token_usage:
                message["ghostStats"] = {
                    "traceId": trace_id or "-",
                    "inputTokens": token_usage.get("input_tokens", 0) or 0,
                    "cacheReadTokens": token_usage.get("cache_read_tokens", 0) or 0,
                    "outputTokens": token_usage.get("output_tokens", 0) or 0,
                }
            trace_query_context = ghost_footer.get("trace_query_context") or {}
            if trace_query_context:
                message["traceQueryContext"] = trace_query_context
            if trace_id:
                message["traceId"] = trace_id
            MessageEventService._apply_thread_task_metadata(message, data)
            return

    @staticmethod
    def _apply_turn_duration_to_latest_assistant(
        messages: list[dict[str, Any]],
        *,
        terminal_timestamp: int,
        turn_index: int | None,
        data: dict[str, Any],
    ) -> None:
        boundary_index = -1
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if message.get("role") not in {"user", "turn"}:
                continue
            message_turn_index = message.get("turnIndex")
            if turn_index is None or message_turn_index in {None, turn_index}:
                boundary_index = index
                break

        turn_output_messages: list[dict[str, Any]] = []
        for message in messages[boundary_index + 1 :]:
            if (
                not _is_turn_output_message(message)
                or message.get("cancelled")
                or message.get("status") == "cancelled"
            ):
                continue
            message_turn_index = message.get("turnIndex")
            if turn_index is not None and message_turn_index not in {None, turn_index}:
                continue
            turn_output_messages.append(message)

        assistant_messages = [
            message
            for message in turn_output_messages
            if message.get("role") == "assistant"
            and str(message.get("content") or "").strip()
        ]
        if not turn_output_messages or not assistant_messages:
            return
        target = assistant_messages[-1]
        if _non_negative_duration_ms(target.get("turnDurationMs")) is not None:
            return
        explicit_duration = _non_negative_duration_ms(
            data.get("turnDurationMs", data.get("turn_duration_ms"))
        )
        if explicit_duration is None:
            started_at = _non_negative_duration_ms(data.get("first_token_at_ms"))
            if started_at is None:
                started_at = _non_negative_duration_ms(turn_output_messages[0].get("timestamp"))
            if started_at is None or terminal_timestamp < started_at:
                return
            explicit_duration = terminal_timestamp - started_at
        target["turnDurationMs"] = explicit_duration

    @staticmethod
    def _apply_thread_task_metadata(
        message: dict[str, Any],
        data: dict[str, Any],
    ) -> None:
        thread_task = data.get("thread_task") or data.get("threadTask")
        if not isinstance(thread_task, dict):
            return
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        runtime_params = metadata.get("runtime_params")
        if not isinstance(runtime_params, dict):
            runtime_params = {}
        metadata = {
            **metadata,
            "thread_task": dict(thread_task),
            "runtime_params": {
                **runtime_params,
                "thread_task": dict(thread_task),
            },
        }
        message["metadata"] = metadata

    @staticmethod
    def _event_timestamp_ms(event: MessageEventRecord) -> int:
        data_timestamp = MessageEventService._coerce_timestamp_ms(
            event.data.get("messageTimeMs")
            or event.data.get("timestamp_ms")
            or event.data.get("timestamp")
        )
        if data_timestamp is not None:
            return data_timestamp
        try:
            return int(
                datetime.fromisoformat(event.created_at.replace("Z", "+00:00")).timestamp() * 1000
            )
        except ValueError:
            return 0

    @staticmethod
    def _coerce_timestamp_ms(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int | float) and value > 1_000_000_000_000:
            return int(value)
        return None


def _non_negative_duration_ms(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        return None
    return int(value)


def _is_turn_output_message(message: dict[str, Any]) -> bool:
    role = message.get("role")
    if role in {"assistant", "reasoning"}:
        return bool(str(message.get("content") or "").strip())
    return role in {"tool", "subagent", "a2ui"}


def _role_from_replay_action(action: str) -> str:
    if action == ReplayAction.SYSTEM_MESSAGE.value:
        return "SystemMessage"
    if action == ReplayAction.AI_MESSAGE.value:
        return "AIMessage"
    return "HumanMessage"


def _is_visible_llm_retry_progress(data: dict[str, Any]) -> bool:
    if data.get("middleware") != "LLMRetry" and data.get("kind") != "llm_retry":
        return False
    return str(data.get("stage") or "") in {"retrying", "recovered", "completed", "failed"}


def _llm_retry_progress_content(data: dict[str, Any]) -> str:
    stage = str(data.get("stage") or "")
    retry_index = _positive_int(data.get("retry_index"), default=1)
    max_retries = _positive_int(data.get("max_retries"), default=3)
    if stage in {"recovered", "completed"}:
        return "LLM 请求重试成功"
    if stage == "failed":
        return f"LLM 请求重试失败 {retry_index}/{max_retries}"
    return f"LLM 请求正在重试 {retry_index}/{max_retries}"


def _llm_retry_status(data: dict[str, Any]) -> str:
    stage = str(data.get("stage") or "")
    if stage == "failed":
        return "failed"
    if stage in {"recovered", "completed"}:
        return "completed"
    return "running"


def _llm_retry_metadata(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "llm_retry",
        "stage": str(data.get("stage") or ""),
        "notice_id": _llm_retry_notice_id_from_data(data),
        "attempt": data.get("attempt"),
        "retry_index": _positive_int(data.get("retry_index"), default=1),
        "max_retries": _positive_int(data.get("max_retries"), default=3),
        "max_attempts": data.get("max_attempts"),
        "retry_after_ms": data.get("retry_after_ms"),
        "gateway_trace_id": data.get("gateway_trace_id"),
        "error": data.get("error"),
        "error_type": data.get("error_type"),
    }


def _llm_retry_notice_id_from_data(data: dict[str, Any]) -> str:
    notice_id = str(data.get("notice_id") or "").strip()
    if notice_id:
        return notice_id
    fallback_id = (
        data.get("trace_id")
        or data.get("session_id")
        or data.get("active_session_id")
        or ""
    )
    return f"llm-retry:{fallback_id}"


def _positive_int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int) and value > 0:
        return value
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _is_visible_context_compression_progress(data: dict[str, Any]) -> bool:
    if data.get("middleware") != "ContextCompressionMiddleware":
        return False
    stage = str(data.get("stage") or "")
    return stage in {"compression_started", "compression_completed", "compression_failed"}


def _context_compression_progress_content(data: dict[str, Any]) -> str:
    stage = str(data.get("stage") or "")
    if stage == "compression_started":
        return "正在压缩上下文"
    if stage == "compression_completed":
        return "上下文压缩已完成"
    if stage == "compression_failed":
        return "上下文压缩失败"
    return "上下文压缩已完成"


def _context_compression_status(data: dict[str, Any]) -> str:
    stage = str(data.get("stage") or "")
    if stage == "compression_started":
        return "running"
    if stage == "compression_failed":
        return "failed"
    return "completed"


def _context_compression_metadata(data: dict[str, Any]) -> dict[str, Any]:
    stage = str(data.get("stage") or "")
    mode = str(data.get("compression_mode") or "context")
    return {
        "kind": "context_compression",
        "stage": stage,
        "mode": mode,
        "notice_id": _context_compression_notice_id_from_data(data),
        "reason": data.get("reason"),
        "compression_reason": data.get("compression_reason"),
    }


def _context_compression_notice_id_from_data(data: dict[str, Any]) -> str:
    notice_id = str(data.get("notice_id") or "").strip()
    if notice_id:
        return notice_id
    notice_key = (
        data.get("trace_id")
        or data.get("session_id")
        or data.get("active_session_id")
        or ""
    )
    return f"context-compression:{notice_key}"


def _default_context_label(item_type: str, content: str) -> str:
    if item_type == "file":
        return "文件"
    if item_type == "quote":
        return "引用片段"
    if item_type == "slot":
        return "会话上下文"
    cleaned = " ".join(content.split())
    return cleaned[:16] if cleaned else "上下文"


def _same_tool_call(start_data: dict[str, Any], end_data: dict[str, Any]) -> bool:
    start_run = str(start_data.get("run_id") or "")
    end_run = str(end_data.get("run_id") or "")
    if start_run and end_run and start_run != end_run:
        return False
    start_call = str(start_data.get("tool_call_id") or "")
    end_call = str(end_data.get("tool_call_id") or "")
    if start_call and end_call and start_call != end_call:
        return False
    return True


def _is_summary_value(value: Any) -> bool:
    if isinstance(value, bool | int | float):
        return True
    return isinstance(value, str) and len(value) <= 512


def _preview_text(value: Any, limit: int = _TOOL_PREVIEW_TEXT_LIMIT) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def _tool_target(params: dict[str, Any]) -> str:
    for key in ("path", "file", "query", "pattern", "command"):
        value = params.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("patch", "diff", "content"):
        value = params.get(key)
        if isinstance(value, str):
            target = _patch_file_target(value)
            if target:
                return target
    return ""


def _patch_file_target(value: str) -> str:
    if not value:
        return ""
    for raw_line in value.splitlines():
        line = raw_line.strip()
        for prefix in (
            "*** Add File:",
            "*** Update File:",
            "*** Delete File:",
        ):
            if line.startswith(prefix):
                return line[len(prefix) :].strip()
        for prefix in ("+++ b/", "--- a/"):
            if line.startswith(prefix):
                return line[len(prefix) :].strip()
    return ""
