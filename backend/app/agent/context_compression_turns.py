from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from backend.app.agent.context_compression_segments import approximate_message_tokens
from backend.app.agent.context_compression_utils import (
    CONTEXT_COMPRESSION_METADATA_KEY,
    is_context_compression_summary_message,
    stringify_message_content,
)

CURRENT_TURN_MESSAGE_MARKER = "_keydex_current_turn"
INJECTED_MESSAGE_MARKER = "_injected"
COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY = "keydex_compact_runtime_attachment"
TURN_LEDGER_METADATA_KEY = "turn_ledger"


@dataclass(frozen=True, slots=True)
class CompressionTurnSegment:
    record_id: str
    turn_id: str
    kind: Literal["turn", "execution"]
    messages: tuple[BaseMessage, ...]
    source_message_ids: tuple[str, ...]
    approximate_tokens: int
    root_message_id: str | None = None


@dataclass(frozen=True, slots=True)
class CompressionTurnManifest:
    segments: tuple[CompressionTurnSegment, ...]
    previous_records: tuple[dict[str, str], ...]
    previous_current_state: str
    legacy_summary: str
    turn_root_map: dict[str, str]
    execution_counts: dict[str, int]
    turn_count: int

    @property
    def expected_record_ids(self) -> tuple[str, ...]:
        return tuple(segment.record_id for segment in self.segments)

    @property
    def all_record_ids(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                [
                    *(
                        str(item.get("id") or "")
                        for item in self.previous_records
                        if str(item.get("id") or "")
                    ),
                    *self.expected_record_ids,
                ]
            )
        )

    def protocol_metadata(
        self, records: list[dict[str, str]], current_state: str
    ) -> dict[str, Any]:
        return {
            TURN_LEDGER_METADATA_KEY: {
                "schema_version": 1,
                "records": [
                    {"id": str(item.get("id") or ""), "text": str(item.get("text") or "")}
                    for item in records
                    if str(item.get("id") or "") and str(item.get("text") or "").strip()
                ],
                "current_state": str(current_state or "").strip(),
                "legacy_summary": self.legacy_summary,
                "turn_root_map": dict(self.turn_root_map),
                "execution_counts": dict(self.execution_counts),
                "turn_count": max(int(self.turn_count), 0),
            }
        }


@dataclass(frozen=True, slots=True)
class RawConversationBundle:
    start_index: int
    end_index: int
    messages: tuple[BaseMessage, ...]
    approximate_tokens: int
    has_real_user_root: bool


def build_compression_turn_manifest(messages: list[BaseMessage]) -> CompressionTurnManifest:
    previous_summary = next(
        (
            message
            for message in reversed(messages)
            if is_context_compression_summary_message(message)
        ),
        None,
    )
    previous_records, previous_state, legacy_summary, root_map, execution_counts, turn_count = (
        _previous_ledger(previous_summary)
    )
    candidates = [
        message
        for message in messages
        if not is_context_compression_summary_message(message)
    ]
    segments, root_map, execution_counts, turn_count = _build_segments(
        candidates,
        turn_root_map=root_map,
        execution_counts=execution_counts,
        turn_count=turn_count,
    )
    return CompressionTurnManifest(
        segments=tuple(segments),
        previous_records=tuple(previous_records),
        previous_current_state=previous_state,
        legacy_summary=legacy_summary,
        turn_root_map=root_map,
        execution_counts=execution_counts,
        turn_count=turn_count,
    )


def build_raw_conversation_bundles(
    messages: list[BaseMessage],
) -> tuple[RawConversationBundle, ...]:
    if not messages:
        return ()
    root_indexes = [index for index, message in enumerate(messages) if is_real_user_root(message)]
    if not root_indexes:
        return (
            RawConversationBundle(
                start_index=0,
                end_index=len(messages),
                messages=tuple(messages),
                approximate_tokens=sum(approximate_message_tokens(item) for item in messages),
                has_real_user_root=False,
            ),
        )

    starts: list[int] = []
    previous_root = -1
    for root_index in root_indexes:
        start = root_index
        while start > previous_root + 1 and is_user_companion(messages[start - 1]):
            start -= 1
        starts.append(start)
        previous_root = root_index

    bundles: list[RawConversationBundle] = []
    if starts[0] > 0:
        prefix = tuple(messages[: starts[0]])
        bundles.append(
            RawConversationBundle(
                start_index=0,
                end_index=starts[0],
                messages=prefix,
                approximate_tokens=sum(approximate_message_tokens(item) for item in prefix),
                has_real_user_root=False,
            )
        )
    for offset, start in enumerate(starts):
        end = starts[offset + 1] if offset + 1 < len(starts) else len(messages)
        chunk = tuple(messages[start:end])
        bundles.append(
            RawConversationBundle(
                start_index=start,
                end_index=end,
                messages=chunk,
                approximate_tokens=sum(approximate_message_tokens(item) for item in chunk),
                has_real_user_root=True,
            )
        )
    return tuple(bundles)


