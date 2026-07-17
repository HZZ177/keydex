import { useEffect, useMemo, useRef, useState } from "react";

import type { GitCommitSummary, GitStatusSnapshot } from "@/runtime/gitTypes";

import { GitConfirmActionDialog, GitDialogField, GitDialogOptions, GitDialogSummary, GitFormDialog } from "./GitDialogFrame";
import { splitGitUpstream, validateGitBranchName } from "./gitDialogContracts";
import styles from "./GitDialogFrame.module.css";

export interface GitPushOptions {
  remote: string;
  source: string;
  target: string;
  setUpstream: boolean;
  tags: boolean;
  forceWithLease: boolean;
}

export function GitPushDialog({
  open,
  status,
  remotes,
  outgoingCommits = [],
  replacedCommits = [],
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  status: GitStatusSnapshot | null;
  remotes: readonly string[];
  outgoingCommits?: readonly GitCommitSummary[];
  replacedCommits?: readonly GitCommitSummary[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (options: GitPushOptions) => void | boolean | Promise<void | boolean>;
}) {
  const upstream = splitGitUpstream(status?.branch.upstream);
  const source = status?.branch.head ?? "";
  const initialRemote = upstream?.remote ?? remotes[0] ?? "";
  const initialTarget = upstream?.branch ?? source;
  const [remote, setRemote] = useState(initialRemote);
  const [target, setTarget] = useState(initialTarget);
  const [setUpstream, setSetUpstream] = useState(!upstream);
  const [tags, setTags] = useState(false);
  const [forceWithLease, setForceWithLease] = useState(false);
  const [forceConfirmationOpen, setForceConfirmationOpen] = useState(false);
  const submittingRef = useRef(false);
  const repositoryId = status?.repositoryId ?? null;
  const remoteOptions = useMemo(
    () => Array.from(new Set([...(initialRemote ? [initialRemote] : []), ...remotes])),
    [initialRemote, remotes],
  );
  const protectedTarget = ["main", "master"].includes(target.trim().toLocaleLowerCase());
  const targetValidation = validateGitBranchName(target);
  const valid = Boolean(source && remote.trim() && targetValidation.valid && remoteOptions.length > 0);

  useEffect(() => {
    if (!open) return;
    setRemote(initialRemote);
    setTarget(initialTarget);
    setSetUpstream(!upstream);
    setTags(false);
    setForceWithLease(false);
    setForceConfirmationOpen(false);
    submittingRef.current = false;
  }, [initialRemote, initialTarget, open, repositoryId, upstream?.branch, upstream?.remote]);

  useEffect(() => {
    if (protectedTarget) setForceWithLease(false);
  }, [protectedTarget]);

  if (!open) return null;

  const options = (): GitPushOptions => ({
    remote: remote.trim(),
    source,
    target: target.trim(),
    setUpstream,
    tags,
    forceWithLease,
  });
  const execute = async () => {
    if (!valid || busy || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onConfirm(options());
    } finally {
      submittingRef.current = false;
    }
  };
  const submit = () => {
    if (forceWithLease) {
      setForceConfirmationOpen(true);
      return;
    }
    return execute();
  };

  if (forceConfirmationOpen) {
    return (
      <GitConfirmActionDialog
        title="确认带租约强制推送"
        description="此操作会改写远程历史。租约会阻止覆盖你尚未获取的远程更新，但不会消除改写历史的风险。"
        target={`${source} → ${remote}/${target.trim()}`}
        details={[
          `将发布 ${outgoingCommits.length} 个本地提交`,
          `可能替换 ${replacedCommits.length || status?.branch.behind || 0} 个远程提交`,
        ]}
        confirmLabel={busy ? "正在推送…" : "带租约强制推送"}
        busy={busy}
        onCancel={() => setForceConfirmationOpen(false)}
        onConfirm={() => void execute()}
      />
    );
  }

  return (
    <GitFormDialog
      title="推送"
      description="确认源分支、远程仓库和目标分支后再发布提交。"
      confirmLabel={busy ? "正在推送…" : forceWithLease ? "继续确认" : "推送"}
      busy={busy}
      valid={valid}
      error={error}
      onCancel={onCancel}
      onSubmit={submit}
    >
      <GitDialogSummary tone={forceWithLease ? "danger" : "default"}>
        <strong>{source ? `${source} → ${remote || "未选择远程"}/${target || "未填写目标"}` : "当前处于分离指针状态"}</strong>
        <span>{status?.branch.upstream ? `当前上游：${status.branch.upstream}` : "首次推送将创建上游关系"}</span>
        <span>领先 {status?.branch.ahead ?? 0} · 落后 {status?.branch.behind ?? 0}</span>
      </GitDialogSummary>

      <GitDialogField label="远程仓库" error={!remoteOptions.length ? "当前仓库没有可用的远程仓库" : undefined}>
        <select aria-label="推送远程仓库" value={remote} disabled={busy || !remoteOptions.length} onChange={(event) => setRemote(event.currentTarget.value)}>
          {remoteOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </GitDialogField>
      <GitDialogField label="目标分支" error={target && !targetValidation.valid ? targetValidation.message : undefined}>
        <input aria-label="推送目标分支" value={target} disabled={busy} onChange={(event) => setTarget(event.currentTarget.value)} />
      </GitDialogField>
      <GitDialogOptions>
        <label><input type="checkbox" checked={setUpstream} disabled={busy} onChange={(event) => setSetUpstream(event.currentTarget.checked)} />设置上游</label>
        <label><input type="checkbox" checked={tags} disabled={busy} onChange={(event) => setTags(event.currentTarget.checked)} />推送标签</label>
        <label><input type="checkbox" checked={forceWithLease} disabled={busy || protectedTarget} onChange={(event) => setForceWithLease(event.currentTarget.checked)} />带租约强制推送</label>
      </GitDialogOptions>

      {outgoingCommits.length > 0 ? <GitCommitPreview title="将要发布的提交" commits={outgoingCommits} /> : null}
      {forceWithLease && replacedCommits.length > 0 ? <GitCommitPreview title="可能被替换的远程提交" commits={replacedCommits} tone="danger" /> : null}
      {!source ? <GitDialogSummary tone="warning">当前处于分离指针状态，无法推送分支。</GitDialogSummary> : null}
      {!remoteOptions.length ? <GitDialogSummary tone="warning">请先添加远程仓库，再执行推送。</GitDialogSummary> : null}
      {protectedTarget ? <GitDialogSummary tone="warning">受保护分支 {target.trim()} 不允许强制推送。</GitDialogSummary> : null}
      {forceWithLease ? <GitDialogSummary tone="danger">强制推送只使用带租约保护的方式；下一步仍需最终确认。</GitDialogSummary> : null}
    </GitFormDialog>
  );
}

function GitCommitPreview({ title, commits, tone = "default" }: { title: string; commits: readonly GitCommitSummary[]; tone?: "default" | "danger" }) {
  return (
    <section className={styles.commitList} data-tone={tone} aria-label={title}>
      <strong>{title}（{commits.length}）</strong>
      <ul>{commits.map((commit) => <li key={commit.objectId}><code>{commit.objectId.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ul>
    </section>
  );
}
