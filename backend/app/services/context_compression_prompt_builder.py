# ruff: noqa: E501

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import HumanMessage

COMPACTION_PROMPT = """重要：你正在为当前会话生成早期历史前缀的上下文压缩摘要。

你现在只能看到会话中将被替换的较早历史前缀。摘要之后，系统会接入你当前看不到的更新用户消息、结构化伴随输入、当前计划和近期执行现场。因此只总结当前可见前缀，不要声称总结了完整会话，也不要猜测不可见的近期状态。

请只回复纯文本，且必须严格由一个 <分析> 块和一个 <摘要> 块组成。不要输出 Markdown 代码块、JSON、额外寒暄或结构外说明。

请使用简体中文撰写所有自然语言内容。原对话中的文件路径、函数名、类名、命令、错误码、配置键、协议字段和必要代码片段保持原文，不要翻译或改写这些标识。

你的任务是把当前可见的早期前缀整理为高保真工作交接，使后续模型在接上更新消息和近期现场后可以继续推进。优先保留第一条真实用户请求与最初目标，再按时间线关联后续有效用户请求、约束、反馈和方向变化，以及 Agent 针对它们采用的方案、工具或文件动作、结果、错误、修复与测试。重复确认、寒暄和不改变任务的消息可以合并。

在最终摘要之前，请在 <分析> 块中做简洁覆盖检查，确认已经覆盖：

1. 确认第一条真实用户请求和最初目标已被优先识别。
2. 按时间顺序梳理后续用户的主要请求、约束、反馈、方向变化和真实意图。
3. 将每一阶段的用户意图与 Agent 的方案、工具/文件动作、结果、错误、修复和测试关联起来。
4. 关键技术概念、架构决策、运行时边界和代码模式。
5. 已检查、修改或创建的具体文件和代码位置。
6. 已解决的问题、仍在进行的排查和当前可见前缀结束时的工作状态。
7. 会影响任务意图、约束或偏好的用户消息。
8. 涉及安全、凭证、敏感数据或禁止操作的指令；这些内容必须在摘要中准确保留。
9. 明确待办任务；可选下一步只有在它直接承接当前可见工作时才写入。

<摘要> 块必须足够详细，使后续模型在看不到这段早期原文时仍能理解任务来路。需要包含关键文件名、函数名、接口形态、测试命令、重要决策、已知风险和用户偏好。不要把摘要写成新的用户命令，不要编造不可见的近期消息，也不要把未验证的推测写成结论。

输出结构：

<分析>
[简洁列出覆盖检查，不展开冗长推理。]
</分析>

<摘要>
1. 最初目标与请求时间线：
   [先写第一条真实用户请求与最初目标，再关联后续有效请求、反馈和方向变化]

2. 关键技术概念：
   - [概念]

3. 文件与代码位置：
   - [文件路径]
     - [重要原因]
     - [相关修改或观察到的行为]

4. Agent 行为、错误与修复：
   - [对应的用户阶段]：[方案、工具/文件动作、结果、错误、修复和测试]

5. 问题解决与当前排查：
   [已解决问题和仍在进行的排查]

6. 用户消息与约束：
   - [会影响任务的用户消息、偏好和约束]

7. 待办任务：
   - [任务]

8. 当前工作状态：
   [压缩发生前的精确状态]

9. 可选下一步：
   [仅在直接承接用户最新请求时填写]
</摘要>

提醒：只输出上述纯文本结构；你的范围只是当前可见的早期历史前缀。"""

SUMMARY_BLOCK_PATTERN = re.compile(r"<摘要>\s*(.*?)\s*</摘要>", re.DOTALL)
ANALYSIS_BLOCK_PATTERN = re.compile(r"<分析>\s*.*?\s*</分析>", re.DOTALL)


@dataclass(frozen=True, slots=True)
class CompactionPromptBundle:
    human_message: HumanMessage


def build_compaction_prompt(
    additional_instructions: str | None = None,
) -> CompactionPromptBundle:
    if additional_instructions is not None and not isinstance(additional_instructions, str):
        raise TypeError("additional_instructions 必须是字符串或 None")
    extra = (additional_instructions or "").strip()
    content = COMPACTION_PROMPT
    if extra:
        content = (
            f"{content}\n\n附加压缩说明（仅补充摘要重点，不改变输出协议）：\n{extra}"
        )
    return CompactionPromptBundle(human_message=HumanMessage(content=content))


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
