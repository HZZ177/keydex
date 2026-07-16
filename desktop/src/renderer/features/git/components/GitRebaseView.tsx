import { ArrowDown, ArrowUp, GitPullRequestArrow, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitRebaseAction, GitRebasePreview, GitRebaseTodoItem, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitRebaseView.module.css";

export function GitRebaseView({
  refs,
  status,
  preview,
  busy,
  onPreview,
  onRebase,
  onControl,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  preview: GitRebasePreview | null;
  busy: boolean;
  onPreview: (upstream: string, onto: string | null) => void;
  onRebase: (upstream: string, onto: string | null, interactive: boolean, todo: readonly GitRebaseTodoItem[]) => void;
  onControl: (action: "continue" | "skip" | "abort") => void;
}) {
  const [upstream, setUpstream] = useState("");
  const [onto, setOnto] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [todo, setTodo] = useState<GitRebaseTodoItem[]>([]);
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingControl, setPendingControl] = useState<"skip" | "abort" | null>(null);
  useEffect(() => {
    setTodo((preview?.commits ?? []).map((item) => ({ ...item, action: "pick" })));
  }, [preview]);
  const validationError = useMemo(() => validateRebaseTodo(todo), [todo]);
  const operation = status?.operation?.kind === "rebase" ? status.operation : null;
  const previewMatches = preview?.upstream === upstream.trim() && (preview.onto ?? "") === onto.trim();
  return (
    <section className={styles.root} aria-label="Rebase workflow">
      <header><GitPullRequestArrow size={14} /><div><strong>Rebase</strong><span>Replay current-branch commits on an upstream or explicit onto revision.</span></div></header>
      {operation ? (
        <div className={styles.operation} role="status">
          <div><strong>Rebase {operation.state}</strong><span>{operation.currentStep && operation.totalSteps ? `Step ${operation.currentStep} of ${operation.totalSteps}` : "Resolve the current step, skip it, or abort."}</span></div>
          <button type="button" disabled={busy || operation.state === "conflicted"} onClick={() => onControl("continue")}>Continue</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("skip")}>Skip</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("abort")}>Abort</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label><span>Upstream</span><input aria-label="Rebase upstream" list="git-rebase-refs" value={upstream} onChange={(event) => setUpstream(event.target.value)} /></label>
        <label><span>Onto (optional)</span><input aria-label="Rebase onto" list="git-rebase-refs" value={onto} onChange={(event) => setOnto(event.target.value)} /></label>
        <datalist id="git-rebase-refs">{refs.map((ref) => <option value={ref.fullName} key={ref.fullName}>{ref.shortName}</option>)}</datalist>
        <label className={styles.check}><input type="checkbox" checked={interactive} onChange={(event) => setInteractive(event.target.checked)} />Edit interactive todo</label>
        <div className={styles.buttons}>
          <button type="button" disabled={busy || !upstream.trim()} onClick={() => onPreview(upstream.trim(), onto.trim() || null)}><Search size={11} />Preview</button>
          <button type="button" disabled={busy || !previewMatches || preview?.dirty || preview?.commits.length === 0 || (interactive && Boolean(validationError))} onClick={() => setPendingStart(true)}>Rebase</button>
        </div>
      </div>
      {preview ? (
        <div className={styles.preview}>
          <dl><div><dt>HEAD</dt><dd><code>{preview.headObjectId.slice(0, 12)}</code></dd></div><div><dt>Upstream</dt><dd>{preview.upstream} <code>{preview.upstreamObjectId.slice(0, 12)}</code></dd></div><div><dt>Onto</dt><dd>{preview.onto ?? preview.upstream} {preview.ontoObjectId ? <code>{preview.ontoObjectId.slice(0, 12)}</code> : null}</dd></div><div><dt>Commits</dt><dd>{preview.commits.length}</dd></div></dl>
          {preview.dirty ? <p className={styles.warning}>Commit or stash local changes before rebasing.</p> : null}
          {interactive ? (
            <ol className={styles.todo} aria-label="Interactive rebase todo">{todo.map((item, index) => (
              <li key={item.objectId}>
                <select aria-label={`Action for ${item.subject}`} value={item.action} onChange={(event) => setTodo((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, action: event.target.value as GitRebaseAction, message: event.target.value === "reword" ? candidate.message ?? "" : null } : candidate))}><option value="pick">pick</option><option value="reword">reword</option><option value="squash">squash</option><option value="fixup">fixup</option><option value="drop">drop</option></select>
                <code>{item.objectId.slice(0, 8)}</code><span>{item.subject}</span>
                {item.action === "reword" ? <input className={styles.reword} aria-label={`New message for ${item.subject}`} value={item.message ?? ""} placeholder="New commit message" onChange={(event) => setTodo((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, message: event.target.value } : candidate))} /> : null}
                <button type="button" aria-label={`Move ${item.subject} up`} disabled={index === 0} onClick={() => setTodo((current) => moveTodo(current, index, index - 1))}><ArrowUp size={11} /></button>
                <button type="button" aria-label={`Move ${item.subject} down`} disabled={index === todo.length - 1} onClick={() => setTodo((current) => moveTodo(current, index, index + 1))}><ArrowDown size={11} /></button>
              </li>
            ))}</ol>
          ) : <ul className={styles.commits}>{preview.commits.map((item) => <li key={item.objectId}><code>{item.objectId.slice(0, 8)}</code><span>{item.subject}</span></li>)}</ul>}
          {interactive && validationError ? <p className={styles.warning} role="alert">{validationError}</p> : null}
        </div>
      ) : null}
      {pendingStart ? (
        <div className={styles.confirmation} role="alertdialog" aria-label="Confirm rebase">
          <strong>Rewrite {preview?.commits.length ?? 0} local commit(s)?</strong>
          <span>Current commit IDs will change. The reflog can be used for recovery.</span>
          <button type="button" onClick={() => { setPendingStart(false); onRebase(upstream.trim(), onto.trim() || null, interactive, interactive ? todo : []); }}>Confirm rebase</button>
          <button type="button" onClick={() => setPendingStart(false)}>Cancel</button>
        </div>
      ) : null}
      {pendingControl ? (
        <div className={styles.confirmation} role="alertdialog" aria-label={`Confirm rebase ${pendingControl}`}>
          <strong>{pendingControl === "abort" ? "Abort and restore the original branch state?" : "Skip the current rebase commit?"}</strong>
          <span>{pendingControl === "abort" ? "Rebase progress and resolved changes for this operation will be discarded." : "The current commit will not be replayed."}</span>
          <button type="button" onClick={() => { const action = pendingControl; setPendingControl(null); onControl(action); }}>Confirm {pendingControl}</button>
          <button type="button" onClick={() => setPendingControl(null)}>Cancel</button>
        </div>
      ) : null}
    </section>
  );
}

export function validateRebaseTodo(todo: readonly GitRebaseTodoItem[]): string | null {
  if (todo.length === 0) return "Interactive rebase requires at least one commit.";
  const seen = new Set<string>();
  let actionable = false;
  for (const item of todo) {
    if (seen.has(item.objectId)) return "The same commit cannot appear twice.";
    seen.add(item.objectId);
    if ((item.action === "squash" || item.action === "fixup") && !actionable) return "Squash/fixup needs a previous non-dropped commit.";
    if (item.action === "reword" && !item.message?.trim()) return "Reword needs a new commit message.";
    if (item.action !== "drop") actionable = true;
  }
  return null;
}

function moveTodo(items: readonly GitRebaseTodoItem[], from: number, to: number): GitRebaseTodoItem[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
