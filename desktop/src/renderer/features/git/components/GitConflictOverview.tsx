import { AlertTriangle, FileWarning } from "lucide-react";

import type { GitConflictFile, GitConflictsSnapshot } from "@/runtime/gitTypes";

import styles from "./GitConflictOverview.module.css";

export function GitConflictOverview({
  snapshot,
  loading,
  selectedPath,
  onSelect,
}: {
  snapshot: GitConflictsSnapshot | null;
  loading: boolean;
  selectedPath: string | null;
  onSelect: (file: GitConflictFile) => void;
}) {
  if (loading) return <div className={styles.state}>正在读取三阶段冲突数据…</div>;
  if (!snapshot?.files.length) return null;
  return (
    <section className={styles.root} aria-label="冲突详情">
      <header><AlertTriangle size={13} /><strong>{snapshot.files.length} 个未解决的冲突路径</strong><span>可编辑上限 {formatBytes(snapshot.maxEditableBytes)}</span></header>
      <div className={styles.files} role="listbox" aria-label="冲突文件">{snapshot.files.map((file) => (
        <button type="button" role="option" aria-selected={selectedPath === file.path} key={file.path} onClick={() => onSelect(file)}>
          <FileWarning size={12} /><span>{file.path}</span><em>{conflictKindLabel(file.kind)}</em>
          <small>{file.stages.map((stage) => conflictStageLabel(stage.label)).join(" · ") || "无阶段数据"}</small>
          <small>{file.editable ? file.allowedActions.map(conflictActionLabel).join(" · ") : conflictLimitReason(file)}</small>
        </button>
      ))}</div>
      {snapshot.files.some((file) => file.kind === "rename") ? <p>重命名冲突可能涉及多个关联路径；解决前请检查全部关联项。</p> : null}
    </section>
  );
}

export function conflictLimitReason(file: GitConflictFile): string {
  if (file.kind === "submodule") return "子模块：请选择当前分支版本或传入版本";
  if (file.kind === "binary" || file.resultBinary) return "二进制文件：无法直接编辑";
  if (file.resultTooLarge || file.stages.some((stage) => stage.tooLarge)) return "文件过大，无法使用合并编辑器";
  if (file.stages.some((stage) => stage.encoding === "unsupported")) return "不支持的文本编码";
  return "无法直接编辑";
}

function conflictKindLabel(kind: GitConflictFile["kind"]): string {
  return ({ text: "文本", binary: "二进制", submodule: "子模块", rename: "重命名", delete_modify: "删除与修改" } as Partial<Record<GitConflictFile["kind"], string>>)[kind] ?? "冲突";
}

function conflictStageLabel(label: GitConflictFile["stages"][number]["label"]): string {
  return ({ base: "共同基础", ours: "当前分支", theirs: "传入版本" } as Record<GitConflictFile["stages"][number]["label"], string>)[label];
}

function conflictActionLabel(action: GitConflictFile["allowedActions"][number]): string {
  return ({ accept_ours: "采用当前分支版本", accept_theirs: "采用传入版本", keep_modified: "保留修改", accept_delete: "接受删除", delete: "删除路径", mark_resolved: "标记为已解决" } as Partial<Record<GitConflictFile["allowedActions"][number], string>>)[action] ?? "解决冲突";
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${Math.round(value / (1024 * 1024))} MiB` : `${Math.round(value / 1024)} KiB`;
}
