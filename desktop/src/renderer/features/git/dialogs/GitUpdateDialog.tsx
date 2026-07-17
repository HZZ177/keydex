import { useEffect, useRef, useState } from "react";

import type { GitStatusSnapshot } from "@/runtime/gitTypes";

import { GitDialogSummary, GitFormDialog } from "./GitDialogFrame";
import styles from "./GitDialogFrame.module.css";

export type GitUpdateStrategy = "ff_only" | "merge" | "rebase";
type GitUpdateChoice = Exclude<GitUpdateStrategy, "ff_only">;

const UPDATE_STRATEGIES: readonly {
  value: GitUpdateChoice;
  label: string;
  description: string;
}[] = [
  {
    value: "merge",
    label: "将传入更改合并到当前分支",
    description: "保留本地提交；双方都有新提交时，会创建一个合并提交。",
  },
  {
    value: "rebase",
    label: "在传入更改上变基当前分支",
    description: "先应用传入提交，再依次重放本地提交；历史更线性，但会改写本地提交。",
  },
];

export function GitUpdateDialog({
  open,
  status,
  initialStrategy,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
  onOpenBranchSettings,
}: {
  open: boolean;
  status: GitStatusSnapshot | null;
  initialStrategy: GitUpdateStrategy;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (strategy: GitUpdateStrategy) => void | boolean | Promise<void | boolean>;
  onOpenBranchSettings?: () => void;
}) {
  const [strategy, setStrategy] = useState<GitUpdateChoice>(() => updateChoice(initialStrategy));
  const submittingRef = useRef(false);
  const repositoryId = status?.repositoryId ?? null;

  useEffect(() => {
    if (!open) return;
    setStrategy(updateChoice(initialStrategy));
    submittingRef.current = false;
  }, [initialStrategy, open, repositoryId]);

  if (!open) return null;

  const upstream = status?.branch.upstream ?? null;
  const head = status?.branch.head ?? (status?.branch.detachedAt ? `分离指针 ${status.branch.detachedAt.slice(0, 12)}` : "当前分支");
  const dirtyCount = status?.files.length ?? 0;
  const confirm = async () => {
    if (busy || !upstream || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onConfirm(strategy);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <GitFormDialog
      title="更新项目"
      description="“传入更改”指上方显示的上游分支中的新提交。选择如何把它们整合到当前分支。"
      confirmLabel={busy ? "正在更新…" : "更新"}
      busy={busy}
      valid={Boolean(upstream)}
      error={error}
      onCancel={onCancel}
      onSubmit={confirm}
    >
      <GitDialogSummary tone={dirtyCount > 0 ? "warning" : "default"}>
        <strong>{head} {upstream ? `← ${upstream}` : "尚未设置上游"}</strong>
        <span>领先 {status?.branch.ahead ?? 0} · 落后 {status?.branch.behind ?? 0}</span>
        <span>{dirtyCount > 0 ? `${dirtyCount} 个本地改动` : "工作树干净"}</span>
      </GitDialogSummary>

      <fieldset className={`${styles.choiceGroup} ${styles.updateChoiceGroup}`}>
        <legend>更新方式</legend>
        {UPDATE_STRATEGIES.map((option) => (
          <label className={`${styles.choiceOption} ${styles.updateChoiceOption}`} key={option.value}>
            <input
              type="radio"
              name="git-update-strategy"
              value={option.value}
              checked={strategy === option.value}
              disabled={busy}
              onChange={() => setStrategy(option.value)}
            />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </fieldset>
      <p className={styles.updateChoiceHint}>如果当前分支没有本地独有提交，两种方式都会直接更新到上游的最新位置。</p>

      {dirtyCount > 0 ? (
        <GitDialogSummary tone="warning">
          工作区存在本地改动；合并或变基可能失败。Keydex 不会自动储藏。
        </GitDialogSummary>
      ) : null}
      {!upstream ? (
        <GitDialogSummary tone="warning">
          <strong>当前分支没有可用的上游，暂时无法更新。</strong>
          <span>请先在分支区域选择并设置上游分支。</span>
          {onOpenBranchSettings ? (
            <button className={styles.inlineAction} type="button" onClick={onOpenBranchSettings}>前往分支设置</button>
          ) : null}
        </GitDialogSummary>
      ) : null}
    </GitFormDialog>
  );
}

function updateChoice(strategy: GitUpdateStrategy): GitUpdateChoice {
  return strategy === "rebase" ? "rebase" : "merge";
}
