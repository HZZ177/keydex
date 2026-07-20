# ruff: noqa: E501

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import HumanMessage

from backend.app.agent.context_compression_turns import (
    CompressionTurnSegment,
    render_turn_segments,
)

COMPACTION_PROMPT = """重要：你正在为当前会话生成早期历史前缀的高保真上下文压缩摘要。

宿主程序已经把待压缩历史确定性地划分为 TURN（真实用户轮次）和 EXECUTION_SEGMENT（同一长任务中较早的执行片段）。轮次和片段 ID 是事实边界，不由你重新判断。

你的首要任务是逐条记录“用户说了什么、Agent 做了什么、得到了什么结果”。必须遵守：

1. 为输入中的每个 ID 输出且只输出一条 <记录>，顺序必须与输入一致。
2. 不得把两个 TURN 或 EXECUTION_SEGMENT 合并，不得跳过简短确认、纠正、否决或方向变化。
3. 每条记录分别写清：用户请求/反馈；Agent 的方案与具体动作；关键工具、命令、文件和代码位置；结果、错误、修复与测试；本轮结束状态和未完成事项。
4. EXECUTION_SEGMENT 没有新的真实用户消息时，明确写“延续同一用户目标”，重点记录这个执行片段新增的动作、证据和状态。
5. 文件路径、函数名、类名、命令、错误码、配置键、协议字段和必要代码片段保持原文。不要把试过但失败的方案写成最终结论，也不要丢掉用户明确否决的方向。
6. 结构化伴随输入属于同一用户轮次，只记录它对该轮意图的作用；不要把它误写成另一轮用户消息。
7. 最后输出一个 <当前状态>，只汇总当前目标、已确认决策、精确工作状态、风险和待办。它不能代替前面的逐条记录。

只回复以下纯文本结构，不要输出 Markdown 代码块、JSON、分析过程、寒暄或结构外说明：

<摘要>
<记录 id="输入中的 ID">
用户说了什么：
- ...

Agent 做了什么：
- ...

结果、错误与验证：
- ...

用户反馈或方向变化：
- ...

本轮结束状态与未完成事项：
- ...
</记录>

[按照输入顺序继续输出其余 <记录>]

<当前状态>
- 当前目标：...
- 已确认决策：...
- 精确工作状态：...
- 风险与待办：...
</当前状态>
</摘要>

请使用简体中文。你的范围只是下面宿主提供的当前可见早期历史前缀；摘要之后还会接入近期完整轮次、当前结构化输入、计划和执行现场，不要猜测不可见内容。"""

SUMMARY_BLOCK_PATTERN = re.compile(r"<摘要>\s*(.*?)\s*</摘要>", re.DOTALL)
ANALYSIS_BLOCK_PATTERN = re.compile(r"<分析>\s*.*?\s*</分析>", re.DOTALL)
SUMMARY_RECORD_PATTERN = re.compile(
    r'<记录\s+id=["\']([^"\']+)["\']\s*>\s*(.*?)\s*</记录>',
    re.DOTALL,
)
CURRENT_STATE_PATTERN = re.compile(r"<当前状态>\s*(.*?)\s*</当前状态>", re.DOTALL)


@dataclass(frozen=True, slots=True)
class CompactionPromptBundle:
    human_message: HumanMessage
    expected_record_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ParsedCompactionSummary:
    records: tuple[dict[str, str], ...]
    current_state: str
    missing_record_ids: tuple[str, ...]
    unexpected_record_ids: tuple[str, ...]


def build_compaction_prompt(
    additional_instructions: str | None = None,
    *,
    turn_segments: Iterable[CompressionTurnSegment] = (),
) -> CompactionPromptBundle:
    if additional_instructions is not None and not isinstance(additional_instructions, str):
        raise TypeError("additional_instructions 必须是字符串或 None")
    segments = tuple(turn_segments)
    extra = (additional_instructions or "").strip()
    content = COMPACTION_PROMPT
    if extra:
        content = (
            f"{content}\n\n附加压缩说明（仅补充每条记录的保留重点，不改变逐条输出协议）：\n{extra}"
        )
    if segments:
        ids = ", ".join(segment.record_id for segment in segments)
        content = (
            f"{content}\n\n宿主要求覆盖的 ID（必须逐一输出）：{ids}\n\n"
            "下面是已完成确定性切分的待压缩消息：\n\n"
            f"{render_turn_segments(segments)}"
        )
    return CompactionPromptBundle(
        human_message=HumanMessage(content=content),
        expected_record_ids=tuple(segment.record_id for segment in segments),
    )


