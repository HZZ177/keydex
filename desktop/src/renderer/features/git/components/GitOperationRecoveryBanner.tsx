import type { GitInProgressOperation } from "@/runtime/gitTypes";
import { useState } from "react";

import styles from "./GitOperationRecoveryBanner.module.css";

export type GitRecoveryAction = "resolve" | "continue" | "skip" | "abort" | "complete";
export type GitRecoveryUiState = "idle" | "running" | "conflicted" | "continuable" | "aborting";
export type GitRecoveryUiEvent = "detect" | "conflict" | "resolve" | "continue" | "abort" | "complete" | "failure";

export function GitOperationRecoveryBanner({
  operation,
  busy,
  onAction,
}: {
  operation: GitInProgressOperation | null;
  busy: boolean;
  onAction: (action: GitRecoveryAction) => void;
}) {
  const [pendingAction, setPendingAction] = useState<"skip" | "abort" | null>(null);
  if (!operation) return null;
  const actions = recoveryActions(operation);
  return (
    <section className={styles.root} aria-label="已恢复的 Git 操作" data-kind={operation.kind} data-state={operation.state}>
      <div><strong>已恢复{operationKindLabel(operation.kind)}</strong><span>{operationStateLabel(operation.state)}{operation.currentStep && operation.totalSteps ? ` · 第 ${operation.currentStep}/${operation.totalSteps} 步` : ""}。仓库元数据是当前状态的判断依据。</span></div>
      <div className={styles.actions}>{actions.map((action) => <button type="button" key={action.id} disabled={busy || !action.enabled} onClick={() => action.id === "skip" || action.id === "abort" ? setPendingAction(action.id) : onAction(action.id)}>{action.label}</button>)}</div>
      {pendingAction ? (
        <div className={styles.confirmation} role="alertdialog" aria-label="确认恢复操作">
          <strong>{pendingAction === "abort" ? "要中止已恢复的操作吗？" : "要跳过当前步骤吗？"}</strong>
          <span>仓库元数据仍是当前状态的判断依据；此操作将发送到正在进行的{operationKindLabel(operation.kind)}任务。</span>
          <button type="button" onClick={() => { const action = pendingAction; setPendingAction(null); onAction(action); }}>{pendingAction === "abort" ? "确认中止" : "确认跳过"}</button>
          <button type="button" onClick={() => setPendingAction(null)}>取消</button>
        </div>
      ) : null}
    </section>
  );
}

export function recoveryActions(operation: GitInProgressOperation): readonly { id: GitRecoveryAction; label: string; enabled: boolean }[] {
  const conflicted = operation.state === "conflicted";
  if (operation.kind === "merge") return conflicted
    ? [{ id: "resolve", label: "解决冲突", enabled: true }, { id: "abort", label: "中止合并", enabled: true }]
    : [{ id: "complete", label: "完成合并", enabled: true }, { id: "abort", label: "中止合并", enabled: true }];
  if (operation.kind === "rebase" || operation.kind === "cherry_pick" || operation.kind === "revert") return [
    ...(conflicted ? [{ id: "resolve" as const, label: "解决冲突", enabled: true }] : [{ id: "continue" as const, label: "继续", enabled: true }]),
    { id: "skip", label: "跳过", enabled: true },
    { id: "abort", label: "中止", enabled: true },
  ];
  if (operation.kind === "stash_apply") return [{ id: "resolve", label: "解决储藏应用冲突", enabled: true }];
  return [];
}

function operationKindLabel(kind: GitInProgressOperation["kind"]): string {
  return ({ merge: "合并", rebase: "变基", cherry_pick: "摘取提交", revert: "反向提交", stash_apply: "储藏应用" } as Record<GitInProgressOperation["kind"], string>)[kind];
}

function operationStateLabel(state: GitInProgressOperation["state"]): string {
  return ({ running: "执行中", conflicted: "存在冲突", continuable: "可以继续" } as Partial<Record<GitInProgressOperation["state"], string>>)[state] ?? "等待处理";
}

export function transitionRecoveryUi(state: GitRecoveryUiState, event: GitRecoveryUiEvent): GitRecoveryUiState {
  const transitions: Partial<Record<GitRecoveryUiEvent, GitRecoveryUiState>> = state === "idle"
    ? { detect: "running" }
    : state === "running"
      ? { conflict: "conflicted", complete: "idle", failure: "continuable", abort: "aborting" }
      : state === "conflicted"
        ? { resolve: "continuable", complete: "idle", abort: "aborting" }
        : state === "continuable"
          ? { continue: "running", conflict: "conflicted", complete: "idle", abort: "aborting" }
          : { complete: "idle", failure: "continuable" };
  const next = transitions[event];
  if (!next) throw new Error(`非法的 Git 恢复状态转换：${state} + ${event}`);
  return next;
}
