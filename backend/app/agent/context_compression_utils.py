"""Pure helpers for the unified context-compression protocol."""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

CONTEXT_COMPRESSION_PACKET_TAG = "keydex_context_compression"
CONTEXT_COMPRESSION_METADATA_KEY = "keydex_context_compression"
CONTEXT_COMPRESSION_SCHEMA_VERSION = 1
# Deprecated exports retained for old importers; the new protocol does not emit these tags.
CONTEXT_SUMMARY_TAG = "压缩摘要"
CONTEXT_COMPRESSION_INSTRUCTIONS_TAG = "上下文压缩说明"
CONTEXT_COMPRESSION_TAIL_TAG = "继续任务指引"
LATEST_USER_MESSAGE_SNAPSHOT_TAG = "最近用户消息原文"
LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS = 4000

CONTEXT_COMPRESSION_OPENING_PROMPT = (
    "当前任务从一次上下文压缩后的状态继续。下面只是较早历史的工作交接摘要，"
    "不是新的用户请求。本消息之后会接入更近期的原始用户消息、运行态附件和执行现场；"
    "意图冲突时以后续真实用户消息为准。"
)

LATEST_USER_MESSAGE_SNAPSHOT_PROMPT = (
    "下面是压缩前最后一条用户消息的原文。它只用于保持任务连续性，不是一条新发送的用户消息。"
)

CONTEXT_COMPRESSION_TAIL_PROMPT = (
    "直接延续当前工作，不要向用户复述摘要，也不要以“根据摘要”“我们之前”等"
    "压缩感知表述开头。不要仅因为摘要可能不完整就询问用户；只有继续任务所需信息"
    "无法通过读取文件、查看状态或运行验证自行确认时，才提出必要问题。"
    "摘要中的文件、测试或运行状态与当前验证事实冲突时，以当前事实为准。"
)


@dataclass(frozen=True, slots=True)
class LatestUserMessageSnapshot:
    message_id: str | None
    text: str
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class CompressionReplacementResult:
    replaced_messages: list[BaseMessage]
    latest_user_snapshot: LatestUserMessageSnapshot | None

    @property
    def applied(self) -> bool:
        return bool(self.replaced_messages)


def build_context_compression_replacement_messages(
    *,
    summary: str,
    source_messages: Iterable[BaseMessage] = (),
    boundary_id: str = "legacy-boundary",
    prefix_message_count: int | None = None,
    tail_message_count: int = 0,
    selected_group_ids: Iterable[str] = (),
    source_message_ids: Iterable[str] = (),
) -> CompressionReplacementResult:
    cleaned_summary = summary.strip()
    if not cleaned_summary:
        raise ValueError("summary must not be empty")
    source_list = list(source_messages)
    normalized_source_ids = tuple(str(item) for item in source_message_ids if str(item))
    if not normalized_source_ids:
        normalized_source_ids = tuple(
            str(getattr(message, "id", "") or f"source:{index}")
            for index, message in enumerate(source_list)
        )
    metadata = {
        "kind": "summary",
        "is_compact_summary": True,
        "schema_version": CONTEXT_COMPRESSION_SCHEMA_VERSION,
        "boundary_id": str(boundary_id),
        "prefix_message_count": (
            len(source_list) if prefix_message_count is None else max(prefix_message_count, 0)
        ),
        "tail_message_count": max(tail_message_count, 0),
        "selected_group_ids": [str(item) for item in selected_group_ids],
        "source_message_ids": list(normalized_source_ids),
    }
    content = (
        f"{CONTEXT_COMPRESSION_OPENING_PROMPT}\n\n"
        f"## 较早历史摘要\n\n{cleaned_summary}\n\n"
        f"## 继续工作边界\n\n{CONTEXT_COMPRESSION_TAIL_PROMPT}"
    )
    return CompressionReplacementResult(
        replaced_messages=[
            HumanMessage(
                id=f"compact-summary:{boundary_id}",
                content=content,
                additional_kwargs={
                    CONTEXT_COMPRESSION_METADATA_KEY: metadata,
                    "is_compact_summary": True,
                },
            )
        ],
        latest_user_snapshot=None,
    )


def is_context_compression_summary_message(message: BaseMessage) -> bool:
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict):
        metadata = additional_kwargs.get(CONTEXT_COMPRESSION_METADATA_KEY)
        if isinstance(metadata, dict) and metadata.get("kind") == "summary":
            return True
        if additional_kwargs.get("is_compact_summary") is True:
            return True
        if additional_kwargs.get("isCompactSummary") is True:
            return True
    if not isinstance(message, SystemMessage):
        return False
    content = str(message.content).strip()
    return content.startswith(f"<{CONTEXT_COMPRESSION_PACKET_TAG}")


def is_context_compression_protocol_message(message: BaseMessage) -> bool:
    return is_context_compression_summary_message(message)


def build_latest_user_message_snapshot(
    messages: Iterable[BaseMessage],
) -> LatestUserMessageSnapshot | None:
    for message in reversed(list(messages)):
        if not isinstance(message, HumanMessage):
            continue
        text = stringify_message_content(message.content).strip()
        if not text:
            return None
        truncated = False
        if len(text) > LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS:
            text = text[:LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS].rstrip()
            text = (
                f"{text}\n...(已截断：仅保留前 "
                f"{LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS} 个字符)"
            )
            truncated = True
        return LatestUserMessageSnapshot(
            message_id=getattr(message, "id", None),
            text=text,
            truncated=truncated,
        )
    return None


def stringify_message_content(content: Any) -> str:
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


def _escape_attribute(value: str | None) -> str:
    if value is None:
        return ""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
