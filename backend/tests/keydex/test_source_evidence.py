from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.keydex.capabilities.base import KeydexWatchSpec
from backend.app.keydex.models import KeydexDiagnostic, KeydexSourceEvidence
from backend.app.keydex.registry import DEFAULT_KEYDEX_CAPABILITY_REGISTRY


def test_kr09_registry_watch_specs_are_exact_and_capability_owned(tmp_path: Path) -> None:
    specs = DEFAULT_KEYDEX_CAPABILITY_REGISTRY.watch_specs("system")

    assert tuple(
        (capability_id, spec.relative_path, spec.kind)
        for capability_id, spec in specs
    ) == (
        ("skills", "skills", "subtree"),
        ("keydex_markdown", "keydex.md", "exact"),
    )
    skills_spec = specs[0][1]
    markdown_spec = specs[1][1]
    assert skills_spec.match(
        scope="system",
        layer_root=tmp_path,
        changed_path=tmp_path / "skills" / "alpha" / "SKILL.md",
    ) == "skills/alpha/SKILL.md"
    assert markdown_spec.match(
        scope="system", layer_root=tmp_path, changed_path="keydex.md"
    ) == "keydex.md"
    assert markdown_spec.match(
        scope="system", layer_root=tmp_path, changed_path="keydex.md"
    ) is None
    assert skills_spec.match(
        scope="system", layer_root=tmp_path, changed_path=tmp_path.parent / "outside.md"
    ) is None


def test_watch_spec_rejects_escape_and_unsupported_scope(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="stay inside"):
        KeydexWatchSpec("../outside")
    spec = KeydexWatchSpec("keydex.md", supported_scopes=frozenset({"system"}))
    assert spec.match(
        scope="workspace", layer_root=tmp_path, changed_path="keydex.md"
    ) is None


def test_km10_source_evidence_contains_only_logical_metadata(tmp_path: Path) -> None:
    private_root = tmp_path / "private-user" / ".keydex"
    marker = "TOP-SECRET-GUIDANCE"
    evidence = KeydexSourceEvidence(
        capability_id="keydex_markdown",
        scope="system",
        locator="system:keydex.md",
        kind="file",
        state="present",
        byte_size=len(marker),
        content_hash="a" * 64,
    )

    serialized = str(evidence.to_payload())
    assert private_root.as_posix() not in serialized
    assert marker not in serialized
    assert evidence.locator == "system:keydex.md"


def test_km31_diagnostic_serialization_is_logical_and_immutable(tmp_path: Path) -> None:
    details = {"limit": 32768}
    diagnostic = KeydexDiagnostic(
        code="keydex_markdown_too_large",
        reason="keydex.md exceeds the byte limit",
        severity="error",
        details=details,
        capability_id="keydex_markdown",
        scope="workspace",
        logical_path="workspace:.keydex/keydex.md",
    )
    details["private_root"] = tmp_path.as_posix()

    payload = diagnostic.to_dict()
    assert payload["path"] == "workspace:.keydex/keydex.md"
    assert payload["logical_path"] == "workspace:.keydex/keydex.md"
    assert payload["capability_id"] == "keydex_markdown"
    assert "private_root" not in payload["details"]
    with pytest.raises(TypeError):
        diagnostic.details["changed"] = True  # type: ignore[index]


def test_diagnostic_rejects_absolute_paths() -> None:
    with pytest.raises(ValueError, match="absolute"):
        KeydexDiagnostic(code="unsafe", reason="unsafe", logical_path="C:/Users/private")
