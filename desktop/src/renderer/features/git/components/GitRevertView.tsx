import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitCommandResult, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import { parseCherryPickCommits } from "./GitCherryPickView";
import styles from "./GitRevertView.module.css";

export function GitRevertView({
  refs,
  status,
  busy,
  requestedCommits,
  outcome,
  onRevert,
  onControl,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  busy: boolean;
  requestedCommits: readonly string[];
  outcome: GitCommandResult | null;
  onRevert: (commits: readonly string[], mainline: number | null) => void;
  onControl: (action: "continue" | "skip" | "abort") => void;
}) {
  const [input, setInput] = useState("");
  const [mainline, setMainline] = useState("");
  const [pendingControl, setPendingControl] = useState<"skip" | "abort" | null>(null);
  const commits = useMemo(() => parseCherryPickCommits(input), [input]);
  const duplicate = commits.find((commit, index) => commits.indexOf(commit) !== index) ?? null;
  const parsedMainline = mainline.trim() ? Number(mainline) : null;
  const invalidMainline = parsedMainline !== null && (!Number.isInteger(parsedMainline) || parsedMainline < 1 || parsedMainline > 64);
  const operation = status?.operation?.kind === "revert" ? status.operation : null;
  return (
    <section className={styles.root} aria-label="反向提交处理流程">
      <header><RotateCcw size={14} /><div><strong>反向提交</strong><span>创建新提交以撤销所选提交，不移动或删除现有历史。</span></div></header>
      {operation ? (
        <div className={styles.operation} role="status">
          <div><strong>反向提交：{operationStateLabel(operation.state)}</strong><span>请解决当前提交、跳过它或中止尚未提交的序列。</span></div>
          <button type="button" disabled={busy || operation.state === "conflicted"} onClick={() => onControl("continue")}>继续</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("skip")}>跳过</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("abort")}>中止</button>
        </div>
      ) : null}
      {pendingControl ? (
        <div className={styles.confirmation} role="alertdialog" aria-label="确认反向提交控制操作">
          <strong>{pendingControl === "abort" ? "中止反向提交序列吗？" : "跳过当前反向提交吗？"}</strong>
          <span>{pendingControl === "abort" ? "尚未提交的撤销改动将被丢弃，并恢复到序列开始时的状态。" : "当前撤销提交将被省略，其余提交继续执行。"}</span>
          <button type="button" onClick={() => { const action = pendingControl; setPendingControl(null); onControl(action); }}>{pendingControl === "abort" ? "确认中止" : "确认跳过"}</button>
          <button type="button" onClick={() => setPendingControl(null)}>取消</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label><span>提交（每行一个，按列出顺序撤销）</span><textarea aria-label="要撤销的提交" rows={4} value={input} onChange={(event) => setInput(event.target.value)} /></label>
        <div className={styles.suggestions} aria-label="反向提交引用建议">{refs.slice(0, 8).map((ref) => <button type="button" key={ref.fullName} disabled={busy} onClick={() => setInput((current) => `${current}${current.trim() ? "\n" : ""}${ref.fullName}`)}>{ref.shortName}</button>)}</div>
        <label><span>主线父提交（合并提交必填）</span><input aria-label="主线父提交" type="number" min={1} max={64} step={1} value={mainline} placeholder="1" onChange={(event) => setMainline(event.target.value)} /></label>
        <p className={styles.note}>对于合并提交，请选择需要保留其历史的父提交（通常为 1）。Keydex 不会猜测此值。</p>
        {duplicate ? <p className={styles.warning} role="alert">提交 {duplicate} 重复出现。</p> : null}
        {invalidMainline ? <p className={styles.warning} role="alert">主线父提交必须是 1 到 64 之间的整数。</p> : null}
        <button type="button" className={styles.primary} disabled={busy || commits.length === 0 || Boolean(duplicate) || invalidMainline || Boolean(operation)} onClick={() => onRevert(commits, parsedMainline)}>创建反向提交</button>
      </div>
      {requestedCommits.length ? (
        <ol className={styles.queue} aria-label="反向提交结果队列">{requestedCommits.map((commit, index) => {
          const state = revertItemState(commit, index, requestedCommits, status, outcome);
          return <li key={`${commit}:${index}`} data-state={state}><code>{commit.length > 16 ? commit.slice(0, 12) : commit}</code><span>{queueStateLabel(state)}</span></li>;
        })}</ol>
      ) : null}
    </section>
  );
}

function operationStateLabel(state: NonNullable<GitStatusSnapshot["operation"]>["state"]): string {
  return ({ running: "执行中", conflicted: "存在冲突", continuable: "可以继续" })[state];
}

function queueStateLabel(state: ReturnType<typeof revertItemState>): string {
  return ({ pending: "等待中", reverted: "已撤销", conflicted: "存在冲突", empty: "已跳过", failed: "失败", aborted: "已中止" })[state];
}

export function revertItemState(
  commit: string,
  index: number,
  commits: readonly string[],
  status: GitStatusSnapshot | null,
  outcome: GitCommandResult | null,
): "pending" | "reverted" | "conflicted" | "empty" | "failed" | "aborted" {
  if (outcome?.state === "succeeded" && !status?.operation) {
    if (outcome.summary.toLowerCase().includes("abort")) return "aborted";
    return "reverted";
  }
  const operation = status?.operation?.kind === "revert" ? status.operation : null;
  if (!operation) return outcome?.state === "failed" ? "failed" : "pending";
  const currentObjectId = operation.currentObjectId;
  const currentIndex = currentObjectId
    ? commits.findIndex((candidate) => candidate === currentObjectId || currentObjectId.startsWith(candidate) || candidate.startsWith(currentObjectId))
    : Math.max(0, (operation.currentStep ?? 1) - 1);
  if (currentIndex >= 0 && index < currentIndex) return "reverted";
  if (currentIndex >= 0 && index === currentIndex) return operation.state === "conflicted" ? "conflicted" : "empty";
  return "pending";
}
