import { Check, CircleAlert, LoaderCircle, MessageSquareText } from "lucide-react";
import type { DiffLineAnnotation } from "@pierre/diffs";

import type { KeydexDiffFile } from "./model";
import type { KeydexDiffSelectionSide } from "./selectionBridge";
import styles from "./DiffAnnotations.module.css";

export type KeydexDiffAnnotationKind = "hunk_action" | "diagnostic" | "comment_placeholder";
export type KeydexDiffAnnotationTone = "neutral" | "info" | "warning" | "error";

export interface KeydexDiffAnnotation {
  readonly id: string;
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly kind: KeydexDiffAnnotationKind;
  readonly side: KeydexDiffSelectionSide;
  readonly line: number;
  readonly message: string;
  readonly tone: KeydexDiffAnnotationTone;
  readonly actionId?: string;
  readonly actionLabel?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly actionState?: "idle" | "queued" | "running" | "success" | "error";
  readonly disabledReason?: string;
  readonly hunkId?: string;
}

export interface KeydexDiffAnnotationSlotProps {
  readonly annotation: KeydexDiffAnnotation;
  readonly onAction?: (annotation: KeydexDiffAnnotation) => void | Promise<void>;
}

export type KeydexDiffAnnotationUpdate =
  | { readonly type: "upsert"; readonly annotation: KeydexDiffAnnotation }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "clear" };

export function KeydexDiffAnnotationSlot({
  annotation,
  onAction,
}: KeydexDiffAnnotationSlotProps) {
  const actionBusy = annotation.busy || annotation.actionState === "queued" || annotation.actionState === "running";
  const actionLabel = annotation.actionState === "success"
    ? `${annotation.actionLabel}成功`
    : annotation.actionState === "error"
      ? `${annotation.actionLabel}失败`
      : actionBusy
        ? `${annotation.actionLabel}中`
        : annotation.actionLabel;
  return (
    <aside
      className={styles.annotation}
      data-keydex-diff-annotation={annotation.kind}
      data-tone={annotation.tone}
      data-annotation-id={annotation.id}
      role={annotation.tone === "error" ? "alert" : "note"}
    >
      <span className={styles.icon} aria-hidden="true">
        {annotation.kind === "comment_placeholder"
          ? <MessageSquareText size={14} />
          : <CircleAlert size={14} />}
      </span>
      <span className={styles.message}>{annotation.message}</span>
      {annotation.actionId && annotation.actionLabel ? (
        <button
          className={styles.action}
          type="button"
          disabled={annotation.disabled || actionBusy || !onAction}
          aria-label={actionLabel}
          aria-busy={actionBusy || undefined}
          data-action-state={annotation.actionState ?? "idle"}
          data-tooltip-label={annotation.disabled ? annotation.disabledReason ?? `${annotation.actionLabel}当前不可用` : actionLabel}
          onClick={() => void onAction?.(annotation)}
        >
          {actionBusy ? <LoaderCircle className={styles.spinner} size={14} aria-hidden="true" /> : null}
          {annotation.actionState === "success" ? <Check size={14} aria-hidden="true" /> : null}
          {annotation.actionState === "error" ? <CircleAlert size={14} aria-hidden="true" /> : null}
          <span>{annotation.actionLabel}</span>
        </button>
      ) : null}
    </aside>
  );
}

export function toPierreDiffAnnotations(
  file: KeydexDiffFile,
  annotations: readonly KeydexDiffAnnotation[],
): DiffLineAnnotation<KeydexDiffAnnotation>[] {
  return annotations
    .filter((annotation) => annotationMatchesFile(annotation, file))
    .filter((annotation) => annotation.line === 0 || annotationLineIsVisible(file, annotation))
    .map((annotation) => ({
      lineNumber: annotation.line,
      side: annotation.side === "old" ? "deletions" : "additions",
      metadata: annotation,
    }));
}

export function reduceKeydexDiffAnnotations(
  current: readonly KeydexDiffAnnotation[],
  update: KeydexDiffAnnotationUpdate,
): readonly KeydexDiffAnnotation[] {
  if (update.type === "clear") return Object.freeze([]);
  if (update.type === "remove") {
    return Object.freeze(current.filter((annotation) => annotation.id !== update.id));
  }
  validateAnnotation(update.annotation);
  const next = current.filter((annotation) => annotation.id !== update.annotation.id);
  next.push(Object.freeze({ ...update.annotation }));
  return Object.freeze(next);
}

export function keydexHunkActionAnnotation(
  file: KeydexDiffFile,
  hunkId: string,
  input: Omit<KeydexDiffAnnotation, "fileId" | "fileCacheKey" | "kind" | "side" | "line" | "hunkId">,
): KeydexDiffAnnotation {
  const hunk = file.hunks.find((candidate) => candidate.id === hunkId);
  if (!hunk) throw new Error(`未找到差异变更块：${hunkId}`);
  const side: KeydexDiffSelectionSide = hunk.newLines > 0 ? "new" : "old";
  const line = side === "new" ? hunk.newStart : hunk.oldStart;
  const annotation: KeydexDiffAnnotation = {
    ...input,
    fileId: file.id,
    fileCacheKey: file.cacheKey,
    kind: "hunk_action",
    side,
    line,
    hunkId,
  };
  validateAnnotation(annotation);
  return Object.freeze(annotation);
}

function annotationMatchesFile(annotation: KeydexDiffAnnotation, file: KeydexDiffFile): boolean {
  return annotation.fileId === file.id && annotation.fileCacheKey === file.cacheKey;
}

function annotationLineIsVisible(file: KeydexDiffFile, annotation: KeydexDiffAnnotation): boolean {
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const patchLine of hunk.lines) {
      if (patchLine.startsWith("\\ No newline")) continue;
      const sign = patchLine[0];
      if (annotation.side === "old" && sign !== "+" && oldLine === annotation.line) return true;
      if (annotation.side === "new" && sign !== "-" && newLine === annotation.line) return true;
      if (sign !== "+") oldLine += 1;
      if (sign !== "-") newLine += 1;
    }
  }
  return false;
}

function validateAnnotation(annotation: KeydexDiffAnnotation) {
  if (!annotation.id || !annotation.fileId || !annotation.fileCacheKey || !annotation.message.trim()) {
    throw new Error("差异标注缺少稳定标识或显示内容");
  }
  if (!Number.isInteger(annotation.line) || annotation.line < 0) {
    throw new Error("差异标注行号必须是非负整数");
  }
  if (annotation.kind === "hunk_action" && (!annotation.actionId || !annotation.actionLabel)) {
    throw new Error("变更块操作标注缺少动作标识或文案");
  }
}
