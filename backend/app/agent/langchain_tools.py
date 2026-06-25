from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from langchain_core.tools import StructuredTool

from backend.app.tools import LocalTool, ToolExecutionContext, ToolRegistry


def _json_result(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def local_tool_to_langchain_tool(
    tool: LocalTool,
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> StructuredTool:
    async def _run(**kwargs: Any) -> str:
        result = await tool.run(dict(kwargs), context_factory())
        if result.ok:
            return _json_result(result.result)
        return _json_result(_failed_tool_payload(tool.name, result.error))

    _run.__name__ = tool.name
    _run.__doc__ = tool.description or tool.name
    return StructuredTool.from_function(
        coroutine=_run,
        name=tool.name,
        description=tool.description or tool.name,
        args_schema=tool.parameters,
    )


def _failed_tool_payload(tool_name: str, error: dict[str, Any] | None) -> dict[str, Any]:
    normalized_error = error or {"code": "tool_failed", "message": "工具执行失败", "details": {}}
    code = str(normalized_error.get("code") or "tool_failed")
    message = str(normalized_error.get("message") or "工具执行失败")
    details = normalized_error.get("details")
    if not isinstance(details, dict):
        details = {}
    return {
        "tool": tool_name,
        "ok": False,
        "status": "failed",
        "code": code,
        "message": message,
        "details": details,
        "error": normalized_error,
        "tool_summary": f"工具 {tool_name} 执行失败：{message}（错误码：{code}）。",
    }


def registry_to_langchain_tools(
    registry: ToolRegistry,
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> list[StructuredTool]:
    return [
        local_tool_to_langchain_tool(tool, context_factory=context_factory)
        for tool in registry.list()
    ]