def build_missing_record_repair_prompt(
    segments: Iterable[CompressionTurnSegment],
) -> CompactionPromptBundle:
    missing = tuple(segments)
    ids = ", ".join(segment.record_id for segment in missing)
    content = f"""你正在补齐一次上下文压缩中缺失的逐轮记录。

只为下面这些缺失 ID 输出 <记录>，每个 ID 恰好一条，保持输入顺序，不要输出 <当前状态>，也不要重写其他轮次。每条仍需分别说明用户说了什么、Agent 做了什么、结果/错误/验证、方向变化以及结束状态。

输出协议：
<摘要>
<记录 id="输入中的 ID">
用户说了什么：...
Agent 做了什么：...
结果、错误与验证：...
用户反馈或方向变化：...
本轮结束状态与未完成事项：...
</记录>
</摘要>

必须覆盖的缺失 ID：{ids}

{render_turn_segments(missing)}"""
    return CompactionPromptBundle(
        human_message=HumanMessage(content=content),
        expected_record_ids=tuple(segment.record_id for segment in missing),
    )


def extract_summary_text(content: Any) -> str | None:
    text = _clean_text_content(content)
    if not text:
        return None
    match = SUMMARY_BLOCK_PATTERN.search(text)
    if match:
        return _strip_code_fence(match.group(1).strip()) or None
    if "<分析" in text or "<analysis" in text.lower():
        return None
    return _strip_code_fence(text.strip()) or None


def parse_compaction_summary(
    summary: str,
    *,
    expected_record_ids: Iterable[str],
) -> ParsedCompactionSummary:
    expected = tuple(dict.fromkeys(str(item) for item in expected_record_ids if str(item)))
    by_id: dict[str, str] = {}
    unexpected: list[str] = []
    expected_set = set(expected)
    for match in SUMMARY_RECORD_PATTERN.finditer(str(summary or "")):
        record_id = match.group(1).strip()
        text = _strip_code_fence(match.group(2).strip())
        if not record_id or not text or record_id in by_id:
            continue
        if record_id not in expected_set:
            unexpected.append(record_id)
            continue
        by_id[record_id] = text
    state_match = CURRENT_STATE_PATTERN.search(str(summary or ""))
    current_state = _strip_code_fence(state_match.group(1).strip()) if state_match else ""
    records = tuple({"id": item, "text": by_id[item]} for item in expected if item in by_id)
    return ParsedCompactionSummary(
        records=records,
        current_state=current_state,
        missing_record_ids=tuple(item for item in expected if item not in by_id),
        unexpected_record_ids=tuple(dict.fromkeys(unexpected)),
    )


def assemble_turn_ledger_summary(
    *,
    previous_records: Iterable[dict[str, str]],
    new_records: Iterable[dict[str, str]],
    legacy_summary: str = "",
    current_state: str = "",
) -> str:
    ordered: list[dict[str, str]] = []
    positions: dict[str, int] = {}
    for raw in [*previous_records, *new_records]:
        record_id = str(raw.get("id") or "").strip()
        text = str(raw.get("text") or "").strip()
        if not record_id or not text:
            continue
        if record_id in positions:
            ordered[positions[record_id]] = {"id": record_id, "text": text}
        else:
            positions[record_id] = len(ordered)
            ordered.append({"id": record_id, "text": text})

    sections: list[str] = []
    legacy = str(legacy_summary or "").strip()
    if legacy:
        sections.append(f"## 既有历史交接（旧格式原样保留）\n\n{legacy}")
    if ordered:
        ledger_lines = ["## 逐轮对话与执行记录"]
        for item in ordered:
            ledger_lines.append(f"### {item['id']}\n\n{item['text']}")
        sections.append("\n\n".join(ledger_lines))
    state = str(current_state or "").strip()
    if not state and ordered:
        state = "以最后一条逐轮记录的结束状态为准，并结合后续保留的近期原文继续执行。"
    if state:
        sections.append(f"## 当前工作状态\n\n{state}")
    return "\n\n".join(sections).strip()


def _clean_text_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
            else:
                parts.append(str(item))
        return "".join(parts).strip()
    return str(content).strip() if content is not None else ""


def _strip_code_fence(text: str) -> str:
    cleaned = text.strip()
    if not cleaned.startswith("```"):
        return cleaned
    lines = cleaned.splitlines()
    if len(lines) >= 2 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return cleaned
