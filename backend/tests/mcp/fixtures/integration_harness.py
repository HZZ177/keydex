from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientToolResult,
    McpClientToolSpec,
)
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories
from backend.tests.mcp.fixtures.mock_mcp_servers import (
    MockMcpServerScenario,
    MockMcpTool,
)


@dataclass(frozen=True)
class McpIntegrationGateCommand:
    label: str
    command: tuple[str, ...]
    issue_scope: str


@dataclass(frozen=True)
class McpFailureEvidence:
    command: str
    test_name: str
    issue_id: str
    blocking_reason: str

    def to_dict(self) -> dict[str, str]:
        return {
            "command": self.command,
            "test_name": self.test_name,
            "issue_id": self.issue_id,
            "blocking_reason": self.blocking_reason,
        }


MCP_BACKEND_INTEGRATION_GATE_COMMANDS: tuple[McpIntegrationGateCommand, ...] = (
    McpIntegrationGateCommand(
        label="mcp-core",
        command=(".venv\\Scripts\\python.exe", "-m", "pytest", "backend\\tests\\mcp"),
        issue_scope="MCP-061..MCP-080",
    ),
    McpIntegrationGateCommand(
        label="mcp-api",
        command=(
            ".venv\\Scripts\\python.exe",
            "-m",
            "pytest",
            "backend\\tests\\api\\test_mcp_server_api.py",
            "backend\\tests\\api\\test_mcp_tool_policy_api.py",
            "backend\\tests\\api\\test_mcp_runtime_api.py",
            "backend\\tests\\api\\test_mcp_oauth_api.py",
            "backend\\tests\\api\\test_mcp_import_export_api.py",
        ),
        issue_scope="MCP-061..MCP-080",
    ),
    McpIntegrationGateCommand(
        label="mcp-service-agent",
        command=(
            ".venv\\Scripts\\python.exe",
            "-m",
            "pytest",
            "backend\\tests\\services\\test_chat_service.py",
            "backend\\tests\\agent\\test_agent_runner.py",
            "-k",
            "mcp",
        ),
        issue_scope="MCP-068; MCP-070; MCP-076",
    ),
)

MCP_FAILURE_EVIDENCE_FIELDS = (
    "command",
    "test_name",
    "issue_id",
    "blocking_reason",
)


def create_mcp_api_test_harness(
    tmp_path: Path,
    *,
    scenario: MockMcpServerScenario | None = None,
    failing_server_names: set[str] | None = None,
) -> McpApiTestHarness:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    fake_client_factory = FakeMcpManagerClientFactory(
        scenario or MockMcpServerScenario(),
        failing_server_names=failing_server_names,
    )
    app.state.mcp_manager.client_factory = fake_client_factory
    client = TestClient(app)
    return McpApiTestHarness(
        app=app,
        client=client,
        repositories=app.state.repositories,
        fake_client_factory=fake_client_factory,
    )


@dataclass
class McpApiTestHarness:
    app: FastAPI
    client: TestClient
    repositories: StorageRepositories
    fake_client_factory: FakeMcpManagerClientFactory

    def close(self) -> None:
        self.client.close()

    def create_http_server(self, name: str = "Harness MCP") -> str:
        response = self.client.post(
            "/api/mcp/servers",
            json={
                "name": name,
                "transport": "streamable_http",
                "url": "https://mcp.example.test/mcp",
            },
        )
        assert response.status_code == 200
        return str(response.json()["id"])

    def seed_tool(
        self,
        server_id: str,
        raw_name: str = "read_file",
        *,
        read_only: bool = True,
    ) -> Any:
        return self.repositories.mcp_tools.upsert_many(
            server_id,
            [
                {
                    "raw_name": raw_name,
                    "model_name": f"mcp__{server_id}__{raw_name}",
                    "callable_namespace": f"mcp__{server_id}",
                    "callable_name": raw_name,
                    "display_name": raw_name,
                    "description": raw_name,
                    "input_schema": {"type": "object"},
                    "schema_hash": f"hash-{raw_name}",
                    "annotations": {"readOnlyHint": True} if read_only else {},
                }
            ],
        )[0]


class FakeMcpManagerClientFactory:
    def __init__(
        self,
        scenario: MockMcpServerScenario,
        *,
        failing_server_names: set[str] | None = None,
    ) -> None:
        self.scenario = scenario
        self.failing_server_names = failing_server_names or set()
        self.created_server_ids: list[str] = []

    def create_client(self, server: McpServerRecord) -> FakeMcpManagerClient:
        self.created_server_ids.append(server.id)
        if server.name in self.failing_server_names:
            return FakeMcpManagerClient(
                server.id,
                scenario=self.scenario,
                error=McpRuntimeError(McpErrorCode.TIMEOUT),
            )
        return FakeMcpManagerClient(server.id, scenario=self.scenario)


class FakeMcpManagerClient(McpClientBase):
    def __init__(
        self,
        server_id: str,
        *,
        scenario: MockMcpServerScenario,
        error: BaseException | None = None,
    ) -> None:
        super().__init__(server_id=server_id)
        self.scenario = scenario
        self.error = error
        self.tool_calls: list[dict[str, Any]] = []

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        if self.error is not None:
            raise self.error
        self.transition_status(McpServerStatus.ONLINE, reason="fake_initialize")
        return McpClientInitializeResult(
            protocol_version=self.scenario.protocol_version,
            server_info={"name": self.scenario.name},
            capabilities=McpClientCapabilities(
                tools=True,
                sampling=True,
                elicitation=True,
            ),
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        return [_to_tool_spec(tool) for tool in self.scenario.tools]

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult:
        self.tool_calls.append({"name": raw_tool_name, "arguments": dict(arguments or {})})
        return McpClientToolResult(
            call_id=call_id or "fake-call",
            status="success",
            content=[{"type": "text", "text": f"fake:{raw_tool_name}"}],
            structured_content={"arguments": dict(arguments or {})},
        )

    async def cancel_call(self, call_id: str) -> bool:
        return call_id.startswith("fake") or call_id.startswith("call")

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.transition_status(McpServerStatus.OFFLINE, reason="fake_shutdown")


def _to_tool_spec(tool: MockMcpTool) -> McpClientToolSpec:
    return McpClientToolSpec(
        name=tool.name,
        description=tool.description,
        input_schema=dict(tool.input_schema),
        annotations=dict(tool.annotations or {}),
    )
