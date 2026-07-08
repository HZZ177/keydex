from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool
from langgraph.prebuilt import ToolRuntime

from backend.app.a2ui.registry import A2UIRegistry, A2UIToolDefinition
from backend.app.tools import ToolExecutionContext

A2UIToolHandler = Callable[
    [A2UIToolDefinition, dict[str, Any], ToolExecutionContext, RunnableConfig | None],
    Awaitable[str | dict[str, Any]],
]


class _A2UIStructuredTool(StructuredTool):
    def _to_args_and_kwargs(
        self,
        tool_input: str | dict[str, Any],
        tool_call_id: str | None,
    ) -> tuple[tuple[Any, ...], dict[str, Any]]:
        args, kwargs = super()._to_args_and_kwargs(tool_input, tool_call_id)
        kwargs.pop("tool_call_id", None)
        if tool_call_id:
            kwargs["tool_call_id"] = tool_call_id
        return args, kwargs


def a2ui_registry_to_langchain_tools(
    registry: A2UIRegistry,
    *,
    context_factory: Callable[[], ToolExecutionContext],
    handler: A2UIToolHandler,
) -> list[StructuredTool]:
    return a2ui_tools_to_langchain_tools(
        registry.definitions,
        context_factory=context_factory,
        handler=handler,
    )


def a2ui_tools_to_langchain_tools(
    definitions: Sequence[A2UIToolDefinition],
    *,
    context_factory: Callable[[], ToolExecutionContext],
    handler: A2UIToolHandler,
) -> list[StructuredTool]:
    return [
        a2ui_tool_to_langchain_tool(
            definition,
            context_factory=context_factory,
            handler=handler,
        )
        for definition in definitions
    ]


def a2ui_tool_to_langchain_tool(
    definition: A2UIToolDefinition,
    *,
    context_factory: Callable[[], ToolExecutionContext],
    handler: A2UIToolHandler,
) -> StructuredTool:
    async def _run(
        runtime: ToolRuntime | None = None,
        config: RunnableConfig | None = None,
        tool_call_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        resolved_tool_call_id = str(
            tool_call_id or getattr(runtime, "tool_call_id", "") or ""
        ).strip()
        result = await handler(
            definition,
            dict(kwargs),
            _context_for_a2ui_tool(context_factory(), config, resolved_tool_call_id),
            config,
        )
        return _stringify_tool_result(result)

    _run.__name__ = definition.render_key
    _run.__doc__ = definition.tool_description
    return _A2UIStructuredTool.from_function(
        coroutine=_run,
        name=definition.render_key,
        description=definition.tool_description,
        args_schema=definition.input_schema,
        metadata=_a2ui_tool_metadata(definition),
    )


def _a2ui_tool_metadata(definition: A2UIToolDefinition) -> dict[str, Any]:
    return {
        "a2ui": {
            "render_key": definition.render_key,
            "mode": definition.mode,
            "stream_enabled": definition.stream_enabled,
        }
    }


def _context_for_a2ui_tool(
    context: ToolExecutionContext,
    config: RunnableConfig | None,
    tool_call_id: str | None,
) -> ToolExecutionContext:
    metadata = dict(context.metadata)
    if config:
        run_id = _config_text(config, "run_id")
        if run_id:
            metadata["run_id"] = run_id
        config_tool_call_id = _config_text(config, "tool_call_id")
        if config_tool_call_id:
            metadata["tool_call_id"] = config_tool_call_id
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            for key in ("run_id", "tool_call_id"):
                value = _dict_text(configurable, key)
                if value:
                    metadata[key] = value
        config_metadata = config.get("metadata")
        if isinstance(config_metadata, dict):
            for key in ("run_id", "tool_call_id", "langgraph_node"):
                value = _dict_text(config_metadata, key)
                if value:
                    metadata[key] = value
    if tool_call_id:
        metadata["tool_call_id"] = tool_call_id
    return ToolExecutionContext(
        session_id=context.session_id,
        user_id=context.user_id,
        workspace_root=context.workspace_root,
        turn_index=context.turn_index,
        trace_id=context.trace_id,
        metadata=metadata,
    )


def _config_text(config: RunnableConfig, key: str) -> str:
    return str(config.get(key) or "").strip()


def _dict_text(values: dict[str, Any], key: str) -> str:
    return str(values.get(key) or "").strip()


def _stringify_tool_result(value: str | dict[str, Any]) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)
