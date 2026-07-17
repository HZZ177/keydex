import { Cherry, GripVertical } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitCommandResult, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import { GitConfirmActionDialog } from "../dialogs";
import styles from "./GitCherryPickView.module.css";

export function GitCherryPickView({
  refs,
  status,
  busy,
  requestedCommits,
  skippedCommits = [],
  outcome,
  onCherryPick,
  onControl,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  busy: boolean;
  requestedCommits: readonly string[];
  skippedCommits?: readonly string[];
  outcome: GitCommandResult | null;
  onCherryPick: (commits: readonly string[], recordOrigin: boolean) => void;
  onControl: (action: "continue" | "skip" | "abort") => void;
}) {
  const [input, setInput] = useState("");
  const [recordOrigin, setRecordOrigin] = useState(false);
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingControl, setPendingControl] = useState<"skip" | "abort" | null>(null);
  const commits = useMemo(() => parseCherryPickCommits(input), [input]);
  const duplicate = commits.find((commit, index) => commits.indexOf(commit) !== index) ?? null;
  const operation = status?.operation?.kind === "cherry_pick" ? status.operation : null;
  return (
    <section className={styles.root} aria-label="摘取提交流程">
      <header>
        <Cherry size={14} />
        <div><strong>摘取提交</strong><span>按照下方列出的顺序依次应用一个或多个提交。</span></div>
      </header>
      {operation ? (
        <div className={styles.operation} role="status">
          <div><strong>摘取提交：{operationStateLabel(operation.state)}</strong><span>{operation.currentStep && operation.totalSteps ? `第 ${operation.currentStep}/${operation.totalSteps} 个提交` : "请解决当前提交、跳过它或中止整个序列。"}</span></div>
          <button type="button" disabled={busy || operation.state === "conflicted"} onClick={() => onControl("continue")}>继续</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("skip")}>跳过</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("abort")}>中止</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label>
          <span>提交（每行一个，按从上到下的顺序应用）</span>
          <textarea
            aria-label="要摘取的提交"
            rows={4}
            value={input}
            placeholder={"分支名~2\n分支名~1\n分支名"}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <div className={styles.suggestions} aria-label="提交引用建议">{refs.slice(0, 8).map((ref) => <button type="button" key={ref.fullName} disabled={busy} onClick={() => setInput((current) => `${current}${current.trim() ? "\n" : ""}${ref.fullName}`)}>{ref.shortName}</button>)}</div>
        <label className={styles.check}><input type="checkbox" checked={recordOrigin} onChange={(event) => setRecordOrigin(event.target.checked)} />附加来源信息（-x）</label>
        {duplicate ? <p className={styles.warning} role="alert">提交 {duplicate} 重复出现。</p> : null}
        <button type="button" className={styles.primary} disabled={busy || commits.length === 0 || Boolean(duplicate) || Boolean(operation)} onClick={() => setPendingStart(true)}>摘取提交</button>
      </div>
      {requestedCommits.length > 0 ? (
        <ol className={styles.queue} aria-label="摘取提交结果队列">
          {requestedCommits.map((commit, index) => {
            const state = cherryPickItemState(commit, index, requestedCommits, status, outcome, skippedCommits);
            return <li key={`${commit}:${index}`} data-state={state}><GripVertical size={12} /><code>{commit.length > 16 ? commit.slice(0, 12) : commit}</code><span>{queueStateLabel(state)}</span></li>;
          })}
        </ol>
      ) : null}
      {pendingStart && commits.length > 0 && !duplicate ? (
        <GitConfirmActionDialog
          title="确认摘取提交"
          description="提交将按照列出的顺序依次应用到当前分支。"
          target={`${commits.length} 个提交`}
          details={[commits.join(" → "), `来源信息：${recordOrigin ? "写入 -x" : "不写入"}`]}
          confirmLabel="确认摘取"
          confirmTone="default"
          busy={busy}
          onCancel={() => setPendingStart(false)}
          onConfirm={() => { setPendingStart(false); onCherryPick(commits, recordOrigin); }}
        />
      ) : null}
      {pendingControl && operation ? (
        <GitConfirmActionDialog
          title={pendingControl === "abort" ? "确认中止摘取提交" : "确认跳过当前提交"}
          description={pendingControl === "abort" ? "分支和工作树将恢复到序列开始前的状态。" : "只会省略当前提交，其余提交继续执行。"}
          target={operation.currentObjectId ? `当前对象：${operation.currentObjectId.slice(0, 12)}` : "当前摘取步骤"}
          details={operation.currentStep && operation.totalSteps ? [`进度：${operation.currentStep}/${operation.totalSteps}`] : []}
          confirmLabel={pendingControl === "abort" ? "确认中止" : "确认跳过"}
          busy={busy}
          onCancel={() => setPendingControl(null)}
          onConfirm={() => { const action = pendingControl; setPendingControl(null); onControl(action); }}
        />
      ) : null}
    </section>
  );
}

function operationStateLabel(state: NonNullable<GitStatusSnapshot["operation"]>["state"]): string {
  return ({ running: "执行中", conflicted: "存在冲突", continuable: "可以继续" })[state];
}

function queueStateLabel(state: ReturnType<typeof cherryPickItemState>): string {
  return ({ pending: "等待中", applied: "已应用", conflicted: "存在冲突", empty: "已跳过", failed: "失败", aborted: "已中止" })[state];
}

export function parseCherryPickCommits(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function cherryPickItemState(
  commit: string,
  index: number,
  commits: readonly string[],
  status: GitStatusSnapshot | null,
  outcome: GitCommandResult | null,
  skippedCommits: readonly string[] = [],
): "pending" | "applied" | "conflicted" | "empty" | "failed" | "aborted" {
  if (skippedCommits.some((skipped) => commit === skipped || commit.startsWith(skipped) || skipped.startsWith(commit))) {
    return "empty";
  }
  if (outcome?.state === "succeeded" && !status?.operation) {
    if (outcome.summary.toLowerCase().includes("abort")) return "aborted";
    return "applied";
  }
  const operation = status?.operation?.kind === "cherry_pick" ? status.operation : null;
  if (!operation) return outcome?.state === "failed" ? "failed" : "pending";
  const currentObjectId = operation.currentObjectId;
  const currentIndex = currentObjectId
    ? commits.findIndex((candidate) => candidate === currentObjectId || currentObjectId.startsWith(candidate) || candidate.startsWith(currentObjectId))
    : Math.max(0, (operation.currentStep ?? 1) - 1);
  if (currentIndex >= 0 && index < currentIndex) return "applied";
  if (currentIndex >= 0 && index === currentIndex) return operation.state === "conflicted" ? "conflicted" : "empty";
  return "pending";
}
