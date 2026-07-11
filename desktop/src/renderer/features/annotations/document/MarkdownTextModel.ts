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
  type MarkdownLogicalDocument,
  type MarkdownLogicalSegment,
} from "./markdownLogicalText";

export class MarkdownTextModel implements DocumentTextModel {
  readonly kind = "markdown" as const;
  readonly rawSource: string;
  readonly logicalText: string;
  readonly revision: Readonly<{ documentRevision: string; textRevision: string }>;
  readonly blocks: readonly DocumentBlock[];
  readonly segments: readonly MarkdownLogicalSegment[];

  constructor(rawSource: string, documentRevision: string) {
    if (!documentRevision.trim()) {
      throw new Error("MarkdownTextModel requires a document revision");
    }
    const serialized = serializeMarkdownLogicalText(rawSource);
    this.rawSource = rawSource;
    this.logicalText = serialized.logicalText;
    this.segments = serialized.segments;
    this.revision = Object.freeze({
      documentRevision,
      textRevision: serialized.textRevision,
    });
    this.blocks = Object.freeze(serialized.blocks.map((block) => Object.freeze({
      key: block.key,
      logicalRange: freezeRange({ start: block.logicalStart, end: block.logicalEnd }),
      sourceRanges: this.sourceRangesForSerializedBlock(serialized, block.key),
      context: block.context,
    })));
    Object.freeze(this);
  }

  toSourceRanges(range: LogicalRange): readonly SourceRange[] {
    assertUtf16Range(range, this.logicalText.length, "logical range");
    if (range.end === range.start) {
      return Object.freeze([]);
    }
    const ranges: SourceRange[] = [];
    for (const segment of this.segments) {
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
    const containing = this.blocks.find((block) =>
      offset >= block.logicalRange.start && offset < block.logicalRange.end);
    if (containing) {
      return containing;
    }
    if (offset === this.logicalText.length) {
      return this.blocks.at(-1) ?? null;
    }
    return this.blocks.find((block) => block.logicalRange.start > offset) ?? null;
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
    for (const block of this.blocks) {
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

  private sourceRangesForSerializedBlock(
    serialized: MarkdownLogicalDocument,
    blockKey: string,
  ): readonly SourceRange[] {
    const ranges: SourceRange[] = [];
    for (const segment of serialized.segments) {
      if (segment.blockKey !== blockKey || segment.sourceStart === null || segment.sourceEnd === null) {
        continue;
      }
      appendSourceRange(ranges, { start: segment.sourceStart, end: segment.sourceEnd });
    }
    return Object.freeze(ranges.map(freezeRange));
  }
}

export function createMarkdownTextModel(
  rawSource: string,
  documentRevision: string,
): MarkdownTextModel {
  return new MarkdownTextModel(rawSource, documentRevision);
}

function appendSourceRange(ranges: SourceRange[], next: SourceRange): void {
  const previous = ranges.at(-1);
  if (previous && previous.end === next.start) {
    ranges[ranges.length - 1] = { start: previous.start, end: next.end };
    return;
  }
  ranges.push({ ...next });
}
