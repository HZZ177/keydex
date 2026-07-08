from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from backend.app.a2ui.registry import build_builtin_a2ui_registry
from backend.app.a2ui.tools import a2ui_registry_to_langchain_tools
from backend.app.tools import ToolExecutionContext


def test_a2ui_registry_to_langchain_tools_uses_render_key_names_and_metadata(tmp_path) -> None:
    tools = a2ui_registry_to_langchain_tools(
        build_builtin_a2ui_registry(),
        context_factory=lambda: _context(tmp_path),
        handler=_echo_handler,
    )

    by_name = {tool.name: tool for tool in tools}
    assert set(by_name) == {"chart", "choice", "form"}
    assert by_name["chart"].metadata == {
        "a2ui": {"render_key": "chart", "mode": "render", "stream_enabled": True}
    }
    assert by_name["choice"].metadata == {
        "a2ui": {"render_key": "choice", "mode": "interactive", "stream_enabled": True}
    }
    assert by_name["choice"].args_schema["type"] == "object"
    assert by_name["form"].description


@pytest.mark.asyncio
async def test_a2ui_langchain_tool_invokes_handler_with_definition_args_and_context(
    tmp_path,
) -> None:
    captured: dict[str, Any] = {}

    async def handler(definition, args, context, config):
        captured["definition"] = definition
        captured["args"] = args
        captured["context"] = context
        captured["config"] = config
        return {"ok": True, "render_key": definition.render_key, "args": args}

    tool = a2ui_registry_to_langchain_tools(
        build_builtin_a2ui_registry(),
        context_factory=lambda: _context(tmp_path),
        handler=handler,
    )[1]

    payload = json.loads(await tool.ainvoke({
        "title": "选择方案",
        "options": [{"label": "方案 A", "value": "a"}],
    }))

    assert tool.name == "choice"
    assert payload == {
        "ok": True,
        "render_key": "choice",
        "args": {"title": "选择方案", "options": [{"label": "方案 A", "value": "a"}]},
    }
    assert captured["definition"].render_key == "choice"
    assert captured["args"] == {"title": "选择方案", "options": [{"label": "方案 A", "value": "a"}]}
    assert captured["context"].session_id == "session-1"


@pytest.mark.asyncio
async def test_a2ui_langchain_tool_injects_tool_call_id_from_tool_call(
    tmp_path,
) -> None:
    captured: dict[str, Any] = {}

    async def handler(definition, args, context, config):
        captured["args"] = args
        captured["metadata"] = dict(context.metadata)
        return {"ok": True}

    tool = a2ui_registry_to_langchain_tools(
        build_builtin_a2ui_registry(),
        context_factory=lambda: _context(tmp_path),
        handler=handler,
    )[1]

    payload = await tool.ainvoke(
        {
            "type": "tool_call",
            "id": "call-choice-1",
            "name": "choice",
            "args": {"title": "选择方案", "options": [{"label": "方案 A", "value": "a"}]},
        }
    )

    assert json.loads(payload.content) == {"ok": True}
    assert payload.tool_call_id == "call-choice-1"
    assert captured["args"] == {"title": "选择方案", "options": [{"label": "方案 A", "value": "a"}]}
    assert captured["metadata"]["tool_call_id"] == "call-choice-1"


async def _echo_handler(definition, args, context, config):
    return {
        "render_key": definition.render_key,
        "args": args,
        "session_id": context.session_id,
    }


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-1",
    )
