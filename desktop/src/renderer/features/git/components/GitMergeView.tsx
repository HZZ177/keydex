import { AlertTriangle, GitMerge, Search, X } from "lucide-react";
import { useState } from "react";

import type { GitMergePreview, GitMergeStrategy, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitMergeView.module.css";

export function GitMergeView({
  refs,
  status,
  preview,
  busy,
  onPreview,
  onMerge,
  onAbort,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  preview: GitMergePreview | null;
  busy: boolean;
  onPreview: (source: string) => void;
  onMerge: (source: string, strategy: GitMergeStrategy, message: string) => void;
  onAbort: () => void;
}) {
  const [source, setSource] = useState("");
  const [strategy, setStrategy] = useState<GitMergeStrategy>("ff");
  const [message, setMessage] = useState("");
  const mergeOperation = status?.operation?.kind === "merge" ? status.operation : null;
  return (
    <section className={styles.root} aria-label="Merge workflow">
      <header><GitMerge size={14} /><div><strong>Merge</strong><span>Preview the merge base and incoming commits before updating the current branch.</span></div></header>
      {mergeOperation ? (
        <div className={styles.operation} role="status" data-state={mergeOperation.state}>
          <AlertTriangle size={14} />
          <div><strong>Merge {mergeOperation.state}</strong><span>{mergeOperation.currentObjectId?.slice(0, 12) ?? "Resolve conflicts or abort the merge."}</span></div>
          <button type="button" disabled={busy} onClick={onAbort}><X size={11} />Abort merge</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label><span>Source branch or revision</span><input list="git-merge-refs" value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <datalist id="git-merge-refs">{refs.filter((ref) => !ref.current).map((ref) => <option value={ref.fullName} key={ref.fullName}>{ref.shortName}</option>)}</datalist>
        <label><span>Strategy</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as GitMergeStrategy)}><option value="ff">Allow fast-forward</option><option value="no_ff">Always create merge commit</option><option value="squash">Squash into index</option></select></label>
        {strategy !== "squash" ? <label><span>Merge message (optional)</span><input value={message} onChange={(event) => setMessage(event.target.value)} /></label> : null}
        <div className={styles.buttons}>
          <button type="button" disabled={busy || !source.trim()} onClick={() => onPreview(source.trim())}><Search size={11} />Preview</button>
          <button type="button" disabled={busy || !source.trim() || preview?.source !== source.trim() || preview.alreadyMerged} onClick={() => onMerge(source.trim(), strategy, message)}><GitMerge size={11} />{strategy === "squash" ? "Squash" : "Merge"}</button>
        </div>
      </div>
      {preview ? (
        <dl className={styles.preview}>
          <div><dt>HEAD</dt><dd><code>{preview.headObjectId.slice(0, 12)}</code></dd></div>
          <div><dt>Source</dt><dd>{preview.source} <code>{preview.sourceObjectId.slice(0, 12)}</code></dd></div>
          <div><dt>Merge base</dt><dd><code>{preview.mergeBaseObjectId.slice(0, 12)}</code></dd></div>
          <div><dt>Incoming</dt><dd>{preview.incomingCommits} commit(s)</dd></div>
          <div><dt>Result</dt><dd>{preview.alreadyMerged ? "Already merged" : preview.fastForward ? "Fast-forward available" : "Merge commit required"}</dd></div>
          <div><dt>Worktree</dt><dd className={preview.dirty ? styles.warning : undefined}>{preview.dirty ? "Has local changes; Git may reject overlapping paths" : "Clean"}</dd></div>
        </dl>
      ) : null}
    </section>
  );
}
