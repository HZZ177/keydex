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
  if (loading) return <div className={styles.state}>Loading three-stage conflict data…</div>;
  if (!snapshot?.files.length) return null;
  return (
    <section className={styles.root} aria-label="Conflict details">
      <header><AlertTriangle size={13} /><strong>{snapshot.files.length} unresolved conflict path(s)</strong><span>Editable limit {formatBytes(snapshot.maxEditableBytes)}</span></header>
      <div className={styles.files} role="listbox" aria-label="Conflict files">{snapshot.files.map((file) => (
        <button type="button" role="option" aria-selected={selectedPath === file.path} key={file.path} onClick={() => onSelect(file)}>
          <FileWarning size={12} /><span>{file.path}</span><em>{file.kind}</em>
          <small>{file.stages.map((stage) => stage.label.toUpperCase()).join(" · ") || "no stages"}</small>
          <small>{file.editable ? file.allowedActions.join(" · ") : conflictLimitReason(file)}</small>
        </button>
      ))}</div>
      {snapshot.files.some((file) => file.kind === "rename") ? <p>Rename conflicts may span related paths; review all linked entries before resolving.</p> : null}
    </section>
  );
}

export function conflictLimitReason(file: GitConflictFile): string {
  if (file.kind === "submodule") return "Submodule: choose ours or theirs";
  if (file.kind === "binary" || file.resultBinary) return "Binary: direct editing unavailable";
  if (file.resultTooLarge || file.stages.some((stage) => stage.tooLarge)) return "Too large for the merge editor";
  if (file.stages.some((stage) => stage.encoding === "unsupported")) return "Unsupported text encoding";
  return "Direct editing unavailable";
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${Math.round(value / (1024 * 1024))} MiB` : `${Math.round(value / 1024)} KiB`;
}
