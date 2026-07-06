from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
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
    async def _run(config: RunnableConfig, **kwargs: Any) -> str:
        result = await tool.run(dict(kwargs), _context_for_tool(tool, context_factory(), config))
        if result.ok:
            return _json_result(_successful_tool_payload(result))
        return _json_result(_failed_tool_payload(tool.name, result.error, result.metadata))

    _run.__name__ = tool.name
    _run.__doc__ = tool.description or tool.name
    return StructuredTool.from_function(
        coroutine=_run,
        name=tool.name,
        description=tool.description or tool.name,
        args_schema=tool.parameters,
        metadata=_langchain_tool_metadata(tool),
    )


def _context_for_tool(
    tool: LocalTool,
    context: ToolExecutionContext,
    config: RunnableConfig | None,
) -> ToolExecutionContext:
    metadata = dict(context.metadata)
    metadata["tool_name"] = tool.name
    if config:
        run_id = str(config.get("run_id") or "").strip()
        if run_id:
            metadata["run_id"] = run_id
        tool_call_id = str(config.get("tool_call_id") or "").strip()
        if tool_call_id:
            metadata["tool_call_id"] = tool_call_id
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            for key in ("run_id", "tool_call_id"):
                value = str(configurable.get(key) or "").strip()
                if value:
                    metadata[key] = value
        config_metadata = config.get("metadata")
        if isinstance(config_metadata, dict):
            for key in ("run_id", "tool_call_id", "langgraph_node"):
                value = str(config_metadata.get(key) or "").strip()
                if value:
                    metadata[key] = value
    return ToolExecutionContext(
        session_id=context.session_id,
        user_id=context.user_id,
        workspace_root=context.workspace_root,
        turn_index=context.turn_index,
        trace_id=context.trace_id,
        metadata=metadata,
    )


def _successful_tool_payload(result: Any) -> Any:
    metadata = getattr(result, "metadata", None)
    if not metadata:
        return result.result
    if isinstance(result.result, dict):
        existing_metadata = result.result.get("metadata")
        if isinstance(existing_metadata, dict):
            return {
                **result.result,
                "metadata": _merge_result_metadata(existing_metadata, metadata),
            }
        return {**result.result, "metadata": metadata}
    return {"result": result.result, "metadata": metadata}


def _failed_tool_payload(
    tool_name: str,
    error: dict[str, Any] | None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
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
        **({"metadata": metadata} if metadata else {}),
    }


def _langchain_tool_metadata(tool: LocalTool) -> dict[str, Any] | None:
    metadata = getattr(tool, "metadata", None)
    if metadata is None:
        return None
    to_dict = getattr(metadata, "to_dict", None)
    if callable(to_dict):
        return {"mcp": to_dict()}
    if isinstance(metadata, dict):
        return dict(metadata)
    return None


def _merge_result_metadata(
    existing: dict[str, Any],
    extra: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in extra.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def registry_to_langchain_tools(
    registry: ToolRegistry,
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> list[StructuredTool]:
    return tools_to_langchain_tools(
        registry.list(),
        context_factory=context_factory,
    )


def tools_to_langchain_tools(
    tools: Sequence[LocalTool],
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> list[StructuredTool]:
    return [
        local_tool_to_langchain_tool(tool, context_factory=context_factory)
        for tool in tools
        if tool.enabled
    ]
