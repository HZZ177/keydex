from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.app.core.time import utc_now
from backend.app.keydex.models import KeydexDiagnostic, KeydexWorkspaceProfile
from backend.app.keydex.profile import load_keydex_workspace_profile
from backend.app.keydex.skills import SkillCatalog, discover_workspace_skills


@dataclass(frozen=True)
class KeydexWorkspaceFingerprint:
    workspace_root: Path
    keydex_json_mtime_ns: int | None
    keydex_json_size: int | None
    keydex_json_sha256: str | None
    skills_dir_mtime_ns: int | None
    skill_entry_fingerprints: tuple[tuple[str, int, int, str], ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "workspace_root", Path(self.workspace_root).expanduser().resolve())

    def to_payload(self) -> dict[str, Any]:
        return {
            "workspace_root": self.workspace_root.as_posix(),
            "keydex_json_mtime_ns": self.keydex_json_mtime_ns,
            "keydex_json_size": self.keydex_json_size,
            "keydex_json_sha256": self.keydex_json_sha256,
            "skills_dir_mtime_ns": self.skills_dir_mtime_ns,
            "skill_entry_fingerprints": self.skill_entry_fingerprints,
        }

    def digest(self) -> str:
        payload = json.dumps(self.to_payload(), ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class KeydexWorkspaceRuntimeSnapshot:
    workspace_root: Path
    keydex_profile: KeydexWorkspaceProfile
    skill_catalog: SkillCatalog
    fingerprint: str
    loaded_at: datetime
    diagnostics: list[KeydexDiagnostic]

    def __post_init__(self) -> None:
        object.__setattr__(self, "workspace_root", Path(self.workspace_root).expanduser().resolve())


def build_keydex_workspace_fingerprint(workspace_root: str | Path) -> KeydexWorkspaceFingerprint:
    resolved_root = Path(workspace_root).expanduser().resolve()
    keydex_root = resolved_root / ".keydex"
    manifest_path = keydex_root / "keydex.json"
    skills_dir = keydex_root / "skills"

    manifest_stat = manifest_path.stat() if manifest_path.is_file() else None
    skills_dir_stat = skills_dir.stat() if skills_dir.is_dir() else None
    entries: list[tuple[str, int, int]] = []
    if skills_dir.is_dir():
        for skill_md in sorted(
            skills_dir.glob("*/SKILL.md"),
            key=lambda path: path.as_posix().lower(),
        ):
            if not skill_md.is_file():
                continue
            stat = skill_md.stat()
            entries.append(
                (
                    _relative_to_workspace(resolved_root, skill_md),
                    stat.st_mtime_ns,
                    stat.st_size,
                    _file_sha256(skill_md),
                )
            )

    return KeydexWorkspaceFingerprint(
        workspace_root=resolved_root,
        keydex_json_mtime_ns=manifest_stat.st_mtime_ns if manifest_stat else None,
        keydex_json_size=manifest_stat.st_size if manifest_stat else None,
        keydex_json_sha256=_file_sha256(manifest_path) if manifest_stat else None,
        skills_dir_mtime_ns=skills_dir_stat.st_mtime_ns if skills_dir_stat else None,
        skill_entry_fingerprints=tuple(entries),
    )


def build_keydex_workspace_runtime_snapshot(
    workspace_root: str | Path,
) -> KeydexWorkspaceRuntimeSnapshot:
    profile = load_keydex_workspace_profile(workspace_root)
    catalog = discover_workspace_skills(profile)
    fingerprint = build_keydex_workspace_fingerprint(profile.workspace_root).digest()
    return KeydexWorkspaceRuntimeSnapshot(
        workspace_root=profile.workspace_root,
        keydex_profile=profile,
        skill_catalog=catalog,
        fingerprint=fingerprint,
        loaded_at=utc_now(),
        diagnostics=list(catalog.diagnostics),
    )


def _relative_to_workspace(workspace_root: Path, path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(workspace_root).as_posix()
    except ValueError:
        return path.as_posix()


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
