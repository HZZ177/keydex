import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitRemoteInfo } from "@/runtime/git";
import type { GitCommitSummary, GitStatusSnapshot } from "@/runtime/gitTypes";
import { GitPushDialog, GitUpdateDialog, type GitPushOptions, type GitUpdateStrategy } from "@/renderer/features/git/dialogs";

import styles from "./GitSyncActions.module.css";

export interface GitFetchOptions {
  remote: string | null;
  allRemotes: boolean;
  prune: boolean;
  tags: boolean;
}

export type { GitUpdateStrategy } from "@/renderer/features/git/dialogs";
export type { GitPushOptions } from "@/renderer/features/git/dialogs";

export function GitSyncActions({
  remotes,
  busy,
  status,
  updateStrategy,
  updateBusy,
  updateError = null,
  credentialLoginRemote = null,
  credentialLoginBusy = false,
  pushBusy,
  pushError = null,
  outgoingCommits = [],
  replacedCommits = [],
  onFetch,
  onUpdateStrategyChange,
  onUpdate,
  onCredentialLogin,
  onPush,
}: {
  remotes: readonly GitRemoteInfo[];
  busy: boolean;
  status: GitStatusSnapshot | null;
  updateStrategy: GitUpdateStrategy;
  updateBusy: boolean;
  updateError?: string | null;
  credentialLoginRemote?: string | null;
  credentialLoginBusy?: boolean;
  pushBusy: boolean;
  pushError?: string | null;
  outgoingCommits?: readonly GitCommitSummary[];
  replacedCommits?: readonly GitCommitSummary[];
  onFetch: (options: GitFetchOptions) => void | Promise<void>;
  onUpdateStrategyChange: (strategy: GitUpdateStrategy) => void;
  onUpdate: (strategy: GitUpdateStrategy) => void | boolean | Promise<void | boolean>;
  onCredentialLogin?: () => void | Promise<void>;
  onPush: (options: GitPushOptions) => void | boolean | Promise<void | boolean>;
}) {
  const [target, setTarget] = useState(remotes[0]?.name ?? "origin");
  const [prune, setPrune] = useState(false);
  const [tags, setTags] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);

  useEffect(() => {
    if (target !== "__all__" && !remotes.some((remote) => remote.name === target)) {
      setTarget(remotes[0]?.name ?? "origin");
    }
  }, [remotes, target]);

  useEffect(() => {
    setUpdateDialogOpen(false);
    setPushDialogOpen(false);
  }, [status?.repositoryId]);

  const allRemotes = target === "__all__";
  const upstream = status?.branch.upstream ?? null;
  const dirty = (status?.files.length ?? 0) > 0;
  const divergence = status ? `领先 ${status.branch.ahead} · 落后 ${status.branch.behind}` : "正在读取分支差异…";
  const pushTarget = status?.branch.upstream ?? (status?.branch.head && remotes[0] ? `${remotes[0].name}/${status.branch.head}` : null);
  return (
    <section className={styles.root} aria-label="远程同步" aria-busy={busy || updateBusy}>
      <div className={styles.heading}>
        <div><strong>获取</strong><span>读取远程引用，不修改工作区文件。</span></div>
        <button
          type="button"
          disabled={busy || remotes.length === 0}
          onClick={() => void onFetch({ remote: allRemotes ? null : target, allRemotes, prune, tags })}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {busy ? "正在获取…" : "获取"}
        </button>
      </div>
      <div className={styles.options}>
        <label>远程仓库
          <select aria-label="获取远程仓库" value={target} disabled={busy || remotes.length === 0} onChange={(event) => setTarget(event.currentTarget.value)}>
            {remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}
            {remotes.length > 1 ? <option value="__all__">全部远程仓库</option> : null}
          </select>
        </label>
        <label className={styles.check}><input type="checkbox" checked={prune} disabled={busy} onChange={(event) => setPrune(event.currentTarget.checked)} />清理远程已删除引用</label>
        <label className={styles.check}><input type="checkbox" checked={tags} disabled={busy} onChange={(event) => setTags(event.currentTarget.checked)} />获取全部标签</label>
      </div>
      <p className={styles.hint}>{prune ? "将清理远程已删除引用对应的本地跟踪引用。" : "默认保留远程已删除引用对应的本地跟踪引用。"}</p>
      <div className={styles.divider} />
      <div className={styles.heading}>
        <div><strong>更新项目</strong><span>{upstream ? `从 ${upstream} 更新当前分支` : "当前分支尚未设置上游"}</span></div>
        <button type="button" disabled={updateBusy} onClick={() => setUpdateDialogOpen(true)}>{updateBusy ? "正在更新…" : "更新…"}</button>
      </div>
      <div className={styles.options}>
        <span className={styles.preflight}>{dirty ? `${status?.files.length} 个本地改动` : "工作树干净"} · {divergence}</span>
      </div>
      {!upstream ? <p className={styles.warning}>请先在分支区域明确选择上游，再执行更新。</p> : null}
      <div className={styles.divider} />
      <div className={styles.heading}>
        <div><strong>推送</strong><span>{status?.branch.head && pushTarget ? `${status.branch.head} → ${pushTarget}` : "当前没有可用的推送目标"}</span></div>
        <button
          type="button"
          disabled={pushBusy}
          onClick={() => setPushDialogOpen(true)}
        >{pushBusy ? "正在推送…" : "推送…"}</button>
      </div>
      <p className={styles.hint}>{status?.branch.upstream ? `比 ${status.branch.upstream} 领先 ${status.branch.ahead} 个提交` : "此次推送将明确创建新的上游关系。"}</p>
      <GitUpdateDialog
        open={updateDialogOpen}
        status={status}
        initialStrategy={updateStrategy}
        busy={updateBusy}
        error={updateError}
        credentialHost={credentialLoginRemote}
        credentialBusy={credentialLoginBusy}
        onCancel={() => setUpdateDialogOpen(false)}
        onConfirm={async (strategy) => {
          onUpdateStrategyChange(strategy);
          const succeeded = await onUpdate(strategy);
          if (succeeded !== false) setUpdateDialogOpen(false);
          return succeeded;
        }}
        onCredentialLogin={credentialLoginRemote ? onCredentialLogin : undefined}
      />
      {pushDialogOpen ? <GitPushDialog
        open={pushDialogOpen}
        status={status}
        remotes={remotes.map((remote) => remote.name)}
        outgoingCommits={outgoingCommits}
        replacedCommits={replacedCommits}
        busy={pushBusy}
        error={pushError}
        onCancel={() => setPushDialogOpen(false)}
        onConfirm={async (options) => {
          const succeeded = await onPush(options);
          if (succeeded !== false) setPushDialogOpen(false);
          return succeeded;
        }}
      /> : null}
    </section>
  );
}
