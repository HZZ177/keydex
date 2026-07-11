import {
  assertUtf16Offset,
  assertUtf16Range,
  freezeContext,
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

const SOURCE_CONTEXT = freezeContext({ containerType: "source", headingPath: [] });

export class PlainTextModel implements DocumentTextModel {
  readonly kind = "plain-text" as const;
  readonly rawSource: string;
  readonly logicalText: string;
  readonly revision: Readonly<{ documentRevision: string; textRevision: string }>;
  readonly blocks: readonly DocumentBlock[];

  constructor(rawSource: string, documentRevision: string) {
    if (!documentRevision.trim()) {
      throw new Error("PlainTextModel requires a document revision");
    }
    this.rawSource = rawSource;
    this.logicalText = rawSource;
    this.revision = Object.freeze({
      documentRevision,
      textRevision: documentRevision,
    });
    this.blocks = rawSource.length === 0
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            key: "source",
            logicalRange: freezeRange({ start: 0, end: rawSource.length }),
            sourceRanges: Object.freeze([freezeRange({ start: 0, end: rawSource.length })]),
            context: SOURCE_CONTEXT,
          }),
        ]);
    Object.freeze(this);
  }

  toSourceRanges(range: LogicalRange): readonly SourceRange[] {
    this.assertRange(range, "logical range");
    return Object.freeze([freezeRange(range)]);
  }

  toLogicalRange(range: SourceRange): LogicalRange {
    this.assertRange(range, "source range");
    return freezeRange(range);
  }

  blockAt(offset: number): DocumentBlock | null {
    assertUtf16Offset(offset, this.logicalText.length, "logical offset");
    return this.blocks[0] ?? null;
  }

  contextAt(range: LogicalRange): DocumentContext {
    this.assertRange(range, "logical range");
    return SOURCE_CONTEXT;
  }

  projectSelection(selection: DocumentSelection): SelectionProjection | null {
    let logicalRange: LogicalRange;
    if (selection.coordinateSpace === "block") {
      const block = this.blocks[0];
      if (!block || selection.blockKey !== block.key) {
        return null;
      }
      assertUtf16Range(selection.range, this.logicalText.length, "block range");
      logicalRange = freezeRange(selection.range);
    } else {
      this.assertRange(selection.range, `${selection.coordinateSpace} range`);
      logicalRange = freezeRange(selection.range);
    }
    return this.projection(logicalRange);
  }

  projectView(range: LogicalRange): ViewProjection {
    this.assertRange(range, "logical range");
    return this.projection(freezeRange(range));
  }

  private projection(logicalRange: LogicalRange): ViewProjection {
    const blockRanges: readonly BlockRangeProjection[] = this.blocks.length === 0
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({ blockKey: "source", range: freezeRange(logicalRange) }),
        ]);
    return Object.freeze({
      logicalRange,
      sourceRanges: Object.freeze([freezeRange(logicalRange)]),
      blockRanges,
    });
  }

  private assertRange(range: LogicalRange | SourceRange, label: string): void {
    assertUtf16Range(range, this.logicalText.length, label);
  }
}

export function createPlainTextModel(
  rawSource: string,
  documentRevision: string,
): PlainTextModel {
  return new PlainTextModel(rawSource, documentRevision);
}
