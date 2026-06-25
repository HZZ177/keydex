from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from backend.app.events.actions import CompletedEventItemAction, ReplayAction
from backend.app.storage import MessageEventRecord


class MessageEventService:
    def __init__(self, repository) -> None:
        self._repository = repository

    def get_display_messages(self, session_id: str) -> list[dict[str, Any]]:
        return self._aggregate_events(self._repository.list_by_session(session_id))

    def get_turn_messages(self, session_id: str, turn_index: int) -> list[dict[str, Any]]:
        return self._aggregate_events(self._repository.list_by_turn(session_id, turn_index))

    def _aggregate_events(self, events: list[MessageEventRecord]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        active_subagents: dict[str, int] = {}
        tool_run_map: dict[str, tuple[int, int | None]] = {}
        approval_message_map: dict[str, int] = {}
        pending_context_items: list[dict[str, Any]] = []

        for event in events:
            action = self._canonical_action(event)
            data = self._visible_data(event)

            if action in {
                ReplayAction.USER_MESSAGE.value,
                ReplayAction.SYSTEM_MESSAGE.value,
                ReplayAction.AI_MESSAGE.value,
            } and self._is_message_injection_event(event, data):
                pending_context_items.append(
                    self._context_item_from_injected_message(event, data, action)
                )
                continue

            if action == ReplayAction.USER_MESSAGE.value:
                message = {
                    "role": "user",
                    "content": data.get("content", ""),
                    "attachments": data.get("attachments", []),
                    "timestamp": self._event_timestamp_ms(event),
                }
                if pending_context_items:
                    message["contextItems"] = pending_context_items
                    pending_context_items = []
                messages.append(message)
                continue

            if action == ReplayAction.SYSTEM_MESSAGE.value:
                if self._is_hidden_internal_system_message(data):
                    continue
                messages.append(
                    {
                        "role": "system",
                        "content": data.get("content", ""),
                        "timestamp": self._event_timestamp_ms(event),
                    }
                )
                continue

            if action == ReplayAction.AI_MESSAGE.value:
                messages.append(
                    {
                        "role": "assistant",
                        "content": data.get("content", ""),
                        "timestamp": self._event_timestamp_ms(event),
                    }
                )
                continue

            if action == ReplayAction.STREAM_BATCH.value:
                self._append_stream_batch(
                    messages,
                    active_subagents,
                    data,
                    self._event_timestamp_ms(event),
                )
                continue

            if action == ReplayAction.TOOL_START.value:
                self._append_tool_start(
                    messages,
                    active_subagents,
                    tool_run_map,
                    data,
                    self._event_timestamp_ms(event),
                )
                continue

            if action == ReplayAction.TOOL_END.value:
                self._apply_tool_end(messages, tool_run_map, data)
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
                messages.append(
                    {
                        "role": "reasoning",
                        "content": str(data.get("text", data.get("content", "")) or ""),
                        "reasoningKind": data.get("kind", "reasoning"),
                        "timestamp": self._event_timestamp_ms(event),
                    }
                )
                continue

            if action == ReplayAction.COMPLETED.value:
                self._apply_ghost_footer_to_latest_assistant(messages, data)
                continue

            if action == ReplayAction.CANCELLED.value:
                self._append_cancelled_marker(messages, data, self._event_timestamp_ms(event))
                continue

            if action == ReplayAction.ERROR.value:
                messages.append(
                    {
                        "role": "error",
                        "content": data.get("message", data.get("error", "")),
                        "traceId": data.get("trace_id"),
                        "timestamp": self._event_timestamp_ms(event),
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
                messages.append(
                    {
                        "role": "reasoning",
                        "content": str(data.get("text", data.get("content", "")) or ""),
                        "reasoningKind": data.get("kind", "reasoning"),
                    }
                )

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
    def _context_item_from_injected_message(
        event: MessageEventRecord,
        data: dict[str, Any],
        action: str,
    ) -> dict[str, Any]:
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        item_type = str(
            metadata.get("kind")
            or metadata.get("type")
            or data.get("injectionSource")
            or "follow"
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
    def _is_hidden_internal_system_message(data: dict[str, Any]) -> bool:
        if data.get("internal") is True:
            return True
        return str(data.get("content", "") or "").startswith("【用户上传的附件文档：")

    @staticmethod
    def _append_stream_batch(
        messages: list[dict[str, Any]],
        active_subagents: dict[str, int],
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
        ):
            messages[-1]["content"] += content
            return
        messages.append({"role": "assistant", "content": content, "timestamp": timestamp})

    @staticmethod
    def _append_tool_start(
        messages: list[dict[str, Any]],
        active_subagents: dict[str, int],
        tool_run_map: dict[str, tuple[int, int | None]],
        data: dict[str, Any],
        timestamp: int,
    ) -> None:
        run_id = str(data.get("run_id") or "")
        tool_call = {
            "toolName": data.get("tool", data.get("tool_name", "")),
            "toolParams": data.get("params"),
            "runId": run_id,
            "status": "running",
            "timestamp": timestamp,
        }
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
        data: dict[str, Any],
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
        target["toolResult"] = data.get("result", "")
        MessageEventService._apply_tool_payload_to_message(target, data)

    @staticmethod
    def _apply_tool_payload_to_message(target: dict[str, Any], data: dict[str, Any]) -> None:
        target["toolResult"] = data.get("result", "")
        target["toolDurationMs"] = data.get("duration_ms")
        ui_payload = MessageEventService._tool_ui_payload(data)
        if ui_payload:
            target["uiPayload"] = ui_payload
        files = MessageEventService._tool_files(data, ui_payload)
        if files:
            target["fileChanges"] = files
        error = data.get("error") or MessageEventService._tool_result_error(data.get("result"))
        target["status"] = "error" if error else "completed"
        if error:
            target["toolError"] = error

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
    def _normalize_file_change(item: dict[str, Any]) -> dict[str, Any]:
        added = int(item.get("added_lines") or item.get("additions") or 0)
        deleted = int(
            item.get("deleted_lines")
            or item.get("removed_lines")
            or item.get("deletions")
            or 0
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
            return message
        return ""

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
            return

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
                datetime.fromisoformat(event.created_at.replace("Z", "+00:00")).timestamp()
                * 1000
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


def _role_from_replay_action(action: str) -> str:
    if action == ReplayAction.SYSTEM_MESSAGE.value:
        return "SystemMessage"
    if action == ReplayAction.AI_MESSAGE.value:
        return "AIMessage"
    return "HumanMessage"


def _default_context_label(item_type: str, content: str) -> str:
    if item_type == "file":
        return "文件"
    if item_type == "quote":
        return "引用片段"
    if item_type == "slot":
        return "会话上下文"
    cleaned = " ".join(content.split())
    return cleaned[:16] if cleaned else "上下文"
