from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

from .access import GitAccessDenied, GitAncestorGrantStore, GitWorktreeGrantStore
from .advanced import (
    REFLOG_FORMAT,
    GitAdvancedParseError,
    parse_blame_porcelain,
    parse_lfs_json,
    parse_lfs_locks_json,
    parse_reflog,
    parse_submodule_status,
    parse_worktree_porcelain,
)
from .capabilities import probe_git_capabilities
from .conflicts import (
    classify_conflict,
    decode_conflict_content,
    parse_unmerged_index,
    resolution_actions,
)
from .diff import apply_numstat, parse_git_diff, parse_numstat_z
from .discovery import discover_git_repositories
from .history import LOG_FORMAT, parse_git_log
from .history_query import (
    GitHistoryQuery,
    build_history_log_args,
    normalize_history_query,
    with_exact_revision,
)
from .models import (
    GitAncestorGrantRequest,
    GitAncestorGrantResponse,
    GitApiError,
    GitBisectSnapshotResponse,
    GitBlameResponse,
    GitCapabilityResponse,
    GitCommitDetailResponse,
    GitCompareResponse,
    GitConflictFileResponse,
    GitConflictResultSaveRequest,
    GitConflictResultSaveResponse,
    GitConflictsResponse,
    GitConflictStageResponse,
    GitDiffResponse,
    GitDiscoveryRequest,
    GitDiscoveryResponse,
    GitFileDiffResponse,
    GitFileStatusCode,
    GitHistoryPageResponse,
    GitIdentityResponse,
    GitIdentityUpdateRequest,
    GitLfsSnapshotResponse,
    GitMergePreviewResponse,
    GitPatchExportResponse,
    GitRebasePreviewItem,
    GitRebasePreviewResponse,
    GitReflogResponse,
    GitRefsResponse,
    GitRemotesResponse,
    GitRepositoryRequest,
    GitRepositoryResponse,
    GitResetPreviewFile,
    GitResetPreviewResponse,
    GitStashDetailResponse,
    GitStashPageResponse,
    GitStatusResponse,
    GitSubmodulesSnapshotResponse,
    GitWorktreeCommandRequest,
    GitWorktreeGrantRequest,
    GitWorktreeGrantResponse,
    GitWorktreePathsRequest,
    GitWorktreePathsResponse,
    GitWorktreesSnapshotResponse,
)
from .refs import REF_FORMAT, parse_for_each_ref
from .remotes import parse_remote_verbose
from .runner import GitCliRunner, GitCommandResult, redact_git_output
from .security import (
    GitParameterError,
    resolve_repo_path,
    resolve_repository_layout,
    validate_repo_relative_path,
    validate_revision,
)
from .stash import STASH_FORMAT, parse_stash_list
from .state import detect_in_progress_operation
from .status import GitStatusParseError, parse_porcelain_v2_status

_ModelT = TypeVar("_ModelT", bound=BaseModel)
_QueryT = TypeVar("_QueryT")
_MAX_EDITABLE_CONFLICT_BYTES = 1024 * 1024
_READ_ONLY_GIT_ENV = {"GIT_OPTIONAL_LOCKS": "0"}


@dataclass(frozen=True)
class _RegisteredRepository:
    response: GitRepositoryResponse
    project_root: Path


