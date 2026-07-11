/**
 * Every offset in this module is a JavaScript string offset measured in UTF-16
 * code units. No line/column, byte, Unicode code point, DOM, or editor offsets
 * may cross this boundary without an explicit projection.
 */
export interface Utf16Range {
  readonly start: number;
  readonly end: number;
}

export type LogicalRange = Utf16Range;
export type SourceRange = Utf16Range;
export type BlockLocalRange = Utf16Range;

export interface DocumentTextRevision {
  readonly documentRevision: string;
  readonly textRevision: string;
}

export interface DocumentContext {
  readonly containerType: string;
  readonly headingPath: readonly string[];
}

export interface DocumentBlock {
  readonly key: string;
  readonly logicalRange: LogicalRange;
  readonly sourceRanges: readonly SourceRange[];
  readonly context: DocumentContext;
}

export interface BlockRangeProjection {
  readonly blockKey: string;
  readonly range: BlockLocalRange;
}

export type DocumentSelection =
  | { readonly coordinateSpace: "logical"; readonly range: LogicalRange }
  | { readonly coordinateSpace: "source"; readonly range: SourceRange }
  | {
      readonly coordinateSpace: "block";
      readonly blockKey: string;
      readonly range: BlockLocalRange;
    };

export interface SelectionProjection {
  readonly logicalRange: LogicalRange;
  readonly sourceRanges: readonly SourceRange[];
  readonly blockRanges: readonly BlockRangeProjection[];
}

export interface ViewProjection {
  readonly logicalRange: LogicalRange;
  readonly sourceRanges: readonly SourceRange[];
  readonly blockRanges: readonly BlockRangeProjection[];
}

export interface DocumentTextModel {
  readonly kind: "plain-text" | "markdown";
  readonly rawSource: string;
  readonly logicalText: string;
  readonly revision: DocumentTextRevision;
  readonly blocks: readonly DocumentBlock[];

  toSourceRanges(range: LogicalRange): readonly SourceRange[];
  toLogicalRange(range: SourceRange): LogicalRange | null;
  blockAt(offset: number): DocumentBlock | null;
  contextAt(range: LogicalRange): DocumentContext;
  projectSelection(selection: DocumentSelection): SelectionProjection | null;
  projectView(range: LogicalRange): ViewProjection;
}

export function assertUtf16Offset(offset: number, length: number, label = "offset"): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new RangeError(`${label} must be a safe UTF-16 offset between 0 and ${length}`);
  }
}

export function assertUtf16Range(
  range: Utf16Range,
  length: number,
  label = "range",
): void {
  assertUtf16Offset(range.start, length, `${label}.start`);
  assertUtf16Offset(range.end, length, `${label}.end`);
  if (range.end < range.start) {
    throw new RangeError(`${label}.end must be greater than or equal to ${label}.start`);
  }
}

export function freezeRange<T extends Utf16Range>(range: T): Readonly<T> {
  return Object.freeze({ ...range });
}

export function freezeContext(context: DocumentContext): DocumentContext {
  return Object.freeze({
    containerType: context.containerType,
    headingPath: Object.freeze([...context.headingPath]),
  });
}
