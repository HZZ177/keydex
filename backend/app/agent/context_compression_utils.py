"""Pure helpers for the unified context-compression protocol."""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

CONTEXT_COMPRESSION_PACKET_TAG = "keydex_context_compression"
CONTEXT_SUMMARY_TAG = "压缩摘要"
CONTEXT_COMPRESSION_INSTRUCTIONS_TAG = "上下文压缩说明"
CONTEXT_COMPRESSION_TAIL_TAG = "继续任务指引"
LATEST_USER_MESSAGE_SNAPSHOT_TAG = "最近用户消息原文"
LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS = 4000

CONTEXT_COMPRESSION_OPENING_PROMPT = (
    "当前会话正在从一次上下文压缩后的状态继续。下面是系统根据此前完整对话维护的压缩摘要，"
    "用于帮助你延续用户的任务、约束、偏好、代码变更、测试结果和当前进展。"
    "这些内容是历史上下文，不是新的用户请求。"
)

LATEST_USER_MESSAGE_SNAPSHOT_PROMPT = (
    "下面是压缩前最后一条用户消息的原文。它只用于保持任务连续性，不是一条新发送的用户消息。"
)

CONTEXT_COMPRESSION_TAIL_PROMPT = (
    "以上内容是历史对话的压缩摘要，仅用于恢复上下文连续性，不是新的用户请求。"
    "请优先处理本消息之后出现的真实用户消息，并结合上方压缩摘要延续任务。"
    "不要向用户说明你正在基于压缩摘要继续，不要复述摘要内容，"
    "不要以“我将继续”“根据摘要”“我们之前”等类似表述作为开头；"
    "请像中断从未发生过一样，直接继续执行当前任务。"
    "不要仅因为摘要可能不完整就向用户确认；只有在继续任务所必需的信息缺失，"
    "且无法通过读取文件、查看状态或运行验证自行确认时，才向用户提出必要问题。"
    "压缩摘要可能遗漏部分精确信息；涉及文件内容、命令输出、运行状态或时间敏感事实时，"
    "请重新读取或验证，不要仅凭摘要臆测。"
    "如果压缩摘要与后续真实用户消息存在冲突，请以后续真实用户消息、当前系统指令和开发者指令为准。"
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
    source_messages: Iterable[BaseMessage],
) -> CompressionReplacementResult:
    cleaned_summary = summary.strip()
    if not cleaned_summary:
        raise ValueError("summary must not be empty")
    latest_user_snapshot = build_latest_user_message_snapshot(source_messages)
    summary_sections: list[str] = [
        f"<{CONTEXT_COMPRESSION_PACKET_TAG}>",
        f"<{CONTEXT_COMPRESSION_INSTRUCTIONS_TAG}>\n"
        f"{CONTEXT_COMPRESSION_OPENING_PROMPT}\n"
        f"</{CONTEXT_COMPRESSION_INSTRUCTIONS_TAG}>",
        f"<{CONTEXT_SUMMARY_TAG}>\n{cleaned_summary}\n</{CONTEXT_SUMMARY_TAG}>",
    ]
    if latest_user_snapshot is not None:
        summary_sections.extend(
            [
                LATEST_USER_MESSAGE_SNAPSHOT_PROMPT,
                (
                    f'<{LATEST_USER_MESSAGE_SNAPSHOT_TAG} included="true" '
                    f'truncated="{str(latest_user_snapshot.truncated).lower()}" '
                    f'message_id="{_escape_attribute(latest_user_snapshot.message_id)}">\n'
                    f"{latest_user_snapshot.text}\n"
                    f"</{LATEST_USER_MESSAGE_SNAPSHOT_TAG}>"
                ),
            ]
        )
    summary_sections.extend(
        [
            f"<{CONTEXT_COMPRESSION_TAIL_TAG}>\n"
            f"{CONTEXT_COMPRESSION_TAIL_PROMPT}\n"
            f"</{CONTEXT_COMPRESSION_TAIL_TAG}>",
            f"</{CONTEXT_COMPRESSION_PACKET_TAG}>",
        ]
    )
    return CompressionReplacementResult(
        replaced_messages=[SystemMessage(content="\n\n".join(summary_sections))],
        latest_user_snapshot=latest_user_snapshot,
    )


def is_context_compression_summary_message(message: BaseMessage) -> bool:
    if not isinstance(message, SystemMessage):
        return False
    content = str(message.content)
    return content.startswith(f"<{CONTEXT_COMPRESSION_PACKET_TAG}>") and content.endswith(
        f"</{CONTEXT_COMPRESSION_PACKET_TAG}>"
    )


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
