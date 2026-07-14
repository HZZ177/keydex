import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
  MarkdownSnapshotResourceKind,
} from "../document/MarkdownSnapshot";
import type { MarkdownBlockRenderUnit } from "../document/blockSubdivision";

export interface MarkdownKnownResourceSize {
  readonly width: number;
  readonly height: number;
}

export interface MarkdownHeightEstimateOptions {
  readonly viewportWidth: number;
  readonly baseLineHeight?: number;
  readonly averageCharacterWidth?: number;
  readonly horizontalPadding?: number;
  readonly blockGap?: number;
  readonly knownResourceSizes?: ReadonlyMap<string, MarkdownKnownResourceSize>;
}

export interface MarkdownHeightEstimateContext {
  readonly viewportWidth: number;
  readonly availableWidth: number;
  readonly baseLineHeight: number;
  readonly averageCharacterWidth: number;
  readonly blockGap: number;
  readonly knownResourcesByBlock: ReadonlyMap<string, readonly ResolvedResourceSize[]>;
}

interface ResolvedResourceSize extends MarkdownKnownResourceSize {
  readonly kind: MarkdownSnapshotResourceKind;
}

interface EstimateShape {
  readonly logicalCharacters: number;
  readonly sourceLines: number;
  readonly tableRows: number;
  readonly includeBlockGap: boolean;
}

export function createMarkdownHeightEstimateContext(
  snapshot: Pick<MarkdownSnapshot, "resources">,
  options: MarkdownHeightEstimateOptions,
): MarkdownHeightEstimateContext {
  const viewportWidth = finitePositive(options.viewportWidth, "viewportWidth");
  const baseLineHeight = finitePositive(options.baseLineHeight ?? 22, "baseLineHeight");
  const averageCharacterWidth = finitePositive(
    options.averageCharacterWidth ?? 8,
    "averageCharacterWidth",
  );
  const horizontalPadding = finiteNonNegative(options.horizontalPadding ?? 32, "horizontalPadding");
  const blockGap = finiteNonNegative(options.blockGap ?? 12, "blockGap");
  const knownResourcesByBlock = new Map<string, ResolvedResourceSize[]>();
  for (const resource of snapshot.resources) {
    const size = options.knownResourceSizes?.get(resource.id);
    if (!size || !validSize(size)) continue;
    const entries = knownResourcesByBlock.get(resource.block_id) ?? [];
    entries.push(Object.freeze({ kind: resource.kind, width: size.width, height: size.height }));
    knownResourcesByBlock.set(resource.block_id, entries);
  }
  return Object.freeze({
    viewportWidth,
    availableWidth: Math.max(80, viewportWidth - horizontalPadding),
    baseLineHeight,
    averageCharacterWidth,
    blockGap,
    knownResourcesByBlock,
  });
}

export function estimateMarkdownBlockHeight(
  block: MarkdownSnapshotBlock,
  context: MarkdownHeightEstimateContext,
): number {
  return estimateMarkdownBlockHeightWithGap(block, context, true);
}

function estimateMarkdownBlockHeightWithGap(
  block: MarkdownSnapshotBlock,
  context: MarkdownHeightEstimateContext,
  includeBlockGap: boolean,
): number {
  return estimate(block, context, {
    logicalCharacters: Math.max(0, block.logical_end - block.logical_start),
    sourceLines: Math.max(1, block.line_end - block.line_start),
    tableRows: Math.max(1, block.line_end - block.line_start - 1),
    includeBlockGap,
  });
}

export function estimateMarkdownRenderUnitHeight(
  block: MarkdownSnapshotBlock,
  unit: MarkdownBlockRenderUnit,
  context: MarkdownHeightEstimateContext,
): number {
  if (unit.blockId !== block.id) throw new Error("Render unit does not belong to block");
  return estimate(block, context, {
    logicalCharacters: Math.max(0, unit.logicalEnd - unit.logicalStart),
    sourceLines: Math.max(1, unit.lineEnd - unit.lineStart),
    tableRows: unit.rowStart === null || unit.rowEnd === null
      ? 1
      : Math.max(1, unit.rowEnd - unit.rowStart + (unit.tableHeaderLogicalStart === null ? 0 : 1)),
    includeBlockGap: !unit.continuationAfter,
  });
}

export function estimateMarkdownSnapshotHeights(
  snapshot: MarkdownSnapshot,
  options: MarkdownHeightEstimateOptions,
): Float64Array {
  const context = createMarkdownHeightEstimateContext(snapshot, options);
  return estimateMarkdownBlockHeights(snapshot.blocks, context);
}

export async function estimateMarkdownSnapshotHeightsIncrementally(
  snapshot: MarkdownSnapshot,
  options: MarkdownHeightEstimateOptions,
  yieldControl: () => Promise<void>,
  chunkSize = 2_048,
): Promise<Float64Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be a positive integer");
  const context = createMarkdownHeightEstimateContext(snapshot, options);
  const heights = new Float64Array(snapshot.blocks.length);
  for (let start = 0; start < snapshot.blocks.length; start += chunkSize) {
    const end = Math.min(snapshot.blocks.length, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      heights[index] = estimateMarkdownBlockHeightWithGap(
        snapshot.blocks[index],
        context,
        index < snapshot.blocks.length - 1,
      );
    }
    if (end < snapshot.blocks.length) await yieldControl();
  }
  return heights;
}

