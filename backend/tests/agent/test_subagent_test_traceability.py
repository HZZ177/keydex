from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TRACEABILITY_PATH = ROOT / "docs" / "decisions" / "subagent-test-traceability.json"
TEST_ID_PATTERN = re.compile(
    r"^(?P<prefix>[A-Z0-9]+(?:-[A-Z0-9]+)+)-(?P<start>\d{3})$"
)
TEST_RANGE_PATTERN = re.compile(
    r"^(?P<prefix>[A-Z0-9]+(?:-[A-Z0-9]+)+)-(?P<start>\d{3})\.\.(?P<end>\d{3})$"
)
PLAN_CODE_SPAN_PATTERN = re.compile(r"`((?:UT|FT|FE|E2E)-[^`]+)`")
ALLOWED_TEST_ROOTS = (
    "backend/tests/",
    "desktop/tests/",
    "desktop/e2e/",
)


def _expand_expression(expression: str) -> set[str]:
    expanded: set[str] = set()
    prefix: str | None = None
    for part in expression.split("/"):
        range_match = TEST_RANGE_PATTERN.fullmatch(part)
        if range_match:
            prefix = range_match.group("prefix")
            start = int(range_match.group("start"))
            end = int(range_match.group("end"))
            assert start <= end, expression
            expanded.update(f"{prefix}-{value:03d}" for value in range(start, end + 1))
            continue
        id_match = TEST_ID_PATTERN.fullmatch(part)
        if id_match:
            prefix = id_match.group("prefix")
            expanded.add(f"{prefix}-{int(id_match.group('start')):03d}")
            continue
        if prefix is not None and re.fullmatch(r"\d{3}", part):
            expanded.add(f"{prefix}-{int(part):03d}")
            continue
        suffix_range = re.fullmatch(r"(?P<start>\d{3})\.\.(?P<end>\d{3})", part)
        if prefix is not None and suffix_range:
            start = int(suffix_range.group("start"))
            end = int(suffix_range.group("end"))
            assert start <= end, expression
            expanded.update(f"{prefix}-{value:03d}" for value in range(start, end + 1))
            continue
        raise AssertionError(f"invalid test ID expression: {expression}")
    return expanded


def _load_manifest() -> dict[str, object]:
    return json.loads(TRACEABILITY_PATH.read_text(encoding="utf-8"))


def _plan_test_ids(plan_path: Path) -> set[str]:
    content = plan_path.read_text(encoding="utf-8")
    state_section = content.split("### 16.", 1)[1].split("### 17.", 1)[0]
    acceptance_section = content.split("### 18.", 1)[1].split("### 19.", 1)[0]
    expressions = [
        expression
        for expression in PLAN_CODE_SPAN_PATTERN.findall(
            f"{state_section}\n{acceptance_section}"
        )
        if "*" not in expression
    ]
    return set().union(*(_expand_expression(expression) for expression in expressions))


def test_traceability_manifest_covers_every_plan_test_id_exactly() -> None:
    manifest = _load_manifest()
    plan_path = ROOT / str(manifest["plan"])
    contracts = manifest["contracts"]
    assert isinstance(contracts, list) and contracts

    mapped_ids: set[str] = set()
    for contract in contracts:
        assert isinstance(contract, dict)
        ids = contract.get("ids")
        assert isinstance(ids, list) and ids
        for expression in ids:
            assert isinstance(expression, str)
            expanded = _expand_expression(expression)
            assert mapped_ids.isdisjoint(expanded), f"duplicate traceability IDs: {expanded}"
            mapped_ids.update(expanded)

    assert mapped_ids == _plan_test_ids(plan_path)
    assert len(mapped_ids) == 336


def test_traceability_references_real_test_anchors() -> None:
    manifest = _load_manifest()
    for contract in manifest["contracts"]:
        assert contract["layer"] in {"unit", "functional", "e2e"}
        assert str(contract["behavior"]).strip()
        refs = contract["test_refs"]
        assert isinstance(refs, list) and refs
        for ref in refs:
            relative_path = str(ref["path"]).replace("\\", "/")
            assert relative_path.startswith(ALLOWED_TEST_ROOTS)
            path = ROOT / relative_path
            assert path.is_file(), relative_path
            assert str(ref["contains"]) in path.read_text(encoding="utf-8"), ref


def test_literal_e2e_contract_lists_every_acceptance_id_in_playwright_sources() -> None:
    manifest = _load_manifest()
    literal_contracts = [item for item in manifest["contracts"] if item.get("literal_ids")]
    assert len(literal_contracts) == 1
    contract = literal_contracts[0]
    expected = set().union(*(_expand_expression(item) for item in contract["ids"]))
    source = "\n".join(
        (ROOT / ref["path"]).read_text(encoding="utf-8") for ref in contract["test_refs"]
    ).upper()
    assert {test_id for test_id in expected if test_id not in source} == set()
