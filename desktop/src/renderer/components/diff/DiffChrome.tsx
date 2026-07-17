import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import type { KeydexDiffFile, KeydexDiffStatus } from "./model";
import styles from "./DiffChrome.module.css";
import { keydexDiffFileAccessibleName } from "./DiffAccessibility";

export interface KeydexDiffFileHeaderPresentation {
  readonly fileName: string;
  readonly directoryPath: string;
  readonly fullPath: string;
  readonly status: KeydexDiffStatus;
  readonly statusLabel: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly metadata: readonly string[];
}

export interface KeydexDiffFileHeaderChromeProps {
  readonly presentation: KeydexDiffFileHeaderPresentation;
  readonly icon?: ReactNode;
  readonly statusIcon?: ReactNode;
  readonly actions?: ReactNode;
  readonly selected?: boolean;
  readonly density?: "default" | "compact";
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
}

/**
 * Presentation-only file header. Domain actions and material icons are composed by
 * the surface-specific file header so every Diff consumer shares one visual contract.
 */
export function KeydexDiffFileHeaderChrome({
  presentation,
  icon,
  statusIcon,
  actions,
  selected = false,
  density = "default",
  expanded,
  onToggle,
}: KeydexDiffFileHeaderChromeProps) {
  const compact = density === "compact";
  const interactive = Boolean(onToggle);
  return (
    <header
      className={styles.fileHeader}
      data-keydex-diff-file-header="true"
      data-density={density}
      data-selected={selected ? "true" : "false"}
      data-status={presentation.status}
      title={presentation.fullPath}
      role={interactive ? "button" : "group"}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? expanded : undefined}
      aria-label={interactive
        ? `${fileHeaderAccessibleName(presentation)}，${expanded ? "收起文件差异" : "展开文件差异"}`
        : fileHeaderAccessibleName(presentation)}
      onClick={interactive ? (event) => {
        if ((event.target as HTMLElement).closest("button, a")) return;
        onToggle?.();
      } : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onToggle?.();
      } : undefined}
    >
      <span className={styles.identity}>
        {icon ? <span className={styles.fileIcon} aria-hidden="true">{icon}</span> : null}
        <span className={styles.fileName}>{presentation.fileName}</span>
        {compact ? (
          <KeydexDiffLineStats additions={presentation.additions} deletions={presentation.deletions} />
        ) : null}
        {presentation.directoryPath ? (
          <span className={styles.directoryPath}>{presentation.directoryPath}</span>
        ) : null}
      </span>
      {!compact ? (
        <span className={styles.secondary}>
          {statusIcon ? <span className={styles.statusIcon} data-status={presentation.status} aria-hidden="true">{statusIcon}</span> : null}
          <span className={styles.status} data-status={presentation.status}>
            {presentation.statusLabel}
          </span>
          {presentation.metadata.map((item) => (
            <span className={styles.metadata} key={item}>{item}</span>
          ))}
          <KeydexDiffLineStats additions={presentation.additions} deletions={presentation.deletions} />
        </span>
      ) : null}
      {actions ? <span className={styles.actions}>{actions}</span> : null}
    </header>
  );
}

export interface KeydexDiffHunkSeparatorProps {
  readonly label: string;
  readonly hiddenLineCount?: number;
  readonly expanded?: boolean;
  readonly disabled?: boolean;
  readonly onToggle?: () => void;
  readonly actions?: ReactNode;
}

export function KeydexDiffHunkSeparator({
  label,
  hiddenLineCount = 0,
  expanded = false,
  disabled = false,
  onToggle,
  actions,
}: KeydexDiffHunkSeparatorProps) {
  const expandable = hiddenLineCount > 0 && Boolean(onToggle);
  const contextLabel = hiddenLineCount > 0
    ? expanded
      ? `收起 ${hiddenLineCount} 行上下文`
      : `展开 ${hiddenLineCount} 行未更改内容`
    : "没有可展开的上下文";

  return (
    <div
      className={styles.hunkSeparator}
      data-keydex-diff-hunk="true"
      data-expanded={expanded ? "true" : "false"}
      data-expandable={expandable ? "true" : "false"}
      role="group"
      aria-label={`变更块 ${label}`}
    >
      <code className={styles.hunkLabel}>{label}</code>
      {expandable ? (
        <button
          className={styles.contextButton}
          type="button"
          aria-expanded={expanded}
          aria-label={contextLabel}
          data-tooltip-label={contextLabel}
          disabled={disabled}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{contextLabel}</span>
        </button>
      ) : hiddenLineCount > 0 ? (
        <span className={styles.contextHint}>{hiddenLineCount} 行未更改内容</span>
      ) : null}
      {actions ? <span className={styles.hunkActions}>{actions}</span> : null}
    </div>
  );
}

export function keydexDiffFileHeaderPresentation(
  file: KeydexDiffFile,
): KeydexDiffFileHeaderPresentation {
  const { fileName, directoryPath } = splitDisplayPath(file.displayPath);
  const metadata: string[] = [];
  if (file.status === "renamed" && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    metadata.push(`${file.oldPath} → ${file.newPath}`);
  }
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    metadata.push(`模式 ${file.oldMode} → ${file.newMode}`);
  }
  if (file.binary) metadata.push("二进制");
  if (file.truncated) metadata.push("内容已截断");

  return Object.freeze({
    fileName,
    directoryPath,
    fullPath: file.displayPath,
    status: file.status,
    statusLabel: KEYDEX_DIFF_STATUS_LABELS[file.status],
    additions: file.additions,
    deletions: file.deletions,
    metadata: Object.freeze(metadata),
  });
}

export function splitDisplayPath(path: string): { fileName: string; directoryPath: string } {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { fileName: normalized, directoryPath: "" }
    : { fileName: normalized.slice(separator + 1), directoryPath: normalized.slice(0, separator) };
}

function KeydexDiffLineStats({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) return null;
  return (
    <span
      className={styles.lineStats}
      aria-label={`新增 ${additions ?? 0} 行，删除 ${deletions ?? 0} 行`}
    >
      <span data-kind="added" aria-hidden="true">+{additions ?? 0}</span>
      <span data-kind="removed" aria-hidden="true">-{deletions ?? 0}</span>
    </span>
  );
}

function fileHeaderAccessibleName(
  presentation: KeydexDiffFileHeaderPresentation,
): string {
  return keydexDiffFileAccessibleName({
    displayPath: presentation.fullPath,
    status: presentation.status,
    additions: presentation.additions,
    deletions: presentation.deletions,
  });
}

const KEYDEX_DIFF_STATUS_LABELS: Readonly<Record<KeydexDiffStatus, string>> = Object.freeze({
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  type_changed: "类型变化",
  unknown: "变更",
});
