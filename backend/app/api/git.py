from __future__ import annotations

import asyncio
from dataclasses import astuple
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend.app.git.access import GitAncestorGrantStore, GitWorktreeGrantStore
from backend.app.git.capabilities import probe_git_capabilities
from backend.app.git.command_service import GitCommandRegistry, GitCommandRisk, GitCommandService
from backend.app.git.confirmations import GitConfirmationService
from backend.app.git.default_commands import create_default_git_command_registry
from backend.app.git.history_query import GitHistoryQuery
from backend.app.git.models import (
    GitAncestorGrantRequest,
    GitAncestorGrantResponse,
    GitApiError,
    GitBisectControlCommandRequest,
    GitBisectSnapshotResponse,
    GitBisectStartCommandRequest,
    GitBlameResponse,
    GitBranchCommandRequest,
    GitBranchDeleteCommandRequest,
    GitBranchRenameCommandRequest,
    GitCapabilityResponse,
    GitCheckoutCommandRequest,
    GitCherryPickCommandRequest,
    GitCherryPickControlCommandRequest,
    GitCommandResponse,
    GitCommitCommandRequest,
    GitCommitDetailResponse,
    GitCompareResponse,
    GitConfirmationRequest,
    GitConfirmationResponse,
    GitConflictActionCommandRequest,
    GitConflictResultSaveRequest,
    GitConflictResultSaveResponse,
    GitConflictsResponse,
    GitDiffResponse,
    GitDiscoveryRequest,
    GitDiscoveryResponse,
    GitErrorResponse,
    GitFetchCommandRequest,
    GitHistoryPageResponse,
    GitIdentityResponse,
    GitIdentityUpdateRequest,
    GitLfsCommandRequest,
    GitLfsSnapshotResponse,
    GitMergeAbortCommandRequest,
    GitMergeCommandRequest,
    GitMergePreviewResponse,
    GitPatchCommandRequest,
    GitPatchExportResponse,
    GitPathsCommandRequest,
    GitPushCommandRequest,
    GitRebaseCommandRequest,
    GitRebaseControlCommandRequest,
    GitRebasePreviewResponse,
    GitReflogResponse,
    GitRefsResponse,
    GitRemoteAddCommandRequest,
    GitRemoteRemoveCommandRequest,
    GitRemoteRenameCommandRequest,
    GitRemoteSetUrlCommandRequest,
    GitRemotesResponse,
    GitRepositoryRequest,
    GitResetCommandRequest,
    GitResetPreviewResponse,
    GitRestoreCommandRequest,
    GitRevertCommandRequest,
    GitRevertControlCommandRequest,
    GitStashBranchCommandRequest,
    GitStashClearCommandRequest,
    GitStashDetailResponse,
    GitStashEntryCommandRequest,
    GitStashPageResponse,
    GitStashPushCommandRequest,
    GitStatusResponse,
    GitSubmoduleCommandRequest,
    GitSubmodulesSnapshotResponse,
    GitTagCreateCommandRequest,
    GitTagDeleteCommandRequest,
    GitUpdateCommandRequest,
    GitUpstreamCommandRequest,
    GitWorktreeCommandRequest,
    GitWorktreeGrantRequest,
    GitWorktreeGrantResponse,
    GitWorktreesSnapshotResponse,
)
from backend.app.git.query_service import GitQueryService, repository_version
from backend.app.git.runner import GitCliRunner

router = APIRouter(prefix="/api/git", tags=["git"])


def get_git_query_service(request: Request) -> GitQueryService:
    service = getattr(request.app.state, "git_query_service", None)
    if isinstance(service, GitQueryService):
        return service
    settings = request.app.state.settings
    service = GitQueryService(
        grants=GitAncestorGrantStore(Path(settings.data_dir) / "git" / "ancestor-grants.json"),
        worktree_grants=GitWorktreeGrantStore(
            Path(settings.data_dir) / "git" / "worktree-grants.json"
        ),
    )
    request.app.state.git_query_service = service
    return service


GitQueries = Annotated[GitQueryService, Depends(get_git_query_service)]


def get_git_command_registry(request: Request) -> GitCommandRegistry:
    registry = getattr(request.app.state, "git_command_registry", None)
    if isinstance(registry, GitCommandRegistry):
        return registry
    registry = create_default_git_command_registry()
    request.app.state.git_command_registry = registry
    return registry


