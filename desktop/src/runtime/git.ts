import type { HttpClient } from "./httpClient";
import {
  normalizeGitCapability,
  normalizeGitBlame,
  normalizeGitBisect,
  normalizeGitCommandResult,
  normalizeGitCommitDetail,
  normalizeGitCompare,
  normalizeGitConflicts,
  normalizeGitDiff,
  normalizeGitDiscovery,
  normalizeGitHistory,
  normalizeGitLfs,
  normalizeGitMetadataEvent,
  normalizeGitMergePreview,
  normalizeGitRefs,
  normalizeGitReflog,
  normalizeGitRebasePreview,
  normalizeGitResetPreview,
  normalizeGitStatus,
  normalizeGitSubmodules,
  normalizeGitWorktrees,
  type GitCapabilitySet,
  type GitBlamePage,
  type GitBisectSnapshot,
  type GitCommandResult,
  type GitCommitDetail,
  type GitCompareMode,
  type GitCompareResult,
  type GitConflictsSnapshot,
  type GitConflictFile,
  type GitDiffSnapshot,
  type GitFileDiff,
  type GitDiscoverySnapshot,
  type GitHistoryPage,
  type GitLfsSnapshot,
  type GitMetadataChangedEvent,
  type GitMergePreview,
  type GitMergeStrategy,
  type GitRefsSnapshot,
  type GitReflogPage,
  type GitRebasePreview,
  type GitRebaseTodoItem,
  type GitResetMode,
  type GitResetPreview,
  type GitObjectId,
  type GitRepositoryId,
  type GitRepositoryVersion,
  type GitStatusSnapshot,
  type GitSubmodulesSnapshot,
  type GitWorktreesSnapshot,
} from "./gitTypes";

export interface GitProjectScope {
  workspaceId: string;
  projectRoot: string;
}

export interface GitRepositoryScope extends GitProjectScope {
  repositoryId: GitRepositoryId;
}

export interface GitAncestorGrantCommand extends GitProjectScope {
  repositoryId: GitRepositoryId;
  repositoryRoot: string;
}

export interface GitWorktreeGrantCommand extends GitRepositoryScope {
  worktreePath: string;
}

export interface GitWorktreeGrant extends GitProjectScope {
  parentRepositoryId: GitRepositoryId;
  worktreePath: string;
  scope: "git_worktree";
}

export interface GitCommandBase extends GitRepositoryScope {
  idempotencyKey: string;
  expectedRepositoryVersion?: string | null;
  confirmationToken?: string | null;
}

export interface GitMergeCommand extends GitCommandBase {
  source: string;
  strategy: GitMergeStrategy;
  message?: string | null;
}

export interface GitRebaseCommand extends GitCommandBase {
  upstream: string;
  onto?: string | null;
  interactive: boolean;
  todo: readonly GitRebaseTodoItem[];
}

export interface GitRebaseControlCommand extends GitCommandBase {
  action: "continue" | "skip" | "abort";
}

export interface GitCherryPickCommand extends GitCommandBase {
  commits: readonly string[];
  recordOrigin?: boolean;
}

export interface GitCherryPickControlCommand extends GitCommandBase {
  action: "continue" | "skip" | "abort";
}

export interface GitRevertCommand extends GitCommandBase {
  commits: readonly string[];
  mainline?: number | null;
}

export interface GitRevertControlCommand extends GitCommandBase {
  action: "continue" | "skip" | "abort";
}

export interface GitResetCommand extends GitCommandBase {
  target: string;
  mode: GitResetMode;
}

export interface GitRestoreCommand extends GitCommandBase {
  paths: readonly string[];
  source?: string | null;
  staged: boolean;
  worktree: boolean;
}

export interface GitPathsCommand extends GitCommandBase {
  paths: string[];
}

export interface GitPatchCommand extends GitCommandBase {
  patch: string;
  cached?: boolean;
  reverse?: boolean;
  checkOnly?: boolean;
  reject?: boolean;
}

export type GitPatchExportMode = "working_tree" | "index" | "commit" | "range";

export interface GitPatchExport {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  mode: GitPatchExportMode;
  left: string | null;
  right: string | null;
  paths: readonly string[];
  filename: string;
  patch: string;
}

export interface GitConflictResultSaveCommand extends GitRepositoryScope {
  path: string;
  content: string;
  encoding: "utf-8" | "utf-8-bom";
  eol: "lf" | "crlf";
  expectedResultRevision: string;
  expectedStages: readonly Pick<GitConflictFile["stages"][number], "stage" | "objectId">[];
}

export interface GitConflictResultSaveResult {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  path: string;
  resultRevision: string;
  bytesWritten: number;
  encoding: "utf-8" | "utf-8-bom";
  eol: "lf" | "crlf";
}

export type GitConflictFileAction =
  | "accept_ours"
  | "accept_theirs"
  | "keep_modified"
  | "accept_delete"
  | "delete"
  | "mark_resolved"
  | "reopen";

export interface GitConflictActionCommand extends GitCommandBase {
  action: GitConflictFileAction;
  path: string;
  expectedStages: readonly Pick<GitConflictFile["stages"][number], "stage" | "objectId" | "mode">[];
  resolvedIndexEntry?: string | null;
}

export interface GitBisectStartCommand extends GitCommandBase {
  goodRevision: string;
  badRevision: string;
}

