import { History, Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitBlamePage, GitObjectId } from "@/runtime/gitTypes";

import styles from "./GitBlameView.module.css";

export interface GitBlameRequest {
  path: string;
  revision: string;
  ignoreRevsFile: string | null;
}

export function GitBlameView({
  page,
  loading,
  defaultPath,
  onLoad,
  onLoadMore,
  onOpenCommit,
}: {
  page: GitBlamePage | null;
  loading: boolean;
  defaultPath: string;
  onLoad: (request: GitBlameRequest) => void;
  onLoadMore: () => void;
  onOpenCommit: (objectId: GitObjectId) => void;
}) {
  const [path, setPath] = useState(defaultPath);
  const [revision, setRevision] = useState("");
  const [useIgnoreRevs, setUseIgnoreRevs] = useState(false);
  useEffect(() => {
    if (!path && defaultPath) setPath(defaultPath);
  }, [defaultPath, path]);

  return (
    <section className={styles.root} aria-label="Git 逐行历史">
      <form
        className={styles.toolbar}
        aria-label="逐行历史选项"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad({
            path: path.trim(),
            revision: revision.trim(),
            ignoreRevsFile: useIgnoreRevs ? ".git-blame-ignore-revs" : null,
          });
        }}
      >
        <label><span>文件路径</span><input required value={path} placeholder="例如：源码/文件.ts" onChange={(event) => setPath(event.target.value)} /></label>
        <label><span>修订</span><input value={revision} placeholder="当前工作树" onChange={(event) => setRevision(event.target.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={useIgnoreRevs} onChange={(event) => setUseIgnoreRevs(event.target.checked)} />使用忽略修订配置文件</label>
        <button type="submit" disabled={loading || !path.trim()}><Search size={12} />{loading ? "正在加载…" : "查看逐行历史"}</button>
      </form>
      {page ? (
        <>
          <header className={styles.summary}>
            <strong>{page.path}</strong>
            <span>{page.revision ?? "当前工作树"}</span>
            <span>第 {page.startLine}–{page.lines.at(-1)?.finalLine ?? page.startLine} 行</span>
            {page.ignoreRevsFile ? <span>已忽略 {page.ignoreRevsFile} 中的修订</span> : null}
          </header>
          <div className={styles.scroller} role="table" aria-label="逐行历史">
            {page.lines.map((line) => (
              <div className={styles.line} role="row" key={`${line.finalLine}-${line.objectId}`}>
                <span role="cell" className={styles.lineNumber}>{line.finalLine}</span>
                <button
                  type="button"
                  role="cell"
                  className={styles.commit}
                  disabled={line.uncommitted}
                  title={line.uncommitted ? "工作树中尚未提交的行" : `${line.objectId} ${line.summary}`}
                  onClick={() => onOpenCommit(line.objectId)}
                >
                  {line.uncommitted ? "未提交" : line.objectId.slice(0, 8)}
                </button>
                <span role="cell" className={styles.author}>{line.authorName || "未知"}</span>
                <span role="cell" className={styles.date}>{formatBlameDate(line.authoredAt)}</span>
                <code role="cell">{line.content}</code>
                {line.boundary ? <span className={styles.badge}>边界提交</span> : null}
              </div>
            ))}
          </div>
          {page.nextStartLine ? (
            <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>
              从第 {page.nextStartLine} 行继续加载
            </button>
          ) : null}
        </>
      ) : <div className={styles.empty}><History size={18} /><span>请选择文件以查看逐行修改历史。</span></div>}
    </section>
  );
}

function formatBlameDate(epochSeconds: number | null) {
  if (epochSeconds === null) return "—";
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}
