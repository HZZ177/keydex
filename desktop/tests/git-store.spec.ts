import { describe, expect, it } from "vitest";

import {
  createGitStore,
  type GitUiStorage,
  selectActiveGitRepository,
  selectProjectUi,
  selectSelectedGitStatus,
} from "@/renderer/features/git/store/gitStore";
import type {
  GitDiscoverySnapshot,
  GitRepositoryId,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";

const capability = {
  available: true,
  executable: "git",
  version: "2.50.0",
  supportsSwitch: true,
  supportsRestore: true,
  supportsPathspecFromFile: true,
  lfsAvailable: false,
};

function discovery(workspaceId: string, ...ids: string[]): GitDiscoverySnapshot {
  return {
    capability,
    repositories: ids.map((id) => ({
      id: id as GitRepositoryId,
      workspaceId,
      rootPath: `C:/${workspaceId}/${id}`,
      displayPath: id,
      gitDirPath: `C:/${workspaceId}/${id}/.git`,
      kind: "workspace" as const,
      parentRepoId: null,
      bare: false,
      ancestorAuthorization: "not_required" as const,
    })),
    ancestorCandidate: null,
  };
}

describe("Git store", () => {
  it("normalizes repositories and keeps project selections isolated", () => {
    const store = createGitStore();
    store.getState().activateProject("workspace-a", "C:/a");
    store.getState().discoverySucceeded("workspace-a", "C:/a", discovery("workspace-a", "a-1", "a-2"));
    store.getState().selectRepository("workspace-a", "a-2" as GitRepositoryId);
    store.getState().activateProject("workspace-b", "C:/b");
    store.getState().discoverySucceeded("workspace-b", "C:/b", discovery("workspace-b", "b-1"));

    expect(selectActiveGitRepository(store.getState())?.id).toBe("b-1");
    store.getState().activateProject("workspace-a", "C:/a");
    expect(selectActiveGitRepository(store.getState())?.id).toBe("a-2");
    expect(Object.keys(store.getState().repositories)).toEqual(["a-1", "a-2", "b-1"]);
  });

  it("stores backend facts per repository without optimistic mutation", () => {
    const store = createGitStore();
    store.getState().activateProject("workspace-a", "C:/a");
    store.getState().discoverySucceeded("workspace-a", "C:/a", discovery("workspace-a", "a-1"));
    store.getState().setStatus({
      repositoryId: "a-1" as GitRepositoryId,
      repositoryVersion: "v1" as GitRepositoryVersion,
      branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
      files: [],
      operation: null,
    });
    store.getState().recordOperation({
      operationId: "op-1",
      repositoryId: "a-1" as GitRepositoryId,
      repositoryVersion: "pending" as GitRepositoryVersion,
      state: "queued",
      summary: "stage",
      result: {},
      command: "stage",
      risk: "write",
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      retryable: false,
      error: null,
    });

    expect(selectSelectedGitStatus(store.getState())?.branch.head).toBe("main");
    expect(store.getState().operations["op-1"].state).toBe("queued");
    expect(selectSelectedGitStatus(store.getState())?.files).toEqual([]);
  });

  it("preserves visible selections across external refreshes and falls back when targets disappear", () => {
    const store = createGitStore();
    const repositoryId = "a-1" as GitRepositoryId;
    store.getState().activateProject("workspace-a", "C:/a");
    store.getState().discoverySucceeded("workspace-a", "C:/a", discovery("workspace-a", "a-1"));
    store.getState().updateProjectUi("workspace-a", {
      selectedPath: "src/topic.ts",
      selectedRef: "refs/heads/topic",
    });
    const topicRef = {
      fullName: "refs/heads/topic",
      shortName: "topic",
      kind: "local" as const,
      objectId: "abc" as never,
      peeledObjectId: null,
      upstream: null,
      ahead: null,
      behind: null,
      current: false,
    };
    const mainRef = {
      ...topicRef,
      fullName: "refs/heads/main",
      shortName: "main",
      objectId: "def" as never,
      current: true,
    };
    store.getState().setStatus({
      repositoryId,
      repositoryVersion: "v1" as GitRepositoryVersion,
      branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
      files: [{ path: "src/topic.ts", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: false, submodule: false }],
      operation: null,
    });
    store.getState().setRefs({ repositoryId, refs: [mainRef, topicRef] });
    expect(selectProjectUi(store.getState(), "workspace-a")).toMatchObject({
      selectedPath: "src/topic.ts",
      selectedRef: "refs/heads/topic",
    });

    store.getState().setStatus({
      repositoryId,
      repositoryVersion: "v2" as GitRepositoryVersion,
      branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
      files: [],
      operation: null,
    });
    store.getState().setRefs({ repositoryId, refs: [mainRef] });
    expect(selectProjectUi(store.getState(), "workspace-a")).toMatchObject({
      selectedPath: null,
      selectedRef: "refs/heads/main",
    });
  });

  it("keeps UI state scoped by project", () => {
    const store = createGitStore();
    store.getState().updateProjectUi("workspace-a", { toolWindowOpen: true, activeTab: "history" });
    store.getState().updateProjectUi("workspace-b", { commitDraft: "draft-b" });

    expect(selectProjectUi(store.getState(), "workspace-a")).toMatchObject({
      toolWindowOpen: true,
      activeTab: "history",
      commitDraft: "",
      updateStrategyByRepository: {},
    });
    expect(selectProjectUi(store.getState(), "workspace-b").commitDraft).toBe("draft-b");

    store.getState().updateProjectUi("workspace-a", {
      updateStrategyByRepository: { "a-1": "rebase" },
    });
    expect(selectProjectUi(store.getState(), "workspace-a").updateStrategyByRepository["a-1"]).toBe("rebase");
    expect(selectProjectUi(store.getState(), "workspace-b").updateStrategyByRepository).toEqual({});
  });

  it("persists selected root, tab, filters, layout, draft, and update strategy across store reconstruction", () => {
    const storage = new MemoryStorage();
    const first = createGitStore({ storage });
    first.getState().activateProject("workspace-a", "C:/a");
    first.getState().discoverySucceeded("workspace-a", "C:/a", discovery("workspace-a", "a-1", "a-2"));
    first.getState().selectRepository("workspace-a", "a-2" as GitRepositoryId);
    first.getState().updateProjectUi("workspace-a", {
      toolWindowOpen: true,
      toolWindowMaximized: false,
      activeTab: "history",
      selectedRef: "refs/heads/topic",
      selectedPath: "src/a.ts",
      showIgnored: true,
      commitDraft: "draft survives relaunch",
      historyFilters: { search: "fix", revision: "main", author: "Ada", since: "2026-01-01", until: "", path: "src", firstParent: true, mergesOnly: false },
      selectedHistoryObjectId: "abcdef1234567890",
      navigationPanePercent: 24,
      detailPanePercent: 31,
      updateStrategyByRepository: { "a-2": "rebase" },
    });

    const second = createGitStore({ storage });
    second.getState().activateProject("workspace-a", "C:/a");
    second.getState().discoverySucceeded("workspace-a", "C:/a", discovery("workspace-a", "a-1", "a-2"));
    expect(second.getState().projects["workspace-a"].selectedRepositoryId).toBe("a-2");
    expect(selectProjectUi(second.getState(), "workspace-a")).toMatchObject({
      toolWindowOpen: true,
      toolWindowMaximized: false,
      activeTab: "history",
      selectedRef: "refs/heads/topic",
      selectedPath: "src/a.ts",
      showIgnored: true,
      commitDraft: "draft survives relaunch",
      historyFilters: { search: "fix", firstParent: true },
      selectedHistoryObjectId: "abcdef1234567890",
      navigationPanePercent: 24,
      detailPanePercent: 31,
      updateStrategyByRepository: { "a-2": "rebase" },
    });
    expect(storage.value).not.toContain("confirmation_token");
    expect(storage.value).not.toContain("credential");
  });

  it("ignores corrupt data and does not reuse state when a workspace id points to another project root", () => {
    const storage = new MemoryStorage("{broken");
    const clean = createGitStore({ storage });
    clean.getState().activateProject("workspace-a", "C:/a");
    expect(selectProjectUi(clean.getState(), "workspace-a").activeTab).toBe("changes");
    clean.getState().discoverySucceeded("workspace-a", "C:/a", discovery("workspace-a", "a-1"));
    clean.getState().updateProjectUi("workspace-a", { commitDraft: "project a" });

    const reusedId = createGitStore({ storage });
    reusedId.getState().activateProject("workspace-a", "C:/different");
    expect(selectProjectUi(reusedId.getState(), "workspace-a").commitDraft).toBe("");
  });
});

class MemoryStorage implements GitUiStorage {
  constructor(public value = "") {}
  getItem(): string | null { return this.value || null; }
  setItem(_key: string, value: string): void { this.value = value; }
}
