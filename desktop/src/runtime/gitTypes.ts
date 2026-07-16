export type GitRepositoryId = string & { readonly __gitRepositoryId: unique symbol };
export type GitObjectId = string & { readonly __gitObjectId: unique symbol };
export type GitRepositoryVersion = string & { readonly __gitRepositoryVersion: unique symbol };

export type GitRepositoryKind = "workspace" | "nested" | "ancestor" | "worktree" | "submodule";
export type GitFileStatusCode =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "type_changed";
export type GitOperationKind =
  | "init"
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "fetch"
  | "update"
  | "push"
  | "branch"
  | "tag"
  | "remote"
  | "stash"
  | "merge"
  | "rebase"
  | "cherry_pick"
  | "revert"
  | "reset"
  | "restore"
  | "patch"
  | "bisect"
  | "submodule"
  | "worktree"
  | "lfs";
export type GitOperationState = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type GitRiskLevel = "none" | "confirm" | "strong_confirm" | "second_confirm";

export interface GitCapabilitySet {
  available: boolean;
  executable: string | null;
  version: string | null;
  supportsSwitch: boolean;
  supportsRestore: boolean;
  supportsPathspecFromFile: boolean;
  lfsAvailable: boolean;
  reason?: string;
}

export interface GitRepositoryDescriptor {
  id: GitRepositoryId;
  workspaceId: string;
  rootPath: string;
  displayPath: string;
  gitDirPath: string;
  kind: GitRepositoryKind;
  parentRepoId: GitRepositoryId | null;
  bare: boolean;
  ancestorAuthorization: "not_required" | "pending" | "granted" | "denied";
}

export interface GitBranchSummary {
  head: string | null;
  detachedAt: GitObjectId | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  unborn: boolean;
}

export interface GitChangedFile {
  path: string;
  originalPath: string | null;
  indexStatus: GitFileStatusCode | null;
  worktreeStatus: GitFileStatusCode | null;
  conflicted: boolean;
  binary: boolean | null;
  submodule: boolean;
}

export interface GitStatusSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  branch: GitBranchSummary;
  files: readonly GitChangedFile[];
  operation: GitInProgressOperation | null;
}

export interface GitRef {
  fullName: string;
  shortName: string;
  kind: "local" | "remote" | "tag";
  objectId: GitObjectId;
  peeledObjectId: GitObjectId | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  current: boolean;
  annotated?: boolean;
  annotation?: string | null;
  createdAt?: string | null;
}

export interface GitCommitSummary {
  objectId: GitObjectId;
  parentIds: readonly GitObjectId[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  subject: string;
  body: string;
  decorations: readonly string[];
  signature: "valid" | "invalid" | "unknown" | "unsigned";
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: readonly string[];
}

export interface GitFileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: GitFileStatusCode;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  additions: number | null;
  deletions: number | null;
  hunks: readonly GitDiffHunk[];
  rawPatch: string;
  truncated: boolean;
}

export interface GitInProgressOperation {
  kind: "merge" | "rebase" | "cherry_pick" | "revert" | "bisect" | "stash_apply";
  state: "running" | "conflicted" | "continuable";
  currentStep: number | null;
  totalSteps: number | null;
  currentObjectId: GitObjectId | null;
}

export interface GitBisectSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  active: boolean;
  originalHead: string | null;
  currentRevision: GitObjectId | null;
  goodRevisions: readonly GitObjectId[];
  badRevision: GitObjectId | null;
  skippedRevisions: readonly GitObjectId[];
  candidateRevisions: readonly GitObjectId[];
  remainingCount: number;
  culpritRevision: GitObjectId | null;
}

export interface GitSubmodule {
  path: string;
  objectId: GitObjectId;
  state: "clean" | "uninitialized" | "different" | "conflicted";
  description: string;
  name: string | null;
  url: string | null;
  parentRepositoryId: GitRepositoryId;
  childRootPath: string | null;
  initialized: boolean;
}

export interface GitSubmodulesSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  submodules: readonly GitSubmodule[];
}

export interface GitWorktree {
  path: string;
  head: GitObjectId | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  lockedReason: string | null;
  prunableReason: string | null;
  primary: boolean;
  authorized: boolean;
  authorizationRequired: boolean;
  dirty: boolean | null;
}

export interface GitWorktreesSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  worktrees: readonly GitWorktree[];
}

export interface GitLfsFile {
  path: string;
  objectId: string;
  size: number | null;
  status: "tracked" | "missing" | "modified" | "unknown";
}

export interface GitLfsLock {
  id: string;
  path: string;
  owner: string | null;
  lockedAt: string | null;
}

export interface GitLfsSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  available: boolean;
  reason: string | null;
  trackedPatterns: readonly string[];
  files: readonly GitLfsFile[];
  locks: readonly GitLfsLock[];
  locksAvailable: boolean;
}

export type GitConflictKind = "both_modified" | "add_add" | "delete_modify" | "rename" | "binary" | "submodule";

export interface GitConflictStage {
  stage: 1 | 2 | 3;
  label: "base" | "ours" | "theirs";
  objectId: GitObjectId;
  mode: string;
  size: number;
  content: string | null;
  binary: boolean;
  encoding: "utf-8" | "utf-8-bom" | "unsupported" | "binary";
  eol: "lf" | "crlf" | "mixed" | "none";
  tooLarge: boolean;
}

