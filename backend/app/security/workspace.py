from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class WorkspacePathError(ValueError):
    pass


@dataclass(frozen=True)
class ResolvedWorkspacePath:
    raw_path: str
    absolute_path: Path
    workspace_root: Path | None

    @property
    def is_inside_workspace(self) -> bool:
        return self.workspace_root is not None


def normalize_workspace_roots(cwd: str | Path, roots: list[str | Path] | None = None) -> list[Path]:
    candidates = roots or [cwd]
    normalized: list[Path] = []
    for root in candidates:
        resolved = Path(root).expanduser().resolve()
        if resolved not in normalized:
            normalized.append(resolved)
    return normalized


def normalize_workspace_root_for_storage(root: str | Path) -> str:
    resolved = Path(root).expanduser().resolve()
    normalized = resolved.as_posix().rstrip("/")
    if os.name == "nt":
        return normalized.casefold()
    return normalized


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_path(
    raw_path: str | Path,
    *,
    cwd: str | Path,
    workspace_roots: list[str | Path],
) -> ResolvedWorkspacePath:
    raw_text = str(raw_path)
    if not raw_text.strip():
        raise WorkspacePathError("路径不能为空")
    cwd_path = Path(cwd).expanduser().resolve()
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = cwd_path / path
    absolute = path.resolve()
    roots = normalize_workspace_roots(cwd_path, workspace_roots)
    matched = next((root for root in roots if is_relative_to(absolute, root)), None)
    return ResolvedWorkspacePath(
        raw_path=raw_text,
        absolute_path=absolute,
        workspace_root=matched,
    )


def resolve_workspace_path(
    raw_path: str | Path,
    *,
    cwd: str | Path,
    workspace_roots: list[str | Path],
) -> Path:
    resolved = resolve_path(raw_path, cwd=cwd, workspace_roots=workspace_roots)
    if not resolved.is_inside_workspace:
        raise WorkspacePathError(f"路径不在工作区内：{raw_path}")
    return resolved.absolute_path
