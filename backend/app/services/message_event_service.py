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

        for event in events:
            action = self._canonical_action(event)
            data = self._visible_data(event)

            if action == ReplayAction.USER_MESSAGE.value:
                messages.append(
                    {
                        "role": "user",
                        "content": data.get("content", ""),
                        "attachments": data.get("attachments", []),
                        "timestamp": self._event_timestamp_ms(event),
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
                self._append_cancelled_suffix(messages)
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
                    target["toolResult"] = data.get("result", "")
                    target["toolDurationMs"] = data.get("duration_ms")
                    error = data.get("error") or MessageEventService._tool_result_error(
                        data.get("result")
                    )
                    target["status"] = "error" if error else "completed"
                    if error:
                        target["toolError"] = error
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
        if messages and messages[-1].get("role") == "assistant":
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
        target["toolDurationMs"] = data.get("duration_ms")
        error = data.get("error") or MessageEventService._tool_result_error(data.get("result"))
        target["status"] = "error" if error else "completed"
        if error:
            target["toolError"] = error

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
    def _append_cancelled_suffix(messages: list[dict[str, Any]]) -> None:
        for message in reversed(messages):
            if message.get("role") == "assistant":
                message["cancelled"] = True
                return

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
            if message.get("role") != "assistant":
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
