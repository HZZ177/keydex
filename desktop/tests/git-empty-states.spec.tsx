import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitToolWindow } from "@/renderer/features/git/components/GitToolWindow";
import { ActiveProjectProvider, useActiveProjectState } from "@/renderer/providers/ActiveProjectProvider";
import { GitProvider } from "@/renderer/providers/GitProvider";
import type { GitMetadataListener, GitRuntime } from "@/runtime/git";
import type { GitDiffSnapshot, GitFileDiff, GitRepositoryId, GitRepositoryVersion } from "@/runtime/gitTypes";

vi.mock("@/renderer/features/git/components/GitSelectedChangeDiff", () => ({
  GitSelectedChangeDiff: ({ snapshot }: { snapshot: GitDiffSnapshot | null }) => (
    <div data-testid="selected-change-diff">
      {snapshot?.files.map((file) => file.newPath ?? file.oldPath).join(",") ?? "empty"}
    </div>
  ),
}));

afterEach(cleanup);

describe("Git empty and recovery states", () => {
  it("initializes a non-repository project and refreshes without losing the project", async () => {
    const runtime = stateRuntime();
    renderTool(runtime);

    expect(await screen.findByText("当前项目不是 Git 仓库")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "初始化 Git 仓库" }));

    await waitFor(() => expect(runtime.initialize).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", projectRoot: "D:/repo" },
    ));
    expect(await screen.findByTestId("git-tool-window")).not.toBeNull();
    expect(screen.getByText("repo")).not.toBeNull();
  });

  it("renders an explicit Git-missing state with retry", async () => {
    const runtime = stateRuntime({ gitUnavailable: true });
    renderTool(runtime);

    expect(await screen.findByText("Git 不可用")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).not.toBeNull();
    expect(screen.getByText("未找到可用的 Git 命令行程序。")).not.toBeNull();
  });

  it("keeps the history branch selector, left ref selection, and history request synchronized", async () => {
    const runtime = stateRuntime({ readyOnDiscover: true });
    renderTool(runtime, "history");

    const featureBranch = await screen.findByRole("treeitem", { name: "feature/demo" });
    expect(screen.getByRole("button", { name: "分支筛选：全部分支" })).not.toBeNull();
    fireEvent.click(featureBranch);

    await waitFor(() => expect(screen.getByRole("button", { name: "分支筛选：feature/demo" })).not.toBeNull());
    await waitFor(() => expect(runtime.history).toHaveBeenLastCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" }),
      expect.objectContaining({ revision: "refs/heads/feature/demo" }),
    ));
    expect(featureBranch.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "分支筛选：feature/demo" }));
    fireEvent.click(screen.getByRole("option", { name: "全部分支" }));
    await waitFor(() => expect(featureBranch.getAttribute("aria-selected")).toBe("false"));
  });

  it("automatically loads only the first changed file diff", async () => {
    const runtime = stateRuntime({ readyOnDiscover: true, changedFile: true });
    renderTool(runtime);

    await screen.findByRole("treeitem", { name: "src/a.ts modified" });

    await waitFor(() => expect(runtime.diff).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" }),
      expect.objectContaining({ cached: false, path: "src/a.ts", signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByTestId("selected-change-diff").textContent).toBe("src/a.ts");
  });

  it("keeps the selected-file preview when a later repository-wide diff refresh completes", async () => {
    const metadataListeners = new Set<GitMetadataListener>();
    const runtime = stateRuntime({ readyOnDiscover: true, changedFile: true, metadataListeners });
    renderTool(runtime);

    await screen.findByRole("treeitem", { name: "src/a.ts modified" });
    await waitFor(() => expect(screen.getByTestId("selected-change-diff").textContent).toBe("src/a.ts"));

    act(() => {
      metadataListeners.forEach((listener) => listener({
        repositoryId: "repo-1" as GitRepositoryId,
        repositoryVersion: "version-2" as GitRepositoryVersion,
        sequence: 1,
        domains: ["diff"],
        paths: [],
        resyncRequired: false,
      }));
    });

    await waitFor(() => expect(runtime.diff).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" }),
    ));
    await waitFor(() => expect(screen.getByTestId("selected-change-diff").textContent).toBe("src/a.ts"));
    expect(screen.getByTestId("selected-change-diff").textContent).not.toContain("src/b.ts");
  });

  it("does not start view-specific queries while the Git tool window is hidden", async () => {
    const runtime = stateRuntime({ readyOnDiscover: true });
    renderTool(runtime, "history", false);

    await waitFor(() => expect(runtime.status).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runtime.refs).toHaveBeenCalledTimes(1));
    expect(runtime.history).not.toHaveBeenCalled();
    expect(runtime.diff).not.toHaveBeenCalled();
    expect(screen.queryByTestId("git-tool-window")).toBeNull();
  });
});

