import type {
  GitCommandResult,
  GitMetadataChangedEvent,
  GitRepositoryId,
} from "@/runtime/gitTypes";
import type { GitProjectScope, GitRepositoryScope, GitRuntime } from "@/runtime/git";

import type { GitStore } from "./gitStore";

type RefreshDomain = "status" | "refs" | "history" | "diff";

const QUERY_DOMAINS = new Set<RefreshDomain>(["status", "refs", "history", "diff"]);
const RETRYABLE_COMMANDS = new Set(["fetch", "update", "push"]);

export interface GitStoreControllerOptions {
  debounceMs?: number;
  operationPollMs?: number;
}

export interface GitWorktreePathChange {
  repositoryId: GitRepositoryId;
  path: string;
}

export class GitStoreController {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly repositoryRefreshes = new Map<GitRepositoryId, Promise<void>>();
  private readonly requestedDomains = new Map<GitRepositoryId, Set<RefreshDomain>>();
  private readonly timers = new Map<GitRepositoryId, ReturnType<typeof setTimeout>>();
  private readonly pendingWorktreePaths = new Map<GitRepositoryId, Set<string>>();
  private readonly worktreePathTimers = new Map<GitRepositoryId, ReturnType<typeof setTimeout>>();
  private readonly lastEventSequence = new Map<GitRepositoryId, number>();
  private readonly retrySubmissions = new Map<string, () => Promise<GitCommandResult>>();
  private readonly unsubscribe: () => void;
  private readonly debounceMs: number;
  private readonly operationPollMs: number;

  constructor(
    private readonly store: GitStore,
    private readonly runtime: GitRuntime,
    options: GitStoreControllerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 250;
    this.operationPollMs = options.operationPollMs ?? 250;
    this.unsubscribe = runtime.subscribe((event) => this.handleMetadataEvent(event));
  }

  async activateProject(scope: GitProjectScope): Promise<void> {
    const { workspaceId, projectRoot } = scope;
    const cachedProject = this.store.getState().projects[workspaceId];
    const canReuseDiscovery = Boolean(
      cachedProject
      && cachedProject.projectRoot === projectRoot
      && !cachedProject.loading
      && !cachedProject.error
      && cachedProject.repositoryIds.length > 0,
    );
    this.store.getState().activateProject(workspaceId, projectRoot);
    if (canReuseDiscovery) {
      await this.refreshSelectedRepository(workspaceId, projectRoot);
      return;
    }
    this.store.getState().discoveryStarted(workspaceId, projectRoot);
    let discovery: Awaited<ReturnType<GitRuntime["discover"]>>;
    try {
      discovery = await this.runtime.discover(scope, { includeNested: false });
    } catch (error) {
      const normalized = normalizeError(error);
      this.store.getState().discoveryFailed(workspaceId, projectRoot, normalized);
      return;
    }
    const active = this.store.getState().projects[workspaceId];
    if (!active || active.projectRoot !== projectRoot) return;
    this.store.getState().discoverySucceeded(workspaceId, projectRoot, discovery);
    await this.refreshSelectedRepository(workspaceId, projectRoot);
    if (discovery.repositories.some((repository) => repository.kind === "workspace")) {
      await this.enrichNestedRepositories(scope, discovery);
    }
  }

  private async enrichNestedRepositories(
    scope: GitProjectScope,
    initial: Awaited<ReturnType<GitRuntime["discover"]>>,
  ): Promise<void> {
    let discovery: Awaited<ReturnType<GitRuntime["discover"]>>;
    try {
      discovery = await this.runtime.discover(scope, { includeNested: true });
    } catch {
      return;
    }
    const project = this.store.getState().projects[scope.workspaceId];
    if (!project || project.projectRoot !== scope.projectRoot) return;
    const initialIds = initial.repositories.map((repository) => repository.id);
    const nextIds = discovery.repositories.map((repository) => repository.id);
    const ancestorChanged = initial.ancestorCandidate?.id !== discovery.ancestorCandidate?.id
      || initial.ancestorCandidate?.ancestorAuthorization !== discovery.ancestorCandidate?.ancestorAuthorization;
    if (!ancestorChanged && arraysEqual(initialIds, nextIds)) return;
    this.store.getState().discoverySucceeded(scope.workspaceId, scope.projectRoot, discovery);
  }

  private async refreshSelectedRepository(workspaceId: string, projectRoot: string): Promise<void> {
    const selectedRepositoryId = this.store.getState().projects[workspaceId]?.selectedRepositoryId;
    const selectedRepository = selectedRepositoryId
      ? this.store.getState().repositories[selectedRepositoryId]
      : null;
    if (!selectedRepository) return;
    const scope = { workspaceId, projectRoot, repositoryId: selectedRepository.id };
    await this.refreshRepository(scope, selectedRepository.bare ? ["refs"] : ["status", "refs"]);
  }

