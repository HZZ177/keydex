from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from backend.app.agent.langchain_tools import tools_to_langchain_tools
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.tools import (
    MCP_CAPABILITY_DISCOVERY_TOOL_NAME,
    McpActiveToolWindow,
    McpToolCallContext,
    mcp_capability_discovery_tools_from_snapshot,
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


def _snapshot(
    *,
    visible_tools: list[dict[str, Any]],
    policy_summary: dict[str, Any] | None = None,
    capability_directory: list[dict[str, Any]] | None = None,
) -> McpRuntimeSnapshotRecord:
    return McpRuntimeSnapshotRecord(
        id="snap_1",
        session_id="session-a",
        turn_id="turn-1",
        tool_inventory_revision=1,
        visible_tools=visible_tools,
        server_status={},
        policy_summary=policy_summary or {},
        capability_directory=capability_directory or [],
        created_at="2026-07-06T00:00:00Z",
    )


def _contract(
    raw_name: str = "search",
    *,
    server_name: str = "Tools MCP",
    exposure: str = "direct",
    description: str | None = "Exact MCP tool description",
    input_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "server_id": "srv_tools",
        "server_name": server_name,
        "raw_name": raw_name,
        "model_name": f"mcp__srv_tools__{raw_name}",
        "description": description,
        "input_schema": input_schema or {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
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


def _large_schema(marker: str) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            f"param_{index}": {
                "type": "string",
                "title": f"Parameter {index}",
                "description": f"{marker} field {index}",
            }
            for index in range(12)
        },
        "required": ["param_0"],
    }


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
    assert "prompt" not in tool.description
    assert tool.to_tool_spec().description == "Use exactly this text."
    assert tool.to_tool_spec().parameters == _contract()["input_schema"]
    assert langchain_tool.description == "Use exactly this text."
    assert langchain_tool.args_schema == tool.parameters
    assert langchain_tool.metadata["mcp"]["kind"] == "mcp_tool"
    assert langchain_tool.metadata["mcp"]["server_id"] == "srv_tools"
    assert langchain_tool.metadata["mcp"]["server_name"] == "Tools MCP"


def test_mcp_local_tool_preserves_complete_large_direct_schema(tmp_path) -> None:
    schema = _large_schema("direct_large_schema_marker")
    tool = mcp_local_tools_from_snapshot(
        _snapshot(visible_tools=[_contract(input_schema=schema)]),
        FakeMcpExecutor(),
    )[0]

    assert tool.parameters == schema
    assert tool.to_tool_spec().parameters == schema


def test_mcp_local_tools_skip_deferred_contracts_by_default() -> None:
    tools = mcp_local_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("direct", exposure="direct"),
                _contract("candidate", exposure="on_demand"),
            ]
        ),
        FakeMcpExecutor(),
    )

    assert [tool.name for tool in tools] == ["mcp__srv_tools__direct"]


@pytest.mark.asyncio
async def test_mcp_capability_discovery_does_not_emit_large_schema(tmp_path) -> None:
    schema = _large_schema("catalog_schema_marker")
    tools = mcp_capability_discovery_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("candidate", exposure="on_demand", input_schema=schema)
            ],
            capability_directory=[
                {
                    "server_id": "srv_tools",
                    "server_name": "工具服务",
                    "status": "online",
                    "status_label": "在线",
                    "available_tool_count": 1,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 1,
                    "requires_auth": False,
                    "has_on_demand_tools": True,
                    "capability_keywords": ["candidate"],
                }
            ],
        ),
        McpActiveToolWindow(),
    )

    directory = await tools[0].run({}, _context(tmp_path))
    search = await tools[0].run({"query": "candidate"}, _context(tmp_path))
    serialized = json.dumps(
        {"directory": directory.result, "search": search.result},
        ensure_ascii=False,
    )

    assert directory.ok is True
    assert search.ok is True
    assert search.result["tools"][0]["raw_name"] == "candidate"
    assert "input_schema" not in serialized
    assert "catalog_schema_marker" not in serialized