export interface GitConflictFile {
  path: string;
  relatedPaths: readonly string[];
  kind: GitConflictKind;
  stages: readonly GitConflictStage[];
  resultContent: string | null;
  resultBinary: boolean;
  resultEncoding: "utf-8" | "utf-8-bom" | "unsupported" | "binary";
  resultEol: "lf" | "crlf" | "mixed" | "none";
  resultTooLarge: boolean;
  resultRevision: string;
  allowedActions: readonly string[];
  editable: boolean;
}

export interface GitConflictsSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  maxEditableBytes: number;
  files: readonly GitConflictFile[];
}

export interface GitOperationRecord {
  operationId: string;
  repositoryId: GitRepositoryId;
  kind: GitOperationKind;
  state: GitOperationState;
  risk: GitRiskLevel;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string;
  error: GitRuntimeError | null;
}

export interface GitRuntimeError {
  code: string;
  message: string;
  retryable: boolean;
  operationId: string | null;
  repositoryId: GitRepositoryId | null;
  details: Record<string, string | number | boolean | null>;
}

export interface GitVersionedResult<T> {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  value: T;
}

export interface GitDiscoverySnapshot {
  capability: GitCapabilitySet;
  repositories: readonly GitRepositoryDescriptor[];
  ancestorCandidate: GitRepositoryDescriptor | null;
}

export interface GitRefsSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  refs: readonly GitRef[];
}

export interface GitHistoryPage {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  commits: readonly GitCommitSummary[];
  nextCursor: string | null;
}

export interface GitCommitDetail {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  commit: GitCommitSummary;
  selectedParentId: GitObjectId | null;
  files: readonly GitFileDiff[];
}

export type GitCompareMode = "commit" | "two_dot" | "three_dot" | "working_tree";

export interface GitCompareResult {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  mode: GitCompareMode;
  leftLabel: string;
  rightLabel: string;
  leftObjectId: GitObjectId;
  rightObjectId: GitObjectId | null;
  comparisonBaseObjectId: GitObjectId;
  mergeBaseObjectId: GitObjectId | null;
  files: readonly GitFileDiff[];
}

export interface GitBlameLine {
  objectId: GitObjectId;
  originalLine: number;
  finalLine: number;
  authorName: string;
  authorEmail: string;
  authoredAt: number | null;
  summary: string;
  filename: string;
  content: string;
  boundary: boolean;
  uncommitted: boolean;
}

export interface GitBlamePage {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  path: string;
  revision: string | null;
  startLine: number;
  lines: readonly GitBlameLine[];
  nextStartLine: number | null;
  ignoreRevsFile: string | null;
}

export interface GitReflogEntry {
  selector: string;
  objectId: GitObjectId;
  oldObjectId: GitObjectId | null;
  actorName: string;
  actorEmail: string;
  occurredAt: string;
  action: string;
  message: string;
}

export interface GitReflogPage {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  ref: string | null;
  entries: readonly GitReflogEntry[];
  nextCursor: string | null;
}

export type GitMergeStrategy = "ff" | "no_ff" | "squash";

export interface GitMergePreview {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  source: string;
  headObjectId: GitObjectId;
  sourceObjectId: GitObjectId;
  mergeBaseObjectId: GitObjectId;
  incomingCommits: number;
  fastForward: boolean;
  alreadyMerged: boolean;
  dirty: boolean;
}

export type GitRebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface GitRebaseTodoItem {
  action: GitRebaseAction;
  objectId: GitObjectId;
  subject: string;
  message?: string | null;
}

export interface GitRebasePreview {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  upstream: string;
  onto: string | null;
  headObjectId: GitObjectId;
  upstreamObjectId: GitObjectId;
  ontoObjectId: GitObjectId | null;
  commits: readonly Omit<GitRebaseTodoItem, "action">[];
  dirty: boolean;
}

export type GitResetMode = "soft" | "mixed" | "hard";

export interface GitResetPreview {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  target: string;
  targetObjectId: GitObjectId;
  headObjectId: GitObjectId | null;
  mode: GitResetMode;
  files: readonly { path: string; changeType: string }[];
  untrackedOverwrites: readonly string[];
  reflogRecovery: string;
}

export interface GitDiffSnapshot {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  files: readonly GitFileDiff[];
}

export interface GitCommandResult {
  operationId: string;
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  state: Exclude<GitOperationState, "cancelling">;
  summary: string;
  result: Record<string, unknown>;
  command: string;
  risk: "safe" | "write" | "destructive" | "history_rewrite" | "remote_destructive";
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  retryable: boolean;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  } | null;
}

export interface GitMetadataChangedEvent {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  sequence: number;
  domains: readonly string[];
  paths: readonly string[];
  resyncRequired: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label);
}

