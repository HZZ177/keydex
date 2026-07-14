import {
  assertUtf16Offset,
  assertUtf16Range,
  freezeRange,
  type BlockRangeProjection,
  type DocumentBlock,
  type DocumentContext,
  type DocumentSelection,
  type DocumentTextModel,
  type LogicalRange,
  type SelectionProjection,
  type SourceRange,
  type ViewProjection,
} from "./DocumentTextModel";
import {
  serializeMarkdownLogicalText,
  type MarkdownLogicalSourceDocument,
  type MarkdownLogicalDocument,
  type MarkdownLogicalSegment,
} from "./markdownLogicalText";
import { markdownPreviewContentHash } from "@/renderer/markdownShared/identity";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

export class MarkdownTextModel implements DocumentTextModel {
  readonly kind = "markdown" as const;
  readonly rawSource: string;
  readonly logicalText: string;
  readonly revision: Readonly<{ documentRevision: string; textRevision: string }>;
  readonly markdownSnapshotRevision: string | null;

  private readonly snapshot: MarkdownSnapshot | null;
  private serialized: MarkdownLogicalDocument | null;
  private projectedBlocks: readonly DocumentBlock[] | null = null;

  constructor(
    rawSource: string,
    documentRevision: string,
    sourceDocument: MarkdownLogicalSourceDocument | MarkdownLogicalDocument,
  ) {
    if (!documentRevision.trim()) {
      throw new Error("MarkdownTextModel requires a document revision");
    }
    const snapshot = isMarkdownSnapshot(sourceDocument) ? sourceDocument : null;
    const serialized = snapshot
      ? null
      : isLogicalDocument(sourceDocument)
        ? sourceDocument
        : serializeMarkdownLogicalText(rawSource, sourceDocument);
    this.snapshot = snapshot;
    this.serialized = serialized;
    this.rawSource = rawSource;
    this.logicalText = snapshot?.logical_text ?? serialized!.logicalText;
    this.markdownSnapshotRevision = snapshot?.revision ?? null;
    this.revision = Object.freeze({
      documentRevision,
      textRevision: serialized?.textRevision
        ?? `md-logical:${markdownPreviewContentHash(this.logicalText)}`,
    });
  }

  get blocks(): readonly DocumentBlock[] {
    if (this.projectedBlocks) {
      return this.projectedBlocks;
    }
    const serialized = this.logicalDocument();
    const sourceRangesByBlock = sourceRangesByBlockKey(serialized);
    this.projectedBlocks = Object.freeze(serialized.blocks.map((block) => Object.freeze({
      key: block.key,
      logicalRange: freezeRange({ start: block.logicalStart, end: block.logicalEnd }),
      sourceRanges: sourceRangesByBlock.get(block.key) ?? Object.freeze([]),
      context: block.context,
    })));
    return this.projectedBlocks;
  }

  get segments(): readonly MarkdownLogicalSegment[] {
    return this.logicalDocument().segments;
  }

  logicalDocument(): MarkdownLogicalDocument {
    if (!this.serialized) {
      this.serialized = serializeMarkdownLogicalText(this.rawSource, this.snapshot!);
    }
    return this.serialized;
  }

  toSourceRanges(range: LogicalRange): readonly SourceRange[] {
    assertUtf16Range(range, this.logicalText.length, "logical range");
    if (range.end === range.start) {
      return Object.freeze([]);
    }
    const ranges: SourceRange[] = [];
    const segments = this.segments;
    const first = firstLogicalOverlap(segments, range.start);
    for (let index = first; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (segment.logicalStart >= range.end) break;
      if (segment.sourceStart === null || segment.sourceEnd === null) {
        continue;
      }
      const logicalStart = Math.max(range.start, segment.logicalStart);
      const logicalEnd = Math.min(range.end, segment.logicalEnd);
      if (logicalEnd <= logicalStart) {
        continue;
      }
      appendSourceRange(ranges, {
        start: segment.sourceStart + logicalStart - segment.logicalStart,
        end: segment.sourceStart + logicalEnd - segment.logicalStart,
      });
    }
    return Object.freeze(ranges.map(freezeRange));
  }

  toLogicalRange(range: SourceRange): LogicalRange | null {
    assertUtf16Range(range, this.rawSource.length, "source range");
    if (range.end === range.start) {
      return null;
    }
    let logicalStart: number | null = null;
    let logicalEnd: number | null = null;
    for (const segment of this.segments) {
      if (segment.sourceStart === null || segment.sourceEnd === null) {
        continue;
      }
      const sourceStart = Math.max(range.start, segment.sourceStart);
      const sourceEnd = Math.min(range.end, segment.sourceEnd);
      if (sourceEnd <= sourceStart) {
        continue;
      }
      const projectedStart = segment.logicalStart + sourceStart - segment.sourceStart;
      const projectedEnd = segment.logicalStart + sourceEnd - segment.sourceStart;
      logicalStart = logicalStart === null ? projectedStart : Math.min(logicalStart, projectedStart);
      logicalEnd = logicalEnd === null ? projectedEnd : Math.max(logicalEnd, projectedEnd);
    }
    return logicalStart === null || logicalEnd === null
      ? null
      : freezeRange({ start: logicalStart, end: logicalEnd });
  }

