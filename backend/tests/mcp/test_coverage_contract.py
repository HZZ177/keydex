from __future__ import annotations

from importlib import import_module
from pathlib import Path

from backend.tests.mcp.coverage_contract import (
    MCP_EXTERNAL_DEPENDENCY_POLICY,
    MCP_FEATURE_COVERAGE_CONTRACTS,
    MCP_MARKER_CONVENTION,
    MCP_SHARED_FIXTURE_IMPORTS,
    MCP_TEST_FILE_NAMING,
    e2e_issue_ids,
    missing_unit_coverage,
    unit_issue_ids,
)

ROOT = Path(__file__).resolve().parents[3]
PLAN_PATH = ROOT / ".dev" / "plans" / "2026-07-04_13-48-47-mcp-runtime.md"
BASELINE_FILES = (
    ROOT / "backend" / "tests" / "mcp" / "coverage_contract.py",
    ROOT / "backend" / "tests" / "mcp" / "test_coverage_contract.py",
    ROOT / "backend" / "tests" / "mcp" / "fixtures" / "mock_mcp_servers.py",
    ROOT / "backend" / "tests" / "mcp" / "test_mock_mcp_servers.py",
)


def test_mcp_backend_test_conventions_are_machine_readable() -> None:
    assert MCP_TEST_FILE_NAMING["backend_unit"] == "backend/tests/mcp/test_<feature>.py"
    assert MCP_TEST_FILE_NAMING["backend_fixture"].startswith("backend/tests/mcp/fixtures/")
    assert "asyncio" in MCP_MARKER_CONVENTION
    assert "parametrize" in MCP_MARKER_CONVENTION
    assert "pyproject.toml" in MCP_MARKER_CONVENTION["custom_markers"]

    for import_path in MCP_SHARED_FIXTURE_IMPORTS:
        module_name, attribute_name = import_path.rsplit(".", 1)
        module = import_module(module_name)
        assert hasattr(module, attribute_name)


def test_mcp_feature_contracts_cover_f01_to_f20_and_mcp_061_to_080() -> None:
    assert [contract.feature_id for contract in MCP_FEATURE_COVERAGE_CONTRACTS] == [
        f"F{number:02d}" for number in range(1, 21)
    ]
    assert unit_issue_ids() == tuple(f"MCP-{number:03d}" for number in range(61, 81))
    assert e2e_issue_ids() == tuple(f"MCP-{number:03d}" for number in range(81, 101))
    assert missing_unit_coverage() == ()

    for contract in MCP_FEATURE_COVERAGE_CONTRACTS:
        assert contract.feature_name
        assert contract.backend_focus
        assert any(ref in {"DES 6.2", "DES 6.3", "DES 6.4"} for ref in contract.design_refs)


def test_mcp_unit_issues_trace_to_plan_design_refs() -> None:
    plan = PLAN_PATH.read_text(encoding="utf-8")

    for contract in MCP_FEATURE_COVERAGE_CONTRACTS:
        section = _issue_section(plan, contract.unit_issue)
        assert "design_refs:" in section
        assert any(_design_ref_matches(section, ref) for ref in contract.design_refs)


def test_mcp_baseline_forbids_real_external_dependencies() -> None:
    policy_text = " ".join(MCP_EXTERNAL_DEPENDENCY_POLICY.values()).lower()
    assert "real model provider" in policy_text
    assert ".example.test" in policy_text
    assert "real credentials" in policy_text

    forbidden_markers = (
        "api." "openai.com",
        "api." "anthropic.com",
        "generativelanguage." "googleapis.com",
        "sk-" "live",
        "sk-" "proj-",
    )
    for path in BASELINE_FILES:
        text = path.read_text(encoding="utf-8").lower()
        for marker in forbidden_markers:
            assert marker not in text


def _issue_section(plan: str, issue_id: str) -> str:
    marker = f"### {issue_id}"
    start = plan.index(marker)
    next_start = plan.find("\n### MCP-", start + len(marker))
    if next_start == -1:
        return plan[start:]
    return plan[start:next_start]


def _design_ref_matches(section: str, design_ref: str) -> bool:
    if design_ref in section:
        return True
    if design_ref.startswith("DES "):
        return design_ref.removeprefix("DES ") in section
    return False
