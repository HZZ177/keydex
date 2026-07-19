import { memo, useCallback, type CSSProperties } from "react";

import { SafeDiffTokens } from "./safeHastRenderer";
import type { DiffChangeKind, DiffPaneRow } from "./alignedDiffModel";
import styles from "./AlignedDiffRow.module.css";

export interface AlignedDiffRowProps {
  readonly row: DiffPaneRow;
  readonly wrap: boolean;
  readonly lineNumberDigits?: number;
  readonly active?: boolean;
  readonly changeKind?: DiffChangeKind | null;
  readonly changeStart?: boolean;
  readonly changeEnd?: boolean;
  readonly rowRef?: (element: HTMLDivElement | null) => void;
  readonly rowIndex?: number;
  readonly offsetTop?: number;
  readonly observeRow?: (rowIndex: number, element: HTMLElement | null) => void;
  readonly gutterMode?: "inline" | "external";
}

export const AlignedDiffRow = memo(function AlignedDiffRow({
  row,
  wrap,
  lineNumberDigits = 3,
  active = false,
  changeKind = null,
  changeStart = false,
  changeEnd = false,
  rowRef,
  rowIndex,
  offsetTop,
  observeRow,
  gutterMode = "inline",
}: AlignedDiffRowProps) {
  const measuredRowRef = useCallback((element: HTMLDivElement | null) => {
    rowRef?.(element);
    if (rowIndex !== undefined) observeRow?.(rowIndex, element);
  }, [observeRow, rowIndex, rowRef]);
  const style = {
    "--keydex-diff-line-number-digits": String(Math.max(1, lineNumberDigits)),
    "--keydex-diff-row-estimated-height": `${row.estimatedHeight}px`,
    ...(offsetTop === undefined ? {} : { "--keydex-diff-row-offset": `${offsetTop}px` }),
  } as CSSProperties;
  const presentation = diffPaneRowPresentation(row);
  const effectiveChangeKind = changeKind ?? inferredChangeKind(row);
  return (
    <div
      ref={measuredRowRef}
      className={styles.row}
      style={style}
      data-keydex-aligned-row={row.id}
      data-side={row.side}
      data-kind={row.kind}
      data-change-kind={effectiveChangeKind ?? undefined}
      data-change-start={changeStart ? "true" : undefined}
      data-change-end={changeEnd ? "true" : undefined}
      data-segment-id={row.segmentId}
      data-change-id={row.changeId ?? undefined}
      data-active={active ? "true" : "false"}
      data-wrap={wrap ? "true" : "false"}
      data-positioned={offsetTop === undefined ? "false" : "true"}
      data-gutter-mode={gutterMode}
      data-copy-text={diffPaneRowCopyText(row)}
      role="row"
      aria-label={presentation.label}
      aria-selected={active || undefined}
    >
      {gutterMode === "inline" ? (
        <>
          <span className={styles.lineNumber} aria-hidden="true">
            {row.lineNumber ?? ""}
          </span>
          <span className={styles.indicator} aria-hidden="true">
            {presentation.indicator}
          </span>
        </>
      ) : null}
      <code className={styles.code} role="gridcell">
        <SafeDiffTokens tokens={row.tokens} />
        {row.tokens.length === 0 ? row.text : null}
      </code>
    </div>
  );
});

export function diffChangeRowBoundary(
  rows: readonly Pick<DiffPaneRow, "changeId">[],
  rowIndex: number,
): Readonly<{ start: boolean; end: boolean }> {
  const changeId = rows[rowIndex]?.changeId ?? null;
  if (!changeId) return Object.freeze({ start: false, end: false });
  return Object.freeze({
    start: rows[rowIndex - 1]?.changeId !== changeId,
    // A following change owns their shared boundary. This prevents the previous
    // end edge and next start edge from forming a double-width band.
    end: !rows[rowIndex + 1]?.changeId,
  });
}

function inferredChangeKind(row: DiffPaneRow): DiffChangeKind | null {
  if (!row.changeId || row.kind === "context") return null;
  if (row.kind === "added" || row.kind === "removed" || row.kind === "modified") return row.kind;
  return null;
}

export function diffPaneRowCopyText(row: DiffPaneRow): string {
  return row.text;
}

export function diffPaneRowPresentation(row: DiffPaneRow): {
  readonly indicator: string;
  readonly label: string;
} {
  const semantics = row.kind === "added"
    ? { indicator: "+", name: "新增" }
    : row.kind === "removed"
      ? { indicator: "−", name: "删除" }
      : row.kind === "modified"
        ? { indicator: "", name: "修改" }
        : { indicator: "", name: "上下文" };
  const line = row.lineNumber === null ? "无行号" : `第 ${row.lineNumber} 行`;
  return Object.freeze({ indicator: semantics.indicator, label: `${line}，${semantics.name}` });
}