function count(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function positiveCount(value: unknown, label: string): number {
  const result = count(value, label);
  if (result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

const FILE_STATUSES = new Set<GitFileStatusCode>([
  "added", "modified", "deleted", "renamed", "copied", "untracked", "conflicted", "type_changed",
]);

function fileStatus(value: unknown, label: string): GitFileStatusCode | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !FILE_STATUSES.has(value as GitFileStatusCode)) {
    throw new Error(`${label} has an unknown Git file status`);
  }
  return value as GitFileStatusCode;
}

export function normalizeGitRepository(value: unknown): GitRepositoryDescriptor {
  const raw = record(value, "repository");
  const id = text(raw.id, "repository.id") as GitRepositoryId;
  const workspaceId = text(raw.workspace_id, "repository.workspace_id");
  const kind = text(raw.kind, "repository.kind") as GitRepositoryKind;
  if (!["workspace", "nested", "ancestor", "worktree", "submodule"].includes(kind)) {
    throw new Error("repository.kind is unknown");
  }
  const authorization = text(raw.ancestor_authorization, "repository.ancestor_authorization") as GitRepositoryDescriptor["ancestorAuthorization"];
  if (!["not_required", "pending", "granted", "denied"].includes(authorization)) {
    throw new Error("repository.ancestor_authorization is unknown");
  }
  return {
    id,
    workspaceId,
    rootPath: text(raw.root_path, "repository.root_path"),
    displayPath: text(raw.display_path, "repository.display_path"),
    gitDirPath: text(raw.git_dir_path, "repository.git_dir_path"),
    kind,
    parentRepoId: optionalText(raw.parent_repo_id, "repository.parent_repo_id") as GitRepositoryId | null,
    bare: Boolean(raw.bare),
    ancestorAuthorization: authorization,
  };
}

export function normalizeGitStatus(value: unknown): GitStatusSnapshot {
  const raw = record(value, "status");
  const branch = record(raw.branch, "status.branch");
  if (!Array.isArray(raw.files)) throw new Error("status.files must be an array");
  return {
    repositoryId: text(raw.repository_id, "status.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "status.repository_version") as GitRepositoryVersion,
    branch: {
      head: optionalText(branch.head, "status.branch.head"),
      detachedAt: optionalText(branch.detached_at, "status.branch.detached_at") as GitObjectId | null,
      upstream: optionalText(branch.upstream, "status.branch.upstream"),
      ahead: count(branch.ahead, "status.branch.ahead"),
      behind: count(branch.behind, "status.branch.behind"),
      unborn: Boolean(branch.unborn),
    },
    files: raw.files.flatMap((item, index) => {
      const file = record(item, `status.files[${index}]`);
      // Version-skew defense: older backends may still include ignored entries.
      // They are not part of Keydex's Git status contract and must not reach the store.
      if (file.worktree_status === "ignored") return [];
      return [{
        path: text(file.path, `status.files[${index}].path`),
        originalPath: optionalText(file.original_path, `status.files[${index}].original_path`),
        indexStatus: fileStatus(file.index_status, `status.files[${index}].index_status`),
        worktreeStatus: fileStatus(file.worktree_status, `status.files[${index}].worktree_status`),
        conflicted: Boolean(file.conflicted),
        binary: file.binary === null || file.binary === undefined ? null : Boolean(file.binary),
        submodule: Boolean(file.submodule),
      }];
    }),
    operation: raw.operation ? normalizeGitInProgressOperation(raw.operation) : null,
  };
}

export function normalizeGitCapability(value: unknown): GitCapabilitySet {
  const raw = record(value, "Git capability");
  return {
    available: Boolean(raw.available),
    executable: optionalText(raw.executable, "Git capability.executable"),
    version: optionalText(raw.version, "Git capability.version"),
    supportsSwitch: Boolean(raw.supports_switch),
    supportsRestore: Boolean(raw.supports_restore),
    supportsPathspecFromFile: Boolean(raw.supports_pathspec_from_file),
    lfsAvailable: Boolean(raw.lfs_available),
    reason: optionalText(raw.reason, "Git capability.reason") ?? undefined,
  };
}

export function normalizeGitDiscovery(value: unknown): GitDiscoverySnapshot {
  const raw = record(value, "Git discovery");
  if (!Array.isArray(raw.repositories)) throw new Error("Git discovery.repositories must be an array");
  return {
    capability: normalizeGitCapability(raw.capability),
    repositories: raw.repositories.map(normalizeGitRepository),
    ancestorCandidate: raw.ancestor_candidate ? normalizeGitRepository(raw.ancestor_candidate) : null,
  };
}

export function normalizeGitRefs(value: unknown): GitRefsSnapshot {
  const raw = record(value, "Git refs");
  if (!Array.isArray(raw.refs)) throw new Error("Git refs.refs must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git refs.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git refs.repository_version") as GitRepositoryVersion,
    refs: raw.refs.map((value, index) => normalizeGitRef(value, `Git refs.refs[${index}]`)),
  };
}

export function normalizeGitHistory(value: unknown): GitHistoryPage {
  const raw = record(value, "Git history");
  if (!Array.isArray(raw.commits)) throw new Error("Git history.commits must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git history.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git history.repository_version") as GitRepositoryVersion,
    commits: raw.commits.map((value, index) => normalizeGitCommit(value, `Git history.commits[${index}]`)),
    nextCursor: optionalText(raw.next_cursor, "Git history.next_cursor"),
  };
}

