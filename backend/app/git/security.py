from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .access import GitAccessDenied, GitAncestorGrantStore


class GitParameterError(ValueError):
    pass


@dataclass(frozen=True)
class GitRepositoryLayout:
    worktree_root: Path
    git_dir: Path
    bare: bool


def _canonical(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def _same_path(left: Path, right: Path) -> bool:
    left_text = left.as_posix().rstrip("/")
    right_text = right.as_posix().rstrip("/")
    if os.name == "nt":
        return left_text.casefold() == right_text.casefold()
    return left_text == right_text


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_repository_layout(root: str | Path) -> GitRepositoryLayout:
    worktree = _canonical(root)
    dot_git = worktree / ".git"
    if dot_git.is_dir():
        return GitRepositoryLayout(worktree_root=worktree, git_dir=dot_git.resolve(), bare=False)
    if dot_git.is_file():
        line = dot_git.read_text(encoding="utf-8", errors="replace").splitlines()[0].strip()
        prefix, separator, raw_path = line.partition(":")
        if not separator or prefix.casefold() != "gitdir" or not raw_path.strip():
            raise GitParameterError("Invalid .git file")
        candidate = Path(raw_path.strip()).expanduser()
        if not candidate.is_absolute():
            candidate = worktree / candidate
        git_dir = candidate.resolve()
        if not git_dir.is_dir():
            raise GitParameterError("Referenced gitdir does not exist")
        return GitRepositoryLayout(worktree_root=worktree, git_dir=git_dir, bare=False)
    if (worktree / "HEAD").is_file() and (worktree / "objects").is_dir():
        return GitRepositoryLayout(worktree_root=worktree, git_dir=worktree, bare=True)
    raise GitParameterError("Path is not a Git repository")


def require_repository_scope(
    layout: GitRepositoryLayout,
    *,
    workspace_id: str,
    project_root: str | Path,
    repository_id: str,
    grants: GitAncestorGrantStore,
) -> str:
    return grants.require_access(
        workspace_id=workspace_id,
        project_root=project_root,
        repo_id=repository_id,
        repo_root=layout.worktree_root,
    )


def validate_repo_relative_path(path: str) -> str:
    normalized = path.strip().replace("\\", "/")
    if not normalized or "\x00" in normalized:
        raise GitParameterError("Git path is empty or contains NUL")
    if normalized.startswith(("/", "-")) or re.match(r"^[A-Za-z]:/", normalized):
        raise GitParameterError("Git path must be repository-relative and cannot be an option")
    pure = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in pure.parts):
        raise GitParameterError("Git path contains traversal segments")
    return pure.as_posix()


def resolve_repo_path(layout: GitRepositoryLayout, path: str, *, must_exist: bool = False) -> Path:
    normalized = validate_repo_relative_path(path)
    candidate = (layout.worktree_root / Path(*PurePosixPath(normalized).parts)).resolve()
    if not _is_relative_to(candidate, layout.worktree_root):
        raise GitAccessDenied("Git path resolves outside the repository")
    if must_exist and not candidate.exists():
        raise GitParameterError("Git path does not exist")
    return candidate


_INVALID_REF = re.compile(r"[\x00-\x20~^:?*\\]|\.\.|@\{|//")


def validate_ref_name(value: str, *, allow_head: bool = False) -> str:
    ref = value.strip()
    if allow_head and ref == "HEAD":
        return ref
    if (
        not ref
        or ref.startswith(("-", ".", "/"))
        or ref.endswith(("/", ".", ".lock"))
        or _INVALID_REF.search(ref)
    ):
        raise GitParameterError("Invalid Git ref name")
    return ref


def validate_revision(value: str) -> str:
    revision = value.strip()
    if revision == "HEAD":
        return revision
    if re.fullmatch(r"[0-9a-fA-F]{4,64}", revision):
        return revision
    ancestry = re.fullmatch(
        r"(?P<base>.+?)(?P<suffix>(?:(?:[~^][0-9]*)|(?:@\{[0-9]+\}))+)",
        revision,
    )
    if ancestry is not None:
        base = ancestry.group("base")
        if base != "HEAD" and not re.fullmatch(r"[0-9a-fA-F]{4,64}", base):
            validate_ref_name(base)
        return revision
    return validate_ref_name(revision)


def validate_remote_name(value: str) -> str:
    remote = validate_ref_name(value)
    if "/" in remote:
        raise GitParameterError("Git remote name cannot contain a slash")
    return remote


def validate_remote_url(value: str) -> str:
    url = value.strip()
    if not url or "\x00" in url or "\n" in url or "\r" in url or url.startswith("-"):
        raise GitParameterError("Invalid Git remote URL")
    return url


def ensure_layout_matches(layout: GitRepositoryLayout, expected_root: str | Path) -> None:
    if not _same_path(layout.worktree_root, _canonical(expected_root)):
        raise GitAccessDenied("Resolved repository root does not match the registered repository")