export interface GitBisectControlCommand extends GitCommandBase {
  action: "good" | "bad" | "skip" | "reset";
}

export interface GitSubmoduleCommand extends GitCommandBase {
  action: "init" | "update" | "sync" | "deinit";
  paths: readonly string[];
  recursive: boolean;
  force: boolean;
}

export interface GitWorktreeCommand extends GitCommandBase {
  action: "add" | "remove" | "prune" | "lock" | "unlock";
  worktreePath: string | null;
  revision?: string;
  newBranch?: string | null;
  detach?: boolean;
  force?: boolean;
  lockReason?: string | null;
  dirtyConfirmed?: boolean;
}

export interface GitLfsCommand extends GitCommandBase {
  action: "fetch" | "pull" | "push";
  remote?: string | null;
  refspec?: string | null;
}

export interface GitIdentity {
  repositoryId: GitRepositoryId;
  name: string | null;
  email: string | null;
  signByDefault: boolean;
}

export interface GitIdentityUpdate extends GitRepositoryScope {
  name: string;
  email: string;
  signByDefault: boolean;
}

export interface GitCommitCommand extends GitCommandBase {
  message: string;
  amend?: boolean;
  sign?: boolean;
  paths: string[];
  untrackedPaths?: string[];
}

export interface GitBranchCommand extends GitCommandBase {
  branchName: string;
  startPoint?: string;
}

export interface GitBranchRenameCommand extends GitCommandBase {
  oldName: string;
  newName: string;
}

export interface GitBranchDeleteCommand extends GitCommandBase {
  branchName: string;
  force?: boolean;
  remote?: string | null;
}

export interface GitTagCreateCommand extends GitCommandBase {
  tagName: string;
  target?: string;
  annotated?: boolean;
  message?: string | null;
  sign?: boolean;
}

export interface GitTagDeleteCommand extends GitCommandBase {
  tagName: string;
  remote?: string | null;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
  trackingBranches: readonly string[];
}

export interface GitRemoteAddCommand extends GitCommandBase { remoteName: string; url: string }
export interface GitRemoteRenameCommand extends GitCommandBase { oldName: string; newName: string }
export interface GitRemoteSetUrlCommand extends GitCommandBase { remoteName: string; url: string; push?: boolean }
export interface GitRemoteRemoveCommand extends GitCommandBase { remoteName: string }
export interface GitUpstreamCommand extends GitCommandBase { branchName: string; upstream: string | null }

export interface GitCheckoutCommand extends GitCommandBase {
  ref: string;
  detach?: boolean;
}

export interface GitRemoteCommand extends GitCommandBase {
  remote?: string;
  refspec?: string | null;
  setUpstream?: boolean;
  prune?: boolean;
  tags?: boolean;
}

export interface GitFetchCommand extends GitCommandBase {
  remote?: string | null;
  allRemotes?: boolean;
  prune?: boolean;
  tags?: boolean;
}

export interface GitUpdateCommand extends GitCommandBase {
  remote: string;
  refspec: string;
  strategy?: "ff_only" | "merge" | "rebase";
}

export interface GitPushCommand extends GitCommandBase {
  remote: string;
  source: string;
  target: string;
  tagName?: string | null;
  setUpstream?: boolean;
  tags?: boolean;
  forceWithLease?: boolean;
}

export interface GitStashEntry {
  selector: string;
  objectId: GitObjectId;
  baseObjectId: GitObjectId | null;
  authorName: string;
  createdAt: string;
  message: string;
}

export interface GitStashPage {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  entries: readonly GitStashEntry[];
  nextCursor: string | null;
}

export interface GitStashDetail {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion;
  entry: GitStashEntry;
  files: readonly GitFileDiff[];
}

export interface GitStashPushCommand extends GitCommandBase {
  message?: string | null;
  staged?: boolean;
  includeUntracked?: boolean;
}

export interface GitStashEntryCommand extends GitCommandBase {
  selector: string;
  objectId: GitObjectId;
  reinstateIndex?: boolean;
}

export interface GitStashBranchCommand extends GitStashEntryCommand {
  branchName: string;
}

export interface GitQueryOptions {
  signal?: AbortSignal;
}

export interface GitHistoryFilters {
  search: string;
  revision: string;
  author: string;
  since: string;
  until: string;
  path: string;
  firstParent: boolean;
  mergesOnly: boolean;
}

export interface GitHistoryQueryOptions extends GitQueryOptions, Partial<GitHistoryFilters> {
  cursor?: string | null;
  limit?: number;
}

export type GitMetadataListener = (event: GitMetadataChangedEvent) => void;