export function normalizeGitCommit(value: unknown, label = "Git commit"): GitCommitSummary {
  const raw = record(value, label);
  if (!Array.isArray(raw.parent_ids) || !Array.isArray(raw.decorations)) {
    throw new Error(`${label} parents and decorations must be arrays`);
  }
  const signature = text(raw.signature, `${label}.signature`) as GitCommitSummary["signature"];
  if (!["valid", "invalid", "unknown", "unsigned"].includes(signature)) {
    throw new Error(`${label}.signature is unknown`);
  }
  return {
    objectId: text(raw.object_id, `${label}.object_id`) as GitObjectId,
    parentIds: raw.parent_ids.map((value, index) => text(value, `${label}.parent_ids[${index}]`) as GitObjectId),
    authorName: typeof raw.author_name === "string" ? raw.author_name : "",
    authorEmail: typeof raw.author_email === "string" ? raw.author_email : "",
    authoredAt: text(raw.authored_at, `${label}.authored_at`),
    committerName: typeof raw.committer_name === "string" ? raw.committer_name : "",
    committerEmail: typeof raw.committer_email === "string" ? raw.committer_email : "",
    committedAt: text(raw.committed_at, `${label}.committed_at`),
    subject: typeof raw.subject === "string" ? raw.subject : "",
    body: typeof raw.body === "string" ? raw.body : "",
    decorations: raw.decorations.map((value, index) => text(value, `${label}.decorations[${index}]`)),
    signature,
  };
}

export function normalizeGitCommitDetail(value: unknown): GitCommitDetail {
  const raw = record(value, "Git commit detail");
  if (!Array.isArray(raw.files)) throw new Error("Git commit detail.files must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git commit detail.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git commit detail.repository_version") as GitRepositoryVersion,
    commit: normalizeGitCommit(raw.commit, "Git commit detail.commit"),
    selectedParentId: optionalText(raw.selected_parent_id, "Git commit detail.selected_parent_id") as GitObjectId | null,
    files: raw.files.map((file, index) => normalizeGitFileDiff(file, `Git commit detail.files[${index}]`)),
  };
}

export function normalizeGitCompare(value: unknown): GitCompareResult {
  const raw = record(value, "Git compare");
  if (!Array.isArray(raw.files)) throw new Error("Git compare.files must be an array");
  const mode = text(raw.mode, "Git compare.mode") as GitCompareMode;
  if (!["commit", "two_dot", "three_dot", "working_tree"].includes(mode)) {
    throw new Error("Git compare.mode is unknown");
  }
  return {
    repositoryId: text(raw.repository_id, "Git compare.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git compare.repository_version") as GitRepositoryVersion,
    mode,
    leftLabel: text(raw.left_label, "Git compare.left_label"),
    rightLabel: text(raw.right_label, "Git compare.right_label"),
    leftObjectId: text(raw.left_object_id, "Git compare.left_object_id") as GitObjectId,
    rightObjectId: optionalText(raw.right_object_id, "Git compare.right_object_id") as GitObjectId | null,
    comparisonBaseObjectId: text(raw.comparison_base_object_id, "Git compare.comparison_base_object_id") as GitObjectId,
    mergeBaseObjectId: optionalText(raw.merge_base_object_id, "Git compare.merge_base_object_id") as GitObjectId | null,
    files: raw.files.map((file, index) => normalizeGitFileDiff(file, `Git compare.files[${index}]`)),
  };
}

export function normalizeGitBlame(value: unknown): GitBlamePage {
  const raw = record(value, "Git blame");
  if (!Array.isArray(raw.lines)) throw new Error("Git blame.lines must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git blame.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git blame.repository_version") as GitRepositoryVersion,
    path: text(raw.path, "Git blame.path"),
    revision: optionalText(raw.revision, "Git blame.revision"),
    startLine: positiveCount(raw.start_line, "Git blame.start_line"),
    lines: raw.lines.map((value, index) => {
      const line = record(value, `Git blame.lines[${index}]`);
      return {
        objectId: text(line.object_id, `Git blame.lines[${index}].object_id`) as GitObjectId,
        originalLine: positiveCount(line.original_line, `Git blame.lines[${index}].original_line`),
        finalLine: positiveCount(line.final_line, `Git blame.lines[${index}].final_line`),
        authorName: typeof line.author_name === "string" ? line.author_name : "",
        authorEmail: typeof line.author_email === "string" ? line.author_email : "",
        authoredAt: line.authored_at === null || line.authored_at === undefined
          ? null
          : count(line.authored_at, `Git blame.lines[${index}].authored_at`),
        summary: typeof line.summary === "string" ? line.summary : "",
        filename: text(line.filename, `Git blame.lines[${index}].filename`),
        content: typeof line.content === "string" ? line.content : "",
        boundary: Boolean(line.boundary),
        uncommitted: Boolean(line.uncommitted),
      };
    }),
    nextStartLine: raw.next_start_line === null || raw.next_start_line === undefined
      ? null
      : positiveCount(raw.next_start_line, "Git blame.next_start_line"),
    ignoreRevsFile: optionalText(raw.ignore_revs_file, "Git blame.ignore_revs_file"),
  };
}

