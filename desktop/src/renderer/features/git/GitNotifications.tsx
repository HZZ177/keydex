import { useCallback, useEffect, useState } from "react";

import type { GitStore } from "@/renderer/features/git/store/gitStore";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { GitCommandResult } from "@/runtime/gitTypes";

export interface GitCompletionNotification {
  type: "success" | "info";
  message: string;
}

/**
 * Routes terminal Git command feedback through the application notification
 * viewport. Stage/unstage are intentionally quiet because their checked state
 * is already immediate feedback and a toast for every checkbox would be noisy.
 */
export function GitOperationNotificationBridge({ store }: { store: GitStore }) {
  const notifications = useNotifications();

  useEffect(() => store.subscribe((state, previousState) => {
    if (state.operations === previousState.operations) return;
    for (const operationId of state.operationIds) {
      const operation = state.operations[operationId];
      const previous = previousState.operations[operationId];
      if (!operation || operation === previous || operation.state === previous?.state) continue;
      const notification = gitCompletionNotification(operation);
      if (!notification) continue;
      notifications[notification.type](notification.message);
    }
  }), [notifications, store]);

  return null;
}

/**
 * Keeps dialog-local error text available for correction while also sending
 * the same failure through the shared temporary notification channel.
 */
export function useGitErrorNotificationState(): [
  string | null,
  (message: string | null) => void,
] {
  const notifications = useNotifications();
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = useCallback((next: string | null) => {
    setMessageState(next);
    if (next) notifications.error(next);
  }, [notifications]);
  return [message, setMessage];
}

export function gitCompletionNotification(
  operation: GitCommandResult,
): GitCompletionNotification | null {
  if (operation.state === "cancelled") {
    return { type: "info", message: `${gitCommandLabel(operation.command)}已取消` };
  }
  if (operation.state !== "succeeded" || operation.command === "stage" || operation.command === "unstage") {
    return null;
  }
  return { type: "success", message: gitSuccessMessage(operation) };
}

function gitSuccessMessage(operation: GitCommandResult): string {
  const result = operation.result;
  switch (operation.command) {
    case "apply_patch":
      return result.check_only === true ? "补丁检查通过" : "补丁应用完成";
    case "discard":
      return "已丢弃所选文件的本地改动";
    case "clean":
      return "已删除所选未跟踪文件";
    case "commit": {
      const oid = typeof result.oid === "string" ? result.oid.slice(0, 12) : "";
      return oid ? `提交成功 · ${oid}` : "提交成功";
    }
    case "create_branch":
      return "分支已创建并签出";
    case "rename_branch":
      return "分支重命名完成";
    case "delete_branch":
      return "分支删除完成";
    case "create_tag":
      return "标签创建完成";
    case "delete_tag":
      return "标签删除完成";
    case "checkout":
      return "签出完成";
    case "fetch":
      return "远程数据获取完成";
    case "add_remote":
      return "远程仓库添加完成";
    case "rename_remote":
      return "远程仓库重命名完成";
    case "set_remote_url":
      return "远程仓库地址更新完成";
    case "remove_remote":
      return "远程仓库移除完成";
    case "set_upstream":
      return "上游分支设置完成";
    case "update":
      return result.status === "up_to_date" ? "项目已是最新状态" : "项目更新完成";
    case "push":
      return "推送完成";
    case "stash_push":
      return "本地改动已储藏";
    case "stash_apply":
      return "储藏应用完成";
    case "stash_pop":
      return "储藏弹出完成";
    case "stash_branch":
      return "已从储藏创建分支";
    case "stash_drop":
      return "储藏删除完成";
    case "stash_clear":
      return "储藏清理完成";
    case "merge":
      return "合并完成";
    case "merge_abort":
      return "合并已中止";
    case "rebase":
      return "变基完成";
    case "rebase_control":
      return "变基操作完成";
    case "cherry_pick":
      return "拣选完成";
    case "cherry_pick_control":
      return "拣选操作完成";
    case "revert":
      return "还原提交完成";
    case "revert_control":
      return "还原提交操作完成";
    case "reset":
      return "重置完成";
    case "restore":
      return "路径还原完成";
    case "bisect_start":
      return "二分定位已开始";
    case "bisect_control":
      return "二分定位操作完成";
    case "submodule_action":
      return "子模块操作完成";
    case "worktree_action":
      return "工作树操作完成";
    case "lfs_action":
      return "Git LFS 操作完成";
    case "conflict_action":
      return "冲突处理完成";
    default:
      return "Git 操作完成";
  }
}

function gitCommandLabel(command: string): string {
  const labels: Record<string, string> = {
    fetch: "获取远程数据",
    update: "更新项目",
    push: "推送",
    commit: "提交",
    merge: "合并",
    rebase: "变基",
    cherry_pick: "拣选",
    revert: "还原提交",
  };
  return labels[command] ?? "Git 操作";
}
