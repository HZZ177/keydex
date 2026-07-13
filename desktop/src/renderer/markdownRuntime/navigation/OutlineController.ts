import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import {
  MarkdownHeightIndex,
  type MarkdownHeightUpdate,
} from "../layout/HeightIndex";
import {
  MarkdownScrollAnchorController,
  type MarkdownScrollCorrection,
} from "../view/ScrollAnchorController";
import type { MarkdownViewRevealTarget } from "../view/types";

export interface MarkdownOutlineNode {
  readonly id: string;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly title: string;
  readonly sourceLine: number;
  readonly parentBlockId: string | null;
  readonly sectionStart: number;
  readonly sectionEnd: number;
}

export interface MarkdownOutlineViewportInput {
  readonly scrollTop: number;
  readonly viewportHeight: number;
}

export interface MarkdownFoldResult {
  readonly blockId: string;
  readonly collapsed: boolean;
  readonly foldedBlockIds: readonly string[];
  readonly hiddenIndices: readonly number[];
  readonly changedIndices: readonly number[];
  readonly correction: MarkdownScrollCorrection | null;
}

export interface MarkdownOutlineNavigationResult {
  readonly targetBlockId: string;
  readonly expandedHeadingBlockIds: readonly string[];
  readonly foldResult: MarkdownFoldResult | null;
}

export interface MarkdownOutlineControllerOptions {
  readonly foldedBlockIds?: readonly string[];
  readonly onFoldedBlockIdsChanged?: (blockIds: readonly string[]) => void;
  readonly reveal?: (target: MarkdownViewRevealTarget) => void | Promise<void>;
}

export class MarkdownOutlineController {
  private snapshot: MarkdownSnapshot;
  private heightIndex: MarkdownHeightIndex;
  private baseHeights: Float64Array;
  private baseKinds: Uint8Array;
  private outlineNodes: readonly MarkdownOutlineNode[];
  private outlineById = new Map<string, MarkdownOutlineNode>();
  private outlineByBlockId = new Map<string, MarkdownOutlineNode>();
  private blockIndexById = new Map<string, number>();
  private folded = new Set<string>();
  private hidden = new Set<number>();
  private scrollAnchor: MarkdownScrollAnchorController;
  private readonly onFoldedBlockIdsChanged?: (blockIds: readonly string[]) => void;
  private readonly reveal?: (target: MarkdownViewRevealTarget) => void | Promise<void>;

  constructor(
    snapshot: MarkdownSnapshot,
    heightIndex: MarkdownHeightIndex,
    baseHeights: ArrayLike<number>,
    options: MarkdownOutlineControllerOptions = {},
  ) {
    validateInputs(snapshot, heightIndex, baseHeights);
    this.snapshot = snapshot;
    this.heightIndex = heightIndex;
    this.baseHeights = copyHeights(baseHeights);
    this.baseKinds = copyKinds(heightIndex);
    this.outlineNodes = buildOutlineNodes(snapshot);
    this.reindexOutline();
    this.folded = new Set((options.foldedBlockIds ?? []).filter((id) => this.outlineByBlockId.has(id)));
    this.hidden = computeHiddenIndices(this.outlineNodes, this.folded);
    this.applyHiddenState();
    this.scrollAnchor = new MarkdownScrollAnchorController(
      heightIndex,
      snapshot.blocks.map((block) => block.id),
    );
    this.onFoldedBlockIdsChanged = options.onFoldedBlockIdsChanged;
    this.reveal = options.reveal;
  }

  nodes(): readonly MarkdownOutlineNode[] {
    return this.outlineNodes;
  }

  foldedBlockIds(): readonly string[] {
    return Object.freeze(this.outlineNodes
      .map((node) => node.blockId)
      .filter((blockId) => this.folded.has(blockId)));
  }

  hiddenIndices(): readonly number[] {
    return Object.freeze([...this.hidden].sort((left, right) => left - right));
  }

  visibleBlockIndices(): readonly number[] {
    const visible: number[] = [];
    for (let index = 0; index < this.snapshot.blocks.length; index += 1) {
      if (!this.hidden.has(index)) visible.push(index);
    }
    return Object.freeze(visible);
  }

  toggleFold(blockId: string, viewport: MarkdownOutlineViewportInput): MarkdownFoldResult {
    const node = this.outlineByBlockId.get(blockId);
    if (!node) throw new Error(`Markdown outline heading ${blockId} is missing`);
    if (this.folded.has(blockId)) this.folded.delete(blockId);
    else this.folded.add(blockId);
    return this.commitFoldChange(blockId, viewport);
  }

