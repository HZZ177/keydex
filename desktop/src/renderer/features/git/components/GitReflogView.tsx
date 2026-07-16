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
    <section className={styles.root} aria-label="Git reflog">
      <form
        className={styles.toolbar}
        aria-label="Reflog options"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad(ref.trim() || "HEAD");
        }}
      >
        <label><span>Reference</span><input list="git-reflog-refs" value={ref} onChange={(event) => setRef(event.target.value)} /></label>
        <datalist id="git-reflog-refs"><option value="HEAD" />{refOptions.map((item) => <option value={item} key={item} />)}</datalist>
        <button type="submit" disabled={loading || !ref.trim()}><RefreshCw size={12} />{loading ? "Loading…" : "Load"}</button>
      </form>
      {page ? (
        <>
          <header className={styles.summary}><strong>{page.ref ?? "All refs"}</strong><span>{page.entries.length} loaded entry(s)</span></header>
          <div className={styles.entries} role="listbox" aria-label="Reflog entries">
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
                <span className={styles.action}>{entry.action}</span>
                <span className={styles.message}>{entry.message}</span>
                <span>{entry.actorName}</span>
                <time dateTime={entry.occurredAt}>{formatReflogDate(entry.occurredAt)}</time>
              </button>
            ))}
          </div>
          {page.nextCursor ? <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>Load older entries</button> : null}
        </>
      ) : <div className={styles.empty}>Load HEAD or a branch reflog to inspect recovery points.</div>}
      {selected ? (
        <footer className={styles.actions}>
          <div><strong>{selected.selector}</strong><code>{selected.objectId}</code></div>
          <button type="button" onClick={() => onCopy(selected.objectId)}><Copy size={11} />Copy hash</button>
          <label><span>New branch</span><input value={branchName} placeholder="recovery/branch" onChange={(event) => setBranchName(event.target.value)} /></label>
          <button type="button" disabled={!branchName.trim()} onClick={() => onCreateBranch(branchName.trim(), selected.objectId)}><GitBranchPlus size={11} />Create branch</button>
          <button type="button" onClick={() => onReset(selected.objectId)}><RotateCcw size={11} />Reset here</button>
        </footer>
      ) : null}
    </section>
  );
}

function formatReflogDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
