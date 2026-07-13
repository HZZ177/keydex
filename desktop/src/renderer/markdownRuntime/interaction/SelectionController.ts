import type { DocumentSelection } from "@/renderer/features/annotations/document/DocumentTextModel";

import type { MarkdownPositionMapper } from "../mapping";

export type MarkdownSelectionDirection = "forward" | "backward" | "none";

export interface MarkdownSelectionBlockRange {
  readonly blockId: string;
  readonly blockIndex: number;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly blockLocalStart: number;
  readonly blockLocalEnd: number;
}

export interface MarkdownProjectedSelection {
  readonly revision: string;
  readonly direction: MarkdownSelectionDirection;
  readonly nativeText: string;
  readonly logicalText: string;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly blockRanges: readonly MarkdownSelectionBlockRange[];
  readonly pinnedBlockIds: readonly string[];
  readonly pinnedIndices: ReadonlySet<number>;
  readonly anchor: {
    readonly blockId: string;
    readonly blockLocalLogicalOffset: number;
  };
  readonly focus: {
    readonly blockId: string;
    readonly blockLocalLogicalOffset: number;
  };
  readonly annotationSelection: DocumentSelection;
}

export type MarkdownSelectionFailureReason =
  | "no-selection"
  | "collapsed"
  | "outside-document"
  | "unmapped-endpoint"
  | "empty-logical-range"
  | "split-surrogate"
  | "pin-limit"
  | "restore-unavailable"
  | "restore-text-changed";

export interface MarkdownSelectionUpdateResult {
  readonly selection: MarkdownProjectedSelection | null;
  readonly reason: MarkdownSelectionFailureReason | null;
}

export interface MarkdownSelectionControllerOptions {
  readonly mapper: MarkdownPositionMapper;
  readonly boundary: HTMLElement;
  readonly selection?: Selection | null;
  readonly maxPinnedBlocks?: number;
  readonly preserveFocusTarget?: (target: Element | null) => boolean;
  readonly onChange?: (result: MarkdownSelectionUpdateResult) => void;
  readonly onPinnedIndicesChanged?: (indices: ReadonlySet<number>) => void;
}

export class MarkdownSelectionController {
  private mapper: MarkdownPositionMapper;
  private readonly boundary: HTMLElement;
  private readonly nativeSelection: Selection | null;
  private readonly maxPinnedBlocks: number;
  private readonly preserveFocusTarget: (target: Element | null) => boolean;
  private readonly onChange?: (result: MarkdownSelectionUpdateResult) => void;
  private readonly onPinnedIndicesChanged?: (indices: ReadonlySet<number>) => void;
  private current: MarkdownProjectedSelection | null = null;
  private attached = false;
  private disposed = false;

  constructor(options: MarkdownSelectionControllerOptions) {
    this.mapper = options.mapper;
    this.boundary = options.boundary;
    this.nativeSelection = options.selection === undefined
      ? options.boundary.ownerDocument.getSelection()
      : options.selection;
    this.maxPinnedBlocks = positiveInteger(options.maxPinnedBlocks ?? 128, "maxPinnedBlocks");
    this.preserveFocusTarget = options.preserveFocusTarget
      ?? ((target) => target !== null && this.boundary.contains(target));
    this.onChange = options.onChange;
    this.onPinnedIndicesChanged = options.onPinnedIndicesChanged;
  }

  attach(): () => void {
    this.assertActive();
    if (this.attached) return () => this.detach();
    this.attached = true;
    this.boundary.ownerDocument.addEventListener("selectionchange", this.handleSelectionChange);
    this.boundary.addEventListener("focusout", this.handleFocusOut);
    this.update();
    return () => this.detach();
  }