  setFoldedBlockIds(
    blockIds: readonly string[],
    viewport: MarkdownOutlineViewportInput,
  ): MarkdownFoldResult {
    const valid = new Set(blockIds.filter((id) => this.outlineByBlockId.has(id)));
    this.folded = valid;
    return this.commitFoldChange(blockIds[0] ?? "", viewport);
  }

  async navigateOutline(
    outlineId: string,
    viewport: MarkdownOutlineViewportInput,
  ): Promise<MarkdownOutlineNavigationResult> {
    const node = this.outlineById.get(outlineId);
    if (!node) throw new Error(`Markdown outline item ${outlineId} is missing`);
    return this.navigateBlock(node.blockId, viewport);
  }

  async navigateBlock(
    blockId: string,
    viewport: MarkdownOutlineViewportInput,
  ): Promise<MarkdownOutlineNavigationResult> {
    const targetIndex = this.blockIndexById.get(blockId);
    if (targetIndex === undefined) throw new Error(`Markdown navigation block ${blockId} is missing`);
    const expanded = this.outlineNodes
      .filter((node) => this.folded.has(node.blockId)
        && targetIndex >= node.sectionStart
        && targetIndex < node.sectionEnd)
      .map((node) => node.blockId);
    let foldResult: MarkdownFoldResult | null = null;
    if (expanded.length) {
      expanded.forEach((id) => this.folded.delete(id));
      foldResult = this.commitFoldChange(expanded[0]!, viewport);
    }
    await this.reveal?.({ kind: "block", blockId });
    return Object.freeze({
      targetBlockId: blockId,
      expandedHeadingBlockIds: Object.freeze(expanded),
      foldResult,
    });
  }

  updateBaseHeight(index: number, height: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.baseHeights.length) {
      throw new RangeError(`Markdown outline height ${index} is out of range`);
    }
    if (!Number.isFinite(height) || height < 0) throw new Error("Markdown outline height must be non-negative");
    this.baseHeights[index] = height;
    this.baseKinds[index] = 1;
    return this.hidden.has(index)
      ? 0
      : this.heightIndex.update(index, height, { kind: "measured", revision: this.snapshot.revision });
  }

  reconcile(
    snapshot: MarkdownSnapshot,
    heightIndex: MarkdownHeightIndex,
    baseHeights: ArrayLike<number>,
  ): void {
    validateInputs(snapshot, heightIndex, baseHeights);
    const previousFolded = this.folded;
    this.snapshot = snapshot;
    this.heightIndex = heightIndex;
    this.baseHeights = copyHeights(baseHeights);
    this.baseKinds = copyKinds(heightIndex);
    this.outlineNodes = buildOutlineNodes(snapshot);
    this.reindexOutline();
    this.folded = new Set([...previousFolded].filter((id) => this.outlineByBlockId.has(id)));
    this.hidden = computeHiddenIndices(this.outlineNodes, this.folded);
    this.applyHiddenState();
    this.scrollAnchor.reset(heightIndex, snapshot.blocks.map((block) => block.id));
    this.publishFoldedState();
  }

  private commitFoldChange(
    changedBlockId: string,
    viewport: MarkdownOutlineViewportInput,
  ): MarkdownFoldResult {
    const nextHidden = computeHiddenIndices(this.outlineNodes, this.folded);
    const changedIndices = symmetricDifference(this.hidden, nextHidden);
    const updates: MarkdownHeightUpdate[] = changedIndices.map((index) => ({
      index,
      height: nextHidden.has(index) ? 0 : this.baseHeights[index]!,
      kind: nextHidden.has(index) ? "estimated" : this.baseKinds[index] ? "measured" : "estimated",
    }));
    const anchor = this.scrollAnchor.capture(viewport);
    let correction: MarkdownScrollCorrection | null = null;
    if (updates.length && anchor) {
      correction = this.scrollAnchor.applyHeightUpdates(anchor, updates, {
        revision: this.snapshot.revision,
        currentScrollTop: viewport.scrollTop,
        viewportHeight: viewport.viewportHeight,
        allowDuringUserScroll: true,
      });
    } else if (updates.length) {
      this.heightIndex.updateBatch(updates, { revision: this.snapshot.revision });
    }
    this.hidden = nextHidden;
    this.publishFoldedState();
    return Object.freeze({
      blockId: changedBlockId,
      collapsed: this.folded.has(changedBlockId),
      foldedBlockIds: this.foldedBlockIds(),
      hiddenIndices: this.hiddenIndices(),
      changedIndices: Object.freeze(changedIndices),
      correction,
    });
  }

  private applyHiddenState(): void {
    for (const index of this.hidden) {
      this.heightIndex.update(index, 0, { kind: "estimated", revision: this.snapshot.revision });
    }
  }

  private reindexOutline(): void {
    this.outlineById = new Map(this.outlineNodes.map((node) => [node.id, node]));
    this.outlineByBlockId = new Map(this.outlineNodes.map((node) => [node.blockId, node]));
    this.blockIndexById = new Map(this.snapshot.blocks.map((block) => [block.id, block.index]));
  }

  private publishFoldedState(): void {
    this.onFoldedBlockIdsChanged?.(this.foldedBlockIds());
  }
}

