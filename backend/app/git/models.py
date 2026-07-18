from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .error_contract import GIT_ERROR_CONTRACT, git_error_http_status


class GitModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GitRepositoryKind(StrEnum):
    WORKSPACE = "workspace"
    NESTED = "nested"
    ANCESTOR = "ancestor"
    WORKTREE = "worktree"
    SUBMODULE = "submodule"


class GitAncestorAuthorization(StrEnum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending"
    GRANTED = "granted"
    DENIED = "denied"


class GitFileStatusCode(StrEnum):
    ADDED = "added"
    MODIFIED = "modified"
    DELETED = "deleted"
    RENAMED = "renamed"
    COPIED = "copied"
    UNTRACKED = "untracked"
    CONFLICTED = "conflicted"
    TYPE_CHANGED = "type_changed"


class GitCapabilityResponse(GitModel):
    available: bool
    executable: str | None = None
    version: str | None = None
    supports_switch: bool = False
    supports_restore: bool = False
    supports_pathspec_from_file: bool = False
    lfs_available: bool = False
    reason: str | None = None


class GitRepositoryResponse(GitModel):
    id: str = Field(min_length=1)
    workspace_id: str = Field(min_length=1)
    root_path: str = Field(min_length=1)
    display_path: str = Field(min_length=1)
    git_dir_path: str = Field(min_length=1)
    kind: GitRepositoryKind
    parent_repo_id: str | None = None
    bare: bool = False
    ancestor_authorization: GitAncestorAuthorization = GitAncestorAuthorization.NOT_REQUIRED


class GitDiscoveryRequest(GitModel):
    workspace_id: str = Field(min_length=1)
    project_root: str = Field(min_length=1)
    include_nested: bool = True
    max_depth: int = Field(default=8, ge=0, le=32)
    max_directories: int = Field(default=10_000, ge=1, le=100_000)


class GitDiscoveryResponse(GitModel):
    capability: GitCapabilityResponse
    repositories: list[GitRepositoryResponse] = Field(default_factory=list)
    ancestor_candidate: GitRepositoryResponse | None = None


class GitAncestorGrantRequest(GitModel):
    workspace_id: str = Field(min_length=1)
    project_root: str = Field(min_length=1)
    repository_id: str = Field(min_length=1)
    repository_root: str = Field(min_length=1)


class GitAncestorGrantResponse(GitModel):
    workspace_id: str
    project_root: str
    repository_id: str
    repository_root: str
    scope: Literal["git_only"] = "git_only"


class GitWorktreeGrantResponse(GitModel):
    workspace_id: str = Field(min_length=1)
    project_root: str = Field(min_length=1)
    parent_repository_id: str = Field(min_length=1)
    worktree_path: str = Field(min_length=1)
    scope: Literal["git_worktree"] = "git_worktree"


class GitRepositoryRequest(GitModel):
    workspace_id: str = Field(min_length=1)
    project_root: str = Field(min_length=1)
    repository_id: str = Field(min_length=1)


class GitWorktreePathsRequest(GitRepositoryRequest):
    paths: list[str] = Field(min_length=1, max_length=1000)

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, value: list[str]) -> list[str]:
        from .security import validate_repo_relative_path

        return list(dict.fromkeys(validate_repo_relative_path(path) for path in value))


class GitWorktreePathsResponse(GitModel):
    repository_id: str = Field(min_length=1)
    paths: list[str] = Field(default_factory=list)


class GitWorktreeGrantRequest(GitRepositoryRequest):
    worktree_path: str = Field(min_length=1, max_length=4096)


class GitBranchResponse(GitModel):
    head: str | None = None
    detached_at: str | None = None
    upstream: str | None = None
    ahead: int = Field(default=0, ge=0)
    behind: int = Field(default=0, ge=0)
    unborn: bool = False


