from __future__ import annotations

from pathlib import Path

from backend.app.keydex.skills.model import SkillDefinition
from backend.app.security.workspace import is_relative_to

KEYDEX_SKILL_MAX_ENTRY_BYTES = 512 * 1024
KEYDEX_SKILL_MAX_RESOURCE_BYTES = 256 * 1024


class SkillResourcePathError(ValueError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def resolve_skill_resource_path(skill: SkillDefinition, resource_path: str | Path) -> Path:
    raw_path = Path(resource_path)
    if not str(resource_path).strip():
        raise SkillResourcePathError("skill_resource_invalid", "resource_path must not be empty")
    if raw_path.is_absolute():
        raise SkillResourcePathError(
            "skill_resource_forbidden",
            "resource_path must be relative to the skill root",
        )

    root = skill.root_dir.resolve()
    resolved = (root / raw_path).resolve()
    if not is_relative_to(resolved, root):
        raise SkillResourcePathError(
            "skill_resource_forbidden",
            "resolved resource_path must stay under the skill root",
        )
    return resolved


def ensure_skill_file_size(
    path: Path,
    *,
    max_bytes: int,
    code: str = "skill_file_too_large",
) -> None:
    if path.stat().st_size > max_bytes:
        raise SkillResourcePathError(code, f"skill file exceeds {max_bytes} bytes")
