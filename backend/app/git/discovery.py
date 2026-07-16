from __future__ import annotations

import hashlib
import os
import subprocess
from collections import deque
from pathlib import Path

from .access import GitAccessDenied, GitAncestorGrantStore
from .capabilities import probe_git_capabilities
from .models import (
    GitAncestorAuthorization,
    GitCapabilityResponse,
    GitDiscoveryRequest,
    GitDiscoveryResponse,
    GitRepositoryKind,
    GitRepositoryResponse,
)
from .security import GitParameterError, GitRepositoryLayout, resolve_repository_layout

_SKIP_DIRECTORY_NAMES = {".git", ".venv", "node_modules", "__pycache__"}


def _path_key(path: Path) -> str:
    text = path.resolve().as_posix().rstrip("/")
    return text.casefold() if os.name == "nt" else text


def repository_id(layout: GitRepositoryLayout) -> str:
    source = f"{_path_key(layout.worktree_root)}\0{_path_key(layout.git_dir)}"
    return f"git-{hashlib.sha256(source.encode()).hexdigest()[:20]}"


def discover_git_repositories(
    request: GitDiscoveryRequest,
    *,
    grants: GitAncestorGrantStore,
    capability: GitCapabilityResponse | None = None,
) -> GitDiscoveryResponse:
    capability = capability or probe_git_capabilities()
    if not capability.available:
        return GitDiscoveryResponse(capability=capability)
    project_root = Path(request.project_root).expanduser().resolve()
    if not project_root.is_dir():
        raise GitParameterError("Project root does not exist")

    layouts = _scan_repositories(
        project_root,
        include_nested=request.include_nested,
        max_depth=request.max_depth,
        max_directories=request.max_directories,
        executable=capability.executable or "git",
    )
    layouts = _exclude_ignored_nested_repositories(
        project_root,
        layouts,
        executable=capability.executable or "git",
    )
    repositories = _responses(request.workspace_id, project_root, layouts)
    ancestor = _nearest_ancestor(project_root)
    ancestor_response = None
    if ancestor is not None and all(
        _path_key(item.worktree_root) != _path_key(ancestor.worktree_root) for item in layouts
    ):
        ancestor_id = repository_id(ancestor)
        try:
            grants.require_access(
                workspace_id=request.workspace_id,
                project_root=project_root,
                repo_id=ancestor_id,
                repo_root=ancestor.worktree_root,
            )
            authorization = GitAncestorAuthorization.GRANTED
        except GitAccessDenied:
            authorization = GitAncestorAuthorization.PENDING
        ancestor_response = _response(
            request.workspace_id,
            project_root,
            ancestor,
            kind=GitRepositoryKind.ANCESTOR,
            authorization=authorization,
        )

    return GitDiscoveryResponse(
        capability=capability,
        repositories=repositories,
        ancestor_candidate=ancestor_response,
    )


def _scan_repositories(
    project_root: Path,
    *,
    include_nested: bool,
    max_depth: int,
    max_directories: int,
    executable: str,
) -> list[GitRepositoryLayout]:
    queue: deque[tuple[Path, int]] = deque([(project_root, 0)])
    layouts: list[GitRepositoryLayout] = []
    visited: set[str] = set()
    directory_count = 0
    root_worktree_found = False
    while queue:
        depth = queue[0][1]
        level: list[Path] = []
        while queue and queue[0][1] == depth:
            level.append(queue.popleft()[0])
        children: list[Path] = []
        for directory in level:
            key = _path_key(directory)
            if key in visited:
                continue
            visited.add(key)
            directory_count += 1
            if directory_count > max_directories:
                raise GitParameterError("Git repository discovery directory limit exceeded")
            try:
                layout = resolve_repository_layout(directory)
            except (GitParameterError, OSError):
                layout = None
            if layout is not None:
                layouts.append(layout)
                if (
                    depth == 0
                    and not layout.bare
                    and _path_key(layout.worktree_root) == _path_key(project_root)
                ):
                    root_worktree_found = True
                if not include_nested:
                    continue
            if depth >= max_depth:
                continue
            try:
                directory_children = sorted(
                    (entry for entry in directory.iterdir() if entry.is_dir()),
                    key=lambda path: path.name.casefold(),
                )
            except OSError:
                continue
            children.extend(
                child
                for child in directory_children
                if child.name not in _SKIP_DIRECTORY_NAMES and not child.is_symlink()
            )
        if root_worktree_found and children:
            ignored = _check_ignored_paths(
                project_root,
                [_relative_path(child, project_root) for child in children],
                executable=executable,
            )
            children = [
                child for child in children if _relative_path(child, project_root) not in ignored
            ]
        queue.extend((child, depth + 1) for child in children)
    return layouts


