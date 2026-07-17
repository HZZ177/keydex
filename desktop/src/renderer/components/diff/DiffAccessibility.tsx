import type { ReactNode } from "react";

import type { KeydexDiffDocument, KeydexDiffFile, KeydexDiffStatus } from "./model";
import type { KeydexDiffProfileName } from "./profiles";
import type { KeydexDiffSelectionRange } from "./selectionBridge";
import { summarizeDiffStatistics } from "./statistics";
import styles from "./DiffAccessibility.module.css";
import { handleKeydexDiffKeyDown } from "./diffKeyboard";

export type KeydexDiffAccessibleLineKind = "context" | "added" | "removed";

export interface KeydexDiffAccessibilityBridgeProps {
  readonly profile: KeydexDiffProfileName;
  readonly document?: KeydexDiffDocument;
  readonly file?: KeydexDiffFile;
  readonly selection?: KeydexDiffSelectionRange | null;
  readonly busy?: boolean;
  readonly onClearSelection?: () => void;
  readonly children: ReactNode;
}

export function KeydexDiffAccessibilityBridge({
  profile,
  document,
  file,
  selection,
  busy = false,
  onClearSelection,
  children,
}: KeydexDiffAccessibilityBridgeProps) {
  const label = keydexDiffAccessibleName({ profile, document, file });
  const announcement = busy
    ? "正在更新差异内容"
    : selection
      ? keydexDiffSelectionAccessibleName(selection)
      : document
        ? keydexDiffDocumentSummary(document)
        : file
          ? keydexDiffFileAccessibleName(file)
          : "差异内容已就绪";
  return (
    <section
      className={styles.bridge}
      data-keydex-diff-accessibility="true"
      data-diff-profile={profile}
      role="region"
      aria-label={label}
      aria-busy={busy || undefined}
      onKeyDown={(event) => handleKeydexDiffKeyDown(event, { onClearSelection })}
    >
      {children}
      <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </section>
  );
}

export function keydexDiffAccessibleName({
  profile,
  document,
  file,
}: Pick<KeydexDiffAccessibilityBridgeProps, "profile" | "document" | "file">): string {
  const profileName = ({
    compact: "对话内差异",
    review: "文件审阅差异",
    git: "Git 差异",
    preview: "文件预览差异",
  } satisfies Record<KeydexDiffProfileName, string>)[profile];
  if (file) return `${profileName}：${keydexDiffFileAccessibleName(file)}`;
  if (document) return `${profileName}：${keydexDiffDocumentSummary(document)}`;
  return profileName;
}

export function keydexDiffDocumentSummary(document: KeydexDiffDocument): string {
  const summary = summarizeDiffStatistics(document.files);
  const statistics = summary.additions === null || summary.deletions === null
    ? "部分行数未知"
    : `新增 ${summary.additions} 行，删除 ${summary.deletions} 行`;
  return `共 ${document.files.length} 个文件，${statistics}`;
}

export function keydexDiffFileAccessibleName(
  file: Pick<KeydexDiffFile, "displayPath" | "status" | "additions" | "deletions">,
): string {
  const status = KEYDEX_DIFF_STATUS_NAMES[file.status];
  const statistics = file.additions === null || file.deletions === null
    ? "变更行数未知"
    : `新增 ${file.additions} 行，删除 ${file.deletions} 行`;
  return `${file.displayPath}，${status}，${statistics}`;
}

export function keydexDiffLineAccessibleName({
  kind,
  oldLine,
  newLine,
  content,
}: {
  readonly kind: KeydexDiffAccessibleLineKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly content: string;
}): string {
  const normalizedContent = content.replace(/^[+ -]/u, "").trim() || "空行";
  if (kind === "added") return `新增行 ${newLine ?? "未知"}：${normalizedContent}`;
  if (kind === "removed") return `删除行 ${oldLine ?? "未知"}：${normalizedContent}`;
  if (oldLine === newLine || newLine === null) {
    return `未更改行 ${oldLine ?? "未知"}：${normalizedContent}`;
  }
  return `未更改行，原第 ${oldLine ?? "未知"} 行，新第 ${newLine} 行：${normalizedContent}`;
}

export function keydexDiffSelectionAccessibleName(
  selection: KeydexDiffSelectionRange,
): string {
  const anchor = `${selectionSideLabel(selection.anchor.side)}第 ${selection.anchor.line} 行`;
  const focus = `${selectionSideLabel(selection.focus.side)}第 ${selection.focus.line} 行`;
  return anchor === focus ? `已选择${anchor}` : `已选择${anchor}到${focus}`;
}

const KEYDEX_DIFF_STATUS_NAMES: Readonly<Record<KeydexDiffStatus, string>> = Object.freeze({
  added: "新增文件",
  modified: "修改文件",
  deleted: "删除文件",
  renamed: "重命名文件",
  copied: "复制文件",
  type_changed: "文件类型变化",
  unknown: "文件发生变更",
});

function selectionSideLabel(side: "old" | "new"): string {
  return side === "old" ? "原文件" : "新文件";
}
