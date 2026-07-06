from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.app.agent.langchain_tools import tools_to_langchain_tools
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.tools import (
    DEFERRED_LIST_TOOL_NAME,
    DEFERRED_SEARCH_TOOL_NAME,
    McpActiveToolWindow,
    McpToolCallContext,
    mcp_deferred_tools_from_snapshot,
    mcp_local_tools_from_snapshot,
)
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import McpRuntimeSnapshotRecord
from backend.app.tools.base import ToolExecutionContext, ToolExecutionResult


class FakeMcpExecutor:
    def __init__(
        self,
        result: Any = None,
        *,
        error: BaseException | None = None,
    ) -> None:
        self.result = result if result is not None else {"content": "ok"}
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def execute_tool(
        self,
        *,
        snapshot_id: str,
        server_id: str,
        raw_tool_name: str,
        arguments: dict[str, Any],
        call_context: McpToolCallContext,
    ) -> Any:
        self.calls.append(
            {
                "snapshot_id": snapshot_id,
                "server_id": server_id,
                "raw_tool_name": raw_tool_name,
                "arguments": arguments,
                "call_context": call_context,
            }
        )
        if self.error is not None:
            raise self.error
        return self.result


def _snapshot(*, visible_tools: list[dict[str, Any]]) -> McpRuntimeSnapshotRecord:
    return McpRuntimeSnapshotRecord(
        id="snap_1",
        session_id="session-a",
        turn_id="turn-1",
        tool_inventory_revision=1,
        visible_tools=visible_tools,
        server_status={},
        policy_summary={},
        created_at="2026-07-06T00:00:00Z",
    )


def _contract(
    raw_name: str = "search",
    *,
    exposure: str = "direct",
    description: str | None = "Exact MCP tool description",
) -> dict[str, Any]:
    return {
        "server_id": "srv_tools",
        "server_name": "Tools MCP",
        "raw_name": raw_name,
        "model_name": f"mcp__srv_tools__{raw_name}",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
        "risk_level": "high",
        "approval_mode": "prompt",
        "exposure": exposure,
        "annotations": {"readOnlyHint": False},
    }


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-a",
        user_id="user-a",
        workspace_root=tmp_path,
        turn_index=3,
        trace_id="trace-a",
        metadata={"tool_call_id": "call-a", "run_id": "run-a"},
    )


@pytest.mark.asyncio
async def test_mcp_local_tool_metadata_and_fake_executor_call(tmp_path) -> None:
    executor = FakeMcpExecutor(result=ToolExecutionResult.success({"answer": 42}))
    tools = mcp_local_tools_from_snapshot(
        _snapshot(visible_tools=[_contract()]),
        executor,
    )

    result = await tools[0].run({"query": "status"}, _context(tmp_path))

    assert result.ok is True
    assert result.result == {"answer": 42}
    assert result.metadata["mcp"]["snapshot_id"] == "snap_1"
    assert tools[0].name == "mcp__srv_tools__search"
    assert tools[0].description == "Exact MCP tool description"
    assert tools[0].parameters == _contract()["input_schema"]
    assert tools[0].metadata.raw_tool_name == "search"
    assert executor.calls == [
        {
            "snapshot_id": "snap_1",
            "server_id": "srv_tools",
            "raw_tool_name": "search",
            "arguments": {"query": "status"},
            "call_context": executor.calls[0]["call_context"],
        }
    ]
    call_context = executor.calls[0]["call_context"]
    assert call_context.tool_call_id == "call-a"
    assert call_context.run_id == "run-a"
    assert call_context.risk_level == "high"
    assert call_context.approval_mode == "prompt"
    assert result.metadata["mcp"]["kind"] == "mcp_tool"
    assert result.metadata["mcp"]["server_name"] == "Tools MCP"
    assert result.metadata["mcp"]["model_tool_name"] == "mcp__srv_tools__search"


def test_mcp_local_tool_preserves_description_and_langchain_schema(tmp_path) -> None:
    tool = mcp_local_tools_from_snapshot(
        _snapshot(visible_tools=[_contract(description="Use exactly this text.")]),
        FakeMcpExecutor(),
    )[0]

    langchain_tool = tools_to_langchain_tools(
        [tool],
        context_factory=lambda: _context(tmp_path),
    )[0]

    assert tool.description == "Use exactly this text."
    assert "high" not in tool.description
    assert "prompt" not in tool.description
    assert tool.to_tool_spec().description == "Use exactly this text."
    assert tool.to_tool_spec().parameters == _contract()["input_schema"]
    assert langchain_tool.description == "Use exactly this text."
    assert langchain_tool.args_schema == tool.parameters
    assert langchain_tool.metadata["mcp"]["kind"] == "mcp_tool"
    assert langchain_tool.metadata["mcp"]["server_id"] == "srv_tools"
    assert langchain_tool.metadata["mcp"]["server_name"] == "Tools MCP"


def test_mcp_local_tools_skip_deferred_contracts_by_default() -> None:
    tools = mcp_local_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("direct", exposure="direct"),
                _contract("candidate", exposure="deferred"),
            ]
        ),
        FakeMcpExecutor(),
    )

    assert [tool.name for tool in tools] == ["mcp__srv_tools__direct"]


@pytest.mark.asyncio
async def test_mcp_deferred_search_and_list_tools_activate_candidates(tmp_path) -> None:
    active_window = McpActiveToolWindow(time_provider=lambda: 1000.0)
    tools = mcp_deferred_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("direct", exposure="direct"),
                _contract("candidate", exposure="deferred", description="Find the target"),
                _contract("other", exposure="deferred", description="Other tool"),
            ]
        ),
        active_window,
        ttl_sec=30,
    )

    assert [tool.name for tool in tools] == [
        DEFERRED_SEARCH_TOOL_NAME,
        DEFERRED_LIST_TOOL_NAME,
    ]

    search_result = await tools[0].run({"query": "target"}, _context(tmp_path))

    assert search_result.ok is True
    assert search_result.result["action"] == "search"
    assert search_result.result["count"] == 1
    assert search_result.result["tools"][0]["raw_name"] == "candidate"
    assert search_result.result["tools"][0]["model_name"] == "mcp__srv_tools__candidate"
    assert search_result.result["activation"]["available_next_turn"] is True
    assert active_window.active_model_names("session-a") == {"mcp__srv_tools__candidate"}

    list_result = await tools[1].run({"limit": 2}, _context(tmp_path))

    assert list_result.ok is True
    assert [item["raw_name"] for item in list_result.result["tools"]] == [
        "candidate",
        "other",
    ]
    assert active_window.active_model_names("session-a") == {
        "mcp__srv_tools__candidate",
        "mcp__srv_tools__other",
    }


@pytest.mark.asyncio
async def test_mcp_local_tool_converts_runtime_error_to_tool_execution_result(
    tmp_path,
) -> None:
    executor = FakeMcpExecutor(
        error=McpRuntimeError(
            McpErrorCode.AUTH_REQUIRED,
            detail={"server_status": "auth_required"},
        )
    )
    tool = mcp_local_tools_from_snapshot(
        _snapshot(visible_tools=[_contract()]),
        executor,
    )[0]

    result = await tool.run({"query": "status"}, _context(tmp_path))

    assert result.ok is False
    assert result.error is not None
    assert result.error["code"] == "auth_required"
    assert result.error["details"]["server_status"] == "auth_required"
    assert result.error["details"]["mcp"]["server_id"] == "srv_tools"