def get_git_confirmation_service(request: Request) -> GitConfirmationService:
    service = getattr(request.app.state, "git_confirmation_service", None)
    if isinstance(service, GitConfirmationService):
        return service
    service = GitConfirmationService()
    request.app.state.git_confirmation_service = service
    return service


def get_git_command_service(request: Request) -> GitCommandService:
    service = getattr(request.app.state, "git_command_service", None)
    if isinstance(service, GitCommandService):
        return service
    confirmations = get_git_confirmation_service(request)
    service = GitCommandService(
        query_service=get_git_query_service(request),
        registry=get_git_command_registry(request),
        confirmation_validator=confirmations.validate,
    )
    request.app.state.git_command_service = service
    return service


GitCommands = Annotated[GitCommandService, Depends(get_git_command_service)]
GitConfirmations = Annotated[GitConfirmationService, Depends(get_git_confirmation_service)]
GitRegistry = Annotated[GitCommandRegistry, Depends(get_git_command_registry)]


def _error_responses() -> dict[int | str, dict[str, object]]:
    return {
        403: {"model": GitErrorResponse},
        404: {"model": GitErrorResponse},
        422: {"model": GitErrorResponse},
        503: {"model": GitErrorResponse},
    }


def _repository_request(
    workspace_id: str,
    project_root: str,
    repository_id: str = "placeholder",
) -> GitRepositoryRequest:
    return GitRepositoryRequest(
        workspace_id=workspace_id,
        project_root=project_root,
        repository_id=repository_id,
    )


GitRepositoryRequestDep = Annotated[GitRepositoryRequest, Depends(_repository_request)]


@router.get("/capabilities", response_model=GitCapabilityResponse)
async def git_capabilities() -> GitCapabilityResponse:
    return probe_git_capabilities()


@router.post(
    "/repositories/discover",
    response_model=GitDiscoveryResponse,
    responses=_error_responses(),
)
async def discover_repositories(
    payload: GitDiscoveryRequest,
    service: GitQueries,
) -> GitDiscoveryResponse:
    # Discovery may recursively inspect thousands of directories and probes
    # the local Git installation.  Keep that blocking filesystem/process work
    # off the ASGI event loop so the rest of the backend remains responsive.
    return await asyncio.to_thread(_call, service.discover, payload)


@router.post("/repositories/init", response_model=GitDiscoveryResponse)
async def initialize_repository(
    payload: GitDiscoveryRequest,
    service: GitQueries,
) -> GitDiscoveryResponse:
    project_root = Path(payload.project_root).expanduser().resolve()
    if not project_root.is_dir():
        raise HTTPException(status_code=422, detail="Project root does not exist")
    result = await GitCliRunner().run(("init",), cwd=project_root)
    if not result.succeeded:
        raise HTTPException(status_code=422, detail=result.safe_stderr or "Git init failed")
    return await asyncio.to_thread(_call, service.discover, payload)


@router.post("/repositories/ancestor-grants", response_model=GitAncestorGrantResponse)
async def authorize_ancestor_repository(
    payload: GitAncestorGrantRequest,
    service: GitQueries,
) -> GitAncestorGrantResponse:
    return _call(service.authorize_ancestor, payload)


@router.delete("/repositories/ancestor-grants")
async def revoke_ancestor_repository(
    workspace_id: Annotated[str, Query(min_length=1)],
    project_root: Annotated[str, Query(min_length=1)],
    service: GitQueries,
) -> dict[str, bool]:
    return {
        "revoked": service.revoke_ancestor(
            workspace_id=workspace_id,
            project_root=project_root,
        )
    }


@router.post(
    "/repositories/worktree-grants",
    response_model=GitWorktreeGrantResponse,
)
async def authorize_worktree(
    payload: GitWorktreeGrantRequest,
    service: GitQueries,
) -> GitWorktreeGrantResponse:
    return _call(service.authorize_worktree, payload)


@router.post("/repositories/worktree-grants/revoke")
async def revoke_worktree(
    payload: GitWorktreeGrantRequest,
    service: GitQueries,
) -> dict[str, bool]:
    return {"revoked": _call(service.revoke_worktree, payload)}


