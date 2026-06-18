from __future__ import annotations

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.plan import register_plan_tools


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_plan",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=3,
    )


def _registry() -> ToolRegistry:
    return register_plan_tools(ToolRegistry())


async def _run(args: dict, tmp_path):
    return await _registry().require("update_plan").run(args, _context(tmp_path))


async def test_update_plan_tool_creates_plan_ui_payload(tmp_path) -> None:
    result = await _run(
        {
            "explanation": "先搭骨架，再补测试",
            "plan": [
                {"step": "分析需求", "status": "completed"},
                {"step": "实现工具", "status": "in_progress"},
                {"step": "补充测试", "status": "pending"},
            ],
        },
        tmp_path,
    )

    assert result.ok is True
    assert result.result["ui_payload"] == {
        "explanation": "先搭骨架，再补测试",
        "entries": [
            {"content": "分析需求", "status": "completed"},
            {"content": "实现工具", "status": "in_progress"},
            {"content": "补充测试", "status": "pending"},
        ],
    }
    assert result.result["summary"] == {
        "total": 3,
        "completed": 1,
        "active": "实现工具",
    }
    assert result.result["session_id"] == "ses_plan"
    assert result.result["turn_index"] == 3


async def test_update_plan_tool_accepts_content_alias_for_history_payload(tmp_path) -> None:
    result = await _run(
        {
            "plan": [
                {"content": "分析需求", "status": "completed"},
                {"content": "验证结果", "status": "completed"},
            ],
        },
        tmp_path,
    )

    assert result.ok is True
    assert result.result["plan"] == [
        {"step": "分析需求", "status": "completed"},
        {"step": "验证结果", "status": "completed"},
    ]
    assert result.result["ui_payload"]["entries"][1] == {
        "content": "验证结果",
        "status": "completed",
    }


async def test_update_plan_tool_rejects_invalid_status(tmp_path) -> None:
    result = await _run(
        {"plan": [{"step": "错误状态", "status": "doing"}]},
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_plan_status"


async def test_update_plan_tool_rejects_multiple_active_steps(tmp_path) -> None:
    result = await _run(
        {
            "plan": [
                {"step": "实现 A", "status": "in_progress"},
                {"step": "实现 B", "status": "in_progress"},
            ]
        },
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_plan_state"


async def test_update_plan_tool_rejects_empty_plan(tmp_path) -> None:
    result = await _run({"plan": []}, tmp_path)

    assert result.ok is False
    assert result.error["code"] == "invalid_tool_args"
