import type { KeydexDiffScrollChainingMode } from "../profiles";

export interface AlignedScrollablePane {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
}

const BOTTOM_SCROLL_SPACE_FRACTION = 0.3;

export function alignedDiffBottomScrollSpace(
  contentHeight: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(viewportHeight)) return 0;
  if (viewportHeight <= 0 || contentHeight <= viewportHeight) return 0;
  return Math.round(viewportHeight * BOTTOM_SCROLL_SPACE_FRACTION);
}

export interface AlignedDiffWheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly shiftKey: boolean;
}

export function applyAlignedDiffPaneHorizontalWheel(
  pane: AlignedScrollablePane,
  event: AlignedDiffWheelInput,
): boolean {
  const delta = alignedHorizontalWheelDelta(event, pane.clientWidth);
  if (delta === 0) return false;
  const maximum = Math.max(0, pane.scrollWidth - pane.clientWidth);
  const next = Math.min(maximum, Math.max(0, pane.scrollLeft + delta));
  if (Math.abs(next - pane.scrollLeft) < 0.01) return false;
  pane.scrollLeft = next;
  return true;
}

export function applyAlignedDiffPaneVerticalWheel(
  pane: AlignedScrollablePane,
  event: AlignedDiffWheelInput,
): boolean {
  const delta = alignedVerticalWheelDelta(event, pane.clientHeight);
  if (delta === 0) return false;
  const maximum = Math.max(0, pane.scrollHeight - pane.clientHeight);
  const next = Math.min(maximum, Math.max(0, pane.scrollTop + delta));
  if (Math.abs(next - pane.scrollTop) < 0.01) return false;
  pane.scrollTop = next;
  return true;
}

export function shouldChainAlignedDiffVerticalWheel(
  pane: Pick<AlignedScrollablePane, "scrollTop" | "scrollHeight" | "clientHeight">,
  deltaY: number,
  mode: KeydexDiffScrollChainingMode,
  tolerance = 0.5,
): boolean {
  if (mode === "contain" || !Number.isFinite(deltaY) || deltaY === 0) return false;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError("tolerance must be non-negative");
  if (deltaY < 0) return pane.scrollTop <= tolerance;
  const maximum = Math.max(0, pane.scrollHeight - pane.clientHeight);
  return pane.scrollTop >= maximum - tolerance;
}

export function alignedHorizontalWheelDelta(
  event: AlignedDiffWheelInput,
  pageWidth: number,
): number {
  // Preserve the browser's native pixel precision and momentum for real
  // horizontal input (trackpads, tilt wheels and scrollbar gestures). We only
  // synthesize horizontal movement for Shift + vertical-wheel compatibility.
  if (!event.shiftKey) return 0;
  const raw = event.deltaY || event.deltaX;
  if (raw === 0) return 0;
  const pixels = event.deltaMode === 1
    ? raw * 8
    : event.deltaMode === 2
      ? Math.sign(raw) * Math.max(1, pageWidth)
      : raw;
  return Math.sign(pixels) * Math.min(Math.abs(pixels), 32);
}

export function alignedVerticalWheelDelta(
  event: AlignedDiffWheelInput,
  pageHeight: number,
): number {
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return 0;
  const raw = event.deltaY;
  if (raw === 0) return 0;
  if (event.deltaMode === 1) return raw * 16;
  if (event.deltaMode === 2) return raw * Math.max(1, pageHeight);
  return raw;
}
