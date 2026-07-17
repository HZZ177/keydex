import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitToolWindow,
  gitChangesDetailSurface,
  gitOperationFailureMessage,
  operationControlWarning,
  pushTargetFromStatus,
} from "@/renderer/features/git/components/GitToolWindow";
import type { GitConflictFile, GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";
import type { ActiveProjectState } from "@/renderer/features/git/activeProject";
import type { Workspace } from "@/types/protocol";

afterEach(cleanup);

const readyProject: ActiveProjectState = {
  status: "ready",
  workspaceId: "workspace-1",
  projectPath: "D:/repo",
  name: "repo",
  selectedRepoId: "repo-1",
  repoRoots: [
    { id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" },
  ],
};

describe("GitToolWindow", () => {
  it("keeps the merge editor, read-only conflict diff, and ordinary change diff mutually exclusive", () => {
    expect(gitChangesDetailSurface(null)).toBe("change_diff");
    expect(gitChangesDetailSurface(conflictFile({ editable: true }))).toBe("merge_editor");
    expect(gitChangesDetailSurface(conflictFile({ editable: false, resultBinary: true }))).toBe("conflict_diff");
    expect(gitChangesDetailSurface(conflictFile({ editable: false, resultTooLarge: true }))).toBe("conflict_diff");
  });

  it("preserves readable hook failures from a completed operation", () => {
    expect(gitOperationFailureMessage({
      summary: "commit",
      result: { error: "Keydex policy rejected this commit" },
    })).toBe("远程拒绝了此次更新，请先获取远程改动后再试。");
    expect(gitOperationFailureMessage({ summary: "commit", result: {} })).toBe("Git 操作失败。");
    expect(gitOperationFailureMessage({
      summary: "fetch",
      result: {
        error: "Git credentials are unavailable.",
        help_action: "Configure the system credential manager, then retry.",
      },
    })).toBe("远程仓库认证失败，请先配置可用凭据。");
    expect(gitOperationFailureMessage({
      summary: "fetch",
      result: {
        error_code: "git_credentials_missing",
        error: "Git credentials are unavailable.",
      },
    })).toBe("Git 凭据不可用：远程仓库认证失败，请先配置可用凭据。 在系统凭据管理器或外部 Git 客户端中配置凭据后重试。");
  });

  it("derives an explicit push target and rejects detached/no-upstream states", () => {
    expect(pushTargetFromStatus(statusWithUpstream(1))).toEqual({
      remote: "origin",
      branch: "main",
      target: "main",
      upstream: "origin/main",
    });
    expect(pushTargetFromStatus({
      ...statusWithUpstream(0),
      branch: { ...statusWithUpstream(0).branch, upstream: null },
    })).toBeNull();
    expect(pushTargetFromStatus({
      ...statusWithUpstream(0),
      branch: { ...statusWithUpstream(0).branch, head: null, detachedAt: "abc" as never },
    })).toBeNull();
  });

  it("describes skip/abort data loss with affected worktree paths", () => {
    const status: GitStatusSnapshot = {
      ...statusWithUpstream(0),
      operation: {
        kind: "rebase",
        state: "conflicted",
        currentStep: 1,
        totalSteps: 2,
        currentObjectId: "abcdef1234567890" as never,
      },
      files: [{
        path: "src/conflict.ts",
        originalPath: null,
        indexStatus: "conflicted",
        worktreeStatus: "conflicted",
        conflicted: true,
        binary: false,
        submodule: false,
      }],
    };
    expect(operationControlWarning("rebase", "skip", status)).toContain("abcdef123456");
    expect(operationControlWarning("rebase", "skip", status)).toContain("src/conflict.ts");
    expect(operationControlWarning("rebase", "abort", status)).toContain("恢复操作前状态");
  });

  it("renders project-scoped navigation and switches views", () => {
    render(<GitToolWindow project={readyProject} maximized />);

    expect(screen.getByTestId("git-tool-window").dataset.layout).toBe("maximized");
    expect(screen.getByTestId("git-project-name").textContent).toBe("repo");
    expect(screen.queryByText(".")).toBeNull();
    const changesTab = screen.getByRole("tab", { name: "提交" });
    expect(changesTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("git-pane-header")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Git 仓库导航" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整 Git 仓库导航宽度" })).toBeNull();
    const commitPaneSplitter = screen.getByRole("separator", { name: "调整提交面板宽度" });
    expect(commitPaneSplitter.getAttribute("aria-valuenow")).toBe("28");
    fireEvent.keyDown(commitPaneSplitter, { key: "ArrowRight" });
    expect(commitPaneSplitter.getAttribute("aria-valuenow")).toBe("30");
    const commitEditorSplitter = screen.getByRole("separator", { name: "调整提交说明区域高度" });
    expect(commitEditorSplitter.getAttribute("aria-valuenow")).toBe("34");
    fireEvent.keyDown(commitEditorSplitter, { key: "ArrowUp" });
    expect(commitEditorSplitter.getAttribute("aria-valuenow")).toBe("36");
    expect(screen.queryByText("Git 数据加载后显示在这里")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看逐行历史" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: "Blame" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Reflog" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "操作" })).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "提交" }).getAttribute("data-view")).toBe("changes");
    expect(screen.getByRole("complementary", { name: "Git 详情" }).getAttribute("data-detail-surface"))
      .toBe("change_diff");
    changesTab.focus();
    fireEvent.keyDown(changesTab, { key: "ArrowRight" });
    const historyTab = screen.getByRole("tab", { name: "Git 日志" });
    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("separator", { name: "调整 Git 详情宽度" }).getAttribute("aria-valuenow")).toBe("28");
    expect(screen.getByRole("complementary", { name: "Git 仓库导航" })).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整 Git 仓库导航宽度" })).not.toBeNull();
    expect(historyTab.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(historyTab);
    const panel = screen.getByRole("tabpanel", { name: "Git 日志" });
    expect(historyTab.getAttribute("aria-controls")).toBe(panel.id);
    expect(screen.queryByTestId("git-pane-header")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多 Git 视图" }));
    expect(screen.getByRole("menuitem", { name: /暂存的改动/ })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /恢复提交/ })).not.toBeNull();
    const advanced = screen.getByRole("menuitem", { name: /高级 Git 工具/ });
    fireEvent.click(advanced);
    expect(screen.queryByRole("menu", { name: "更多 Git 视图" })).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "高级 Git 工具" }).getAttribute("data-view")).toBe("operations");
  });

  it("retains controller state while releasing the hidden Git DOM", () => {
    const { rerender } = render(<GitToolWindow project={readyProject} maximized active />);
    fireEvent.click(screen.getByRole("tab", { name: "Git 日志" }));
    expect(screen.getByRole("tab", { name: "Git 日志" }).getAttribute("aria-selected")).toBe("true");

    rerender(<GitToolWindow project={readyProject} maximized active={false} />);
    expect(screen.queryByTestId("git-tool-window")).toBeNull();

    rerender(<GitToolWindow project={readyProject} maximized active />);
    expect(screen.getByRole("tab", { name: "Git 日志" }).getAttribute("aria-selected")).toBe("true");
  });

  it("uses the shared workspace selector to switch the Git project", () => {
    const current = workspace("workspace-1", "repo");
    const target = workspace("workspace-2", "other-repo");
    const onSelectWorkspace = vi.fn();
    render(
      <GitToolWindow
        project={readyProject}
        maximized
        projectSelector={{
          value: { type: "workspace", workspace: current },
          workspaces: [current, target],
          onSelectWorkspace,
        }}
      />,
    );

    expect(screen.getByTestId("git-project-name").textContent).toContain("repo");
    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("option", { name: /other-repo/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith(target);
  });

  it("exposes bounded keyboard-adjustable navigation and detail splitters", () => {
    render(<GitToolWindow project={readyProject} maximized initialView="history" />);

    const navigation = screen.getByRole("separator", { name: "调整 Git 仓库导航宽度" });
    const details = screen.getByRole("separator", { name: "调整 Git 详情宽度" });
    expect(navigation.getAttribute("aria-valuenow")).toBe("19");
    expect(details.getAttribute("aria-valuenow")).toBe("28");

    fireEvent.keyDown(navigation, { key: "ArrowRight" });
    expect(navigation.getAttribute("aria-valuenow")).toBe("21");
    fireEvent.keyDown(navigation, { key: "Home" });
    expect(navigation.getAttribute("aria-valuenow")).toBe("12");
    fireEvent.keyDown(details, { key: "ArrowLeft" });
    expect(details.getAttribute("aria-valuenow")).toBe("30");
    fireEvent.keyDown(details, { key: "End" });
    expect(details.getAttribute("aria-valuemax")).toBe("60");
    expect(details.getAttribute("aria-valuenow")).toBe("60");
  });

  it("resizes both visible panes from pointer movement instead of only changing hover state", () => {
    render(<GitToolWindow project={readyProject} maximized initialView="history" />);

    const workspace = screen.getByTestId("git-workspace");
    Object.defineProperty(workspace, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 100, right: 1100, top: 0, bottom: 600, width: 1000, height: 600, x: 100, y: 0, toJSON: () => ({}) }),
    });
    const navigation = screen.getByRole("separator", { name: "调整 Git 仓库导航宽度" });
    const details = screen.getByRole("separator", { name: "调整 Git 详情宽度" });

    fireEvent(navigation, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 290 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 340 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientX: 340 }));
    expect(navigation.getAttribute("aria-valuenow")).toBe("24");

    fireEvent(details, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 820 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 760 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientX: 760 }));
    expect(details.getAttribute("aria-valuenow")).toBe("34");
  });

  it("lets the commit pane extend to eighty percent of the Git workspace", () => {
    render(<GitToolWindow project={readyProject} maximized />);

    const splitter = screen.getByRole("separator", { name: "调整提交面板宽度" });
    expect(splitter.getAttribute("aria-valuemax")).toBe("80");

    fireEvent.keyDown(splitter, { key: "End" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("80");

    fireEvent.keyDown(splitter, { key: "Home" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("18");
  });

  it("resizes the commit editor from vertical pointer movement", () => {
    render(<GitToolWindow project={readyProject} maximized />);

    const workspace = screen.getByTestId("git-changes-workspace");
    Object.defineProperty(workspace, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 800, top: 100, bottom: 700, width: 800, height: 600, x: 0, y: 100, toJSON: () => ({}) }),
    });
    const splitter = screen.getByRole("separator", { name: "调整提交说明区域高度" });

    fireEvent(splitter, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 496 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientY: 400 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientY: 400 }));
    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
  });

  it.each([
    [{ status: "loading", workspaceId: "w", projectPath: "D:/repo", name: "repo", selectedRepoId: null }, "正在读取 Git 仓库"],
    [{ status: "non_repo", workspaceId: "w", projectPath: "D:/repo", name: "repo", selectedRepoId: null }, "当前项目不是 Git 仓库"],
    [{ status: "error", workspaceId: "w", projectPath: "D:/repo", name: "repo", selectedRepoId: null, errorCode: "failed", message: "broken" }, "Git 仓库加载失败"],
  ] as const)("renders the %s shell state", (project, title) => {
    render(<GitToolWindow project={project as ActiveProjectState} maximized={false} />);
    expect(screen.getByText(title)).not.toBeNull();
  });
});

