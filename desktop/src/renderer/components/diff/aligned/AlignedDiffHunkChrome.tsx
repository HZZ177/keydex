import { FoldVertical } from "lucide-react";

import type { PierreAlignedPreparedFile } from "../engine/pierreAlignedAdapter";
import type { DiffPaneRow, DiffPaneSide, KeydexAlignedDiffModel } from "./alignedDiffModel";
import { alignedHunkId } from "./buildAlignedDiffModel";
import { AlignedDiffRow } from "./AlignedDiffRow";
import styles from "./AlignedDiffHunkChrome.module.css";

export type AlignedDiffPaneItem =
  | { readonly type: "metadata"; readonly id: string; readonly lines: readonly string[] }
  | { readonly type: "hunk_header"; readonly id: string; readonly hunkId: string; readonly label: string }
  | {
      readonly type: "collapsed_gap";
      readonly id: string;
      readonly segmentId: string;
      readonly hiddenLineCount: number;
      readonly canExpand: boolean;
    }
  | { readonly type: "row"; readonly id: string; readonly row: DiffPaneRow }
  | { readonly type: "eof"; readonly id: string; readonly side: DiffPaneSide };

export function buildAlignedDiffPaneItems(
  model: KeydexAlignedDiffModel,
  prepared: PierreAlignedPreparedFile,
  side: DiffPaneSide,
): readonly AlignedDiffPaneItem[] {
  const items: AlignedDiffPaneItem[] = [];
  const metadata = alignedFileMetadata(prepared);
  if (metadata.length > 0) items.push(Object.freeze({ type: "metadata", id: "metadata", lines: metadata }));
  const rows = side === "old" ? model.leftRows : model.rightRows;
  let currentHunkId: string | null = null;
  for (const segment of model.segments) {
    if (segment.kind === "collapsed_gap") {
      const range = side === "old" ? segment.left : segment.right;
      const hiddenLineCount = range.startLine !== null && range.endLine !== null
        ? range.endLine - range.startLine + 1
        : 0;
      items.push(Object.freeze({
        type: "collapsed_gap",
        id: `${side}:${segment.id}:gap`,
        segmentId: segment.id,
        hiddenLineCount,
        canExpand: !prepared.partial && hiddenLineCount > 0,
      }));
      continue;
    }
    if (segment.hunkId && segment.hunkId !== currentHunkId) {
      currentHunkId = segment.hunkId;
      const hunk = prepared.hunks.find(
        (candidate) => alignedHunkId(prepared.fileCacheKey, candidate) === currentHunkId,
      );
      items.push(Object.freeze({
        type: "hunk_header",
        id: `${side}:${currentHunkId}:header`,
        hunkId: currentHunkId,
        label: alignedHunkLabel(hunk?.specs ?? null, hunk?.context ?? null),
      }));
    }
    const range = side === "old" ? segment.left : segment.right;
    for (let index = range.startRow; index < range.endRow; index += 1) {
      const row = rows[index];
      if (!row) continue;
      items.push(Object.freeze({ type: "row", id: row.id, row }));
      if (row.noTrailingNewline) {
        items.push(Object.freeze({ type: "eof", id: `${row.id}:eof`, side }));
      }
    }
  }
  return Object.freeze(items);
}

export function AlignedDiffPaneItemView({
  item,
  wrap,
  lineNumberDigits,
  onExpandGap,
}: {
  readonly item: AlignedDiffPaneItem;
  readonly wrap: boolean;
  readonly lineNumberDigits?: number;
  readonly onExpandGap?: (segmentId: string) => void;
}) {
  if (item.type === "row") {
    return <AlignedDiffRow row={item.row} wrap={wrap} lineNumberDigits={lineNumberDigits} />;
  }
  if (item.type === "metadata") {
    return (
      <div className={styles.metadata} data-keydex-aligned-metadata="">
        {item.lines.map((line) => <span key={line}>{line}</span>)}
      </div>
    );
  }
  if (item.type === "hunk_header") {
    return <div className={styles.hunkHeader} data-keydex-aligned-hunk={item.hunkId}>{item.label}</div>;
  }
  if (item.type === "eof") {
    return <div className={styles.eof} data-keydex-aligned-eof={item.side}>文件末尾没有换行符</div>;
  }
  const label = `已折叠 ${item.hiddenLineCount} 行未修改内容`;
  const content = (
    <span className={styles.gapContent}>
      <FoldVertical className={styles.gapIcon} size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
  return (
    <div className={styles.gap} data-keydex-aligned-gap={item.segmentId}>
      {item.canExpand && onExpandGap ? (
        <button type="button" onClick={() => onExpandGap(item.segmentId)} aria-label={`展开${item.hiddenLineCount}行上下文`}>
          {content}
        </button>
      ) : content}
    </div>
  );
}

export function alignedHunkLabel(specs: string | null, context: string | null): string {
  const range = specs?.trim() || "差异区块";
  return context ? `${range} · ${context}` : range;
}

export function alignedFileMetadata(prepared: PierreAlignedPreparedFile): readonly string[] {
  const lines: string[] = [];
  if (prepared.previousName && prepared.previousName !== prepared.name) {
    lines.push(`重命名：${prepared.previousName} → ${prepared.name}`);
  }
  if (prepared.oldMode && prepared.newMode && prepared.oldMode !== prepared.newMode) {
    lines.push(`文件模式：${prepared.oldMode} → ${prepared.newMode}`);
  }
  return Object.freeze(lines);
}
