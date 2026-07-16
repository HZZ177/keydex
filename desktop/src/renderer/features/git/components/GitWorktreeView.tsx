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
  if (!confirm(`要移除此关联工作树的登记信息吗？\n${worktree.path}`)) return false;
  return !worktree.dirty || confirm(`此工作树存在未提交改动。确认丢弃这些改动并移除工作树吗？\n${worktree.path}`);
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
    <section className={styles.root} aria-label="Git 工作树">
      <header>
        <div><GitBranch size={14} /><strong>工作树</strong></div>
        <button type="button" disabled={busy} onClick={onPrune}>清理失效登记</button>
      </header>
      <p className={styles.identity}>父仓库 <code>{parentRepositoryId ?? "不可用"}</code>。外部路径需要单独授予精确路径权限。</p>
      {loading ? <p>正在读取工作树…</p> : (
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
        <strong><Plus size={13} />添加工作树</strong>
        <label>目标绝对路径<input aria-label="工作树目标路径" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\项目工作树\\功能分支" /></label>
        <div className={styles.addGrid}>
          <label>修订<input aria-label="工作树修订" value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
          <label>新分支<input aria-label="工作树新分支" value={newBranch} disabled={detach} onChange={(event) => setNewBranch(event.target.value)} placeholder="功能/主题" /></label>
        </div>
        <label className={styles.check}><input type="checkbox" checked={detach} onChange={(event) => setDetach(event.target.checked)} />使用分离指针</label>
        <div className={styles.addActions}>
          <button type="button" disabled={busy || !path.trim()} onClick={() => onAuthorize(path.trim())}><ShieldCheck size={13} />授权外部路径</button>
          <button type="submit" disabled={busy || !path.trim() || !revision.trim()}><Plus size={13} />添加</button>
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
  const branch = worktree.branch?.replace(/^refs\/heads\//, "") ?? (worktree.detached ? "分离指针" : "裸仓库");
  return (
    <li className={styles.row}>
      <div className={styles.details}>
        <strong>{branch}</strong>
        <code>{worktree.path}</code>
        <small>
          {worktree.primary ? "主工作树" : worktree.authorizationRequired ? "外部路径" : "项目路径"}
          {worktree.dirty === true ? " · 有改动" : worktree.dirty === false ? " · 干净" : " · 状态不可见"}
          {worktree.lockedReason ? ` · 已锁定：${worktree.lockedReason}` : ""}
          {worktree.prunableReason ? " · 可清理" : ""}
        </small>
      </div>
      <div className={styles.actions}>
        {worktree.authorizationRequired && !worktree.authorized ? <button type="button" disabled={busy} onClick={() => onAuthorize(worktree.path)}><ShieldCheck size={12} />授权</button> : null}
        {worktree.authorizationRequired && worktree.authorized ? <button type="button" disabled={busy} onClick={() => onRevoke(worktree.path)}><Unplug size={12} />撤销授权</button> : null}
        {!worktree.primary && worktree.lockedReason ? <button type="button" disabled={busy} onClick={() => onUnlock(worktree)}><LockOpen size={12} />解锁</button> : null}
        {!worktree.primary && !worktree.lockedReason ? <button type="button" disabled={busy || !worktree.authorized} onClick={() => onLock(worktree, window.prompt("工作树锁定原因（可选）")?.trim() || null)}><Lock size={12} />锁定</button> : null}
        {!worktree.primary ? <button type="button" className={styles.remove} disabled={busy || !worktree.authorized} onClick={() => onRemove(worktree)}><Trash2 size={12} />移除</button> : null}
      </div>
    </li>
  );
}
