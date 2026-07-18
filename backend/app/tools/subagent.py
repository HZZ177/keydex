from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from backend.app.subagents.models import ContinueSubagentRequest, DelegateSubagentRequest
from backend.app.tools.base import FunctionTool, ToolExecutionError, ToolHandler

DELEGATE_SUBAGENT_TOOL_NAME = "delegate_subagent"
CONTINUE_SUBAGENT_TOOL_NAME = "continue_subagent"
DELEGATE_SUBAGENT_TOOL_DESCRIPTION = """将开放式、跨文件或需要独立执行的任务交给一个新的预设
Sub-Agent，并等待本次 Run 进入终态后返回完整最终报告和寻址 ID。

当用户要求全面了解仓库、梳理项目结构和技术栈、追踪跨文件链路、调查未知影响范围，或无法确定
一次搜索能否找到完整答案时，默认优先使用 `explorer`。即使只调用一个 Explorer，上下文隔离和
完整证据收集本身也是委派收益，并不要求必须并行。用户明确要求使用 Sub-Agent 时应按要求调用。

角色选择：
- `explorer`：严格只读，适合陌生项目调研、开放式搜索、跨文件源码追踪、证据收集和方案分析。
- `worker`：可以执行实现、修改文件、运行命令和验证；它与主 Agent 及其他 Worker 共享工作区。

使用规则：
- 只有目标明确到具体文件、局部目录或单个已知问题且无需多轮探索时，才由主 Agent 直接处理。
- 互不依赖的任务可以在同一轮并行调用多个 Sub-Agent。
- 多个 Worker 并行时，任务范围和可能修改的文件必须互不重叠。
- `task` 必须完整说明目标、范围、约束、预期返回内容，以及是否允许修改和需要哪些验证。
- 每次调用都会创建新的 Sub-Agent 实例和私有子会话。
- 如果要继续、复用或回到之前的 Sub-Agent，必须使用 `continue_subagent`。
- 调用会等待终态；用户可在运行期间通过 Sub-Agent 侧栏查看、引导或取消，无需轮询状态。
""".strip()
DELEGATE_SUBAGENT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "type": {
            "type": "string",
            "enum": ["explorer", "worker"],
            "description": (
                "不可变的 Sub-Agent 角色预设。"
                "`explorer` 仅做只读探索；"
                "`worker` 可进行实现、文件修改、命令执行和验证。"
            ),
        },
        "task": {
            "type": "string",
            "minLength": 1,
            "description": (
                "交给新 Sub-Agent 的完整独立任务。"
                "必须包含目标、范围、约束、预期返回内容，"
                "并明确是否允许修改以及需要执行哪些验证。"
            ),
        },
    },
    "required": ["type", "task"],
    "additionalProperties": False,
}

CONTINUE_SUBAGENT_TOOL_DESCRIPTION = """在一个已经存在的 Sub-Agent 私有对话上下文中继续工作，
为同一个 Sub-Agent 实例创建新的不可变 Run，并等待该 Run 进入终态后返回完整最终报告。

使用规则：
- 使用先前 `delegate_subagent` 或 `continue_subagent` 返回的稳定 `subagent_id`。
- 当用户要求继续、复用、重新打开、回到先前 Sub-Agent，或新任务明显依赖其既有上下文时使用。
- 保留原 Sub-Agent 的角色、私有子会话、历史记录和上下文；不能通过本工具更换角色。
- `task` 只描述本次新增目标、补充约束、纠偏要求或需要继续完成的工作。
- 如果任务与既有上下文无关，应使用 `delegate_subagent` 创建新实例。
- 同一个 Sub-Agent 有活动 Run 时不要重复续用；应等待当前 Run 进入终态。
- 调用会等待新 Run 进入终态；用户可在运行期间通过 Sub-Agent 侧栏查看、引导或取消。
""".strip()
CONTINUE_SUBAGENT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subagent_id": {
            "type": "string",
            "minLength": 1,
            "description": (
                "需要继续使用的稳定 Sub-Agent 实例 ID，"
                "来自此前 delegate_subagent 或 continue_subagent 的返回结果。"
            ),
        },
        "task": {
            "type": "string",
            "minLength": 1,
            "description": (
                "基于该 Sub-Agent 既有上下文执行的下一项有边界任务。"
                "说明本次新增目标、补充约束、纠偏方向和预期返回内容。"
            ),
        },
    },
    "required": ["subagent_id", "task"],
    "additionalProperties": False,
}


def parse_delegate_subagent_request(args: dict[str, Any]) -> DelegateSubagentRequest:
    try:
        return DelegateSubagentRequest.model_validate(args)
    except ValidationError as exc:
        validation_errors = [
            {
                "type": item["type"],
                "loc": [str(part) for part in item["loc"]],
                "message": item["msg"],
            }
            for item in exc.errors(include_input=False)
        ]
        raise ToolExecutionError(
            "delegate_subagent requires exactly type=explorer|worker and a non-empty task",
            code="SUBAGENT_REQUEST_INVALID",
            details={"validation_errors": validation_errors},
        ) from exc


def create_delegate_subagent_tool(handler: ToolHandler) -> FunctionTool:
    return FunctionTool(
        name=DELEGATE_SUBAGENT_TOOL_NAME,
        description=DELEGATE_SUBAGENT_TOOL_DESCRIPTION,
        parameters=DELEGATE_SUBAGENT_PARAMETERS,
        handler=handler,
    )


def parse_continue_subagent_request(args: dict[str, Any]) -> ContinueSubagentRequest:
    try:
        return ContinueSubagentRequest.model_validate(args)
    except ValidationError as exc:
        validation_errors = [
            {
                "type": item["type"],
                "loc": [str(part) for part in item["loc"]],
                "message": item["msg"],
            }
            for item in exc.errors(include_input=False)
        ]
        raise ToolExecutionError(
            "continue_subagent requires exactly subagent_id and a non-empty task",
            code="SUBAGENT_CONTINUE_REQUEST_INVALID",
            details={"validation_errors": validation_errors},
        ) from exc


def create_continue_subagent_tool(handler: ToolHandler) -> FunctionTool:
    return FunctionTool(
        name=CONTINUE_SUBAGENT_TOOL_NAME,
        description=CONTINUE_SUBAGENT_TOOL_DESCRIPTION,
        parameters=CONTINUE_SUBAGENT_PARAMETERS,
        handler=handler,
    )
