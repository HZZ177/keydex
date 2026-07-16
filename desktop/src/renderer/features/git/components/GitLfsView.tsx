import { CloudDownload, CloudUpload, Database, LockKeyhole } from "lucide-react";
import { useState } from "react";

import type { GitLfsSnapshot } from "@/runtime/gitTypes";

import styles from "./GitLfsView.module.css";

export type GitLfsAction = "fetch" | "pull" | "push";

export function GitLfsView({ snapshot, loading, busy, onAction }: {
  snapshot: GitLfsSnapshot | null;
  loading: boolean;
  busy: boolean;
  onAction: (action: GitLfsAction, remote: string | null, refspec: string | null) => void;
}) {
  const [remote, setRemote] = useState("origin");
  const [refspec, setRefspec] = useState("HEAD");
  const disabled = busy || !snapshot?.available;
  return (
    <section className={styles.root} aria-label="Git LFS">
      <header><Database size={14} /><strong>Git LFS</strong></header>
      {loading ? <p>Loading Git LFS status…</p> : !snapshot?.available ? (
        <div className={styles.unavailable} role="status">
          <strong>Git LFS unavailable</strong>
          <span>{snapshot?.reason ?? "Install git-lfs separately, then refresh this repository."}</span>
          <small>Keydex never installs Git LFS automatically.</small>
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <span>{snapshot.files.length} LFS files</span>
            <span>{snapshot.trackedPatterns.length} tracked patterns</span>
            <span>{snapshot.locksAvailable ? `${snapshot.locks.length} locks` : "Locks unavailable"}</span>
          </div>
          <div className={styles.columns}>
            <div><strong>Tracked patterns</strong>{snapshot.trackedPatterns.length ? <ul>{snapshot.trackedPatterns.map((pattern) => <li key={pattern}><code>{pattern}</code></li>)}</ul> : <p>No LFS patterns in .gitattributes.</p>}</div>
            <div><strong>Files</strong>{snapshot.files.length ? <ul>{snapshot.files.map((file) => <li key={file.path}><code>{file.path}</code><small>{file.status}{file.size === null ? "" : ` · ${formatBytes(file.size)}`}</small></li>)}</ul> : <p>No LFS files in the current index.</p>}</div>
            <div><strong><LockKeyhole size={12} />Locks</strong>{snapshot.locksAvailable ? snapshot.locks.length ? <ul>{snapshot.locks.map((lock) => <li key={lock.id}><code>{lock.path}</code><small>{lock.owner ?? "unknown owner"}{lock.lockedAt ? ` · ${lock.lockedAt}` : ""}</small></li>)}</ul> : <p>No locks reported.</p> : <p>Configure a reachable LFS remote to query locks.</p>}</div>
          </div>
        </>
      )}
      <div className={styles.controls} aria-disabled={!snapshot?.available}>
        <label>Remote<input aria-label="Git LFS remote" value={remote} disabled={disabled} onChange={(event) => setRemote(event.target.value)} /></label>
        <label>Refspec<input aria-label="Git LFS refspec" value={refspec} disabled={disabled} onChange={(event) => setRefspec(event.target.value)} /></label>
        <div>
          <button type="button" disabled={disabled} onClick={() => onAction("fetch", remote.trim() || null, refspec.trim() || null)}><CloudDownload size={12} />Fetch objects</button>
          <button type="button" disabled={disabled} onClick={() => onAction("pull", remote.trim() || null, null)}><CloudDownload size={12} />Pull & checkout</button>
          <button type="button" disabled={disabled || !remote.trim() || !refspec.trim()} onClick={() => onAction("push", remote.trim(), refspec.trim())}><CloudUpload size={12} />Push objects</button>
        </div>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