  refreshRepository(scope: GitRepositoryScope, domains: readonly string[]): Promise<void> {
    const repository = this.store.getState().repositories[scope.repositoryId];
    const queryDomains = Array.from(new Set(
      domains.filter(isRefreshDomain).filter((domain) => !repository?.bare || isBareRepositoryDomain(domain)),
    ));
    if (queryDomains.length === 0) return Promise.resolve();
    const requested = this.requestedDomains.get(scope.repositoryId) ?? new Set<RefreshDomain>();
    queryDomains.forEach((domain) => requested.add(domain));
    this.requestedDomains.set(scope.repositoryId, requested);
    const existing = this.repositoryRefreshes.get(scope.repositoryId);
    if (existing) return existing;

    const refresh = this.drainRepositoryRefreshes(scope)
      .finally(() => this.repositoryRefreshes.delete(scope.repositoryId));
    this.repositoryRefreshes.set(scope.repositoryId, refresh);
    return refresh;
  }

  async runCommand(
    submit: () => Promise<GitCommandResult>,
  ): Promise<GitCommandResult> {
    let operation = await submit();
    this.store.getState().recordOperation(operation);
    if (RETRYABLE_COMMANDS.has(operation.command)) {
      this.retrySubmissions.set(operation.operationId, submit);
    }
    while (operation.state === "queued" || operation.state === "running") {
      await delay(this.operationPollMs);
      operation = await this.runtime.operation(operation.operationId);
      this.store.getState().recordOperation(operation);
    }
    if (!operation.retryable || operation.state !== "failed") {
      this.retrySubmissions.delete(operation.operationId);
    }
    const explicitDomains = Array.isArray(operation.result.refresh_domains)
      ? operation.result.refresh_domains.map(String)
      : null;
    if (operation.state === "succeeded" || explicitDomains) {
      const domains = explicitDomains ?? ["status", "refs", "history", "diff"];
      this.invalidateAndSchedule(operation.repositoryId, domains, true);
    }
    return operation;
  }

  canRetryOperation(operationId: string): boolean {
    return this.retrySubmissions.has(operationId)
      && this.store.getState().operations[operationId]?.retryable === true;
  }

  retryOperation(operationId: string): Promise<GitCommandResult> {
    const submit = this.retrySubmissions.get(operationId);
    if (!submit || !this.canRetryOperation(operationId)) {
      return Promise.reject(new Error("This Git operation cannot be retried safely"));
    }
    this.retrySubmissions.delete(operationId);
    return this.runCommand(submit);
  }

  canCancelOperation(operationId: string): boolean {
    const operation = this.store.getState().operations[operationId];
    return operation?.state === "queued" || operation?.state === "running";
  }

  async cancelOperation(operationId: string): Promise<GitCommandResult> {
    if (!this.canCancelOperation(operationId)) {
      throw new Error("This Git operation is no longer cancellable");
    }
    const operation = await this.runtime.cancel(operationId);
    this.store.getState().recordOperation(operation);
    return operation;
  }

  handleMetadataEvent(event: GitMetadataChangedEvent): void {
    const previousSequence = this.lastEventSequence.get(event.repositoryId) ?? -1;
    if (event.sequence <= previousSequence) return;
    this.lastEventSequence.set(event.repositoryId, event.sequence);
    this.invalidateAndSchedule(event.repositoryId, event.domains, false);
  }

  handleExternalWorktreeChanges(repositoryIds: readonly GitRepositoryId[]): void {
    for (const repositoryId of new Set(repositoryIds)) {
      const repository = this.store.getState().repositories[repositoryId];
      this.invalidateAndSchedule(
        repositoryId,
        repository?.bare ? ["refs"] : ["status"],
        false,
      );
    }
  }

  handleExternalWorktreePaths(changes: readonly GitWorktreePathChange[]): void {
    for (const change of changes) {
      const path = change.path.trim().replaceAll("\\", "/");
      if (!path) continue;
      const paths = this.pendingWorktreePaths.get(change.repositoryId) ?? new Set<string>();
      paths.add(path);
      this.pendingWorktreePaths.set(change.repositoryId, paths);
    }
    for (const repositoryId of new Set(changes.map((change) => change.repositoryId))) {
      if (!this.pendingWorktreePaths.has(repositoryId)) continue;
      const previous = this.worktreePathTimers.get(repositoryId);
      if (previous) clearTimeout(previous);
      this.worktreePathTimers.set(repositoryId, setTimeout(() => {
        this.worktreePathTimers.delete(repositoryId);
        void this.flushExternalWorktreePaths(repositoryId);
      }, this.debounceMs));
    }
  }

  handleRepositoryWatchResync(repositoryId: GitRepositoryId): void {
    const repository = this.store.getState().repositories[repositoryId];
    this.invalidateAndSchedule(
      repositoryId,
      repository?.bare ? ["refs", "history"] : ["status", "refs", "history", "diff"],
      true,
    );
  }

  dispose(): void {
    this.unsubscribe();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.worktreePathTimers.forEach(clearTimeout);
    this.worktreePathTimers.clear();
    this.pendingWorktreePaths.clear();
    this.requestedDomains.clear();
    this.retrySubmissions.clear();
  }

