import { Binary, RotateCcw, Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitBisectSnapshot, GitObjectId } from "@/runtime/gitTypes";

import styles from "./GitBisectView.module.css";

export function GitBisectView({
  snapshot,
  loading,
  busy,
  revisions,
  onStart,
  onControl,
  onOpenHistory,
}: {
  snapshot: GitBisectSnapshot | null;
  loading: boolean;
  busy: boolean;
  revisions: readonly string[];
  onStart: (good: string, bad: string) => void;
  onControl: (action: "good" | "bad" | "skip" | "reset") => void;
  onOpenHistory: (objectId: GitObjectId) => void;
}) {
  const [good, setGood] = useState("");
  const [bad, setBad] = useState("HEAD");
  const [pendingStart, setPendingStart] = useState(false);
  useEffect(() => {
    if (!good && revisions.length) setGood(revisions.find((ref) => ref !== "HEAD") ?? revisions[0]);
  }, [good, revisions]);
  return (
    <section className={styles.root} aria-label="Git 二分定位助手">
      <header><Binary size={14} /><div><strong>二分定位助手</strong><span>请手动判断每个已签出的修订是否正常。Keydex 不会自动运行用户测试命令。</span></div></header>
      {loading ? <p>正在加载二分定位状态…</p> : snapshot?.active ? (
        <>
          <div className={styles.summary}>
            <span>当前修订 <code>{short(snapshot.currentRevision)}</code></span>
            <span>剩余 <strong>{snapshot.remainingCount}</strong></span>
            <span>正常 {snapshot.goodRevisions.length}</span>
            <span>已跳过 {snapshot.skippedRevisions.length}</span>
          </div>
          {snapshot.culpritRevision ? (
            <div className={styles.culprit}><Search size={14} /><span>首个异常提交 <code>{snapshot.culpritRevision}</code></span><button type="button" onClick={() => onOpenHistory(snapshot.culpritRevision!)}>在日志中打开</button></div>
          ) : (
            <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={() => onControl("good")}>标记为正常</button>
              <button type="button" disabled={busy} onClick={() => onControl("bad")}>标记为异常</button>
              <button type="button" disabled={busy} onClick={() => onControl("skip")}>跳过此修订</button>
            </div>
          )}
          <div className={styles.candidates}><strong>候选范围</strong><ol>{snapshot.candidateRevisions.slice(0, 12).map((revision) => <li key={revision} data-current={revision === snapshot.currentRevision ? "true" : "false"}><code>{revision}</code></li>)}</ol>{snapshot.remainingCount > 12 ? <span>另有 {snapshot.remainingCount - 12} 个</span> : null}</div>
          <button type="button" className={styles.reset} disabled={busy} onClick={() => onControl("reset")}><RotateCcw size={13} />结束二分定位</button>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); if (good.trim() && bad.trim()) setPendingStart(true); }}>
          <label>已知正常修订<input aria-label="已知正常修订" list="git-bisect-revisions" value={good} onChange={(event) => setGood(event.target.value)} /></label>
          <label>已知异常修订<input aria-label="已知异常修订" list="git-bisect-revisions" value={bad} onChange={(event) => setBad(event.target.value)} /></label>
          <datalist id="git-bisect-revisions">{revisions.map((revision) => <option key={revision} value={revision} />)}</datalist>
          <button type="submit" disabled={busy || !good.trim() || !bad.trim()}>开始二分定位</button>
          {pendingStart ? (
            <div className={styles.confirmation} role="alertdialog" aria-label="确认开始二分定位">
              <strong>从正常修订 {good.trim()} 到异常修订 {bad.trim()} 开始定位吗？</strong>
              <span>Git 会临时签出候选提交；结束二分定位后会恢复原分支。</span>
              <button type="button" onClick={() => { setPendingStart(false); onStart(good.trim(), bad.trim()); }}>确认开始</button>
              <button type="button" onClick={() => setPendingStart(false)}>取消</button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

function short(value: string | null): string {
  return value?.slice(0, 12) ?? "未知";
}
