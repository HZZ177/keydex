import type { CSSProperties } from "react";

import type { DiffConnectorGeometry } from "./alignedDiffModel";
import styles from "./DiffConnectorLane.module.css";

export interface DiffConnectorLaneProps {
  readonly geometry: readonly DiffConnectorGeometry[];
  readonly height: number;
  readonly activeChangeId?: string | null;
  readonly hoveredChangeId?: string | null;
  readonly edgeWidth?: number;
  readonly className?: string;
}

export function DiffConnectorLane({
  geometry,
  height,
  activeChangeId = null,
  hoveredChangeId = null,
  edgeWidth = 1,
  className,
}: DiffConnectorLaneProps) {
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const safeEdgeWidth = Number.isFinite(edgeWidth) && edgeWidth > 0 ? edgeWidth : 1;
  const style = {
    "--keydex-diff-edge-width": `${safeEdgeWidth}px`,
  } as CSSProperties;
  return (
    <svg
      className={[styles.lane, className].filter(Boolean).join(" ")}
      style={style}
      viewBox={`0 0 100 ${safeHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-keydex-diff-connector=""
    >
      {geometry.map((item) => {
        const zeroEdge = diffConnectorZeroEdgePathData(item);
        return (
          <g
            key={item.changeId}
            className={styles.change}
            data-change-id={item.changeId}
            data-kind={item.kind}
            data-active={activeChangeId === item.changeId ? "true" : "false"}
            data-hovered={hoveredChangeId === item.changeId ? "true" : "false"}
            data-clipped-top={item.clippedTop ? "true" : "false"}
            data-clipped-bottom={item.clippedBottom ? "true" : "false"}
            data-left-start={number(item.leftStart)}
            data-left-end={number(item.leftEnd)}
            data-right-start={number(item.rightStart)}
            data-right-end={number(item.rightEnd)}
          >
            <path
              className={styles.fill}
              d={diffConnectorPathData(item, safeEdgeWidth)}
              data-connector-fill=""
            />
            {zeroEdge ? (
              <path
                className={[styles.edge, styles.zeroEdge].join(" ")}
                d={zeroEdge}
                vectorEffect="non-scaling-stroke"
                data-connector-zero-edge={item.kind === "added" ? "old" : "new"}
              />
            ) : null}
            {diffConnectorEdgePathData(item, safeEdgeWidth).map((pathData, index) => (
              <path
                key={index === 0 ? "start" : "end"}
                className={styles.edge}
                d={pathData}
                vectorEffect="non-scaling-stroke"
                data-connector-edge={index === 0 ? "start" : "end"}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export function diffConnectorPathData(
  geometry: DiffConnectorGeometry,
  edgeWidth = 1,
): string {
  const edges = diffConnectorVisualEdges(geometry, edgeWidth);
  return [
    `M 0 ${edges.leftStart}`,
    `C 36 ${edges.leftStart} 64 ${edges.rightStart} 100 ${edges.rightStart}`,
    `L 100 ${edges.rightEnd}`,
    `C 64 ${edges.rightEnd} 36 ${edges.leftEnd} 0 ${edges.leftEnd}`,
    "Z",
  ].join(" ");
}

export function diffConnectorEdgePathData(
  geometry: DiffConnectorGeometry,
  edgeWidth = 1,
): readonly [start: string, end: string] {
  const edges = diffConnectorVisualEdges(geometry, edgeWidth);
  return Object.freeze([
    `M 0 ${edges.leftStart} C 36 ${edges.leftStart} 64 ${edges.rightStart} 100 ${edges.rightStart}`,
    `M 0 ${edges.leftEnd} C 36 ${edges.leftEnd} 64 ${edges.rightEnd} 100 ${edges.rightEnd}`,
  ]);
}

export function diffConnectorZeroEdgePathData(geometry: DiffConnectorGeometry): string | null {
  if (geometry.kind === "added" && geometry.leftStart === geometry.leftEnd) {
    const y = number(geometry.leftStart);
    return `M -10000 ${y} L 0 ${y}`;
  }
  if (geometry.kind === "removed" && geometry.rightStart === geometry.rightEnd) {
    const y = number(geometry.rightStart);
    return `M 100 ${y} L 10100 ${y}`;
  }
  return null;
}

function diffConnectorVisualEdges(geometry: DiffConnectorGeometry, edgeWidth: number): {
  readonly leftStart: string;
  readonly leftEnd: string;
  readonly rightStart: string;
  readonly rightEnd: string;
} {
  const leftZero = geometry.kind === "added" && geometry.leftStart === geometry.leftEnd;
  const rightZero = geometry.kind === "removed" && geometry.rightStart === geometry.rightEnd;
  const edgeCenterOffset = safeEdgeCenterOffset(edgeWidth);
  const left = insetConnectorRange(geometry.leftStart, geometry.leftEnd, leftZero, edgeCenterOffset);
  const right = insetConnectorRange(geometry.rightStart, geometry.rightEnd, rightZero, edgeCenterOffset);
  return Object.freeze({
    leftStart: number(left.start),
    leftEnd: number(left.end),
    rightStart: number(right.start),
    rightEnd: number(right.end),
  });
}

function insetConnectorRange(
  start: number,
  end: number,
  zeroHeight: boolean,
  edgeCenterOffset: number,
): Readonly<{ start: number; end: number }> {
  if (zeroHeight) {
    return Object.freeze({
      start: start - edgeCenterOffset,
      end: end + edgeCenterOffset,
    });
  }
  if (end - start <= edgeCenterOffset * 2) {
    const midpoint = start + (end - start) / 2;
    return Object.freeze({ start: midpoint, end: midpoint });
  }
  return Object.freeze({
    start: start + edgeCenterOffset,
    end: end - edgeCenterOffset,
  });
}

function safeEdgeCenterOffset(edgeWidth: number): number {
  if (!Number.isFinite(edgeWidth) || edgeWidth <= 0) return 0.5;
  return edgeWidth / 2;
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("connector coordinates must be finite");
  return String(Object.is(value, -0) ? 0 : value);
}
