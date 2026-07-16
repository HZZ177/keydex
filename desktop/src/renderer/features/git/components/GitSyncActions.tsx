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
  const divergence = status ? `${status.branch.ahead} ahead · ${status.branch.behind} behind` : "Loading divergence…";
  const protectedTarget = ["main", "master"].includes(pushTarget.toLocaleLowerCase());
  return (
    <section className={styles.root} aria-label="远程同步" aria-busy={busy || updateBusy}>
      <div className={styles.heading}>
        <div><strong>Fetch</strong><span>读取远程 refs，不修改工作区文件。</span></div>
        <button
          type="button"
          disabled={busy || remotes.length === 0}
          onClick={() => void onFetch({ remote: allRemotes ? null : target, allRemotes, prune, tags })}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {busy ? "Fetching…" : "Fetch"}
        </button>
      </div>
      <div className={styles.options}>
        <label>Remote
          <select aria-label="Fetch remote" value={target} disabled={busy || remotes.length === 0} onChange={(event) => setTarget(event.currentTarget.value)}>
            {remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}
            {remotes.length > 1 ? <option value="__all__">All remotes</option> : null}
          </select>
        </label>
        <label className={styles.check}><input type="checkbox" checked={prune} disabled={busy} onChange={(event) => setPrune(event.currentTarget.checked)} />Prune deleted refs</label>
        <label className={styles.check}><input type="checkbox" checked={tags} disabled={busy} onChange={(event) => setTags(event.currentTarget.checked)} />Fetch all tags</label>
      </div>
      <p className={styles.hint}>{prune ? "将显式清理远程已删除的 tracking refs。" : "默认保留远程已删除的本地 tracking refs。"}</p>
      {progress.length > 0 ? <output className={styles.progress} aria-live="polite">{progress.join("\n")}</output> : null}
      <div className={styles.divider} />
      <div className={styles.heading}>
        <div><strong>Update Project</strong><span>{upstream ? `从 ${upstream} 更新当前分支` : "当前分支尚未设置 upstream"}</span></div>
        <button type="button" disabled={updateBusy || !upstream} onClick={() => void onUpdate()}>{updateBusy ? "Updating…" : "Update"}</button>
      </div>
      <div className={styles.options}>
        <label>Strategy
          <select aria-label="Update strategy" value={updateStrategy} disabled={updateBusy} onChange={(event) => onUpdateStrategyChange(event.currentTarget.value as GitUpdateStrategy)}>
            <option value="ff_only">Fast-forward only (default)</option>
            <option value="merge">Merge</option>
            <option value="rebase">Rebase</option>
          </select>
        </label>
        <span className={styles.preflight}>{dirty ? `${status?.files.length} local changes` : "Clean worktree"} · {divergence}</span>
      </div>
      {dirty ? <p className={styles.warning}>工作区存在本地改动；Merge/Rebase 可能失败。Keydex 不会自动 stash，也不会在策略失败后 fallback。</p> : null}
      {!upstream ? <p className={styles.warning}>请先在分支区域显式选择 upstream，再执行 Update。</p> : null}
      {updateOutcome ? <output className={styles.outcome} data-status={updateOutcome} aria-live="polite">{updateOutcome === "up_to_date" ? "Already up to date" : updateOutcome === "updated" ? "Updated successfully" : "Update stopped on conflicts"}</output> : null}
      <div className={styles.divider} />
      <div className={styles.heading}>
        <div><strong>Push</strong><span>{status?.branch.head ? `${status.branch.head} → ${pushRemote}/${pushTarget}` : "Detached HEAD cannot be pushed from this view"}</span></div>
        <button
          type="button"
          disabled={pushBusy || !status?.branch.head || !pushRemote || !pushTarget.trim()}
          onClick={() => status?.branch.head && void onPush({ remote: pushRemote, source: status.branch.head, target: pushTarget.trim(), setUpstream, tags: pushTags, forceWithLease })}
        >{pushBusy ? "Pushing…" : forceWithLease ? "Force Push with Lease" : "Push"}</button>
      </div>
      <div className={styles.options}>
        <label>Remote<select aria-label="Push remote" value={pushRemote} disabled={pushBusy} onChange={(event) => setPushRemote(event.currentTarget.value)}>{remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select></label>
        <label>Target<input aria-label="Push target branch" value={pushTarget} disabled={pushBusy} onChange={(event) => setPushTarget(event.currentTarget.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={setUpstream} disabled={pushBusy} onChange={(event) => setSetUpstream(event.currentTarget.checked)} />Set upstream</label>
        <label className={styles.check}><input type="checkbox" checked={pushTags} disabled={pushBusy} onChange={(event) => setPushTags(event.currentTarget.checked)} />Push tags</label>
        <label className={styles.check}><input type="checkbox" checked={forceWithLease} disabled={pushBusy || protectedTarget} onChange={(event) => setForceWithLease(event.currentTarget.checked)} />Force with lease</label>
      </div>
      <p className={styles.hint}>{status?.branch.upstream ? `${status.branch.ahead} commit(s) ahead of ${status.branch.upstream}` : "This will create a new upstream explicitly."}</p>
      {outgoingCommits.length > 0 ? (
        <section className={styles.commitPreview} aria-label="Outgoing commits" data-testid="git-push-outgoing-commits">
          <strong>Commits to publish ({outgoingCommits.length})</strong>
          <ul>{outgoingCommits.map((commit) => <li key={commit.objectId}><code>{commit.objectId.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ul>
        </section>
      ) : null}
      {forceWithLease && replacedCommits.length > 0 ? (
        <section className={styles.commitPreview} aria-label="Remote commits that will be replaced" data-testid="git-push-replaced-commits">
          <strong>Remote commits that may be replaced ({replacedCommits.length})</strong>
          <ul>{replacedCommits.map((commit) => <li key={commit.objectId}><code>{commit.objectId.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ul>
        </section>
      ) : null}
      {protectedTarget ? <p className={styles.warning}>Force push is blocked for protected branch {pushTarget}.</p> : forceWithLease ? <p className={styles.warning}>Lease protects against stale remote state. {replacedCommits.length || status?.branch.behind || 0} remote commit(s) may be replaced; bare --force is never used.</p> : null}
      {pushOutcome ? <output className={styles.outcome} data-status={pushOutcome} aria-live="polite">{pushOutcome === "pushed" ? "Push completed" : "Push rejected: fetch/update before retrying"}</output> : null}
    </section>
  );
}
