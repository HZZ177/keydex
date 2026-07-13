import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
} from "./MarkdownSnapshot";

export type MarkdownBlockSubdivisionKind =
  | "whole"
  | "paragraph-segment"
  | "code-segment"
  | "code-lines"
  | "table-rows";

export interface MarkdownBlockRenderUnit {
  readonly id: string;
  readonly blockId: string;
  readonly index: number;
  readonly kind: MarkdownBlockSubdivisionKind;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly rowStart: number | null;
  readonly rowEnd: number | null;
  readonly continuationBefore: boolean;
  readonly continuationAfter: boolean;
  readonly tableHeaderLogicalStart: number | null;
  readonly tableHeaderLogicalEnd: number | null;
}

export interface MarkdownBlockSubdivisionOptions {
  readonly paragraphMaxCharacters?: number;
  readonly codeMaxCharacters?: number;
  readonly codeMaxLines?: number;
  readonly tableMaxCharacters?: number;
  readonly tableMaxRows?: number;
}

interface NormalizedMarkdownBlockSubdivisionOptions {
  readonly paragraphMaxCharacters: number;
  readonly codeMaxCharacters: number;
  readonly codeMaxLines: number;
  readonly tableMaxCharacters: number;
  readonly tableMaxRows: number;
}

export interface MarkdownSubdivisionSelectionSegment {
  readonly unitId: string;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

const DEFAULTS = Object.freeze({
  paragraphMaxCharacters: 16 * 1024,
  codeMaxCharacters: 64 * 1024,
  codeMaxLines: 500,
  tableMaxCharacters: 64 * 1024,
  tableMaxRows: 200,
});

export function subdivideMarkdownBlock(
  snapshot: MarkdownSnapshot,
  block: MarkdownSnapshotBlock,
  options: MarkdownBlockSubdivisionOptions = {},
): readonly MarkdownBlockRenderUnit[] {
  if (snapshot.blocks[block.index]?.id !== block.id) throw new Error("Block does not belong to Snapshot index");
  const limits = normalizeOptions(options);
  const text = snapshot.logical_text.slice(block.logical_start, block.logical_end);
  let boundaries: readonly number[];
  let kind: MarkdownBlockSubdivisionKind;
  if (block.kind === "paragraph" && text.length > limits.paragraphMaxCharacters) {
    boundaries = characterBoundaries(text, limits.paragraphMaxCharacters, true);
    kind = "paragraph-segment";
  } else if ((block.kind === "code" || block.kind === "mermaid")
    && (text.length > limits.codeMaxCharacters || lineCount(text) > limits.codeMaxLines)) {
    boundaries = boundedLineBoundaries(text, limits.codeMaxCharacters, limits.codeMaxLines);
    kind = lineCount(text) > 1 ? "code-lines" : "code-segment";
  } else if (block.kind === "table"
    && (text.length > limits.tableMaxCharacters || lineCount(text) > limits.tableMaxRows)) {
    boundaries = boundedLineBoundaries(text, limits.tableMaxCharacters, limits.tableMaxRows);
    kind = "table-rows";
  } else {
    return Object.freeze([wholeUnit(block)]);
  }
  const localStarts = [0, ...boundaries.slice(0, -1)];
  const lines = lineStartOffsets(text);
  const tableHeaderEnd = block.kind === "table" ? firstLineEnd(text) : null;
  const sourceBoundary = createSourceBoundaryMapper(block);
  return Object.freeze(boundaries.map((localEnd, index) => {
    const localStart = localStarts[index];
    const logicalStart = block.logical_start + localStart;
    const logicalEnd = block.logical_start + localEnd;
    return Object.freeze({
      id: `${block.id}:unit:${index + 1}`,
      blockId: block.id,
      index,
      kind,
      sourceStart: sourceBoundary(logicalStart),
      sourceEnd: sourceBoundary(logicalEnd),
      logicalStart,
      logicalEnd,
      lineStart: lineIndex(lines, localStart),
      lineEnd: lineIndex(lines, localEnd),
      rowStart: kind === "table-rows" ? lineIndex(lines, localStart) : null,
      rowEnd: kind === "table-rows" ? lineIndex(lines, localEnd) : null,
      continuationBefore: index > 0,
      continuationAfter: index < boundaries.length - 1,
      tableHeaderLogicalStart: tableHeaderEnd === null || index === 0 ? null : block.logical_start,
      tableHeaderLogicalEnd: tableHeaderEnd === null || index === 0 ? null : block.logical_start + tableHeaderEnd,
    });
  }));
}

export function subdivideMarkdownSnapshot(
  snapshot: MarkdownSnapshot,
  options: MarkdownBlockSubdivisionOptions = {},
): ReadonlyMap<string, readonly MarkdownBlockRenderUnit[]> {
  return new Map(snapshot.blocks.map((block) => [block.id, subdivideMarkdownBlock(snapshot, block, options)]));
}

export function subdivisionSelectionSegments(
  units: readonly MarkdownBlockRenderUnit[],
  logicalStart: number,
  logicalEnd: number,
): readonly MarkdownSubdivisionSelectionSegment[] {
  if (!Number.isSafeInteger(logicalStart) || !Number.isSafeInteger(logicalEnd)
    || logicalStart < 0 || logicalEnd < logicalStart) {
    throw new Error("Selection logical range is invalid");
  }
  return Object.freeze(units.flatMap((unit) => {
    const start = Math.max(logicalStart, unit.logicalStart);
    const end = Math.min(logicalEnd, unit.logicalEnd);
    if (end <= start) return [];
    return [Object.freeze({
      unitId: unit.id,
      logicalStart: start,
      logicalEnd: end,
      sourceStart: interpolateRange(
        start,
        unit.logicalStart,
        unit.logicalEnd,
        unit.sourceStart,
        unit.sourceEnd,
      ),
      sourceEnd: interpolateRange(
        end,
        unit.logicalStart,
        unit.logicalEnd,
        unit.sourceStart,
        unit.sourceEnd,
      ),
    })];
  }));
}

function wholeUnit(block: MarkdownSnapshotBlock): MarkdownBlockRenderUnit {
  return Object.freeze({
    id: `${block.id}:whole`,
    blockId: block.id,
    index: 0,
    kind: "whole",
    sourceStart: block.source_start,
    sourceEnd: block.source_end,
    logicalStart: block.logical_start,
    logicalEnd: block.logical_end,
    lineStart: 0,
    lineEnd: Math.max(1, block.line_end - block.line_start),
    rowStart: null,
    rowEnd: null,
    continuationBefore: false,
    continuationAfter: false,
    tableHeaderLogicalStart: null,
    tableHeaderLogicalEnd: null,
  });
}

function characterBoundaries(text: string, maxCharacters: number, preferWordBoundary: boolean): number[] {
  const boundaries: number[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= maxCharacters) {
      boundaries.push(text.length);
      break;
    }
    const target = start + maxCharacters;
    let boundary = target;
    if (preferWordBoundary) {
      const minimum = Math.max(start + 1, target - Math.min(2048, Math.floor(maxCharacters / 4)));
      for (let index = target; index >= minimum; index -= 1) {
        if (/\s/u.test(text[index - 1] ?? "")) {
          boundary = index;
          break;
        }
      }
    }
    boundary = safeGraphemeBoundary(text, boundary, start);
    if (boundary <= start) boundary = safeCodePointBoundary(text, target, start);
    boundaries.push(boundary);
    start = boundary;
  }
  return boundaries;
}

