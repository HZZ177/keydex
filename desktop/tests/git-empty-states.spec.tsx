import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitToolWindow } from "@/renderer/features/git/components/GitToolWindow";
import { ActiveProjectProvider, useActiveProjectState } from "@/renderer/providers/ActiveProjectProvider";
import { GitProvider } from "@/renderer/providers/GitProvider";
import type { GitRuntime } from "@/runtime/git";
import type { GitRepositoryId, GitRepositoryVersion } from "@/runtime/gitTypes";

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

  it("loads only the clicked file diff and does not prefetch a repository-wide diff", async () => {
    const runtime = stateRuntime({ readyOnDiscover: true, changedFile: true });
    renderTool(runtime);

    const row = await screen.findByRole("treeitem", { name: "src/a.ts modified" });
    expect(runtime.diff).not.toHaveBeenCalled();
    fireEvent.click(row);

    await waitFor(() => expect(runtime.diff).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" }),
      expect.objectContaining({ cached: false, path: "src/a.ts", signal: expect.any(AbortSignal) }),
    ));
  });
});

function Tool({ initialView }: { initialView?: "history" }) {
  return <GitToolWindow project={useActiveProjectState()} maximized initialView={initialView} />;
}

function renderTool(runtime: GitRuntime, initialView?: "history") {
  return render(
    <ActiveProjectProvider
      discovery={{ project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" } }}
    >
      <GitProvider runtime={runtime}>
        <Tool initialView={initialView} />
      </GitProvider>
    </ActiveProjectProvider>,
  );
}

function stateRuntime(options: { gitUnavailable?: boolean; readyOnDiscover?: boolean; changedFile?: boolean } = {}): GitRuntime {
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
    diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, files: [] }),
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
    subscribe: vi.fn(() => () => undefined),
    acceptEvent: vi.fn(() => false),
  } as unknown as GitRuntime;
}