export function normalizeGitReflog(value: unknown): GitReflogPage {
  const raw = record(value, "Git reflog");
  if (!Array.isArray(raw.entries)) throw new Error("Git reflog.entries must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git reflog.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git reflog.repository_version") as GitRepositoryVersion,
    ref: optionalText(raw.ref, "Git reflog.ref"),
    entries: raw.entries.map((value, index) => {
      const entry = record(value, `Git reflog.entries[${index}]`);
      return {
        selector: text(entry.selector, `Git reflog.entries[${index}].selector`),
        objectId: text(entry.object_id, `Git reflog.entries[${index}].object_id`) as GitObjectId,
        oldObjectId: optionalText(entry.old_object_id, `Git reflog.entries[${index}].old_object_id`) as GitObjectId | null,
        actorName: typeof entry.actor_name === "string" ? entry.actor_name : "",
        actorEmail: typeof entry.actor_email === "string" ? entry.actor_email : "",
        occurredAt: text(entry.occurred_at, `Git reflog.entries[${index}].occurred_at`),
        action: text(entry.action, `Git reflog.entries[${index}].action`),
        message: typeof entry.message === "string" ? entry.message : "",
      };
    }),
    nextCursor: optionalText(raw.next_cursor, "Git reflog.next_cursor"),
  };
}

export function normalizeGitMergePreview(value: unknown): GitMergePreview {
  const raw = record(value, "Git merge preview");
  return {
    repositoryId: text(raw.repository_id, "Git merge preview.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git merge preview.repository_version") as GitRepositoryVersion,
    source: text(raw.source, "Git merge preview.source"),
    headObjectId: text(raw.head_object_id, "Git merge preview.head_object_id") as GitObjectId,
    sourceObjectId: text(raw.source_object_id, "Git merge preview.source_object_id") as GitObjectId,
    mergeBaseObjectId: text(raw.merge_base_object_id, "Git merge preview.merge_base_object_id") as GitObjectId,
    incomingCommits: count(raw.incoming_commits, "Git merge preview.incoming_commits"),
    fastForward: Boolean(raw.fast_forward),
    alreadyMerged: Boolean(raw.already_merged),
    dirty: Boolean(raw.dirty),
  };
}

export function normalizeGitRebasePreview(value: unknown): GitRebasePreview {
  const raw = record(value, "Git rebase preview");
  if (!Array.isArray(raw.commits)) throw new Error("Git rebase preview.commits must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git rebase preview.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git rebase preview.repository_version") as GitRepositoryVersion,
    upstream: text(raw.upstream, "Git rebase preview.upstream"),
    onto: optionalText(raw.onto, "Git rebase preview.onto"),
    headObjectId: text(raw.head_object_id, "Git rebase preview.head_object_id") as GitObjectId,
    upstreamObjectId: text(raw.upstream_object_id, "Git rebase preview.upstream_object_id") as GitObjectId,
    ontoObjectId: optionalText(raw.onto_object_id, "Git rebase preview.onto_object_id") as GitObjectId | null,
    commits: raw.commits.map((value, index) => {
      const item = record(value, `Git rebase preview.commits[${index}]`);
      return {
        objectId: text(item.object_id, `Git rebase preview.commits[${index}].object_id`) as GitObjectId,
        subject: typeof item.subject === "string" ? item.subject : "",
      };
    }),
    dirty: Boolean(raw.dirty),
  };
}

export function normalizeGitResetPreview(value: unknown): GitResetPreview {
  const raw = record(value, "Git reset preview");
  if (!Array.isArray(raw.files)) throw new Error("Git reset preview.files must be an array");
  if (!Array.isArray(raw.untracked_overwrites)) throw new Error("Git reset preview.untracked_overwrites must be an array");
  const mode = text(raw.mode, "Git reset preview.mode");
  if (mode !== "soft" && mode !== "mixed" && mode !== "hard") throw new Error("Git reset preview.mode is invalid");
  return {
    repositoryId: text(raw.repository_id, "Git reset preview.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git reset preview.repository_version") as GitRepositoryVersion,
    target: text(raw.target, "Git reset preview.target"),
    targetObjectId: text(raw.target_object_id, "Git reset preview.target_object_id") as GitObjectId,
    headObjectId: optionalText(raw.head_object_id, "Git reset preview.head_object_id") as GitObjectId | null,
    mode,
    files: raw.files.map((value, index) => {
      const item = record(value, `Git reset preview.files[${index}]`);
      return { path: text(item.path, `Git reset preview.files[${index}].path`), changeType: text(item.change_type, `Git reset preview.files[${index}].change_type`) };
    }),
    untrackedOverwrites: raw.untracked_overwrites.map((value, index) => text(value, `Git reset preview.untracked_overwrites[${index}]`)),
    reflogRecovery: text(raw.reflog_recovery, "Git reset preview.reflog_recovery"),
  };
}

