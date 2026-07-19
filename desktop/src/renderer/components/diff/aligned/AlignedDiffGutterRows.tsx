import type { CSSProperties } from "react";

import { diffChangeRowBoundary, diffPaneRowPresentation } from "./AlignedDiffRow";
import type { DiffChangeKind, DiffPaneRow } from "./alignedDiffModel";
import styles from "./AlignedDiffGutterRows.module.css";

export interface AlignedDiffGutterRowsProps {
  readonly rows: readonly DiffPaneRow[];
  readonly rowIndexes: readonly number[];
  readonly rowOffsets: readonly number[] | undefined;
  readonly totalHeight: number;
  readonly activeChangeId: string | null;
  readonly changeKindById: ReadonlyMap<string, DiffChangeKind>;
}

export function AlignedDiffGutterRows({
  rows,
  rowIndexes,
  rowOffsets,
  totalHeight,
  activeChangeId,
  changeKindById,
}: AlignedDiffGutterRowsProps) {
  return (
    <div
      className={styles.canvas}
      style={{ height: totalHeight } as CSSProperties}
      data-keydex-aligned-gutter-canvas=""
      aria-hidden="true"
    >
      {rowIndexes.map((rowIndex) => {
        const row = rows[rowIndex];
        if (!row) return null;
        const top = rowOffsets?.[rowIndex] ?? rowIndex * row.estimatedHeight;
        const next = rowOffsets?.[rowIndex + 1] ?? top + row.estimatedHeight;
        const height = Math.max(row.estimatedHeight, next - top);
        const changeKind = row.changeId
          ? changeKindById.get(row.changeId) ?? inferredChangeKind(row)
          : null;
        const boundary = diffChangeRowBoundary(rows, rowIndex);
        const presentation = diffPaneRowPresentation(row);
        const style = {
          "--keydex-diff-gutter-row-offset": `${top}px`,
          "--keydex-diff-gutter-row-height": `${height}px`,
        } as CSSProperties;
        return (
          <div
            key={row.id}
            className={styles.row}
            style={style}
            data-keydex-aligned-gutter-row={row.id}
            data-side={row.side}
            data-kind={row.kind}
            data-change-kind={changeKind ?? undefined}
            data-change-start={boundary.start ? "true" : undefined}
            data-change-end={boundary.end ? "true" : undefined}
            data-active={row.changeId !== null && row.changeId === activeChangeId ? "true" : "false"}
          >
            <span className={styles.lineNumber}>{row.lineNumber ?? ""}</span>
            <span className={styles.indicator}>{presentation.indicator}</span>
          </div>
        );
      })}
    </div>
  );
}

function inferredChangeKind(row: DiffPaneRow): DiffChangeKind | null {
  if (!row.changeId || row.kind === "context") return null;
  if (row.kind === "added" || row.kind === "removed" || row.kind === "modified") return row.kind;
  return null;
}
