from __future__ import annotations

from typing import Any, Literal

from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

PlanStatus = Literal["pending", "in_progress", "completed"]
VALID_PLAN_STATUSES: set[str] = {"pending", "in_progress", "completed"}


def create_plan_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="update_plan",
            description="同步当前任务计划快照，用于前端计划卡片和历史恢复。",
            parameters={
                "type": "object",
                "properties": {
                    "explanation": {
                        "type": "string",
                        "description": "可选计划说明，解释这次计划调整的原因。",
                    },
                    "plan": {
                        "type": "array",
                        "description": "完整计划步骤快照。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step": {"type": "string", "description": "计划步骤内容。"},
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"],
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
    active = next((entry["content"] for entry in entries if entry["status"] == "in_progress"), None)

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
            "active": active,
        },
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