export function buildMarkdownOutline(snapshot: MarkdownSnapshot): readonly MarkdownOutlineNode[] {
  return buildOutlineNodes(snapshot);
}

function buildOutlineNodes(snapshot: MarkdownSnapshot): readonly MarkdownOutlineNode[] {
  const blockIndexById = new Map(snapshot.blocks.map((block) => [block.id, block.index]));
  const nodes = snapshot.outline.map((entry) => ({
    entry,
    blockIndex: blockIndexById.get(entry.block_id),
  })).filter((value): value is typeof value & { blockIndex: number } => value.blockIndex !== undefined)
    .sort((left, right) => left.blockIndex - right.blockIndex);
  const result: Array<MarkdownOutlineNode & { sectionEnd: number }> = [];
  const stack: number[] = [];
  for (const value of nodes) {
    while (stack.length && result[stack.at(-1)!]!.level >= value.entry.level) {
      result[stack.pop()!]!.sectionEnd = value.blockIndex;
    }
    const parent = stack.length ? result[stack.at(-1)!]! : null;
    result.push({
      id: value.entry.id,
      blockId: value.entry.block_id,
      blockIndex: value.blockIndex,
      level: value.entry.level,
      title: value.entry.title,
      sourceLine: value.entry.source_line,
      parentBlockId: parent?.blockId ?? null,
      sectionStart: value.blockIndex + 1,
      sectionEnd: snapshot.blocks.length,
    });
    stack.push(result.length - 1);
  }
  while (stack.length) result[stack.pop()!]!.sectionEnd = snapshot.blocks.length;
  return Object.freeze(result.map((node) => Object.freeze({ ...node })));
}

function computeHiddenIndices(
  nodes: readonly MarkdownOutlineNode[],
  folded: ReadonlySet<string>,
): Set<number> {
  const intervals = nodes
    .filter((node) => folded.has(node.blockId) && node.sectionEnd > node.sectionStart)
    .map((node) => [node.sectionStart, node.sectionEnd] as const)
    .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const hidden = new Set<number>();
  let intervalIndex = 0;
  while (intervalIndex < intervals.length) {
    let [start, end] = intervals[intervalIndex++]!;
    while (intervalIndex < intervals.length && intervals[intervalIndex]![0] <= end) {
      end = Math.max(end, intervals[intervalIndex++]![1]);
    }
    for (let index = start; index < end; index += 1) hidden.add(index);
  }
  return hidden;
}

function symmetricDifference(left: ReadonlySet<number>, right: ReadonlySet<number>): number[] {
  const values = [...left].filter((value) => !right.has(value));
  for (const value of right) if (!left.has(value)) values.push(value);
  return values.sort((a, b) => a - b);
}

function validateInputs(
  snapshot: MarkdownSnapshot,
  heightIndex: MarkdownHeightIndex,
  baseHeights: ArrayLike<number>,
): void {
  if (snapshot.revision !== heightIndex.revision
    || snapshot.blocks.length !== heightIndex.length
    || baseHeights.length !== snapshot.blocks.length) {
    throw new Error("Markdown OutlineController inputs do not match");
  }
}

function copyHeights(values: ArrayLike<number>): Float64Array {
  const result = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value) || value < 0) throw new Error("Markdown outline base height is invalid");
    result[index] = value;
  }
  return result;
}

function copyKinds(index: MarkdownHeightIndex): Uint8Array {
  const kinds = new Uint8Array(index.length);
  for (let position = 0; position < index.length; position += 1) {
    kinds[position] = index.kindAt(position) === "measured" ? 1 : 0;
  }
  return kinds;
}
