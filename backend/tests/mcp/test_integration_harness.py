from __future__ import annotations

from backend.tests.mcp.fixtures.integration_harness import (
    MCP_BACKEND_INTEGRATION_GATE_COMMANDS,
    MCP_FAILURE_EVIDENCE_FIELDS,
    McpFailureEvidence,
    create_mcp_api_test_harness,
)


def test_mcp_api_harness_starts_router_and_injects_fake_manager(tmp_path) -> None:
    harness = create_mcp_api_test_harness(tmp_path)
    try:
        server_id = harness.create_http_server("Harness MCP")
        response = harness.client.post(f"/api/mcp/servers/{server_id}/refresh")

        assert response.status_code == 200
        assert response.json()["ok"] is True
        assert response.json()["tools_count"] == 4
        assert response.json()["prompts_count"] == 1
        assert harness.fake_client_factory.created_server_ids == [server_id]
        assert harness.repositories.mcp_tools.get_by_raw_name(server_id, "read_file") is not None
        assert harness.repositories.mcp_prompts.get_by_raw_name(
            server_id,
            "summarize_ticket",
        ) is not None
    finally:
        harness.close()


def test_mcp_api_harness_database_isolated_per_tmp_path(tmp_path) -> None:
    first = create_mcp_api_test_harness(tmp_path / "first")
    second = create_mcp_api_test_harness(tmp_path / "second")
    try:
        first.create_http_server("First MCP")

        first_list = first.client.get("/api/mcp/servers")
        second_list = second.client.get("/api/mcp/servers")

        assert first_list.status_code == 200
        assert second_list.status_code == 200
        assert first_list.json()["total"] == 1
        assert second_list.json()["total"] == 0
    finally:
        first.close()
        second.close()


def test_mcp_integration_gate_commands_are_mcp_scoped() -> None:
    joined_commands = [
        " ".join(command.command) for command in MCP_BACKEND_INTEGRATION_GATE_COMMANDS
    ]

    assert any("backend\\tests\\mcp" in command for command in joined_commands)
    assert any("backend\\tests\\api\\test_mcp" in command for command in joined_commands)
    assert any("backend\\tests\\services" in command for command in joined_commands)
    assert any("backend\\tests\\agent" in command for command in joined_commands)

    forbidden_fragments = ("npm", "pnpm", "build", "package", "desktop", "electron")
    for command in joined_commands:
        lowered = command.lower()
        for fragment in forbidden_fragments:
            assert fragment not in lowered


def test_mcp_failure_evidence_format_is_complete() -> None:
    evidence = McpFailureEvidence(
        command=".venv\\Scripts\\python.exe -m pytest backend\\tests\\mcp",
        test_name="backend/tests/mcp/test_example.py::test_case",
        issue_id="MCP-070",
        blocking_reason="mock timeout did not reproduce",
    )

    assert MCP_FAILURE_EVIDENCE_FIELDS == (
        "command",
        "test_name",
        "issue_id",
        "blocking_reason",
    )
    assert evidence.to_dict() == {
        "command": ".venv\\Scripts\\python.exe -m pytest backend\\tests\\mcp",
        "test_name": "backend/tests/mcp/test_example.py::test_case",
        "issue_id": "MCP-070",
        "blocking_reason": "mock timeout did not reproduce",
    }
