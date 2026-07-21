from __future__ import annotations

import json
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from backend.app.agent.langchain_tools import local_tool_to_langchain_tool
from backend.app.agent.tool_results.specialized import subagent_result_projector
from backend.app.tools.base import (
    FunctionTool,
    ToolExecutionContext,
    ToolExecutionError,
)


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
    )


@pytest.mark.asyncio
async def test_langchain_tool_returns_projected_content_and_equivalent_artifact(
    tmp_path: Path,
) -> None:
    tool = FunctionTool(
        name="example",
        description="example",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: {"items": [{"path": "a.py", "line": 2}]},
    )
    langchain_tool = local_tool_to_langchain_tool(
        tool,
        context_factory=lambda: _context(tmp_path),
    )

    output = await langchain_tool.ainvoke(
        {"type": "tool_call", "id": "call-1", "name": "example", "args": {}}
    )

    assert isinstance(output, ToolMessage)
    assert output.tool_call_id == "call-1"
    assert json.loads(output.content) == output.artifact["display_payload"]
    assert "_keydex_projection" not in output.content
    assert output.artifact["schema_version"] == "keydex.tool_artifact.v1"
    assert output.artifact["projection"]["truncated"] is False
    assert "full_payload" not in output.artifact


@pytest.mark.asyncio
async def test_direct_langchain_invoke_preserves_content_compatibility(tmp_path: Path) -> None:
    tool = FunctionTool(
        name="example",
        description="example",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: {"value": 7},
    )
    langchain_tool = local_tool_to_langchain_tool(
        tool,
        context_factory=lambda: _context(tmp_path),
    )
    payload = json.loads(await langchain_tool.ainvoke({}))
    assert payload["value"] == 7


@pytest.mark.asyncio
async def test_subagent_report_reaches_parent_agent_without_projection_truncation(
    tmp_path: Path,
) -> None:
    report = "完整调查证据\n" * 20_000
    tool = FunctionTool(
        name="delegate_subagent",
        description="delegate",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: {
            "schema_version": "keydex.subagent.v1",
            "state": "completed",
            "subagent_id": "sub-1",
            "run_id": "run-1",
            "child_session_id": "child-1",
            "role": "explorer",
            "ok": True,
            "final_report": report,
            "report_truncated": False,
        },
        result_projector=subagent_result_projector,
    )
    adapted = local_tool_to_langchain_tool(tool, context_factory=lambda: _context(tmp_path))

    output = await adapted.ainvoke(
        {"type": "tool_call", "id": "call-subagent", "name": tool.name, "args": {}}
    )

    assert isinstance(output, ToolMessage)
    payload = json.loads(output.content)
    assert len(output.content.encode("utf-8")) > 32 * 1024
    assert payload["final_report"] == report
    assert payload["report_truncated"] is False
    assert "_keydex_projection" not in payload
    assert output.artifact["projection"]["truncated"] is False
    assert output.artifact["persisted_ref"] is None


@pytest.mark.asyncio
async def test_failed_tool_keeps_existing_error_content_without_success_artifact(
    tmp_path: Path,
) -> None:
    def fail(_args, _context):
        raise ToolExecutionError("missing", code="missing")

    tool = FunctionTool(
        name="example",
        description="example",
        parameters={"type": "object", "properties": {}},
        handler=fail,
    )
    langchain_tool = local_tool_to_langchain_tool(
        tool,
        context_factory=lambda: _context(tmp_path),
    )
    output = await langchain_tool.ainvoke(
        {"type": "tool_call", "id": "call-2", "name": "example", "args": {}}
    )
    assert isinstance(output, ToolMessage)
    assert json.loads(output.content)["error"]["code"] == "missing"
    assert output.artifact is None


@pytest.mark.asyncio
async def test_internal_governance_is_checkpointed_but_not_sent_in_model_content(
    tmp_path: Path,
) -> None:
    tool = FunctionTool(
        name="search_text",
        description="search",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: {"results": []},
    )

    class Guard:
        async def before_tool(self, **_kwargs):
            return object()

        async def after_tool(self, _reservation, **_kwargs):
            return {
                "exploration": {
                    "kind": "wide_discovery",
                    "reason": "workspace_root_search",
                    "scope_key": ".",
                }
            }

    context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"exploration_guard": Guard()},
    )
    adapted = local_tool_to_langchain_tool(tool, context_factory=lambda: context)

    output = await adapted.ainvoke(
        {"type": "tool_call", "id": "call-guard", "name": tool.name, "args": {}}
    )

    assert "workspace_root_search" not in output.content
    assert output.artifact["governance"]["exploration"]["kind"] == "wide_discovery"