  blockAt(offset: number): DocumentBlock | null {
    assertUtf16Offset(offset, this.logicalText.length, "logical offset");
    const blocks = this.blocks;
    if (offset === this.logicalText.length) {
      return blocks.at(-1) ?? null;
    }
    const index = firstLogicalOverlap(blocks, offset);
    const candidate = blocks[index];
    if (!candidate) return null;
    return offset >= candidate.logicalRange.start && offset < candidate.logicalRange.end
      ? candidate
      : candidate.logicalRange.start > offset ? candidate : null;
  }

  contextAt(range: LogicalRange): DocumentContext {
    assertUtf16Range(range, this.logicalText.length, "logical range");
    const offset = range.start === this.logicalText.length && range.start > 0
      ? range.start - 1
      : range.start;
    return this.blockAt(offset)?.context
      ?? Object.freeze({ containerType: "markdown", headingPath: Object.freeze([]) });
  }

  projectSelection(selection: DocumentSelection): SelectionProjection | null {
    let logicalRange: LogicalRange | null;
    if (selection.coordinateSpace === "logical") {
      assertUtf16Range(selection.range, this.logicalText.length, "logical range");
      logicalRange = freezeRange(selection.range);
    } else if (selection.coordinateSpace === "source") {
      logicalRange = this.toLogicalRange(selection.range);
    } else {
      const block = this.blocks.find((candidate) => candidate.key === selection.blockKey);
      if (!block) {
        return null;
      }
      const blockLength = block.logicalRange.end - block.logicalRange.start;
      assertUtf16Range(selection.range, blockLength, "block range");
      logicalRange = freezeRange({
        start: block.logicalRange.start + selection.range.start,
        end: block.logicalRange.start + selection.range.end,
      });
    }
    return logicalRange ? this.projection(logicalRange) : null;
  }

  projectView(range: LogicalRange): ViewProjection {
    assertUtf16Range(range, this.logicalText.length, "logical range");
    return this.projection(freezeRange(range));
  }

  private projection(logicalRange: LogicalRange): ViewProjection {
    return Object.freeze({
      logicalRange,
      sourceRanges: this.toSourceRanges(logicalRange),
      blockRanges: this.toBlockRanges(logicalRange),
    });
  }

  private toBlockRanges(range: LogicalRange): readonly BlockRangeProjection[] {
    const projections: BlockRangeProjection[] = [];
    const blocks = this.blocks;
    const first = firstLogicalOverlap(blocks, range.start);
    for (let index = first; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.logicalRange.start >= range.end) break;
      const start = Math.max(range.start, block.logicalRange.start);
      const end = Math.min(range.end, block.logicalRange.end);
      if (end <= start) {
        continue;
      }
      projections.push(Object.freeze({
        blockKey: block.key,
        range: freezeRange({
          start: start - block.logicalRange.start,
          end: end - block.logicalRange.start,
        }),
      }));
    }
    return Object.freeze(projections);
  }

}

function firstLogicalOverlap<T extends {
  readonly logicalEnd?: number;
  readonly logicalRange?: LogicalRange;
}>(items: readonly T[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = items[middle]!;
    const end = item.logicalEnd ?? item.logicalRange!.end;
    if (end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createMarkdownTextModel(
  rawSource: string,
  documentRevision: string,
  sourceDocument: MarkdownLogicalSourceDocument,
): MarkdownTextModel {
  return new MarkdownTextModel(rawSource, documentRevision, sourceDocument);
}

export function createMarkdownTextModelFromProjection(
  rawSource: string,
  documentRevision: string,
  projection: MarkdownLogicalDocument,
): MarkdownTextModel {
  return new MarkdownTextModel(rawSource, documentRevision, projection);
}

function isLogicalDocument(
  value: MarkdownLogicalSourceDocument | MarkdownLogicalDocument,
): value is MarkdownLogicalDocument {
  return "logicalText" in value && "segments" in value && "textRevision" in value;
}

function isMarkdownSnapshot(
  value: MarkdownLogicalSourceDocument | MarkdownLogicalDocument,
): value is MarkdownSnapshot {
  return "schema_version" in value;
}

function appendSourceRange(ranges: SourceRange[], next: SourceRange): void {
  const previous = ranges.at(-1);
  if (previous && previous.end === next.start) {
    ranges[ranges.length - 1] = { start: previous.start, end: next.end };
    return;
  }
  ranges.push({ ...next });
}

function sourceRangesByBlockKey(
  serialized: MarkdownLogicalDocument,
): ReadonlyMap<string, readonly SourceRange[]> {
  const mutable = new Map<string, SourceRange[]>();
  for (const segment of serialized.segments) {
    if (segment.sourceStart === null || segment.sourceEnd === null) continue;
    const ranges = mutable.get(segment.blockKey) ?? [];
    appendSourceRange(ranges, { start: segment.sourceStart, end: segment.sourceEnd });
    mutable.set(segment.blockKey, ranges);
  }
  return new Map([...mutable].map(([key, ranges]) => [key, Object.freeze(ranges.map(freezeRange))]));
}