class GitChangedFileResponse(GitModel):
    path: str = Field(min_length=1)
    original_path: str | None = None
    index_status: GitFileStatusCode | None = None
    worktree_status: GitFileStatusCode | None = None
    conflicted: bool = False
    binary: bool | None = None
    submodule: bool = False

    @field_validator("path", "original_path")
    @classmethod
    def validate_repo_relative_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.replace("\\", "/")
        if normalized.startswith("/") or "\x00" in normalized:
            raise ValueError("Git paths must be repository-relative and NUL-free")
        return normalized


class GitInProgressOperationResponse(GitModel):
    kind: Literal["merge", "rebase", "cherry_pick", "revert", "bisect", "stash_apply"]
    state: Literal["running", "conflicted", "continuable"]
    current_step: int | None = Field(default=None, ge=1)
    total_steps: int | None = Field(default=None, ge=1)
    current_object_id: str | None = None


class GitConflictStageResponse(GitModel):
    stage: Literal[1, 2, 3]
    label: Literal["base", "ours", "theirs"]
    object_id: str = Field(min_length=4)
    mode: str = Field(min_length=6, max_length=6)
    size: int = Field(ge=0)
    content: str | None = None
    binary: bool
    encoding: Literal["utf-8", "utf-8-bom", "unsupported", "binary"]
    eol: Literal["lf", "crlf", "mixed", "none"]
    too_large: bool = False


class GitConflictFileResponse(GitModel):
    path: str = Field(min_length=1)
    related_paths: list[str] = Field(default_factory=list)
    kind: Literal["both_modified", "add_add", "delete_modify", "rename", "binary", "submodule"]
    stages: list[GitConflictStageResponse] = Field(default_factory=list)
    result_content: str | None = None
    result_binary: bool = False
    result_encoding: Literal["utf-8", "utf-8-bom", "unsupported", "binary"]
    result_eol: Literal["lf", "crlf", "mixed", "none"]
    result_too_large: bool = False
    result_revision: str = Field(min_length=1)
    allowed_actions: list[str] = Field(default_factory=list)
    editable: bool


class GitConflictsResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    max_editable_bytes: int = Field(ge=1)
    files: list[GitConflictFileResponse] = Field(default_factory=list)


class GitConflictStageExpectation(GitModel):
    stage: Literal[1, 2, 3]
    object_id: str = Field(min_length=4)


class GitConflictIndexStage(GitConflictStageExpectation):
    mode: str = Field(pattern=r"^[0-7]{6}$")


class GitConflictResultSaveRequest(GitRepositoryRequest):
    path: str = Field(min_length=1, max_length=4096)
    content: str = Field(max_length=1_200_000)
    encoding: Literal["utf-8", "utf-8-bom"] = "utf-8"
    eol: Literal["lf", "crlf"] = "lf"
    expected_result_revision: str = Field(min_length=1, max_length=128)
    expected_stages: list[GitConflictStageExpectation] = Field(min_length=1, max_length=3)


class GitConflictResultSaveResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    path: str = Field(min_length=1)
    result_revision: str = Field(min_length=1)
    bytes_written: int = Field(ge=0)
    encoding: Literal["utf-8", "utf-8-bom"]
    eol: Literal["lf", "crlf"]


class GitStatusResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    branch: GitBranchResponse
    files: list[GitChangedFileResponse] = Field(default_factory=list)
    operation: GitInProgressOperationResponse | None = None


class GitRefResponse(GitModel):
    full_name: str = Field(min_length=1)
    short_name: str = Field(min_length=1)
    kind: Literal["local", "remote", "tag"]
    object_id: str = Field(min_length=4)
    peeled_object_id: str | None = None
    upstream: str | None = None
    ahead: int | None = Field(default=None, ge=0)
    behind: int | None = Field(default=None, ge=0)
    current: bool = False
    annotated: bool = False
    annotation: str | None = None
    created_at: str | None = None