export function normalizeGitConflicts(value: unknown): GitConflictsSnapshot {
  const raw = record(value, "Git conflicts");
  if (!Array.isArray(raw.files)) throw new Error("Git conflicts.files must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git conflicts.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git conflicts.repository_version") as GitRepositoryVersion,
    maxEditableBytes: count(raw.max_editable_bytes, "Git conflicts.max_editable_bytes"),
    files: raw.files.map((value, fileIndex) => {
      const file = record(value, `Git conflicts.files[${fileIndex}]`);
      if (!Array.isArray(file.related_paths) || !Array.isArray(file.stages) || !Array.isArray(file.allowed_actions)) throw new Error(`Git conflicts.files[${fileIndex}] arrays are invalid`);
      return {
        path: text(file.path, `Git conflicts.files[${fileIndex}].path`),
        relatedPaths: file.related_paths.map((item, index) => text(item, `Git conflicts.files[${fileIndex}].related_paths[${index}]`)),
        kind: text(file.kind, `Git conflicts.files[${fileIndex}].kind`) as GitConflictKind,
        stages: file.stages.map((value, stageIndex) => {
          const stage = record(value, `Git conflicts.files[${fileIndex}].stages[${stageIndex}]`);
          return {
            stage: count(stage.stage, `Git conflict stage`) as 1 | 2 | 3,
            label: text(stage.label, `Git conflict label`) as "base" | "ours" | "theirs",
            objectId: text(stage.object_id, `Git conflict object`) as GitObjectId,
            mode: text(stage.mode, `Git conflict mode`),
            size: count(stage.size, `Git conflict size`),
            content: optionalText(stage.content, `Git conflict content`),
            binary: Boolean(stage.binary),
            encoding: text(stage.encoding, `Git conflict encoding`) as GitConflictStage["encoding"],
            eol: text(stage.eol, `Git conflict eol`) as GitConflictStage["eol"],
            tooLarge: Boolean(stage.too_large),
          };
        }),
        resultContent: optionalText(file.result_content, `Git conflict result_content`),
        resultBinary: Boolean(file.result_binary),
        resultEncoding: text(file.result_encoding, `Git conflict result_encoding`) as GitConflictFile["resultEncoding"],
        resultEol: text(file.result_eol, `Git conflict result_eol`) as GitConflictFile["resultEol"],
        resultTooLarge: Boolean(file.result_too_large),
        resultRevision: text(file.result_revision, `Git conflict result_revision`),
        allowedActions: file.allowed_actions.map((item, index) => text(item, `Git conflicts.files[${fileIndex}].allowed_actions[${index}]`)),
        editable: Boolean(file.editable),
      };
    }),
  };
}

export function normalizeGitBisect(value: unknown): GitBisectSnapshot {
  const raw = record(value, "Git bisect");
  for (const key of ["good_revisions", "skipped_revisions", "candidate_revisions"]) {
    if (!Array.isArray(raw[key])) throw new Error(`Git bisect.${key} must be an array`);
  }
  return {
    repositoryId: text(raw.repository_id, "Git bisect.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git bisect.repository_version") as GitRepositoryVersion,
    active: Boolean(raw.active),
    originalHead: optionalText(raw.original_head, "Git bisect.original_head"),
    currentRevision: optionalText(raw.current_revision, "Git bisect.current_revision") as GitObjectId | null,
    goodRevisions: (raw.good_revisions as unknown[]).map((item, index) => text(item, `Git bisect.good_revisions[${index}]`) as GitObjectId),
    badRevision: optionalText(raw.bad_revision, "Git bisect.bad_revision") as GitObjectId | null,
    skippedRevisions: (raw.skipped_revisions as unknown[]).map((item, index) => text(item, `Git bisect.skipped_revisions[${index}]`) as GitObjectId),
    candidateRevisions: (raw.candidate_revisions as unknown[]).map((item, index) => text(item, `Git bisect.candidate_revisions[${index}]`) as GitObjectId),
    remainingCount: count(raw.remaining_count, "Git bisect.remaining_count"),
    culpritRevision: optionalText(raw.culprit_revision, "Git bisect.culprit_revision") as GitObjectId | null,
  };
}

export function normalizeGitSubmodules(value: unknown): GitSubmodulesSnapshot {
  const raw = record(value, "Git submodules");
  if (!Array.isArray(raw.submodules)) throw new Error("Git submodules.submodules must be an array");
  const repositoryId = text(raw.repository_id, "Git submodules.repository_id") as GitRepositoryId;
  return {
    repositoryId,
    repositoryVersion: text(raw.repository_version, "Git submodules.repository_version") as GitRepositoryVersion,
    submodules: raw.submodules.map((value, index) => {
      const item = record(value, `Git submodules.submodules[${index}]`);
      const state = text(item.state, `Git submodules.submodules[${index}].state`) as GitSubmodule["state"];
      if (!new Set(["clean", "uninitialized", "different", "conflicted"]).has(state)) throw new Error("Git submodule state is invalid");
      return {
        path: text(item.path, `Git submodules.submodules[${index}].path`),
        objectId: text(item.object_id, `Git submodules.submodules[${index}].object_id`) as GitObjectId,
        state,
        description: typeof item.description === "string" ? item.description : "",
        name: optionalText(item.name, `Git submodules.submodules[${index}].name`),
        url: optionalText(item.url, `Git submodules.submodules[${index}].url`),
        parentRepositoryId: (optionalText(item.parent_repository_id, `Git submodules.submodules[${index}].parent_repository_id`) as GitRepositoryId | null) ?? repositoryId,
        childRootPath: optionalText(item.child_root_path, `Git submodules.submodules[${index}].child_root_path`),
        initialized: Boolean(item.initialized),
      };
    }),
  };
}