def render_turn_segments(segments: tuple[CompressionTurnSegment, ...]) -> str:
    rendered: list[str] = []
    for segment in segments:
        tag = "TURN" if segment.kind == "turn" else "EXECUTION_SEGMENT"
        rendered.append(
            f'<{tag} id="{segment.record_id}" turn_id="{segment.turn_id}">'
        )
        for message in segment.messages:
            rendered.append(_render_message(message))
        rendered.append(f"</{tag}>")
    return "\n\n".join(rendered)


def build_fallback_turn_summary(segment: CompressionTurnSegment) -> str:
    users: list[str] = []
    agent_actions: list[str] = []
    results: list[str] = []
    for message in segment.messages:
        content = stringify_message_content(getattr(message, "content", "")).strip()
        if isinstance(message, HumanMessage):
            label = "结构化伴随输入" if is_user_companion(message) else "用户"
            if content:
                users.append(f"- {label}：{_bounded(content, 2_000)}")
        elif isinstance(message, AIMessage):
            if content:
                agent_actions.append(f"- Agent 回复/说明：{_bounded(content, 2_000)}")
            for call in message.tool_calls:
                name = str(call.get("name") or "unknown_tool")
                args = json.dumps(call.get("args") or {}, ensure_ascii=False, sort_keys=True)
                agent_actions.append(f"- Agent 调用 `{name}`：{_bounded(args, 1_200)}")
        elif isinstance(message, ToolMessage):
            results.append(
                f"- 工具结果 `{message.tool_call_id}`：{_bounded(content, 1_500)}"
            )
        elif isinstance(message, SystemMessage) and content:
            agent_actions.append(f"- 运行约束：{_bounded(content, 1_000)}")
    user_text = "\n".join(users) or "- 本片段没有新的真实用户消息，延续同一用户目标。"
    action_text = "\n".join(agent_actions) or "- 未发现可可靠提取的 Agent 文本或工具动作。"
    result_text = "\n".join(results) or "- 未发现独立工具结果；以 Agent 记录的阶段状态为准。"
    return (
        f"用户说了什么：\n{user_text}\n\n"
        f"Agent 做了什么：\n{action_text}\n\n"
        f"结果、错误与验证：\n{result_text}\n\n"
        "本片段结束状态：以上内容由宿主从原始消息保底提取，后续应结合近期原文继续。"
    )


def is_real_user_root(message: BaseMessage) -> bool:
    if not isinstance(message, HumanMessage):
        return False
    if is_context_compression_summary_message(message):
        return False
    if _message_flag(message, INJECTED_MESSAGE_MARKER):
        return False
    if _runtime_attachment_kind(message):
        return False
    group_metadata = getattr(message, "additional_kwargs", {}).get(
        "keydex_structured_user_group"
    )
    if isinstance(group_metadata, dict):
        return group_metadata.get("member_kind") == "root_user_message"
    return True


def is_user_companion(message: BaseMessage) -> bool:
    if _message_flag(message, INJECTED_MESSAGE_MARKER):
        return True
    group_metadata = getattr(message, "additional_kwargs", {}).get(
        "keydex_structured_user_group"
    )
    return isinstance(group_metadata, dict) and group_metadata.get("member_kind") != (
        "root_user_message"
    )


def _build_segments(
    messages: list[BaseMessage],
    *,
    turn_root_map: dict[str, str],
    execution_counts: dict[str, int],
    turn_count: int,
) -> tuple[list[CompressionTurnSegment], dict[str, str], dict[str, int], int]:
    if not messages:
        return [], dict(turn_root_map), dict(execution_counts), max(turn_count, 0)
    root_map = dict(turn_root_map)
    exec_counts = {str(key): max(int(value), 0) for key, value in execution_counts.items()}
    count = max(int(turn_count), 0)
    roots = [index for index, message in enumerate(messages) if is_real_user_root(message)]
    starts: list[int] = []
    previous_root = -1
    for root_index in roots:
        start = root_index
        while start > previous_root + 1 and is_user_companion(messages[start - 1]):
            start -= 1
        starts.append(start)
        previous_root = root_index

    raw_segments: list[tuple[int, int, int | None]] = []
    if not starts:
        raw_segments.append((0, len(messages), None))
    else:
        if starts[0] > 0:
            raw_segments.append((0, starts[0], None))
        for offset, start in enumerate(starts):
            end = starts[offset + 1] if offset + 1 < len(starts) else len(messages)
            root_index = roots[offset]
            raw_segments.append((start, end, root_index))

    result: list[CompressionTurnSegment] = []
    latest_turn_id = _latest_turn_id(root_map, count)
    for start, end, root_index in raw_segments:
        root_message_id = (
            _message_id(messages[root_index], root_index)
            if root_index is not None
            else None
        )
        existing_turn_id = root_map.get(root_message_id or "") if root_message_id else None
        if root_index is not None and existing_turn_id is None:
            count += 1
            turn_id = f"TURN-{count:04d}"
            root_map[root_message_id or f"anonymous:{count}"] = turn_id
            exec_counts.setdefault(turn_id, 0)
            record_id = turn_id
            kind: Literal["turn", "execution"] = "turn"
            latest_turn_id = turn_id
        else:
            turn_id = existing_turn_id or latest_turn_id
            if not turn_id:
                count += 1
                turn_id = f"TURN-{count:04d}"
                latest_turn_id = turn_id
            exec_counts[turn_id] = exec_counts.get(turn_id, 0) + 1
            record_id = f"{turn_id}/EXEC-{exec_counts[turn_id]:04d}"
            kind = "execution"
        chunk = tuple(message.model_copy(deep=True) for message in messages[start:end])
        result.append(
            CompressionTurnSegment(
                record_id=record_id,
                turn_id=turn_id,
                kind=kind,
                messages=chunk,
                source_message_ids=tuple(
                    _message_id(message, start + offset)
                    for offset, message in enumerate(chunk)
                ),
                approximate_tokens=sum(approximate_message_tokens(item) for item in chunk),
                root_message_id=root_message_id,
            )
        )
    return result, root_map, exec_counts, count


