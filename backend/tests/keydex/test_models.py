from pathlib import Path

from backend.app.keydex import (
    KeydexDiagnostic,
    KeydexEffectiveProfile,
    KeydexLayer,
    KeydexLayerProfile,
    KeydexWorkspaceProfile,
)


def test_keydex_diagnostic_serializes() -> None:
    diagnostic = KeydexDiagnostic(
        code="manifest_invalid",
        reason="invalid json",
        path=".keydex/keydex.md",
        severity="error",
        details={"line": 1},
    )

    assert diagnostic.to_dict() == {
        "code": "manifest_invalid",
        "reason": "invalid json",
        "path": ".keydex/keydex.md",
        "severity": "error",
        "details": {"line": 1},
        "capability_id": None,
        "scope": None,
        "logical_path": ".keydex/keydex.md",
    }


def test_keydex_layer_normalizes_root(tmp_path: Path) -> None:
    layer = KeydexLayer(
        scope="workspace",
        root=tmp_path / "repo" / ".keydex",
        enabled=True,
        manifest={"schema_version": 1},
    )

    assert layer.root.is_absolute()
    assert layer.root == (tmp_path / "repo" / ".keydex").resolve()


def test_keydex_workspace_profile_preserves_workspace_scope(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    keydex_root = workspace_root / ".keydex"
    skills_root = keydex_root / "skills"
    layer = KeydexLayer(
        scope="workspace",
        root=keydex_root,
        enabled=True,
        manifest={"schema_version": 1, "skills": {"enabled": True}},
    )

    profile = KeydexWorkspaceProfile(
        workspace_root=workspace_root,
        keydex_root=keydex_root,
        active_layers=[layer],
        skills_root=skills_root,
        skills_enabled=True,
    )

    assert profile.workspace_root == workspace_root.resolve()
    assert profile.keydex_root == keydex_root.resolve()
    assert profile.skills_root == skills_root.resolve()
    assert profile.active_layers == [layer]
    assert profile.active_layers[0].scope == "workspace"


def test_layer_profile_is_canonical_and_immutable_at_the_collection_boundary(
    tmp_path: Path,
) -> None:
    diagnostics = [KeydexDiagnostic(code="sample", reason="sample")]
    profile = KeydexLayerProfile(
        scope="system",
        root=tmp_path / "user" / ".keydex",
        enabled=True,
        diagnostics=diagnostics,
    )

    diagnostics.clear()

    assert profile.root == (tmp_path / "user" / ".keydex").resolve()
    assert profile.skills_root == (tmp_path / "user" / ".keydex" / "skills").resolve()
    assert tuple(item.code for item in profile.diagnostics) == ("sample",)


def test_effective_profile_requires_layers_matching_its_mode(tmp_path: Path) -> None:
    builtin = KeydexLayerProfile(
        scope="builtin",
        root=tmp_path / "builtin",
        enabled=True,
    )
    system = KeydexLayerProfile(scope="system", root=tmp_path / "system", enabled=True)
    workspace = KeydexLayerProfile(
        scope="workspace",
        root=tmp_path / "workspace" / ".keydex",
        enabled=True,
    )

    system_only = KeydexEffectiveProfile(
        mode="system_only",
        system=system,
        builtin=builtin,
    )
    workspace_effective = KeydexEffectiveProfile(
        mode="workspace_effective",
        system=system,
        workspace=workspace,
        builtin=builtin,
    )

    assert system_only.workspace is None
    assert system_only.builtin is builtin
    assert workspace_effective.workspace is workspace
