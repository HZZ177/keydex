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
    <section className={styles.root} aria-label="Git blame">
      <form
        className={styles.toolbar}
        aria-label="Blame options"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad({
            path: path.trim(),
            revision: revision.trim(),
            ignoreRevsFile: useIgnoreRevs ? ".git-blame-ignore-revs" : null,
          });
        }}
      >
        <label><span>File path</span><input required value={path} placeholder="src/file.ts" onChange={(event) => setPath(event.target.value)} /></label>
        <label><span>Revision</span><input value={revision} placeholder="Working tree" onChange={(event) => setRevision(event.target.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={useIgnoreRevs} onChange={(event) => setUseIgnoreRevs(event.target.checked)} />Use .git-blame-ignore-revs</label>
        <button type="submit" disabled={loading || !path.trim()}><Search size={12} />{loading ? "Loading…" : "Blame"}</button>
      </form>
      {page ? (
        <>
          <header className={styles.summary}>
            <strong>{page.path}</strong>
            <span>{page.revision ?? "Working tree"}</span>
            <span>Lines {page.startLine}–{page.lines.at(-1)?.finalLine ?? page.startLine}</span>
            {page.ignoreRevsFile ? <span>Ignoring revisions from {page.ignoreRevsFile}</span> : null}
          </header>
          <div className={styles.scroller} role="table" aria-label="Blame lines">
            {page.lines.map((line) => (
              <div className={styles.line} role="row" key={`${line.finalLine}-${line.objectId}`}>
                <span role="cell" className={styles.lineNumber}>{line.finalLine}</span>
                <button
                  type="button"
                  role="cell"
                  className={styles.commit}
                  disabled={line.uncommitted}
                  title={line.uncommitted ? "Uncommitted working tree line" : `${line.objectId} ${line.summary}`}
                  onClick={() => onOpenCommit(line.objectId)}
                >
                  {line.uncommitted ? "Working" : line.objectId.slice(0, 8)}
                </button>
                <span role="cell" className={styles.author}>{line.authorName || "Unknown"}</span>
                <span role="cell" className={styles.date}>{formatBlameDate(line.authoredAt)}</span>
                <code role="cell">{line.content}</code>
                {line.boundary ? <span className={styles.badge}>boundary</span> : null}
              </div>
            ))}
          </div>
          {page.nextStartLine ? (
            <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>
              Load lines from {page.nextStartLine}
            </button>
          ) : null}
        </>
      ) : <div className={styles.empty}><History size={18} /><span>Choose a file to inspect line history.</span></div>}
    </section>
  );
}

function formatBlameDate(epochSeconds: number | null) {
  if (epochSeconds === null) return "—";
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}
