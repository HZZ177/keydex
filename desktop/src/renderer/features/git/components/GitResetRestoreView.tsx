import { FileClock, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitResetMode, GitResetPreview, GitStatusSnapshot } from "@/runtime/gitTypes";

import { parseCherryPickCommits } from "./GitCherryPickView";
import { GitConfirmActionDialog } from "../dialogs";
import styles from "./GitResetRestoreView.module.css";

export function GitResetRestoreView({
  status,
  preview,
  initialResetTarget,
  busy,
  onPreview,
  onReset,
  onRestore,
}: {
  status: GitStatusSnapshot | null;
  preview: GitResetPreview | null;
  initialResetTarget: string;
  busy: boolean;
  onPreview: (target: string, mode: GitResetMode) => void;
  onReset: (target: string, mode: GitResetMode) => void;
  onRestore: (paths: readonly string[], source: string | null, staged: boolean, worktree: boolean) => void;
}) {
  const [target, setTarget] = useState(initialResetTarget);
  const [mode, setMode] = useState<GitResetMode>("mixed");
  const [pathsInput, setPathsInput] = useState("");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState<"worktree" | "index" | "both">("worktree");
  const [pendingReset, setPendingReset] = useState(false);
  const [pendingRestore, setPendingRestore] = useState(false);
  useEffect(() => {
    if (initialResetTarget) setTarget(initialResetTarget);
  }, [initialResetTarget]);
  useEffect(() => {
    setPendingReset(false);
    setPendingRestore(false);
  }, [status?.repositoryId, status?.repositoryVersion]);
  const paths = useMemo(() => parseCherryPickCommits(pathsInput), [pathsInput]);
  const previewMatches = preview?.target === target.trim() && preview.mode === mode;
  const risk = resetRisk(mode, previewMatches ? preview.untrackedOverwrites : []);
  return (
    <section className={styles.root} aria-label="重置与还原">
      <header><RotateCcw size={14} /><div><strong>重置分支</strong><span>移动当前分支位置。继续前请检查准确引用及受影响文件。</span></div></header>
      <div className={styles.form}>
        <label><span>目标修订</span><input aria-label="重置目标" value={target} placeholder="例如：HEAD~1" onChange={(event) => setTarget(event.target.value)} /></label>
        <label><span>模式</span><select aria-label="重置模式" value={mode} onChange={(event) => setMode(event.target.value as GitResetMode)}><option value="soft">软重置——保留暂存区和工作树</option><option value="mixed">混合重置——重置暂存区并保留工作树</option><option value="hard">硬重置——重置暂存区和工作树</option></select></label>
        <div className={styles.buttons}><button type="button" disabled={busy || !target.trim()} onClick={() => onPreview(target.trim(), mode)}>预览重置</button><button type="button" className={styles.danger} disabled={busy || !previewMatches} onClick={() => setPendingReset(true)}>重置到目标</button></div>
      </div>
      {previewMatches && preview ? (
        <div className={styles.preview} data-risk={risk}>
          <dl><div><dt>当前提交</dt><dd><code>{preview.headObjectId?.slice(0, 12) ?? "尚无提交"}</code></dd></div><div><dt>目标</dt><dd><code>{preview.targetObjectId.slice(0, 12)}</code></dd></div><div><dt>文件</dt><dd>{preview.files.length}</dd></div><div><dt>风险</dt><dd>{riskLabel(risk)}</dd></div></dl>
          {preview.files.length ? <ul aria-label="重置影响的文件">{preview.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul> : <p>当前提交与目标之间没有文件树差异。</p>}
          {preview.untrackedOverwrites.length ? <div className={styles.warning} role="alert"><strong>未跟踪数据将被覆盖</strong><span>{preview.untrackedOverwrites.join("、")}</span></div> : null}
          <p className={styles.recovery}><FileClock size={11} />可通过“恢复提交”找回重置前的分支位置。</p>
        </div>
      ) : null}
      <header className={styles.restoreHeader}><FileClock size={14} /><div><strong>还原路径</strong><span>还原所选路径，但不移动当前分支位置。</span></div></header>
      <div className={styles.form}>
        <label><span>路径（每行一个）</span><textarea aria-label="要还原的路径" rows={3} value={pathsInput} onChange={(event) => setPathsInput(event.target.value)} /></label>
        <div className={styles.suggestions}>{status?.files.slice(0, 12).map((file) => <button type="button" key={file.path} onClick={() => setPathsInput((current) => `${current}${current.trim() ? "\n" : ""}${file.path}`)}>{file.path}</button>)}</div>
        <label><span>来源修订（留空时工作树使用暂存区）</span><input aria-label="还原来源" value={source} placeholder={destination === "worktree" ? "暂存区" : "当前提交"} onChange={(event) => setSource(event.target.value)} /></label>
        <label><span>目标位置</span><select aria-label="还原目标位置" value={destination} onChange={(event) => setDestination(event.target.value as typeof destination)}><option value="worktree">工作树</option><option value="index">暂存区</option><option value="both">暂存区和工作树</option></select></label>
        {destination !== "index" ? <p className={styles.warning}>还原工作树会丢弃所选路径中的本地内容，需要再次确认。</p> : null}
        <button type="button" className={destination === "index" ? undefined : styles.danger} disabled={busy || paths.length === 0} onClick={() => destination === "index" ? onRestore(paths, source.trim() || null, true, false) : setPendingRestore(true)}>还原所选路径</button>
      </div>
      {pendingReset && previewMatches && preview ? (
        <GitConfirmActionDialog
          title="确认重置分支"
          description="重置会移动当前分支位置。请核对预览和恢复位置后再继续。"
          target={`${preview.headObjectId?.slice(0, 12) ?? "尚无提交"} → ${preview.targetObjectId.slice(0, 12)}`}
          details={[
            `模式：${resetModeLabel(mode)}`,
            `影响文件：${preview.files.length} 个`,
            ...(preview.untrackedOverwrites.length ? [`将覆盖未跟踪路径：${preview.untrackedOverwrites.join("、")}`] : []),
            `恢复位置：${preview.reflogRecovery || "HEAD@{1}"}`,
          ]}
          confirmLabel="确认重置"
          busy={busy}
          onCancel={() => setPendingReset(false)}
          onConfirm={() => { setPendingReset(false); onReset(target.trim(), mode); }}
        />
      ) : null}
      {pendingRestore ? (
        <GitConfirmActionDialog
          title="确认还原路径"
          description={`将丢弃 ${paths.length} 个所选路径在${destination === "both" ? "暂存区和工作树" : "工作树"}中的内容。`}
          target={paths.join("、")}
          details={[`来源：${source.trim() || "暂存区"}`, `目标：${destinationLabel(destination)}`]}
          confirmLabel="确认还原"
          busy={busy}
          onCancel={() => setPendingRestore(false)}
          onConfirm={() => { setPendingRestore(false); onRestore(paths, source.trim() || null, destination !== "worktree", true); }}
        />
      ) : null}
    </section>
  );
}

function riskLabel(risk: ReturnType<typeof resetRisk>): string {
  return ({ "history-rewrite": "重写历史", destructive: "破坏性操作", "untracked-loss": "可能丢失未跟踪数据" })[risk];
}

function destinationLabel(destination: "worktree" | "index" | "both"): string {
  return ({ worktree: "工作树", index: "暂存区", both: "暂存区和工作树" })[destination];
}

function resetModeLabel(mode: GitResetMode): string {
  return ({ soft: "软重置", mixed: "混合重置", hard: "硬重置" })[mode];
}

export function resetRisk(mode: GitResetMode, untrackedOverwrites: readonly string[]): "history-rewrite" | "destructive" | "untracked-loss" {
  if (mode !== "hard") return "history-rewrite";
  return untrackedOverwrites.length ? "untracked-loss" : "destructive";
}