function Tool({ initialView, active = true }: { initialView?: "history"; active?: boolean }) {
  return (
    <GitToolWindow
      project={useActiveProjectState()}
      maximized
      initialView={initialView}
      active={active}
    />
  );
}

function renderTool(runtime: GitRuntime, initialView?: "history", active = true) {
  return render(
    <ActiveProjectProvider
      discovery={{ project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" } }}
    >
      <GitProvider runtime={runtime}>
        <Tool initialView={initialView} active={active} />
      </GitProvider>
    </ActiveProjectProvider>,
  );
}

function stateRuntime(options: {
  gitUnavailable?: boolean;
  readyOnDiscover?: boolean;
  changedFile?: boolean;
  metadataListeners?: Set<GitMetadataListener>;
} = {}): GitRuntime {
  const repositoryId = "repo-1" as GitRepositoryId;
  const repositoryVersion = "version-1" as GitRepositoryVersion;
  const capability = options.gitUnavailable
    ? {
        available: false,
        executable: null,
        version: null,
        supportsSwitch: false,
        supportsRestore: false,
        supportsPathspecFromFile: false,
        lfsAvailable: false,
        reason: "Git executable was not found",
      }
    : {
        available: true,
        executable: "git",
        version: "2.50.0",
        supportsSwitch: true,
        supportsRestore: true,
        supportsPathspecFromFile: true,
        lfsAvailable: false,
      };
  const empty = { capability, repositories: [], ancestorCandidate: null };
  const ready = {
    capability,
    repositories: [
      {
        id: repositoryId,
        workspaceId: "workspace-1",
        rootPath: "D:/repo",
        displayPath: ".",
        gitDirPath: "D:/repo/.git",
        kind: "workspace" as const,
        parentRepoId: null,
        bare: false,
        ancestorAuthorization: "not_required" as const,
      },
    ],
    ancestorCandidate: null,
  };
  const discover = options.gitUnavailable
    ? vi.fn().mockResolvedValue(empty)
    : options.readyOnDiscover
      ? vi.fn().mockResolvedValue(ready)
      : vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(ready);
  return {
    capabilities: vi.fn().mockResolvedValue(capability),
    discover,
    initialize: vi.fn().mockResolvedValue(ready),
    authorizeAncestor: vi.fn().mockResolvedValue(undefined),
    revokeAncestor: vi.fn().mockResolvedValue(false),
    status: vi.fn().mockResolvedValue({
      repositoryId,
      repositoryVersion,
      branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
      files: options.changedFile ? [{
        path: "src/a.ts",
        originalPath: null,
        indexStatus: null,
        worktreeStatus: "modified" as const,
        conflicted: false,
        binary: false,
        submodule: false,
      }] : [],
      operation: null,
    }),
    refs: vi.fn().mockResolvedValue({
      repositoryId,
      repositoryVersion,
      refs: options.readyOnDiscover ? [
        {
          fullName: "refs/heads/main",
          shortName: "main",
          kind: "local",
          objectId: "a".repeat(40),
          peeledObjectId: null,
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          current: true,
        },
        {
          fullName: "refs/heads/feature/demo",
          shortName: "feature/demo",
          kind: "local",
          objectId: "b".repeat(40),
          peeledObjectId: null,
          upstream: "origin/feature/demo",
          ahead: 0,
          behind: 0,
          current: false,
        },
      ] : [],
    }),
    history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, commits: [], nextCursor: null }),
    diff: vi.fn().mockImplementation((_scope, query?: { path?: string }) => Promise.resolve({
      repositoryId,
      repositoryVersion,
      files: query?.path === "src/a.ts"
        ? [changedFileDiff("src/a.ts")]
        : options.changedFile
          ? [changedFileDiff("src/a.ts"), changedFileDiff("src/b.ts")]
          : [],
    })),
    commit: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    createCommit: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    fetch: vi.fn(),
    update: vi.fn(),
    push: vi.fn(),
    confirmation: vi.fn(),
    operation: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn((listener: GitMetadataListener) => {
      options.metadataListeners?.add(listener);
      return () => options.metadataListeners?.delete(listener);
    }),
    acceptEvent: vi.fn(() => false),
  } as unknown as GitRuntime;
}

function changedFileDiff(path: string): GitFileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    binary: false,
    oldMode: "100644",
    newMode: "100644",
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-old", "+new"],
    }],
    rawPatch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
  };
}