class GitCommitResponse(GitModel):
    object_id: str = Field(min_length=4)
    parent_ids: list[str] = Field(default_factory=list)
    author_name: str
    author_email: str
    authored_at: str
    committer_name: str
    committer_email: str
    committed_at: str
    subject: str
    body: str
    decorations: list[str] = Field(default_factory=list)
    signature: Literal["valid", "invalid", "unknown", "unsigned"] = "unsigned"


class GitDiffHunkResponse(GitModel):
    header: str
    old_start: int = Field(ge=0)
    old_lines: int = Field(ge=0)
    new_start: int = Field(ge=0)
    new_lines: int = Field(ge=0)
    lines: list[str] = Field(default_factory=list)


class GitFileDiffResponse(GitModel):
    old_path: str | None = None
    new_path: str | None = None
    status: GitFileStatusCode
    binary: bool = False
    old_mode: str | None = None
    new_mode: str | None = None
    additions: int | None = Field(default=None, ge=0)
    deletions: int | None = Field(default=None, ge=0)
    hunks: list[GitDiffHunkResponse] = Field(default_factory=list)
    raw_patch: str
    truncated: bool = False


class GitBlameLineResponse(GitModel):
    object_id: str = Field(min_length=4)
    original_line: int = Field(ge=1)
    final_line: int = Field(ge=1)
    author_name: str = ""
    author_email: str = ""
    authored_at: int | None = None
    summary: str = ""
    filename: str = Field(min_length=1)
    content: str
    boundary: bool = False
    uncommitted: bool = False


class GitReflogEntryResponse(GitModel):
    selector: str = Field(min_length=1)
    object_id: str = Field(min_length=4)
    old_object_id: str | None = None
    actor_name: str
    actor_email: str
    occurred_at: str
    action: str
    message: str


class GitSubmoduleResponse(GitModel):
    path: str = Field(min_length=1)
    object_id: str = Field(min_length=4)
    state: Literal["clean", "uninitialized", "different", "conflicted"]
    description: str = ""
    name: str | None = None
    url: str | None = None
    parent_repository_id: str | None = None
    child_root_path: str | None = None
    initialized: bool = False


class GitSubmodulesSnapshotResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    submodules: list[GitSubmoduleResponse] = Field(default_factory=list)


class GitWorktreeResponse(GitModel):
    path: str = Field(min_length=1)
    head: str | None = None
    branch: str | None = None
    bare: bool = False
    detached: bool = False
    locked_reason: str | None = None
    prunable_reason: str | None = None
    primary: bool = False
    authorized: bool = False
    authorization_required: bool = False
    dirty: bool | None = None


class GitWorktreesSnapshotResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    worktrees: list[GitWorktreeResponse] = Field(default_factory=list)


class GitBisectResponse(GitModel):
    active: bool
    good_revisions: list[str] = Field(default_factory=list)
    bad_revisions: list[str] = Field(default_factory=list)
    skipped_revisions: list[str] = Field(default_factory=list)
    current_revision: str | None = None


class GitBisectSnapshotResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    active: bool
    original_head: str | None = None
    current_revision: str | None = None
    good_revisions: list[str] = Field(default_factory=list)
    bad_revision: str | None = None
    skipped_revisions: list[str] = Field(default_factory=list)
    candidate_revisions: list[str] = Field(default_factory=list)
    remaining_count: int = Field(default=0, ge=0)
    culprit_revision: str | None = None


class GitLfsFileResponse(GitModel):
    path: str = Field(min_length=1)
    object_id: str = Field(min_length=1)
    size: int | None = Field(default=None, ge=0)
    status: Literal["tracked", "missing", "modified", "unknown"] = "tracked"


class GitLfsLockResponse(GitModel):
    id: str = Field(min_length=1)
    path: str = Field(min_length=1)
    owner: str | None = None
    locked_at: str | None = None


class GitLfsSnapshotResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    available: bool
    reason: str | None = None
    tracked_patterns: list[str] = Field(default_factory=list)
    files: list[GitLfsFileResponse] = Field(default_factory=list)
    locks: list[GitLfsLockResponse] = Field(default_factory=list)
    locks_available: bool = False


class GitRefsResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    refs: list[GitRefResponse] = Field(default_factory=list)


class GitRemoteResponse(GitModel):
    name: str
    fetch_url: str | None = None
    push_url: str | None = None
    tracking_branches: list[str] = Field(default_factory=list)


class GitRemotesResponse(GitModel):
    repository_id: str
    repository_version: str
    remotes: list[GitRemoteResponse] = Field(default_factory=list)


class GitHistoryPageResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    commits: list[GitCommitResponse] = Field(default_factory=list)
    next_cursor: str | None = None


class GitCommitDetailResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    commit: GitCommitResponse
    selected_parent_id: str | None = None
    files: list[GitFileDiffResponse] = Field(default_factory=list)


class GitRevisionTreeEntryResponse(GitModel):
    path: str = Field(min_length=1)
    object_id: str = Field(min_length=4)
    mode: str = Field(min_length=6, max_length=6)
    kind: Literal["blob", "submodule"]
    size: int | None = Field(default=None, ge=0)


class GitRevisionTreeResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    object_id: str = Field(min_length=4)
    entries: list[GitRevisionTreeEntryResponse] = Field(default_factory=list)


class GitCompareResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    mode: Literal["commit", "two_dot", "three_dot", "working_tree"]
    left_label: str = Field(min_length=1)
    right_label: str = Field(min_length=1)
    left_object_id: str = Field(min_length=4)
    right_object_id: str | None = Field(default=None, min_length=4)
    comparison_base_object_id: str = Field(min_length=4)
    merge_base_object_id: str | None = Field(default=None, min_length=4)
    files: list[GitFileDiffResponse] = Field(default_factory=list)


class GitMergePreviewResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    source: str = Field(min_length=1)
    head_object_id: str = Field(min_length=4)
    source_object_id: str = Field(min_length=4)
    merge_base_object_id: str = Field(min_length=4)
    incoming_commits: int = Field(ge=0)
    fast_forward: bool
    already_merged: bool
    dirty: bool


class GitDiffResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    files: list[GitFileDiffResponse] = Field(default_factory=list)


class GitBlameResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    path: str = Field(min_length=1)
    revision: str | None = None
    start_line: int = Field(ge=1)
    lines: list[GitBlameLineResponse] = Field(default_factory=list)
    next_start_line: int | None = Field(default=None, ge=1)
    ignore_revs_file: str | None = None


class GitReflogResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    ref: str | None = None
    entries: list[GitReflogEntryResponse] = Field(default_factory=list)
    next_cursor: str | None = None


class GitStashEntryResponse(GitModel):
    selector: str = Field(pattern=r"^stash@\{\d+\}$")
    object_id: str = Field(min_length=4)
    base_object_id: str | None = Field(default=None, min_length=4)
    author_name: str
    created_at: str
    message: str


class GitStashPageResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    entries: list[GitStashEntryResponse] = Field(default_factory=list)
    next_cursor: str | None = None


class GitStashDetailResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    entry: GitStashEntryResponse
    files: list[GitFileDiffResponse] = Field(default_factory=list)


class GitCommandRequest(GitRepositoryRequest):
    idempotency_key: str = Field(min_length=8, max_length=128)
    expected_repository_version: str | None = None
    confirmation_token: str | None = None


class GitConflictActionCommandRequest(GitCommandRequest):
    action: Literal[
        "accept_ours",
        "accept_theirs",
        "keep_modified",
        "accept_delete",
        "delete",
        "mark_resolved",
        "reopen",
    ]
    path: str = Field(min_length=1, max_length=4096)
    expected_stages: list[GitConflictIndexStage] = Field(min_length=1, max_length=3)
    resolved_index_entry: str | None = Field(default=None, max_length=8192)

    @model_validator(mode="after")
    def validate_conflict_action(self) -> GitConflictActionCommandRequest:
        if self.action == "reopen" and not self.resolved_index_entry:
            raise ValueError("Reopening a conflict requires the resolved index entry")
        if self.action != "reopen" and self.resolved_index_entry is not None:
            raise ValueError("The resolved index entry is only valid when reopening a conflict")
        if len({item.stage for item in self.expected_stages}) != len(self.expected_stages):
            raise ValueError("Conflict action stages must be unique")
        return self


