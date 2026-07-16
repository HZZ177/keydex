import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitCommandResult, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import { parseCherryPickCommits } from "./GitCherryPickView";
import styles from "./GitRevertView.module.css";

export function GitRevertView({
  refs,
  status,
  busy,
  requestedCommits,
  outcome,
  onRevert,
  onControl,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  busy: boolean;
  requestedCommits: readonly string[];
  outcome: GitCommandResult | null;
  onRevert: (commits: readonly string[], mainline: number | null) => void;
  onControl: (action: "continue" | "skip" | "abort") => void;
}) {
  const [input, setInput] = useState("");
  const [mainline, setMainline] = useState("");
  const [pendingControl, setPendingControl] = useState<"skip" | "abort" | null>(null);
  const commits = useMemo(() => parseCherryPickCommits(input), [input]);
  const duplicate = commits.find((commit, index) => commits.indexOf(commit) !== index) ?? null;
  const parsedMainline = mainline.trim() ? Number(mainline) : null;
  const invalidMainline = parsedMainline !== null && (!Number.isInteger(parsedMainline) || parsedMainline < 1 || parsedMainline > 64);
  const operation = status?.operation?.kind === "revert" ? status.operation : null;
  return (
    <section className={styles.root} aria-label="Revert workflow">
      <header><RotateCcw size={14} /><div><strong>Revert</strong><span>Create new commits that undo selected commits. Existing history is not moved or deleted.</span></div></header>
      {operation ? (
        <div className={styles.operation} role="status">
          <div><strong>Revert {operation.state}</strong><span>Resolve the current commit, skip it, or abort the uncommitted sequence.</span></div>
          <button type="button" disabled={busy || operation.state === "conflicted"} onClick={() => onControl("continue")}>Continue revert</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("skip")}>Skip revert</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("abort")}>Abort revert</button>
        </div>
      ) : null}
      {pendingControl ? (
        <div className={styles.confirmation} role="alertdialog" aria-label={`Confirm revert ${pendingControl}`}>
          <strong>{pendingControl === "abort" ? "Abort the revert sequence?" : "Skip the current revert commit?"}</strong>
          <span>{pendingControl === "abort" ? "Uncommitted revert changes will be discarded and the starting HEAD restored." : "The current revert is omitted; remaining commits continue."}</span>
          <button type="button" onClick={() => { const action = pendingControl; setPendingControl(null); onControl(action); }}>Confirm {pendingControl}</button>
          <button type="button" onClick={() => setPendingControl(null)}>Cancel</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label><span>Commits (one per line, reverted in listed order)</span><textarea aria-label="Commits to revert" rows={4} value={input} onChange={(event) => setInput(event.target.value)} /></label>
        <div className={styles.suggestions} aria-label="Revert reference suggestions">{refs.slice(0, 8).map((ref) => <button type="button" key={ref.fullName} disabled={busy} onClick={() => setInput((current) => `${current}${current.trim() ? "\n" : ""}${ref.fullName}`)}>{ref.shortName}</button>)}</div>
        <label><span>Mainline parent (required for merge commits)</span><input aria-label="Mainline parent" type="number" min={1} max={64} step={1} value={mainline} placeholder="1" onChange={(event) => setMainline(event.target.value)} /></label>
        <p className={styles.note}>For a merge commit, choose the parent whose history should be kept (usually 1). Keydex never guesses this value.</p>
        {duplicate ? <p className={styles.warning} role="alert">Commit {duplicate} appears more than once.</p> : null}
        {invalidMainline ? <p className={styles.warning} role="alert">Mainline parent must be an integer from 1 to 64.</p> : null}
        <button type="button" className={styles.primary} disabled={busy || commits.length === 0 || Boolean(duplicate) || invalidMainline || Boolean(operation)} onClick={() => onRevert(commits, parsedMainline)}>Create revert commits</button>
      </div>
      {requestedCommits.length ? (
        <ol className={styles.queue} aria-label="Revert result queue">{requestedCommits.map((commit, index) => {
          const state = revertItemState(commit, index, requestedCommits, status, outcome);
          return <li key={`${commit}:${index}`} data-state={state}><code>{commit.length > 16 ? commit.slice(0, 12) : commit}</code><span>{state}</span></li>;
        })}</ol>
      ) : null}
    </section>
  );
}

export function revertItemState(
  commit: string,
  index: number,
  commits: readonly string[],
  status: GitStatusSnapshot | null,
  outcome: GitCommandResult | null,
): "pending" | "reverted" | "conflicted" | "empty" | "failed" | "aborted" {
  if (outcome?.state === "succeeded" && !status?.operation) {
    if (outcome.summary.toLowerCase().includes("abort")) return "aborted";
    return "reverted";
  }
  const operation = status?.operation?.kind === "revert" ? status.operation : null;
  if (!operation) return outcome?.state === "failed" ? "failed" : "pending";
  const currentObjectId = operation.currentObjectId;
  const currentIndex = currentObjectId
    ? commits.findIndex((candidate) => candidate === currentObjectId || currentObjectId.startsWith(candidate) || candidate.startsWith(currentObjectId))
    : Math.max(0, (operation.currentStep ?? 1) - 1);
  if (currentIndex >= 0 && index < currentIndex) return "reverted";
  if (currentIndex >= 0 && index === currentIndex) return operation.state === "conflicted" ? "conflicted" : "empty";
  return "pending";
}