def _previous_ledger(
    summary_message: BaseMessage | None,
) -> tuple[list[dict[str, str]], str, str, dict[str, str], dict[str, int], int]:
    if summary_message is None:
        return [], "", "", {}, {}, 0
    metadata = getattr(summary_message, "additional_kwargs", {}).get(
        CONTEXT_COMPRESSION_METADATA_KEY
    )
    ledger = metadata.get(TURN_LEDGER_METADATA_KEY) if isinstance(metadata, dict) else None
    if isinstance(ledger, dict) and int(ledger.get("schema_version") or 0) == 1:
        records = [
            {"id": str(item.get("id") or ""), "text": str(item.get("text") or "").strip()}
            for item in (ledger.get("records") or [])
            if isinstance(item, dict)
            and str(item.get("id") or "")
            and str(item.get("text") or "").strip()
        ]
        root_map = {
            str(key): str(value)
            for key, value in dict(ledger.get("turn_root_map") or {}).items()
            if str(key) and str(value)
        }
        execution_counts = {
            str(key): max(int(value), 0)
            for key, value in dict(ledger.get("execution_counts") or {}).items()
        }
        return (
            records,
            str(ledger.get("current_state") or "").strip(),
            str(ledger.get("legacy_summary") or "").strip(),
            root_map,
            execution_counts,
            max(int(ledger.get("turn_count") or 0), 0),
        )
    return [], "", _extract_visible_summary(summary_message), {}, {}, 0


def _extract_visible_summary(message: BaseMessage) -> str:
    content = stringify_message_content(getattr(message, "content", ""))
    marker = "## 较早历史摘要"
    boundary = "## 继续工作边界"
    if marker in content:
        content = content.split(marker, 1)[1]
    if boundary in content:
        content = content.split(boundary, 1)[0]
    return content.strip()


def _render_message(message: BaseMessage) -> str:
    content = stringify_message_content(getattr(message, "content", "")).strip()
    if isinstance(message, HumanMessage):
        role = "用户结构化伴随输入" if is_user_companion(message) else "用户"
    elif isinstance(message, AIMessage):
        role = "Agent"
    elif isinstance(message, ToolMessage):
        role = f"工具结果 tool_call_id={message.tool_call_id}"
    elif isinstance(message, SystemMessage):
        role = "系统/运行约束"
    else:
        role = type(message).__name__
    parts = [f"[{role}]", content or "(无文本内容)"]
    if isinstance(message, AIMessage) and message.tool_calls:
        parts.append(
            "[Agent 工具调用]\n"
            + json.dumps(message.tool_calls, ensure_ascii=False, indent=2, default=str)
        )
    return "\n".join(parts)


def _latest_turn_id(root_map: dict[str, str], turn_count: int) -> str:
    if root_map:
        return list(root_map.values())[-1]
    return f"TURN-{turn_count:04d}" if turn_count > 0 else ""


def _message_id(message: BaseMessage, fallback_index: int) -> str:
    return str(getattr(message, "id", "") or f"message:{fallback_index}")


def _message_flag(message: BaseMessage, key: str) -> bool:
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict) and additional_kwargs.get(key) is True:
        return True
    return getattr(message, key, False) is True


def _runtime_attachment_kind(message: BaseMessage) -> str:
    metadata = getattr(message, "additional_kwargs", {}).get(
        COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY
    )
    return str(metadata.get("kind") or "") if isinstance(metadata, dict) else ""


def _bounded(text: str, max_chars: int) -> str:
    cleaned = str(text or "").strip()
    if len(cleaned) <= max_chars:
        return cleaned
    half = max((max_chars - 40) // 2, 20)
    return f"{cleaned[:half]}\n...[保底摘要截断]...\n{cleaned[-half:]}"
