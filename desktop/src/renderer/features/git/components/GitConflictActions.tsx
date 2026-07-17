import { Check, RotateCcw, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitConflictFileAction } from "@/runtime/git";
import type { GitConflictFile } from "@/runtime/gitTypes";

import { GitConfirmActionDialog } from "../dialogs";
import styles from "./GitConflictActions.module.css";

export interface GitConflictActionOption {
  action: GitConflictFileAction;
  label: string;
  warning: string;
}

export function conflictActionOptions(file: GitConflictFile): readonly GitConflictActionOption[] {
  const allowed = new Set(file.allowedActions);
  const options: GitConflictActionOption[] = [];
  if (allowed.has("accept_ours") && file.stages.some((stage) => stage.stage === 2)) {
    options.push({ action: "accept_ours", label: "采用当前分支版本", warning: "要用当前分支版本替换工作树结果吗？此路径尚未提交的冲突编辑将丢失。" });
  }
  if (allowed.has("accept_theirs") && file.stages.some((stage) => stage.stage === 3)) {
    options.push({ action: "accept_theirs", label: "采用传入版本", warning: "要用传入版本替换工作树结果吗？此路径尚未提交的冲突编辑将丢失。" });
  }
  if (allowed.has("keep_modified")) {
    options.push({ action: "keep_modified", label: "保留修改后的文件", warning: "要使用保留下来的修改版本替换当前工作树结果吗？" });
  }
  if (allowed.has("accept_delete")) {
    options.push({ action: "accept_delete", label: "接受删除", warning: `要删除 ${file.path}，并将这次删除暂存为冲突解决结果吗？` });
  } else if (allowed.has("delete")) {
    options.push({ action: "delete", label: "删除路径", warning: `要删除 ${file.path}，并将这次删除暂存为冲突解决结果吗？` });
  }
  return options;
}

export function GitConflictActions({
  file,
  dirty,
  unresolvedBlocks,
  busy,
  recentlyResolvedPath,
  onAction,
  onReopen,
}: {
  file: GitConflictFile | null;
  dirty: boolean;
  unresolvedBlocks: number;
  busy: boolean;
  recentlyResolvedPath?: string | null;
  onAction: (action: GitConflictFileAction) => void;
  onReopen?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<GitConflictActionOption | null>(null);
  useEffect(() => setPendingAction(null), [file?.path, file?.resultRevision]);
  if (!file && !recentlyResolvedPath) return null;
  return (
    <section className={styles.root} aria-label="冲突解决操作">
      {file ? (
        <>
          <header><ShieldAlert size={13} /><strong>解决 {file.path}</strong></header>
          <div className={styles.actions}>{conflictActionOptions(file).map((option) => (
            <button
              type="button"
              key={option.action}
              disabled={busy}
              onClick={() => setPendingAction(option)}
            >{option.label}</button>
          ))}</div>
          <button
            type="button"
            className={styles.resolve}
            disabled={busy || dirty || unresolvedBlocks > 0}
            title={dirty ? "请先保存结果，再标记为已解决" : unresolvedBlocks ? "请先解决所有冲突标记块" : "将此结果添加到暂存区"}
            onClick={() => onAction("mark_resolved")}
          ><Check size={13} />标记为已解决并暂存</button>
          {dirty || unresolvedBlocks > 0 ? <p>{dirty ? "请先保存工作树结果，再进行暂存。" : `仍有 ${unresolvedBlocks} 个冲突标记块尚未解决。`}</p> : null}
        </>
      ) : null}
      {recentlyResolvedPath && onReopen ? (
        <button type="button" className={styles.reopen} disabled={busy} onClick={onReopen}><RotateCcw size={13} />重新打开 {recentlyResolvedPath}</button>
      ) : null}
      {file && pendingAction ? (
        <GitConfirmActionDialog
          title={`确认${pendingAction.label}`}
          description={pendingAction.warning}
          target={file.path}
          details={[
            conflictActionEffect(pendingAction.action),
            `冲突类型：${file.kind}`,
            ...(file.resultBinary ? ["这是二进制文件，无法在文本编辑器中恢复未保存内容。"] : []),
          ]}
          confirmLabel={`确认${pendingAction.label}`}
          busy={busy}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => { const action = pendingAction.action; setPendingAction(null); onAction(action); }}
        />
      ) : null}
    </section>
  );
}

function conflictActionEffect(action: GitConflictFileAction): string {
  return ({
    accept_ours: "采用当前分支一侧，并覆盖工作树中的当前结果。",
    accept_theirs: "采用传入分支一侧，并覆盖工作树中的当前结果。",
    keep_modified: "保留仍存在的修改版本，并将它作为解决结果。",
    accept_delete: "接受删除一侧，该路径会从工作树删除并暂存。",
    delete: "删除该路径并将删除暂存为解决结果。",
    mark_resolved: "将当前结果暂存为已解决。",
    reopen: "重新打开已解决路径。",
  })[action];
}
