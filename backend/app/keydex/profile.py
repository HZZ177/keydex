from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.app.keydex.models import (
    KeydexDiagnostic,
    KeydexLayerProfile,
    KeydexScope,
    KeydexWorkspaceProfile,
    resolve_system_keydex_root,
)

DEFAULT_SCHEMA_VERSION = 1
MANIFEST_RELATIVE_PATH = ".keydex/keydex.json"


class KeydexManifestError(ValueError):
    pass


def default_keydex_manifest(scope: KeydexScope = "workspace") -> dict[str, Any]:
    skills: dict[str, Any] = {"enabled": True}
    if scope == "workspace":
        skills["inherit_system"] = True
    return {"schema_version": DEFAULT_SCHEMA_VERSION, "skills": skills}


def load_keydex_system_profile(
    system_root: str | Path | None = None,
) -> KeydexLayerProfile:
    root = resolve_system_keydex_root() if system_root is None else Path(system_root)
    return load_keydex_layer_profile("system", root)


def load_keydex_layer_profile(
    scope: KeydexScope,
    keydex_root: str | Path,
) -> KeydexLayerProfile:
    resolved_root = Path(keydex_root).expanduser().resolve()
    manifest_path = resolved_root / "keydex.json"
    diagnostics: list[KeydexDiagnostic] = []
    manifest = default_keydex_manifest(scope)
    available = True

    if resolved_root.exists() and not resolved_root.is_dir():
        diagnostics.append(
            KeydexDiagnostic(
                code="keydex_root_invalid",
                path=".keydex",
                severity="error",
                reason=".keydex root is not a directory",
            )
        )
        available = False
    elif manifest_path.is_file():
        try:
            raw_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest = merge_keydex_manifest(raw_manifest, diagnostics, scope=scope)
        except (OSError, json.JSONDecodeError, KeydexManifestError) as exc:
            diagnostics.append(
                KeydexDiagnostic(
                    code="keydex_manifest_invalid",
                    path=MANIFEST_RELATIVE_PATH,
                    severity="error",
                    reason=str(exc),
                )
            )
            manifest = default_keydex_manifest(scope)
            available = False
    elif manifest_path.exists():
        diagnostics.append(
            KeydexDiagnostic(
                code="keydex_manifest_invalid",
                path=MANIFEST_RELATIVE_PATH,
                severity="error",
                reason="manifest path is not a file",
            )
        )
        available = False

    directory_enabled = resolved_root.is_dir()
    configured_enabled = bool(manifest.get("skills", {}).get("enabled", True))
    inherit_system = (
        bool(manifest.get("skills", {}).get("inherit_system", True))
        if scope == "workspace"
        else True
    )
    return KeydexLayerProfile(
        scope=scope,
        root=resolved_root,
        enabled=directory_enabled and available and configured_enabled,
        available=available,
        inherit_system=inherit_system,
        manifest=manifest,
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
        inherit_system=layer.inherit_system,
        available=layer.available,
        diagnostics=list(layer.diagnostics),
    )


def merge_keydex_manifest(
    raw_manifest: Any,
    diagnostics: list[KeydexDiagnostic] | None = None,
    *,
    scope: KeydexScope = "workspace",
) -> dict[str, Any]:
    if not isinstance(raw_manifest, dict):
        raise KeydexManifestError("manifest root must be a JSON object")

    diagnostics = diagnostics if diagnostics is not None else []
    manifest = default_keydex_manifest(scope)

    _warn_unknown_fields(
        raw_manifest,
        known_fields={"schema_version", "skills"},
        diagnostics=diagnostics,
        field_path="",
    )

    if "schema_version" in raw_manifest:
        schema_version = raw_manifest["schema_version"]
        if not isinstance(schema_version, int) or isinstance(schema_version, bool):
            raise KeydexManifestError("schema_version must be an integer")
        if schema_version != DEFAULT_SCHEMA_VERSION:
            raise KeydexManifestError(
                f"unsupported schema_version: {schema_version}"
            )
        manifest["schema_version"] = schema_version

    if "skills" in raw_manifest:
        skills = raw_manifest["skills"]
        if not isinstance(skills, dict):
            raise KeydexManifestError("skills must be a JSON object")
        _warn_unknown_fields(
            skills,
            known_fields={"enabled", "inherit_system"},
            diagnostics=diagnostics,
            field_path="skills",
        )
        if "enabled" in skills:
            enabled = skills["enabled"]
            if not isinstance(enabled, bool):
                raise KeydexManifestError("skills.enabled must be a boolean")
            manifest["skills"]["enabled"] = enabled
        if "inherit_system" in skills:
            inherit_system = skills["inherit_system"]
            if not isinstance(inherit_system, bool):
                raise KeydexManifestError("skills.inherit_system must be a boolean")
            if scope == "workspace":
                manifest["skills"]["inherit_system"] = inherit_system

    return manifest


def _warn_unknown_fields(
    data: dict[str, Any],
    *,
    known_fields: set[str],
    diagnostics: list[KeydexDiagnostic],
    field_path: str,
) -> None:
    for field_name in sorted(set(data) - known_fields):
        qualified_name = f"{field_path}.{field_name}" if field_path else field_name
        diagnostics.append(
            KeydexDiagnostic(
                code="keydex_manifest_unknown_field",
                path=MANIFEST_RELATIVE_PATH,
                severity="warning",
                reason=f"unknown manifest field: {qualified_name}",
                details={"field": qualified_name},
            )
        )