function conflictFile(overrides: Partial<GitConflictFile>): GitConflictFile {
  return {
    path: "src/conflict.ts",
    relatedPaths: [],
    kind: "both_modified",
    stages: [{
      stage: 2,
      label: "ours",
      objectId: "a".repeat(40) as GitConflictFile["stages"][number]["objectId"],
      mode: "100644",
      size: 3,
      content: "ours\n",
      binary: false,
      encoding: "utf-8",
      eol: "lf",
      tooLarge: false,
    }],
    resultContent: "ours\n",
    resultBinary: false,
    resultEncoding: "utf-8",
    resultEol: "lf",
    resultTooLarge: false,
    resultRevision: "revision-1",
    allowedActions: ["edit"],
    editable: true,
    ...overrides,
  };
}

function statusWithUpstream(ahead: number): GitStatusSnapshot {
  return {
    repositoryId: "repo-1" as GitRepositoryId,
    repositoryVersion: "v1" as GitRepositoryVersion,
    branch: { head: "main", detachedAt: null, upstream: "origin/main", ahead, behind: 0, unborn: false },
    operation: null,
    files: [],
  };
}

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    root_path: `D:/work/${name}`,
    normalized_root_path: `D:/work/${name}`,
    type: "local",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    last_opened_at: null,
    archived_at: null,
  };
}
