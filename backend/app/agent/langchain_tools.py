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
        return _json_result(result.error or {"code": "tool_failed", "message": "工具执行失败"})

    _run.__name__ = tool.name
    _run.__doc__ = tool.description or tool.name
    return StructuredTool.from_function(
        coroutine=_run,
        name=tool.name,
        description=tool.description or tool.name,
        args_schema=tool.parameters,
    )


def registry_to_langchain_tools(
    registry: ToolRegistry,
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> list[StructuredTool]:
    return [
        local_tool_to_langchain_tool(tool, context_factory=context_factory)
        for tool in registry.list()
    ]
