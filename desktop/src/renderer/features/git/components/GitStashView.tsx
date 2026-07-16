import { Archive, FileDiff } from "lucide-react";
import { useState } from "react";

import type { GitStashDetail, GitStashEntry } from "@/runtime/git";

import styles from "./GitStashView.module.css";

export function GitStashView({
  entries,
  selected,
  detail,
  selectedFileIndex,
  loading,
  hasMore,
  onSelect,
  onSelectFile,
  onLoadMore,
  busy,
  onCreate,
  onApply,
  onPop,
  onBranch,
  onDrop,
  onClear,
}: {
  entries: readonly GitStashEntry[];
  selected: GitStashEntry | null;
  detail: GitStashDetail | null;
  selectedFileIndex: number;
  loading: boolean;
  hasMore: boolean;
  onSelect: (entry: GitStashEntry) => void;
  onSelectFile: (index: number) => void;
  onLoadMore: () => void;
  busy: boolean;
  onCreate: (options: { message: string; staged: boolean; includeUntracked: boolean }) => void;
  onApply: (entry: GitStashEntry, reinstateIndex: boolean) => void;
  onPop: (entry: GitStashEntry, reinstateIndex: boolean) => void;
  onBranch: (entry: GitStashEntry, branchName: string) => void;
  onDrop: (entry: GitStashEntry) => void;
  onClear: () => void;
}) {
  const [message, setMessage] = useState("");
  const [staged, setStaged] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [branchName, setBranchName] = useState("");
  return (
    <div className={styles.root}>
      <form className={styles.toolbar} onSubmit={(event) => { event.preventDefault(); onCreate({ message, staged, includeUntracked }); }}>
        <input aria-label="储藏说明" value={message} placeholder="储藏说明（可选）" disabled={busy} onChange={(event) => setMessage(event.currentTarget.value)} />
        <label><input type="checkbox" checked={staged} disabled={busy || includeUntracked} onChange={(event) => setStaged(event.currentTarget.checked)} />仅储藏已暂存改动</label>
        <label><input type="checkbox" checked={includeUntracked} disabled={busy || staged} onChange={(event) => setIncludeUntracked(event.currentTarget.checked)} />包含未跟踪文件</label>
        <button type="submit" disabled={busy}>创建储藏</button>
        <button type="button" className={styles.danger} disabled={busy || entries.length === 0} onClick={onClear}>清空全部…</button>
      </form>
      {!loading && entries.length === 0 ? (
        <div className={styles.empty} role="status"><Archive size={20} /><strong>没有储藏记录</strong><span>创建储藏可以临时保存本地改动。</span></div>
      ) : <>
      <div className={styles.list} role="listbox" aria-label="Git 储藏记录" aria-busy={loading}>
        {entries.map((entry) => (
          <button
            type="button"
            role="option"
            aria-selected={selected?.objectId === entry.objectId}
            key={`${entry.selector}:${entry.objectId}`}
            onClick={() => onSelect(entry)}
          >
            <Archive size={13} />
            <span><strong>{entry.selector}</strong><small>{entry.message}</small></span>
            <time dateTime={entry.createdAt}>{formatStashDate(entry.createdAt)}</time>
          </button>
        ))}
        {hasMore ? <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>{loading ? "正在读取…" : "读取更多"}</button> : null}
      </div>
      <section className={styles.detail} aria-label="储藏详情">
        {detail ? (
          <>
            <header>
              <div><strong>{detail.entry.message}</strong><span>{detail.entry.authorName} · 基础提交 {detail.entry.baseObjectId?.slice(0, 8) ?? "未知"}</span></div>
              <code>{detail.entry.objectId.slice(0, 8)}</code>
            </header>
            <div className={styles.actions}>
              <label><input type="checkbox" checked={reinstateIndex} disabled={busy} onChange={(event) => setReinstateIndex(event.currentTarget.checked)} />恢复暂存状态</label>
              <button type="button" disabled={busy} onClick={() => selected && onApply(selected, reinstateIndex)}>应用</button>
              <button type="button" disabled={busy} onClick={() => selected && onPop(selected, reinstateIndex)}>应用并删除</button>
              <input aria-label="储藏分支名称" value={branchName} placeholder="新分支名称" disabled={busy} onChange={(event) => setBranchName(event.currentTarget.value)} />
              <button type="button" disabled={busy || !branchName.trim()} onClick={() => selected && onBranch(selected, branchName.trim())}>创建分支</button>
              <button type="button" className={styles.danger} disabled={busy} onClick={() => selected && onDrop(selected)}>删除储藏…</button>
            </div>
            <div className={styles.files} role="listbox" aria-label="储藏文件">
              {detail.files.map((file, index) => (
                <button type="button" role="option" aria-selected={index === selectedFileIndex} key={`${file.oldPath}:${file.newPath}:${index}`} onClick={() => onSelectFile(index)}>
                  <FileDiff size={12} /><span>{file.newPath ?? file.oldPath}</span><small>{file.additions === null ? "二进制" : `+${file.additions ?? 0} −${file.deletions ?? 0}`}</small>
                </button>
              ))}
            </div>
          </>
        ) : <div className={styles.prompt}>{loading ? "正在读取储藏详情…" : "选择一条储藏记录以查看文件和差异。"}</div>}
      </section>
      </>}
    </div>
  );
}

export function formatStashDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
