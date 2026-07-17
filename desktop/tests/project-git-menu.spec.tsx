import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { ProjectGitMenu } from "@/renderer/components/layout/Titlebar/ProjectGitMenu";
import { ActiveProjectProvider } from "@/renderer/providers/ActiveProjectProvider";
import { GitProvider } from "@/renderer/providers/GitProvider";
import type { GitRuntime } from "@/runtime/git";
import type {
  GitCommitDetail,
  GitCommitSummary,
  GitFileDiff,
  GitRepositoryId,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";

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
    expect(screen.queryByLabelText("2 个改动")).toBeNull();
    const titlebarDivergence = screen.getByLabelText("传入 1 个提交，传出 2 个提交");
    expect(titlebarDivergence.querySelector('[data-direction="incoming"] .lucide-arrow-down-left')?.getAttribute("width")).toBe("13");
    expect(titlebarDivergence.querySelector('[data-direction="outgoing"] .lucide-arrow-up-right')?.getAttribute("width")).toBe("13");

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
    expect(screen.queryByText(".")).toBeNull();
    expect(screen.getByRole("treeitem", { name: /^本地/ }).getAttribute("aria-expanded")).toBe("true");
    const currentBranch = screen.getByRole("treeitem", { name: "main（本地）" });
    const upstreamBranch = screen.getByRole("treeitem", { name: "origin/main（远程）" });
    expect(currentBranch.querySelector(".lucide-star")).not.toBeNull();
    expect(upstreamBranch.querySelector(".lucide-star")).not.toBeNull();
    expect(currentBranch.getAttribute("data-ref-state")).toBe("current");
    expect(currentBranch.querySelector('[data-tone="mainline"]')).not.toBeNull();
    const divergence = currentBranch.querySelector('[aria-label="传入 1 个提交，传出 2 个提交"]');
    expect(divergence?.querySelector('[data-direction="incoming"] .lucide-arrow-down-left')).not.toBeNull();
    expect(divergence?.querySelector('[data-direction="outgoing"] .lucide-arrow-up-right')).not.toBeNull();
    expect(upstreamBranch.getAttribute("data-ref-state")).toBe("upstream");
    expect(upstreamBranch.querySelector('[data-tone="mainline"]')).not.toBeNull();

    fireEvent.click(currentBranch);
    expect(screen.getByRole("menu", { name: "main 引用操作" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "从 'main' 新建分支…" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "更新" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "推送…" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "重命名…" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "签出 'main'" })).toBeNull();
    fireEvent.click(currentBranch);

    fireEvent.click(upstreamBranch);
    expect(screen.getByRole("menu", { name: "origin/main 引用操作" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "签出 'origin/main'（分离当前指针）" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "从 'origin/main' 新建分支…" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "在 Git 面板中合并或变基…" })).not.toBeNull();
    fireEvent.click(upstreamBranch);

    const tagGroup = screen.getByRole("treeitem", { name: /^标签/ });
    expect(tagGroup.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "v1.0.0（标签）" })).toBeNull();
    fireEvent.click(tagGroup);
    const tag = screen.getByRole("treeitem", { name: "v1.0.0（标签）" });
    expect(tag.querySelector('[data-tone="tag"]')).not.toBeNull();
    fireEvent.click(tag);
    expect(screen.getByRole("menuitem", { name: "签出标记 'v1.0.0'（分离当前指针）" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "在 Git 面板中管理标签…" })).not.toBeNull();
    fireEvent.click(tag);

    fireEvent.change(search, { target: { value: "feature" } });
    const featureBranch = screen.getByRole("treeitem", { name: "feature/git-menu（本地）" });
    fireEvent.click(featureBranch);
    expect(screen.getByRole("menuitem", { name: "签出 'feature/git-menu'" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "与 'main' 比较" })).not.toBeNull();
    fireEvent.click(featureBranch);
    expect(screen.queryByRole("treeitem", { name: "main（本地）" })).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    const updateAction = screen.getByRole("menuitem", { name: /更新项目/ });
    const pushAction = screen.getByRole("menuitem", { name: /推送…/ });
    expect(updateAction.querySelector("svg.lucide-arrow-down-left")).not.toBeNull();
    expect(pushAction.querySelector("svg.lucide-arrow-up-right")).not.toBeNull();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "项目 Git 菜单" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Git：main" }));

    fireEvent.click(screen.getByRole("button", { name: "Git：main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /更新项目/ }));
    expect(runtime.update).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "更新项目" }).textContent).toContain("main ← origin/main");
    fireEvent.click(screen.getByRole("radio", { name: /将传入更改合并到当前分支/ }));
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    await waitFor(() => expect(runtime.update).toHaveBeenCalledWith(expect.objectContaining({ strategy: "merge" })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "更新项目" })).toBeNull());

    fireEvent.keyDown(window, { key: "t", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "更新项目" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(screen.getByRole("button", { name: "Git：main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开 Git 面板" }));
    expect(onOpenToolWindow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Git：main" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Git 帮助与风险说明" }));
    expect(screen.getByRole("dialog", { name: "Git 操作与风险说明" })).not.toBeNull();
    expect(screen.getByText(/强制推送只使用带租约保护的方式/)).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Git 操作与风险说明" })).toBeNull());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
    const pushDialog = await screen.findByRole("dialog", { name: "将提交推送到 repo" });
    expect(pushDialog.textContent).toContain("main → origin/main");
    await screen.findByRole("option", { name: /Ready to push/ });
    expect(runtime.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "推送" }));
    await waitFor(() => expect(runtime.push).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "commit editor" }), { key: "t", ctrlKey: true });
    expect(runtime.update).toHaveBeenCalledTimes(1);
  });

  it("opens real dialogs for create and rename instead of embedding inputs in the menu", async () => {
    const runtime = readyRuntime();
    render(
      <ActiveProjectProvider
        discovery={{
          project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
          repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
        }}
      >
        <GitProvider runtime={runtime}><ProjectGitMenu onOpenToolWindow={vi.fn()} /></GitProvider>
      </ActiveProjectProvider>,
    );
    const trigger = await screen.findByRole("button", { name: "Git：main" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /新建分支/ }));
    expect(screen.queryByRole("menu", { name: "项目 Git 菜单" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "创建新分支" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("新分支名称"), { target: { value: "feature/dialog" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(runtime.createBranch).toHaveBeenCalledWith(expect.objectContaining({
      branchName: "feature/dialog",
      startPoint: "HEAD",
    })));

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("treeitem", { name: "feature/git-menu（本地）" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名…" }));
    expect(screen.getByRole("dialog", { name: "重命名分支 feature/git-menu" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("重命名分支"), { target: { value: "feature/renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await waitFor(() => expect(runtime.renameBranch).toHaveBeenCalledWith(expect.objectContaining({
      oldName: "feature/git-menu",
      newName: "feature/renamed",
    })));
  });

  it("reuses the commit-and-push preview with outgoing commits, a directory tree and tag scope", async () => {
    const runtime = readyRuntime();
    const outgoingCommit = commitSummary("Feature commit", "d");
    vi.mocked(runtime.status).mockResolvedValue({
      repositoryId: "repo-1" as GitRepositoryId,
      repositoryVersion: "version-1" as GitRepositoryVersion,
      branch: { head: "feature/demo", detachedAt: null, upstream: "origin/feature/demo", ahead: 2, behind: 2, unborn: false },
      files: [],
      operation: null,
    });
    vi.mocked(runtime.history).mockResolvedValue({
      repositoryId: "repo-1" as GitRepositoryId,
      repositoryVersion: "version-1" as GitRepositoryVersion,
      commits: [outgoingCommit],
      nextCursor: null,
    });
    vi.mocked(runtime.commit).mockResolvedValue(commitDetail(outgoingCommit, [fileDiff("desktop/src/feature.ts")]));
    render(
      <ActiveProjectProvider
        discovery={{
          project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
          repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
        }}
      >
        <GitProvider runtime={runtime}><ProjectGitMenu onOpenToolWindow={vi.fn()} /></GitProvider>
      </ActiveProjectProvider>,
    );

    const trigger = await screen.findByRole("button", { name: "Git：feature/demo" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /推送…/ }));
    const dialog = await screen.findByRole("dialog", { name: "将提交推送到 repo" });
    await within(dialog).findByRole("option", { name: /Feature commit/ });
    await waitFor(() => expect(within(dialog).getByRole("tree", { name: "待推送提交改动文件树" })).not.toBeNull());
    const tree = within(dialog).getByRole("tree", { name: "待推送提交改动文件树" });
    expect(within(tree).getByText("repo")).not.toBeNull();
    expect(within(tree).getByText("desktop")).not.toBeNull();
    expect(within(tree).getByText("src")).not.toBeNull();
    expect(within(tree).getByText("feature.ts")).not.toBeNull();
    expect(runtime.history).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" }),
      expect.objectContaining({ revision: "origin/feature/demo..HEAD" }),
    );

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "推送标签" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "推送标签范围" }));
    fireEvent.click(screen.getByRole("option", { name: "当前分支" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "推送" }));

    await waitFor(() => expect(runtime.push).toHaveBeenCalledWith(expect.objectContaining({
      source: "feature/demo",
      target: "feature/demo",
      remote: "origin",
      tags: false,
      followTags: true,
    })));
    expect(runtime.confirmation).not.toHaveBeenCalled();
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
    history: vi.fn().mockResolvedValue({
      repositoryId,
      repositoryVersion,
      commits: [commitSummary("Ready to push", "a")],
      nextCursor: null,
    }),
    diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, files: [] }),
    remotes: vi.fn().mockResolvedValue([{ name: "origin", fetchUrl: "D:/origin.git", pushUrl: "D:/origin.git", trackingBranches: ["main"] }]),
    commit: vi.fn().mockImplementation((_, revision) => Promise.resolve(
      commitDetail(commitSummary("Ready to push", String(revision).slice(0, 1)), [fileDiff("desktop/src/app.ts")]),
    )),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    createCommit: vi.fn(),
    createBranch: vi.fn().mockResolvedValue(commandSucceeded(repositoryId, repositoryVersion, "Created branch")),
    renameBranch: vi.fn().mockResolvedValue(commandSucceeded(repositoryId, repositoryVersion, "Renamed branch")),
    checkout: vi.fn().mockResolvedValue(commandSucceeded(repositoryId, repositoryVersion, "Checked out")),
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

function commitSummary(subject: string, seed: string): GitCommitSummary {
  return {
    objectId: seed.repeat(40) as never,
    parentIds: [],
    authorName: "Alice",
    authorEmail: "alice@example.invalid",
    authoredAt: "2026-07-17T00:00:00Z",
    committerName: "Alice",
    committerEmail: "alice@example.invalid",
    committedAt: "2026-07-17T00:00:00Z",
    subject,
    body: "",
    decorations: [],
    signature: "unsigned",
  };
}

function commitDetail(commit: GitCommitSummary, files: readonly GitFileDiff[]): GitCommitDetail {
  return {
    repositoryId: "repo-1" as never,
    repositoryVersion: "version-1" as never,
    commit,
    selectedParentId: null,
    files,
  };
}

function fileDiff(path: string): GitFileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    binary: false,
    oldMode: null,
    newMode: null,
    additions: 1,
    deletions: 0,
    hunks: [],
    rawPatch: "",
    truncated: false,
  };
}

function commandSucceeded(repositoryId: GitRepositoryId, repositoryVersion: GitRepositoryVersion, summary: string) {
  return {
    operationId: `operation-${summary}`,
    repositoryId,
    repositoryVersion,
    state: "succeeded" as const,
    summary,
    result: { refresh_domains: ["status", "refs"] },
  };
}