export interface GitRuntime {
  capabilities(options?: GitQueryOptions): Promise<GitCapabilitySet>;
  discover(scope: GitProjectScope, options?: GitQueryOptions): Promise<GitDiscoverySnapshot>;
  initialize(scope: GitProjectScope, options?: GitQueryOptions): Promise<GitDiscoverySnapshot>;
  authorizeAncestor(command: GitAncestorGrantCommand, options?: GitQueryOptions): Promise<void>;
  revokeAncestor(scope: GitProjectScope, options?: GitQueryOptions): Promise<boolean>;
  authorizeWorktree(command: GitWorktreeGrantCommand, options?: GitQueryOptions): Promise<GitWorktreeGrant>;
  revokeWorktree(command: GitWorktreeGrantCommand, options?: GitQueryOptions): Promise<boolean>;
  status(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitStatusSnapshot>;
  refs(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitRefsSnapshot>;
  remotes(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<readonly GitRemoteInfo[]>;
  stashList(scope: GitRepositoryScope, options?: GitQueryOptions & { cursor?: string | null; limit?: number }): Promise<GitStashPage>;
  stashDetail(scope: GitRepositoryScope, selector: string, objectId: GitObjectId, options?: GitQueryOptions): Promise<GitStashDetail>;
  history(
    scope: GitRepositoryScope,
    options?: GitHistoryQueryOptions,
  ): Promise<GitHistoryPage>;
  commit(
    scope: GitRepositoryScope,
    revision: string,
    options?: GitQueryOptions & { parentId?: GitObjectId | null },
  ): Promise<GitCommitDetail>;
  compare(
    scope: GitRepositoryScope,
    options: GitQueryOptions & { mode: GitCompareMode; left: string; right?: string | null },
  ): Promise<GitCompareResult>;
  blame(
    scope: GitRepositoryScope,
    options: GitQueryOptions & {
      path: string;
      revision?: string | null;
      startLine?: number;
      lineCount?: number;
      ignoreRevsFile?: string | null;
    },
  ): Promise<GitBlamePage>;
  reflog(
    scope: GitRepositoryScope,
    options?: GitQueryOptions & { ref?: string | null; cursor?: string | null; limit?: number },
  ): Promise<GitReflogPage>;
  mergePreview(
    scope: GitRepositoryScope,
    source: string,
    options?: GitQueryOptions,
  ): Promise<GitMergePreview>;
  rebasePreview(
    scope: GitRepositoryScope,
    upstream: string,
    onto?: string | null,
    options?: GitQueryOptions,
  ): Promise<GitRebasePreview>;
  resetPreview(
    scope: GitRepositoryScope,
    target: string,
    mode: GitResetMode,
    options?: GitQueryOptions,
  ): Promise<GitResetPreview>;
  conflicts(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitConflictsSnapshot>;
  bisect(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitBisectSnapshot>;
  submodules(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitSubmodulesSnapshot>;
  worktrees(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitWorktreesSnapshot>;
  lfs(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitLfsSnapshot>;
  saveConflictResult(
    command: GitConflictResultSaveCommand,
    options?: GitQueryOptions,
  ): Promise<GitConflictResultSaveResult>;
  conflictAction(
    command: GitConflictActionCommand,
    options?: GitQueryOptions,
  ): Promise<GitCommandResult>;
  startBisect(command: GitBisectStartCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  controlBisect(command: GitBisectControlCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  submoduleAction(command: GitSubmoduleCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  worktreeAction(command: GitWorktreeCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  lfsAction(command: GitLfsCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  exportPatch(
    scope: GitRepositoryScope,
    mode: GitPatchExportMode,
    options?: GitQueryOptions & { left?: string | null; right?: string | null; paths?: readonly string[] },
  ): Promise<GitPatchExport>;
  diff(scope: GitRepositoryScope, options?: GitQueryOptions & { cached?: boolean }): Promise<GitDiffSnapshot>;
  identity(scope: GitRepositoryScope, options?: GitQueryOptions): Promise<GitIdentity>;
  updateIdentity(command: GitIdentityUpdate, options?: GitQueryOptions): Promise<GitIdentity>;
  stage(command: GitPathsCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  unstage(command: GitPathsCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  applyPatch(command: GitPatchCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  discard(command: GitPathsCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  clean(command: GitPathsCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  ignore(command: GitPathsCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  createCommit(command: GitCommitCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  createBranch(command: GitBranchCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  renameBranch(command: GitBranchRenameCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  deleteBranch(command: GitBranchDeleteCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  createTag(command: GitTagCreateCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  deleteTag(command: GitTagDeleteCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  addRemote(command: GitRemoteAddCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  renameRemote(command: GitRemoteRenameCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  setRemoteUrl(command: GitRemoteSetUrlCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  removeRemote(command: GitRemoteRemoveCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  setUpstream(command: GitUpstreamCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  checkout(command: GitCheckoutCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  fetch(command: GitFetchCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  update(command: GitUpdateCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  push(command: GitPushCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  createStash(command: GitStashPushCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  applyStash(command: GitStashEntryCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  popStash(command: GitStashEntryCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  branchFromStash(command: GitStashBranchCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  dropStash(command: GitStashEntryCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  clearStashes(command: GitCommandBase, options?: GitQueryOptions): Promise<GitCommandResult>;
  merge(command: GitMergeCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  abortMerge(command: GitCommandBase, options?: GitQueryOptions): Promise<GitCommandResult>;
  rebase(command: GitRebaseCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  controlRebase(command: GitRebaseControlCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  cherryPick(command: GitCherryPickCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  controlCherryPick(command: GitCherryPickControlCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  revert(command: GitRevertCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  controlRevert(command: GitRevertControlCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  reset(command: GitResetCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  restore(command: GitRestoreCommand, options?: GitQueryOptions): Promise<GitCommandResult>;
  confirmation(command: string, payload: GitCommandBase, options?: GitQueryOptions): Promise<{ token: string; expiresAt: string; risk: string }>;
  operation(operationId: string, options?: GitQueryOptions): Promise<GitCommandResult>;
  cancel(operationId: string, options?: GitQueryOptions): Promise<GitCommandResult>;
  subscribe(listener: GitMetadataListener): () => void;
  acceptEvent(action: string, data: unknown): boolean;
}

export function createGitRuntime(http: HttpClient): GitRuntime {
  const listeners = new Set<GitMetadataListener>();
  const query = (scope: GitRepositoryScope) => {
    const params = new URLSearchParams({ workspace_id: scope.workspaceId, project_root: scope.projectRoot });
    return params;
  };
  const repositoryPath = (scope: GitRepositoryScope, suffix: string) =>
    `/api/git/repositories/${encodeURIComponent(scope.repositoryId)}${suffix}`;
  const requestCommand = async (
    suffix: string,
    command: GitCommandBase,
    options: GitQueryOptions = {},
  ) => normalizeGitCommandResult(await http.request(repositoryPath(command, suffix), {
    method: "POST",
    body: commandPayload(command),
    signal: options.signal,
  }));

  return {
    async capabilities(options = {}) {
      return normalizeGitCapability(await http.request("/api/git/capabilities", { signal: options.signal }));
    },
    async discover(scope, options = {}) {
      return normalizeGitDiscovery(await http.request("/api/git/repositories/discover", {
        method: "POST",
        body: { workspace_id: scope.workspaceId, project_root: scope.projectRoot },
        signal: options.signal,
      }));
    },
    async initialize(scope, options = {}) {
      return normalizeGitDiscovery(await http.request("/api/git/repositories/init", {
        method: "POST",
        body: { workspace_id: scope.workspaceId, project_root: scope.projectRoot },
        signal: options.signal,
      }));
    },
    async authorizeAncestor(command, options = {}) {
      await http.request("/api/git/repositories/ancestor-grants", {
        method: "POST",
        body: {
          workspace_id: command.workspaceId,
          project_root: command.projectRoot,
          repository_id: command.repositoryId,
          repository_root: command.repositoryRoot,
        },
        signal: options.signal,
      });
    },
    async revokeAncestor(scope, options = {}) {
      const params = new URLSearchParams({ workspace_id: scope.workspaceId, project_root: scope.projectRoot });
      const result = await http.request<Record<string, unknown>>(`/api/git/repositories/ancestor-grants?${params}`, {
        method: "DELETE",
        signal: options.signal,
      });
      return result.revoked === true;
    },
    async authorizeWorktree(command, options = {}) {
      const raw = await http.request<Record<string, unknown>>("/api/git/repositories/worktree-grants", {
        method: "POST",
        body: {
          workspace_id: command.workspaceId,
          project_root: command.projectRoot,
          repository_id: command.repositoryId,
          worktree_path: command.worktreePath,
        },
        signal: options.signal,
      });
      return {
        workspaceId: String(raw.workspace_id ?? ""),
        projectRoot: String(raw.project_root ?? ""),
        parentRepositoryId: String(raw.parent_repository_id ?? "") as GitRepositoryId,
        worktreePath: String(raw.worktree_path ?? ""),
        scope: "git_worktree",
      };
    },
    async revokeWorktree(command, options = {}) {
      const raw = await http.request<Record<string, unknown>>("/api/git/repositories/worktree-grants/revoke", {
        method: "POST",
        body: {
          workspace_id: command.workspaceId,
          project_root: command.projectRoot,
          repository_id: command.repositoryId,
          worktree_path: command.worktreePath,
        },
        signal: options.signal,
      });
      return raw.revoked === true;
    },
    async status(scope, options = {}) {
      return normalizeGitStatus(await http.request(`${repositoryPath(scope, "/status")}?${query(scope)}`, { signal: options.signal }));
    },
    async refs(scope, options = {}) {
      return normalizeGitRefs(await http.request(`${repositoryPath(scope, "/refs")}?${query(scope)}`, { signal: options.signal }));
    },
    async remotes(scope, options = {}) {
      const raw = await http.request<Record<string, unknown>>(
        `${repositoryPath(scope, "/remotes")}?${query(scope)}`,
        { signal: options.signal },
      );
      const values = Array.isArray(raw.remotes) ? raw.remotes : [];
      return values.map((value) => normalizeGitRemoteInfo(value));
    },
    async stashList(scope, options = {}) {
      const params = query(scope);
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      return normalizeGitStashPage(await http.request(`${repositoryPath(scope, "/stash")}?${params}`, { signal: options.signal }));
    },
    async stashDetail(scope, selector, objectId, options = {}) {
      const params = query(scope);
      params.set("selector", selector);
      params.set("object_id", objectId);
      return normalizeGitStashDetail(await http.request(`${repositoryPath(scope, "/stash-detail")}?${params}`, { signal: options.signal }));
    },
    async history(scope, options = {}) {
      const params = query(scope);
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      const search = options.search?.trim();
      if (search) {
        if (/^[0-9a-f]{4,64}$/i.test(search)) params.set("hash_prefix", search);
        else params.set("query", search);
      }
      if (options.revision?.trim()) params.set("revision", options.revision.trim());
      if (options.author?.trim()) params.set("author", options.author.trim());
      if (options.since?.trim()) params.set("since", options.since.trim());
      if (options.until?.trim()) params.set("until", options.until.trim());
      if (options.path?.trim()) params.set("path", options.path.trim());
      if (options.firstParent) params.set("first_parent", "true");
      if (options.mergesOnly) params.set("merges_only", "true");
      return normalizeGitHistory(await http.request(`${repositoryPath(scope, "/history")}?${params}`, { signal: options.signal }));
    },
    async commit(scope, revision, options = {}) {
      const params = query(scope);
      if (options.parentId) params.set("parent", options.parentId);
      return normalizeGitCommitDetail(await http.request(
        `${repositoryPath(scope, `/commits/${encodeURIComponent(revision)}`)}?${params}`,
        { signal: options.signal },
      ));
    },
    async compare(scope, options) {
      const params = query(scope);
      params.set("mode", options.mode);
      params.set("left", options.left);
      if (options.right) params.set("right", options.right);
      return normalizeGitCompare(await http.request(
        `${repositoryPath(scope, "/compare")}?${params}`,
        { signal: options.signal },
      ));
    },
    async blame(scope, options) {
      const params = query(scope);
      params.set("path", options.path);
      if (options.revision) params.set("revision", options.revision);
      if (options.startLine) params.set("start_line", String(options.startLine));
      if (options.lineCount) params.set("line_count", String(options.lineCount));
      if (options.ignoreRevsFile) params.set("ignore_revs_file", options.ignoreRevsFile);
      return normalizeGitBlame(await http.request(
        `${repositoryPath(scope, "/blame")}?${params}`,
        { signal: options.signal },
      ));
    },
    async reflog(scope, options = {}) {
      const params = query(scope);
      if (options.ref) params.set("ref", options.ref);
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      return normalizeGitReflog(await http.request(
        `${repositoryPath(scope, "/reflog")}?${params}`,
        { signal: options.signal },
      ));
    },
    async mergePreview(scope, source, options = {}) {
      const params = query(scope);
      params.set("source", source);
      return normalizeGitMergePreview(await http.request(
        `${repositoryPath(scope, "/merge-preview")}?${params}`,
        { signal: options.signal },
      ));
    },
    async rebasePreview(scope, upstream, onto = null, options = {}) {
      const params = query(scope);
      params.set("upstream", upstream);
      if (onto) params.set("onto", onto);
      return normalizeGitRebasePreview(await http.request(
        `${repositoryPath(scope, "/rebase-preview")}?${params}`,
        { signal: options.signal },
      ));
    },
    async resetPreview(scope, target, mode, options = {}) {
      const params = query(scope);
      params.set("target", target);
      params.set("mode", mode);
      return normalizeGitResetPreview(await http.request(
        `${repositoryPath(scope, "/reset-preview")}?${params}`,
        { signal: options.signal },
      ));
    },
    async conflicts(scope, options = {}) {
      return normalizeGitConflicts(await http.request(
        `${repositoryPath(scope, "/conflicts")}?${query(scope)}`,
        { signal: options.signal },
      ));
    },
    async bisect(scope, options = {}) {
      return normalizeGitBisect(await http.request(
        `${repositoryPath(scope, "/bisect")}?${query(scope)}`,
        { signal: options.signal },
      ));
    },
    async submodules(scope, options = {}) {
      return normalizeGitSubmodules(await http.request(
        `${repositoryPath(scope, "/submodules")}?${query(scope)}`,
        { signal: options.signal },
      ));
    },
    async worktrees(scope, options = {}) {
      return normalizeGitWorktrees(await http.request(
        `${repositoryPath(scope, "/worktrees")}?${query(scope)}`,
        { signal: options.signal },
      ));
    },
    async lfs(scope, options = {}) {
      return normalizeGitLfs(await http.request(
        `${repositoryPath(scope, "/lfs")}?${query(scope)}`,
        { signal: options.signal },
      ));
    },
    async saveConflictResult(command, options = {}) {
      const raw = await http.request<Record<string, unknown>>(
        repositoryPath(command, "/conflicts/result"),
        {
          method: "POST",
          body: {
            workspace_id: command.workspaceId,
            project_root: command.projectRoot,
            repository_id: command.repositoryId,
            path: command.path,
            content: command.content,
            encoding: command.encoding,
            eol: command.eol,
            expected_result_revision: command.expectedResultRevision,
            expected_stages: command.expectedStages.map((stage) => ({
              stage: stage.stage,
              object_id: stage.objectId,
            })),
          },
          signal: options.signal,
        },
      );
      return normalizeGitConflictResultSave(raw);
    },
    async exportPatch(scope, mode, options = {}) {
      const params = query(scope);
      params.set("mode", mode);
      if (options.left) params.set("left", options.left);
      if (options.right) params.set("right", options.right);
      for (const path of options.paths ?? []) params.append("paths", path);
      return normalizeGitPatchExport(await http.request(
        `${repositoryPath(scope, "/patch-export")}?${params}`,
        { signal: options.signal },
      ));
    },
    async diff(scope, options = {}) {
      const params = query(scope);
      if (options.cached) params.set("cached", "true");
      return normalizeGitDiff(await http.request(`${repositoryPath(scope, "/diff")}?${params}`, { signal: options.signal }));
    },
    async identity(scope, options = {}) {
      const raw = await http.request<Record<string, unknown>>(
        `${repositoryPath(scope, "/identity")}?${query(scope)}`,
        { signal: options.signal },
      );
      return normalizeGitIdentity(raw);
    },
    async updateIdentity(command, options = {}) {
      const raw = await http.request<Record<string, unknown>>(repositoryPath(command, "/identity"), {
        method: "PUT",
        body: {
          workspace_id: command.workspaceId,
          project_root: command.projectRoot,
          repository_id: command.repositoryId,
          name: command.name,
          email: command.email,
          sign_by_default: command.signByDefault,
        },
        signal: options.signal,
      });
      return normalizeGitIdentity(raw);
    },
    stage: (command, options) => requestCommand("/stage", command, options),
    unstage: (command, options) => requestCommand("/unstage", command, options),
    applyPatch: (command, options) => requestCommand("/patch", command, options),
    discard: (command, options) => requestCommand("/discard", command, options),
    clean: (command, options) => requestCommand("/clean", command, options),
    ignore: (command, options) => requestCommand("/ignore", command, options),
    createCommit: (command, options) => requestCommand("/commit", command, options),
    createBranch: (command, options) => requestCommand("/branches", command, options),
    renameBranch: (command, options) => requestCommand("/branches/rename", command, options),
    deleteBranch: (command, options) => requestCommand("/branches/delete", command, options),
    createTag: (command, options) => requestCommand("/tags", command, options),
    deleteTag: (command, options) => requestCommand("/tags/delete", command, options),
    addRemote: (command, options) => requestCommand("/remotes", command, options),
    renameRemote: (command, options) => requestCommand("/remotes/rename", command, options),
    setRemoteUrl: (command, options) => requestCommand("/remotes/url", command, options),
    removeRemote: (command, options) => requestCommand("/remotes/remove", command, options),
    setUpstream: (command, options) => requestCommand("/upstream", command, options),
    checkout: (command, options) => requestCommand("/checkout", command, options),
    fetch: (command, options) => requestCommand("/fetch", command, options),
    update: (command, options) => requestCommand("/update", command, options),
    push: (command, options) => requestCommand("/push", command, options),
    createStash: (command, options) => requestCommand("/stash", command, options),
    applyStash: (command, options) => requestCommand("/stash/apply", command, options),
    popStash: (command, options) => requestCommand("/stash/pop", command, options),
    branchFromStash: (command, options) => requestCommand("/stash/branch", command, options),
    dropStash: (command, options) => requestCommand("/stash/drop", command, options),
    clearStashes: (command, options) => requestCommand("/stash/clear", command, options),
    merge: (command, options) => requestCommand("/merge", command, options),
    abortMerge: (command, options) => requestCommand("/merge/abort", command, options),
    rebase: (command, options) => requestCommand("/rebase", command, options),
    controlRebase: (command, options) => requestCommand("/rebase/control", command, options),
    cherryPick: (command, options) => requestCommand("/cherry-pick", command, options),
    controlCherryPick: (command, options) => requestCommand("/cherry-pick/control", command, options),
    revert: (command, options) => requestCommand("/revert", command, options),
    controlRevert: (command, options) => requestCommand("/revert/control", command, options),
    reset: (command, options) => requestCommand("/reset", command, options),
    restore: (command, options) => requestCommand("/restore", command, options),
    conflictAction: (command, options) => requestCommand("/conflicts/action", command, options),
    startBisect: (command, options) => requestCommand("/bisect/start", command, options),
    controlBisect: (command, options) => requestCommand("/bisect/control", command, options),
    submoduleAction: (command, options) => requestCommand("/submodules/action", command, options),
    worktreeAction: (command, options) => requestCommand("/worktrees/action", command, options),
    lfsAction: (command, options) => requestCommand("/lfs/action", command, options),
    async confirmation(command, payload, options = {}) {
      const raw = await http.request<Record<string, unknown>>("/api/git/confirmations", {
        method: "POST",
        body: { command, payload: commandPayload(payload) },
        signal: options.signal,
      });
      return {
        token: String(raw.token ?? ""),
        expiresAt: String(raw.expires_at ?? ""),
        risk: String(raw.risk ?? ""),
      };
    },
    async operation(operationId, options = {}) {
      return normalizeGitCommandResult(await http.request(`/api/git/operations/${encodeURIComponent(operationId)}`, { signal: options.signal }));
    },
    async cancel(operationId, options = {}) {
      return normalizeGitCommandResult(await http.request(`/api/git/operations/${encodeURIComponent(operationId)}`, {
        method: "DELETE",
        signal: options.signal,
      }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acceptEvent(action, data) {
      if (action !== "gitMetadataChanged") return false;
      const event = normalizeGitMetadataEvent(data);
      listeners.forEach((listener) => listener(event));
      return true;
    },
  };
}

function normalizeGitIdentity(raw: Record<string, unknown>): GitIdentity {
  return {
    repositoryId: String(raw.repository_id ?? "") as GitRepositoryId,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : null,
    email: typeof raw.email === "string" && raw.email.trim() ? raw.email : null,
    signByDefault: raw.sign_by_default === true,
  };
}

function normalizeGitConflictResultSave(
  raw: Record<string, unknown>,
): GitConflictResultSaveResult {
  const encoding = String(raw.encoding ?? "");
  const eol = String(raw.eol ?? "");
  if (encoding !== "utf-8" && encoding !== "utf-8-bom") {
    throw new Error("Git conflict result encoding is invalid");
  }
  if (eol !== "lf" && eol !== "crlf") {
    throw new Error("Git conflict result EOL is invalid");
  }
  return {
    repositoryId: String(raw.repository_id ?? "") as GitRepositoryId,
    repositoryVersion: String(raw.repository_version ?? "") as GitRepositoryVersion,
    path: String(raw.path ?? ""),
    resultRevision: String(raw.result_revision ?? ""),
    bytesWritten: Number(raw.bytes_written ?? 0),
    encoding,
    eol,
  };
}

function normalizeGitRemoteInfo(value: unknown): GitRemoteInfo {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    name: String(raw.name ?? ""),
    fetchUrl: typeof raw.fetch_url === "string" ? raw.fetch_url : null,
    pushUrl: typeof raw.push_url === "string" ? raw.push_url : null,
    trackingBranches: Array.isArray(raw.tracking_branches) ? raw.tracking_branches.map(String) : [],
  };
}

function normalizeGitStashEntry(value: unknown): GitStashEntry {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    selector: String(raw.selector ?? ""),
    objectId: String(raw.object_id ?? "") as GitObjectId,
    baseObjectId: typeof raw.base_object_id === "string" ? raw.base_object_id as GitObjectId : null,
    authorName: String(raw.author_name ?? ""),
    createdAt: String(raw.created_at ?? ""),
    message: String(raw.message ?? ""),
  };
}

function normalizeGitStashPage(value: unknown): GitStashPage {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    repositoryId: String(raw.repository_id ?? "") as GitRepositoryId,
    repositoryVersion: String(raw.repository_version ?? "") as GitRepositoryVersion,
    entries: Array.isArray(raw.entries) ? raw.entries.map(normalizeGitStashEntry) : [],
    nextCursor: typeof raw.next_cursor === "string" ? raw.next_cursor : null,
  };
}

function normalizeGitStashDetail(value: unknown): GitStashDetail {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const diff = normalizeGitDiff({
    repository_id: raw.repository_id,
    repository_version: raw.repository_version,
    files: raw.files,
  });
  return {
    repositoryId: diff.repositoryId,
    repositoryVersion: diff.repositoryVersion,
    entry: normalizeGitStashEntry(raw.entry),
    files: diff.files,
  };
}

function commandPayload(command: GitCommandBase): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    workspace_id: command.workspaceId,
    project_root: command.projectRoot,
    repository_id: command.repositoryId,
    idempotency_key: command.idempotencyKey,
    expected_repository_version: command.expectedRepositoryVersion ?? null,
    confirmation_token: command.confirmationToken ?? null,
  };
  if ("paths" in command) payload.paths = command.paths;
  if ("patch" in command) {
    const patch = command as GitPatchCommand;
    payload.patch = patch.patch;
    payload.cached = patch.cached ?? true;
    payload.reverse = patch.reverse ?? false;
    payload.check_only = patch.checkOnly ?? false;
    payload.reject = patch.reject ?? false;
  }
  if (
    "message" in command
    && !("staged" in command)
    && !("includeUntracked" in command)
    && !("source" in command)
    && !("tagName" in command)
  ) {
    const commit = command as GitCommitCommand;
    payload.message = commit.message;
    payload.amend = commit.amend ?? false;
    payload.sign = commit.sign ?? false;
    payload.untracked_paths = commit.untrackedPaths ?? [];
  }
  if ("branchName" in command) {
    const branch = command as GitBranchCommand & GitBranchDeleteCommand & GitUpstreamCommand;
    payload.branch_name = branch.branchName;
    if ("startPoint" in branch) payload.start_point = branch.startPoint ?? "HEAD";
    if ("upstream" in branch) payload.upstream = branch.upstream;
    if ("force" in branch || "remote" in branch) {
      payload.force = branch.force ?? false;
      payload.remote = branch.remote ?? null;
    }
  }
  if ("oldName" in command) {
    const rename = command as GitBranchRenameCommand;
    payload.old_name = rename.oldName;
    payload.new_name = rename.newName;
  }
  if ("tagName" in command) {
    const tag = command as GitTagCreateCommand & GitTagDeleteCommand;
    payload.tag_name = tag.tagName;
    if (!("source" in command) && ("target" in tag || "annotated" in tag || "message" in tag || "sign" in tag)) {
      payload.target = tag.target ?? "HEAD";
      payload.annotated = tag.annotated ?? false;
      payload.message = tag.message ?? null;
      payload.sign = tag.sign ?? false;
    }
    if ("remote" in tag) payload.remote = tag.remote ?? null;
  }
  if ("remoteName" in command) {
    const remote = command as GitRemoteAddCommand & GitRemoteSetUrlCommand & GitRemoteRemoveCommand;
    payload.remote_name = remote.remoteName;
    if ("url" in remote) payload.url = remote.url;
    if ("push" in remote) payload.push = remote.push ?? false;
  }
  if ("oldName" in command && !("branchName" in command)) {
    const rename = command as GitRemoteRenameCommand;
    payload.old_name = rename.oldName;
    payload.new_name = rename.newName;
  }
  if ("ref" in command) {
    const checkout = command as GitCheckoutCommand;
    payload.ref = checkout.ref;
    payload.detach = checkout.detach ?? false;
  }
  if (
    !("branchName" in command)
    && !("tagName" in command)
    && ["remote", "refspec", "setUpstream", "prune", "tags", "allRemotes", "strategy"].some((key) => key in command)
  ) {
    const remote = command as GitRemoteCommand & GitFetchCommand & GitUpdateCommand;
    payload.remote = remote.allRemotes ? null : remote.remote ?? "origin";
    if ("refspec" in remote || "setUpstream" in remote) {
      payload.refspec = remote.refspec ?? null;
      if ("setUpstream" in remote) payload.set_upstream = remote.setUpstream ?? false;
    }
    if ("prune" in remote) payload.prune = remote.prune ?? false;
    if ("tags" in remote) payload.tags = remote.tags ?? false;
    if ("allRemotes" in remote) payload.all_remotes = remote.allRemotes ?? false;
    if ("strategy" in remote) payload.strategy = remote.strategy ?? "ff_only";
  }
  if ("source" in command && "target" in command) {
    const push = command as GitPushCommand;
    payload.remote = push.remote;
    payload.source = push.source;
    payload.target = push.target;
    payload.tag_name = push.tagName ?? null;
    payload.set_upstream = push.setUpstream ?? false;
    payload.tags = push.tags ?? false;
    payload.force_with_lease = push.forceWithLease ?? false;
    delete payload.refspec;
    delete payload.prune;
    delete payload.all_remotes;
  }
  if ("source" in command && "strategy" in command && !("target" in command)) {
    const merge = command as GitMergeCommand;
    payload.source = merge.source;
    payload.strategy = merge.strategy;
    payload.message = merge.message ?? null;
    delete payload.remote;
    delete payload.refspec;
    delete payload.prune;
    delete payload.tags;
    delete payload.all_remotes;
  }
  if ("upstream" in command && "interactive" in command) {
    const rebase = command as GitRebaseCommand;
    payload.upstream = rebase.upstream;
    payload.onto = rebase.onto ?? null;
    payload.interactive = rebase.interactive;
    payload.todo = rebase.todo.map((item) => ({
      action: item.action,
      object_id: item.objectId,
      subject: item.subject,
      message: item.message ?? null,
    }));
  }
  if ("commits" in command) {
    const sequence = command as GitCherryPickCommand & GitRevertCommand;
    payload.commits = [...sequence.commits];
    if ("recordOrigin" in sequence) payload.record_origin = sequence.recordOrigin ?? false;
    if ("mainline" in sequence) payload.mainline = sequence.mainline ?? null;
  }
  if ("target" in command && !("source" in command)) {
    const reset = command as GitResetCommand;
    payload.target = reset.target;
    payload.mode = reset.mode;
  }
  if ("paths" in command && ("staged" in command || "worktree" in command)) {
    const restore = command as GitRestoreCommand;
    payload.source = restore.source ?? null;
    payload.staged = restore.staged;
    payload.worktree = restore.worktree;
  }
  if ("action" in command) {
    payload.action = (command as GitRebaseControlCommand | GitCherryPickControlCommand | GitRevertControlCommand).action;
  }
  if ("expectedStages" in command && "path" in command) {
    const conflict = command as GitConflictActionCommand;
    payload.path = conflict.path;
    payload.expected_stages = conflict.expectedStages.map((stage) => ({
      stage: stage.stage,
      object_id: stage.objectId,
      mode: stage.mode,
    }));
    payload.resolved_index_entry = conflict.resolvedIndexEntry ?? null;
  }
  if ("goodRevision" in command && "badRevision" in command) {
    const bisect = command as GitBisectStartCommand;
    payload.good_revision = bisect.goodRevision;
    payload.bad_revision = bisect.badRevision;
  }
  if ("recursive" in command && "force" in command && "paths" in command) {
    const submodule = command as GitSubmoduleCommand;
    payload.recursive = submodule.recursive;
    payload.force = submodule.force;
  }
  if ("worktreePath" in command) {
    const worktree = command as GitWorktreeCommand;
    payload.worktree_path = worktree.worktreePath;
    payload.revision = worktree.revision ?? "HEAD";
    payload.new_branch = worktree.newBranch ?? null;
    payload.detach = worktree.detach ?? false;
    payload.force = worktree.force ?? false;
    payload.lock_reason = worktree.lockReason ?? null;
    payload.dirty_confirmed = worktree.dirtyConfirmed ?? false;
  }
  if ("selector" in command && "objectId" in command) {
    const stash = command as GitStashEntryCommand & GitStashBranchCommand;
    payload.selector = stash.selector;
    payload.object_id = stash.objectId;
    payload.reinstate_index = stash.reinstateIndex ?? false;
    if ("branchName" in stash) payload.branch_name = stash.branchName;
  }
  if ("includeUntracked" in command || ("staged" in command && !("worktree" in command))) {
    const stash = command as GitStashPushCommand;
    payload.message = stash.message ?? null;
    payload.staged = stash.staged ?? false;
    payload.include_untracked = stash.includeUntracked ?? false;
  }
  return payload;
}

function normalizeGitPatchExport(value: unknown): GitPatchExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git patch export must be an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.paths)) throw new Error("Git patch export.paths must be an array");
  const mode = String(raw.mode ?? "");
  if (mode !== "working_tree" && mode !== "index" && mode !== "commit" && mode !== "range") throw new Error("Git patch export.mode is invalid");
  return {
    repositoryId: String(raw.repository_id ?? "") as GitRepositoryId,
    repositoryVersion: String(raw.repository_version ?? "") as GitRepositoryVersion,
    mode,
    left: typeof raw.left === "string" ? raw.left : null,
    right: typeof raw.right === "string" ? raw.right : null,
    paths: raw.paths.map(String),
    filename: String(raw.filename ?? "changes.patch"),
    patch: String(raw.patch ?? ""),
  };
}
