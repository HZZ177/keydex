import { GitBranch, Lock, LockOpen, Plus, ShieldCheck, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import type { GitRepositoryId, GitWorktree, GitWorktreesSnapshot } from "@/runtime/gitTypes";

import styles from "./GitWorktreeView.module.css";

export interface GitWorktreeAddOptions {
  path: string;
  revision: string;
  newBranch: string | null;
  detach: boolean;
}

export function confirmWorktreeRemoval(
  worktree: Pick<GitWorktree, "path" | "dirty">,
  confirm: (message: string) => boolean = window.confirm,
): boolean {
  if (!confirm(`Remove this linked worktree registration?\n${worktree.path}`)) return false;
  return !worktree.dirty || confirm(`Confirm destruction of uncommitted changes in this dirty worktree:\n${worktree.path}`);
}

export function GitWorktreeView({
  snapshot,
  parentRepositoryId,
  loading,
  busy,
  onAuthorize,
  onRevoke,
  onAdd,
  onRemove,
  onPrune,
  onLock,
  onUnlock,
}: {
  snapshot: GitWorktreesSnapshot | null;
  parentRepositoryId: GitRepositoryId | null;
  loading: boolean;
  busy: boolean;
  onAuthorize: (path: string) => void;
  onRevoke: (path: string) => void;
  onAdd: (options: GitWorktreeAddOptions) => void;
  onRemove: (worktree: GitWorktree) => void;
  onPrune: () => void;
  onLock: (worktree: GitWorktree, reason: string | null) => void;
  onUnlock: (worktree: GitWorktree) => void;
}) {
  const [path, setPath] = useState("");
  const [revision, setRevision] = useState("HEAD");
  const [newBranch, setNewBranch] = useState("");
  const [detach, setDetach] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || !revision.trim()) return;
    onAdd({
      path: path.trim(),
      revision: revision.trim(),
      newBranch: detach || !newBranch.trim() ? null : newBranch.trim(),
      detach,
    });
  };
  return (
    <section className={styles.root} aria-label="Git worktrees">
      <header>
        <div><GitBranch size={14} /><strong>Worktrees</strong></div>
        <button type="button" disabled={busy} onClick={onPrune}>Prune stale</button>
      </header>
      <p className={styles.identity}>Parent repository <code>{parentRepositoryId ?? "unavailable"}</code>. External paths require an independent exact-path grant.</p>
      {loading ? <p>Loading worktrees…</p> : (
        <ul className={styles.list}>
          {(snapshot?.worktrees ?? []).map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              busy={busy}
              onAuthorize={onAuthorize}
              onRevoke={onRevoke}
              onRemove={onRemove}
              onLock={onLock}
              onUnlock={onUnlock}
            />
          ))}
        </ul>
      )}
      <form className={styles.addForm} onSubmit={submit}>
        <strong><Plus size={13} />Add worktree</strong>
        <label>Absolute target path<input aria-label="Worktree target path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\worktrees\\feature" /></label>
        <div className={styles.addGrid}>
          <label>Revision<input aria-label="Worktree revision" value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
          <label>New branch<input aria-label="Worktree new branch" value={newBranch} disabled={detach} onChange={(event) => setNewBranch(event.target.value)} placeholder="feature/topic" /></label>
        </div>
        <label className={styles.check}><input type="checkbox" checked={detach} onChange={(event) => setDetach(event.target.checked)} />Detached HEAD</label>
        <div className={styles.addActions}>
          <button type="button" disabled={busy || !path.trim()} onClick={() => onAuthorize(path.trim())}><ShieldCheck size={13} />Authorize external path</button>
          <button type="submit" disabled={busy || !path.trim() || !revision.trim()}><Plus size={13} />Add</button>
        </div>
      </form>
    </section>
  );
}

function WorktreeRow({ worktree, busy, onAuthorize, onRevoke, onRemove, onLock, onUnlock }: {
  worktree: GitWorktree;
  busy: boolean;
  onAuthorize: (path: string) => void;
  onRevoke: (path: string) => void;
  onRemove: (worktree: GitWorktree) => void;
  onLock: (worktree: GitWorktree, reason: string | null) => void;
  onUnlock: (worktree: GitWorktree) => void;
}) {
  const branch = worktree.branch?.replace(/^refs\/heads\//, "") ?? (worktree.detached ? "detached HEAD" : "bare");
  return (
    <li className={styles.row}>
      <div className={styles.details}>
        <strong>{branch}</strong>
        <code>{worktree.path}</code>
        <small>
          {worktree.primary ? "primary" : worktree.authorizationRequired ? "external" : "project path"}
          {worktree.dirty === true ? " · dirty" : worktree.dirty === false ? " · clean" : " · status hidden"}
          {worktree.lockedReason ? ` · locked: ${worktree.lockedReason}` : ""}
          {worktree.prunableReason ? ` · prunable: ${worktree.prunableReason}` : ""}
        </small>
      </div>
      <div className={styles.actions}>
        {worktree.authorizationRequired && !worktree.authorized ? <button type="button" disabled={busy} onClick={() => onAuthorize(worktree.path)}><ShieldCheck size={12} />Authorize</button> : null}
        {worktree.authorizationRequired && worktree.authorized ? <button type="button" disabled={busy} onClick={() => onRevoke(worktree.path)}><Unplug size={12} />Revoke</button> : null}
        {!worktree.primary && worktree.lockedReason ? <button type="button" disabled={busy} onClick={() => onUnlock(worktree)}><LockOpen size={12} />Unlock</button> : null}
        {!worktree.primary && !worktree.lockedReason ? <button type="button" disabled={busy || !worktree.authorized} onClick={() => onLock(worktree, window.prompt("Optional worktree lock reason")?.trim() || null)}><Lock size={12} />Lock</button> : null}
        {!worktree.primary ? <button type="button" className={styles.remove} disabled={busy || !worktree.authorized} onClick={() => onRemove(worktree)}><Trash2 size={12} />Remove</button> : null}
      </div>
    </li>
  );
}