export function normalizeGitWorktrees(value: unknown): GitWorktreesSnapshot {
  const raw = record(value, "Git worktrees");
  if (!Array.isArray(raw.worktrees)) throw new Error("Git worktrees.worktrees must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git worktrees.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git worktrees.repository_version") as GitRepositoryVersion,
    worktrees: raw.worktrees.map((value, index) => {
      const item = record(value, `Git worktrees.worktrees[${index}]`);
      return {
        path: text(item.path, `Git worktrees.worktrees[${index}].path`),
        head: optionalText(item.head, `Git worktrees.worktrees[${index}].head`) as GitObjectId | null,
        branch: optionalText(item.branch, `Git worktrees.worktrees[${index}].branch`),
        bare: Boolean(item.bare),
        detached: Boolean(item.detached),
        lockedReason: optionalText(item.locked_reason, `Git worktrees.worktrees[${index}].locked_reason`),
        prunableReason: optionalText(item.prunable_reason, `Git worktrees.worktrees[${index}].prunable_reason`),
        primary: Boolean(item.primary),
        authorized: Boolean(item.authorized),
        authorizationRequired: Boolean(item.authorization_required),
        dirty: item.dirty === null || item.dirty === undefined ? null : Boolean(item.dirty),
      };
    }),
  };
}

export function normalizeGitLfs(value: unknown): GitLfsSnapshot {
  const raw = record(value, "Git LFS");
  if (!Array.isArray(raw.tracked_patterns) || !Array.isArray(raw.files) || !Array.isArray(raw.locks)) {
    throw new Error("Git LFS patterns, files, and locks must be arrays");
  }
  return {
    repositoryId: text(raw.repository_id, "Git LFS.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git LFS.repository_version") as GitRepositoryVersion,
    available: Boolean(raw.available),
    reason: optionalText(raw.reason, "Git LFS.reason"),
    trackedPatterns: raw.tracked_patterns.map((item, index) => text(item, `Git LFS.tracked_patterns[${index}]`)),
    files: raw.files.map((value, index) => {
      const item = record(value, `Git LFS.files[${index}]`);
      const status = text(item.status, `Git LFS.files[${index}].status`) as GitLfsFile["status"];
      if (!["tracked", "missing", "modified", "unknown"].includes(status)) throw new Error("Git LFS file status is invalid");
      return {
        path: text(item.path, `Git LFS.files[${index}].path`),
        objectId: text(item.object_id, `Git LFS.files[${index}].object_id`),
        size: item.size === null || item.size === undefined ? null : count(item.size, `Git LFS.files[${index}].size`),
        status,
      };
    }),
    locks: raw.locks.map((value, index) => {
      const item = record(value, `Git LFS.locks[${index}]`);
      return {
        id: text(item.id, `Git LFS.locks[${index}].id`),
        path: text(item.path, `Git LFS.locks[${index}].path`),
        owner: optionalText(item.owner, `Git LFS.locks[${index}].owner`),
        lockedAt: optionalText(item.locked_at, `Git LFS.locks[${index}].locked_at`),
      };
    }),
    locksAvailable: Boolean(raw.locks_available),
  };
}

export function normalizeGitDiff(value: unknown): GitDiffSnapshot {
  const raw = record(value, "Git diff");
  if (!Array.isArray(raw.files)) throw new Error("Git diff.files must be an array");
  return {
    repositoryId: text(raw.repository_id, "Git diff.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git diff.repository_version") as GitRepositoryVersion,
    files: raw.files.map((value, index) => normalizeGitFileDiff(value, `Git diff.files[${index}]`)),
  };
}

export function normalizeGitCommandResult(value: unknown): GitCommandResult {
  const raw = record(value, "Git command");
  const state = text(raw.state, "Git command.state") as GitCommandResult["state"];
  if (!["queued", "running", "succeeded", "failed", "cancelled"].includes(state)) {
    throw new Error("Git command.state is unknown");
  }
  const risk = typeof raw.risk === "string" ? raw.risk : "safe";
  if (!["safe", "write", "destructive", "history_rewrite", "remote_destructive"].includes(risk)) {
    throw new Error("Git command.risk is unknown");
  }
  const error = raw.error === null || raw.error === undefined ? null : record(raw.error, "Git command.error");
  return {
    operationId: text(raw.operation_id, "Git command.operation_id"),
    repositoryId: text(raw.repository_id, "Git command.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git command.repository_version") as GitRepositoryVersion,
    state,
    summary: text(raw.summary, "Git command.summary"),
    result: record(raw.result, "Git command.result"),
    command: typeof raw.command === "string" && raw.command.trim() ? raw.command : "unknown",
    risk: risk as GitCommandResult["risk"],
    createdAt: optionalText(raw.created_at, "Git command.created_at"),
    startedAt: optionalText(raw.started_at, "Git command.started_at"),
    finishedAt: optionalText(raw.finished_at, "Git command.finished_at"),
    durationMs: raw.duration_ms === null || raw.duration_ms === undefined
      ? null
      : count(raw.duration_ms, "Git command.duration_ms"),
    retryable: raw.retryable === true,
    error: error ? {
      code: typeof error.code === "string" && error.code ? error.code : "git_failed",
      message: text(error.message, "Git command.error.message"),
      retryable: error.retryable === true,
      details: error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : {},
    } : null,
  };
}