def _nearest_ancestor(project_root: Path) -> GitRepositoryLayout | None:
    for parent in project_root.parents:
        try:
            return resolve_repository_layout(parent)
        except (GitParameterError, OSError):
            continue
    return None


def _exclude_ignored_nested_repositories(
    project_root: Path,
    layouts: list[GitRepositoryLayout],
    *,
    executable: str,
) -> list[GitRepositoryLayout]:
    root_layout = next(
        (
            layout
            for layout in layouts
            if _path_key(layout.worktree_root) == _path_key(project_root) and not layout.bare
        ),
        None,
    )
    if root_layout is None or len(layouts) < 2:
        return layouts
    candidates: dict[str, GitRepositoryLayout] = {}
    for layout in layouts:
        if layout is root_layout:
            continue
        try:
            relative = layout.worktree_root.relative_to(project_root).as_posix()
        except ValueError:
            continue
        candidates[relative] = layout
    if not candidates:
        return layouts
    ignored = _check_ignored_paths(
        project_root,
        list(candidates),
        executable=executable,
    )
    if not ignored:
        return layouts
    return [
        layout
        for layout in layouts
        if layout is root_layout or _relative_layout_path(layout, project_root) not in ignored
    ]


def _check_ignored_paths(
    project_root: Path,
    candidates: list[str],
    *,
    executable: str,
) -> set[str]:
    candidates = [candidate for candidate in candidates if candidate]
    if not candidates:
        return set()
    startupinfo: subprocess.STARTUPINFO | None = None
    creationflags = 0
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        creationflags = subprocess.CREATE_NO_WINDOW
    try:
        result = subprocess.run(
            [
                executable,
                "-c",
                "core.quotepath=false",
                "check-ignore",
                "--stdin",
                "-z",
            ],
            cwd=project_root,
            input="\0".join(candidates) + "\0",
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            stdin=None,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    return {item for item in result.stdout.split("\0") if item}


def _relative_path(path: Path, project_root: Path) -> str:
    return path.relative_to(project_root).as_posix()


def _relative_layout_path(layout: GitRepositoryLayout, project_root: Path) -> str | None:
    try:
        return layout.worktree_root.relative_to(project_root).as_posix()
    except ValueError:
        return None


def _responses(
    workspace_id: str,
    project_root: Path,
    layouts: list[GitRepositoryLayout],
) -> list[GitRepositoryResponse]:
    sorted_layouts = sorted(layouts, key=lambda layout: _path_key(layout.worktree_root))
    ids = {layout.worktree_root: repository_id(layout) for layout in sorted_layouts}
    responses: list[GitRepositoryResponse] = []
    for layout in sorted_layouts:
        parents = [
            candidate
            for candidate in sorted_layouts
            if candidate.worktree_root != layout.worktree_root
            and _is_relative_to(layout.worktree_root, candidate.worktree_root)
        ]
        parent = max(parents, key=lambda item: len(item.worktree_root.parts), default=None)
        kind = (
            GitRepositoryKind.WORKSPACE
            if _path_key(layout.worktree_root) == _path_key(project_root)
            else GitRepositoryKind.NESTED
        )
        responses.append(
            _response(
                workspace_id,
                project_root,
                layout,
                kind=kind,
                parent_repo_id=ids.get(parent.worktree_root) if parent else None,
            )
        )
    return responses


def _response(
    workspace_id: str,
    project_root: Path,
    layout: GitRepositoryLayout,
    *,
    kind: GitRepositoryKind,
    parent_repo_id: str | None = None,
    authorization: GitAncestorAuthorization = GitAncestorAuthorization.NOT_REQUIRED,
) -> GitRepositoryResponse:
    try:
        relative = layout.worktree_root.relative_to(project_root).as_posix() or "."
    except ValueError:
        relative = layout.worktree_root.name or layout.worktree_root.as_posix()
    return GitRepositoryResponse(
        id=repository_id(layout),
        workspace_id=workspace_id,
        root_path=str(layout.worktree_root),
        display_path=relative,
        git_dir_path=str(layout.git_dir),
        kind=kind,
        parent_repo_id=parent_repo_id,
        bare=layout.bare,
        ancestor_authorization=authorization,
    )


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