class GitBisectStartCommandRequest(GitCommandRequest):
    good_revision: str = Field(min_length=1, max_length=1024)
    bad_revision: str = Field(min_length=1, max_length=1024)


class GitBisectControlCommandRequest(GitCommandRequest):
    action: Literal["good", "bad", "skip", "reset"]


class GitSubmoduleCommandRequest(GitCommandRequest):
    action: Literal["init", "update", "sync", "deinit"]
    paths: list[str] = Field(min_length=1, max_length=500)
    recursive: bool = False
    force: bool = False

    @field_validator("paths")
    @classmethod
    def validate_submodule_paths(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Submodule paths must be unique")
        return value

    @model_validator(mode="after")
    def validate_submodule_options(self) -> GitSubmoduleCommandRequest:
        if self.force and self.action != "deinit":
            raise ValueError("Force is only valid for submodule deinit")
        return self


class GitWorktreeCommandRequest(GitCommandRequest):
    action: Literal["add", "remove", "prune", "lock", "unlock"]
    worktree_path: str | None = Field(default=None, max_length=4096)
    revision: str = Field(default="HEAD", min_length=1, max_length=1024)
    new_branch: str | None = Field(default=None, max_length=1024)
    detach: bool = False
    force: bool = False
    lock_reason: str | None = Field(default=None, max_length=512)
    dirty_confirmed: bool = False

    @model_validator(mode="after")
    def validate_worktree_action(self) -> GitWorktreeCommandRequest:
        if self.action == "prune":
            if self.worktree_path is not None:
                raise ValueError("Worktree prune does not accept a target path")
        elif not self.worktree_path:
            raise ValueError(f"Worktree {self.action} requires a target path")
        if self.new_branch is not None and self.action != "add":
            raise ValueError("A new worktree branch is only valid for add")
        if self.detach and self.action != "add":
            raise ValueError("Detached mode is only valid for worktree add")
        if self.force and self.action != "remove":
            raise ValueError("Force is only valid for worktree remove")
        if self.lock_reason is not None and self.action != "lock":
            raise ValueError("A lock reason is only valid for worktree lock")
        return self


class GitLfsCommandRequest(GitCommandRequest):
    action: Literal["fetch", "pull", "push"]
    remote: str | None = Field(default=None, max_length=255)
    refspec: str | None = Field(default=None, max_length=1024)

    @model_validator(mode="after")
    def validate_lfs_action(self) -> GitLfsCommandRequest:
        if self.action == "push" and (not self.remote or not self.refspec):
            raise ValueError("Git LFS push requires both remote and refspec")
        if self.action == "pull" and self.refspec is not None:
            raise ValueError("Git LFS pull does not accept a refspec")
        return self


class GitPathsCommandRequest(GitCommandRequest):
    paths: list[str] = Field(min_length=1, max_length=1000)

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, value: list[str]) -> list[str]:
        from .security import validate_repo_relative_path

        return [validate_repo_relative_path(path) for path in value]


