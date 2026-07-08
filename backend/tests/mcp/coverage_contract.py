from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class McpFeatureCoverageContract:
    feature_id: str
    feature_name: str
    unit_issue: str
    e2e_issue: str
    design_refs: tuple[str, ...]
    backend_focus: str


MCP_TEST_FILE_NAMING = {
    "backend_unit": "backend/tests/mcp/test_<feature>.py",
    "backend_fixture": "backend/tests/mcp/fixtures/<fixture_name>.py",
    "backend_harness": "backend/tests/mcp/test_<harness_name>.py",
}

MCP_SHARED_FIXTURE_IMPORTS = (
    "backend.tests.mcp.fixtures.mock_mcp_servers.start_mock_mcp_server",
)

MCP_MARKER_CONVENTION = {
    "asyncio": (
        "Use pytest.mark.asyncio for async MCP client, manager, service, and transport tests."
    ),
    "parametrize": "Use pytest.mark.parametrize for policy and error-code matrices.",
    "custom_markers": "Do not add custom MCP markers unless registered in pyproject.toml.",
}

MCP_EXTERNAL_DEPENDENCY_POLICY = {
    "mcp_server": "Use in-process mock factories or .example.test endpoints only.",
    "oauth": "Use MockOAuthProvider or fake token exchangers only.",
    "model": "Use fake model providers only; never call a real model provider.",
    "secret": "Use mock/raw sentinel strings only; never store real credentials.",
}

MCP_FEATURE_COVERAGE_CONTRACTS: tuple[McpFeatureCoverageContract, ...] = (
    McpFeatureCoverageContract(
        "F01",
        "全局数据模型与迁移",
        "MCP-061",
        "MCP-081",
        ("DES 6.2", "DES 6.3"),
        "DDL/repository/JSON/secret-reference baseline tests.",
    ),
    McpFeatureCoverageContract(
        "F02",
        "MCP Manager 与客户端生命周期",
        "MCP-062",
        "MCP-082",
        ("DES 6.2", "DES 6.3"),
        "manager lifecycle, client cache, status transitions, refresh and shutdown.",
    ),
    McpFeatureCoverageContract(
        "F03",
        "Transport 支持",
        "MCP-063",
        "MCP-083",
        ("DES 6.2", "DES 6.3"),
        "stdio, streamable_http, sse config and SDK adapter contracts.",
    ),
    McpFeatureCoverageContract(
        "F04",
        "Auth、Secret 与 OAuth",
        "MCP-064",
        "MCP-084",
        ("DES 6.2", "DES 6.3"),
        "header/env/secret/OAuth state and redaction tests.",
    ),
    McpFeatureCoverageContract(
        "F05",
        "能力发现与刷新",
        "MCP-065",
        "MCP-085",
        ("DES 6.2", "DES 6.3"),
        "initialize, list_tools, schema and refresh audit tests.",
    ),
    McpFeatureCoverageContract(
        "F06",
        "Tool 命名、过滤与默认策略",
        "MCP-066",
        "MCP-086",
        ("DES 6.2",),
        "name sanitization, exposure policy, visibility, and disabled tool tests.",
    ),
    McpFeatureCoverageContract(
        "F07",
        "Runtime Snapshot",
        "MCP-067",
        "MCP-087",
        ("DES 6.2", "DES 6.3"),
        "snapshot freeze, session override, required offline, and live guard tests.",
    ),
    McpFeatureCoverageContract(
        "F08",
        "Agent 集成与工具包装",
        "MCP-068",
        "MCP-088",
        ("DES 6.2", "DES 6.3"),
        "McpLocalTool adapter, metadata, workspace injection, and fake manager tests.",
    ),
    McpFeatureCoverageContract(
        "F09",
        "直接注入预算与能力目录",
        "MCP-069",
        "MCP-089",
        ("DES 6.2", "DES 6.3"),
        "direct budget, capability directory, discover_mcp_tools activation, TTL, and visibility tests.",
    ),
    McpFeatureCoverageContract(
        "F10",
        "Tool 调用、超时、取消、截断",
        "MCP-070",
        "MCP-090",
        ("DES 6.2", "DES 6.3"),
        "schema validation, success/error/timeout/cancel, redaction, and audit tests.",
    ),
    McpFeatureCoverageContract(
        "F11",
        "审批与信任",
        "MCP-071",
        "MCP-091",
        ("DES 6.2", "DES 6.3"),
        "approval modes, trust rules, and command approval isolation.",
    ),
    McpFeatureCoverageContract(
        "F12",
        "Elicitation",
        "MCP-073",
        "MCP-093",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "pending request, WebSocket event, schema mapping, submit, cancel, and timeout.",
    ),
    McpFeatureCoverageContract(
        "F13",
        "Sampling",
        "MCP-074",
        "MCP-094",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "sampling policy, budget, approval gate, fake model provider, and audit.",
    ),
    McpFeatureCoverageContract(
        "F14",
        "Resources 预留",
        "MCP-075",
        "MCP-095",
        ("DES 6.2", "DES 6.3"),
        "reserved resources schema, manager/API non-exposure, and runtime exclusion.",
    ),
    McpFeatureCoverageContract(
        "F15",
        "Runtime Panel 会话级开关",
        "MCP-076",
        "MCP-096",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "runtime status, session override, live guard, cancel API, and panel reducer.",
    ),
    McpFeatureCoverageContract(
        "F16",
        "MCP Console 单独页面",
        "MCP-077",
        "MCP-097",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "route, server list, form validation, tabs, loading, empty, and error states.",
    ),
    McpFeatureCoverageContract(
        "F17",
        "审计、日志与状态",
        "MCP-078",
        "MCP-098",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "audit writer, redaction, filters, pagination, status, and frontend details.",
    ),
    McpFeatureCoverageContract(
        "F18",
        "导入导出",
        "MCP-079",
        "MCP-099",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "config parsers, conflict preview, import apply, export stripping, and errors.",
    ),
    McpFeatureCoverageContract(
        "F19",
        "测试基建",
        "MCP-080",
        "MCP-100",
        ("DES 6.2", "DES 6.3", "DES 6.4"),
        "mock server health, fixtures, database isolation, E2E base url, and cleanup.",
    ),
)


def unit_issue_ids() -> tuple[str, ...]:
    return tuple(contract.unit_issue for contract in MCP_FEATURE_COVERAGE_CONTRACTS)


def e2e_issue_ids() -> tuple[str, ...]:
    return tuple(contract.e2e_issue for contract in MCP_FEATURE_COVERAGE_CONTRACTS)


def missing_unit_coverage() -> tuple[str, ...]:
    expected = {f"MCP-{issue:03d}" for issue in range(61, 81)} - {"MCP-072"}
    actual = set(unit_issue_ids())
    return tuple(sorted(expected - actual))
