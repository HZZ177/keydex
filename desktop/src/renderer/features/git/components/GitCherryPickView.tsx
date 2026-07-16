import { Cherry, GripVertical } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitCommandResult, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitCherryPickView.module.css";

export function GitCherryPickView({
  refs,
  status,
  busy,
  requestedCommits,
  skippedCommits = [],
  outcome,
  onCherryPick,
  onControl,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  busy: boolean;
  requestedCommits: readonly string[];
  skippedCommits?: readonly string[];
  outcome: GitCommandResult | null;
  onCherryPick: (commits: readonly string[], recordOrigin: boolean) => void;
  onControl: (action: "continue" | "skip" | "abort") => void;
}) {
  const [input, setInput] = useState("");
  const [recordOrigin, setRecordOrigin] = useState(false);
  const [pendingControl, setPendingControl] = useState<"skip" | "abort" | null>(null);
  const commits = useMemo(() => parseCherryPickCommits(input), [input]);
  const duplicate = commits.find((commit, index) => commits.indexOf(commit) !== index) ?? null;
  const operation = status?.operation?.kind === "cherry_pick" ? status.operation : null;
  return (
    <section className={styles.root} aria-label="Cherry-pick workflow">
      <header>
        <Cherry size={14} />
        <div><strong>Cherry-pick</strong><span>Apply one or more commits in the exact order listed below.</span></div>
      </header>
      {operation ? (
        <div className={styles.operation} role="status">
          <div><strong>Cherry-pick {operation.state}</strong><span>{operation.currentStep && operation.totalSteps ? `Commit ${operation.currentStep} of ${operation.totalSteps}` : "Resolve the current commit, skip it, or abort the sequence."}</span></div>
          <button type="button" disabled={busy || operation.state === "conflicted"} onClick={() => onControl("continue")}>Continue</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("skip")}>Skip</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("abort")}>Abort</button>
        </div>
      ) : null}
      {pendingControl ? (
        <div className={styles.confirmation} role="alertdialog" aria-label={`Confirm cherry-pick ${pendingControl}`}>
          <strong>{pendingControl === "abort" ? "Abort the cherry-pick sequence?" : "Skip the current cherry-pick commit?"}</strong>
          <span>{pendingControl === "abort" ? "The branch and worktree will return to the pre-sequence state." : "Only the current empty or conflicted commit is omitted; remaining commits continue."}</span>
          <button type="button" onClick={() => { const action = pendingControl; setPendingControl(null); onControl(action); }}>Confirm {pendingControl}</button>
          <button type="button" onClick={() => setPendingControl(null)}>Cancel</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label>
          <span>Commits (one per line, first applied first)</span>
          <textarea
            aria-label="Commits"
            rows={4}
            value={input}
            placeholder={"feature~2\nfeature~1\nfeature"}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <div className={styles.suggestions} aria-label="Commit reference suggestions">{refs.slice(0, 8).map((ref) => <button type="button" key={ref.fullName} disabled={busy} onClick={() => setInput((current) => `${current}${current.trim() ? "\n" : ""}${ref.fullName}`)}>{ref.shortName}</button>)}</div>
        <label className={styles.check}><input type="checkbox" checked={recordOrigin} onChange={(event) => setRecordOrigin(event.target.checked)} />Append origin metadata (-x)</label>
        {duplicate ? <p className={styles.warning} role="alert">Commit {duplicate} appears more than once.</p> : null}
        <button type="button" className={styles.primary} disabled={busy || commits.length === 0 || Boolean(duplicate) || Boolean(operation)} onClick={() => onCherryPick(commits, recordOrigin)}>Cherry-pick commits</button>
      </div>
      {requestedCommits.length > 0 ? (
        <ol className={styles.queue} aria-label="Cherry-pick result queue">
          {requestedCommits.map((commit, index) => {
            const state = cherryPickItemState(commit, index, requestedCommits, status, outcome, skippedCommits);
            return <li key={`${commit}:${index}`} data-state={state}><GripVertical size={12} /><code>{commit.length > 16 ? commit.slice(0, 12) : commit}</code><span>{state}</span></li>;
          })}
        </ol>
      ) : null}
    </section>
  );
}

export function parseCherryPickCommits(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function cherryPickItemState(
  commit: string,
  index: number,
  commits: readonly string[],
  status: GitStatusSnapshot | null,
  outcome: GitCommandResult | null,
  skippedCommits: readonly string[] = [],
): "pending" | "applied" | "conflicted" | "empty" | "failed" | "aborted" {
  if (skippedCommits.some((skipped) => commit === skipped || commit.startsWith(skipped) || skipped.startsWith(commit))) {
    return "empty";
  }
  if (outcome?.state === "succeeded" && !status?.operation) {
    if (outcome.summary.toLowerCase().includes("abort")) return "aborted";
    return "applied";
  }
  const operation = status?.operation?.kind === "cherry_pick" ? status.operation : null;
  if (!operation) return outcome?.state === "failed" ? "failed" : "pending";
  const currentObjectId = operation.currentObjectId;
  const currentIndex = currentObjectId
    ? commits.findIndex((candidate) => candidate === currentObjectId || currentObjectId.startsWith(candidate) || candidate.startsWith(currentObjectId))
    : Math.max(0, (operation.currentStep ?? 1) - 1);
  if (currentIndex >= 0 && index < currentIndex) return "applied";
  if (currentIndex >= 0 && index === currentIndex) return operation.state === "conflicted" ? "conflicted" : "empty";
  return "pending";
}
