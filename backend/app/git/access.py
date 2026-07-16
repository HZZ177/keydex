from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path


class GitAccessDenied(PermissionError):
    """Raised when a repository is outside the Git-specific authorized scope."""


def _canonical(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def _path_key(path: str | Path) -> str:
    value = _canonical(path).as_posix().rstrip("/")
    return value.casefold() if os.name == "nt" else value


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


@dataclass(frozen=True)
class GitAncestorGrant:
    workspace_id: str
    project_root: str
    repo_id: str
    repo_root: str
    granted_at: str
    scope: str = "git_only"

    def matches(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        repo_id: str,
        repo_root: str | Path,
    ) -> bool:
        return (
            self.scope == "git_only"
            and self.workspace_id == workspace_id
            and self.repo_id == repo_id
            and _path_key(self.project_root) == _path_key(project_root)
            and _path_key(self.repo_root) == _path_key(repo_root)
        )


class GitAncestorGrantStore:
    """Persistent grants for Git operations only.

    This store is intentionally not consulted by the workspace file security
    module. An ancestor grant therefore cannot broaden generic file, terminal,
    or tool access.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._lock = threading.RLock()

    def list(self) -> tuple[GitAncestorGrant, ...]:
        with self._lock:
            if not self._path.exists():
                return ()
            try:
                payload = json.loads(self._path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                return ()
            if not isinstance(payload, list):
                return ()
            grants: list[GitAncestorGrant] = []
            for item in payload:
                if not isinstance(item, dict):
                    continue
                try:
                    grant = GitAncestorGrant(**item)
                except TypeError:
                    continue
                if grant.scope == "git_only":
                    grants.append(grant)
            return tuple(grants)

    def authorize(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        repo_id: str,
        repo_root: str | Path,
    ) -> GitAncestorGrant:
        project = _canonical(project_root)
        repo = _canonical(repo_root)
        if project == repo or not _is_relative_to(project, repo):
            raise GitAccessDenied("Only a strict ancestor repository can receive an ancestor grant")
        grant = GitAncestorGrant(
            workspace_id=workspace_id,
            project_root=str(project),
            repo_id=repo_id,
            repo_root=str(repo),
            granted_at=datetime.now(UTC).isoformat(),
        )
        with self._lock:
            remaining = [
                item
                for item in self.list()
                if not (
                    item.workspace_id == workspace_id
                    and _path_key(item.project_root) == _path_key(project)
                )
            ]
            self._write([*remaining, grant])
        return grant

    def revoke(self, *, workspace_id: str, project_root: str | Path) -> bool:
        with self._lock:
            existing = list(self.list())
            remaining = [
                item
                for item in existing
                if not (
                    item.workspace_id == workspace_id
                    and _path_key(item.project_root) == _path_key(project_root)
                )
            ]
            if len(remaining) == len(existing):
                return False
            self._write(remaining)
            return True

    def require_access(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        repo_id: str,
        repo_root: str | Path,
    ) -> str:
        project = _canonical(project_root)
        repo = _canonical(repo_root)
        if _is_relative_to(repo, project):
            return "workspace"
        matching = next(
            (
                grant
                for grant in self.list()
                if grant.matches(
                    workspace_id=workspace_id,
                    project_root=project,
                    repo_id=repo_id,
                    repo_root=repo,
                )
            ),
            None,
        )
        if matching is None:
            raise GitAccessDenied(
                "Repository is outside the workspace and has no Git ancestor grant"
            )
        return "ancestor_grant"

    def _write(self, grants: list[GitAncestorGrant]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self._path.name}.", suffix=".tmp", dir=self._path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                json.dump([asdict(grant) for grant in grants], stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._path)
        finally:
            temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class GitWorktreeGrant:
    workspace_id: str
    project_root: str
    parent_repo_id: str
    worktree_path: str
    granted_at: str
    scope: str = "git_worktree"

    def matches(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        parent_repo_id: str,
        worktree_path: str | Path,
    ) -> bool:
        return (
            self.scope == "git_worktree"
            and self.workspace_id == workspace_id
            and self.parent_repo_id == parent_repo_id
            and _path_key(self.project_root) == _path_key(project_root)
            and _path_key(self.worktree_path) == _path_key(worktree_path)
        )


class GitWorktreeGrantStore:
    """Exact-path grants for sibling/external worktrees.

    Sharing a common Git directory never grants workspace/file access. The grant
    is bound to one project, one parent repository identity, and one target path.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._lock = threading.RLock()

    def list(self) -> tuple[GitWorktreeGrant, ...]:
        with self._lock:
            if not self._path.exists():
                return ()
            try:
                payload = json.loads(self._path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                return ()
            if not isinstance(payload, list):
                return ()
            grants: list[GitWorktreeGrant] = []
            for item in payload:
                if not isinstance(item, dict):
                    continue
                try:
                    grant = GitWorktreeGrant(**item)
                except TypeError:
                    continue
                if grant.scope == "git_worktree":
                    grants.append(grant)
            return tuple(grants)

    def authorize(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        parent_repo_id: str,
        worktree_path: str | Path,
    ) -> GitWorktreeGrant:
        project = _canonical(project_root)
        target = _canonical(worktree_path)
        if _is_relative_to(target, project):
            raise GitAccessDenied("Worktrees inside the project do not require an external grant")
        if target == target.parent or not target.parent.is_dir():
            raise GitAccessDenied("The external worktree parent directory must exist")
        grant = GitWorktreeGrant(
            workspace_id=workspace_id,
            project_root=str(project),
            parent_repo_id=parent_repo_id,
            worktree_path=str(target),
            granted_at=datetime.now(UTC).isoformat(),
        )
        with self._lock:
            remaining = [
                item
                for item in self.list()
                if not item.matches(
                    workspace_id=workspace_id,
                    project_root=project,
                    parent_repo_id=parent_repo_id,
                    worktree_path=target,
                )
            ]
            self._write([*remaining, grant])
        return grant

    def is_authorized(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        parent_repo_id: str,
        worktree_path: str | Path,
    ) -> bool:
        return any(
            item.matches(
                workspace_id=workspace_id,
                project_root=project_root,
                parent_repo_id=parent_repo_id,
                worktree_path=worktree_path,
            )
            for item in self.list()
        )

    def revoke(
        self,
        *,
        workspace_id: str,
        project_root: str | Path,
        parent_repo_id: str,
        worktree_path: str | Path,
    ) -> bool:
        with self._lock:
            existing = list(self.list())
            remaining = [
                item
                for item in existing
                if not item.matches(
                    workspace_id=workspace_id,
                    project_root=project_root,
                    parent_repo_id=parent_repo_id,
                    worktree_path=worktree_path,
                )
            ]
            if len(existing) == len(remaining):
                return False
            self._write(remaining)
            return True

    def _write(self, grants: list[GitWorktreeGrant]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self._path.name}.", suffix=".tmp", dir=self._path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                json.dump([asdict(grant) for grant in grants], stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._path)
        finally:
            temporary.unlink(missing_ok=True)