  private async flushExternalWorktreePaths(repositoryId: GitRepositoryId): Promise<void> {
    const paths = this.pendingWorktreePaths.get(repositoryId);
    this.pendingWorktreePaths.delete(repositoryId);
    if (!paths || paths.size === 0) return;
    const scope = this.scopeForRepository(repositoryId);
    if (!scope || !this.runtime.worktreePaths) {
      this.handleExternalWorktreeChanges([repositoryId]);
      return;
    }
    try {
      const relevantPaths = await this.runtime.worktreePaths(scope, Array.from(paths));
      if (relevantPaths.length > 0) this.handleExternalWorktreeChanges([repositoryId]);
    } catch {
      // A filtering failure must not hide a real worktree change.
      this.handleExternalWorktreeChanges([repositoryId]);
    }
  }

  private async drainRepositoryRefreshes(scope: GitRepositoryScope): Promise<void> {
    while (true) {
      const pending = this.requestedDomains.get(scope.repositoryId);
      if (!pending || pending.size === 0) {
        this.requestedDomains.delete(scope.repositoryId);
        return;
      }
      const domains = Array.from(pending);
      this.requestedDomains.delete(scope.repositoryId);
      const epoch = this.store.getState().repositoryEpochs[scope.repositoryId] ?? 0;
      await Promise.allSettled(domains.map((domain) => this.refreshDomain(scope, domain, epoch)));
    }
  }

  private refreshDomain(
    scope: GitRepositoryScope,
    domain: RefreshDomain,
    epoch: number,
  ): Promise<void> {
    const key = `${scope.repositoryId}:${epoch}:${domain}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.loadDomain(scope, domain)
      .then((result) => {
        const currentEpoch = this.store.getState().repositoryEpochs[scope.repositoryId] ?? 0;
        if (currentEpoch !== epoch) return;
        const actions = this.store.getState();
        if (domain === "status") actions.setStatus(result as Awaited<ReturnType<GitRuntime["status"]>>);
        if (domain === "refs") actions.setRefs(result as Awaited<ReturnType<GitRuntime["refs"]>>);
        if (domain === "history") actions.setHistory(result as Awaited<ReturnType<GitRuntime["history"]>>);
        if (domain === "diff") actions.setDiff(result as Awaited<ReturnType<GitRuntime["diff"]>>);
        actions.clearInvalidatedDomains(scope.repositoryId, [domain]);
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private loadDomain(scope: GitRepositoryScope, domain: RefreshDomain): Promise<unknown> {
    if (domain === "status") return this.runtime.status(scope);
    if (domain === "refs") return this.runtime.refs(scope);
    if (domain === "history") return this.runtime.history(scope);
    return this.runtime.diff(scope);
  }

  private invalidateAndSchedule(
    repositoryId: GitRepositoryId,
    domains: readonly string[],
    immediate: boolean,
  ): void {
    const mapped = mapInvalidationDomains(domains);
    if (mapped.length === 0) return;
    this.store.getState().invalidateRepository(repositoryId, mapped);
    const repository = this.store.getState().repositories[repositoryId];
    const project = repository
      ? this.store.getState().projects[repository.workspaceId]
      : null;
    if (!project || project.selectedRepositoryId !== repositoryId) return;
    const previous = this.timers.get(repositoryId);
    if (previous) clearTimeout(previous);
    const run = () => {
      this.timers.delete(repositoryId);
      const scope = this.scopeForRepository(repositoryId);
      if (!scope) return;
      const pending = this.store.getState().invalidatedDomainsByRepository[repositoryId] ?? mapped;
      void this.refreshRepository(scope, pending);
    };
    if (immediate) {
      queueMicrotask(run);
    } else {
      this.timers.set(repositoryId, setTimeout(run, this.debounceMs));
    }
  }

  private scopeForRepository(repositoryId: GitRepositoryId): GitRepositoryScope | null {
    const repository = this.store.getState().repositories[repositoryId];
    if (!repository) return null;
    const project = this.store.getState().projects[repository.workspaceId];
    if (!project) return null;
    return {
      workspaceId: project.workspaceId,
      projectRoot: project.projectRoot,
      repositoryId,
    };
  }
}

export function mapInvalidationDomains(domains: readonly string[]): RefreshDomain[] {
  const mapped = new Set<RefreshDomain>();
  domains.forEach((domain) => {
    if (isRefreshDomain(domain)) mapped.add(domain);
    if (domain === "operation") mapped.add("status");
    if (domain === "config" || domain === "remotes") mapped.add("refs");
  });
  return Array.from(mapped);
}

function isRefreshDomain(value: string): value is RefreshDomain {
  return QUERY_DOMAINS.has(value as RefreshDomain);
}

function isBareRepositoryDomain(domain: RefreshDomain): boolean {
  return domain === "refs" || domain === "history";
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.message === "string") {
      return { code: typeof value.code === "string" ? value.code : "git_failed", message: value.message };
    }
  }
  return { code: "git_failed", message: error instanceof Error ? error.message : String(error) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
