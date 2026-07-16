import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { ProjectGitMenu } from "@/renderer/components/layout/Titlebar/ProjectGitMenu";
import { ActiveProjectProvider } from "@/renderer/providers/ActiveProjectProvider";
import { GitProvider } from "@/renderer/providers/GitProvider";
import type { GitRuntime } from "@/runtime/git";
import type { GitRepositoryId, GitRepositoryVersion } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("ProjectGitMenu", () => {
  it("is globally visible but disabled without a loaded project", () => {
    render(
      <ActiveProjectProvider discovery={{ project: null }}>
        <Titlebar
          title="Keydex"
          modeSwitch={{ currentMode: "agent", onModeChange: vi.fn() }}
          projectGitMenu={{ onOpenToolWindow: vi.fn() }}
        />
      </ActiveProjectProvider>,
    );

    expect(screen.getByRole("button", { name: "Git：加载项目后可用" }).hasAttribute("disabled")).toBe(true);
  });

  it("disables the project entry without showing a hover tooltip when system Git is unavailable", async () => {
    const runtime = readyRuntime();
    vi.mocked(runtime.discover).mockResolvedValue({
      capability: {
        available: false,
        executable: null,
        version: null,
        supportsSwitch: false,
        supportsRestore: false,
        supportsPathspecFromFile: false,
        lfsAvailable: false,
        reason: "git executable was not found",
      },
      repositories: [],
      ancestorCandidate: null,
    });
    render(
      <ActiveProjectProvider discovery={{ project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" } }}>
        <GitProvider runtime={runtime}>
          <ProjectGitMenu onOpenToolWindow={vi.fn()} />
        </GitProvider>
      </ActiveProjectProvider>,
    );

    const trigger = await screen.findByRole("button", { name: "Git：系统 Git 不可用" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.hasAttribute("title")).toBe(false);
  });

  it("shows branch, dirty and synchronization state and opens the shared tool window", async () => {
    const onOpenToolWindow = vi.fn();
    const runtime = readyRuntime();
    render(
      <ActiveProjectProvider
        discovery={{
          project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
          repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
        }}
      >
        <GitProvider runtime={runtime}>
          <input aria-label="commit editor" />
          <ProjectGitMenu onOpenToolWindow={onOpenToolWindow} />
        </GitProvider>
      </ActiveProjectProvider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Git：main" })).not.toBeNull());
    expect(screen.getByLabelText("2 个改动")).not.toBeNull();
    expect(screen.getByLabelText("领先 2，落后 1")).not.toBeNull();

    const trigger = screen.getByRole("button", { name: "Git：main" });
    expect(trigger.hasAttribute("title")).toBe(false);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("textbox", { name: "搜索 Git 分支和操作" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole("treeitem", { name: /^本地/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "main（本地）" })).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: "origin/main（远程）" })).not.toBeNull();
    const tagGroup = screen.getByRole("treeitem", { name: /^标签/ });
    expect(tagGroup.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "v1.0.0（标签）" })).toBeNull();
    fireEvent.click(tagGroup);
    expect(screen.getByRole("treeitem", { name: "v1.0.0（标签）" })).not.toBeNull();

    fireEvent.change(search, { target: { value: "feature" } });
    expect(screen.getByRole("treeitem", { name: "feature/git-menu（本地）" })).not.toBeNull();
    expect(screen.queryByRole("treeitem", { name: "main（本地）" })).toBeNull();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "项目 Git 菜单" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Git：main" }));

    fireEvent.click(screen.getByRole("button", { name: "Git：main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /更新项目/ }));
    await waitFor(() => expect(runtime.update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Git：main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开 Git 面板" }));
    expect(onOpenToolWindow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Git：main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Git 帮助与风险说明" }));
    expect(screen.getByRole("dialog", { name: "Git 操作与风险说明" })).not.toBeNull();
    expect(screen.getByText(/Force Push 只使用 --force-with-lease/)).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Git 操作与风险说明" })).toBeNull());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(runtime.push).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "commit editor" }), { key: "t", ctrlKey: true });
    expect(runtime.update).toHaveBeenCalledTimes(1);
  });
});

function readyRuntime(): GitRuntime {
  const repositoryId = "repo-1" as GitRepositoryId;
  const repositoryVersion = "version-1" as GitRepositoryVersion;
  return {
    capabilities: vi.fn(),
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
      repositories: [
        {
          id: repositoryId,
          workspaceId: "workspace-1",
          rootPath: "D:/repo",
          displayPath: ".",
          gitDirPath: "D:/repo/.git",
          kind: "workspace",
          parentRepoId: null,
          bare: false,
          ancestorAuthorization: "not_required",
        },
      ],
      ancestorCandidate: null,
    }),
    status: vi.fn().mockResolvedValue({
      repositoryId,
      repositoryVersion,
      branch: { head: "main", detachedAt: null, upstream: "origin/main", ahead: 2, behind: 1, unborn: false },
      files: [
        { path: "a.ts", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: false, submodule: false },
        { path: "b.ts", originalPath: null, indexStatus: "added", worktreeStatus: null, conflicted: false, binary: false, submodule: false },
      ],
      operation: null,
    }),
    refs: vi.fn().mockResolvedValue({
      repositoryId,
      repositoryVersion,
      refs: [
        { fullName: "refs/heads/main", shortName: "main", kind: "local", objectId: "a".repeat(40), peeledObjectId: null, upstream: "origin/main", ahead: 2, behind: 1, current: true },
        { fullName: "refs/heads/feature/git-menu", shortName: "feature/git-menu", kind: "local", objectId: "b".repeat(40), peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
        { fullName: "refs/remotes/origin/main", shortName: "origin/main", kind: "remote", objectId: "a".repeat(40), peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
        { fullName: "refs/tags/v1.0.0", shortName: "v1.0.0", kind: "tag", objectId: "c".repeat(40), peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
      ],
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
    update: vi.fn().mockResolvedValue({
      operationId: "operation-update",
      repositoryId,
      repositoryVersion,
      state: "succeeded",
      summary: "Updated from origin",
      result: { refresh_domains: ["status", "refs", "history", "diff"] },
    }),
    push: vi.fn().mockResolvedValue({
      operationId: "operation-push",
      repositoryId,
      repositoryVersion,
      state: "succeeded",
      summary: "Pushed to origin",
      result: { refresh_domains: ["status", "refs", "history"] },
    }),
    confirmation: vi.fn(),
    operation: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    acceptEvent: vi.fn(() => false),
  } as unknown as GitRuntime;
}
