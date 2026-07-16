import { ClipboardCheck, Download, FileUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitCommandResult } from "@/runtime/gitTypes";
import type { GitPatchExport, GitPatchExportMode } from "@/runtime/git";

import { parseCherryPickCommits } from "./GitCherryPickView";
import styles from "./GitPatchExchangeView.module.css";

export interface GitPatchImportOptions {
  cached: boolean;
  reverse: boolean;
  reject: boolean;
}

export function GitPatchExchangeView({
  exported,
  busy,
  dryRunSignature,
  outcome,
  rejectFiles,
  onExport,
  onCheck,
  onApply,
}: {
  exported: GitPatchExport | null;
  busy: boolean;
  dryRunSignature: string | null;
  outcome: GitCommandResult | null;
  rejectFiles: readonly string[];
  onExport: (mode: GitPatchExportMode, left: string | null, right: string | null, paths: readonly string[]) => void;
  onCheck: (patch: string, options: GitPatchImportOptions) => void;
  onApply: (patch: string, options: GitPatchImportOptions) => void;
}) {
  const [mode, setMode] = useState<GitPatchExportMode>("working_tree");
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [pathsInput, setPathsInput] = useState("");
  const [patch, setPatch] = useState("");
  const [cached, setCached] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [reject, setReject] = useState(false);
  const paths = useMemo(() => parseCherryPickCommits(pathsInput), [pathsInput]);
  const options = { cached, reverse, reject };
  const signature = patchImportSignature(patch, options);
  const exportInvalid = (mode === "commit" && !left.trim()) || (mode === "range" && (!left.trim() || !right.trim()));
  return (
    <section className={styles.root} aria-label="Patch import and export">
      <header><Download size={14} /><div><strong>Export patch</strong><span>Export the working tree, index, a commit, or a revision range. Optional paths limit the patch.</span></div></header>
      <div className={styles.grid}>
        <label><span>Source</span><select aria-label="Patch export mode" value={mode} onChange={(event) => setMode(event.target.value as GitPatchExportMode)}><option value="working_tree">Working tree</option><option value="index">Index</option><option value="commit">Single commit</option><option value="range">Revision range</option></select></label>
        {mode === "commit" || mode === "range" ? <label><span>{mode === "commit" ? "Commit" : "Left revision"}</span><input aria-label="Patch left revision" value={left} onChange={(event) => setLeft(event.target.value)} /></label> : null}
        {mode === "range" ? <label><span>Right revision</span><input aria-label="Patch right revision" value={right} onChange={(event) => setRight(event.target.value)} /></label> : null}
        <label className={styles.wide}><span>Selected paths (optional)</span><textarea aria-label="Patch export paths" rows={2} value={pathsInput} onChange={(event) => setPathsInput(event.target.value)} /></label>
        <button type="button" disabled={busy || exportInvalid} onClick={() => onExport(mode, left.trim() || null, right.trim() || null, paths)}>Generate patch</button>
      </div>
      {exported ? <div className={styles.exportResult}><strong>{exported.filename}</strong><span>{exported.patch.length} characters</span><button type="button" disabled={!exported.patch} onClick={() => downloadPatch(exported)}>Save patch</button><textarea aria-label="Exported patch" readOnly rows={5} value={exported.patch} /></div> : null}

      <header className={styles.importHeader}><FileUp size={14} /><div><strong>Import patch</strong><span>Every import must pass an unchanged dry-run before Apply becomes available.</span></div></header>
      <textarea className={styles.patchInput} aria-label="Patch content" rows={8} value={patch} onChange={(event) => setPatch(event.target.value)} placeholder="diff --git a/path b/path" />
      <div className={styles.options}>
        <label><input type="checkbox" checked={cached} onChange={(event) => { setCached(event.target.checked); if (event.target.checked) setReject(false); }} />Apply to index</label>
        <label><input type="checkbox" checked={reverse} onChange={(event) => setReverse(event.target.checked)} />Reverse patch</label>
        <label><input type="checkbox" checked={reject} disabled={cached} onChange={(event) => setReject(event.target.checked)} />Keep rejected hunks (.rej)</label>
      </div>
      <div className={styles.actions}><button type="button" disabled={busy || !patch.trim()} onClick={() => onCheck(patch, options)}><ClipboardCheck size={11} />Dry-run</button><button type="button" disabled={busy || !patch.trim() || dryRunSignature !== signature} onClick={() => onApply(patch, options)}>Apply patch</button></div>
      {dryRunSignature === signature ? <p className={styles.ready}>Dry-run passed for this exact patch and option set.</p> : null}
      {outcome ? <p className={styles.outcome} data-state={outcome.state}>{outcome.summary}</p> : null}
      {rejectFiles.length ? <div className={styles.rejects} role="alert"><strong>Patch was only partially applied. Review reject files:</strong><ul>{rejectFiles.map((path) => <li key={path}>{path}</li>)}</ul></div> : null}
    </section>
  );
}

export function patchImportSignature(patch: string, options: GitPatchImportOptions): string {
  let hash = 2166136261;
  const value = `${options.cached ? 1 : 0}:${options.reverse ? 1 : 0}:${options.reject ? 1 : 0}:${patch}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function downloadPatch(exported: GitPatchExport): void {
  const url = URL.createObjectURL(new Blob([exported.patch], { type: "text/x-diff;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
