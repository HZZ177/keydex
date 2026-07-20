from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, RemoveMessage, ToolMessage

from backend.app.agent.context_compression_utils import (
    is_context_compression_protocol_message,
    stringify_message_content,
)

TRUNCATED_TOOL_RESULT_METADATA_KEY = "keydex_truncated_tool_result_metadata"


@dataclass(frozen=True, slots=True)
class CompressionProtocolUnit:
    start_index: int
    end_index: int
    messages: tuple[BaseMessage, ...]
    message_ids: tuple[str, ...]
    approximate_tokens: int
    kind: str


@dataclass(frozen=True, slots=True)
class CompressionProtocolUnitsResult:
    units: tuple[CompressionProtocolUnit, ...]
    valid: bool = True
    failure_reason: str | None = None


def approximate_message_tokens(message: BaseMessage) -> int:
    content = stringify_message_content(getattr(message, "content", ""))
    structural = ""
    if isinstance(message, AIMessage):
        structural = str(getattr(message, "tool_calls", None) or "")
    return max((len(content) + len(structural) + 1) // 2 + 3, 1)


def build_protocol_safe_units(
    messages: list[BaseMessage],
) -> CompressionProtocolUnitsResult:
    """Build immutable cut units without ever orphaning a tool result."""

    units: list[CompressionProtocolUnit] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        if isinstance(message, RemoveMessage):
            index += 1
            continue

        if isinstance(message, ToolMessage):
            return CompressionProtocolUnitsResult(
                units=tuple(units),
                valid=False,
                failure_reason=f"orphan_tool_result:{getattr(message, 'tool_call_id', '')}",
            )

        if isinstance(message, AIMessage) and message.tool_calls:
            expected = {
                str(call.get("id") or "").strip()
                for call in message.tool_calls
                if str(call.get("id") or "").strip()
            }
            if not expected:
                return CompressionProtocolUnitsResult(
                    units=tuple(units),
                    valid=False,
                    failure_reason="tool_call_missing_id",
                )
            results: list[BaseMessage] = []
            found: set[str] = set()
            cursor = index + 1
            while cursor < len(messages) and isinstance(messages[cursor], ToolMessage):
                tool_message = messages[cursor]
                tool_call_id = str(getattr(tool_message, "tool_call_id", "") or "").strip()
                if tool_call_id not in expected or tool_call_id in found:
                    return CompressionProtocolUnitsResult(
                        units=tuple(units),
                        valid=False,
                        failure_reason=f"unexpected_tool_result:{tool_call_id}",
                    )
                found.add(tool_call_id)
                results.append(tool_message)
                cursor += 1
            missing = expected - found
            if missing:
                return CompressionProtocolUnitsResult(
                    units=tuple(units),
                    valid=False,
                    failure_reason=f"missing_tool_result:{','.join(sorted(missing))}",
                )
            units.append(_build_unit(index, cursor, [message, *results], "tool_exchange"))
            index = cursor
            continue

        kind = "compact_summary" if is_context_compression_protocol_message(message) else "message"
        units.append(_build_unit(index, index + 1, [message], kind))
        index += 1

    return CompressionProtocolUnitsResult(units=tuple(units))


def truncate_completed_tool_result(
    message: ToolMessage,
    *,
    max_tokens: int,
) -> ToolMessage:
    """Return a replacement-only copy; the transcript object is never mutated."""

    content = stringify_message_content(message.content)
    max_chars = max(max_tokens * 2, 80)
    if len(content) <= max_chars:
        return message.model_copy(deep=True)
    half = max((max_chars - 80) // 2, 20)
    shortened = (
        f"{content[:half]}\n\n...[压缩后近期现场已截断，原始工具结果保持不变]...\n\n"
        f"{content[-half:]}"
    )
    additional_kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
    recovery_metadata = _tool_result_recovery_metadata(message, content)
    if recovery_metadata:
        additional_kwargs[TRUNCATED_TOOL_RESULT_METADATA_KEY] = recovery_metadata
    return message.model_copy(
        update={"content": shortened, "additional_kwargs": additional_kwargs},
        deep=True,
    )


def _tool_result_recovery_metadata(
    message: ToolMessage,
    content: str,
) -> dict[str, Any] | None:
    if str(getattr(message, "name", "") or "") != "read_file":
        return None
    if str(getattr(message, "status", "") or "").casefold() == "error":
        return None
    try:
        payload = json.loads(content)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    nested = payload.get("result")
    if isinstance(nested, dict):
        payload = nested
    if (
        payload.get("ok") is False
        or str(payload.get("status") or "").casefold() == "failed"
        or isinstance(payload.get("error"), dict)
    ):
        return None
    fields = {
        key: payload.get(key)
        for key in ("path", "start_line", "returned_lines", "mode")
        if payload.get(key) is not None
    }
    return fields or None


def _build_unit(
    start_index: int,
    end_index: int,
    messages: list[BaseMessage],
    kind: str,
) -> CompressionProtocolUnit:
    return CompressionProtocolUnit(
        start_index=start_index,
        end_index=end_index,
        messages=tuple(messages),
        message_ids=tuple(
            str(getattr(message, "id", "") or f"index:{start_index + offset}")
            for offset, message in enumerate(messages)
        ),
        approximate_tokens=sum(approximate_message_tokens(message) for message in messages),
        kind=kind,
    )