class GitQueryService:
    def __init__(
        self,
        *,
        grants: GitAncestorGrantStore,
        worktree_grants: GitWorktreeGrantStore | None = None,
        runner: GitCliRunner | None = None,
        max_concurrent_queries: int = 2,
    ) -> None:
        if max_concurrent_queries < 1:
            raise ValueError("Git query concurrency limit must be positive")
        self._grants = grants
        self._worktree_grants = worktree_grants
        self._runner = runner or GitCliRunner(max_concurrency=max_concurrent_queries)
        self._repositories: dict[tuple[str, str], _RegisteredRepository] = {}
        self._cache: dict[tuple[str, str, str], BaseModel] = {}
        self._repository_versions: dict[str, str] = {}
        self._commit_detail_cache: OrderedDict[
            tuple[str, str, str | None], GitCommitDetailResponse
        ] = OrderedDict()
        self._capability: GitCapabilityResponse | None = None
        self._capability_lock = threading.Lock()
        self._lock = asyncio.Lock()
        self._query_semaphore = asyncio.Semaphore(max_concurrent_queries)
        self._repository_query_locks: dict[tuple[str, str, str], asyncio.Lock] = {}
        self._inflight_queries: dict[tuple[object, ...], asyncio.Task[object]] = {}
        self._inflight_query_waiters: dict[tuple[object, ...], int] = {}

    async def coalesced_query(
        self,
        request: GitRepositoryRequest,
        domain: str,
        factory: Callable[[], Awaitable[_QueryT]],
        *,
        variant: tuple[object, ...] = (),
    ) -> _QueryT:
        """Share identical reads and serialize expensive reads for one repository."""
        repository_key = (
            request.workspace_id,
            str(Path(request.project_root).expanduser().resolve()),
            request.repository_id,
        )
        query_key = (*repository_key, domain, *variant)
        async with self._lock:
            existing = self._inflight_queries.get(query_key)
            if existing is None:
                repository_lock = self._repository_query_locks.setdefault(
                    repository_key, asyncio.Lock()
                )
                task = asyncio.create_task(
                    self._run_coalesced_query(repository_lock, factory)
                )
                self._inflight_queries[query_key] = task
                task.add_done_callback(
                    lambda completed, key=query_key: self._forget_inflight_query(
                        key, completed
                    )
                )
            else:
                task = existing
            self._inflight_query_waiters[query_key] = (
                self._inflight_query_waiters.get(query_key, 0) + 1
            )
        try:
            return await asyncio.shield(task)  # type: ignore[return-value]
        finally:
            async with self._lock:
                remaining = self._inflight_query_waiters.get(query_key, 1) - 1
                if remaining > 0:
                    self._inflight_query_waiters[query_key] = remaining
                else:
                    self._inflight_query_waiters.pop(query_key, None)
                    if not task.done():
                        task.cancel()

    async def _run_coalesced_query(
        self,
        repository_lock: asyncio.Lock,
        factory: Callable[[], Awaitable[_QueryT]],
    ) -> _QueryT:
        async with repository_lock:
            async with self._query_semaphore:
                return await factory()

    @property
    def runner(self) -> GitCliRunner:
        """The single process budget shared by Git reads and mutations."""
        return self._runner

    def _forget_inflight_query(
        self,
        key: tuple[object, ...],
        task: asyncio.Task[object],
    ) -> None:
        if self._inflight_queries.get(key) is task:
            self._inflight_queries.pop(key, None)
        if task.cancelled():
            return
        task.exception()

    def discover(self, request: GitDiscoveryRequest) -> GitDiscoveryResponse:
        response = discover_git_repositories(
            request,
            grants=self._grants,
            capability=self._capability_snapshot(),
        )
        project_root = Path(request.project_root).expanduser().resolve()
        for repository in [*response.repositories, response.ancestor_candidate]:
            if repository is not None:
                self._repositories[(request.workspace_id, repository.id)] = _RegisteredRepository(
                    response=repository,
                    project_root=project_root,
                )
        return response

    def _capability_snapshot(self) -> GitCapabilityResponse:
        capability = self._capability
        if capability is not None:
            return capability
        with self._capability_lock:
            if self._capability is None:
                self._capability = probe_git_capabilities()
            return self._capability

    def capabilities(self) -> GitCapabilityResponse:
        return self._capability_snapshot()

    def authorize_ancestor(self, request: GitAncestorGrantRequest) -> GitAncestorGrantResponse:
        discovery = self.discover(
            GitDiscoveryRequest(
                workspace_id=request.workspace_id,
                project_root=request.project_root,
            )
        )
        candidate = discovery.ancestor_candidate
        if (
            candidate is None
            or candidate.id != request.repository_id
            or Path(candidate.root_path).resolve() != Path(request.repository_root).resolve()
        ):
            raise GitApiError(
                "git_ancestor_not_authorized",
                "Ancestor grant no longer matches the discovered repository",
            )
        grant = self._grants.authorize(
            workspace_id=request.workspace_id,
            project_root=request.project_root,
            repo_id=request.repository_id,
            repo_root=request.repository_root,
        )
        return GitAncestorGrantResponse(
            workspace_id=grant.workspace_id,
            project_root=grant.project_root,
            repository_id=grant.repo_id,
            repository_root=grant.repo_root,
        )

    def revoke_ancestor(self, *, workspace_id: str, project_root: str) -> bool:
        return self._grants.revoke(workspace_id=workspace_id, project_root=project_root)

    def authorize_worktree(
        self, request: GitWorktreeGrantRequest
    ) -> GitWorktreeGrantResponse:
        registered = self._resolve(request)
        if self._worktree_grants is None:
            raise GitApiError("git_unavailable", "Worktree authorization store is unavailable")
        try:
            grant = self._worktree_grants.authorize(
                workspace_id=request.workspace_id,
                project_root=request.project_root,
                parent_repo_id=registered.response.id,
                worktree_path=request.worktree_path,
            )
        except GitAccessDenied as exc:
            raise GitApiError("git_access_denied", str(exc)) from exc
        self.invalidate(registered.response.id)
        return GitWorktreeGrantResponse(
            workspace_id=grant.workspace_id,
            project_root=grant.project_root,
            parent_repository_id=grant.parent_repo_id,
            worktree_path=grant.worktree_path,
        )

    def revoke_worktree(
        self, request: GitWorktreeGrantRequest
    ) -> bool:
        registered = self._resolve(request)
        revoked = bool(
            self._worktree_grants
            and self._worktree_grants.revoke(
                workspace_id=request.workspace_id,
                project_root=request.project_root,
                parent_repo_id=registered.response.id,
                worktree_path=request.worktree_path,
            )
        )
        if revoked:
            self.invalidate(registered.response.id)
        return revoked

    async def status(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitStatusResponse:
        registered = self._resolve(request)
        if registered.response.bare:
            raise GitApiError(
                "git_validation_failed",
                "Git status is unavailable for a bare repository",
                repository_id=registered.response.id,
            )
        result = await self._run(
            registered,
            [
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
            cancel_event=cancel_event,
        )
        # Refresh after Git returns so a metadata mutation racing this query
        # cannot leave the response carrying a stale token.
        version = await self.version_async(registered.response, refresh=True)
        try:
            status = parse_porcelain_v2_status(
                result.stdout,
                repository_id=registered.response.id,
                repository_version=version,
            )
        except GitStatusParseError as exc:
            raise GitApiError(
                "git_parse_failed",
                str(exc),
                retryable=True,
                details={
                    "diagnostic": (
                        "Repository HEAD or status metadata is unreadable; "
                        "repair it and retry."
                    ),
                },
            ) from exc
        status.operation = detect_in_progress_operation(
            registered.response.git_dir_path,
            has_unmerged_files=any(item.conflicted for item in status.files),
        )
        return status

    async def worktree_paths(
        self,
        request: GitWorktreePathsRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitWorktreePathsResponse:
        registered = self._resolve(request)
        if registered.response.bare:
            return GitWorktreePathsResponse(repository_id=registered.response.id, paths=[])
        result = await self._runner.run(
            ["check-ignore", "-z", "--stdin"],
            cwd=registered.response.root_path,
            env=_READ_ONLY_GIT_ENV,
            input_text="\0".join(request.paths) + "\0",
            cancel_event=cancel_event,
            timeout_seconds=10,
        )
        if result.cancelled:
            raise GitApiError("git_cancelled", "Git path filtering was cancelled")
        if result.timed_out:
            raise GitApiError("git_timeout", "Git path filtering timed out", retryable=True)
        # git check-ignore returns 1 when none of the paths are ignored.
        if result.returncode not in {0, 1}:
            raise GitApiError(
                "git_failed",
                result.safe_stderr.strip() or "Git path filtering failed",
                repository_id=registered.response.id,
            )
        ignored = {path for path in result.stdout.split("\0") if path}
        return GitWorktreePathsResponse(
            repository_id=registered.response.id,
            paths=[path for path in request.paths if path not in ignored],
        )

    async def bisect(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitBisectSnapshotResponse:
        registered = self._resolve(request)
        version = await self.version_async(registered.response)
        cached = self._cached(
            registered.response.id, version, "bisect", GitBisectSnapshotResponse
        )
        if cached is not None:
            return cached
        refs_result = await self._run(
            registered,
            ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/bisect"],
            cancel_event=cancel_event,
        )
        good, bad, skipped = _parse_bisect_refs(refs_result.stdout)
        marker_result = await self._run(
            registered,
            ["rev-parse", "--git-path", "BISECT_START"],
            cancel_event=cancel_event,
        )
        marker = Path(marker_result.stdout.strip())
        if not marker.is_absolute():
            marker = Path(registered.response.root_path) / marker
        active = marker.is_file()
        current: str | None = None
        candidates: list[str] = []
        remaining_count = 0
        if active:
            current_result = await self._run(
                registered, ["rev-parse", "HEAD"], cancel_event=cancel_event
            )
            current = current_result.stdout.strip() or None
        if active and bad and good:
            revision_args = [bad, "--not", *good]
            count_result = await self._run(
                registered,
                ["rev-list", "--count", *revision_args],
                cancel_event=cancel_event,
            )
            try:
                remaining_count = int(count_result.stdout.strip())
            except ValueError as exc:
                raise GitApiError(
                    "git_parse_failed", "Git returned an invalid bisect candidate count"
                ) from exc
            candidates_result = await self._run(
                registered,
                ["rev-list", "--max-count=200", *revision_args],
                cancel_event=cancel_event,
            )
            candidates = [line for line in candidates_result.stdout.splitlines() if line]
        original_head = _read_optional_line(marker) if active else None
        culprit = _read_bisect_culprit(marker.with_name("BISECT_LOG"))
        response = GitBisectSnapshotResponse(
            repository_id=registered.response.id,
            repository_version=version,
            active=active,
            original_head=original_head,
            current_revision=current,
            good_revisions=good,
            bad_revision=bad,
            skipped_revisions=skipped,
            candidate_revisions=candidates,
            remaining_count=remaining_count,
            culprit_revision=culprit,
        )
        return self._store(registered.response.id, version, "bisect", response)

    async def submodules(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitSubmodulesSnapshotResponse:
        registered = self._resolve(request)
        version = await self.version_async(registered.response)
        cached = self._cached(
            registered.response.id,
            version,
            "submodules",
            GitSubmodulesSnapshotResponse,
        )
        if cached is not None:
            return cached
        root = Path(registered.response.root_path)
        if not (root / ".gitmodules").is_file():
            return self._store(
                registered.response.id,
                version,
                "submodules",
                GitSubmodulesSnapshotResponse(
                    repository_id=registered.response.id,
                    repository_version=version,
                ),
            )
        status_result, config_result = await asyncio.gather(
            self._run(
                registered,
                ["submodule", "status", "--recursive"],
                cancel_event=cancel_event,
            ),
            self._run(
                registered,
                [
                    "config",
                    "--file",
                    ".gitmodules",
                    "--get-regexp",
                    r"^submodule\..*\.(path|url)$",
                ],
                cancel_event=cancel_event,
            ),
        )
        config = _parse_submodule_config(config_result.stdout)
        submodules = parse_submodule_status(status_result.stdout)
        name_by_path = {
            values["path"]: name for name, values in config.items() if "path" in values
        }
        for submodule in submodules:
            name = name_by_path.get(submodule.path)
            values = config.get(name, {}) if name else {}
            child_root = resolve_repo_path(
                resolve_repository_layout(registered.response.root_path), submodule.path
            )
            submodule.name = name
            submodule.url = redact_git_output(values.get("url", "")) or None
            submodule.parent_repository_id = registered.response.id
            submodule.child_root_path = str(child_root) if child_root.is_dir() else None
            submodule.initialized = submodule.state != "uninitialized" and child_root.is_dir()
        response = GitSubmodulesSnapshotResponse(
            repository_id=registered.response.id,
            repository_version=version,
            submodules=submodules,
        )
        return self._store(registered.response.id, version, "submodules", response)

    async def worktrees(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitWorktreesSnapshotResponse:
        registered = self._resolve(request)
        version = await self.version_async(registered.response)
        cached = self._cached(
            registered.response.id, version, "worktrees", GitWorktreesSnapshotResponse
        )
        if cached is not None:
            return cached
        result = await self._run(
            registered,
            ["worktree", "list", "--porcelain"],
            cancel_event=cancel_event,
        )
        worktrees = parse_worktree_porcelain(result.stdout)
        project_root = Path(request.project_root).expanduser().resolve()
        primary_root = Path(registered.response.root_path).resolve()
        for worktree in worktrees:
            target = Path(worktree.path).expanduser().resolve()
            worktree.primary = target == primary_root
            inside_project = _is_path_within(target, project_root)
            externally_authorized = bool(
                self._worktree_grants
                and self._worktree_grants.is_authorized(
                    workspace_id=request.workspace_id,
                    project_root=request.project_root,
                    parent_repo_id=registered.response.id,
                    worktree_path=target,
                )
            )
            worktree.authorization_required = not inside_project and not worktree.primary
            worktree.authorized = inside_project or worktree.primary or externally_authorized
            if worktree.authorized and target.is_dir():
                status = await self._runner.run(
                    ("status", "--porcelain"),
                    cwd=target,
                    env=_READ_ONLY_GIT_ENV,
                    timeout_seconds=30,
                    cancel_event=cancel_event,
                )
                worktree.dirty = bool(status.stdout.strip()) if status.succeeded else None
        response = GitWorktreesSnapshotResponse(
            repository_id=registered.response.id,
            repository_version=version,
            worktrees=worktrees,
        )
        return self._store(registered.response.id, version, "worktrees", response)

    async def lfs(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitLfsSnapshotResponse:
        registered = self._resolve(request)
        version = await self.version_async(registered.response)
        cached = self._cached(
            registered.response.id, version, "lfs", GitLfsSnapshotResponse
        )
        if cached is not None:
            return cached
        version_result = await self._runner.run(
            ("lfs", "version"),
            cwd=registered.response.root_path,
            timeout_seconds=20,
            cancel_event=cancel_event,
        )
        if not version_result.succeeded or "git-lfs/" not in (
            version_result.stdout or version_result.stderr
        ).lower():
            response = GitLfsSnapshotResponse(
                repository_id=registered.response.id,
                repository_version=version,
                available=False,
                reason="Git LFS is not installed or is unavailable for this Git executable",
                tracked_patterns=_read_lfs_patterns(Path(registered.response.root_path)),
            )
            return self._store(registered.response.id, version, "lfs", response)
        files_result, locks_result = await asyncio.gather(
            self._runner.run(
                ("lfs", "ls-files", "--json"),
                cwd=registered.response.root_path,
                timeout_seconds=120,
                cancel_event=cancel_event,
            ),
            self._runner.run(
                ("lfs", "locks", "--json"),
                cwd=registered.response.root_path,
                timeout_seconds=10,
                cancel_event=cancel_event,
            ),
        )
        try:
            files = parse_lfs_json(files_result.stdout) if files_result.succeeded else []
            locks = parse_lfs_locks_json(locks_result.stdout) if locks_result.succeeded else []
        except GitAdvancedParseError as exc:
            files = []
            locks = []
            locks_result = replace(locks_result, returncode=1, stderr=str(exc))
        reason = None
        if not files_result.succeeded:
            reason = redact_git_output(files_result.stderr) or "Git LFS file status is unavailable"
        response = GitLfsSnapshotResponse(
            repository_id=registered.response.id,
            repository_version=version,
            available=True,
            reason=reason,
            tracked_patterns=_read_lfs_patterns(Path(registered.response.root_path)),
            files=files,
            locks=locks,
            locks_available=locks_result.succeeded,
        )
        return self._store(registered.response.id, version, "lfs", response)

    async def validate_worktree_command(
        self,
        request: GitWorktreeCommandRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> None:
        if request.action == "prune":
            return
        registered = self._resolve(request)
        assert request.worktree_path is not None
        target = Path(request.worktree_path).expanduser()
        if not target.is_absolute():
            raise GitApiError("git_validation_failed", "Worktree path must be absolute")
        target = target.resolve()
        primary = Path(registered.response.root_path).resolve()
        if request.action == "remove" and target == primary:
            raise GitApiError("git_validation_failed", "The primary worktree cannot be removed")
        inside_project = _is_path_within(
            target, Path(request.project_root).expanduser().resolve()
        )
        authorized = inside_project or target == primary or bool(
            self._worktree_grants
            and self._worktree_grants.is_authorized(
                workspace_id=request.workspace_id,
                project_root=request.project_root,
                parent_repo_id=registered.response.id,
                worktree_path=target,
            )
        )
        if not authorized:
            raise GitApiError(
                "git_access_denied",
                "External worktree path requires an exact Git worktree grant",
            )
        if request.action == "remove" and target.is_dir():
            status = await self._runner.run(
                ("status", "--porcelain"),
                cwd=target,
                env=_READ_ONLY_GIT_ENV,
                timeout_seconds=30,
                cancel_event=cancel_event,
            )
            dirty = status.succeeded and bool(status.stdout.strip())
            if dirty and not request.dirty_confirmed:
                raise GitApiError(
                    "git_operation_conflict",
                    "Dirty worktree removal requires explicit dirty confirmation",
                )

    async def refs(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitRefsResponse:
        registered = self._resolve(request)
        version = await self.version_async(registered.response)
        cached = self._cached(registered.response.id, version, "refs", GitRefsResponse)
        if cached is not None:
            return cached
        result = await self._run(
            registered,
            ["for-each-ref", f"--format={REF_FORMAT}", "refs/heads", "refs/remotes", "refs/tags"],
            cancel_event=cancel_event,
        )
        return self._store(
            registered.response.id,
            version,
            "refs",
            GitRefsResponse(
                repository_id=registered.response.id,
                repository_version=version,
                refs=parse_for_each_ref(result.stdout),
            ),
        )

    async def remotes(self, request: GitRepositoryRequest) -> GitRemotesResponse:
        registered = self._resolve(request)
        version = await self.version_async(registered.response)
        result, refs = await asyncio.gather(
            self._run(registered, ["remote", "--verbose"], cancel_event=None),
            self.refs(request),
        )
        tracking: dict[str, list[str]] = {}
        for ref in refs.refs:
            prefix = "refs/remotes/"
            if ref.kind != "local" or not ref.upstream or not ref.upstream.startswith(prefix):
                continue
            remote_and_branch = ref.upstream.removeprefix(prefix)
            remote, separator, _branch = remote_and_branch.partition("/")
            if separator:
                tracking.setdefault(remote, []).append(ref.short_name)
        return GitRemotesResponse(
            repository_id=registered.response.id,
            repository_version=version,
            remotes=parse_remote_verbose(result.safe_stdout, tracking),
        )

    async def history(
        self,
        request: GitRepositoryRequest,
        *,
        cursor: str | None = None,
        limit: int = 100,
        query: GitHistoryQuery | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitHistoryPageResponse:
        if limit < 1 or limit > 500:
            raise GitApiError("git_validation_failed", "History limit must be between 1 and 500")
        registered = self._resolve(request)
        version = await self.version_async(registered.response, refresh=cursor is not None)
        offset = decode_cursor(cursor, registered.response.id, version) if cursor else 0
        try:
            normalized_query = normalize_history_query(query or GitHistoryQuery())
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc

        if normalized_query.hash_prefix:
            resolved = await self._resolve_history_hash(
                registered,
                normalized_query.hash_prefix,
                cancel_event=cancel_event,
            )
            if resolved is None:
                return GitHistoryPageResponse(
                    repository_id=registered.response.id,
                    repository_version=version,
                    commits=[],
                    next_cursor=None,
                )
            if normalized_query.revision and not await self._revision_contains_commit(
                registered,
                normalized_query.revision,
                resolved,
                cancel_event=cancel_event,
            ):
                return GitHistoryPageResponse(
                    repository_id=registered.response.id,
                    repository_version=version,
                    commits=[],
                    next_cursor=None,
                )
            normalized_query = with_exact_revision(normalized_query, resolved)
        result = await self._run(
            registered,
            build_history_log_args(normalized_query, offset=offset, limit=limit),
            cancel_event=cancel_event,
        )
        commits = parse_git_log(result.stdout)
        has_more = len(commits) > limit
        return GitHistoryPageResponse(
            repository_id=registered.response.id,
            repository_version=version,
            commits=commits[:limit],
            next_cursor=encode_cursor(registered.response.id, version, offset + limit)
            if has_more
            else None,
        )

    async def _resolve_history_hash(
        self,
        registered: _RegisteredRepository,
        hash_prefix: str,
        *,
        cancel_event: asyncio.Event | None,
    ) -> str | None:
        result = await self._runner.run(
            ("rev-parse", "--verify", "--quiet", f"{hash_prefix}^{{commit}}"),
            cwd=registered.response.root_path,
            cancel_event=cancel_event,
            timeout_seconds=60,
        )
        if result.cancelled:
            raise GitApiError("git_cancelled", "Git query was cancelled")
        if result.timed_out:
            raise GitApiError("git_timeout", "Git query timed out", retryable=True)
        if not result.succeeded:
            return None
        object_id = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        return object_id if object_id else None

    async def _revision_contains_commit(
        self,
        registered: _RegisteredRepository,
        revision: str,
        object_id: str,
        *,
        cancel_event: asyncio.Event | None,
    ) -> bool:
        result = await self._runner.run(
            ("merge-base", "--is-ancestor", object_id, revision),
            cwd=registered.response.root_path,
            cancel_event=cancel_event,
            timeout_seconds=60,
        )
        if result.cancelled:
            raise GitApiError("git_cancelled", "Git query was cancelled")
        if result.timed_out:
            raise GitApiError("git_timeout", "Git query timed out", retryable=True)
        if result.returncode in {0, 1}:
            return result.returncode == 0
        raise GitApiError(
            "git_failed",
            result.safe_stderr.strip() or "Git revision filter failed",
            repository_id=registered.response.id,
        )

    async def diff(
        self,
        request: GitRepositoryRequest,
        *,
        cached: bool = False,
        path: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitDiffResponse:
        registered = self._resolve(request)
        if registered.response.bare:
            raise GitApiError(
                "git_validation_failed",
                "Git diff is unavailable for a bare repository",
                repository_id=registered.response.id,
            )
        version = await self.version_async(registered.response)
        base = ["diff", "--no-ext-diff", "--binary", "--find-renames"]
        numstat_args = ["diff", "--no-ext-diff", "--find-renames", "--numstat", "-z"]
        normalized_path: str | None = None
        if cached:
            base.append("--cached")
            numstat_args.append("--cached")
        if path is not None:
            try:
                normalized_path = validate_repo_relative_path(path)
            except GitParameterError as exc:
                raise GitApiError("git_validation_failed", str(exc)) from exc
            base.extend(["--", normalized_path])
            numstat_args.extend(["--", normalized_path])
        patch, numstat = await asyncio.gather(
            self._run(registered, base, cancel_event=cancel_event),
            self._run(registered, numstat_args, cancel_event=cancel_event),
        )
        files = apply_numstat(
            parse_git_diff(patch.stdout, truncated=patch.stdout_truncated),
            parse_numstat_z(numstat.stdout),
        )
        if not cached and normalized_path is not None and not files:
            files = await self._untracked_path_diff(
                registered,
                normalized_path,
                cancel_event=cancel_event,
            )
        return GitDiffResponse(
            repository_id=registered.response.id,
            repository_version=version,
            files=files,
        )

    async def _untracked_path_diff(
        self,
        registered: _RegisteredRepository,
        path: str,
        *,
        cancel_event: asyncio.Event | None,
    ) -> list[GitFileDiffResponse]:
        untracked = await self._run(
            registered,
            ["ls-files", "--others", "--exclude-standard", "-z", "--", path],
            cancel_event=cancel_event,
        )
        if path not in _nul_paths(untracked.stdout):
            return []

        result = await self._runner.run(
            ("diff", "--no-ext-diff", "--no-index", "--binary", "--", "/dev/null", path),
            cwd=registered.response.root_path,
            env=_READ_ONLY_GIT_ENV,
            cancel_event=cancel_event,
            timeout_seconds=60,
        )
        if result.cancelled:
            raise GitApiError("git_cancelled", "Git query was cancelled")
        if result.timed_out:
            raise GitApiError("git_timeout", "Git query timed out", retryable=True)
        if result.returncode not in {0, 1}:
            raise GitApiError(
                "git_failed",
                result.safe_stderr.strip() or "Git untracked file diff failed",
                repository_id=registered.response.id,
            )

        files = parse_git_diff(result.stdout, truncated=result.stdout_truncated)
        if not files:
            return [GitFileDiffResponse(
                old_path=None,
                new_path=path,
                status=GitFileStatusCode.UNTRACKED,
                binary=False,
                new_mode="100644",
                additions=0,
                deletions=0,
                hunks=[],
                raw_patch=(
                    f"diff --git a/{path} b/{path}\n"
                    "new file mode 100644\n"
                    "--- /dev/null\n"
                    f"+++ b/{path}\n"
                ),
                truncated=result.stdout_truncated,
            )]
        return [
            file.model_copy(update={
                "status": GitFileStatusCode.UNTRACKED,
                "additions": None if file.binary else sum(
                    1 for hunk in file.hunks for line in hunk.lines if line.startswith("+")
                ),
                "deletions": None if file.binary else sum(
                    1 for hunk in file.hunks for line in hunk.lines if line.startswith("-")
                ),
            })
            for file in files
        ]

    async def compare(
        self,
        request: GitRepositoryRequest,
        *,
        mode: str,
        left: str,
        right: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitCompareResponse:
        if mode not in {"commit", "two_dot", "three_dot", "working_tree"}:
            raise GitApiError("git_validation_failed", "Unknown Git comparison mode")
        registered = self._resolve(request)
        try:
            left_revision = validate_revision(left)
            right_revision = validate_revision(right) if right else None
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        if mode != "working_tree" and not right_revision:
            raise GitApiError("git_validation_failed", "This comparison requires two revisions")
        if mode == "working_tree" and right_revision:
            raise GitApiError(
                "git_validation_failed",
                "Working tree comparison has no right revision",
            )

        left_object_id = await self._resolve_commit_object(
            registered,
            left_revision,
            cancel_event=cancel_event,
        )
        right_object_id = (
            await self._resolve_commit_object(registered, right_revision, cancel_event=cancel_event)
            if right_revision
            else None
        )
        comparison_base = left_object_id
        merge_base: str | None = None
        if mode == "three_dot":
            assert right_object_id is not None
            result = await self._run(
                registered,
                ["merge-base", left_object_id, right_object_id],
                cancel_event=cancel_event,
            )
            merge_base = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
            if not merge_base:
                raise GitApiError("git_failed", "Git revisions do not have a merge base")
            comparison_base = merge_base

        patch_args = ["diff", "--no-ext-diff", "--binary", "--find-renames", comparison_base]
        numstat_args = [
            "diff",
            "--no-ext-diff",
            "--find-renames",
            "--numstat",
            "-z",
            comparison_base,
        ]
        if right_object_id:
            patch_args.append(right_object_id)
            numstat_args.append(right_object_id)
        patch, numstat = await asyncio.gather(
            self._run(registered, patch_args, cancel_event=cancel_event),
            self._run(registered, numstat_args, cancel_event=cancel_event),
        )
        return GitCompareResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            mode=mode,
            left_label=left_revision,
            right_label=right_revision or "Working tree",
            left_object_id=left_object_id,
            right_object_id=right_object_id,
            comparison_base_object_id=comparison_base,
            merge_base_object_id=merge_base,
            files=apply_numstat(
                parse_git_diff(patch.stdout, truncated=patch.stdout_truncated),
                parse_numstat_z(numstat.stdout),
            ),
        )

    async def merge_preview(
        self,
        request: GitRepositoryRequest,
        source: str,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitMergePreviewResponse:
        registered = self._resolve(request)
        try:
            normalized_source = validate_revision(source)
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        head_object_id, source_object_id = await asyncio.gather(
            self._resolve_commit_object(registered, "HEAD", cancel_event=cancel_event),
            self._resolve_commit_object(
                registered,
                normalized_source,
                cancel_event=cancel_event,
            ),
        )
        merge_base, incoming, status = await asyncio.gather(
            self._run(
                registered,
                ["merge-base", head_object_id, source_object_id],
                cancel_event=cancel_event,
            ),
            self._run(
                registered,
                ["rev-list", "--count", f"{head_object_id}..{source_object_id}"],
                cancel_event=cancel_event,
            ),
            self._run(
                registered,
                ["status", "--porcelain=v1", "--untracked-files=normal"],
                cancel_event=cancel_event,
            ),
        )
        merge_base_object_id = merge_base.stdout.strip().splitlines()[0]
        return GitMergePreviewResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            source=normalized_source,
            head_object_id=head_object_id,
            source_object_id=source_object_id,
            merge_base_object_id=merge_base_object_id,
            incoming_commits=int(incoming.stdout.strip() or "0"),
            fast_forward=merge_base_object_id == head_object_id,
            already_merged=merge_base_object_id == source_object_id,
            dirty=bool(status.stdout.strip()),
        )

    async def rebase_preview(
        self,
        request: GitRepositoryRequest,
        upstream: str,
        *,
        onto: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitRebasePreviewResponse:
        registered = self._resolve(request)
        try:
            normalized_upstream = validate_revision(upstream)
            normalized_onto = validate_revision(onto) if onto else None
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        head_object_id, upstream_object_id = await asyncio.gather(
            self._resolve_commit_object(registered, "HEAD", cancel_event=cancel_event),
            self._resolve_commit_object(
                registered,
                normalized_upstream,
                cancel_event=cancel_event,
            ),
        )
        onto_object_id = (
            await self._resolve_commit_object(
                registered,
                normalized_onto,
                cancel_event=cancel_event,
            )
            if normalized_onto
            else None
        )
        log, status = await asyncio.gather(
            self._run(
                registered,
                [
                    "log",
                    "--reverse",
                    "--format=%H%x00%s%x00",
                    f"{upstream_object_id}..{head_object_id}",
                ],
                cancel_event=cancel_event,
            ),
            self._run(
                registered,
                ["status", "--porcelain=v1", "--untracked-files=normal"],
                cancel_event=cancel_event,
            ),
        )
        fields = log.stdout.split("\x00")
        while fields and not fields[-1].strip():
            fields.pop()
        commits = [
            GitRebasePreviewItem(object_id=fields[index].lstrip("\r\n"), subject=fields[index + 1])
            for index in range(0, len(fields), 2)
        ]
        return GitRebasePreviewResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            upstream=normalized_upstream,
            onto=normalized_onto,
            head_object_id=head_object_id,
            upstream_object_id=upstream_object_id,
            onto_object_id=onto_object_id,
            commits=commits,
            dirty=bool(status.stdout.strip()),
        )

    async def _resolve_commit_object(
        self,
        registered: _RegisteredRepository,
        revision: str,
        *,
        cancel_event: asyncio.Event | None,
    ) -> str:
        result = await self._runner.run(
            ("rev-parse", "--verify", "--quiet", f"{revision}^{{commit}}"),
            cwd=registered.response.root_path,
            cancel_event=cancel_event,
            timeout_seconds=60,
        )
        if result.cancelled:
            raise GitApiError("git_cancelled", "Git query was cancelled")
        if result.timed_out:
            raise GitApiError("git_timeout", "Git query timed out", retryable=True)
        if not result.succeeded or not result.stdout.strip():
            raise GitApiError(
                "git_repository_not_found",
                f"Git revision '{revision}' was not found",
                repository_id=registered.response.id,
            )
        return result.stdout.strip().splitlines()[0]

    async def identity(self, request: GitRepositoryRequest) -> GitIdentityResponse:
        registered = self._resolve(request)

        async def value(key: str) -> str | None:
            result = await self._runner.run(
                ("config", "--get", key),
                cwd=registered.response.root_path,
                timeout_seconds=20,
            )
            if result.timed_out:
                raise GitApiError("git_timeout", f"Reading Git config {key} timed out")
            return result.stdout.strip() or None if result.succeeded else None

        name, email, signing = await asyncio.gather(
            value("user.name"),
            value("user.email"),
            value("commit.gpgsign"),
        )
        return GitIdentityResponse(
            repository_id=registered.response.id,
            name=name,
            email=email,
            sign_by_default=(signing or "").casefold() in {"true", "yes", "on", "1"},
        )

    async def update_identity(self, request: GitIdentityUpdateRequest) -> GitIdentityResponse:
        registered = self._resolve(request)
        values = (
            ("user.name", request.name),
            ("user.email", request.email),
            ("commit.gpgsign", "true" if request.sign_by_default else "false"),
        )
        for key, value in values:
            result = await self._runner.run(
                ("config", "--local", key, value),
                cwd=registered.response.root_path,
                timeout_seconds=20,
            )
            if not result.succeeded:
                raise GitApiError(
                    "git_failed",
                    result.safe_stderr.strip() or f"Failed to update Git config {key}",
                    repository_id=registered.response.id,
                )
        self.invalidate(registered.response.id)
        return await self.identity(request)

    async def commit_detail(
        self,
        request: GitRepositoryRequest,
        revision: str,
        *,
        parent: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitCommitDetailResponse:
        registered = self._resolve(request)
        try:
            normalized_revision = validate_revision(revision)
            normalized_parent = validate_revision(parent) if parent else None
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        cache_key = (
            registered.response.id,
            normalized_revision.casefold(),
            normalized_parent.casefold() if normalized_parent else None,
        ) if (
            re.fullmatch(r"[0-9a-fA-F]{40,64}", normalized_revision)
            and (
                normalized_parent is None
                or re.fullmatch(r"[0-9a-fA-F]{40,64}", normalized_parent)
            )
        ) else None
        if cache_key is not None:
            cached_detail = self._commit_detail_cache.get(cache_key)
            if cached_detail is not None:
                self._commit_detail_cache.move_to_end(cache_key)
                return cached_detail
        result = await self._run(
            registered,
            ["show", "--no-patch", f"--format={LOG_FORMAT}", normalized_revision],
            cancel_event=cancel_event,
        )
        commits = parse_git_log(result.stdout)
        if len(commits) != 1:
            raise GitApiError("git_repository_not_found", "Git revision was not found")
        commit = commits[0]
        if normalized_parent and normalized_parent not in commit.parent_ids:
            raise GitApiError(
                "git_validation_failed",
                "Selected parent does not belong to the commit",
                details={"commit": commit.object_id, "parent": normalized_parent},
            )
        selected_parent = normalized_parent or (commit.parent_ids[0] if commit.parent_ids else None)
        if selected_parent:
            patch_args = [
                "diff",
                "--no-ext-diff",
                "--binary",
                "--find-renames",
                selected_parent,
                commit.object_id,
            ]
            numstat_args = [
                "diff",
                "--no-ext-diff",
                "--find-renames",
                "--numstat",
                "-z",
                selected_parent,
                commit.object_id,
            ]
        else:
            patch_args = [
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--binary",
                "--find-renames",
                "-p",
                commit.object_id,
            ]
            numstat_args = [
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--find-renames",
                "--numstat",
                "-z",
                commit.object_id,
            ]
        patch, numstat = await asyncio.gather(
            self._run(registered, patch_args, cancel_event=cancel_event),
            self._run(registered, numstat_args, cancel_event=cancel_event),
        )
        files = apply_numstat(
            parse_git_diff(patch.stdout, truncated=patch.stdout_truncated),
            parse_numstat_z(numstat.stdout),
        )
        detail = GitCommitDetailResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            commit=commit,
            selected_parent_id=selected_parent,
            files=files,
        )
        if cache_key is not None:
            self._commit_detail_cache[cache_key] = detail
            self._commit_detail_cache.move_to_end(cache_key)
            while len(self._commit_detail_cache) > 128:
                self._commit_detail_cache.popitem(last=False)
        return detail

    async def blame(
        self,
        request: GitRepositoryRequest,
        path: str,
        *,
        revision: str | None = None,
        start_line: int = 1,
        line_count: int = 200,
        ignore_revs_file: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitBlameResponse:
        if start_line < 1 or line_count < 1 or line_count > 1000:
            raise GitApiError(
                "git_validation_failed",
                "Blame line window must start at 1 or later and contain 1 to 1000 lines",
            )
        registered = self._resolve(request)
        try:
            normalized_path = validate_repo_relative_path(path)
            normalized_revision = validate_revision(revision) if revision else None
            normalized_ignore_file = (
                validate_repo_relative_path(ignore_revs_file) if ignore_revs_file else None
            )
            if normalized_ignore_file:
                resolve_repo_path(
                    resolve_repository_layout(registered.response.root_path),
                    normalized_ignore_file,
                    must_exist=True,
                )
        except (GitParameterError, OSError) as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        version = await self.version_async(registered.response)
        args = [
            "blame",
            "--line-porcelain",
            "--follow",
            "-L",
            f"{start_line},+{line_count + 1}",
        ]
        if normalized_ignore_file:
            args.append(f"--ignore-revs-file={normalized_ignore_file}")
        if normalized_revision:
            args.append(normalized_revision)
        args.extend(["--", normalized_path])
        result = await self._run(
            registered,
            args,
            cancel_event=cancel_event,
        )
        lines = parse_blame_porcelain(result.stdout)
        has_more = len(lines) > line_count
        return GitBlameResponse(
            repository_id=registered.response.id,
            repository_version=version,
            path=normalized_path,
            revision=normalized_revision,
            start_line=start_line,
            lines=lines[:line_count],
            next_start_line=start_line + line_count if has_more else None,
            ignore_revs_file=normalized_ignore_file,
        )

    async def reflog(
        self,
        request: GitRepositoryRequest,
        *,
        ref: str | None = None,
        cursor: str | None = None,
        limit: int = 100,
        cancel_event: asyncio.Event | None = None,
    ) -> GitReflogResponse:
        if limit < 1 or limit > 500:
            raise GitApiError("git_validation_failed", "Reflog limit must be between 1 and 500")
        registered = self._resolve(request)
        try:
            normalized_ref = validate_revision(ref) if ref else None
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        version = await self.version_async(registered.response, refresh=cursor is not None)
        offset = decode_cursor(cursor, registered.response.id, version) if cursor else 0
        args = [
            "reflog",
            "show",
            f"--max-count={limit + 1}",
            f"--skip={offset}",
            f"--format={REFLOG_FORMAT}",
        ]
        args.append(normalized_ref or "--all")
        result = await self._run(
            registered,
            args,
            cancel_event=cancel_event,
        )
        entries = parse_reflog(result.stdout)
        has_more = len(entries) > limit
        return GitReflogResponse(
            repository_id=registered.response.id,
            repository_version=version,
            ref=normalized_ref,
            entries=entries[:limit],
            next_cursor=encode_cursor(registered.response.id, version, offset + limit)
            if has_more
            else None,
        )

    async def stash_list(
        self,
        request: GitRepositoryRequest,
        *,
        cursor: str | None = None,
        limit: int = 50,
        cancel_event: asyncio.Event | None = None,
    ) -> GitStashPageResponse:
        if limit < 1 or limit > 200:
            raise GitApiError("git_validation_failed", "Stash limit must be between 1 and 200")
        registered = self._resolve(request)
        version = await self.version_async(registered.response, refresh=cursor is not None)
        offset = decode_cursor(cursor, registered.response.id, version) if cursor else 0
        result = await self._run(
            registered,
            [
                "stash",
                "list",
                f"--max-count={limit + 1}",
                f"--skip={offset}",
                f"--format={STASH_FORMAT}",
            ],
            cancel_event=cancel_event,
        )
        entries = parse_stash_list(result.stdout)
        has_more = len(entries) > limit
        return GitStashPageResponse(
            repository_id=registered.response.id,
            repository_version=version,
            entries=entries[:limit],
            next_cursor=(
                encode_cursor(registered.response.id, version, offset + limit) if has_more else None
            ),
        )

    async def stash_detail(
        self,
        request: GitRepositoryRequest,
        selector: str,
        object_id: str,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitStashDetailResponse:
        if (
            not selector.startswith("stash@{")
            or not selector.endswith("}")
            or not selector[7:-1].isdigit()
        ):
            raise GitApiError("git_validation_failed", "Invalid stash selector")
        registered = self._resolve(request)
        resolved = await self._run(
            registered,
            ["rev-parse", "--verify", selector],
            cancel_event=cancel_event,
        )
        resolved_oid = resolved.stdout.strip()
        if resolved_oid != validate_revision(object_id):
            raise GitApiError(
                "git_operation_conflict",
                "The stash selector changed; refresh the stash list before continuing",
            )
        listing = await self._run(
            registered,
            [
                "stash",
                "list",
                "--max-count=1",
                f"--skip={int(selector[7:-1])}",
                f"--format={STASH_FORMAT}",
            ],
            cancel_event=cancel_event,
        )
        entries = parse_stash_list(listing.stdout)
        if not entries or entries[0].object_id != resolved_oid:
            raise GitApiError("git_repository_not_found", "Stash entry was not found")
        patch, numstat = await asyncio.gather(
            self._run(
                registered,
                ["stash", "show", "--patch", "--binary", "--include-untracked", selector],
                cancel_event=cancel_event,
            ),
            self._run(
                registered,
                ["stash", "show", "--numstat", "-z", "--include-untracked", selector],
                cancel_event=cancel_event,
            ),
        )
        files = apply_numstat(
            parse_git_diff(patch.stdout, truncated=patch.stdout_truncated),
            parse_numstat_z(numstat.stdout),
        )
        return GitStashDetailResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            entry=entries[0],
            files=files,
        )

    async def reset_preview(
        self,
        request: GitRepositoryRequest,
        target: str,
        mode: str,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitResetPreviewResponse:
        if mode not in {"soft", "mixed", "hard"}:
            raise GitApiError("git_validation_failed", "Reset mode must be soft, mixed, or hard")
        registered = self._resolve(request)
        try:
            revision = validate_revision(target)
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        target_result = await self._run(
            registered,
            ["rev-parse", "--verify", f"{revision}^{{commit}}"],
            cancel_event=cancel_event,
        )
        target_object_id = target_result.stdout.strip()
        head_result = await self._runner.run(
            ("rev-parse", "--verify", "HEAD^{commit}"),
            cwd=registered.response.root_path,
            cancel_event=cancel_event,
            timeout_seconds=60,
        )
        head_object_id = head_result.stdout.strip() if head_result.succeeded else None
        file_args = (
            ["diff", "--name-only", "-z", "HEAD", target_object_id]
            if head_object_id
            else [
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                target_object_id,
            ]
        )
        changed, untracked, target_paths = await asyncio.gather(
            self._run(registered, file_args, cancel_event=cancel_event),
            self._run(
                registered,
                ["ls-files", "--others", "--exclude-standard", "-z"],
                cancel_event=cancel_event,
            ),
            self._run(
                registered,
                ["ls-tree", "-r", "--name-only", "-z", target_object_id],
                cancel_event=cancel_event,
            ),
        )
        changed_paths = _nul_paths(changed.stdout)
        untracked_paths = _nul_paths(untracked.stdout)
        tracked_at_target = set(_nul_paths(target_paths.stdout))
        overwrites = sorted(
            path
            for path in untracked_paths
            if path in tracked_at_target
            or any(path.startswith(f"{candidate}/") for candidate in tracked_at_target)
        )
        return GitResetPreviewResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            target=revision,
            target_object_id=target_object_id,
            head_object_id=head_object_id,
            mode=mode,
            files=[GitResetPreviewFile(path=path, change_type="changed") for path in changed_paths],
            untracked_overwrites=overwrites if mode == "hard" else [],
            reflog_recovery="Use HEAD@{1} or ORIG_HEAD to recover the previous branch tip.",
        )

    async def patch_export(
        self,
        request: GitRepositoryRequest,
        mode: str,
        *,
        left: str | None = None,
        right: str | None = None,
        paths: list[str] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> GitPatchExportResponse:
        if mode not in {"working_tree", "index", "commit", "range"}:
            raise GitApiError("git_validation_failed", "Unknown patch export mode")
        registered = self._resolve(request)
        try:
            normalized_paths = [validate_repo_relative_path(path) for path in (paths or [])]
            normalized_left = validate_revision(left) if left else None
            normalized_right = validate_revision(right) if right else None
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc
        if mode in {"commit", "range"} and normalized_left is None:
            raise GitApiError("git_validation_failed", "This patch export requires a left revision")
        if mode == "range" and normalized_right is None:
            raise GitApiError("git_validation_failed", "Range patch export requires two revisions")
        if mode == "working_tree":
            args = ["diff", "--binary", "--no-ext-diff"]
        elif mode == "index":
            args = ["diff", "--cached", "--binary", "--no-ext-diff"]
        elif mode == "commit":
            args = ["format-patch", "-1", "--stdout", "--binary", "--no-signature", normalized_left]
        else:
            args = ["diff", "--binary", "--no-ext-diff", normalized_left, normalized_right]
        if normalized_paths:
            args.extend(("--", *normalized_paths))
        result = await self._run(registered, args, cancel_event=cancel_event)
        if result.stdout_truncated:
            raise GitApiError(
                "git_output_too_large",
                "Patch export exceeded the safe output limit; narrow the selected range or paths",
            )
        return GitPatchExportResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            mode=mode,
            left=normalized_left,
            right=normalized_right,
            paths=normalized_paths,
            filename=_patch_filename(mode, normalized_left, normalized_right),
            patch=result.stdout,
        )

    async def conflicts(
        self,
        request: GitRepositoryRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitConflictsResponse:
        registered = self._resolve(request)
        unmerged = await self._run(
            registered,
            ["ls-files", "-u", "-z"],
            cancel_event=cancel_event,
        )
        entries = parse_unmerged_index(unmerged.stdout)
        grouped: dict[str, list] = {}
        for entry in entries:
            grouped.setdefault(entry.path, []).append(entry)
        isolated_stages = {
            values[0].stage: path for path, values in grouped.items() if len(values) == 1
        }
        rename_paths = (
            set(isolated_stages.values())
            if set(isolated_stages) == {1, 2, 3} and len(set(isolated_stages.values())) > 1
            else set()
        )
        layout = resolve_repository_layout(registered.response.root_path)
        files: list[GitConflictFileResponse] = []
        for path, path_entries in sorted(grouped.items()):
            normalized_path = validate_repo_relative_path(path)
            stages = [
                await self._conflict_stage(registered, entry, cancel_event=cancel_event)
                for entry in sorted(path_entries, key=lambda item: item.stage)
            ]
            (
                result_content,
                result_binary,
                result_encoding,
                result_eol,
                result_too_large,
                result_revision,
            ) = _read_conflict_result(layout, normalized_path)
            binary = result_binary or any(stage.binary for stage in stages)
            too_large = result_too_large or any(stage.too_large for stage in stages)
            submodule = any(stage.mode == "160000" for stage in stages)
            kind = classify_conflict(
                {stage.stage for stage in stages},
                binary=binary,
                submodule=submodule,
                rename=normalized_path in rename_paths,
            )
            files.append(
                GitConflictFileResponse(
                    path=normalized_path,
                    related_paths=sorted(rename_paths) if normalized_path in rename_paths else [],
                    kind=kind,
                    stages=stages,
                    result_content=result_content,
                    result_binary=result_binary,
                    result_encoding=result_encoding,
                    result_eol=result_eol,
                    result_too_large=result_too_large,
                    result_revision=result_revision,
                    allowed_actions=list(resolution_actions(kind)),
                    editable=not binary and not submodule and not too_large,
                )
            )
        return GitConflictsResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            max_editable_bytes=_MAX_EDITABLE_CONFLICT_BYTES,
            files=files,
        )

    async def save_conflict_result(
        self,
        request: GitConflictResultSaveRequest,
        *,
        cancel_event: asyncio.Event | None = None,
    ) -> GitConflictResultSaveResponse:
        registered = self._resolve(request)
        path = validate_repo_relative_path(request.path)
        layout = resolve_repository_layout(registered.response.root_path)
        target = resolve_repo_path(layout, path)
        current_payload = _read_bounded_file(target, _MAX_EDITABLE_CONFLICT_BYTES)
        current_revision = (
            hashlib.sha256(current_payload).hexdigest()
            if current_payload is not None
            else "missing"
        )
        if current_revision != request.expected_result_revision:
            raise GitApiError(
                "git_operation_conflict",
                "Conflict result changed after the editor was opened; reload before saving",
            )
        unmerged = await self._run(
            registered,
            ["ls-files", "-u", "-z", "--", path],
            cancel_event=cancel_event,
        )
        entries = parse_unmerged_index(unmerged.stdout)
        actual_stages = {entry.stage: entry for entry in entries if entry.path == path}
        expected_stages = {item.stage: item.object_id for item in request.expected_stages}
        if not actual_stages or {
            stage: entry.object_id for stage, entry in actual_stages.items()
        } != expected_stages:
            raise GitApiError(
                "git_operation_conflict",
                "Conflict stages changed after the editor was opened; reload before saving",
            )
        stage_details = [
            await self._conflict_stage(registered, entry, cancel_event=cancel_event)
            for entry in actual_stages.values()
        ]
        if any(
            stage.binary or stage.too_large or stage.mode == "160000" for stage in stage_details
        ):
            raise GitApiError(
                "git_validation_failed",
                "Binary, submodule, or oversized conflicts cannot be saved as text",
            )
        normalized = request.content.replace("\r\n", "\n").replace("\r", "\n")
        rendered = normalized.replace("\n", "\r\n") if request.eol == "crlf" else normalized
        payload = rendered.encode("utf-8")
        if request.encoding == "utf-8-bom":
            payload = b"\xef\xbb\xbf" + payload
        if len(payload) > _MAX_EDITABLE_CONFLICT_BYTES:
            raise GitApiError("git_validation_failed", "Conflict result exceeds the editable limit")
        _atomic_write_conflict_result(target, payload)
        return GitConflictResultSaveResponse(
            repository_id=registered.response.id,
            repository_version=await self.version_async(registered.response),
            path=path,
            result_revision=hashlib.sha256(payload).hexdigest(),
            bytes_written=len(payload),
            encoding=request.encoding,
            eol=request.eol,
        )

    async def _conflict_stage(
        self,
        registered: _RegisteredRepository,
        entry,
        *,
        cancel_event: asyncio.Event | None,
    ) -> GitConflictStageResponse:
        size_result = await self._run(
            registered,
            ["cat-file", "-s", entry.object_id],
            cancel_event=cancel_event,
        )
        try:
            size = int(size_result.stdout.strip())
        except ValueError as exc:
            raise GitApiError(
                "git_parse_failed", "Git returned an invalid conflict blob size"
            ) from exc
        too_large = size > _MAX_EDITABLE_CONFLICT_BYTES
        if too_large:
            content, binary, encoding, eol = None, False, "unsupported", "none"
        else:
            blob = await self._run(
                registered,
                ["cat-file", "blob", entry.object_id],
                cancel_event=cancel_event,
            )
            content, binary, encoding, eol = decode_conflict_content(blob.stdout_bytes)
        return GitConflictStageResponse(
            stage=entry.stage,
            label={1: "base", 2: "ours", 3: "theirs"}[entry.stage],
            object_id=entry.object_id,
            mode=entry.mode,
            size=size,
            content=content,
            binary=binary,
            encoding=encoding,
            eol=eol,
            too_large=too_large,
        )

    def invalidate(self, repository_id: str) -> None:
        self._cache = {key: value for key, value in self._cache.items() if key[0] != repository_id}
        self._repository_versions.pop(repository_id, None)

    def version(self, repository: GitRepositoryResponse, *, refresh: bool = False) -> str:
        if refresh:
            self._repository_versions.pop(repository.id, None)
        cached = self._repository_versions.get(repository.id)
        if cached is not None:
            return cached
        version = repository_version(repository)
        self._repository_versions[repository.id] = version
        return version

    async def version_async(
        self,
        repository: GitRepositoryResponse,
        *,
        refresh: bool = False,
    ) -> str:
        return await asyncio.to_thread(self.version, repository, refresh=refresh)

    def repository(self, request: GitRepositoryRequest) -> GitRepositoryResponse:
        return self._resolve(request).response

    def _resolve(self, request: GitRepositoryRequest) -> _RegisteredRepository:
        registered = self._repositories.get((request.workspace_id, request.repository_id))
        if registered is None:
            self.discover(
                GitDiscoveryRequest(
                    workspace_id=request.workspace_id,
                    project_root=request.project_root,
                )
            )
            registered = self._repositories.get((request.workspace_id, request.repository_id))
        if registered is None:
            raise GitApiError("git_repository_not_found", "Git repository is not registered")
        if registered.project_root != Path(request.project_root).expanduser().resolve():
            raise GitApiError("git_access_denied", "Repository is registered for another project")
        try:
            self._grants.require_access(
                workspace_id=request.workspace_id,
                project_root=registered.project_root,
                repo_id=registered.response.id,
                repo_root=registered.response.root_path,
            )
            layout = resolve_repository_layout(registered.response.root_path)
        except (GitAccessDenied, GitParameterError, OSError) as exc:
            raise GitApiError("git_access_denied", str(exc)) from exc
        if layout.git_dir != Path(registered.response.git_dir_path).resolve():
            raise GitApiError("git_access_denied", "Repository metadata changed after discovery")
        return registered

    async def _run(
        self,
        registered: _RegisteredRepository,
        args: list[str],
        *,
        cancel_event: asyncio.Event | None,
    ) -> GitCommandResult:
        result = await self._runner.run(
            args,
            cwd=registered.response.root_path,
            env=_READ_ONLY_GIT_ENV,
            cancel_event=cancel_event,
            timeout_seconds=60,
        )
        if result.cancelled:
            raise GitApiError("git_cancelled", "Git query was cancelled")
        if result.timed_out:
            raise GitApiError("git_timeout", "Git query timed out", retryable=True)
        if not result.succeeded:
            raise GitApiError(
                "git_failed",
                result.safe_stderr.strip() or "Git query failed",
                repository_id=registered.response.id,
            )
        return result

    def _cached(
        self,
        repository_id: str,
        version: str,
        domain: str,
        model: type[_ModelT],
    ) -> _ModelT | None:
        value = self._cache.get((repository_id, version, domain))
        return value if isinstance(value, model) else None

    def _store(self, repository_id: str, version: str, domain: str, value: _ModelT) -> _ModelT:
        self._cache[(repository_id, version, domain)] = value
        return value


def _nul_paths(value: str) -> list[str]:
    return [item for item in value.split("\0") if item]


def _patch_filename(mode: str, left: str | None, right: str | None) -> str:
    label = "-".join(item for item in (mode, left, right) if item)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-.")[:96] or "changes"
    return f"keydex-{safe}.patch"


def _read_conflict_result(
    layout, path: str
) -> tuple[str | None, bool, str, str, bool, str]:
    try:
        target = resolve_repo_path(layout, path, must_exist=True)
        if not target.is_file():
            return None, False, "unsupported", "none", False, "missing"
        with target.open("rb") as handle:
            payload = handle.read(_MAX_EDITABLE_CONFLICT_BYTES + 1)
    except (OSError, GitParameterError, GitAccessDenied):
        return None, False, "unsupported", "none", False, "missing"
    too_large = len(payload) > _MAX_EDITABLE_CONFLICT_BYTES
    content, binary, encoding, eol = decode_conflict_content(
        payload[:_MAX_EDITABLE_CONFLICT_BYTES]
    )
    revision = hashlib.sha256(payload).hexdigest()
    return content if not too_large else None, binary, encoding, eol, too_large, revision


def _read_bounded_file(path: Path, limit: int) -> bytes | None:
    try:
        if not path.is_file():
            return None
        with path.open("rb") as handle:
            payload = handle.read(limit + 1)
    except OSError as exc:
        raise GitApiError("git_failed", f"Unable to read conflict result: {exc}") from exc
    if len(payload) > limit:
        raise GitApiError("git_validation_failed", "Conflict result exceeds the editable limit")
    return payload


def _parse_bisect_refs(value: str) -> tuple[list[str], str | None, list[str]]:
    good: list[str] = []
    bad: str | None = None
    skipped: list[str] = []
    for line in value.splitlines():
        refname, separator, object_id = line.partition("\0")
        if not separator or not object_id:
            continue
        if refname == "refs/bisect/bad":
            bad = object_id
        elif refname.startswith("refs/bisect/good-"):
            good.append(object_id)
        elif refname.startswith(("refs/bisect/skip-", "refs/bisect/skipped-")):
            skipped.append(object_id)
    return sorted(set(good)), bad, sorted(set(skipped))


def _is_path_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _read_lfs_patterns(repository_root: Path) -> list[str]:
    attributes = repository_root / ".gitattributes"
    try:
        lines = attributes.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    patterns: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        fields = stripped.split()
        if len(fields) > 1 and "filter=lfs" in fields[1:] and fields[0] not in patterns:
            patterns.append(fields[0])
    return patterns


def _parse_submodule_config(value: str) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    pattern = re.compile(r"^submodule\.(.+)\.(path|url)$")
    for line in value.splitlines():
        key, separator, setting = line.partition(" ")
        match = pattern.match(key)
        if not separator or not match:
            continue
        name, field = match.groups()
        result.setdefault(name, {})[field] = setting
    return result


def _read_optional_line(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[0].strip() or None
    except (OSError, IndexError):
        return None


def _read_bisect_culprit(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = re.search(r"# first bad commit: \[([0-9a-fA-F]{4,64})\]", value)
    return match.group(1) if match else None


def _atomic_write_conflict_result(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_mode = path.stat().st_mode if path.exists() else None
    descriptor, temporary_name = tempfile.mkstemp(prefix=".keydex-merge-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        if previous_mode is not None:
            os.chmod(temporary, previous_mode)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def repository_version(repository: GitRepositoryResponse) -> str:
    git_dir = Path(repository.git_dir_path)
    digest = hashlib.sha256()
    for relative in ("HEAD", "index", "packed-refs", "MERGE_HEAD", "REBASE_HEAD"):
        path = git_dir / relative
        try:
            digest.update(f"{relative}\0".encode())
            digest.update(path.read_bytes())
        except OSError:
            digest.update(f"{relative}\0missing\0".encode())
    refs = git_dir / "refs"
    if refs.is_dir():
        for path in sorted(item for item in refs.rglob("*") if item.is_file()):
            try:
                digest.update(str(path.relative_to(git_dir)).encode())
                digest.update(b"\0")
                digest.update(path.read_bytes())
            except OSError:
                continue
    return digest.hexdigest()[:24]


def encode_cursor(repository_id: str, version: str, offset: int) -> str:
    payload = json.dumps(
        {"repository_id": repository_id, "version": version, "offset": offset},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def decode_cursor(cursor: str, repository_id: str, version: str) -> int:
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if payload["repository_id"] != repository_id or payload["version"] != version:
            raise ValueError
        offset = int(payload["offset"])
        if offset < 0:
            raise ValueError
        return offset
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise GitApiError("git_validation_failed", "Git cursor is invalid or stale") from exc