@router.get("/repositories/{repository_id}/status", response_model=GitStatusResponse)
async def repository_status(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitStatusResponse:
    request.repository_id = repository_id
    return await _await(
        service.coalesced_query,
        request,
        "status",
        lambda: service.status(request),
    )


@router.get(
    "/repositories/{repository_id}/bisect",
    response_model=GitBisectSnapshotResponse,
)
async def repository_bisect(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitBisectSnapshotResponse:
    request.repository_id = repository_id
    return await _await(service.bisect, request)


@router.get(
    "/repositories/{repository_id}/submodules",
    response_model=GitSubmodulesSnapshotResponse,
)
async def repository_submodules(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitSubmodulesSnapshotResponse:
    request.repository_id = repository_id
    return await _await(service.submodules, request)


@router.get(
    "/repositories/{repository_id}/worktrees",
    response_model=GitWorktreesSnapshotResponse,
)
async def repository_worktrees(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitWorktreesSnapshotResponse:
    request.repository_id = repository_id
    return await _await(service.worktrees, request)


@router.get(
    "/repositories/{repository_id}/lfs",
    response_model=GitLfsSnapshotResponse,
)
async def repository_lfs(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitLfsSnapshotResponse:
    request.repository_id = repository_id
    return await _await(service.lfs, request)


@router.get("/repositories/{repository_id}/refs", response_model=GitRefsResponse)
async def repository_refs(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitRefsResponse:
    request.repository_id = repository_id
    return await _await(
        service.coalesced_query,
        request,
        "refs",
        lambda: service.refs(request),
    )


@router.get("/repositories/{repository_id}/remotes", response_model=GitRemotesResponse)
async def repository_remotes(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitRemotesResponse:
    request.repository_id = repository_id
    return await _await(service.remotes, request)


@router.get("/repositories/{repository_id}/history", response_model=GitHistoryPageResponse)
async def repository_history(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    cursor: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    query: str | None = Query(default=None, max_length=512),
    hash_prefix: str | None = Query(default=None, min_length=4, max_length=64),
    revision: str | None = Query(default=None, max_length=255),
    author: str | None = Query(default=None, max_length=256),
    since: str | None = Query(default=None, max_length=64),
    until: str | None = Query(default=None, max_length=64),
    path: str | None = Query(default=None, max_length=4096),
    first_parent: bool = False,
    merges_only: bool = False,
) -> GitHistoryPageResponse:
    request.repository_id = repository_id
    history_query = GitHistoryQuery(
        text=query,
        hash_prefix=hash_prefix,
        revision=revision,
        author=author,
        since=since,
        until=until,
        path=path,
        first_parent=first_parent,
        merges_only=merges_only,
    )
    return await _await(
        service.coalesced_query,
        request,
        "history",
        lambda: service.history(
            request,
            cursor=cursor,
            limit=limit,
            query=history_query,
        ),
        variant=(cursor, limit, *astuple(history_query)),
    )


@router.get(
    "/repositories/{repository_id}/commits/{revision}",
    response_model=GitCommitDetailResponse,
)
async def repository_commit(
    repository_id: str,
    revision: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    parent: str | None = Query(default=None, max_length=64),
) -> GitCommitDetailResponse:
    request.repository_id = repository_id
    return await _await(service.commit_detail, request, revision, parent=parent)


@router.get("/repositories/{repository_id}/diff", response_model=GitDiffResponse)
async def repository_diff(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    cached: bool = False,
) -> GitDiffResponse:
    request.repository_id = repository_id
    return await _await(
        service.coalesced_query,
        request,
        "diff",
        lambda: service.diff(request, cached=cached),
        variant=(cached,),
    )


@router.get("/repositories/{repository_id}/compare", response_model=GitCompareResponse)
async def repository_compare(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    mode: str = Query(pattern=r"^(commit|two_dot|three_dot|working_tree)$"),
    left: str = Query(min_length=1, max_length=255),
    right: str | None = Query(default=None, max_length=255),
) -> GitCompareResponse:
    request.repository_id = repository_id
    return await _await(service.compare, request, mode=mode, left=left, right=right)


@router.get("/repositories/{repository_id}/merge-preview", response_model=GitMergePreviewResponse)
async def repository_merge_preview(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    source: str = Query(min_length=1, max_length=1024),
) -> GitMergePreviewResponse:
    request.repository_id = repository_id
    return await _await(service.merge_preview, request, source)


@router.get("/repositories/{repository_id}/rebase-preview", response_model=GitRebasePreviewResponse)
async def repository_rebase_preview(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    upstream: str = Query(min_length=1, max_length=1024),
    onto: str | None = Query(default=None, max_length=1024),
) -> GitRebasePreviewResponse:
    request.repository_id = repository_id
    return await _await(service.rebase_preview, request, upstream, onto=onto)


@router.get("/repositories/{repository_id}/reset-preview", response_model=GitResetPreviewResponse)
async def repository_reset_preview(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    target: str = Query(min_length=1, max_length=1024),
    mode: str = Query(pattern=r"^(soft|mixed|hard)$"),
) -> GitResetPreviewResponse:
    request.repository_id = repository_id
    return await _await(service.reset_preview, request, target, mode)


@router.get("/repositories/{repository_id}/patch-export", response_model=GitPatchExportResponse)
async def repository_patch_export(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    mode: str = Query(pattern=r"^(working_tree|index|commit|range)$"),
    left: str | None = Query(default=None, max_length=1024),
    right: str | None = Query(default=None, max_length=1024),
    paths: Annotated[list[str] | None, Query()] = None,
) -> GitPatchExportResponse:
    request.repository_id = repository_id
    return await _await(
        service.patch_export,
        request,
        mode,
        left=left,
        right=right,
        paths=paths or [],
    )


@router.get("/repositories/{repository_id}/conflicts", response_model=GitConflictsResponse)
async def repository_conflicts(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitConflictsResponse:
    request.repository_id = repository_id
    return await _await(service.conflicts, request)


@router.post(
    "/repositories/{repository_id}/conflicts/result",
    response_model=GitConflictResultSaveResponse,
    responses=_error_responses(),
)
async def save_conflict_result(
    repository_id: str,
    payload: GitConflictResultSaveRequest,
    service: GitQueries,
) -> GitConflictResultSaveResponse:
    payload.repository_id = repository_id
    return await _await(service.save_conflict_result, payload)


@router.post(
    "/repositories/{repository_id}/conflicts/action",
    response_model=GitCommandResponse,
    responses=_error_responses(),
)
async def apply_conflict_action(
    repository_id: str,
    payload: GitConflictActionCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "conflict_action", repository_id, payload)


@router.get("/repositories/{repository_id}/identity", response_model=GitIdentityResponse)
async def repository_identity(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitIdentityResponse:
    request.repository_id = repository_id
    return await _await(service.identity, request)


@router.put("/repositories/{repository_id}/identity", response_model=GitIdentityResponse)
async def update_repository_identity(
    repository_id: str,
    payload: GitIdentityUpdateRequest,
    service: GitQueries,
) -> GitIdentityResponse:
    if payload.repository_id != repository_id:
        raise HTTPException(status_code=422, detail="Repository id does not match route")
    return await _await(service.update_identity, payload)


@router.get("/repositories/{repository_id}/blame", response_model=GitBlameResponse)
async def repository_blame(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    path: str = Query(min_length=1, max_length=4096),
    revision: str | None = Query(default=None, max_length=255),
    start_line: int = Query(default=1, ge=1),
    line_count: int = Query(default=200, ge=1, le=1000),
    ignore_revs_file: str | None = Query(default=None, max_length=4096),
) -> GitBlameResponse:
    request.repository_id = repository_id
    return await _await(
        service.blame,
        request,
        path,
        revision=revision,
        start_line=start_line,
        line_count=line_count,
        ignore_revs_file=ignore_revs_file,
    )


@router.get("/repositories/{repository_id}/reflog", response_model=GitReflogResponse)
async def repository_reflog(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    ref: str | None = Query(default=None, max_length=255),
    cursor: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
) -> GitReflogResponse:
    request.repository_id = repository_id
    return await _await(service.reflog, request, ref=ref, cursor=cursor, limit=limit)


@router.get("/repositories/{repository_id}/stash", response_model=GitStashPageResponse)
async def repository_stash_list(
    repository_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> GitStashPageResponse:
    request.repository_id = repository_id
    return await _await(service.stash_list, request, cursor=cursor, limit=limit)


@router.get("/repositories/{repository_id}/stash-detail", response_model=GitStashDetailResponse)
async def repository_stash_detail(
    repository_id: str,
    selector: str,
    object_id: str,
    service: GitQueries,
    request: GitRepositoryRequestDep,
) -> GitStashDetailResponse:
    request.repository_id = repository_id
    return await _await(service.stash_detail, request, selector, object_id)


@router.post("/confirmations", response_model=GitConfirmationResponse)
async def create_git_confirmation(
    payload: GitConfirmationRequest,
    confirmations: GitConfirmations,
    registry: GitRegistry,
) -> GitConfirmationResponse:
    definition = _call(registry.get, payload.command)
    request = _call(definition.request_model.model_validate, payload.payload)
    risk = definition.risk_for(request)
    if risk not in {
        GitCommandRisk.DESTRUCTIVE,
        GitCommandRisk.HISTORY_REWRITE,
        GitCommandRisk.REMOTE_DESTRUCTIVE,
    }:
        raise HTTPException(status_code=422, detail="Git command does not require confirmation")
    return confirmations.issue(payload.command, request, risk=risk.value)


@router.post("/repositories/{repository_id}/stage", response_model=GitCommandResponse)
async def stage_paths(
    repository_id: str,
    payload: GitPathsCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stage", repository_id, payload)


@router.post("/repositories/{repository_id}/unstage", response_model=GitCommandResponse)
async def unstage_paths(
    repository_id: str,
    payload: GitPathsCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "unstage", repository_id, payload)


@router.post("/repositories/{repository_id}/patch", response_model=GitCommandResponse)
async def apply_patch(
    repository_id: str,
    payload: GitPatchCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "apply_patch", repository_id, payload)


@router.post("/repositories/{repository_id}/discard", response_model=GitCommandResponse)
async def discard_paths(
    repository_id: str,
    payload: GitPathsCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "discard", repository_id, payload)


@router.post("/repositories/{repository_id}/clean", response_model=GitCommandResponse)
async def clean_untracked_paths(
    repository_id: str,
    payload: GitPathsCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "clean", repository_id, payload)


@router.post("/repositories/{repository_id}/ignore", response_model=GitCommandResponse)
async def ignore_paths(
    repository_id: str,
    payload: GitPathsCommandRequest,
    service: GitQueries,
) -> GitCommandResponse:
    if payload.repository_id != repository_id:
        raise HTTPException(status_code=422, detail="Repository id does not match route")
    repository = _call(service.repository, payload)
    ignore_file = Path(repository.root_path) / ".gitignore"
    if ignore_file.is_symlink():
        raise HTTPException(status_code=409, detail="Refusing to write a symlinked .gitignore")
    existing = ignore_file.read_text(encoding="utf-8") if ignore_file.exists() else ""
    existing_lines = set(existing.splitlines())
    additions = [f"/{path}" for path in payload.paths if f"/{path}" not in existing_lines]
    if additions:
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        with ignore_file.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(prefix + "\n".join(additions) + "\n")
    service.invalidate(repository_id)
    return GitCommandResponse(
        operation_id=f"ignore-{uuid4().hex}",
        repository_id=repository_id,
        repository_version=repository_version(repository),
        state="succeeded",
        summary=f"Ignored {len(additions)} path(s)",
        result={"refresh_domains": ["status", "diff"], "ignored": additions},
    )


@router.post("/repositories/{repository_id}/commit", response_model=GitCommandResponse)
async def commit_changes(
    repository_id: str,
    payload: GitCommitCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "commit", repository_id, payload)


@router.post("/repositories/{repository_id}/branches", response_model=GitCommandResponse)
async def create_branch(
    repository_id: str,
    payload: GitBranchCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "create_branch", repository_id, payload)


@router.post("/repositories/{repository_id}/branches/rename", response_model=GitCommandResponse)
async def rename_branch(
    repository_id: str,
    payload: GitBranchRenameCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "rename_branch", repository_id, payload)


@router.post("/repositories/{repository_id}/branches/delete", response_model=GitCommandResponse)
async def delete_branch(
    repository_id: str,
    payload: GitBranchDeleteCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "delete_branch", repository_id, payload)


@router.post("/repositories/{repository_id}/tags", response_model=GitCommandResponse)
async def create_tag(
    repository_id: str,
    payload: GitTagCreateCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "create_tag", repository_id, payload)


@router.post("/repositories/{repository_id}/tags/delete", response_model=GitCommandResponse)
async def delete_tag(
    repository_id: str,
    payload: GitTagDeleteCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "delete_tag", repository_id, payload)


@router.post("/repositories/{repository_id}/remotes", response_model=GitCommandResponse)
async def add_remote(
    repository_id: str,
    payload: GitRemoteAddCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "add_remote", repository_id, payload)


@router.post("/repositories/{repository_id}/remotes/rename", response_model=GitCommandResponse)
async def rename_remote(
    repository_id: str,
    payload: GitRemoteRenameCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "rename_remote", repository_id, payload)


@router.post("/repositories/{repository_id}/remotes/url", response_model=GitCommandResponse)
async def set_remote_url(
    repository_id: str,
    payload: GitRemoteSetUrlCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "set_remote_url", repository_id, payload)


@router.post("/repositories/{repository_id}/remotes/remove", response_model=GitCommandResponse)
async def remove_remote(
    repository_id: str,
    payload: GitRemoteRemoveCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "remove_remote", repository_id, payload)


@router.post("/repositories/{repository_id}/upstream", response_model=GitCommandResponse)
async def set_upstream(
    repository_id: str,
    payload: GitUpstreamCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "set_upstream", repository_id, payload)


@router.post("/repositories/{repository_id}/checkout", response_model=GitCommandResponse)
async def checkout_ref(
    repository_id: str,
    payload: GitCheckoutCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "checkout", repository_id, payload)


@router.post("/repositories/{repository_id}/fetch", response_model=GitCommandResponse)
async def fetch_remote(
    repository_id: str,
    payload: GitFetchCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "fetch", repository_id, payload)


@router.post("/repositories/{repository_id}/push", response_model=GitCommandResponse)
async def push_remote(
    repository_id: str,
    payload: GitPushCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "push", repository_id, payload)


@router.post("/repositories/{repository_id}/stash", response_model=GitCommandResponse)
async def create_stash(
    repository_id: str,
    payload: GitStashPushCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stash_push", repository_id, payload)


@router.post("/repositories/{repository_id}/stash/apply", response_model=GitCommandResponse)
async def apply_stash(
    repository_id: str,
    payload: GitStashEntryCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stash_apply", repository_id, payload)


@router.post("/repositories/{repository_id}/stash/pop", response_model=GitCommandResponse)
async def pop_stash(
    repository_id: str,
    payload: GitStashEntryCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stash_pop", repository_id, payload)


@router.post("/repositories/{repository_id}/stash/branch", response_model=GitCommandResponse)
async def branch_from_stash(
    repository_id: str,
    payload: GitStashBranchCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stash_branch", repository_id, payload)


@router.post("/repositories/{repository_id}/stash/drop", response_model=GitCommandResponse)
async def drop_stash(
    repository_id: str,
    payload: GitStashEntryCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stash_drop", repository_id, payload)


@router.post("/repositories/{repository_id}/stash/clear", response_model=GitCommandResponse)
async def clear_stashes(
    repository_id: str,
    payload: GitStashClearCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "stash_clear", repository_id, payload)


@router.post("/repositories/{repository_id}/update", response_model=GitCommandResponse)
async def update_from_remote(
    repository_id: str,
    payload: GitUpdateCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "update", repository_id, payload)


@router.post("/repositories/{repository_id}/merge", response_model=GitCommandResponse)
async def merge_revision(
    repository_id: str,
    payload: GitMergeCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "merge", repository_id, payload)


@router.post("/repositories/{repository_id}/merge/abort", response_model=GitCommandResponse)
async def abort_merge(
    repository_id: str,
    payload: GitMergeAbortCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "merge_abort", repository_id, payload)


@router.post("/repositories/{repository_id}/rebase", response_model=GitCommandResponse)
async def rebase_revision(
    repository_id: str,
    payload: GitRebaseCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "rebase", repository_id, payload)


@router.post("/repositories/{repository_id}/rebase/control", response_model=GitCommandResponse)
async def control_rebase(
    repository_id: str,
    payload: GitRebaseControlCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "rebase_control", repository_id, payload)


@router.post("/repositories/{repository_id}/cherry-pick", response_model=GitCommandResponse)
async def cherry_pick_commits(
    repository_id: str,
    payload: GitCherryPickCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "cherry_pick", repository_id, payload)


@router.post(
    "/repositories/{repository_id}/cherry-pick/control",
    response_model=GitCommandResponse,
)
async def control_cherry_pick(
    repository_id: str,
    payload: GitCherryPickControlCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "cherry_pick_control", repository_id, payload)


@router.post("/repositories/{repository_id}/revert", response_model=GitCommandResponse)
async def revert_commits(
    repository_id: str,
    payload: GitRevertCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "revert", repository_id, payload)


@router.post("/repositories/{repository_id}/revert/control", response_model=GitCommandResponse)
async def control_revert(
    repository_id: str,
    payload: GitRevertControlCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "revert_control", repository_id, payload)


@router.post("/repositories/{repository_id}/reset", response_model=GitCommandResponse)
async def reset_revision(
    repository_id: str,
    payload: GitResetCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "reset", repository_id, payload)


@router.post("/repositories/{repository_id}/restore", response_model=GitCommandResponse)
async def restore_paths(
    repository_id: str,
    payload: GitRestoreCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "restore", repository_id, payload)


@router.post("/repositories/{repository_id}/bisect/start", response_model=GitCommandResponse)
async def start_bisect(
    repository_id: str,
    payload: GitBisectStartCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "bisect_start", repository_id, payload)


@router.post("/repositories/{repository_id}/bisect/control", response_model=GitCommandResponse)
async def control_bisect(
    repository_id: str,
    payload: GitBisectControlCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "bisect_control", repository_id, payload)


@router.post(
    "/repositories/{repository_id}/submodules/action",
    response_model=GitCommandResponse,
)
async def apply_submodule_action(
    repository_id: str,
    payload: GitSubmoduleCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "submodule_action", repository_id, payload)


@router.post(
    "/repositories/{repository_id}/worktrees/action",
    response_model=GitCommandResponse,
)
async def apply_worktree_action(
    repository_id: str,
    payload: GitWorktreeCommandRequest,
    queries: GitQueries,
    commands: GitCommands,
) -> GitCommandResponse:
    payload.repository_id = repository_id
    await _await(queries.validate_worktree_command, payload)
    return _submit(commands, "worktree_action", repository_id, payload)


@router.post(
    "/repositories/{repository_id}/lfs/action",
    response_model=GitCommandResponse,
)
async def apply_lfs_action(
    repository_id: str,
    payload: GitLfsCommandRequest,
    service: GitCommands,
) -> GitCommandResponse:
    return _submit(service, "lfs_action", repository_id, payload)


@router.get("/operations/{operation_id}", response_model=GitCommandResponse)
async def git_operation(operation_id: str, service: GitCommands) -> GitCommandResponse:
    return _call(service.operation, operation_id)


@router.delete("/operations/{operation_id}", response_model=GitCommandResponse)
async def cancel_git_operation(operation_id: str, service: GitCommands) -> GitCommandResponse:
    _call(service.cancel, operation_id)
    return _call(service.operation, operation_id)


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except GitApiError as exc:
        raise _http_error(exc) from exc
    except (ValueError, PermissionError, OSError) as exc:
        raise HTTPException(
            status_code=422,
            detail=GitErrorResponse(
                code="git_validation_failed",
                message=str(exc),
            ).model_dump(),
        ) from exc


def _submit(
    service: GitCommandService,
    command: str,
    repository_id: str,
    payload,
) -> GitCommandResponse:
    payload.repository_id = repository_id
    handle = _call(service.submit, command, payload)
    return _call(service.operation, handle.operation_id)


async def _await(function, *args, **kwargs):
    try:
        return await function(*args, **kwargs)
    except GitApiError as exc:
        raise _http_error(exc) from exc
    except (ValueError, PermissionError, OSError) as exc:
        raise HTTPException(
            status_code=422,
            detail=GitErrorResponse(
                code="git_validation_failed",
                message=str(exc),
            ).model_dump(),
        ) from exc


def _http_error(error: GitApiError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.payload.model_dump())
