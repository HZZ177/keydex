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
    expect(screen.getByText("Git executable was not found")).not.toBeNull();
  });
});

function Tool() {
  return <GitToolWindow project={useActiveProjectState()} maximized />;
}

function renderTool(runtime: GitRuntime) {
  return render(
    <ActiveProjectProvider
      discovery={{ project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" } }}
    >
      <GitProvider runtime={runtime}>
        <Tool />
      </GitProvider>
    </ActiveProjectProvider>,
  );
}

function stateRuntime(options: { gitUnavailable?: boolean } = {}): GitRuntime {
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
      files: [],
      operation: null,
    }),
    refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, refs: [] }),
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