export function estimateMarkdownBlockHeights(
  blocks: readonly MarkdownSnapshotBlock[],
  context: MarkdownHeightEstimateContext,
): Float64Array {
  const heights = new Float64Array(blocks.length);
  for (let index = 0; index < blocks.length; index += 1) {
    heights[index] = estimateMarkdownBlockHeightWithGap(blocks[index], context, index < blocks.length - 1);
  }
  return heights;
}

/**
 * Converts a real block border-box measurement into the vertical extent owned
 * by that absolute-positioned block. Margins cannot separate absolute
 * siblings, so inter-block spacing belongs in HeightIndex. The final block
 * deliberately owns no trailing gap, which keeps one-line message bubbles
 * tight without allowing adjacent Markdown blocks to collide.
 */
export function measuredMarkdownBlockOccupiedHeight(
  borderBoxHeight: number,
  blockIndex: number,
  blockCount: number,
  blockGap = 12,
): number {
  const height = finiteNonNegative(borderBoxHeight, "borderBoxHeight");
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || blockIndex >= blockCount) {
    throw new Error("blockIndex must address blockCount");
  }
  if (!Number.isSafeInteger(blockCount) || blockCount < 1) throw new Error("blockCount must be a positive integer");
  const gap = finiteNonNegative(blockGap, "blockGap");
  return roundHeight(height + (blockIndex < blockCount - 1 ? gap : 0));
}

function estimate(
  block: MarkdownSnapshotBlock,
  context: MarkdownHeightEstimateContext,
  shape: EstimateShape,
): number {
  const line = context.baseLineHeight;
  const charactersPerLine = Math.max(8, Math.floor(context.availableWidth / context.averageCharacterWidth));
  const wrappedLines = Math.max(
    shape.logicalCharacters === 0 ? 1 : Math.ceil(shape.logicalCharacters / charactersPerLine),
    shape.sourceLines,
  );
  let contentHeight: number;
  switch (block.kind) {
    case "heading": {
      const level = block.metadata.heading_level ?? 1;
      const headingLineHeight = line * Math.max(1.1, 1.65 - (level - 1) * 0.1);
      contentHeight = Math.max(headingLineHeight, wrappedLines * headingLineHeight) + 8;
      break;
    }
    case "paragraph":
      contentHeight = wrappedLines * line;
      break;
    case "blockquote":
      contentHeight = wrappedLines * line + 16;
      break;
    case "list": {
      const items = Math.max(1, block.metadata.list?.item_count ?? shape.sourceLines);
      contentHeight = Math.max(items, wrappedLines) * line + 4;
      break;
    }
    case "code":
      contentHeight = 34 + shape.sourceLines * Math.max(18, line * 0.9) + 16;
      break;
    case "mermaid":
      contentHeight = knownResourceHeight(block.id, context, "mermaid")
        ?? Math.max(240, Math.min(560, context.availableWidth * 0.56));
      break;
    case "table": {
      const narrowWrap = context.availableWidth < Math.max(320, (block.metadata.table?.columns ?? 1) * 120)
        ? 1.35
        : 1;
      contentHeight = shape.tableRows * 32 * narrowWrap + 2;
      break;
    }
    case "image":
      contentHeight = knownResourceHeight(block.id, context, "image")
        ?? Math.max(160, Math.min(480, context.availableWidth * 0.56));
      break;
    case "math":
      contentHeight = Math.max(56, wrappedLines * line * 1.2);
      break;
    case "html":
    case "frontmatter":
      contentHeight = 24 + shape.sourceLines * Math.max(18, line * 0.9);
      break;
    case "thematic-break":
      contentHeight = 17;
      break;
    case "unknown":
    default:
      contentHeight = wrappedLines * line;
      break;
  }
  if (block.kind !== "image" && block.kind !== "mermaid") {
    const inlineImageHeight = knownResourceHeight(block.id, context, "image");
    if (inlineImageHeight !== null) contentHeight += inlineImageHeight + 8;
  }
  const minimum = minimumHeight(block.kind, line);
  return roundHeight(Math.max(minimum, contentHeight) + (shape.includeBlockGap ? context.blockGap : 0));
}

function knownResourceHeight(
  blockId: string,
  context: MarkdownHeightEstimateContext,
  kind: MarkdownSnapshotResourceKind,
): number | null {
  const resources = context.knownResourcesByBlock.get(blockId);
  if (!resources) return null;
  let height: number | null = null;
  for (const resource of resources) {
    if (resource.kind !== kind) continue;
    const scale = Math.min(1, context.availableWidth / resource.width);
    const fitted = Math.min(2400, resource.height * scale);
    height = Math.max(height ?? 0, fitted);
  }
  return height;
}

function minimumHeight(kind: MarkdownSnapshotBlock["kind"], line: number): number {
  if (kind === "heading") return line * 1.3;
  if (kind === "code" || kind === "html" || kind === "frontmatter") return 64;
  if (kind === "table") return 66;
  if (kind === "image" || kind === "mermaid") return 160;
  if (kind === "thematic-break") return 17;
  return line;
}

function roundHeight(value: number): number {
  return Math.round(value * 2) / 2;
}

function validSize(value: MarkdownKnownResourceSize): boolean {
  return Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}
