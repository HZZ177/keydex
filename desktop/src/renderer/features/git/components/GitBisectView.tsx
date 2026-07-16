import { Binary, RotateCcw, Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitBisectSnapshot, GitObjectId } from "@/runtime/gitTypes";

import styles from "./GitBisectView.module.css";

export function GitBisectView({
  snapshot,
  loading,
  busy,
  revisions,
  onStart,
  onControl,
  onOpenHistory,
}: {
  snapshot: GitBisectSnapshot | null;
  loading: boolean;
  busy: boolean;
  revisions: readonly string[];
  onStart: (good: string, bad: string) => void;
  onControl: (action: "good" | "bad" | "skip" | "reset") => void;
  onOpenHistory: (objectId: GitObjectId) => void;
}) {
  const [good, setGood] = useState("");
  const [bad, setBad] = useState("HEAD");
  const [pendingStart, setPendingStart] = useState(false);
  useEffect(() => {
    if (!good && revisions.length) setGood(revisions.find((ref) => ref !== "HEAD") ?? revisions[0]);
  }, [good, revisions]);
  return (
    <section className={styles.root} aria-label="Git bisect assistant">
      <header><Binary size={14} /><div><strong>Bisect assistant</strong><span>Manually classify each checked-out revision. Keydex never runs a user test command automatically.</span></div></header>
      {loading ? <p>Loading bisect state…</p> : snapshot?.active ? (
        <>
          <div className={styles.summary}>
            <span>Current <code>{short(snapshot.currentRevision)}</code></span>
            <span>Remaining <strong>{snapshot.remainingCount}</strong></span>
            <span>Good {snapshot.goodRevisions.length}</span>
            <span>Skipped {snapshot.skippedRevisions.length}</span>
          </div>
          {snapshot.culpritRevision ? (
            <div className={styles.culprit}><Search size={14} /><span>First bad commit <code>{snapshot.culpritRevision}</code></span><button type="button" onClick={() => onOpenHistory(snapshot.culpritRevision!)}>Open in history</button></div>
          ) : (
            <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={() => onControl("good")}>Mark good</button>
              <button type="button" disabled={busy} onClick={() => onControl("bad")}>Mark bad</button>
              <button type="button" disabled={busy} onClick={() => onControl("skip")}>Skip revision</button>
            </div>
          )}
          <div className={styles.candidates}><strong>Candidate range</strong><ol>{snapshot.candidateRevisions.slice(0, 12).map((revision) => <li key={revision} data-current={revision === snapshot.currentRevision ? "true" : "false"}><code>{revision}</code></li>)}</ol>{snapshot.remainingCount > 12 ? <span>+ {snapshot.remainingCount - 12} more</span> : null}</div>
          <button type="button" className={styles.reset} disabled={busy} onClick={() => onControl("reset")}><RotateCcw size={13} />Reset bisect</button>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); if (good.trim() && bad.trim()) setPendingStart(true); }}>
          <label>Known good<input aria-label="Known good revision" list="git-bisect-revisions" value={good} onChange={(event) => setGood(event.target.value)} /></label>
          <label>Known bad<input aria-label="Known bad revision" list="git-bisect-revisions" value={bad} onChange={(event) => setBad(event.target.value)} /></label>
          <datalist id="git-bisect-revisions">{revisions.map((revision) => <option key={revision} value={revision} />)}</datalist>
          <button type="submit" disabled={busy || !good.trim() || !bad.trim()}>Start bisect</button>
          {pendingStart ? (
            <div className={styles.confirmation} role="alertdialog" aria-label="Confirm bisect start">
              <strong>Start bisect from {good.trim()} (good) to {bad.trim()} (bad)?</strong>
              <span>Git will temporarily check out candidate commits; Reset bisect restores the original branch.</span>
              <button type="button" onClick={() => { setPendingStart(false); onStart(good.trim(), bad.trim()); }}>Confirm start</button>
              <button type="button" onClick={() => setPendingStart(false)}>Cancel</button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

function short(value: string | null): string {
  return value?.slice(0, 12) ?? "unknown";
}
