from __future__ import annotations

from backend.app.mcp.exposure import (
    McpDirectInjectionPlanner,
    McpExposureResult,
    McpToolExposureResolver,
    McpVisibleTool,
)
from backend.app.mcp.tools import McpActiveToolWindow, McpCapabilitySearchIndex
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _visible_tool(
    raw_name: str,
    *,
    server_id: str = "srv",
    server_name: str | None = None,
    model_name: str | None = None,
    description: str | None = None,
    input_schema: dict | None = None,
) -> McpVisibleTool:
    return McpVisibleTool(
        server_id=server_id,
        raw_name=raw_name,
        model_name=model_name or f"mcp__{server_id}__{raw_name}",
        description=description,
        input_schema=input_schema or {"type": "object"},
        approval_mode="auto",
        server_name=server_name,
    )


def test_direct_injection_planner_uses_direct_mode_within_budget() -> None:
    exposure = McpExposureResult(
        visible_tools=[_visible_tool("one"), _visible_tool("two")],
        hidden_tools=[],
    )

    plan = McpDirectInjectionPlanner(direct_tool_budget=2).plan(exposure)

    assert plan.availability == "direct"
    assert [tool.raw_name for tool in plan.direct_tools] == ["one", "two"]
    assert plan.on_demand_tools == []
    assert plan.has_on_demand_catalog is False


def test_direct_injection_planner_can_force_on_demand_catalog_within_budget() -> None:
    exposure = McpExposureResult(
        visible_tools=[_visible_tool("one"), _visible_tool("two")],
        hidden_tools=[],
    )

    plan = McpDirectInjectionPlanner(
        direct_tool_budget=5,
        force_on_demand=True,
    ).plan(exposure)

    assert plan.availability == "with_on_demand_catalog"
    assert plan.direct_tools == []
    assert [tool.raw_name for tool in plan.on_demand_tools] == ["one", "two"]
    assert plan.has_on_demand_catalog is True


def test_direct_injection_planner_loads_only_active_tools_when_over_budget() -> None:
    tools = [_visible_tool("one"), _visible_tool("two"), _visible_tool("three")]
    exposure = McpExposureResult(visible_tools=tools, hidden_tools=[])

    plan = McpDirectInjectionPlanner(direct_tool_budget=2).plan(
        exposure,
        active_model_names={"mcp__srv__two"},
    )

    assert plan.availability == "with_on_demand_catalog"
    assert [tool.raw_name for tool in plan.direct_tools] == ["two"]
    assert [tool.raw_name for tool in plan.on_demand_tools] == ["one", "three"]
    assert plan.has_on_demand_catalog is True


def test_direct_injection_planner_does_not_preload_recent_success_when_over_budget() -> None:
    tools = [
        _visible_tool("one"),
        _visible_tool("two"),
        _visible_tool("three"),
        _visible_tool("four"),
    ]
    exposure = McpExposureResult(visible_tools=tools, hidden_tools=[])

    plan = McpDirectInjectionPlanner(direct_tool_budget=2).plan(
        exposure,
        recent_model_names=["mcp__srv__three", "mcp__srv__one"],
    )

    assert plan.direct_tools == []
    assert [tool.raw_name for tool in plan.on_demand_tools] == [
        "one",
        "two",
        "three",
        "four",
    ]


def test_direct_injection_planner_does_not_preload_priority_tools_when_over_budget() -> None:
    tools = [_visible_tool("one"), _visible_tool("two"), _visible_tool("three")]
    exposure = McpExposureResult(visible_tools=tools, hidden_tools=[])

    plan = McpDirectInjectionPlanner(direct_tool_budget=2).plan(
        exposure,
        priority_model_names=["mcp__srv__three"],
    )

    assert plan.direct_tools == []
    assert [tool.raw_name for tool in plan.on_demand_tools] == ["one", "two", "three"]


def test_direct_injection_planner_only_uses_active_window_when_over_budget() -> None:
    tools = [
        _visible_tool("one"),
        _visible_tool("two"),
        _visible_tool("three"),
        _visible_tool("four"),
    ]
    exposure = McpExposureResult(visible_tools=tools, hidden_tools=[])

    plan = McpDirectInjectionPlanner(direct_tool_budget=3).plan(
        exposure,
        active_model_names={"mcp__srv__four"},
        recent_model_names=["mcp__srv__three"],
        priority_model_names=["mcp__srv__two"],
    )

    assert [tool.raw_name for tool in plan.direct_tools] == ["four"]
    assert [tool.raw_name for tool in plan.on_demand_tools] == ["one", "two", "three"]