class GitCommitCommandRequest(GitCommandRequest):
    message: str = Field(min_length=1, max_length=20_000)
    amend: bool = False
    sign: bool = False
    paths: list[str] = Field(default_factory=list, max_length=1000)
    untracked_paths: list[str] = Field(default_factory=list, max_length=1000)

    @field_validator("message")
    @classmethod
    def validate_commit_message(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Commit message cannot be blank")
        return value.replace("\r\n", "\n")

    @field_validator("paths", "untracked_paths")
    @classmethod
    def validate_commit_paths(cls, value: list[str]) -> list[str]:
        from .security import validate_repo_relative_path

        return list(dict.fromkeys(validate_repo_relative_path(path) for path in value))

    @model_validator(mode="after")
    def validate_untracked_paths_are_selected(self) -> GitCommitCommandRequest:
        if not set(self.untracked_paths).issubset(self.paths):
            raise ValueError("Untracked commit paths must also be selected commit paths")
        return self


class GitBranchCommandRequest(GitCommandRequest):
    branch_name: str = Field(min_length=1, max_length=255)
    start_point: str = "HEAD"


class GitBranchRenameCommandRequest(GitCommandRequest):
    old_name: str = Field(min_length=1, max_length=255)
    new_name: str = Field(min_length=1, max_length=255)


class GitBranchDeleteCommandRequest(GitCommandRequest):
    branch_name: str = Field(min_length=1, max_length=255)
    force: bool = False
    remote: str | None = Field(default=None, max_length=255)


class GitTagCreateCommandRequest(GitCommandRequest):
    tag_name: str = Field(min_length=1, max_length=255)
    target: str = Field(default="HEAD", min_length=1, max_length=1024)
    annotated: bool = False
    message: str | None = Field(default=None, max_length=20_000)
    sign: bool = False


class GitTagDeleteCommandRequest(GitCommandRequest):
    tag_name: str = Field(min_length=1, max_length=255)
    remote: str | None = Field(default=None, max_length=255)


class GitRemoteAddCommandRequest(GitCommandRequest):
    remote_name: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=4096)


class GitRemoteRenameCommandRequest(GitCommandRequest):
    old_name: str = Field(min_length=1, max_length=255)
    new_name: str = Field(min_length=1, max_length=255)


class GitRemoteSetUrlCommandRequest(GitCommandRequest):
    remote_name: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=4096)
    push: bool = False


class GitRemoteRemoveCommandRequest(GitCommandRequest):
    remote_name: str = Field(min_length=1, max_length=255)


class GitUpstreamCommandRequest(GitCommandRequest):
    branch_name: str = Field(min_length=1, max_length=255)
    upstream: str | None = Field(default=None, max_length=1024)


class GitCheckoutCommandRequest(GitCommandRequest):
    ref: str = Field(min_length=1, max_length=1024)
    detach: bool = False


class GitRemoteCommandRequest(GitCommandRequest):
    remote: str = Field(default="origin", min_length=1, max_length=255)
    refspec: str | None = Field(default=None, max_length=1024)
    set_upstream: bool = False
    prune: bool = False
    tags: bool = False


class GitFetchCommandRequest(GitCommandRequest):
    remote: str | None = Field(default="origin", min_length=1, max_length=255)
    all_remotes: bool = False
    refspec: str | None = Field(default=None, max_length=1024)
    prune: bool = False
    tags: bool = False


class GitUpdateCommandRequest(GitCommandRequest):
    remote: str = Field(default="origin", min_length=1, max_length=255)
    refspec: str = Field(min_length=1, max_length=1024)
    strategy: Literal["ff_only", "merge", "rebase"] = "ff_only"


class GitPushCommandRequest(GitCommandRequest):
    remote: str = Field(default="origin", min_length=1, max_length=255)
    source: str = Field(min_length=1, max_length=1024)
    target: str = Field(min_length=1, max_length=1024)
    tag_name: str | None = Field(default=None, min_length=1, max_length=255)
    set_upstream: bool = False
    tags: bool = False
    follow_tags: bool = False
    force_with_lease: bool = False


class GitStashPushCommandRequest(GitCommandRequest):
    message: str | None = Field(default=None, max_length=20_000)
    staged: bool = False
    include_untracked: bool = False


class GitStashEntryCommandRequest(GitCommandRequest):
    selector: str = Field(pattern=r"^stash@\{\d+\}$")
    object_id: str = Field(min_length=4, max_length=64)
    reinstate_index: bool = False


class GitStashBranchCommandRequest(GitStashEntryCommandRequest):
    branch_name: str = Field(min_length=1, max_length=255)