@pytest.mark.asyncio
async def test_mcp_capability_discovery_tool_lists_and_activates_candidates(tmp_path) -> None:
    active_window = McpActiveToolWindow(time_provider=lambda: 1000.0)
    tools = mcp_capability_discovery_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("direct", exposure="direct"),
                _contract("candidate", exposure="on_demand", description="Find the target"),
                _contract("other", exposure="on_demand", description="Other tool"),
            ]
        ),
        active_window,
        ttl_sec=30,
    )

    assert [tool.name for tool in tools] == [MCP_CAPABILITY_DISCOVERY_TOOL_NAME]

    directory_result = await tools[0].run({"limit": 2}, _context(tmp_path))

    assert directory_result.ok is True
    assert directory_result.result["action"] == "directory"
    assert directory_result.result["servers"] == []
    assert [item["raw_name"] for item in directory_result.result["tools"]] == [
        "candidate",
        "other",
    ]
    assert directory_result.result["activation"]["activated"] is False
    assert active_window.active_model_names("session-a") == set()

    search_result = await tools[0].run({"query": "target"}, _context(tmp_path))

    assert search_result.ok is True
    assert search_result.result["action"] == "search"
    assert search_result.result["count"] == 1
    assert search_result.result["tools"][0]["raw_name"] == "candidate"
    assert search_result.result["tools"][0]["model_name"] == "mcp__srv_tools__candidate"
    assert search_result.result["activation"]["activated"] is True
    assert active_window.active_model_names("session-a") == {"mcp__srv_tools__candidate"}


@pytest.mark.asyncio
async def test_mcp_capability_discovery_directory_returns_server_summaries(tmp_path) -> None:
    active_window = McpActiveToolWindow(time_provider=lambda: 1000.0)
    tools = mcp_capability_discovery_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("candidate", exposure="on_demand", description="Find target"),
            ],
            capability_directory=[
                {
                    "server_id": "srv_tools",
                    "server_name": "知识库服务",
                    "status": "online",
                    "status_label": "在线",
                    "available_tool_count": 1,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 1,
                    "requires_auth": False,
                    "has_on_demand_tools": True,
                    "capability_keywords": ["candidate"],
                },
                {
                    "server_id": "srv_auth",
                    "server_name": "认证服务",
                    "status": "auth_required",
                    "status_label": "需要认证",
                    "available_tool_count": 0,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 0,
                    "requires_auth": True,
                    "has_on_demand_tools": False,
                    "capability_keywords": [],
                },
            ],
        ),
        active_window,
    )

    result = await tools[0].run({}, _context(tmp_path))

    assert result.ok is True
    assert result.result["action"] == "directory"
    assert result.result["activation"]["activated"] is False
    assert result.result["servers"] == [
        {
            "server_id": "srv_tools",
            "server_name": "知识库服务",
            "status": "online",
            "status_label": "在线",
            "available_tool_count": 1,
            "direct_tool_count": 0,
            "on_demand_tool_count": 1,
            "requires_auth": False,
            "has_on_demand_tools": True,
            "capability_keywords": ["candidate"],
        },
        {
            "server_id": "srv_auth",
            "server_name": "认证服务",
            "status": "auth_required",
            "status_label": "需要认证",
            "available_tool_count": 0,
            "direct_tool_count": 0,
            "on_demand_tool_count": 0,
            "requires_auth": True,
            "has_on_demand_tools": False,
            "capability_keywords": [],
        },
    ]
    assert active_window.active_model_names("session-a") == set()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("capability_directory", "expected_reason", "expected_message"),
    [
        ([], "no_servers", "当前没有配置 MCP 服务器。"),
        (
            [
                {
                    "server_id": "srv_auth",
                    "server_name": "认证服务",
                    "status": "auth_required",
                    "status_label": "需要认证",
                    "available_tool_count": 0,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 0,
                    "requires_auth": True,
                    "has_on_demand_tools": False,
                    "capability_keywords": [],
                }
            ],
            "auth_required",
            "MCP 服务器需要认证后才会提供可用工具。",
        ),
        (
            [
                {
                    "server_id": "srv_offline",
                    "server_name": "离线服务",
                    "status": "offline",
                    "status_label": "离线",
                    "available_tool_count": 0,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 0,
                    "requires_auth": False,
                    "has_on_demand_tools": False,
                    "capability_keywords": [],
                }
            ],
            "no_online_servers",
            "当前没有在线可用的 MCP 服务器工具。",
        ),
        (
            [
                {
                    "server_id": "srv_empty",
                    "server_name": "空服务",
                    "status": "online",
                    "status_label": "在线",
                    "available_tool_count": 0,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 0,
                    "requires_auth": False,
                    "has_on_demand_tools": False,
                    "capability_keywords": [],
                }
            ],
            "no_tools",
            "当前 MCP 服务器暂无可用工具，请刷新服务器后再试。",
        ),
        (
            [
                {
                    "server_id": "srv_direct",
                    "server_name": "直接可用服务",
                    "status": "online",
                    "status_label": "在线",
                    "available_tool_count": 2,
                    "direct_tool_count": 2,
                    "on_demand_tool_count": 0,
                    "requires_auth": False,
                    "has_on_demand_tools": False,
                    "capability_keywords": ["read", "write"],
                }
            ],
            "no_on_demand_tools",
            "当前 MCP 工具已直接可用，没有需要按需加载的工具。",
        ),
    ],
)
async def test_mcp_capability_discovery_returns_clear_directory_empty_states(
    tmp_path,
    capability_directory,
    expected_reason,
    expected_message,
) -> None:
    tools = mcp_capability_discovery_tools_from_snapshot(
        _snapshot(visible_tools=[], capability_directory=capability_directory),
        McpActiveToolWindow(),
    )

    result = await tools[0].run({}, _context(tmp_path))

    assert result.ok is True
    assert result.result["tools"] == []
    assert result.result["empty_state"] == {
        "reason": expected_reason,
        "message": expected_message,
    }


