from __future__ import annotations

from pathlib import Path

from backend.app.keydex.models import (
    KeydexDiagnostic,
    KeydexLayerProfile,
    KeydexScope,
    KeydexWorkspaceProfile,
    resolve_system_keydex_root,
)


def load_keydex_system_profile(
    system_root: str | Path | None = None,
) -> KeydexLayerProfile:
    root = resolve_system_keydex_root() if system_root is None else Path(system_root)
    return load_keydex_layer_profile("system", root)


def load_keydex_layer_profile(
    scope: KeydexScope,
    keydex_root: str | Path,
) -> KeydexLayerProfile:
    """Resolve a convention-based layer without reading user configuration files."""

    resolved_root = Path(keydex_root).expanduser().resolve()
    diagnostics: list[KeydexDiagnostic] = []
    available = True
    if resolved_root.exists() and not resolved_root.is_dir():
        diagnostics.append(
            KeydexDiagnostic(
                code="keydex_root_invalid",
                logical_path="builtin" if scope == "builtin" else ".keydex",
                severity="error",
                reason="Keydex layer root is not a directory",
                scope=scope,
            )
        )
        available = False

    enabled = available and resolved_root.is_dir()
    return KeydexLayerProfile(
        scope=scope,
        root=resolved_root,
        enabled=enabled,
        available=available,
        manifest={},
        diagnostics=tuple(diagnostics),
    )


def load_keydex_workspace_profile(workspace_root: str | Path) -> KeydexWorkspaceProfile:
    resolved_root = Path(workspace_root).expanduser().resolve()
    keydex_root = resolved_root / ".keydex"
    layer = load_keydex_layer_profile("workspace", keydex_root)

    return KeydexWorkspaceProfile(
        workspace_root=resolved_root,
        keydex_root=keydex_root,
        active_layers=[layer],
        skills_root=layer.skills_root,
        skills_enabled=layer.enabled,
        available=layer.available,
        diagnostics=list(layer.diagnostics),
    )
