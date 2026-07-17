import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  gitCompletionNotification,
  GitOperationNotificationBridge,
  useGitErrorNotificationState,
} from "@/renderer/features/git/GitNotifications";
import { createGitStore, type GitStore } from "@/renderer/features/git/store/gitStore";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { GitCommandResult } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git notifications", () => {
  it("routes completed commands to the shared temporary notification viewport", () => {
    const store = createGitStore();
    renderNotificationHarness(store);

    fireEvent.click(screen.getByRole("button", { name: "记录提交完成" }));

    const viewport = screen.getByTestId("notification-viewport");
    const toast = within(viewport).getByTestId("notification-item");
    expect(toast.getAttribute("data-type")).toBe("success");
    expect(toast.textContent).toContain("提交成功 · 1234567890ab");
  });

  it("keeps high-frequency stage changes quiet and announces cancellation", () => {
    const store = createGitStore();
    renderNotificationHarness(store);

    fireEvent.click(screen.getByRole("button", { name: "记录暂存完成" }));
    expect(within(screen.getByTestId("notification-viewport")).queryByTestId("notification-item")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "记录推送取消" }));
    const toast = within(screen.getByTestId("notification-viewport")).getByTestId("notification-item");
    expect(toast.getAttribute("data-type")).toBe("info");
    expect(toast.textContent).toContain("推送已取消");
  });

  it("covers every command family that can surface a completed operation", () => {
    const commands = [
      "apply_patch", "discard", "clean", "commit", "create_branch", "rename_branch", "delete_branch",
      "create_tag", "delete_tag", "checkout", "fetch", "add_remote", "rename_remote", "set_remote_url",
      "remove_remote", "set_upstream", "update", "push", "stash_push", "stash_apply", "stash_pop",
      "stash_branch", "stash_drop", "stash_clear", "merge", "merge_abort", "rebase", "rebase_control",
      "cherry_pick", "cherry_pick_control", "revert", "revert_control", "reset", "restore", "bisect_start",
      "bisect_control", "submodule_action", "worktree_action", "lfs_action", "conflict_action",
    ];

    for (const command of commands) {
      expect(gitCompletionNotification(operation(command, "succeeded")), command).toMatchObject({ type: "success" });
    }
    expect(gitCompletionNotification(operation("stage", "succeeded"))).toBeNull();
    expect(gitCompletionNotification(operation("unstage", "succeeded"))).toBeNull();
    expect(gitCompletionNotification(operation("push", "failed"))).toBeNull();
  });

  it("routes Git errors to the same viewport while retaining dialog-local text", () => {
    render(
      <NotificationProvider>
        <ErrorHarness />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "报告错误" }));

    expect(screen.getByTestId("git-local-error").textContent).toBe("推送失败，请检查远程配置");
    const toast = within(screen.getByTestId("notification-viewport")).getByTestId("notification-item");
    expect(toast.getAttribute("data-type")).toBe("error");
    expect(toast.textContent).toContain("推送失败，请检查远程配置");
  });
});

function renderNotificationHarness(store: GitStore) {
  return render(
    <NotificationProvider>
      <GitOperationNotificationBridge store={store} />
      <button type="button" onClick={() => store.getState().recordOperation(operation("commit", "succeeded"))}>
        记录提交完成
      </button>
      <button type="button" onClick={() => store.getState().recordOperation(operation("stage", "succeeded"))}>
        记录暂存完成
      </button>
      <button type="button" onClick={() => store.getState().recordOperation(operation("push", "cancelled"))}>
        记录推送取消
      </button>
    </NotificationProvider>,
  );
}

function ErrorHarness() {
  const [error, setError] = useGitErrorNotificationState();
  return (
    <>
      <button type="button" onClick={() => setError("推送失败，请检查远程配置")}>报告错误</button>
      <span data-testid="git-local-error">{error}</span>
    </>
  );
}

function operation(command: string, state: GitCommandResult["state"]): GitCommandResult {
  return {
    operationId: `operation-${command}-${state}`,
    repositoryId: "repo-1" as never,
    repositoryVersion: "version-1" as never,
    state,
    summary: command,
    result: command === "commit" ? { oid: "1234567890abcdef" } : {},
    command,
    risk: "write",
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    retryable: false,
    error: null,
  };
}