@pytest.mark.asyncio
async def test_mcp_capability_discovery_returns_clear_search_empty_state(tmp_path) -> None:
    tools = mcp_capability_discovery_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract("candidate", exposure="on_demand", description="Find target")
            ],
            capability_directory=[
                {
                    "server_id": "srv_tools",
                    "server_name": "工具服务",
                    "status": "online",
                    "status_label": "在线",
                    "available_tool_count": 1,
                    "direct_tool_count": 0,
                    "on_demand_tool_count": 1,
                    "requires_auth": False,
                    "has_on_demand_tools": True,
                    "capability_keywords": ["candidate"],
                }
            ],
        ),
        McpActiveToolWindow(),
    )

    result = await tools[0].run({"query": "missing"}, _context(tmp_path))

    assert result.ok is True
    assert result.result["tools"] == []
    assert result.result["empty_state"] == {
        "reason": "no_match",
        "message": "未找到匹配的 MCP 工具，未激活任何工具。",
    }
    assert result.result["activation"]["activated_model_names"] == []


def test_mcp_capability_discovery_description_includes_sources_and_activation_rules() -> None:
    tools = mcp_capability_discovery_tools_from_snapshot(
        _snapshot(
            visible_tools=[
                _contract(
                    "candidate",
                    server_name="知识库服务",
                    exposure="on_demand",
                    description="Search knowledge base",
                ),
                _contract(
                    "other",
                    server_name="知识库服务",
                    exposure="on_demand",
                    description="Read knowledge base",
                ),
            ]
        ),
        McpActiveToolWindow(),
    )

    description = tools[0].description

    assert "知识库服务" in description
    assert "2 个工具" in description
    assert "不在已直接可用工具中" in description
    assert "带 query 会搜索并激活命中工具" in description
    assert "token" not in description.lower()
    assert "header" not in description.lower()
    assert "https://" not in description


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
