import {
  MarkdownHeightIndex,
  type MarkdownHeightUpdate,
} from "../layout/HeightIndex";

export interface MarkdownScrollAnchorCaptureInput {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly viewportOffset?: number;
}

export interface MarkdownScrollAnchor {
  readonly revision: string;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly blockLocalOffset: number;
  readonly viewportOffset: number;
  readonly capturedScrollTop: number;
  readonly interactionEpoch: number;
  readonly sequence: number;
}

export type MarkdownScrollCorrectionStatus =
  | "applied"
  | "unchanged"
  | "suppressed-user-scroll"
  | "superseded-interaction"
  | "stale-revision"
  | "missing-anchor";

export interface MarkdownScrollCorrection {
  readonly status: MarkdownScrollCorrectionStatus;
  readonly revision: string;
  readonly anchor: MarkdownScrollAnchor;
  readonly scrollTop: number;
  readonly delta: number;
  readonly heightDelta: number;
  readonly heightChanged: boolean;
  readonly shouldApply: boolean;
}

export interface MarkdownScrollHeightUpdateInput {
  readonly revision: string;
  readonly currentScrollTop: number;
  readonly viewportHeight: number;
  readonly allowDuringUserScroll?: boolean;
}

export interface MarkdownScrollIndexReplacementInput {
  readonly currentScrollTop: number;
  readonly viewportHeight: number;
  readonly blockIdRemap?: ReadonlyMap<string, string>;
  readonly allowDuringUserScroll?: boolean;
}

export interface MarkdownScrollAnchorControllerOptions {
  readonly userScrollQuietMs?: number;
  readonly correctionEpsilon?: number;
  readonly now?: () => number;
}

export interface MarkdownScrollAnchorDiagnostics {
  readonly revision: string;
  readonly captures: number;
  readonly applied: number;
  readonly unchanged: number;
  readonly suppressed: number;
  readonly stale: number;
  readonly missing: number;
  readonly interactionEpoch: number;
}

/**
 * Keeps a logical block-local point at the same viewport coordinate while the
 * height index changes. The controller never reads layout and never writes the
 * scroll container; callers decide whether to apply the returned correction.
 */
export class MarkdownScrollAnchorController {
  private heightIndex: MarkdownHeightIndex;
  private blockIds: readonly string[];
  private blockIndexById: ReadonlyMap<string, number> = new Map();
  private readonly userScrollQuietMs: number;
  private readonly correctionEpsilon: number;
  private readonly now: () => number;
  private interactionEpoch = 0;
  private lastUserScrollAt = Number.NEGATIVE_INFINITY;
  private sequence = 0;
  private captures = 0;
  private applied = 0;
  private unchanged = 0;
  private suppressed = 0;
  private stale = 0;
  private missing = 0;

  constructor(
    heightIndex: MarkdownHeightIndex,
    blockIds: readonly string[],
    options: MarkdownScrollAnchorControllerOptions = {},
    blockIndexById?: ReadonlyMap<string, number>,
  ) {
    this.heightIndex = heightIndex;
    this.blockIds = validateBlockIds(blockIds, heightIndex.length);
    this.blockIndexById = blockIndexById ?? indexBlockIds(this.blockIds);
    this.userScrollQuietMs = finiteNonNegative(options.userScrollQuietMs ?? 120, "userScrollQuietMs");
    this.correctionEpsilon = finiteNonNegative(options.correctionEpsilon ?? 0.5, "correctionEpsilon");
    this.now = options.now ?? (() => performance.now());
  }

  capture(input: MarkdownScrollAnchorCaptureInput): MarkdownScrollAnchor | null {
    const viewportHeight = finiteNonNegative(input.viewportHeight, "viewportHeight");
    const scrollTop = clampScrollTop(input.scrollTop, viewportHeight, this.heightIndex.totalHeight);
    const viewportOffset = Math.min(
      viewportHeight,
      finiteNonNegative(input.viewportOffset ?? 0, "viewportOffset"),
    );
    const result = this.heightIndex.queryY(scrollTop + viewportOffset);
    if (!result) return null;
    this.captures += 1;
    return Object.freeze({
      revision: this.heightIndex.revision,
      blockId: this.blockIds[result.index]!,
      blockIndex: result.index,
      blockLocalOffset: result.offsetWithinBlock,
      viewportOffset,
      capturedScrollTop: scrollTop,
      interactionEpoch: this.interactionEpoch,
      sequence: ++this.sequence,
    });
  }

  recordUserScroll(scrollTop: number): number {
    finite(scrollTop, "scrollTop");
    this.interactionEpoch += 1;
    this.lastUserScrollAt = this.now();
    return this.interactionEpoch;
  }

  recordProgrammaticScroll(scrollTop: number): number {
    finite(scrollTop, "scrollTop");
    this.interactionEpoch += 1;
    return this.interactionEpoch;
  }

  applyHeightUpdates(
    anchor: MarkdownScrollAnchor,
    updates: readonly MarkdownHeightUpdate[],
    input: MarkdownScrollHeightUpdateInput,
  ): MarkdownScrollCorrection {
    const viewportHeight = finiteNonNegative(input.viewportHeight, "viewportHeight");
    const currentScrollTop = clampScrollTop(input.currentScrollTop, viewportHeight, this.heightIndex.totalHeight);
    if (input.revision !== this.heightIndex.revision || anchor.revision !== this.heightIndex.revision) {
      this.stale += 1;
      return this.result("stale-revision", anchor, currentScrollTop, currentScrollTop, 0, false);
    }
    const anchorIndex = this.blockIndexById.get(anchor.blockId);
    if (anchorIndex === undefined) {
      this.missing += 1;
      return this.result("missing-anchor", anchor, currentScrollTop, currentScrollTop, 0, false);
    }
    let heightDelta = 0;
    let heightChanged = false;
    for (const update of updates) {
      const delta = this.heightIndex.update(update.index, update.height, {
        kind: update.kind,
        revision: input.revision,
      });
      heightDelta += delta;
      heightChanged ||= delta !== 0;
    }
    return this.correct(
      anchor,
      anchorIndex,
      currentScrollTop,
      viewportHeight,
      heightDelta,
      heightChanged,
      input.allowDuringUserScroll,
    );
  }