  update(): MarkdownSelectionUpdateResult {
    this.assertActive();
    const selection = this.nativeSelection;
    if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) {
      return this.commit(null, "no-selection");
    }
    if (selection.isCollapsed) return this.commit(null, "collapsed");
    if (!this.boundary.contains(selection.anchorNode) || !this.boundary.contains(selection.focusNode)) {
      return this.commit(null, "outside-document");
    }
    const anchor = this.mapper.domPosition(selection.anchorNode, selection.anchorOffset);
    const focus = this.mapper.domPosition(selection.focusNode, selection.focusOffset);
    if (anchor.status !== "exact" || focus.status !== "exact"
      || anchor.logicalOffset === null || focus.logicalOffset === null
      || anchor.sourceOffset === null || focus.sourceOffset === null
      || anchor.blockId === null || focus.blockId === null
      || anchor.blockIndex === null || focus.blockIndex === null
      || anchor.blockLocalLogicalOffset === null || focus.blockLocalLogicalOffset === null) {
      return this.commit(null, "unmapped-endpoint");
    }
    const logicalStart = Math.min(anchor.logicalOffset, focus.logicalOffset);
    const logicalEnd = Math.max(anchor.logicalOffset, focus.logicalOffset);
    if (logicalEnd <= logicalStart) return this.commit(null, "empty-logical-range");
    if (!isCodePointBoundary(this.mapper.snapshot.logical_text, logicalStart)
      || !isCodePointBoundary(this.mapper.snapshot.logical_text, logicalEnd)) {
      return this.commit(null, "split-surrogate");
    }
    const firstBlock = Math.min(anchor.blockIndex, focus.blockIndex);
    const lastBlock = Math.max(anchor.blockIndex, focus.blockIndex);
    if (lastBlock - firstBlock + 1 > this.maxPinnedBlocks) return this.commit(null, "pin-limit");
    const blockRanges: MarkdownSelectionBlockRange[] = [];
    for (let index = firstBlock; index <= lastBlock; index += 1) {
      const block = this.mapper.snapshot.blocks[index]!;
      const start = Math.max(logicalStart, block.logical_start);
      const end = Math.min(logicalEnd, block.logical_end);
      if (end <= start) continue;
      blockRanges.push(Object.freeze({
        blockId: block.id,
        blockIndex: index,
        logicalStart: start,
        logicalEnd: end,
        blockLocalStart: start - block.logical_start,
        blockLocalEnd: end - block.logical_start,
      }));
    }
    const pinnedIndices = new Set(blockRanges.map((range) => range.blockIndex));
    const direction = anchor.logicalOffset === focus.logicalOffset
      ? "none"
      : anchor.logicalOffset < focus.logicalOffset ? "forward" : "backward";
    const projected: MarkdownProjectedSelection = Object.freeze({
      revision: this.mapper.snapshot.revision,
      direction,
      nativeText: selection.toString(),
      logicalText: this.mapper.snapshot.logical_text.slice(logicalStart, logicalEnd),
      logicalStart,
      logicalEnd,
      sourceStart: Math.min(anchor.sourceOffset, focus.sourceOffset),
      sourceEnd: Math.max(anchor.sourceOffset, focus.sourceOffset),
      blockRanges: Object.freeze(blockRanges),
      pinnedBlockIds: Object.freeze(blockRanges.map((range) => range.blockId)),
      pinnedIndices,
      anchor: Object.freeze({
        blockId: anchor.blockId,
        blockLocalLogicalOffset: anchor.blockLocalLogicalOffset,
      }),
      focus: Object.freeze({
        blockId: focus.blockId,
        blockLocalLogicalOffset: focus.blockLocalLogicalOffset,
      }),
      annotationSelection: Object.freeze({
        coordinateSpace: "logical" as const,
        range: Object.freeze({ start: logicalStart, end: logicalEnd }),
      }),
    });
    return this.commit(projected, null);
  }

  reconcileMapper(nextMapper: MarkdownPositionMapper, restore = true): MarkdownSelectionUpdateResult {
    this.assertActive();
    const previous = this.current;
    this.mapper = nextMapper;
    if (!previous || !restore) {
      this.clearNativeSelection();
      return this.commit(null, previous ? "restore-unavailable" : "no-selection");
    }
    const anchor = nextMapper.blockLocal(previous.anchor.blockId, previous.anchor.blockLocalLogicalOffset);
    const focus = nextMapper.blockLocal(previous.focus.blockId, previous.focus.blockLocalLogicalOffset);
    if (!anchor.dom || !focus.dom || anchor.logicalOffset === null || focus.logicalOffset === null) {
      this.clearNativeSelection();
      return this.commit(null, "restore-unavailable");
    }
    const start = Math.min(anchor.logicalOffset, focus.logicalOffset);
    const end = Math.max(anchor.logicalOffset, focus.logicalOffset);
    if (nextMapper.snapshot.logical_text.slice(start, end) !== previous.logicalText) {
      this.clearNativeSelection();
      return this.commit(null, "restore-text-changed");
    }
    const selection = this.nativeSelection;
    if (!selection) return this.commit(null, "restore-unavailable");
    selection.removeAllRanges();
    if (previous.direction === "backward" && typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(
        anchor.dom.node,
        anchor.dom.offset,
        focus.dom.node,
        focus.dom.offset,
      );
    } else {
      const range = this.boundary.ownerDocument.createRange();
      const first = previous.direction === "backward" ? focus.dom : anchor.dom;
      const last = previous.direction === "backward" ? anchor.dom : focus.dom;
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset);
      selection.addRange(range);
    }
    return this.update();
  }

  currentSelection(): MarkdownProjectedSelection | null {
    return this.current;
  }

  pinnedIndices(): ReadonlySet<number> {
    return this.current?.pinnedIndices ?? EMPTY_PINNED;
  }

  clear(clearNative = true): void {
    this.assertActive();
    if (clearNative) this.clearNativeSelection();
    this.commit(null, "no-selection");
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.boundary.ownerDocument.removeEventListener("selectionchange", this.handleSelectionChange);
    this.boundary.removeEventListener("focusout", this.handleFocusOut);
  }

  destroy(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.current = null;
    this.onPinnedIndicesChanged?.(EMPTY_PINNED);
  }

  private readonly handleSelectionChange = () => {
    if (!this.disposed) this.update();
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    const target = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (!this.preserveFocusTarget(target)) this.clear(false);
  };

  private commit(
    selection: MarkdownProjectedSelection | null,
    reason: MarkdownSelectionFailureReason | null,
  ): MarkdownSelectionUpdateResult {
    this.current = selection;
    const result = Object.freeze({ selection, reason });
    this.onPinnedIndicesChanged?.(selection?.pinnedIndices ?? EMPTY_PINNED);
    this.onChange?.(result);
    return result;
  }

  private clearNativeSelection(): void {
    const selection = this.nativeSelection;
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (this.boundary.contains(range.commonAncestorContainer)) selection.removeAllRanges();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown SelectionController is destroyed");
  }
}

function isCodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const current = value.charCodeAt(offset);
  const previous = value.charCodeAt(offset - 1);
  return !(current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const EMPTY_PINNED: ReadonlySet<number> = new Set();
