from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import HumanMessage

COMPACTION_PROMPT = """重要：你正在为当前会话生成上下文压缩摘要。

你已经能看到压缩所需的上方对话上下文。请只回复纯文本，且必须严格由一个 <分析> 块和一个 <摘要> 块组成。不要输出 Markdown 代码块、JSON、额外寒暄或结构外说明。

请使用简体中文撰写所有自然语言内容。原对话中的文件路径、函数名、类名、命令、错误码、配置键、协议字段和必要代码片段保持原文，不要翻译或改写这些标识。

你的任务是详细总结到目前为止的对话，使会话在上下文压缩后可以继续推进。重点保留用户的明确请求、偏好和约束，助手已执行的操作、代码变更、架构决策、错误与修复、测试结果，以及压缩前仍在进行的工作。

在最终摘要之前，请在 <分析> 块中做简洁覆盖检查，确认已经覆盖：

1. 按时间顺序梳理用户的主要请求和真实意图。
2. 关键技术概念、架构决策、运行时边界和代码模式。
3. 已检查、修改或创建的具体文件和代码位置。
4. 遇到的错误、修复方式，以及导致方向变化的用户反馈。
5. 已解决的问题和仍在进行的排查。
6. 会影响任务意图、约束或偏好的用户消息。
7. 涉及安全、凭证、敏感数据或禁止操作的指令；这些内容必须在摘要中逐字保留。
8. 明确待办任务，以及压缩发生前正在处理的当前工作。
9. 可选下一步；只有在它直接承接用户最新请求时才写入。

<摘要> 块必须足够详细，使下一轮助手即使看不到原始对话，也能继续同一项任务。需要包含关键文件名、函数名、接口形态、测试命令、重要决策、已知风险和用户偏好。不要编造事实，不要把未验证的推测写成结论。

输出结构：

<分析>
[简洁列出覆盖检查，不展开冗长推理。]
</分析>

<摘要>
1. 主要请求与意图：
   [详细描述]

2. 关键技术概念：
   - [概念]

3. 文件与代码位置：
   - [文件路径]
     - [重要原因]
     - [相关修改或观察到的行为]

4. 错误与修复：
   - [错误]：[修复方式，以及相关用户反馈]

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

提醒：只输出上述纯文本结构。"""

SUMMARY_BLOCK_PATTERN = re.compile(r"<摘要>\s*(.*?)\s*</摘要>", re.DOTALL)
ANALYSIS_BLOCK_PATTERN = re.compile(r"<分析>\s*.*?\s*</分析>", re.DOTALL)


@dataclass(frozen=True, slots=True)
class CompactionPromptBundle:
    human_message: HumanMessage


def build_compaction_prompt() -> CompactionPromptBundle:
    return CompactionPromptBundle(human_message=HumanMessage(content=COMPACTION_PROMPT))


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
