import type { SelectedLineRange } from "@pierre/diffs/react";

import type { KeydexDiffFile } from "./model";

export type KeydexDiffSelectionSide = "old" | "new";

export interface KeydexDiffSelectionPoint {
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly side: KeydexDiffSelectionSide;
  readonly line: number;
}

export interface KeydexDiffSelectionRange {
  readonly anchor: KeydexDiffSelectionPoint;
  readonly focus: KeydexDiffSelectionPoint;
}

export type KeydexDiffSelectionAction =
  | { readonly type: "select"; readonly point: KeydexDiffSelectionPoint; readonly shift?: boolean }
  | { readonly type: "replace"; readonly selection: KeydexDiffSelectionRange | null }
  | { readonly type: "clear" }
  | { readonly type: "file_changed"; readonly file: KeydexDiffFile };

export function fromPierreSelectedLineRange(
  file: KeydexDiffFile,
  range: SelectedLineRange | null,
): KeydexDiffSelectionRange | null {
  if (!range || !file.selectableForPatch) return null;
  const anchor = point(file, range.side === "deletions" ? "old" : "new", range.start);
  const focus = point(
    file,
    (range.endSide ?? range.side) === "deletions" ? "old" : "new",
    range.end,
  );
  return keydexDiffSelectionPointIsVisible(file, anchor) && keydexDiffSelectionPointIsVisible(file, focus)
    ? Object.freeze({ anchor, focus })
    : null;
}

export function toPierreSelectedLineRange(
  file: KeydexDiffFile,
  selection: KeydexDiffSelectionRange | null | undefined,
): SelectedLineRange | null {
  if (!selection || !file.selectableForPatch || !keydexDiffSelectionMatchesFile(selection, file)) {
    return null;
  }
  return {
    start: selection.anchor.line,
    end: selection.focus.line,
    side: selection.anchor.side === "old" ? "deletions" : "additions",
    endSide: selection.focus.side === "old" ? "deletions" : "additions",
  };
}

export function reduceKeydexDiffSelection(
  current: KeydexDiffSelectionRange | null,
  action: KeydexDiffSelectionAction,
): KeydexDiffSelectionRange | null {
  if (action.type === "clear") return null;
  if (action.type === "replace") return action.selection ? freezeSelection(action.selection) : null;
  if (action.type === "file_changed") {
    return current && keydexDiffSelectionMatchesFile(current, action.file) ? current : null;
  }

  const nextPoint = freezePoint(action.point);
  if (!action.shift || !current || !sameFilePoint(current.anchor, nextPoint)) {
    return current && samePoint(current.anchor, nextPoint) && samePoint(current.focus, nextPoint)
      ? null
      : Object.freeze({ anchor: nextPoint, focus: nextPoint });
  }
  return Object.freeze({ anchor: current.anchor, focus: nextPoint });
}

export function keydexDiffSelectionMatchesFile(
  selection: KeydexDiffSelectionRange,
  file: KeydexDiffFile,
): boolean {
  return sameFilePoint(selection.anchor, selection.focus)
    && selection.anchor.fileId === file.id
    && selection.anchor.fileCacheKey === file.cacheKey;
}

export function keydexDiffSelectionPointIsVisible(
  file: KeydexDiffFile,
  selectionPoint: KeydexDiffSelectionPoint,
): boolean {
  if (selectionPoint.fileId !== file.id || selectionPoint.fileCacheKey !== file.cacheKey) return false;
  return keydexDiffSelectablePoints(file).some((candidate) => samePoint(candidate, selectionPoint));
}

export function keydexDiffSelectablePoints(file: KeydexDiffFile): readonly KeydexDiffSelectionPoint[] {
  const points: KeydexDiffSelectionPoint[] = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\ No newline")) continue;
      const sign = line[0];
      if (sign !== "+") points.push(point(file, "old", oldLine));
      if (sign !== "-") points.push(point(file, "new", newLine));
      if (sign !== "+") oldLine += 1;
      if (sign !== "-") newLine += 1;
    }
  }
  return Object.freeze(points);
}

/**
 * Resolves a Pierre line selection back to canonical source text.
 *
 * The text deliberately comes from the normalized hunk model instead of the
 * syntax-highlighted DOM. This keeps copy semantics stable across themes,
 * Shadow DOM implementations and renderer upgrades.
 */
export function keydexDiffSelectionText(
  file: KeydexDiffFile,
  selection: KeydexDiffSelectionRange | null | undefined,
): string {
  if (!selection || !keydexDiffSelectionMatchesFile(selection, file)) return "";
  const lines = selectableVisualLines(file);
  const anchor = lines.findIndex((line) => visualLineMatchesPoint(line, selection.anchor));
  const focus = lines.findIndex((line) => visualLineMatchesPoint(line, selection.focus));
  if (anchor < 0 || focus < 0) return "";
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  return lines.slice(start, end + 1).map((line) => line.value.slice(1)).join("\n");
}

interface SelectableVisualLine {
  readonly value: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

function selectableVisualLines(file: KeydexDiffFile): SelectableVisualLine[] {
  const lines: SelectableVisualLine[] = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const value of hunk.lines) {
      if (value.startsWith("\\ No newline")) continue;
      const sign = value[0] ?? " ";
      lines.push({
        value: sign === "+" || sign === "-" || sign === " " ? value : ` ${value}`,
        oldLine: sign === "+" ? null : oldLine,
        newLine: sign === "-" ? null : newLine,
      });
      if (sign !== "+") oldLine += 1;
      if (sign !== "-") newLine += 1;
    }
  }
  return lines;
}

function visualLineMatchesPoint(
  line: SelectableVisualLine,
  point: KeydexDiffSelectionPoint,
): boolean {
  return point.side === "old" ? line.oldLine === point.line : line.newLine === point.line;
}

function point(
  file: KeydexDiffFile,
  side: KeydexDiffSelectionSide,
  line: number,
): KeydexDiffSelectionPoint {
  return freezePoint({ fileId: file.id, fileCacheKey: file.cacheKey, side, line });
}

function freezeSelection(selection: KeydexDiffSelectionRange): KeydexDiffSelectionRange {
  if (!sameFilePoint(selection.anchor, selection.focus)) {
    throw new Error("差异选区不能跨越不同文件或文件版本");
  }
  return Object.freeze({ anchor: freezePoint(selection.anchor), focus: freezePoint(selection.focus) });
}

function freezePoint(selectionPoint: KeydexDiffSelectionPoint): KeydexDiffSelectionPoint {
  if (!selectionPoint.fileId || !selectionPoint.fileCacheKey) {
    throw new Error("差异选区缺少稳定文件坐标");
  }
  if (!Number.isInteger(selectionPoint.line) || selectionPoint.line < 0) {
    throw new Error("差异选区行号必须是非负整数");
  }
  return Object.freeze({ ...selectionPoint });
}

function sameFilePoint(left: KeydexDiffSelectionPoint, right: KeydexDiffSelectionPoint): boolean {
  return left.fileId === right.fileId && left.fileCacheKey === right.fileCacheKey;
}

function samePoint(left: KeydexDiffSelectionPoint, right: KeydexDiffSelectionPoint): boolean {
  return sameFilePoint(left, right) && left.side === right.side && left.line === right.line;
}
