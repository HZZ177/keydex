import { GitBranch, Lock, LockOpen, ShieldCheck, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitRepositoryId, GitWorktree, GitWorktreesSnapshot } from "@/runtime/gitTypes";

import { GitConfirmActionDialog, GitDialogField, GitDialogOptions, GitFormDialog } from "../dialogs";
import styles from "./GitWorktreeView.module.css";

export interface GitWorktreeAddOptions {
  path: string;
  revision: string;
  newBranch: string | null;
  detach: boolean;
}

type WorktreeConfirmation = {
  kind: "authorize" | "revoke" | "remove" | "prune";
  path?: string;
  worktree?: GitWorktree;
};

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
  const [addOpen, setAddOpen] = useState(false);
  const [authorizationPath, setAuthorizationPath] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<WorktreeConfirmation | null>(null);
  const [pendingLock, setPendingLock] = useState<GitWorktree | null>(null);
  const [lockReason, setLockReason] = useState("");

  useEffect(() => {
    setAddOpen(false);
    setAuthorizationPath(null);
    setPendingConfirm(null);
    setPendingLock(null);
  }, [parentRepositoryId]);

  return (
    <section className={styles.root} aria-label="Git 工作树">
      <header>
        <div><GitBranch size={14} /><strong>工作树</strong></div>
        <div className={styles.headerActions}>
          <button type="button" disabled={busy} onClick={() => setAuthorizationPath("")}>授权路径…</button>
          <button type="button" disabled={busy} onClick={() => setAddOpen(true)}>添加工作树…</button>
          <button type="button" disabled={busy} onClick={() => setPendingConfirm({ kind: "prune" })}>清理失效登记…</button>
        </div>
      </header>
      <p className={styles.identity}>父仓库 <code>{parentRepositoryId ?? "不可用"}</code>。外部路径需要单独授予精确路径权限。</p>
      {loading ? <p>正在读取工作树…</p> : (
        <ul className={styles.list}>
          {(snapshot?.worktrees ?? []).map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              busy={busy}
              onUnlock={onUnlock}
              onConfirm={setPendingConfirm}
              onRequestLock={(candidate) => { setLockReason(""); setPendingLock(candidate); }}
            />
          ))}
        </ul>
      )}
      {addOpen ? (
        <GitFormDialog
          title="添加工作树"
          description="创建关联工作树。目标必须是绝对路径；外部路径需要先单独授权。"
          confirmLabel="添加"
          busy={busy}
          valid={Boolean(path.trim() && revision.trim())}
          onCancel={() => setAddOpen(false)}
          onSubmit={() => {
            setAddOpen(false);
            onAdd({ path: path.trim(), revision: revision.trim(), newBranch: detach || !newBranch.trim() ? null : newBranch.trim(), detach });
          }}
        >
          <GitDialogField label="目标绝对路径"><input aria-label="工作树目标路径" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\项目工作树\\功能分支" /></GitDialogField>
          <GitDialogField label="修订"><input aria-label="工作树修订" value={revision} onChange={(event) => setRevision(event.target.value)} /></GitDialogField>
          <GitDialogField label="新分支" hint={detach ? "分离指针时不会创建新分支。" : undefined}><input aria-label="工作树新分支" value={newBranch} disabled={detach} onChange={(event) => setNewBranch(event.target.value)} placeholder="功能/主题" /></GitDialogField>
          <GitDialogOptions><label><input type="checkbox" checked={detach} onChange={(event) => setDetach(event.target.checked)} />使用分离指针</label></GitDialogOptions>
        </GitFormDialog>
      ) : null}
      {authorizationPath !== null ? (
        <GitFormDialog
          title="授权外部工作树路径"
          description="授权仅适用于当前父仓库的 Git 元数据访问，不会扩大文件或终端权限。"
          confirmLabel="确认授权"
          busy={busy}
          valid={Boolean(authorizationPath.trim())}
          onCancel={() => setAuthorizationPath(null)}
          onSubmit={() => { const exactPath = authorizationPath.trim(); setAuthorizationPath(null); onAuthorize(exactPath); }}
        >
          <GitDialogField label="精确绝对路径"><input aria-label="要授权的工作树路径" value={authorizationPath} onChange={(event) => setAuthorizationPath(event.target.value)} /></GitDialogField>
        </GitFormDialog>
      ) : null}
      {pendingLock ? (
        <GitFormDialog
          title="锁定工作树"
          description="锁定可防止 Git 自动清理该工作树。锁定原因可以留空。"
          confirmLabel="锁定"
          busy={busy}
          onCancel={() => setPendingLock(null)}
          onSubmit={() => { const candidate = pendingLock; setPendingLock(null); onLock(candidate, lockReason.trim() || null); }}
        >
          <GitDialogField label="工作树"><input value={pendingLock.path} readOnly /></GitDialogField>
          <GitDialogField label="锁定原因（可选）"><input aria-label="工作树锁定原因" value={lockReason} onChange={(event) => setLockReason(event.target.value)} /></GitDialogField>
        </GitFormDialog>
      ) : null}
      {pendingConfirm ? (
        <GitConfirmActionDialog
          title={worktreeConfirmTitle(pendingConfirm.kind)}
          description={worktreeConfirmDescription(pendingConfirm)}
          target={pendingConfirm.worktree?.path ?? pendingConfirm.path}
          details={pendingConfirm.worktree ? [
            `状态：${pendingConfirm.worktree.dirty === true ? "有未提交改动，将强制移除" : pendingConfirm.worktree.dirty === false ? "干净" : "不可见"}`,
            `锁定：${pendingConfirm.worktree.lockedReason ?? "否"}`,
          ] : []}
          confirmLabel={pendingConfirm.kind === "prune" ? "确认清理" : pendingConfirm.kind === "remove" ? "确认移除" : pendingConfirm.kind === "revoke" ? "确认撤销" : "确认授权"}
          busy={busy}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const pending = pendingConfirm;
            setPendingConfirm(null);
            if (pending.kind === "prune") onPrune();
            else if (pending.kind === "remove" && pending.worktree) onRemove(pending.worktree);
            else if (pending.kind === "revoke" && pending.path) onRevoke(pending.path);
            else if (pending.path) onAuthorize(pending.path);
          }}
        />
      ) : null}
    </section>
  );
}

