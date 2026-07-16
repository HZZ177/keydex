from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.app.core.request_context import (
    get_keydex_capability,
    reset_request_context,
    set_request_context,
)
from backend.app.keydex.capabilities.base import CapabilityKey
from backend.app.keydex.models import (
    CapabilityLayerSnapshot,
    EffectiveCapabilitySnapshot,
    KeydexCapabilityMissingError,
    KeydexCapabilityTypeError,
    KeydexDiagnostic,
    KeydexEffectiveSnapshot,
    KeydexLayerDescriptor,
    KeydexLayerSnapshot,
)


def _layer(
    tmp_path: Path,
    *,
    scope: str = "system",
    capabilities: dict[str, CapabilityLayerSnapshot] | None = None,
) -> KeydexLayerSnapshot:
    return KeydexLayerSnapshot(
        descriptor=KeydexLayerDescriptor(
            scope=scope,  # type: ignore[arg-type]
            root=tmp_path / scope,
            logical_root=scope,
        ),
        capabilities=capabilities or {},
        fingerprint=f"{scope}-fingerprint",
        loaded_at=datetime.now(UTC),
    )


def test_kr07_descriptor_normalizes_root_and_mode_requires_workspace(tmp_path: Path) -> None:
    descriptor = KeydexLayerDescriptor(
        scope="workspace",
        root=tmp_path / "repo" / ".keydex",
        logical_root=".keydex/",
    )
    workspace = _layer(tmp_path, scope="workspace")

    assert descriptor.root == (tmp_path / "repo" / ".keydex").resolve()
    assert descriptor.logical_root == ".keydex"
    with pytest.raises(ValueError, match="requires a workspace layer"):
        KeydexEffectiveSnapshot(
            mode="workspace_effective",
            layers=(_layer(tmp_path),),
            capabilities={},
            fingerprint="effective",
            loaded_at=datetime.now(UTC),
        )
    with pytest.raises(ValueError, match="must not include a workspace"):
        KeydexEffectiveSnapshot(
            mode="system_only",
            layers=(workspace,),
            capabilities={},
            fingerprint="effective",
            loaded_at=datetime.now(UTC),
        )


def test_kr08_capability_payloads_and_diagnostics_remain_isolated(tmp_path: Path) -> None:
    skills_key = CapabilityKey("skills", dict)
    markdown_key = CapabilityKey("keydex_markdown", tuple)
    skills_diagnostic = KeydexDiagnostic(code="skills_warning", reason="skills")
    markdown_diagnostic = KeydexDiagnostic(code="markdown_warning", reason="markdown")
    capabilities = {
        "skills": EffectiveCapabilitySnapshot(
            capability_id="skills",
            key=skills_key,
            payload={"winner": "workspace"},
            fingerprint="skills-fp",
            sources=("workspace:.keydex/skills",),
            diagnostics=(skills_diagnostic,),
        ),
        "keydex_markdown": EffectiveCapabilitySnapshot(
            capability_id="keydex_markdown",
            key=markdown_key,
            payload=("system", "workspace"),
            fingerprint="markdown-fp",
            sources=("system:keydex.md", "workspace:.keydex/keydex.md"),
            diagnostics=(markdown_diagnostic,),
        ),
    }
    snapshot = KeydexEffectiveSnapshot(
        mode="system_only",
        layers=(_layer(tmp_path),),
        capabilities=capabilities,
        fingerprint="effective",
        loaded_at=datetime.now(UTC),
    )

    assert snapshot.require(skills_key) == {"winner": "workspace"}
    assert snapshot.require(markdown_key) == ("system", "workspace")
    assert snapshot.capabilities["skills"].diagnostics == (skills_diagnostic,)
    assert snapshot.capabilities["keydex_markdown"].diagnostics == (markdown_diagnostic,)


def test_kr13_snapshot_copies_maps_lists_and_sources(tmp_path: Path) -> None:
    key = CapabilityKey("skills", dict)
    sources = ["system:.keydex/skills"]
    diagnostics = [KeydexDiagnostic(code="one", reason="one")]
    effective = EffectiveCapabilitySnapshot(
        capability_id="skills",
        key=key,
        payload={},
        fingerprint="skills-fp",
        sources=tuple(sources),
        diagnostics=tuple(diagnostics),
    )
    capabilities = {"skills": effective}
    layers = [_layer(tmp_path)]
    snapshot = KeydexEffectiveSnapshot(
        mode="system_only",
        layers=tuple(layers),
        capabilities=capabilities,
        fingerprint="effective",
        loaded_at=datetime.now(UTC),
        diagnostics=tuple(diagnostics),
    )

    capabilities.clear()
    layers.clear()
    sources.append("workspace:.keydex/skills")
    diagnostics.clear()

    assert tuple(snapshot.capabilities) == ("skills",)
    assert len(snapshot.layers) == 1
    assert snapshot.capabilities["skills"].sources == ("system:.keydex/skills",)
    assert tuple(item.code for item in snapshot.diagnostics) == ("one",)
    with pytest.raises(TypeError):
        snapshot.capabilities["extra"] = effective  # type: ignore[index]


def test_typed_accessor_reports_missing_and_payload_type_mismatch(tmp_path: Path) -> None:
    key = CapabilityKey("skills", dict)
    snapshot = KeydexEffectiveSnapshot(
        mode="system_only",
        layers=(_layer(tmp_path),),
        capabilities={
            "skills": EffectiveCapabilitySnapshot(
                capability_id="skills",
                key=key,
                payload={"winner": "system"},
                fingerprint="skills-fp",
            )
        },
        fingerprint="effective",
        loaded_at=datetime.now(UTC),
    )

    assert snapshot.get(CapabilityKey("missing", str)) is None
    with pytest.raises(KeydexCapabilityMissingError, match="missing"):
        snapshot.require(CapabilityKey("missing", str))
    with pytest.raises(KeydexCapabilityTypeError, match="payload type mismatch"):
        snapshot.require(CapabilityKey("skills", tuple))


def test_ki03_request_context_exposes_typed_capability(tmp_path: Path) -> None:
    skills_key = CapabilityKey("skills", dict)
    payload = {"winner": "system"}
    snapshot = KeydexEffectiveSnapshot(
        mode="system_only",
        layers=(_layer(tmp_path),),
        capabilities={
            "skills": EffectiveCapabilitySnapshot(
                capability_id="skills",
                key=skills_key,
                payload=payload,
                fingerprint="skills-fp",
            )
        },
        fingerprint="effective",
        loaded_at=datetime.now(UTC),
    )
    token = set_request_context(keydex_snapshot=snapshot)
    try:
        assert get_keydex_capability(skills_key) is payload
    finally:
        reset_request_context(token)