class GitStashClearCommandRequest(GitCommandRequest):
    pass


class GitMergeCommandRequest(GitCommandRequest):
    source: str = Field(min_length=1, max_length=1024)
    strategy: Literal["ff", "no_ff", "squash"] = "ff"
    message: str | None = Field(default=None, max_length=20_000)

    @field_validator("message")
    @classmethod
    def validate_merge_message(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.replace("\r\n", "\n").strip()
        return normalized or None


class GitMergeAbortCommandRequest(GitCommandRequest):
    pass


class GitRebaseTodoItem(GitModel):
    action: Literal["pick", "reword", "squash", "fixup", "drop"] = "pick"
    object_id: str = Field(min_length=4, max_length=64)
    subject: str = Field(default="", max_length=512)
    message: str | None = Field(default=None, max_length=20_000)


class GitRebaseCommandRequest(GitCommandRequest):
    upstream: str = Field(min_length=1, max_length=1024)
    onto: str | None = Field(default=None, max_length=1024)
    interactive: bool = False
    todo: list[GitRebaseTodoItem] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_todo(self) -> GitRebaseCommandRequest:
        if self.interactive and not self.todo:
            raise ValueError("Interactive rebase requires a todo plan")
        if not self.interactive and self.todo:
            raise ValueError("A todo plan is only valid for interactive rebase")
        actionable = False
        seen: set[str] = set()
        for item in self.todo:
            if item.object_id in seen:
                raise ValueError("Rebase todo contains a duplicate commit")
            seen.add(item.object_id)
            if item.action in {"squash", "fixup"} and not actionable:
                raise ValueError("Squash/fixup requires a previous non-dropped commit")
            if item.action == "reword" and not (item.message or "").strip():
                raise ValueError("Reword requires a new commit message")
            if item.action != "drop":
                actionable = True
        return self


class GitRebaseControlCommandRequest(GitCommandRequest):
    action: Literal["continue", "skip", "abort"]


class GitRebasePreviewItem(GitModel):
    object_id: str = Field(min_length=4)
    subject: str


class GitRebasePreviewResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    upstream: str = Field(min_length=1)
    onto: str | None = None
    head_object_id: str = Field(min_length=4)
    upstream_object_id: str = Field(min_length=4)
    onto_object_id: str | None = Field(default=None, min_length=4)
    commits: list[GitRebasePreviewItem] = Field(default_factory=list)
    dirty: bool


class GitCherryPickCommandRequest(GitCommandRequest):
    commits: list[str] = Field(min_length=1, max_length=200)
    record_origin: bool = False

    @field_validator("commits")
    @classmethod
    def validate_commits(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Cherry-pick commit list contains duplicates")
        return value


class GitCherryPickControlCommandRequest(GitCommandRequest):
    action: Literal["continue", "skip", "abort"]


class GitRevertCommandRequest(GitCommandRequest):
    commits: list[str] = Field(min_length=1, max_length=200)
    mainline: int | None = Field(default=None, ge=1, le=64)

    @field_validator("commits")
    @classmethod
    def validate_commits(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Revert commit list contains duplicates")
        return value


class GitRevertControlCommandRequest(GitCommandRequest):
    action: Literal["continue", "skip", "abort"]


class GitResetCommandRequest(GitCommandRequest):
    target: str = Field(min_length=1, max_length=1024)
    mode: Literal["soft", "mixed", "hard"] = "mixed"


class GitRestoreCommandRequest(GitCommandRequest):
    paths: list[str] = Field(min_length=1, max_length=2000)
    source: str | None = Field(default=None, max_length=1024)
    staged: bool = False
    worktree: bool = True

    @model_validator(mode="after")
    def validate_destination(self) -> GitRestoreCommandRequest:
        if not self.staged and not self.worktree:
            raise ValueError("Restore requires the index, worktree, or both")
        return self


class GitResetPreviewFile(GitModel):
    path: str
    change_type: str


class GitResetPreviewResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    target: str = Field(min_length=1)
    target_object_id: str = Field(min_length=4)
    head_object_id: str | None = Field(default=None, min_length=4)
    mode: Literal["soft", "mixed", "hard"]
    files: list[GitResetPreviewFile] = Field(default_factory=list)
    untracked_overwrites: list[str] = Field(default_factory=list)
    reflog_recovery: str


class GitPatchCommandRequest(GitCommandRequest):
    patch: str = Field(min_length=1, max_length=2_000_000)
    cached: bool = True
    reverse: bool = False
    check_only: bool = False
    reject: bool = False
    expected_source_version: str | None = Field(default=None, min_length=1, max_length=128)
    expected_source_patch: str | None = Field(default=None, min_length=1, max_length=2_000_000)
    source_kind: Literal["working_tree", "index"] | None = None
    source_paths: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("source_paths")
    @classmethod
    def validate_source_paths(cls, value: list[str]) -> list[str]:
        from .security import validate_repo_relative_path

        return list(dict.fromkeys(validate_repo_relative_path(path) for path in value))

    @model_validator(mode="after")
    def validate_patch_mode(self) -> GitPatchCommandRequest:
        source_identity = (
            self.expected_source_version,
            self.expected_source_patch,
            self.source_kind,
        )
        if any(item is not None for item in source_identity) and (
            any(item is None for item in source_identity) or not self.source_paths
        ):
            raise ValueError(
                "Patch source identity requires version, original patch, kind, and paths"
            )
        if self.check_only and self.reject:
            raise ValueError("Patch dry-run cannot create reject files")
        if self.cached and self.reject:
            raise ValueError("Reject mode is only available for worktree patch import")
        return self


class GitPatchExportResponse(GitModel):
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    mode: Literal["working_tree", "index", "commit", "range"]
    left: str | None = None
    right: str | None = None
    paths: list[str] = Field(default_factory=list)
    filename: str = Field(min_length=1)
    patch: str


class GitIdentityResponse(GitModel):
    repository_id: str
    name: str | None = None
    email: str | None = None
    sign_by_default: bool = False


class GitIdentityUpdateRequest(GitRepositoryRequest):
    name: str = Field(min_length=1, max_length=256)
    email: str = Field(min_length=3, max_length=320)
    sign_by_default: bool = False

    @field_validator("name", "email")
    @classmethod
    def validate_identity_value(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or "\x00" in normalized or "\n" in normalized or "\r" in normalized:
            raise ValueError("Git identity values must be single-line text")
        return normalized


class GitConfirmationRequest(GitModel):
    command: str = Field(min_length=1)
    payload: dict[str, Any]


class GitConfirmationResponse(GitModel):
    token: str = Field(min_length=1)
    expires_at: str
    command: str
    risk: str


class GitOperationErrorResponse(GitModel):
    code: str = "git_failed"
    message: str
    retryable: bool = False
    details: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class GitCommandResponse(GitModel):
    operation_id: str = Field(min_length=1)
    repository_id: str = Field(min_length=1)
    repository_version: str = Field(min_length=1)
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    summary: str
    result: dict[str, Any] = Field(default_factory=dict)
    command: str = "unknown"
    risk: str = "safe"
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    retryable: bool = False
    error: GitOperationErrorResponse | None = None


class GitErrorResponse(GitModel):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    retryable: bool = False
    operation_id: str | None = None
    repository_id: str | None = None
    details: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


GIT_ERROR_HTTP_STATUS: dict[str, int] = {
    code: entry.http_status for code, entry in GIT_ERROR_CONTRACT.items()
}


class GitApiError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        operation_id: str | None = None,
        repository_id: str | None = None,
        details: dict[str, str | int | float | bool | None] | None = None,
    ) -> None:
        super().__init__(message)
        self.payload = GitErrorResponse(
            code=code,
            message=message,
            retryable=retryable,
            operation_id=operation_id,
            repository_id=repository_id,
            details=details or {},
        )
        self.status_code = git_error_http_status(code)