function boundedLineBoundaries(text: string, maxCharacters: number, maxLines: number): number[] {
  const lineEnds = lineEndOffsets(text);
  if (lineEnds.length <= 1 && text.length > maxCharacters) return characterBoundaries(text, maxCharacters, false);
  const boundaries: number[] = [];
  let start = 0;
  let firstLine = 0;
  while (start < text.length) {
    const maxEnd = Math.min(text.length, start + maxCharacters);
    const lastLine = Math.min(lineEnds.length - 1, firstLine + maxLines - 1);
    let boundary = start;
    for (let index = firstLine; index <= lastLine && lineEnds[index] <= maxEnd; index += 1) {
      boundary = lineEnds[index];
    }
    if (boundary <= start) boundary = safeGraphemeBoundary(text, maxEnd, start);
    if (boundary <= start) boundary = safeCodePointBoundary(text, maxEnd, start);
    boundaries.push(boundary);
    start = boundary;
    while (firstLine < lineEnds.length && lineEnds[firstLine] <= start) firstLine += 1;
  }
  return boundaries;
}

function createSourceBoundaryMapper(block: MarkdownSnapshotBlock): (logicalOffset: number) => number {
  const anchors: Array<{ logical: number; source: number }> = [
    { logical: block.logical_start, source: block.source_start },
  ];
  for (const span of block.inline_spans) {
    anchors.push(
      { logical: span.logical_start, source: span.source_start },
      { logical: span.logical_end, source: span.source_end },
    );
  }
  anchors.push({ logical: block.logical_end, source: block.source_end });
  anchors.sort((left, right) => left.logical - right.logical || left.source - right.source);
  return (logicalOffset: number) => {
    if (logicalOffset <= block.logical_start) return block.source_start;
    if (logicalOffset >= block.logical_end) return block.source_end;
    let low = 1;
    let high = anchors.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (anchors[middle].logical < logicalOffset) low = middle + 1;
      else high = middle;
    }
    const previous = anchors[Math.max(0, low - 1)];
    const next = anchors[low];
    return interpolateRange(logicalOffset, previous.logical, next.logical, previous.source, next.source);
  };
}

