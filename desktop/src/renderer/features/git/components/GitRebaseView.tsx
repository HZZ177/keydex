import { ArrowDown, ArrowUp, GitPullRequestArrow, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitRebaseAction, GitRebasePreview, GitRebaseTodoItem, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitRebaseView.module.css";

export function GitRebaseView({
  refs,
  status,
  preview,
  busy,
  onPreview,
  onRebase,
  onControl,
}: {
  refs: readonly GitRef[];
  status: GitStatusSnapshot | null;
  preview: GitRebasePreview | null;
  busy: boolean;
  onPreview: (upstream: string, onto: string | null) => void;
  onRebase: (upstream: string, onto: string | null, interactive: boolean, todo: readonly GitRebaseTodoItem[]) => void;
  onControl: (action: "continue" | "skip" | "abort") => void;
}) {
  const [upstream, setUpstream] = useState("");
  const [onto, setOnto] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [todo, setTodo] = useState<GitRebaseTodoItem[]>([]);
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingControl, setPendingControl] = useState<"skip" | "abort" | null>(null);
  useEffect(() => {
    setTodo((preview?.commits ?? []).map((item) => ({ ...item, action: "pick" })));
  }, [preview]);
  const validationError = useMemo(() => validateRebaseTodo(todo), [todo]);
  const operation = status?.operation?.kind === "rebase" ? status.operation : null;
  const previewMatches = preview?.upstream === upstream.trim() && (preview.onto ?? "") === onto.trim();
  return (
    <section className={styles.root} aria-label="变基流程">
      <header><GitPullRequestArrow size={14} /><div><strong>变基</strong><span>将当前分支提交重新应用到上游或指定目标修订上。</span></div></header>
      {operation ? (
        <div className={styles.operation} role="status">
          <div><strong>变基：{operationStateLabel(operation.state)}</strong><span>{operation.currentStep && operation.totalSteps ? `第 ${operation.currentStep}/${operation.totalSteps} 步` : "请解决当前步骤、跳过它或中止操作。"}</span></div>
          <button type="button" disabled={busy || operation.state === "conflicted"} onClick={() => onControl("continue")}>继续</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("skip")}>跳过</button>
          <button type="button" disabled={busy} onClick={() => setPendingControl("abort")}>中止</button>
        </div>
      ) : null}
      <div className={styles.form}>
        <label><span>上游修订</span><input aria-label="变基上游修订" list="git-rebase-refs" value={upstream} onChange={(event) => setUpstream(event.target.value)} /></label>
        <label><span>目标修订（可选）</span><input aria-label="变基目标修订" list="git-rebase-refs" value={onto} onChange={(event) => setOnto(event.target.value)} /></label>
        <datalist id="git-rebase-refs">{refs.map((ref) => <option value={ref.fullName} key={ref.fullName}>{ref.shortName}</option>)}</datalist>
        <label className={styles.check}><input type="checkbox" checked={interactive} onChange={(event) => setInteractive(event.target.checked)} />编辑交互式任务列表</label>
        <div className={styles.buttons}>
          <button type="button" disabled={busy || !upstream.trim()} onClick={() => onPreview(upstream.trim(), onto.trim() || null)}><Search size={11} />预览</button>
          <button type="button" disabled={busy || !previewMatches || preview?.dirty || preview?.commits.length === 0 || (interactive && Boolean(validationError))} onClick={() => setPendingStart(true)}>变基</button>
        </div>
      </div>
      {preview ? (
        <div className={styles.preview}>
          <dl><div><dt>当前提交</dt><dd><code>{preview.headObjectId.slice(0, 12)}</code></dd></div><div><dt>上游修订</dt><dd>{preview.upstream} <code>{preview.upstreamObjectId.slice(0, 12)}</code></dd></div><div><dt>目标修订</dt><dd>{preview.onto ?? preview.upstream} {preview.ontoObjectId ? <code>{preview.ontoObjectId.slice(0, 12)}</code> : null}</dd></div><div><dt>提交数</dt><dd>{preview.commits.length}</dd></div></dl>
          {preview.dirty ? <p className={styles.warning}>变基前请先提交或储藏本地改动。</p> : null}
          {interactive ? (
            <ol className={styles.todo} aria-label="交互式变基任务列表">{todo.map((item, index) => (
              <li key={item.objectId}>
                <select aria-label={`${item.subject} 的操作`} value={item.action} onChange={(event) => setTodo((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, action: event.target.value as GitRebaseAction, message: event.target.value === "reword" ? candidate.message ?? "" : null } : candidate))}><option value="pick">保留</option><option value="reword">修改说明</option><option value="squash">压缩合并</option><option value="fixup">合并并丢弃说明</option><option value="drop">丢弃</option></select>
                <code>{item.objectId.slice(0, 8)}</code><span>{item.subject}</span>
                {item.action === "reword" ? <input className={styles.reword} aria-label={`${item.subject} 的新提交说明`} value={item.message ?? ""} placeholder="新的提交说明" onChange={(event) => setTodo((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, message: event.target.value } : candidate))} /> : null}
                <button type="button" aria-label={`上移 ${item.subject}`} disabled={index === 0} onClick={() => setTodo((current) => moveTodo(current, index, index - 1))}><ArrowUp size={11} /></button>
                <button type="button" aria-label={`下移 ${item.subject}`} disabled={index === todo.length - 1} onClick={() => setTodo((current) => moveTodo(current, index, index + 1))}><ArrowDown size={11} /></button>
              </li>
            ))}</ol>
          ) : <ul className={styles.commits}>{preview.commits.map((item) => <li key={item.objectId}><code>{item.objectId.slice(0, 8)}</code><span>{item.subject}</span></li>)}</ul>}
          {interactive && validationError ? <p className={styles.warning} role="alert">{validationError}</p> : null}
        </div>
      ) : null}
      {pendingStart ? (
        <div className={styles.confirmation} role="alertdialog" aria-label="确认变基">
          <strong>重写 {preview?.commits.length ?? 0} 个本地提交吗？</strong>
          <span>当前提交标识将发生变化，可通过“恢复提交”找回原位置。</span>
          <button type="button" onClick={() => { setPendingStart(false); onRebase(upstream.trim(), onto.trim() || null, interactive, interactive ? todo : []); }}>确认变基</button>
          <button type="button" onClick={() => setPendingStart(false)}>取消</button>
        </div>
      ) : null}
      {pendingControl ? (
        <div className={styles.confirmation} role="alertdialog" aria-label="确认变基控制操作">
          <strong>{pendingControl === "abort" ? "中止并恢复原分支状态吗？" : "跳过当前变基提交吗？"}</strong>
          <span>{pendingControl === "abort" ? "本次变基进度和已经解决的改动都将被丢弃。" : "当前提交不会被重新应用。"}</span>
          <button type="button" onClick={() => { const action = pendingControl; setPendingControl(null); onControl(action); }}>{pendingControl === "abort" ? "确认中止" : "确认跳过"}</button>
          <button type="button" onClick={() => setPendingControl(null)}>取消</button>
        </div>
      ) : null}
    </section>
  );
}

export function validateRebaseTodo(todo: readonly GitRebaseTodoItem[]): string | null {
  if (todo.length === 0) return "交互式变基至少需要一个提交。";
  const seen = new Set<string>();
  let actionable = false;
  for (const item of todo) {
    if (seen.has(item.objectId)) return "同一个提交不能重复出现。";
    seen.add(item.objectId);
    if ((item.action === "squash" || item.action === "fixup") && !actionable) return "压缩合并前必须有一个未丢弃的提交。";
    if (item.action === "reword" && !item.message?.trim()) return "修改说明时必须填写新的提交说明。";
    if (item.action !== "drop") actionable = true;
  }
  return null;
}

function operationStateLabel(state: NonNullable<GitStatusSnapshot["operation"]>["state"]): string {
  return ({ running: "执行中", conflicted: "存在冲突", continuable: "可以继续" })[state];
}

function moveTodo(items: readonly GitRebaseTodoItem[], from: number, to: number): GitRebaseTodoItem[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
