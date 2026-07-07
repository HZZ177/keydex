from __future__ import annotations

from backend.app.mcp.exposure import McpToolExposureResolver
from backend.app.storage import McpToolRecord, StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(
    repositories: StorageRepositories,
    *,
    server_id: str = "srv_exposure",
    mode: str = "allow_all_except_disabled",
    enabled: bool = True,
) -> None:
    repositories.mcp_servers.create(
        server_id=server_id,
        name=f"Exposure MCP {server_id}",
        description="Server admin note must not enter tool description",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        enabled=enabled,
        default_tool_exposure_mode=mode,
        default_tool_approval_mode="auto",
    )
    repositories.mcp_server_status.upsert(server_id, status="online")


def _tool(
    repositories: StorageRepositories,
    raw_name: str,
    *,
    server_id: str = "srv_exposure",
    description: str = "MCP declared description",
    input_schema: dict | None = None,
    annotations: dict | None = None,
    meta: dict | None = None,
) -> McpToolRecord:
    repositories.mcp_tools.upsert_many(
        server_id,
        [
            {
                "raw_name": raw_name,
                "model_name": f"mcp__{server_id}__{raw_name}",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": raw_name,
                "description": description,
                "input_schema": input_schema or {"type": "object"},
                "annotations": annotations,
                "meta": meta,
                "schema_hash": f"hash-{raw_name}",
            }
        ],
    )
    return repositories.mcp_tools.get_by_raw_name(server_id, raw_name)


def _resolve(repositories: StorageRepositories, server_id: str = "srv_exposure"):
    server = repositories.mcp_servers.get(server_id)
    return McpToolExposureResolver().resolve(
        servers=[server],
        statuses={server_id: repositories.mcp_server_status.get(server_id)},
        tools=repositories.mcp_tools.list_by_server(server_id),
        policies=repositories.mcp_tool_policies.list_by_server(server_id),
        session_overrides=repositories.mcp_session_tool_overrides.list_by_session("session-a"),
    )


def test_allow_all_except_disabled_exposes_all_model_visible_tools(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "read")
    _tool(repositories, "write")

    result = _resolve(repositories)

    assert [tool.raw_name for tool in result.visible_tools] == ["read", "write"]
    assert result.hidden_tools == []


def test_allow_selected_only_requires_explicit_policy_or_session_enable(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, mode="allow_selected_only")
    _tool(repositories, "selected")
    _tool(repositories, "session_selected")
    _tool(repositories, "unselected")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exposure",
        raw_tool_name="selected",
        enabled=True,
    )
    repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="srv_exposure",
        raw_tool_name="session_selected",
        enabled=True,
    )

    result = _resolve(repositories)

    assert [tool.raw_name for tool in result.visible_tools] == [
        "selected",
        "session_selected",
    ]
    assert {
        hidden.raw_name: hidden.reason for hidden in result.hidden_tools
    } == {"unselected": "tool_not_selected"}


def test_policy_hidden_disabled_removed_and_offline_tools_are_excluded(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "hidden")
    _tool(repositories, "disabled")
    _tool(repositories, "removed")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exposure",
        raw_tool_name="hidden",
        hidden=True,
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exposure",
        raw_tool_name="disabled",
        enabled=False,
    )
    repositories.mcp_tools.set_discovery_status("srv_exposure", "removed", "removed")

    result = _resolve(repositories)

    assert result.visible_tools == []
    assert {hidden.raw_name: hidden.reason for hidden in result.hidden_tools} == {
        "disabled": "tool_disabled_by_policy",
        "hidden": "tool_hidden",
        "removed": "tool_removed",
    }

    repositories.mcp_server_status.upsert("srv_exposure", status="offline")
    offline_result = _resolve(repositories)
    assert {hidden.reason for hidden in offline_result.hidden_tools} == {"server_not_online"}


def test_session_disabled_override_excludes_tool(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "tool")
    repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="srv_exposure",
        raw_tool_name="tool",
        enabled=False,
    )

    result = _resolve(repositories)

    assert result.visible_tools == []
    assert result.hidden_tools[0].reason == "tool_disabled_for_session"


def test_disabled_policy_takes_precedence_over_session_enable(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, mode="allow_selected_only")
    _tool(repositories, "tool")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exposure",
        raw_tool_name="tool",
        enabled=False,
    )
    repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="srv_exposure",
        raw_tool_name="tool",
        enabled=True,
    )

    result = _resolve(repositories)

    assert result.visible_tools == []
    assert result.hidden_tools[0].reason == "tool_disabled_by_policy"


def test_model_visibility_meta_controls_exposure(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(
        repositories,
        "hidden_from_model",
        meta={"_meta": {"ui": {"visibility": ["assistant"]}}},
    )
    _tool(
        repositories,
        "visible_to_model",
        meta={"_meta": {"ui": {"visibility": ["assistant", "model"]}}},
    )

    result = _resolve(repositories)

    assert [tool.raw_name for tool in result.visible_tools] == ["visible_to_model"]
    assert result.hidden_tools[0].reason == "tool_hidden_from_model"


def test_model_contract_uses_mcp_description_without_policy_or_server_text(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(
        repositories,
        "tool",
        description="MCP tool description",
        input_schema={
            "type": "object",
            "properties": {"mcpField": {"type": "string"}},
            "required": ["mcpField"],
        },
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exposure",
        raw_tool_name="tool",
        approval_mode="prompt",
        parameter_constraints={"properties": {"policyOnly": {"const": "blocked"}}},
    )

    contract = _resolve(repositories).model_contracts()[0]

    assert contract["description"] == "MCP tool description"
    assert contract["input_schema"] == {
        "type": "object",
        "properties": {"mcpField": {"type": "string"}},
        "required": ["mcpField"],
    }
    assert "Server admin note" not in str(contract)
    assert "prompt" not in contract["description"]
    assert "high" not in contract["description"]
    assert "policyOnly" not in str(contract["input_schema"])


def test_disabled_tool_contract_omits_name_description_and_schema(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(
        repositories,
        "visible",
        description="Visible MCP description",
        input_schema={"type": "object", "properties": {"visibleField": {"type": "string"}}},
    )
    _tool(
        repositories,
        "disabled_secret",
        description="Disabled description must not reach the model",
        input_schema={
            "type": "object",
            "properties": {"disabledSecretField": {"type": "string"}},
        },
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exposure",
        raw_tool_name="disabled_secret",
        enabled=False,
    )

    result = _resolve(repositories)
    contracts = result.model_contracts()
    serialized_contracts = str(contracts)

    assert [contract["raw_name"] for contract in contracts] == ["visible"]
    assert "disabled_secret" not in serialized_contracts
    assert "Disabled description" not in serialized_contracts
    assert "disabledSecretField" not in serialized_contracts
    assert result.hidden_tools[0].reason == "tool_disabled_by_policy"
