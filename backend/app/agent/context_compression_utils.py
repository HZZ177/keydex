"""上下文压缩的纯逻辑工具。

这里只处理消息协议、L1/L2 槽位识别、按轮次切分、工具调用边界保护和锚点替换；
不访问数据库，也不调用模型，便于和基座保持一致并单独测试。
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

CONTEXT_COMPRESSION_CONNECTION_PROMPT = (
    "以下为框架维护的历史上下文压缩区。"
    "请将其视为早期对话的结构化工作日志，并优先结合后续保留的原始消息继续推理。"
)

CONTEXT_COMPRESSION_L1_TAG = "context_compression:l1"
CONTEXT_COMPRESSION_L2_TAG = "context_compression:l2"
TOOL_RESULT_PREVIEW_MAX_CHARS = 500
TOOL_RESULT_PREVIEW_MAX_LINES = 12


@dataclass(slots=True)
class CompressionSlotState:
    existing_l1: SystemMessage | None
    existing_l2: SystemMessage | None


@dataclass(slots=True)
class MessageSplitResult:
    compression_zone: list[BaseMessage]
    retain_zone: list[BaseMessage]


@dataclass(slots=True)
class AnchorReplaceResult:
    anchor_message_id: str | None
    replaced_messages: list[BaseMessage]
    applied: bool


@dataclass(slots=True)
class CompressionStateSnapshot:
    prefix_messages: list[BaseMessage]
    raw_messages: list[BaseMessage]
    slots: CompressionSlotState


CompressionPhase = Literal["initial", "second", "steady"]


@dataclass(slots=True)
class CompressionMaterial:
    phase: CompressionPhase
    existing_l1_message: SystemMessage | None
    existing_l2_message: SystemMessage | None
    existing_l1_content: str | None
    existing_l2_content: str | None
    compression_zone_messages: list[BaseMessage]
    retain_zone_messages: list[BaseMessage]
    anchor_message_id: str | None
    trace_id: str | None = None
    trace_record_id: str | None = None
    original_session_id: str | None = None
    active_session_id: str | None = None
    scene_id: str | None = None
    scene_version_seq: int | None = None
    side_event_metadata: dict[str, Any] | None = None


def _message_id(message: BaseMessage) -> str | None:
    return getattr(message, "id", None)


def _extract_tagged_content(content: str, level_tag: str) -> str | None:
    prefix = f"<{level_tag}>\n"
    suffix = f"\n</{level_tag}>"
    if content.startswith(prefix) and content.endswith(suffix):
        return content[len(prefix) : -len(suffix)]
    return None


def _build_compression_message(level_tag: str, content: str) -> SystemMessage:
    return SystemMessage(content=f"<{level_tag}>\n{content}\n</{level_tag}>")


def build_l1_compression_message(content: str) -> SystemMessage:
    return _build_compression_message(CONTEXT_COMPRESSION_L1_TAG, content)


def build_l2_compression_message(content: str) -> SystemMessage:
    return _build_compression_message(CONTEXT_COMPRESSION_L2_TAG, content)


def build_compression_context_messages(
    *,
    l1_content: str,
    l2_content: str | None = None,
) -> list[SystemMessage]:
    messages: list[SystemMessage] = [SystemMessage(content=CONTEXT_COMPRESSION_CONNECTION_PROMPT)]
    if l2_content:
        messages.append(build_l2_compression_message(l2_content))
    messages.append(build_l1_compression_message(l1_content))
    return messages


def is_l1_compression_message(message: BaseMessage) -> bool:
    return isinstance(message, SystemMessage) and f"<{CONTEXT_COMPRESSION_L1_TAG}>" in str(
        message.content
    )


def is_l2_compression_message(message: BaseMessage) -> bool:
    return isinstance(message, SystemMessage) and f"<{CONTEXT_COMPRESSION_L2_TAG}>" in str(
        message.content
    )


def extract_l1_compression_content(message: BaseMessage) -> str | None:
    if not is_l1_compression_message(message):
        return None
    return _extract_tagged_content(str(message.content), CONTEXT_COMPRESSION_L1_TAG)


def extract_l2_compression_content(message: BaseMessage) -> str | None:
    if not is_l2_compression_message(message):
        return None
    return _extract_tagged_content(str(message.content), CONTEXT_COMPRESSION_L2_TAG)


def detect_existing_compression_slots(messages: Iterable[BaseMessage]) -> CompressionSlotState:
    existing_l1: SystemMessage | None = None
    existing_l2: SystemMessage | None = None
    for message in messages:
        if is_l2_compression_message(message):
            existing_l2 = message
        elif is_l1_compression_message(message):
            existing_l1 = message
    return CompressionSlotState(existing_l1=existing_l1, existing_l2=existing_l2)


def split_compression_prefix(messages: Iterable[BaseMessage]) -> CompressionStateSnapshot:
    prefix_messages: list[BaseMessage] = []
    raw_messages: list[BaseMessage] = []
    prefix_locked = False

    for message in messages:
        is_protocol_message = isinstance(message, SystemMessage) and (
            str(message.content) == CONTEXT_COMPRESSION_CONNECTION_PROMPT
            or is_l1_compression_message(message)
            or is_l2_compression_message(message)
        )
        if not prefix_locked and is_protocol_message:
            prefix_messages.append(message)
            continue
        prefix_locked = True
        raw_messages.append(message)

    return CompressionStateSnapshot(
        prefix_messages=prefix_messages,
        raw_messages=raw_messages,
        slots=detect_existing_compression_slots(prefix_messages),
    )


def adjust_split_index_for_tool_boundary(messages: list[BaseMessage], split_index: int) -> int:
    if split_index <= 0 or split_index >= len(messages):
        return split_index

    left = messages[split_index - 1]
    right = messages[split_index]
    if (
        isinstance(left, AIMessage)
        and getattr(left, "tool_calls", None)
        and isinstance(right, ToolMessage)
    ):
        return split_index - 1

    if isinstance(right, ToolMessage):
        cursor = split_index - 1
        while cursor >= 0 and isinstance(messages[cursor], ToolMessage):
            cursor -= 1
        if (
            cursor >= 0
            and isinstance(messages[cursor], AIMessage)
            and getattr(messages[cursor], "tool_calls", None)
        ):
            return cursor
    return split_index


def split_messages_by_recent_turns(
    messages: Iterable[BaseMessage],
    retain_rounds: int,
) -> MessageSplitResult:
    message_list = list(messages)
    if not message_list:
        return MessageSplitResult(compression_zone=[], retain_zone=[])
    if retain_rounds <= 0:
        return MessageSplitResult(compression_zone=message_list, retain_zone=[])

    human_indices = [
        index for index, message in enumerate(message_list) if isinstance(message, HumanMessage)
    ]
    if not human_indices:
        return MessageSplitResult(compression_zone=[], retain_zone=message_list)
    if len(human_indices) <= retain_rounds:
        return MessageSplitResult(compression_zone=[], retain_zone=message_list)

    split_index = adjust_split_index_for_tool_boundary(message_list, human_indices[-retain_rounds])
    return MessageSplitResult(
        compression_zone=message_list[:split_index],
        retain_zone=message_list[split_index:],
    )


def select_anchor_message_id(messages: Iterable[BaseMessage]) -> str | None:
    for message in messages:
        message_id = _message_id(message)
        if message_id:
            return message_id
    return None


def select_last_message_id(messages: Iterable[BaseMessage]) -> str | None:
    selected: str | None = None
    for message in messages:
        message_id = _message_id(message)
        if message_id:
            selected = message_id
    return selected


def apply_compression_anchor_replacement(
    *,
    messages: Iterable[BaseMessage],
    anchor_message_id: str | None,
    l1_content: str,
    l2_content: str | None = None,
) -> AnchorReplaceResult:
    message_list = list(messages)
    if not anchor_message_id:
        return AnchorReplaceResult(
            anchor_message_id=None, replaced_messages=message_list, applied=False
        )

    anchor_index = next(
        (
            index
            for index, message in enumerate(message_list)
            if _message_id(message) == anchor_message_id
        ),
        None,
    )
    if anchor_index is None:
        return AnchorReplaceResult(
            anchor_message_id=anchor_message_id,
            replaced_messages=message_list,
            applied=False,
        )

    replaced_messages = (
        build_compression_context_messages(
            l1_content=l1_content,
            l2_content=l2_content,
        )
        + message_list[anchor_index:]
    )
    return AnchorReplaceResult(
        anchor_message_id=anchor_message_id,
        replaced_messages=replaced_messages,
        applied=True,
    )


def apply_compression_full_replacement(
    *,
    l1_content: str,
    l2_content: str | None = None,
) -> AnchorReplaceResult:
    return AnchorReplaceResult(
        anchor_message_id=None,
        replaced_messages=build_compression_context_messages(
            l1_content=l1_content,
            l2_content=l2_content,
        ),
        applied=True,
    )


def apply_compression_full_replacement_after_boundary(
    *,
    messages: Iterable[BaseMessage],
    source_last_message_id: str | None,
    l1_content: str,
    l2_content: str | None = None,
) -> AnchorReplaceResult:
    message_list = list(messages)
    if not source_last_message_id:
        return AnchorReplaceResult(
            anchor_message_id=None,
            replaced_messages=message_list,
            applied=False,
        )
    boundary_index = next(
        (
            index
            for index, message in enumerate(message_list)
            if _message_id(message) == source_last_message_id
        ),
        None,
    )
    if boundary_index is None:
        return AnchorReplaceResult(
            anchor_message_id=source_last_message_id,
            replaced_messages=message_list,
            applied=False,
        )
    replaced_messages = build_compression_context_messages(
        l1_content=l1_content,
        l2_content=l2_content,
    ) + message_list[boundary_index + 1 :]
    return AnchorReplaceResult(
        anchor_message_id=source_last_message_id,
        replaced_messages=replaced_messages,
        applied=True,
    )


def detect_compression_phase(snapshot: CompressionStateSnapshot) -> CompressionPhase:
    if snapshot.slots.existing_l1 is None:
        return "initial"
    if snapshot.slots.existing_l2 is None:
        return "second"
    return "steady"


def _stringify_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    value = item.get("text") or ""
                    if value:
                        text_parts.append(str(value))
                else:
                    text_parts.append(json.dumps(item, ensure_ascii=False))
            else:
                text_parts.append(str(item))
        return "\n".join(part for part in text_parts if part)
    if isinstance(content, dict):
        return json.dumps(content, ensure_ascii=False)
    return str(content) if content is not None else ""


def _truncate_tool_result_text(text: str) -> str:
    normalized = text.strip()
    if not normalized:
        return "(空结果)"

    lines = normalized.splitlines()
    truncated_by_lines = False
    if len(lines) > TOOL_RESULT_PREVIEW_MAX_LINES:
        lines = lines[:TOOL_RESULT_PREVIEW_MAX_LINES]
        truncated_by_lines = True

    preview = "\n".join(lines)
    truncated_by_chars = False
    if len(preview) > TOOL_RESULT_PREVIEW_MAX_CHARS:
        preview = preview[:TOOL_RESULT_PREVIEW_MAX_CHARS].rstrip()
        truncated_by_chars = True

    if truncated_by_lines or truncated_by_chars:
        suffix_parts: list[str] = []
        if truncated_by_lines:
            suffix_parts.append(f"仅保留前 {TOOL_RESULT_PREVIEW_MAX_LINES} 行")
        if truncated_by_chars:
            suffix_parts.append(f"仅保留前 {TOOL_RESULT_PREVIEW_MAX_CHARS} 字符")
        preview = f"{preview}\n...(已截断：{'，'.join(suffix_parts)})"
    return preview


def _render_tool_call_summary(message: AIMessage) -> list[str]:
    lines: list[str] = []
    tool_calls = getattr(message, "tool_calls", None) or []
    for index, tool_call in enumerate(tool_calls, start=1):
        if isinstance(tool_call, dict):
            name = tool_call.get("name") or "unknown"
            args = tool_call.get("args")
            tool_id = tool_call.get("id") or "unknown"
        else:
            name = getattr(tool_call, "name", None) or "unknown"
            args = getattr(tool_call, "args", None)
            tool_id = getattr(tool_call, "id", None) or "unknown"

        if isinstance(args, str):
            args_text = args
        elif args is None:
            args_text = "{}"
        else:
            try:
                args_text = json.dumps(args, ensure_ascii=False)
            except TypeError:
                args_text = str(args)
        lines.append(f"  - tool_call[{index}]: name={name}, id={tool_id}, args={args_text}")
    return lines


def render_messages_for_compression_input(messages: Iterable[BaseMessage]) -> str:
    message_list = list(messages)
    if not message_list:
        return ""

    sections: list[str] = []
    current_turn_lines: list[str] = []
    current_turn_number = 0

    def flush_turn() -> None:
        nonlocal current_turn_lines, current_turn_number
        if not current_turn_lines:
            return
        sections.append(
            f"## 用户轮次 {current_turn_number}\n" + "\n".join(current_turn_lines).strip()
        )
        current_turn_lines = []

    for message in message_list:
        if isinstance(message, HumanMessage):
            flush_turn()
            current_turn_number += 1
            current_turn_lines = [
                f"[用户输入]\n{_stringify_message_content(message.content).strip()}"
            ]
            continue

        if current_turn_number == 0:
            current_turn_number = 1

        if isinstance(message, AIMessage):
            ai_text = _stringify_message_content(message.content).strip()
            if ai_text:
                current_turn_lines.append(f"[AI响应]\n{ai_text}")
            tool_call_lines = _render_tool_call_summary(message)
            if tool_call_lines:
                current_turn_lines.append("[AI发起工具调用]\n" + "\n".join(tool_call_lines))
            continue

        if isinstance(message, ToolMessage):
            tool_id = getattr(message, "tool_call_id", None) or "unknown"
            preview = _truncate_tool_result_text(_stringify_message_content(message.content))
            current_turn_lines.append(f"[工具结果][tool_call_id={tool_id}]\n{preview}")
            continue

        current_turn_lines.append(
            f"[{type(message).__name__}]\n{_stringify_message_content(message.content).strip()}"
        )

    flush_turn()
    return "\n\n".join(section.strip() for section in sections if section.strip()).strip()


def extract_compression_material(
    *,
    snapshot: CompressionStateSnapshot,
    split_result: MessageSplitResult,
    anchor_message_id: str | None,
    trace_id: str | None = None,
    trace_record_id: str | None = None,
    original_session_id: str | None = None,
    active_session_id: str | None = None,
    scene_id: str | None = None,
    scene_version_seq: int | None = None,
    side_event_metadata: dict[str, Any] | None = None,
) -> CompressionMaterial:
    existing_l1 = snapshot.slots.existing_l1
    existing_l2 = snapshot.slots.existing_l2
    return CompressionMaterial(
        phase=detect_compression_phase(snapshot),
        existing_l1_message=existing_l1,
        existing_l2_message=existing_l2,
        existing_l1_content=extract_l1_compression_content(existing_l1) if existing_l1 else None,
        existing_l2_content=extract_l2_compression_content(existing_l2) if existing_l2 else None,
        compression_zone_messages=list(split_result.compression_zone),
        retain_zone_messages=list(split_result.retain_zone),
        anchor_message_id=anchor_message_id,
        trace_id=trace_id,
        trace_record_id=trace_record_id,
        original_session_id=original_session_id,
        active_session_id=active_session_id,
        scene_id=scene_id,
        scene_version_seq=scene_version_seq,
        side_event_metadata=dict(side_event_metadata or {}),
    )


def split_and_prepare_compression(
    *,
    messages: Iterable[BaseMessage],
    retain_rounds: int,
) -> tuple[CompressionStateSnapshot, MessageSplitResult, str | None]:
    snapshot = split_compression_prefix(messages)
    split_result = split_messages_by_recent_turns(snapshot.raw_messages, retain_rounds)
    anchor_message_id = select_anchor_message_id(split_result.retain_zone)
    return snapshot, split_result, anchor_message_id


def split_and_prepare_emergency_compression(
    *,
    messages: Iterable[BaseMessage],
) -> tuple[CompressionStateSnapshot, MessageSplitResult, str | None]:
    snapshot = split_compression_prefix(messages)
    split_result = MessageSplitResult(
        compression_zone=list(snapshot.raw_messages),
        retain_zone=[],
    )
    return snapshot, split_result, None
