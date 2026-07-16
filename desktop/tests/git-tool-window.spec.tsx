import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  GitToolWindow,
  acquireGitMutationGate,
  amendRequiresStrongConfirmation,
  gitOperationFailureMessage,
  operationControlWarning,
  pushTargetFromStatus,
  releaseGitMutationGate,
} from "@/renderer/features/git/components/GitToolWindow";
import type { GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";
import type { ActiveProjectState } from "@/renderer/features/git/activeProject";

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
  it("preserves readable hook failures from a completed operation", () => {
    expect(gitOperationFailureMessage({
      summary: "commit",
      result: { error: "Keydex policy rejected this commit" },
    })).toBe("Keydex policy rejected this commit");
    expect(gitOperationFailureMessage({ summary: "commit", result: {} })).toBe("commit failed");
    expect(gitOperationFailureMessage({
      summary: "fetch",
      result: {
        error: "Git credentials are unavailable.",
        help_action: "Configure the system credential manager, then retry.",
      },
    })).toBe("Git credentials are unavailable. Configure the system credential manager, then retry.");
    expect(gitOperationFailureMessage({
      summary: "fetch",
      result: {
        error_code: "git_credentials_missing",
        error: "Git credentials are unavailable.",
      },
    })).toContain("Git 凭据不可用：Git credentials are unavailable.");
  });

  it("requires a strong UI confirmation only when amend may rewrite an upstream commit", () => {
    expect(amendRequiresStrongConfirmation(statusWithUpstream(0))).toBe(true);
    expect(amendRequiresStrongConfirmation(statusWithUpstream(1))).toBe(false);
    expect(amendRequiresStrongConfirmation(null)).toBe(false);
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
    expect(operationControlWarning("rebase", "abort", status)).toContain("pre-operation state");
  });

  it("rejects a synchronous duplicate mutation until the first request releases its gate", () => {
    const inFlight = new Set<string>();
    expect(acquireGitMutationGate(inFlight, "stage")).toBe(true);
    expect(acquireGitMutationGate(inFlight, "stage")).toBe(false);
    expect(acquireGitMutationGate(inFlight, "commit")).toBe(true);
    releaseGitMutationGate(inFlight, "stage");
    expect(acquireGitMutationGate(inFlight, "stage")).toBe(true);
  });

  it("renders project-scoped navigation and switches views", () => {
    render(<GitToolWindow project={readyProject} maximized />);

    expect(screen.getByTestId("git-tool-window").dataset.layout).toBe("maximized");
    const changesTab = screen.getByRole("tab", { name: "本地改动" });
    expect(changesTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "本地改动" }).getAttribute("data-view")).toBe("changes");
    changesTab.focus();
    fireEvent.keyDown(changesTab, { key: "ArrowRight" });
    const historyTab = screen.getByRole("tab", { name: "提交历史" });
    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    expect(historyTab.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(historyTab);
    const panel = screen.getByRole("tabpanel", { name: "提交历史" });
    expect(historyTab.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("exposes bounded keyboard-adjustable navigation and detail splitters", () => {
    render(<GitToolWindow project={readyProject} maximized />);

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
    expect(details.getAttribute("aria-valuenow")).toBe("42");
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

function statusWithUpstream(ahead: number): GitStatusSnapshot {
  return {
    repositoryId: "repo-1" as GitRepositoryId,
    repositoryVersion: "v1" as GitRepositoryVersion,
    branch: { head: "main", detachedAt: null, upstream: "origin/main", ahead, behind: 0, unborn: false },
    operation: null,
    files: [],
  };
}