def test_direct_injection_planner_caps_active_tools_by_budget() -> None:
    tools = [_visible_tool("one"), _visible_tool("two"), _visible_tool("three")]
    exposure = McpExposureResult(visible_tools=tools, hidden_tools=[])

    plan = McpDirectInjectionPlanner(direct_tool_budget=2).plan(
        exposure,
        active_model_names={
            "mcp__srv__one",
            "mcp__srv__two",
            "mcp__srv__three",
        },
    )

    assert [tool.raw_name for tool in plan.direct_tools] == ["one", "two"]
    assert [tool.raw_name for tool in plan.on_demand_tools] == ["three"]


def test_search_matches_query_server_and_schema_summary() -> None:
    index = McpCapabilitySearchIndex(
        [
            _visible_tool(
                "create_issue",
                server_id="github",
                server_name="GitHub 服务",
                description="Create a GitHub issue",
                input_schema={
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Issue title to create",
                        }
                    }
                },
            ),
            _visible_tool(
                "list_tasks",
                server_id="linear",
                description="List tasks",
            ),
        ],
        capability_directory=[
            {
                "server_id": "github",
                "server_name": "GitHub 服务",
                "status_label": "在线",
                "capability_keywords": ["repository", "issue"],
            }
        ],
    )

    assert [item.raw_name for item in index.search(query="github issue")] == [
        "create_issue"
    ]
    assert [item.raw_name for item in index.search(query="GitHub 服务")] == [
        "create_issue"
    ]
    assert [item.raw_name for item in index.search(query="title")] == ["create_issue"]
    assert [item.raw_name for item in index.search(query="Issue title")] == [
        "create_issue"
    ]
    assert index.search(query="repository") == []
    assert [item.raw_name for item in index.search(server_id="linear")] == ["list_tasks"]
    assert [item.raw_name for item in index.search(limit=1)] == ["create_issue"]


def test_search_ranks_exact_tool_name_before_other_matches() -> None:
    index = McpCapabilitySearchIndex(
        [
            _visible_tool(
                "search_issue",
                server_id="github",
                description="Find issue records",
            ),
            _visible_tool(
                "issue",
                server_id="tracker",
                description="Exact issue tool",
            ),
        ]
    )

    assert [item.raw_name for item in index.search(query="issue")] == [
        "issue",
        "search_issue",
    ]


def test_search_ranks_description_and_parameter_matches_stably() -> None:
    index = McpCapabilitySearchIndex(
        [
            _visible_tool(
                "zeta",
                server_id="server-z",
                server_name="Zeta 服务",
                description="Create release notes",
            ),
            _visible_tool(
                "alpha",
                server_id="server-a",
                server_name="Alpha 服务",
                description="Create release notes",
            ),
            _visible_tool(
                "with_parameter",
                server_id="server-p",
                server_name="Parameter 服务",
                input_schema={
                    "properties": {
                        "release_title": {
                            "type": "string",
                            "description": "Release note title",
                        }
                    }
                },
            ),
        ]
    )

    assert [item.raw_name for item in index.search(query="release notes")] == [
        "alpha",
        "zeta",
    ]
    assert [item.raw_name for item in index.search(query="Release note title")] == [
        "with_parameter"
    ]


def test_search_deduplicates_by_model_name_and_applies_limits() -> None:
    duplicate_model_name = "mcp__shared__duplicate"
    index = McpCapabilitySearchIndex(
        [
            _visible_tool(
                "duplicate_a",
                server_id="server-a",
                model_name=duplicate_model_name,
                description="Duplicate target",
            ),
            _visible_tool(
                "duplicate_b",
                server_id="server-b",
                model_name=duplicate_model_name,
                description="Duplicate target",
            ),
            *[
                _visible_tool(
                    f"tool_{index}",
                    server_id="bulk",
                    description="Bulk target",
                )
                for index in range(120)
            ],
        ]
    )

    duplicate_matches = index.search(query="Duplicate target")
    assert [item.model_name for item in duplicate_matches] == [duplicate_model_name]
    assert len(index.search(query="Bulk target", limit=1)) == 1
    assert len(index.search(query="Bulk target", limit=999)) == 100
    assert index.search(query="not-present") == []


def test_search_index_cannot_return_tools_filtered_out_by_exposure() -> None:
    index = McpCapabilitySearchIndex([_visible_tool("enabled")])

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
    index = McpCapabilitySearchIndex(exposure.visible_tools)

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


def test_active_tool_window_reactivation_refreshes_ttl() -> None:
    now = 1000.0
    window = McpActiveToolWindow(time_provider=lambda: now)

    window.activate(session_id="session-a", model_name="mcp__srv__one", ttl_sec=10)
    now = 1005.0
    window.activate(session_id="session-a", model_name="mcp__srv__one", ttl_sec=20)
    now = 1011.0

    assert window.active_model_names("session-a") == {"mcp__srv__one"}

    now = 1026.0

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
            }
        ],
    )
