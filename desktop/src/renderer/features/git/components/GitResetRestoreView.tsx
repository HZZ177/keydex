import { FileClock, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitCommandResult, GitResetMode, GitResetPreview, GitStatusSnapshot } from "@/runtime/gitTypes";

import { parseCherryPickCommits } from "./GitCherryPickView";
import styles from "./GitResetRestoreView.module.css";

export function GitResetRestoreView({
  status,
  preview,
  initialResetTarget,
  busy,
  resetOutcome,
  restoreOutcome,
  onPreview,
  onReset,
  onRestore,
}: {
  status: GitStatusSnapshot | null;
  preview: GitResetPreview | null;
  initialResetTarget: string;
  busy: boolean;
  resetOutcome: GitCommandResult | null;
  restoreOutcome: GitCommandResult | null;
  onPreview: (target: string, mode: GitResetMode) => void;
  onReset: (target: string, mode: GitResetMode) => void;
  onRestore: (paths: readonly string[], source: string | null, staged: boolean, worktree: boolean) => void;
}) {
  const [target, setTarget] = useState(initialResetTarget);
  const [mode, setMode] = useState<GitResetMode>("mixed");
  const [pathsInput, setPathsInput] = useState("");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState<"worktree" | "index" | "both">("worktree");
  const [pendingRestore, setPendingRestore] = useState(false);
  useEffect(() => {
    if (initialResetTarget) setTarget(initialResetTarget);
  }, [initialResetTarget]);
  const paths = useMemo(() => parseCherryPickCommits(pathsInput), [pathsInput]);
  const previewMatches = preview?.target === target.trim() && preview.mode === mode;
  const risk = resetRisk(mode, previewMatches ? preview.untrackedOverwrites : []);
  return (
    <section className={styles.root} aria-label="Reset and restore">
      <header><RotateCcw size={14} /><div><strong>Reset branch</strong><span>Move the current branch tip. Review the exact ref and file impact before continuing.</span></div></header>
      <div className={styles.form}>
        <label><span>Target revision</span><input aria-label="Reset target" value={target} placeholder="HEAD~1 or HEAD@{1}" onChange={(event) => setTarget(event.target.value)} /></label>
        <label><span>Mode</span><select aria-label="Reset mode" value={mode} onChange={(event) => setMode(event.target.value as GitResetMode)}><option value="soft">Soft — keep index and worktree</option><option value="mixed">Mixed — reset index, keep worktree</option><option value="hard">Hard — reset index and worktree</option></select></label>
        <div className={styles.buttons}><button type="button" disabled={busy || !target.trim()} onClick={() => onPreview(target.trim(), mode)}>Preview reset</button><button type="button" className={styles.danger} disabled={busy || !previewMatches} onClick={() => onReset(target.trim(), mode)}>Reset to target</button></div>
      </div>
      {previewMatches && preview ? (
        <div className={styles.preview} data-risk={risk}>
          <dl><div><dt>Current HEAD</dt><dd><code>{preview.headObjectId?.slice(0, 12) ?? "unborn"}</code></dd></div><div><dt>Target</dt><dd><code>{preview.targetObjectId.slice(0, 12)}</code></dd></div><div><dt>Files</dt><dd>{preview.files.length}</dd></div><div><dt>Risk</dt><dd>{risk}</dd></div></dl>
          {preview.files.length ? <ul aria-label="Reset affected files">{preview.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul> : <p>No file-tree difference between HEAD and the target.</p>}
          {preview.untrackedOverwrites.length ? <div className={styles.warning} role="alert"><strong>Untracked data will be overwritten</strong><span>{preview.untrackedOverwrites.join(", ")}</span></div> : null}
          <p className={styles.recovery}><FileClock size={11} />{preview.reflogRecovery}</p>
        </div>
      ) : null}
      {resetOutcome ? <p className={styles.outcome} data-state={resetOutcome.state}>{resetOutcome.summary}. Recovery: <code>{String(resetOutcome.result.recovery_head ?? "HEAD@{1}")}</code></p> : null}

      <header className={styles.restoreHeader}><FileClock size={14} /><div><strong>Restore paths</strong><span>Restore selected paths without moving the current branch tip.</span></div></header>
      <div className={styles.form}>
        <label><span>Paths (one per line)</span><textarea aria-label="Restore paths" rows={3} value={pathsInput} onChange={(event) => setPathsInput(event.target.value)} /></label>
        <div className={styles.suggestions}>{status?.files.slice(0, 12).map((file) => <button type="button" key={file.path} onClick={() => setPathsInput((current) => `${current}${current.trim() ? "\n" : ""}${file.path}`)}>{file.path}</button>)}</div>
        <label><span>Source revision (blank uses index for worktree)</span><input aria-label="Restore source" value={source} placeholder={destination === "worktree" ? "index" : "HEAD"} onChange={(event) => setSource(event.target.value)} /></label>
        <label><span>Destination</span><select aria-label="Restore destination" value={destination} onChange={(event) => setDestination(event.target.value as typeof destination)}><option value="worktree">Worktree</option><option value="index">Index</option><option value="both">Index and worktree</option></select></label>
        {destination !== "index" ? <p className={styles.warning}>Worktree restore discards local content in the selected paths and requires confirmation.</p> : null}
        <button type="button" className={destination === "index" ? undefined : styles.danger} disabled={busy || paths.length === 0} onClick={() => destination === "index" ? onRestore(paths, source.trim() || null, true, false) : setPendingRestore(true)}>Restore selected paths</button>
      </div>
      {pendingRestore ? (
        <div className={styles.confirmation} role="alertdialog" aria-label="Confirm path restore">
          <strong>Discard local content in {paths.length} selected path(s)?</strong>
          <span>{paths.join(", ")} · destination {destination} · source {source.trim() || "index"}</span>
          <button type="button" onClick={() => { setPendingRestore(false); onRestore(paths, source.trim() || null, destination !== "worktree", true); }}>Confirm restore</button>
          <button type="button" onClick={() => setPendingRestore(false)}>Cancel</button>
        </div>
      ) : null}
      {restoreOutcome ? <p className={styles.outcome} data-state={restoreOutcome.state}>{restoreOutcome.summary}</p> : null}
    </section>
  );
}

export function resetRisk(mode: GitResetMode, untrackedOverwrites: readonly string[]): "history-rewrite" | "destructive" | "untracked-loss" {
  if (mode !== "hard") return "history-rewrite";
  return untrackedOverwrites.length ? "untracked-loss" : "destructive";
}
