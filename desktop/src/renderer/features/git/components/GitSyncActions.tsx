import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitRemoteInfo } from "@/runtime/git";
import type { GitCommitSummary, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitSyncActions.module.css";

export interface GitFetchOptions {
  remote: string | null;
  allRemotes: boolean;
  prune: boolean;
  tags: boolean;
}

export type GitUpdateStrategy = "ff_only" | "merge" | "rebase";

export interface GitPushOptions {
  remote: string;
  source: string;
  target: string;
  setUpstream: boolean;
  tags: boolean;
  forceWithLease: boolean;
}

export function GitSyncActions({
  remotes,
  busy,
  progress,
  status,
  updateStrategy,
  updateBusy,
  updateOutcome,
  pushBusy,
  pushOutcome,
  outgoingCommits = [],
  replacedCommits = [],
  onFetch,
  onUpdateStrategyChange,
  onUpdate,
  onPush,
}: {
  remotes: readonly GitRemoteInfo[];
  busy: boolean;
  progress: readonly string[];
  status: GitStatusSnapshot | null;
  updateStrategy: GitUpdateStrategy;
  updateBusy: boolean;
  updateOutcome: "up_to_date" | "updated" | "conflict" | null;
  pushBusy: boolean;
  pushOutcome: "pushed" | "rejected" | null;
  outgoingCommits?: readonly GitCommitSummary[];
  replacedCommits?: readonly GitCommitSummary[];
  onFetch: (options: GitFetchOptions) => void | Promise<void>;
  onUpdateStrategyChange: (strategy: GitUpdateStrategy) => void;
  onUpdate: () => void | Promise<void>;
  onPush: (options: GitPushOptions) => void | Promise<void>;
}) {
  const [target, setTarget] = useState(remotes[0]?.name ?? "origin");
  const [prune, setPrune] = useState(false);
  const [tags, setTags] = useState(false);
  const [pushRemote, setPushRemote] = useState(remotes[0]?.name ?? "origin");
  const [pushTarget, setPushTarget] = useState(status?.branch.head ?? "main");
  const [pushTags, setPushTags] = useState(false);
  const [setUpstream, setSetUpstream] = useState(!status?.branch.upstream);
  const [forceWithLease, setForceWithLease] = useState(false);

  useEffect(() => {
    if (target !== "__all__" && !remotes.some((remote) => remote.name === target)) {
      setTarget(remotes[0]?.name ?? "origin");
    }
  }, [remotes, target]);

  useEffect(() => {
    const upstream = status?.branch.upstream;
    const separator = upstream?.indexOf("/") ?? -1;
    if (upstream && separator > 0) {
      setPushRemote(upstream.slice(0, separator));
      setPushTarget(upstream.slice(separator + 1));
      setSetUpstream(false);
    } else {
      setPushRemote((current) => remotes.some((remote) => remote.name === current) ? current : remotes[0]?.name ?? "origin");
      setPushTarget(status?.branch.head ?? "main");
      setSetUpstream(true);
    }
  }, [remotes, status?.branch.head, status?.branch.upstream]);

  const allRemotes = target === "__all__";
  const upstream = status?.branch.upstream ?? null;
  const dirty = (status?.files.length ?? 0) > 0;
  const divergence = status ? `领先 ${status.branch.ahead} · 落后 ${status.branch.behind}` : "正在读取分支差异…";
  const protectedTarget = ["main", "master"].includes(pushTarget.toLocaleLowerCase());
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
      {progress.length > 0 ? <output className={styles.progress} aria-live="polite">正在接收远程仓库数据…（{progress.length} 条进度更新）</output> : null}
      <div className={styles.divider} />
      <div className={styles.heading}>
        <div><strong>更新项目</strong><span>{upstream ? `从 ${upstream} 更新当前分支` : "当前分支尚未设置上游"}</span></div>
        <button type="button" disabled={updateBusy || !upstream} onClick={() => void onUpdate()}>{updateBusy ? "正在更新…" : "更新"}</button>
      </div>
      <div className={styles.options}>
        <label>更新策略
          <select aria-label="更新策略" value={updateStrategy} disabled={updateBusy} onChange={(event) => onUpdateStrategyChange(event.currentTarget.value as GitUpdateStrategy)}>
            <option value="ff_only">仅快进（默认）</option>
            <option value="merge">合并</option>
            <option value="rebase">变基</option>
          </select>
        </label>
        <span className={styles.preflight}>{dirty ? `${status?.files.length} 个本地改动` : "工作树干净"} · {divergence}</span>
      </div>
      {dirty ? <p className={styles.warning}>工作区存在本地改动；合并或变基可能失败。Keydex 不会自动储藏，也不会在策略失败后自动切换策略。</p> : null}
      {!upstream ? <p className={styles.warning}>请先在分支区域明确选择上游，再执行更新。</p> : null}
      {updateOutcome ? <output className={styles.outcome} data-status={updateOutcome} aria-live="polite">{updateOutcome === "up_to_date" ? "已是最新状态" : updateOutcome === "updated" ? "更新成功" : "更新因冲突而停止"}</output> : null}
      <div className={styles.divider} />
      <div className={styles.heading}>
        <div><strong>推送</strong><span>{status?.branch.head ? `${status.branch.head} → ${pushRemote}/${pushTarget}` : "当前处于分离指针状态，无法从此处推送"}</span></div>
        <button
          type="button"
          disabled={pushBusy || !status?.branch.head || !pushRemote || !pushTarget.trim()}
          onClick={() => status?.branch.head && void onPush({ remote: pushRemote, source: status.branch.head, target: pushTarget.trim(), setUpstream, tags: pushTags, forceWithLease })}
        >{pushBusy ? "正在推送…" : forceWithLease ? "带租约强制推送" : "推送"}</button>
      </div>
      <div className={styles.options}>
        <label>远程仓库<select aria-label="推送远程仓库" value={pushRemote} disabled={pushBusy} onChange={(event) => setPushRemote(event.currentTarget.value)}>{remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select></label>
        <label>目标分支<input aria-label="推送目标分支" value={pushTarget} disabled={pushBusy} onChange={(event) => setPushTarget(event.currentTarget.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={setUpstream} disabled={pushBusy} onChange={(event) => setSetUpstream(event.currentTarget.checked)} />设置上游</label>
        <label className={styles.check}><input type="checkbox" checked={pushTags} disabled={pushBusy} onChange={(event) => setPushTags(event.currentTarget.checked)} />推送标签</label>
        <label className={styles.check}><input type="checkbox" checked={forceWithLease} disabled={pushBusy || protectedTarget} onChange={(event) => setForceWithLease(event.currentTarget.checked)} />带租约强制推送</label>
      </div>
      <p className={styles.hint}>{status?.branch.upstream ? `比 ${status.branch.upstream} 领先 ${status.branch.ahead} 个提交` : "此次推送将明确创建新的上游关系。"}</p>
      {outgoingCommits.length > 0 ? (
        <section className={styles.commitPreview} aria-label="待推送提交" data-testid="git-push-outgoing-commits">
          <strong>将要发布的提交（{outgoingCommits.length}）</strong>
          <ul>{outgoingCommits.map((commit) => <li key={commit.objectId}><code>{commit.objectId.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ul>
        </section>
      ) : null}
      {forceWithLease && replacedCommits.length > 0 ? (
        <section className={styles.commitPreview} aria-label="可能被替换的远程提交" data-testid="git-push-replaced-commits">
          <strong>可能被替换的远程提交（{replacedCommits.length}）</strong>
          <ul>{replacedCommits.map((commit) => <li key={commit.objectId}><code>{commit.objectId.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ul>
        </section>
      ) : null}
      {protectedTarget ? <p className={styles.warning}>受保护分支 {pushTarget} 不允许强制推送。</p> : forceWithLease ? <p className={styles.warning}>租约会防止覆盖过期的远程状态。可能替换 {replacedCommits.length || status?.branch.behind || 0} 个远程提交；不会使用无保护的强制参数。</p> : null}
      {pushOutcome ? <output className={styles.outcome} data-status={pushOutcome} aria-live="polite">{pushOutcome === "pushed" ? "推送完成" : "推送被拒绝：请先获取或更新后再试"}</output> : null}
    </section>
  );
}
