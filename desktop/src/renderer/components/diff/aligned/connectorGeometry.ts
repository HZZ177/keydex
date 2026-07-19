import type {
  DiffConnectorGeometry,
  KeydexAlignedDiffModel,
} from "./alignedDiffModel";
import type { DiffScrollMappingMetrics } from "./hunkScrollMapping";

export interface DiffConnectorViewport {
  readonly leftScrollTop: number;
  readonly rightScrollTop: number;
  readonly leftViewportHeight: number;
  readonly rightViewportHeight: number;
}

/** Computes viewport-local connector endpoints without reading layout from the DOM. */
export function computeVisibleDiffConnectorGeometry(
  _model: KeydexAlignedDiffModel,
  metrics: DiffScrollMappingMetrics,
  viewport: DiffConnectorViewport,
): readonly DiffConnectorGeometry[] {
  validateViewport(viewport);
  const maxViewportHeight = Math.max(viewport.leftViewportHeight, viewport.rightViewportHeight);
  const leftBottom = viewport.leftScrollTop + maxViewportHeight;
  const rightBottom = viewport.rightScrollTop + maxViewportHeight;
  const firstVisibleIndex = Math.min(
    findFirstPotentiallyVisible(metrics.segments, "left", viewport.leftScrollTop),
    findFirstPotentiallyVisible(metrics.segments, "right", viewport.rightScrollTop),
  );
  const result: DiffConnectorGeometry[] = [];
  for (let index = firstVisibleIndex; index < metrics.segments.length; index += 1) {
    const mapping = metrics.segments[index]!;
    if (mapping.left.start > leftBottom && mapping.right.start > rightBottom) break;
    const change = mapping.change;
    if (!change) continue;
    const rawLeftStart = mapping.left.start - viewport.leftScrollTop;
    const rawLeftEnd = mapping.left.end - viewport.leftScrollTop;
    const rawRightStart = mapping.right.start - viewport.rightScrollTop;
    const rawRightEnd = mapping.right.end - viewport.rightScrollTop;
    const envelopeStart = Math.min(rawLeftStart, rawRightStart);
    const envelopeEnd = Math.max(rawLeftEnd, rawRightEnd);
    if (envelopeEnd < 0 || envelopeStart > maxViewportHeight) continue;
    result.push(Object.freeze({
      changeId: change.id,
      kind: change.kind,
      leftStart: clamp(rawLeftStart, 0, viewport.leftViewportHeight),
      leftEnd: clamp(rawLeftEnd, 0, viewport.leftViewportHeight),
      rightStart: clamp(rawRightStart, 0, viewport.rightViewportHeight),
      rightEnd: clamp(rawRightEnd, 0, viewport.rightViewportHeight),
      clippedTop: rawLeftStart < 0 || rawRightStart < 0,
      clippedBottom:
        rawLeftEnd > viewport.leftViewportHeight
        || rawRightEnd > viewport.rightViewportHeight,
    }));
  }
  return Object.freeze(result);
}

function findFirstPotentiallyVisible(
  segments: DiffScrollMappingMetrics["segments"],
  side: "left" | "right",
  viewportStart: number,
): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (segments[middle]![side].end < viewportStart) low = middle + 1;
    else high = middle;
  }
  return low;
}

function validateViewport(viewport: DiffConnectorViewport): void {
  const values = [
    viewport.leftScrollTop,
    viewport.rightScrollTop,
    viewport.leftViewportHeight,
    viewport.rightViewportHeight,
  ];
  if (!values.every(Number.isFinite)) throw new TypeError("connector viewport values must be finite");
  if (viewport.leftScrollTop < 0 || viewport.rightScrollTop < 0) {
    throw new RangeError("connector scroll offsets must be non-negative");
  }
  if (viewport.leftViewportHeight < 0 || viewport.rightViewportHeight < 0) {
    throw new RangeError("connector viewport heights must be non-negative");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