  replaceIndex(
    nextIndex: MarkdownHeightIndex,
    nextBlockIds: readonly string[],
    anchor: MarkdownScrollAnchor,
    input: MarkdownScrollIndexReplacementInput,
  ): MarkdownScrollCorrection {
    const previousRevision = this.heightIndex.revision;
    const viewportHeight = finiteNonNegative(input.viewportHeight, "viewportHeight");
    const currentScrollTop = clampScrollTop(input.currentScrollTop, viewportHeight, nextIndex.totalHeight);
    this.heightIndex = nextIndex;
    this.blockIds = validateBlockIds(nextBlockIds, nextIndex.length);
    this.blockIndexById = indexBlockIds(this.blockIds);
    if (anchor.revision !== previousRevision) {
      this.stale += 1;
      return this.result("stale-revision", anchor, currentScrollTop, currentScrollTop, 0, false);
    }
    const targetId = input.blockIdRemap?.get(anchor.blockId) ?? anchor.blockId;
    const anchorIndex = this.blockIndexById.get(targetId);
    if (anchorIndex === undefined) {
      this.missing += 1;
      return this.result("missing-anchor", anchor, currentScrollTop, currentScrollTop, 0, false);
    }
    return this.correct(anchor, anchorIndex, currentScrollTop, viewportHeight, 0, false, input.allowDuringUserScroll);
  }

  reset(
    nextIndex: MarkdownHeightIndex,
    nextBlockIds: readonly string[],
    nextBlockIndexById?: ReadonlyMap<string, number>,
  ): void {
    this.heightIndex = nextIndex;
    this.blockIds = validateBlockIds(nextBlockIds, nextIndex.length);
    this.blockIndexById = nextBlockIndexById ?? indexBlockIds(this.blockIds);
  }

  diagnostics(): MarkdownScrollAnchorDiagnostics {
    return Object.freeze({
      revision: this.heightIndex.revision,
      captures: this.captures,
      applied: this.applied,
      unchanged: this.unchanged,
      suppressed: this.suppressed,
      stale: this.stale,
      missing: this.missing,
      interactionEpoch: this.interactionEpoch,
    });
  }

  private correct(
    anchor: MarkdownScrollAnchor,
    anchorIndex: number,
    currentScrollTop: number,
    viewportHeight: number,
    heightDelta: number,
    heightChanged: boolean,
    allowDuringUserScroll = false,
  ): MarkdownScrollCorrection {
    if (anchor.interactionEpoch !== this.interactionEpoch) {
      this.suppressed += 1;
      return this.result("superseded-interaction", anchor, currentScrollTop, currentScrollTop, heightDelta, heightChanged);
    }
    if (!allowDuringUserScroll && this.now() - this.lastUserScrollAt < this.userScrollQuietMs) {
      this.suppressed += 1;
      return this.result("suppressed-user-scroll", anchor, currentScrollTop, currentScrollTop, heightDelta, heightChanged);
    }
    const localOffset = Math.min(anchor.blockLocalOffset, this.heightIndex.heightAt(anchorIndex));
    const target = clampScrollTop(
      this.heightIndex.offsetOf(anchorIndex) + localOffset - anchor.viewportOffset,
      viewportHeight,
      this.heightIndex.totalHeight,
    );
    if (Math.abs(target - currentScrollTop) <= this.correctionEpsilon) {
      this.unchanged += 1;
      return this.result("unchanged", anchor, currentScrollTop, currentScrollTop, heightDelta, heightChanged);
    }
    this.applied += 1;
    return this.result("applied", anchor, target, currentScrollTop, heightDelta, heightChanged);
  }

  private result(
    status: MarkdownScrollCorrectionStatus,
    anchor: MarkdownScrollAnchor,
    scrollTop: number,
    previousScrollTop: number,
    heightDelta: number,
    heightChanged: boolean,
  ): MarkdownScrollCorrection {
    return Object.freeze({
      status,
      revision: this.heightIndex.revision,
      anchor,
      scrollTop,
      delta: scrollTop - previousScrollTop,
      heightDelta,
      heightChanged,
      shouldApply: status === "applied",
    });
  }
}

function validateBlockIds(blockIds: readonly string[], length: number): readonly string[] {
  if (blockIds.length !== length) {
    throw new Error(`Block id count ${blockIds.length} does not match HeightIndex length ${length}`);
  }
  const copy = Object.freeze([...blockIds]);
  if (new Set(copy).size !== copy.length || copy.some((id) => !id.trim())) {
    throw new Error("Markdown scroll anchor block ids must be non-empty and unique");
  }
  return copy;
}

function indexBlockIds(blockIds: readonly string[]): Map<string, number> {
  return new Map(blockIds.map((id, index) => [id, index]));
}

function clampScrollTop(scrollTop: number, viewportHeight: number, totalHeight: number): number {
  const value = finite(scrollTop, "scrollTop");
  return Math.max(0, Math.min(value, Math.max(0, totalHeight - viewportHeight)));
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}