function WorktreeRow({ worktree, busy, onUnlock, onConfirm, onRequestLock }: {
  worktree: GitWorktree;
  busy: boolean;
  onUnlock: (worktree: GitWorktree) => void;
  onConfirm: (pending: WorktreeConfirmation) => void;
  onRequestLock: (worktree: GitWorktree) => void;
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
        {worktree.authorizationRequired && !worktree.authorized ? <button type="button" disabled={busy} onClick={() => onConfirm({ kind: "authorize", path: worktree.path })}><ShieldCheck size={12} />授权</button> : null}
        {worktree.authorizationRequired && worktree.authorized ? <button type="button" disabled={busy} onClick={() => onConfirm({ kind: "revoke", path: worktree.path })}><Unplug size={12} />撤销授权</button> : null}
        {!worktree.primary && worktree.lockedReason ? <button type="button" disabled={busy} onClick={() => onUnlock(worktree)}><LockOpen size={12} />解锁</button> : null}
        {!worktree.primary && !worktree.lockedReason ? <button type="button" disabled={busy || !worktree.authorized} onClick={() => onRequestLock(worktree)}><Lock size={12} />锁定</button> : null}
        {!worktree.primary ? <button type="button" className={styles.remove} disabled={busy || !worktree.authorized} onClick={() => onConfirm({ kind: "remove", worktree })}><Trash2 size={12} />移除</button> : null}
      </div>
    </li>
  );
}

function worktreeConfirmTitle(kind: WorktreeConfirmation["kind"]): string {
  return ({ authorize: "确认授权外部工作树", revoke: "确认撤销工作树授权", remove: "确认移除工作树", prune: "确认清理失效登记" })[kind];
}

function worktreeConfirmDescription(pending: WorktreeConfirmation): string {
  if (pending.kind === "authorize") return "仅允许当前父仓库读取这个精确路径的 Git 元数据，不扩大文件或终端权限。";
  if (pending.kind === "revoke") return "撤销后 Keydex 将不再读取此外部工作树路径。";
  if (pending.kind === "prune") return "只会清理 Git 判定为失效的工作树登记信息。";
  return pending.worktree?.dirty ? "此工作树存在未提交改动；移除会强制丢弃这些改动。" : "将移除关联工作树及其登记信息；主工作树不会出现在此操作中。";
}
