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
    <section className={styles.root} aria-label="Recovered Git operation" data-kind={operation.kind} data-state={operation.state}>
      <div><strong>Recovered {operation.kind.replace("_", " ")}</strong><span>{operation.state}{operation.currentStep && operation.totalSteps ? ` · step ${operation.currentStep}/${operation.totalSteps}` : ""}. Repository metadata is the source of truth.</span></div>
      <div className={styles.actions}>{actions.map((action) => <button type="button" key={action.id} disabled={busy || !action.enabled} onClick={() => action.id === "skip" || action.id === "abort" ? setPendingAction(action.id) : onAction(action.id)}>{action.label}</button>)}</div>
      {pendingAction ? (
        <div className={styles.confirmation} role="alertdialog" aria-label={`Confirm recovered operation ${pendingAction}`}>
          <strong>{pendingAction === "abort" ? "Abort the recovered operation?" : "Skip the current recovered step?"}</strong>
          <span>Repository metadata remains the source of truth; this action is sent to the active {operation.kind.replace("_", " ")} operation.</span>
          <button type="button" onClick={() => { const action = pendingAction; setPendingAction(null); onAction(action); }}>Confirm {pendingAction}</button>
          <button type="button" onClick={() => setPendingAction(null)}>Cancel</button>
        </div>
      ) : null}
    </section>
  );
}

export function recoveryActions(operation: GitInProgressOperation): readonly { id: GitRecoveryAction; label: string; enabled: boolean }[] {
  const conflicted = operation.state === "conflicted";
  if (operation.kind === "merge") return conflicted
    ? [{ id: "resolve", label: "Resolve conflicts", enabled: true }, { id: "abort", label: "Abort merge", enabled: true }]
    : [{ id: "complete", label: "Complete merge", enabled: true }, { id: "abort", label: "Abort merge", enabled: true }];
  if (operation.kind === "rebase" || operation.kind === "cherry_pick" || operation.kind === "revert") return [
    ...(conflicted ? [{ id: "resolve" as const, label: "Resolve conflicts", enabled: true }] : [{ id: "continue" as const, label: "Continue", enabled: true }]),
    { id: "skip", label: "Skip", enabled: true },
    { id: "abort", label: "Abort", enabled: true },
  ];
  if (operation.kind === "stash_apply") return [{ id: "resolve", label: "Resolve stash conflicts", enabled: true }];
  return [];
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
  if (!next) throw new Error(`Illegal Git recovery transition: ${state} + ${event}`);
  return next;
}
