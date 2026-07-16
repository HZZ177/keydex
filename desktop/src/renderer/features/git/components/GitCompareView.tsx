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
    <section className={styles.root} aria-label="比较修订">
      <header><ArrowLeftRight size={12} /><strong>比较</strong></header>
      <div className={styles.controls}>
        <label>
          <span>比较方式</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as GitCompareMode)}>
            <option value="commit">提交与父提交</option>
            <option value="two_dot">两个端点（左侧..右侧）</option>
            <option value="three_dot">分支改动（左侧...右侧）</option>
            <option value="working_tree">修订与工作树</option>
          </select>
        </label>
        <label>
          <span>{mode === "three_dot" ? "基准分支（A）" : "左侧（A）"}</span>
          <input list="git-compare-revisions" value={left} onChange={(event) => setLeft(event.target.value)} />
        </label>
        {requiresRight ? (
          <label>
            <span>{mode === "three_dot" ? "目标分支（B）" : "右侧（B）"}</span>
            <input list="git-compare-revisions" value={right} onChange={(event) => setRight(event.target.value)} />
          </label>
        ) : <span className={styles.workingTarget}>右侧：工作树</span>}
        <datalist id="git-compare-revisions">{revisions.map((revision) => <option value={revision} key={revision} />)}</datalist>
        <button
          type="button"
          disabled={loading || !left.trim() || (requiresRight && !right.trim())}
          onClick={() => onCompare(mode, left.trim(), requiresRight ? right.trim() : null)}
        >
          <ArrowLeftRight size={11} />{loading ? "正在比较…" : "比较"}
        </button>
      </div>
      {result ? (
        <div className={styles.result}>
          <dl>
            <div><dt>左侧</dt><dd>{result.leftLabel} <code>{result.leftObjectId.slice(0, 8)}</code></dd></div>
            <div><dt>右侧</dt><dd>{result.rightLabel} {result.rightObjectId ? <code>{result.rightObjectId.slice(0, 8)}</code> : null}</dd></div>
            <div><dt>差异基准</dt><dd><code>{result.comparisonBaseObjectId.slice(0, 8)}</code>{result.mergeBaseObjectId ? "（合并基准）" : ""}</dd></div>
          </dl>
          <header><strong>{result.files.length} 个文件</strong><span className={styles.additions}>+{additions}</span><span className={styles.deletions}>−{deletions}</span></header>
          <ul aria-label="比较的文件">{result.files.map((file, index) => {
            const path = file.newPath ?? file.oldPath ?? `文件 ${index + 1}`;
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
