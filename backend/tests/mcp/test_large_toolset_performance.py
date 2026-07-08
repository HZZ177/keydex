from __future__ import annotations

import json
from time import perf_counter

import pytest

from backend.app.mcp.runtime import McpRuntimeSnapshotBuilder, McpRuntimeSnapshotContext
from backend.app.mcp.tools import McpActiveToolWindow, mcp_capability_discovery_tools_from_snapshot
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import ToolExecutionContext


_PERFORMANCE_LIMITS_SEC = {
    100: {"snapshot": 1.0, "index": 0.3, "search": 0.3},
    300: {"snapshot": 2.0, "index": 0.6, "search": 0.5},
    1000: {"snapshot": 6.0, "index": 1.5, "search": 1.0},
}


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_large_server(repositories: StorageRepositories, tool_count: int) -> None:
    repositories.mcp_servers.create(
        server_id="srv_large",
        name="Large Tool MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    repositories.mcp_server_status.update_refresh_counts(
        "srv_large",
        status="online",
        tools_count=tool_count,
    )


def _insert_large_tools(repositories: StorageRepositories, tool_count: int) -> str:
    target_raw_name = f"zz_target_tool_{tool_count:04d}"
    tools = []
    for index in range(tool_count):
        raw_name = target_raw_name if index == tool_count - 1 else f"tool_{index:04d}"
        tools.append(
            {
                "raw_name": raw_name,
                "model_name": f"mcp__srv_large__{raw_name}",
                "callable_namespace": "mcp__srv_large",
                "callable_name": raw_name,
                "description": f"Large tool {index}",
                "input_schema": _large_schema(index, tool_count),
                "schema_hash": f"hash-{index}",
                "annotations": {},
            }
        )
    repositories.mcp_tools.upsert_many("srv_large", tools)
    return target_raw_name


def _large_schema(index: int, tool_count: int) -> dict:
    marker = f"unique_payload_{tool_count}" if index == tool_count - 1 else f"payload_{index}"
    return {
        "type": "object",
        "properties": {
            f"param_{part}": {
                "type": "string",
                "title": f"Parameter {part}",
                "description": f"{marker} field {part} for tool {index}",
            }
            for part in range(8)
        },
    }


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-large",
        user_id="user-large",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-large",
        metadata={},
    )


@pytest.mark.parametrize("tool_count", [100, 300, 1000])
@pytest.mark.asyncio
async def test_large_toolset_snapshot_directory_and_search_performance(tmp_path, tool_count: int) -> None:
    repositories = _repositories(tmp_path)
    _create_large_server(repositories, tool_count)
    target_raw_name = _insert_large_tools(repositories, tool_count)
    limits = _PERFORMANCE_LIMITS_SEC[tool_count]

    snapshot_started = perf_counter()
    snapshot = McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=20).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-large")
    )
    snapshot_elapsed = perf_counter() - snapshot_started

    assert snapshot_elapsed < limits["snapshot"], f"{tool_count} tools snapshot took {snapshot_elapsed:.3f}s"
    assert snapshot.direct_available_tools == 0
    assert snapshot.on_demand_tools == tool_count
    assert snapshot.unavailable_tools == 0
    assert len(snapshot.capability_directory) == 1
    assert snapshot.capability_directory[0]["available_tool_count"] == tool_count
    assert "input_schema" not in json.dumps(snapshot.capability_directory, ensure_ascii=False)
    assert f"unique_payload_{tool_count}" not in json.dumps(snapshot.capability_directory, ensure_ascii=False)

    index_started = perf_counter()
    discovery_tools = mcp_capability_discovery_tools_from_snapshot(
        snapshot,
        McpActiveToolWindow(),
    )
    index_elapsed = perf_counter() - index_started

    assert index_elapsed < limits["index"], f"{tool_count} tools index took {index_elapsed:.3f}s"

    search_started = perf_counter()
    result = await discovery_tools[0].run(
        {"query": f"unique_payload_{tool_count}", "limit": 5},
        _context(tmp_path),
    )
    search_elapsed = perf_counter() - search_started

    assert search_elapsed < limits["search"], f"{tool_count} tools search took {search_elapsed:.3f}s"
    assert result.ok is True
    assert [item["raw_name"] for item in result.result["tools"]] == [target_raw_name]
    assert result.result["activation"]["activated_model_names"] == [
        f"mcp__srv_large__{target_raw_name}"
    ]