export function normalizeGitMetadataEvent(value: unknown): GitMetadataChangedEvent {
  const raw = record(value, "Git metadata event");
  if (!Array.isArray(raw.domains) || !Array.isArray(raw.paths)) {
    throw new Error("Git metadata event domains and paths must be arrays");
  }
  return {
    repositoryId: text(raw.repository_id, "Git metadata event.repository_id") as GitRepositoryId,
    repositoryVersion: text(raw.repository_version, "Git metadata event.repository_version") as GitRepositoryVersion,
    sequence: count(raw.sequence, "Git metadata event.sequence"),
    domains: raw.domains.map((value, index) => text(value, `Git metadata event.domains[${index}]`)),
    paths: raw.paths.map((value, index) => text(value, `Git metadata event.paths[${index}]`)),
    resyncRequired: Boolean(raw.resync_required),
  };
}

function normalizeGitRef(value: unknown, label: string): GitRef {
  const raw = record(value, label);
  const kind = text(raw.kind, `${label}.kind`) as GitRef["kind"];
  if (!["local", "remote", "tag"].includes(kind)) throw new Error(`${label}.kind is unknown`);
  return {
    fullName: text(raw.full_name, `${label}.full_name`),
    shortName: text(raw.short_name, `${label}.short_name`),
    kind,
    objectId: text(raw.object_id, `${label}.object_id`) as GitObjectId,
    peeledObjectId: optionalText(raw.peeled_object_id, `${label}.peeled_object_id`) as GitObjectId | null,
    upstream: optionalText(raw.upstream, `${label}.upstream`),
    ahead: raw.ahead === null || raw.ahead === undefined ? null : count(raw.ahead, `${label}.ahead`),
    behind: raw.behind === null || raw.behind === undefined ? null : count(raw.behind, `${label}.behind`),
    current: Boolean(raw.current),
    annotated: Boolean(raw.annotated),
    annotation: optionalText(raw.annotation, `${label}.annotation`),
    createdAt: optionalText(raw.created_at, `${label}.created_at`),
  };
}

function normalizeGitFileDiff(value: unknown, label: string): GitFileDiff {
  const raw = record(value, label);
  if (!Array.isArray(raw.hunks)) throw new Error(`${label}.hunks must be an array`);
  return {
    oldPath: optionalText(raw.old_path, `${label}.old_path`),
    newPath: optionalText(raw.new_path, `${label}.new_path`),
    status: fileStatus(raw.status, `${label}.status`) ?? "modified",
    binary: Boolean(raw.binary),
    oldMode: optionalText(raw.old_mode, `${label}.old_mode`),
    newMode: optionalText(raw.new_mode, `${label}.new_mode`),
    additions: raw.additions === null || raw.additions === undefined ? null : count(raw.additions, `${label}.additions`),
    deletions: raw.deletions === null || raw.deletions === undefined ? null : count(raw.deletions, `${label}.deletions`),
    hunks: raw.hunks.map((value, index) => {
      const hunk = record(value, `${label}.hunks[${index}]`);
      if (!Array.isArray(hunk.lines)) throw new Error(`${label}.hunks[${index}].lines must be an array`);
      return {
        header: typeof hunk.header === "string" ? hunk.header : "",
        oldStart: count(hunk.old_start, `${label}.hunks[${index}].old_start`),
        oldLines: count(hunk.old_lines, `${label}.hunks[${index}].old_lines`),
        newStart: count(hunk.new_start, `${label}.hunks[${index}].new_start`),
        newLines: count(hunk.new_lines, `${label}.hunks[${index}].new_lines`),
        lines: hunk.lines.map((value) => String(value)),
      };
    }),
    rawPatch: typeof raw.raw_patch === "string" ? raw.raw_patch : "",
    truncated: Boolean(raw.truncated),
  };
}

function normalizeGitInProgressOperation(value: unknown): GitInProgressOperation {
  const raw = record(value, "Git operation");
  return {
    kind: text(raw.kind, "Git operation.kind") as GitInProgressOperation["kind"],
    state: text(raw.state, "Git operation.state") as GitInProgressOperation["state"],
    currentStep: raw.current_step === null || raw.current_step === undefined ? null : count(raw.current_step, "Git operation.current_step"),
    totalSteps: raw.total_steps === null || raw.total_steps === undefined ? null : count(raw.total_steps, "Git operation.total_steps"),
    currentObjectId: optionalText(raw.current_object_id, "Git operation.current_object_id") as GitObjectId | null,
  };
}

export function normalizeGitRuntimeError(value: unknown): GitRuntimeError {
  const raw = record(value, "Git error");
  const details = raw.details === undefined ? {} : record(raw.details, "Git error.details");
  return {
    code: text(raw.code, "Git error.code"),
    message: text(raw.message, "Git error.message"),
    retryable: Boolean(raw.retryable),
    operationId: optionalText(raw.operation_id, "Git error.operation_id"),
    repositoryId: optionalText(raw.repository_id, "Git error.repository_id") as GitRepositoryId | null,
    details: Object.fromEntries(
      Object.entries(details).filter((entry): entry is [string, string | number | boolean | null] =>
        entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]),
      ),
    ),
  };
}
