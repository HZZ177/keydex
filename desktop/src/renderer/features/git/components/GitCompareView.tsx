import { ArrowLeftRight } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitCompareMode, GitCompareResult } from "@/runtime/gitTypes";

import styles from "./GitCompareView.module.css";

export function GitCompareView({
  result,
  loading,
  revisions,
  defaultLeft,
  defaultRight,
  selectedFileIndex,
  onCompare,
  onSelectFile,
}: {
  result: GitCompareResult | null;
  loading: boolean;
  revisions: readonly string[];
  defaultLeft: string;
  defaultRight: string;
  selectedFileIndex: number;
  onCompare: (mode: GitCompareMode, left: string, right: string | null) => void;
  onSelectFile: (index: number) => void;
}) {
  const [mode, setMode] = useState<GitCompareMode>("commit");
  const [left, setLeft] = useState(defaultLeft);
  const [right, setRight] = useState(defaultRight);
  useEffect(() => {
    setMode("commit");
    setLeft(defaultLeft);
    setRight(defaultRight);
  }, [defaultLeft, defaultRight]);
  const requiresRight = mode !== "working_tree";
  const additions = result?.files.reduce((total, file) => total + (file.additions ?? 0), 0) ?? 0;
  const deletions = result?.files.reduce((total, file) => total + (file.deletions ?? 0), 0) ?? 0;

  return (
    <section className={styles.root} aria-label="Compare revisions">
      <header><ArrowLeftRight size={12} /><strong>Compare</strong></header>
      <div className={styles.controls}>
        <label>
          <span>Mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as GitCompareMode)}>
            <option value="commit">Commit ↔ parent</option>
            <option value="two_dot">Endpoints (A..B)</option>
            <option value="three_dot">Branch changes (A...B)</option>
            <option value="working_tree">Revision ↔ working tree</option>
          </select>
        </label>
        <label>
          <span>{mode === "three_dot" ? "Base branch (A)" : "Left (A)"}</span>
          <input list="git-compare-revisions" value={left} onChange={(event) => setLeft(event.target.value)} />
        </label>
        {requiresRight ? (
          <label>
            <span>{mode === "three_dot" ? "Target branch (B)" : "Right (B)"}</span>
            <input list="git-compare-revisions" value={right} onChange={(event) => setRight(event.target.value)} />
          </label>
        ) : <span className={styles.workingTarget}>Right: Working tree</span>}
        <datalist id="git-compare-revisions">{revisions.map((revision) => <option value={revision} key={revision} />)}</datalist>
        <button
          type="button"
          disabled={loading || !left.trim() || (requiresRight && !right.trim())}
          onClick={() => onCompare(mode, left.trim(), requiresRight ? right.trim() : null)}
        >
          <ArrowLeftRight size={11} />{loading ? "Comparing…" : "Compare"}
        </button>
      </div>
      {result ? (
        <div className={styles.result}>
          <dl>
            <div><dt>Left</dt><dd>{result.leftLabel} <code>{result.leftObjectId.slice(0, 8)}</code></dd></div>
            <div><dt>Right</dt><dd>{result.rightLabel} {result.rightObjectId ? <code>{result.rightObjectId.slice(0, 8)}</code> : null}</dd></div>
            <div><dt>Diff base</dt><dd><code>{result.comparisonBaseObjectId.slice(0, 8)}</code>{result.mergeBaseObjectId ? " (merge base)" : ""}</dd></div>
          </dl>
          <header><strong>{result.files.length} file(s)</strong><span className={styles.additions}>+{additions}</span><span className={styles.deletions}>−{deletions}</span></header>
          <ul aria-label="Compared files">{result.files.map((file, index) => {
            const path = file.newPath ?? file.oldPath ?? `File ${index + 1}`;
            return (
              <li key={`${path}-${index}`}>
                <button type="button" aria-pressed={selectedFileIndex === index} onClick={() => onSelectFile(index)}>
                  <span>{path}</span><small>{file.status}</small>
                </button>
              </li>
            );
          })}</ul>
        </div>
      ) : null}
    </section>
  );
}
