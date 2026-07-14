from __future__ import annotations

from typing import Any, Literal

from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

PlanStatus = Literal["pending", "in_progress", "completed", "failed"]
VALID_PLAN_STATUSES: set[str] = {"pending", "in_progress", "completed", "failed"}


def create_plan_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="update_plan",
            description=(
                "创建或更新当前任务的完整执行计划，并向用户同步真实进度。"
                "对预计需要至少 3 个有意义动作、包含多项用户要求、涉及多个文件或资源、"
                "存在先后依赖或需要先调研再实施的任务，应主动使用本工具；"
                "简单问答、单条命令、一个局部小修改或能够立即完成的任务不要使用。"
                "首次调用应发生在开始实质工作前，计划通常包含 3～7 个简短、可验证的步骤，"
                "并将当前步骤设为 in_progress。"
                "每次调用都必须发送包含全部步骤的最新完整快照。"
                "只要仍有工作需要推进，就应恰好有一个步骤处于 in_progress。"
                "完成或确认失败一个步骤后，应在开始下一步骤前立即再次调用本工具，"
                "将当前步骤更新为 completed 或 failed，并将下一步骤更新为 in_progress。"
                "任务范围变化时，发送调整后的完整计划并通过 explanation 说明原因。"
                "任何时候最多只能有一个步骤处于 in_progress。"
                "最终回复前不得遗留 pending 或 in_progress；"
                "全部完成时应将所有步骤标记为 completed。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "explanation": {
                        "type": "string",
                        "description": (
                            "可选计划调整说明。首次创建通常无需填写；新增、删除、拆分、"
                            "合并或重新排序步骤时，应说明调整原因。"
                        ),
                    },
                    "plan": {
                        "type": "array",
                        "description": "当前任务的完整计划快照，不是本次发生变化的局部步骤。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step": {
                                    "type": "string",
                                    "description": "简短、具体、可验证的阶段结果。",
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed", "failed"],
                                },
                            },
                            "required": ["step", "status"],
                        },
                    },
                },
                "required": ["plan"],
            },
            handler=update_plan_tool,
        )
    ]


def register_plan_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_plan_tools():
        registry.register(tool)
    return registry


async def update_plan_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    raw_plan = args.get("plan")
    entries = _normalize_plan(raw_plan)
    explanation = _optional_text(args.get("explanation"))
    completed = sum(1 for entry in entries if entry["status"] == "completed")
    failed = sum(1 for entry in entries if entry["status"] == "failed")
    active = next((entry["content"] for entry in entries if entry["status"] == "in_progress"), None)
    has_pending = any(entry["status"] == "pending" for entry in entries)

    if active:
        model_guidance = (
            f"计划已同步。继续执行当前 in_progress 步骤“{active}”；"
            "该步骤完成或失败后，在开始下一步骤前再次调用 update_plan，并发送完整计划快照。"
        )
    elif has_pending:
        model_guidance = (
            "计划已同步，但仍有 pending 步骤且当前没有 in_progress。"
            "继续工作前请再次调用 update_plan，将下一步骤设为 in_progress。"
        )
    else:
        model_guidance = (
            "计划已同步，当前没有 pending 或 in_progress 步骤。"
            "如果任务已经结束，可以进行最终回复；如果仍有工作，请先更新计划。"
        )

    ui_payload = {
        "explanation": explanation,
        "entries": entries,
    }
    return {
        "explanation": explanation,
        "plan": [{"step": entry["content"], "status": entry["status"]} for entry in entries],
        "entries": entries,
        "ui_payload": ui_payload,
        "summary": {
            "total": len(entries),
            "completed": completed,
            "failed": failed,
            "active": active,
        },
        "model_guidance": model_guidance,
        "session_id": context.session_id,
        "turn_index": context.turn_index,
    }


def _normalize_plan(raw_plan: Any) -> list[dict[str, PlanStatus]]:
    if not isinstance(raw_plan, list) or not raw_plan:
        raise ToolExecutionError("plan 必须是非空数组", code="invalid_tool_args")

    entries: list[dict[str, PlanStatus]] = []
    active_count = 0
    for index, raw_entry in enumerate(raw_plan):
        if not isinstance(raw_entry, dict):
            raise ToolExecutionError(
                "plan 每一项必须是对象",
                code="invalid_tool_args",
                details={"index": index},
            )
        content = _required_text(raw_entry.get("step", raw_entry.get("content")), index=index)
        status = _normalize_status(raw_entry.get("status"), index=index)
        if status == "in_progress":
            active_count += 1
        entries.append({"content": content, "status": status})

    if active_count > 1:
        raise ToolExecutionError(
            "同一份计划最多只能有一个进行中步骤",
            code="invalid_plan_state",
            details={"in_progress_count": active_count},
        )
    return entries


def _normalize_status(value: Any, *, index: int) -> PlanStatus:
    if value not in VALID_PLAN_STATUSES:
        raise ToolExecutionError(
            "计划状态非法",
            code="invalid_plan_status",
            details={
                "index": index,
                "status": value,
                "allowed": sorted(VALID_PLAN_STATUSES),
            },
        )
    return value


def _required_text(value: Any, *, index: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ToolExecutionError(
            "计划步骤内容不能为空",
            code="invalid_tool_args",
            details={"index": index},
        )
    return value.strip()


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ToolExecutionError("explanation 必须是字符串", code="invalid_tool_args")
    stripped = value.strip()
    return stripped or None
