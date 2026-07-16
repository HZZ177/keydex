import { Copy, GitBranchPlus, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitObjectId, GitReflogEntry, GitReflogPage } from "@/runtime/gitTypes";

import styles from "./GitReflogView.module.css";

export function GitReflogView({
  page,
  loading,
  refOptions,
  onLoad,
  onLoadMore,
  onCreateBranch,
  onCopy,
  onReset,
}: {
  page: GitReflogPage | null;
  loading: boolean;
  refOptions: readonly string[];
  onLoad: (ref: string) => void;
  onLoadMore: () => void;
  onCreateBranch: (name: string, objectId: GitObjectId) => void;
  onCopy: (objectId: GitObjectId) => void;
  onReset: (objectId: GitObjectId) => void;
}) {
  const [ref, setRef] = useState("HEAD");
  const [selected, setSelected] = useState<GitReflogEntry | null>(null);
  const [branchName, setBranchName] = useState("");
  useEffect(() => {
    setSelected(page?.entries[0] ?? null);
    setBranchName("");
  }, [page?.repositoryVersion, page?.ref]);

  return (
    <section className={styles.root} aria-label="Git 引用记录">
      <form
        className={styles.toolbar}
        aria-label="引用记录选项"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad(ref.trim() || "HEAD");
        }}
      >
        <label><span>引用</span><input list="git-reflog-refs" value={ref} onChange={(event) => setRef(event.target.value)} /></label>
        <datalist id="git-reflog-refs"><option value="HEAD" />{refOptions.map((item) => <option value={item} key={item} />)}</datalist>
        <button type="submit" disabled={loading || !ref.trim()}><RefreshCw size={12} />{loading ? "正在读取…" : "读取"}</button>
      </form>
      {page ? (
        <>
          <header className={styles.summary}><strong>{page.ref ?? "全部引用"}</strong><span>已读取 {page.entries.length} 条记录</span></header>
          <div className={styles.entries} role="listbox" aria-label="引用变更记录">
            {page.entries.map((entry) => (
              <button
                type="button"
                role="option"
                aria-selected={selected?.selector === entry.selector}
                key={`${entry.selector}-${entry.objectId}`}
                onClick={() => {
                  setSelected(entry);
                  setBranchName("");
                }}
              >
                <code>{entry.objectId.slice(0, 8)}</code>
                <span className={styles.selector}>{entry.selector}</span>
                <span className={styles.action}>{reflogActionLabel(entry.action)}</span>
                <span className={styles.message}>{entry.message}</span>
                <span>{entry.actorName}</span>
                <time dateTime={entry.occurredAt}>{formatReflogDate(entry.occurredAt)}</time>
              </button>
            ))}
          </div>
          {page.nextCursor ? <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>读取更早记录</button> : null}
        </>
      ) : <div className={styles.empty}>读取当前指针或分支的引用记录，以查看可恢复位置。</div>}
      {selected ? (
        <footer className={styles.actions}>
          <div><strong>{selected.selector}</strong><code>{selected.objectId}</code></div>
          <button type="button" onClick={() => onCopy(selected.objectId)}><Copy size={11} />复制哈希</button>
          <label><span>新分支</span><input value={branchName} placeholder="请输入恢复分支名" onChange={(event) => setBranchName(event.target.value)} /></label>
          <button type="button" disabled={!branchName.trim()} onClick={() => onCreateBranch(branchName.trim(), selected.objectId)}><GitBranchPlus size={11} />创建分支</button>
          <button type="button" onClick={() => onReset(selected.objectId)}><RotateCcw size={11} />重置到此处</button>
        </footer>
      ) : null}
    </section>
  );
}

function reflogActionLabel(action: string): string {
  const normalized = action.toLowerCase().replace(/[_-]/g, " ");
  if (normalized.includes("commit") || normalized.includes("amend")) return "提交";
  if (normalized.includes("checkout") || normalized.includes("switch")) return "切换分支";
  if (normalized.includes("reset")) return "重置";
  if (normalized.includes("rebase")) return "变基";
  if (normalized.includes("merge")) return "合并";
  if (normalized.includes("cherry pick")) return "摘取提交";
  if (normalized.includes("revert")) return "反向提交";
  if (normalized.includes("pull")) return "拉取";
  if (normalized.includes("clone")) return "克隆";
  if (normalized.includes("branch")) return "分支操作";
  return "引用变更";
}

function formatReflogDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
