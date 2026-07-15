from __future__ import annotations

import hashlib
import stat
from dataclasses import dataclass
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


@dataclass(frozen=True)
class SkillTextResource:
    path: Path
    logical_path: str
    content: str
    encoding: str
    revision: str


def resolve_skill_resource_path(skill: SkillDefinition, resource_path: str | Path) -> Path:
    logical_path = normalize_skill_resource_path(resource_path)
    raw_path = Path(logical_path)

    root = skill.root_dir.resolve()
    candidate = root / raw_path
    current = root
    for part in raw_path.parts:
        if part in {"", "."}:
            continue
        current = current / part
        if _is_link_like(current):
            raise SkillResourcePathError(
                "skill_resource_forbidden",
                "resource_path must not traverse symlinks or junctions",
            )
    resolved = candidate.resolve()
    if not is_relative_to(resolved, root):
        raise SkillResourcePathError(
            "skill_resource_forbidden",
            "resolved resource_path must stay under the skill root",
        )
    return resolved


def normalize_skill_resource_path(resource_path: str | Path) -> str:
    raw_path = Path(resource_path)
    if not str(resource_path).strip():
        raise SkillResourcePathError("skill_resource_invalid", "resource_path must not be empty")
    if raw_path.is_absolute() or raw_path.drive or ".." in raw_path.parts:
        raise SkillResourcePathError(
            "skill_resource_forbidden",
            "resource_path must be relative to the skill root",
        )
    return raw_path.as_posix()


def read_skill_text_resource(
    skill: SkillDefinition,
    resource_path: str | Path,
    *,
    max_bytes: int = KEYDEX_SKILL_MAX_RESOURCE_BYTES,
) -> SkillTextResource:
    resolved = resolve_skill_resource_path(skill, resource_path)
    if not resolved.exists():
        raise SkillResourcePathError(
            "skill_resource_not_found", "Skill resource file was not found."
        )
    if _is_link_like(resolved) or resolved.is_dir():
        raise SkillResourcePathError(
            "skill_resource_not_file", "Skill resource path must be a regular file."
        )
    try:
        file_stat = resolved.stat(follow_symlinks=False)
    except OSError as exc:
        raise SkillResourcePathError(
            "skill_resource_unreadable", "Skill resource file could not be read."
        ) from exc
    if not stat.S_ISREG(file_stat.st_mode):
        raise SkillResourcePathError(
            "skill_resource_not_file", "Skill resource path must be a regular file."
        )
    if file_stat.st_size > max_bytes:
        raise SkillResourcePathError(
            "skill_resource_too_large", f"skill file exceeds {max_bytes} bytes"
        )
    try:
        content_bytes = resolved.read_bytes()
    except OSError as exc:
        raise SkillResourcePathError(
            "skill_resource_unreadable", "Skill resource file could not be read."
        ) from exc
    if len(content_bytes) > max_bytes:
        raise SkillResourcePathError(
            "skill_resource_too_large", f"skill file exceeds {max_bytes} bytes"
        )
    if b"\0" in content_bytes:
        raise SkillResourcePathError(
            "skill_resource_not_text", "Skill resource file must be valid UTF-8 text."
        )
    try:
        content = content_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SkillResourcePathError(
            "skill_resource_not_text", "Skill resource file must be valid UTF-8 text."
        ) from exc
    logical_path = Path(resource_path).as_posix()
    return SkillTextResource(
        path=resolved,
        logical_path=logical_path,
        content=content,
        encoding="utf-8",
        revision=hashlib.sha256(content_bytes).hexdigest(),
    )


def ensure_skill_file_size(
    path: Path,
    *,
    max_bytes: int,
    code: str = "skill_file_too_large",
) -> None:
    if path.stat().st_size > max_bytes:
        raise SkillResourcePathError(code, f"skill file exceeds {max_bytes} bytes")


def _is_link_like(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    try:
        return bool(path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except (AttributeError, OSError):
        return False
