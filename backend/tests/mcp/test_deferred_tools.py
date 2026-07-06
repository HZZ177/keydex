from __future__ import annotations

from backend.app.mcp.exposure import (
    McpDeferredExposurePlanner,
    McpExposureResult,
    McpToolExposureResolver,
    McpVisibleTool,
)
from backend.app.mcp.tools import McpActiveToolWindow, McpDeferredToolSearchIndex
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _visible_tool(
    raw_name: str,
    *,
    server_id: str = "srv",
    description: str | None = None,
    risk_level: str = "unknown",
    input_schema: dict | None = None,
) -> McpVisibleTool:
    return McpVisibleTool(
        server_id=server_id,
        raw_name=raw_name,
        model_name=f"mcp__{server_id}__{raw_name}",
        description=description,
        input_schema=input_schema or {"type": "object"},
        risk_level=risk_level,
        approval_mode="auto",
    )


def test_deferred_planner_uses_direct_mode_under_threshold() -> None:
    exposure = McpExposureResult(
        visible_tools=[_visible_tool("one"), _visible_tool("two")],
        hidden_tools=[],
    )

    plan = McpDeferredExposurePlanner(direct_threshold=2).plan(exposure)

    assert plan.mode == "direct"
    assert [tool.raw_name for tool in plan.direct_tools] == ["one", "two"]
    assert plan.deferred_tools == []
    assert plan.include_search_tool is False
    assert plan.include_list_tool is False


def test_deferred_planner_can_force_deferred_mode_under_threshold() -> None:
    exposure = McpExposureResult(
        visible_tools=[_visible_tool("one"), _visible_tool("two")],
        hidden_tools=[],
    )

    plan = McpDeferredExposurePlanner(
        direct_threshold=5,
        force_deferred=True,
    ).plan(exposure)

    assert plan.mode == "deferred"
    assert plan.direct_tools == []
    assert [tool.raw_name for tool in plan.deferred_tools] == ["one", "two"]
    assert plan.include_search_tool is True
    assert plan.include_list_tool is True


def test_deferred_planner_exposes_only_active_tools_when_over_threshold() -> None:
    tools = [_visible_tool("one"), _visible_tool("two"), _visible_tool("three")]
    exposure = McpExposureResult(visible_tools=tools, hidden_tools=[])

    plan = McpDeferredExposurePlanner(direct_threshold=2).plan(
        exposure,
        active_model_names={"mcp__srv__two"},
    )

    assert plan.mode == "deferred"
    assert [tool.raw_name for tool in plan.direct_tools] == ["two"]
    assert [tool.raw_name for tool in plan.deferred_tools] == ["one", "three"]
    assert plan.include_search_tool is True
    assert plan.include_list_tool is True


def test_search_matches_query_server_risk_and_schema_summary() -> None:
    index = McpDeferredToolSearchIndex(
        [
            _visible_tool(
                "create_issue",
                server_id="github",
                description="Create a GitHub issue",
                risk_level="high",
                input_schema={"properties": {"title": {"type": "string"}}},
            ),
            _visible_tool(
                "list_tasks",
                server_id="linear",
                description="List tasks",
                risk_level="low",
            ),
        ]
    )

    assert [item.raw_name for item in index.search(query="github issue")] == [
        "create_issue"
    ]
    assert [item.raw_name for item in index.search(query="title")] == ["create_issue"]
    assert [item.raw_name for item in index.search(server_id="linear")] == ["list_tasks"]
    assert [item.raw_name for item in index.search(risk_level="high")] == [
        "create_issue"
    ]
    assert [item.raw_name for item in index.list_tools(limit=1)] == ["create_issue"]


def test_search_index_cannot_return_tools_filtered_out_by_exposure() -> None:
    index = McpDeferredToolSearchIndex([_visible_tool("enabled")])

    assert index.search(query="disabled") == []


def test_search_index_built_from_exposure_cannot_return_disabled_hidden_or_offline_tools(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="srv_visible",
        name="Visible MCP",
        transport="streamable_http",
        url="https://mcp.example.test/visible",
    )
    repositories.mcp_servers.create(
        server_id="srv_offline",
        name="Offline MCP",
        transport="streamable_http",
        url="https://mcp.example.test/offline",
    )
    repositories.mcp_server_status.upsert("srv_visible", status="online")
    repositories.mcp_server_status.upsert("srv_offline", status="offline")
    _persist_tool(repositories, "srv_visible", "enabled")
    _persist_tool(repositories, "srv_visible", "disabled")
    _persist_tool(repositories, "srv_visible", "hidden")
    _persist_tool(repositories, "srv_offline", "offline")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_visible",
        raw_tool_name="disabled",
        enabled=False,
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_visible",
        raw_tool_name="hidden",
        hidden=True,
    )
    servers, _total = repositories.mcp_servers.list(limit=10)
    tools = [
        tool
        for server in servers
        for tool in repositories.mcp_tools.list_by_server(server.id)
    ]
    policies = [
        policy
        for server in servers
        for policy in repositories.mcp_tool_policies.list_by_server(server.id)
    ]
    statuses = {
        server.id: repositories.mcp_server_status.get(server.id) for server in servers
    }
    exposure = McpToolExposureResolver().resolve(
        servers=servers,
        statuses=statuses,
        tools=tools,
        policies=policies,
    )
    index = McpDeferredToolSearchIndex(exposure.visible_tools)

    assert [item.raw_name for item in index.search(query="enabled")] == ["enabled"]
    assert index.search(query="disabled") == []
    assert index.search(query="hidden") == []
    assert index.search(query="offline") == []
    assert {hidden.reason for hidden in exposure.hidden_tools} == {
        "server_not_online",
        "tool_disabled_by_policy",
        "tool_hidden",
    }


def test_active_tool_window_is_session_scoped_and_expires() -> None:
    now = 1000.0

    def time_provider() -> float:
        return now

    window = McpActiveToolWindow(time_provider=time_provider)
    window.activate(session_id="session-a", model_name="mcp__srv__one", ttl_sec=10)

    assert window.active_model_names("session-a") == {"mcp__srv__one"}
    assert window.active_model_names("session-b") == set()

    now = 1011.0

    assert window.active_model_names("session-a") == set()


def test_active_tool_window_clear_session_removes_only_that_session() -> None:
    now = 1000.0
    window = McpActiveToolWindow(time_provider=lambda: now)
    window.activate(session_id="session-a", model_name="mcp__srv__one", ttl_sec=10)
    window.activate(session_id="session-b", model_name="mcp__srv__two", ttl_sec=10)

    window.clear_session("session-a")

    assert window.active_model_names("session-a") == set()
    assert window.active_model_names("session-b") == {"mcp__srv__two"}


def _persist_tool(
    repositories: StorageRepositories,
    server_id: str,
    raw_name: str,
) -> None:
    repositories.mcp_tools.upsert_many(
        server_id,
        [
            {
                "raw_name": raw_name,
                "model_name": f"mcp__{server_id}__{raw_name}",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": raw_name,
                "description": f"{raw_name} description",
                "input_schema": {"type": "object"},
                "schema_hash": f"hash-{raw_name}",
                "risk_level": "low",
            }
        ],
    )