function interpolateRange(
  value: number,
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number,
): number {
  if (inputEnd <= inputStart) return outputStart;
  const ratio = (value - inputStart) / (inputEnd - inputStart);
  return Math.round(outputStart + Math.max(0, Math.min(1, ratio)) * (outputEnd - outputStart));
}

function safeGraphemeBoundary(text: string, target: number, minimum: number): number {
  if (typeof Intl.Segmenter !== "function") return safeCodePointBoundary(text, target, minimum);
  const windowStart = Math.max(minimum, target - 256);
  const windowEnd = Math.min(text.length, target + 256);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let boundary = windowStart;
  for (const segment of segmenter.segment(text.slice(windowStart, windowEnd))) {
    const candidate = windowStart + segment.index;
    if (candidate > target) break;
    if (candidate > minimum) boundary = candidate;
  }
  return boundary > minimum ? boundary : safeCodePointBoundary(text, target, minimum);
}

function safeCodePointBoundary(text: string, target: number, minimum: number): number {
  let boundary = Math.max(minimum + 1, Math.min(target, text.length));
  const code = text.charCodeAt(boundary);
  if (code >= 0xdc00 && code <= 0xdfff) boundary -= 1;
  return Math.max(minimum + 1, boundary);
}

function lineStartOffsets(value: string): number[] {
  const offsets = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function lineEndOffsets(value: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") offsets.push(index + 1);
  }
  if (offsets.at(-1) !== value.length) offsets.push(value.length);
  return offsets;
}

function lineIndex(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(offsets.length, low);
}

function lineCount(value: string): number {
  return lineStartOffsets(value).length;
}

function firstLineEnd(value: string): number {
  const newline = value.indexOf("\n");
  return newline < 0 ? value.length : newline + 1;
}

function normalizeOptions(options: MarkdownBlockSubdivisionOptions): NormalizedMarkdownBlockSubdivisionOptions {
  const values = { ...DEFAULTS, ...options };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return values;
}
