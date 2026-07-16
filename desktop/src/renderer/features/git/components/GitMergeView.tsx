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
    <section className={styles.root} aria-label="合并流程">
      <header><GitMerge size={14} /><div><strong>合并</strong><span>更新当前分支前，先预览合并基准和即将进入的提交。</span></div></header>
      {mergeOperation ? (
        <div className={styles.operation} role="status" data-state={mergeOperation.state}>
          <AlertTriangle size={14} />
          <div><strong>合并：{operationStateLabel(mergeOperation.state)}</strong><span>{mergeOperation.currentObjectId?.slice(0, 12) ?? "请解决冲突或中止合并。"}</span></div>
          <button type="button" disabled={busy} onClick={onAbort}><X size={11} />中止合并</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label><span>来源分支或修订</span><input list="git-merge-refs" value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <datalist id="git-merge-refs">{refs.filter((ref) => !ref.current).map((ref) => <option value={ref.fullName} key={ref.fullName}>{ref.shortName}</option>)}</datalist>
        <label><span>策略</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as GitMergeStrategy)}><option value="ff">允许快进</option><option value="no_ff">始终创建合并提交</option><option value="squash">压缩到暂存区</option></select></label>
        {strategy !== "squash" ? <label><span>合并说明（可选）</span><input value={message} onChange={(event) => setMessage(event.target.value)} /></label> : null}
        <div className={styles.buttons}>
          <button type="button" disabled={busy || !source.trim()} onClick={() => onPreview(source.trim())}><Search size={11} />预览</button>
          <button type="button" disabled={busy || !source.trim() || preview?.source !== source.trim() || preview.alreadyMerged} onClick={() => onMerge(source.trim(), strategy, message)}><GitMerge size={11} />{strategy === "squash" ? "压缩" : "合并"}</button>
        </div>
      </div>
      {preview ? (
        <dl className={styles.preview}>
          <div><dt>当前提交</dt><dd><code>{preview.headObjectId.slice(0, 12)}</code></dd></div>
          <div><dt>来源</dt><dd>{preview.source} <code>{preview.sourceObjectId.slice(0, 12)}</code></dd></div>
          <div><dt>合并基准</dt><dd><code>{preview.mergeBaseObjectId.slice(0, 12)}</code></dd></div>
          <div><dt>进入提交</dt><dd>{preview.incomingCommits} 个提交</dd></div>
          <div><dt>结果</dt><dd>{preview.alreadyMerged ? "已经合并" : preview.fastForward ? "可以快进" : "需要创建合并提交"}</dd></div>
          <div><dt>工作树</dt><dd className={preview.dirty ? styles.warning : undefined}>{preview.dirty ? "存在本地改动；Git 可能拒绝重叠路径" : "干净"}</dd></div>
        </dl>
      ) : null}
    </section>
  );
}

function operationStateLabel(state: NonNullable<GitStatusSnapshot["operation"]>["state"]): string {
  return ({ running: "执行中", conflicted: "存在冲突", continuable: "可以继续" })[state];
}
