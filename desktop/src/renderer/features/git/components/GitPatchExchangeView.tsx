import { ClipboardCheck, Download, FileUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitCommandResult } from "@/runtime/gitTypes";
import type { GitPatchExport, GitPatchExportMode } from "@/runtime/git";

import { parseCherryPickCommits } from "./GitCherryPickView";
import styles from "./GitPatchExchangeView.module.css";

export interface GitPatchImportOptions {
  cached: boolean;
  reverse: boolean;
  reject: boolean;
}

export function GitPatchExchangeView({
  exported,
  busy,
  dryRunSignature,
  outcome,
  rejectFiles,
  onExport,
  onCheck,
  onApply,
}: {
  exported: GitPatchExport | null;
  busy: boolean;
  dryRunSignature: string | null;
  outcome: GitCommandResult | null;
  rejectFiles: readonly string[];
  onExport: (mode: GitPatchExportMode, left: string | null, right: string | null, paths: readonly string[]) => void;
  onCheck: (patch: string, options: GitPatchImportOptions) => void;
  onApply: (patch: string, options: GitPatchImportOptions) => void;
}) {
  const [mode, setMode] = useState<GitPatchExportMode>("working_tree");
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [pathsInput, setPathsInput] = useState("");
  const [patch, setPatch] = useState("");
  const [cached, setCached] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [reject, setReject] = useState(false);
  const paths = useMemo(() => parseCherryPickCommits(pathsInput), [pathsInput]);
  const options = { cached, reverse, reject };
  const signature = patchImportSignature(patch, options);
  const exportInvalid = (mode === "commit" && !left.trim()) || (mode === "range" && (!left.trim() || !right.trim()));
  return (
    <section className={styles.root} aria-label="补丁导入与导出">
      <header><Download size={14} /><div><strong>导出补丁</strong><span>可以导出工作树、暂存区、单个提交或修订范围；填写路径可限定补丁范围。</span></div></header>
      <div className={styles.grid}>
        <label><span>来源</span><select aria-label="补丁导出方式" value={mode} onChange={(event) => setMode(event.target.value as GitPatchExportMode)}><option value="working_tree">工作树</option><option value="index">暂存区</option><option value="commit">单个提交</option><option value="range">修订范围</option></select></label>
        {mode === "commit" || mode === "range" ? <label><span>{mode === "commit" ? "提交" : "左侧修订"}</span><input aria-label="补丁左侧修订" value={left} onChange={(event) => setLeft(event.target.value)} /></label> : null}
        {mode === "range" ? <label><span>右侧修订</span><input aria-label="补丁右侧修订" value={right} onChange={(event) => setRight(event.target.value)} /></label> : null}
        <label className={styles.wide}><span>限定路径（可选，每行一个）</span><textarea aria-label="补丁导出路径" rows={2} value={pathsInput} onChange={(event) => setPathsInput(event.target.value)} /></label>
        <button type="button" disabled={busy || exportInvalid} onClick={() => onExport(mode, left.trim() || null, right.trim() || null, paths)}>生成补丁</button>
      </div>
      {exported ? <div className={styles.exportResult}><strong>{exported.filename}</strong><span>{exported.patch.length} 个字符</span><button type="button" disabled={!exported.patch} onClick={() => downloadPatch(exported)}>保存补丁</button><textarea aria-label="已导出的补丁" readOnly rows={5} value={exported.patch} /></div> : null}

      <header className={styles.importHeader}><FileUp size={14} /><div><strong>导入补丁</strong><span>补丁内容和选项必须先通过试运行，之后才能正式应用。</span></div></header>
      <textarea className={styles.patchInput} aria-label="补丁内容" rows={8} value={patch} onChange={(event) => setPatch(event.target.value)} placeholder="请粘贴补丁内容" />
      <div className={styles.options}>
        <label><input type="checkbox" checked={cached} onChange={(event) => { setCached(event.target.checked); if (event.target.checked) setReject(false); }} />应用到暂存区</label>
        <label><input type="checkbox" checked={reverse} onChange={(event) => setReverse(event.target.checked)} />反向应用补丁</label>
        <label><input type="checkbox" checked={reject} disabled={cached} onChange={(event) => setReject(event.target.checked)} />保留未应用的变更块文件（.rej）</label>
      </div>
      <div className={styles.actions}><button type="button" disabled={busy || !patch.trim()} onClick={() => onCheck(patch, options)}><ClipboardCheck size={11} />试运行</button><button type="button" disabled={busy || !patch.trim() || dryRunSignature !== signature} onClick={() => onApply(patch, options)}>应用补丁</button></div>
      {dryRunSignature === signature ? <p className={styles.ready}>当前补丁内容和选项已通过试运行。</p> : null}
      {outcome ? <p className={styles.outcome} data-state={outcome.state}>{commandStateLabel(outcome.state)}</p> : null}
      {rejectFiles.length ? <div className={styles.rejects} role="alert"><strong>补丁仅部分应用，请检查以下未应用文件：</strong><ul>{rejectFiles.map((path) => <li key={path}>{path}</li>)}</ul></div> : null}
    </section>
  );
}

function commandStateLabel(state: GitCommandResult["state"]): string {
  return ({ queued: "操作已进入队列", running: "操作正在执行", succeeded: "操作成功完成", failed: "操作执行失败", cancelled: "操作已取消" } as Record<GitCommandResult["state"], string>)[state];
}

export function patchImportSignature(patch: string, options: GitPatchImportOptions): string {
  let hash = 2166136261;
  const value = `${options.cached ? 1 : 0}:${options.reverse ? 1 : 0}:${options.reject ? 1 : 0}:${patch}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function downloadPatch(exported: GitPatchExport): void {
  const url = URL.createObjectURL(new Blob([exported.patch], { type: "text/x-diff;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
