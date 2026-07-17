import { describe, expect, it, vi } from "vitest";

import { createGitStore } from "@/renderer/features/git/store/gitStore";
import {
  GitStoreController,
  mapInvalidationDomains,
} from "@/renderer/features/git/store/gitStoreController";
import type { GitRuntime } from "@/runtime/git";
import type {
  GitCommandResult,
  GitMetadataChangedEvent,
  GitRepositoryId,
  GitRepositoryVersion,
  GitStatusSnapshot,
} from "@/runtime/gitTypes";

const repositoryId = "repo-a" as GitRepositoryId;
const version = (value: string) => value as GitRepositoryVersion;

function status(value: string): GitStatusSnapshot {
  return {
    repositoryId,
    repositoryVersion: version(value),
    branch: { head: value, detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    files: [],
    operation: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function preparedStore(bare = false) {
  const store = createGitStore();
  store.getState().activateProject("workspace-a", "C:/project");
  store.getState().discoverySucceeded("workspace-a", "C:/project", {
    capability: {
      available: true,
      executable: "git",
      version: "2.50.0",
      supportsSwitch: true,
      supportsRestore: true,
      supportsPathspecFromFile: true,
      lfsAvailable: false,
    },
    repositories: [{
      id: repositoryId,
      workspaceId: "workspace-a",
      rootPath: "C:/project",
      displayPath: ".",
      gitDirPath: "C:/project/.git",
      kind: "workspace",
      parentRepoId: null,
      bare,
      ancestorAuthorization: "not_required",
    }],
    ancestorCandidate: null,
  });
  return store;
}

describe("Git store controller", () => {
  it("serializes refreshes per repository and collapses an event storm into one trailing query", async () => {
    const first = deferred<GitStatusSnapshot>();
    const second = deferred<GitStatusSnapshot>();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    } as unknown as GitRuntime;
    const store = preparedStore();
    const controller = new GitStoreController(store, runtime, { debounceMs: 0 });
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId };

    const oldRequest = controller.refreshRepository(scope, ["status"]);
    const duplicate = controller.refreshRepository(scope, ["status"]);
    expect(runtime.status).toHaveBeenCalledTimes(1);
    for (let sequence = 1; sequence <= 50; sequence += 1) {
      controller.handleMetadataEvent(event(sequence));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.status).toHaveBeenCalledTimes(1);
    first.resolve(status("old"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.status).toHaveBeenCalledTimes(2);
    expect(store.getState().statusByRepository[repositoryId]).toBeUndefined();
    second.resolve(status("new"));
    await Promise.all([oldRequest, duplicate]);

    expect(store.getState().statusByRepository[repositoryId]?.branch.head).toBe("new");
    controller.dispose();
  });

  it("runs different refresh domains sequentially for one repository", async () => {
    const pendingStatus = deferred<GitStatusSnapshot>();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockReturnValue(pendingStatus.promise),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("fresh"), refs: [] }),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime);
    const refresh = controller.refreshRepository({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId,
    }, ["status", "refs"]);

    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.refs).not.toHaveBeenCalled();
    pendingStatus.resolve(status("fresh"));
    await refresh;

    expect(runtime.refs).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("coalesces watcher domains and ignores duplicate sequences", async () => {
    vi.useFakeTimers();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockResolvedValue(status("fresh")),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("fresh"), refs: [] }),
    } as unknown as GitRuntime;
    const store = preparedStore();
    const controller = new GitStoreController(store, runtime, { debounceMs: 20 });

    controller.handleMetadataEvent(event(2, ["status"]));
    controller.handleMetadataEvent(event(2, ["status"]));
    controller.handleMetadataEvent(event(3, ["refs"]));
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.refs).toHaveBeenCalledTimes(1);
    expect(mapInvalidationDomains(["operation", "remotes"])).toEqual(["status", "refs"]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("refreshes explicit domains after a partially mutating failed command", async () => {
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockResolvedValue(status("conflicted")),
      diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("conflicted"), files: [] }),
    } as unknown as GitRuntime;
    const store = preparedStore();
    const controller = new GitStoreController(store, runtime, { debounceMs: 0 });
    const failed = {
      operationId: "stash-conflict",
      repositoryId,
      repositoryVersion: version("conflicted"),
      state: "failed" as const,
      summary: "stash_apply",
      result: { error: "CONFLICT", refresh_domains: ["status", "diff", "stash"] },
      command: "stash_apply",
      risk: "write" as const,
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      retryable: false,
      error: null,
    };
    controller.setForegroundActive(true);
    await expect(controller.runCommand(async () => failed)).resolves.toBe(failed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.diff).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("reports queued, running, and terminal command states to the action host", async () => {
    const queued = commandResult({ operationId: "patch-1", state: "queued", retryable: false });
    const running = commandResult({ operationId: "patch-1", state: "running", retryable: false });
    const succeeded = commandResult({ operationId: "patch-1", state: "succeeded", retryable: false });
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      operation: vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(succeeded),
      status: vi.fn().mockResolvedValue(status("after-patch")),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("after-patch"), refs: [] }),
      history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("after-patch"), commits: [], nextCursor: null }),
      diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("after-patch"), files: [] }),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime, { operationPollMs: 0 });
    const onStateChange = vi.fn();

    await expect(controller.runCommand(async () => queued, onStateChange)).resolves.toBe(succeeded);
    expect(onStateChange.mock.calls.map(([operation]) => operation.state))
      .toEqual(["queued", "running", "succeeded"]);
    controller.dispose();
  });

  it("coalesces external worktree changes into a lightweight status refresh", async () => {
    vi.useFakeTimers();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockResolvedValue(status("external")),
      diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("external"), files: [] }),
      refs: vi.fn(),
      history: vi.fn(),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime, { debounceMs: 20 });

    controller.handleExternalWorktreeChanges([repositoryId, repositoryId]);
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.diff).not.toHaveBeenCalled();
    expect(runtime.refs).not.toHaveBeenCalled();
    expect(runtime.history).not.toHaveBeenCalled();
    controller.dispose();
    vi.useRealTimers();
  });

  it("does not refresh Git when every external worktree path is ignored", async () => {
    vi.useFakeTimers();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      worktreePaths: vi.fn().mockResolvedValue([]),
      status: vi.fn(),
      diff: vi.fn(),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime, { debounceMs: 20 });

    controller.handleExternalWorktreePaths([{ repositoryId, path: ".dev/cache.db" }]);
    controller.handleExternalWorktreePaths([{ repositoryId, path: ".dev/cache.db" }]);
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.worktreePaths).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId }),
      [".dev/cache.db"],
    );
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.diff).not.toHaveBeenCalled();
    controller.dispose();
    vi.useRealTimers();
  });

  it("refreshes Git when an external worktree batch contains a relevant path", async () => {
    vi.useFakeTimers();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      worktreePaths: vi.fn().mockResolvedValue(["src/a.ts"]),
      status: vi.fn().mockResolvedValue(status("external-filtered")),
      diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("external-filtered"), files: [] }),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime, { debounceMs: 20 });

    controller.handleExternalWorktreePaths([
      { repositoryId, path: ".dev/cache.db" },
      { repositoryId, path: "src/a.ts" },
    ]);
    await vi.advanceTimersByTimeAsync(45);

    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.diff).not.toHaveBeenCalled();
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps worktree path filtering single-flight and schedules one trailing batch", async () => {
    vi.useFakeTimers();
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      worktreePaths: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      status: vi.fn(),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime, { debounceMs: 20 });

    controller.handleExternalWorktreePaths([{ repositoryId, path: "src/a.ts" }]);
    await vi.advanceTimersByTimeAsync(25);
    expect(runtime.worktreePaths).toHaveBeenCalledTimes(1);

    controller.handleExternalWorktreePaths([{ repositoryId, path: "src/b.ts" }]);
    await vi.advanceTimersByTimeAsync(25);
    expect(runtime.worktreePaths).toHaveBeenCalledTimes(1);

    first.resolve([]);
    await vi.advanceTimersByTimeAsync(25);
    expect(runtime.worktreePaths).toHaveBeenCalledTimes(2);
    expect(runtime.worktreePaths).toHaveBeenLastCalledWith(
      expect.objectContaining({ repositoryId }),
      ["src/b.ts"],
    );
    second.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps expensive invalidated domains stale until the Git surface is visible", async () => {
    vi.useFakeTimers();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockResolvedValue(status("background")),
      history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("foreground"), commits: [], nextCursor: null }),
      diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("foreground"), files: [] }),
    } as unknown as GitRuntime;
    const store = preparedStore();
    const controller = new GitStoreController(store, runtime, { debounceMs: 20 });

    controller.handleMetadataEvent(event(1, ["status", "history", "diff"]));
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.history).not.toHaveBeenCalled();
    expect(runtime.diff).not.toHaveBeenCalled();
    expect(store.getState().invalidatedDomainsByRepository[repositoryId]).toEqual(["history", "diff"]);

    controller.setForegroundActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.history).toHaveBeenCalledTimes(1);
    expect(runtime.diff).toHaveBeenCalledTimes(1);
    controller.dispose();
    vi.useRealTimers();
  });

  it("never loads worktree-only status or diff domains for a bare repository", async () => {
    vi.useFakeTimers();
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn(),
      diff: vi.fn(),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("bare"), refs: [] }),
      history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("bare"), commits: [], nextCursor: null }),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(true), runtime, { debounceMs: 20 });
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId };

    await controller.refreshRepository(scope, ["status", "refs", "history", "diff"]);
    controller.handleExternalWorktreeChanges([repositoryId]);
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.diff).not.toHaveBeenCalled();
    expect(runtime.refs).toHaveBeenCalledTimes(2);
    expect(runtime.history).toHaveBeenCalledTimes(1);
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps background repositories invalidated without querying until they are selected", async () => {
    vi.useFakeTimers();
    const backgroundRepositoryId = "repo-background" as GitRepositoryId;
    const store = preparedStore();
    store.getState().discoverySucceeded("workspace-a", "C:/project", {
      capability: store.getState().projects["workspace-a"].capability!,
      repositories: [
        store.getState().repositories[repositoryId],
        {
          ...store.getState().repositories[repositoryId],
          id: backgroundRepositoryId,
          rootPath: "C:/project/packages/background",
          displayPath: "packages/background",
          gitDirPath: "C:/project/packages/background/.git",
          kind: "nested",
          parentRepoId: repositoryId,
        },
      ],
      ancestorCandidate: null,
    });
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn(),
      diff: vi.fn(),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(store, runtime, { debounceMs: 20 });

    controller.handleExternalWorktreeChanges([backgroundRepositoryId]);
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.diff).not.toHaveBeenCalled();
    expect(store.getState().invalidatedDomainsByRepository[backgroundRepositoryId]).toEqual([
      "status",
    ]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps project discovery usable when one repository refresh fails", async () => {
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      discover: vi.fn().mockResolvedValue({
        capability: {
          available: true,
          executable: "git",
          version: "2.50.0",
          supportsSwitch: true,
          supportsRestore: true,
          supportsPathspecFromFile: true,
          lfsAvailable: false,
        },
        repositories: [{
          id: repositoryId,
          workspaceId: "workspace-a",
          rootPath: "C:/project",
          displayPath: ".",
          gitDirPath: "C:/project/.git",
          kind: "workspace",
          parentRepoId: null,
          bare: false,
          ancestorAuthorization: "not_required",
        }],
        ancestorCandidate: null,
      }),
      status: vi.fn().mockRejectedValue(new Error("damaged nested repository")),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("ok"), refs: [] }),
      history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("ok"), commits: [], nextCursor: null }),
    } as unknown as GitRuntime;
    const store = createGitStore();
    const controller = new GitStoreController(store, runtime);

    await controller.activateProject({ workspaceId: "workspace-a", projectRoot: "C:/project" });

    expect(store.getState().projects["workspace-a"]).toMatchObject({ loading: false, error: null });
    expect(store.getState().refsByRepository[repositoryId]).toEqual([]);
    expect(runtime.discover).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
    }, { includeNested: false });
    expect(runtime.discover).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
    }, { includeNested: true });
    expect(runtime.history).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("surfaces a structured initial status failure and clears it after a successful retry", async () => {
    const discovery = {
      capability: {
        available: true,
        executable: "git",
        version: "2.50.0",
        supportsSwitch: true,
        supportsRestore: true,
        supportsPathspecFromFile: true,
        lfsAvailable: false,
      },
      repositories: [{
        id: repositoryId,
        workspaceId: "workspace-a",
        rootPath: "C:/project",
        displayPath: ".",
        gitDirPath: "C:/project/.git",
        kind: "workspace" as const,
        parentRepoId: null,
        bare: false,
        ancestorAuthorization: "not_required" as const,
      }],
      ancestorCandidate: null,
    };
    const damagedHead = Object.assign(new Error("fatal: invalid HEAD metadata"), {
      code: "git_failed",
    });
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      discover: vi.fn().mockResolvedValue(discovery),
      status: vi.fn().mockRejectedValueOnce(damagedHead).mockResolvedValueOnce(status("main")),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("ok"), refs: [] }),
    } as unknown as GitRuntime;
    const store = createGitStore();
    const controller = new GitStoreController(store, runtime);
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project" };

    await controller.activateProject(scope);

    expect(store.getState().projects[scope.workspaceId].error).toEqual({
      code: "git_failed",
      message: "fatal: invalid HEAD metadata",
    });
    expect(store.getState().statusByRepository[repositoryId]).toBeUndefined();

    await controller.activateProject(scope);

    expect(store.getState().projects[scope.workspaceId]).toMatchObject({ loading: false, error: null });
    expect(store.getState().statusByRepository[repositoryId]?.branch.head).toBe("main");
    expect(runtime.status).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("keeps a cached status visible when a later structured refresh fails", async () => {
    const store = preparedStore();
    store.getState().setStatus(status("cached"));
    const refreshError = Object.assign(new Error("temporary status failure"), {
      code: "git_failed",
    });
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockRejectedValue(refreshError),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(store, runtime);

    await controller.refreshRepository({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId,
    }, ["status"]);

    expect(store.getState().projects["workspace-a"].error).toBeNull();
    expect(store.getState().statusByRepository[repositoryId]?.branch.head).toBe("cached");
    controller.dispose();
  });

  it("reuses a discovered project and refreshes only the selected repository summary", async () => {
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      discover: vi.fn(),
      status: vi.fn().mockResolvedValue(status("cached")),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("cached"), refs: [] }),
      history: vi.fn(),
      diff: vi.fn(),
    } as unknown as GitRuntime;
    const store = preparedStore();
    const controller = new GitStoreController(store, runtime);

    await controller.activateProject({ workspaceId: "workspace-a", projectRoot: "C:/project" });

    expect(runtime.discover).not.toHaveBeenCalled();
    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(runtime.refs).toHaveBeenCalledTimes(1);
    expect(runtime.history).not.toHaveBeenCalled();
    expect(runtime.diff).not.toHaveBeenCalled();
    expect(store.getState().projects["workspace-a"].loading).toBe(false);
    controller.dispose();
  });

  it("retries only explicitly retryable network operations with a fresh submission", async () => {
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn().mockResolvedValue(status("retry")),
      refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("retry"), refs: [] }),
      history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("retry"), commits: [], nextCursor: null }),
      diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion: version("retry"), files: [] }),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(preparedStore(), runtime);
    const failed = commandResult({ operationId: "fetch-1", state: "failed", retryable: true });
    const succeeded = commandResult({ operationId: "fetch-2", state: "succeeded", retryable: false });
    const submit = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(succeeded);

    await expect(controller.runCommand(submit)).resolves.toBe(failed);
    expect(controller.canRetryOperation("fetch-1")).toBe(true);
    await expect(controller.retryOperation("fetch-1")).resolves.toBe(succeeded);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(controller.canRetryOperation("fetch-1")).toBe(false);
    await expect(controller.retryOperation("fetch-2")).rejects.toThrow("cannot be retried safely");
    controller.dispose();
  });

  it("cancels only queued or running operations and records the server state", async () => {
    const store = preparedStore();
    store.getState().recordOperation(commandResult({ operationId: "fetch-running", state: "running", retryable: false }));
    const cancelled = commandResult({ operationId: "fetch-running", state: "cancelled", retryable: false });
    const runtime = {
      subscribe: vi.fn(() => () => undefined),
      cancel: vi.fn().mockResolvedValue(cancelled),
    } as unknown as GitRuntime;
    const controller = new GitStoreController(store, runtime);

    expect(controller.canCancelOperation("fetch-running")).toBe(true);
    await expect(controller.cancelOperation("fetch-running")).resolves.toBe(cancelled);
    expect(runtime.cancel).toHaveBeenCalledWith("fetch-running");
    expect(store.getState().operations["fetch-running"].state).toBe("cancelled");
    expect(controller.canCancelOperation("fetch-running")).toBe(false);
    await expect(controller.cancelOperation("fetch-running")).rejects.toThrow("no longer cancellable");
    controller.dispose();
  });
});

function event(sequence: number, domains = ["status"]): GitMetadataChangedEvent {
  return {
    repositoryId,
    repositoryVersion: version(`event-${sequence}`),
    sequence,
    domains,
    paths: ["index"],
    resyncRequired: false,
  };
}

function commandResult({
  operationId,
  state,
  retryable,
}: {
  operationId: string;
  state: GitCommandResult["state"];
  retryable: boolean;
}): GitCommandResult {
  return {
    operationId,
    repositoryId,
    repositoryVersion: version(operationId),
    state,
    summary: "Fetch origin",
    result: {},
    command: "fetch",
    risk: "write" as const,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    retryable,
    error: retryable ? { code: "git_network_unavailable", message: "Offline", retryable: true, details: {} } : null,
  };
}
