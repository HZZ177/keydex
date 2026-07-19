import { fingerprintDiffContent } from "../identity";

export const KEYDEX_ALIGNED_DIFF_MODEL_VERSION = "aligned-v1";

export type DiffPaneSide = "old" | "new";

export type DiffPaneRowKind =
  | "context"
  | "modified"
  | "added"
  | "removed"
  | "hunk_header"
  | "collapsed_gap"
  | "metadata"
  | "eof";

export type DiffAlignmentSegmentKind = "context" | "change" | "collapsed_gap";

export type DiffChangeKind = "added" | "removed" | "modified";

export interface DiffTokenText {
  readonly type: "text";
  readonly value: string;
}

export interface DiffTokenSpan {
  readonly type: "span";
  readonly classNames: readonly string[];
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children: readonly DiffTokenNode[];
}

export type DiffTokenNode = DiffTokenText | DiffTokenSpan;

export interface DiffPaneRow {
  readonly id: string;
  readonly fileId: string;
  readonly side: DiffPaneSide;
  readonly kind: DiffPaneRowKind;
  readonly lineNumber: number | null;
  readonly sourceIndex: number;
  readonly segmentId: string;
  readonly changeId: string | null;
  readonly hunkId: string | null;
  readonly text: string;
  readonly tokens: readonly DiffTokenNode[];
  readonly noTrailingNewline: boolean;
  readonly estimatedHeight: number;
}

export interface DiffSideRange {
  /** Half-open pane-row range. Empty ranges represent pure additions/deletions. */
  readonly startRow: number;
  readonly endRow: number;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export interface DiffAlignmentSegment {
  readonly id: string;
  readonly kind: DiffAlignmentSegmentKind;
  readonly left: DiffSideRange;
  readonly right: DiffSideRange;
  readonly hunkId: string | null;
  readonly changeId: string | null;
}

export interface DiffChangeBlock {
  readonly id: string;
  readonly segmentId: string;
  readonly kind: DiffChangeKind;
  readonly left: DiffSideRange;
  readonly right: DiffSideRange;
}

export interface DiffSemanticAnchor {
  readonly segmentId: string;
  readonly rowId: string | null;
  readonly rowFraction: number;
  readonly viewportFraction: number;
}

export interface DiffConnectorGeometry {
  readonly changeId: string;
  readonly kind: DiffChangeKind;
  readonly leftStart: number;
  readonly leftEnd: number;
  readonly rightStart: number;
  readonly rightEnd: number;
  readonly clippedTop: boolean;
  readonly clippedBottom: boolean;
}

export interface KeydexAlignedDiffModel {
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly sourceVersion: string;
  readonly modelVersion: typeof KEYDEX_ALIGNED_DIFF_MODEL_VERSION;
  readonly cacheKey: string;
  readonly partial: boolean;
  readonly leftRows: readonly DiffPaneRow[];
  readonly rightRows: readonly DiffPaneRow[];
  readonly segments: readonly DiffAlignmentSegment[];
  readonly changes: readonly DiffChangeBlock[];
}

export type KeydexAlignedDiffModelInput = Omit<
  KeydexAlignedDiffModel,
  "modelVersion" | "leftRows" | "rightRows" | "segments" | "changes"
> & {
  readonly leftRows: readonly DiffPaneRow[];
  readonly rightRows: readonly DiffPaneRow[];
  readonly segments: readonly DiffAlignmentSegment[];
  readonly changes: readonly DiffChangeBlock[];
};

export class KeydexAlignedDiffModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeydexAlignedDiffModelError";
  }
}

export function createAlignedDiffStableId(
  kind: "row" | "segment" | "change",
  fileCacheKey: string,
  ordinal: number,
  signature = "",
): string {
  if (!fileCacheKey.trim()) throw new KeydexAlignedDiffModelError("fileCacheKey is required");
  assertNonNegativeInteger(ordinal, "ordinal");
  const fingerprint = fingerprintDiffContent([
    KEYDEX_ALIGNED_DIFF_MODEL_VERSION,
    kind,
    fileCacheKey,
    String(ordinal),
    signature,
  ].join("\u0000"));
  return `aligned-${kind}:${fingerprint}`;
}

export function createKeydexAlignedDiffModel(
  input: KeydexAlignedDiffModelInput,
): KeydexAlignedDiffModel {
  const fileId = requiredText(input.fileId, "fileId");
  const fileCacheKey = requiredText(input.fileCacheKey, "fileCacheKey");
  const sourceVersion = requiredText(input.sourceVersion, "sourceVersion");
  const cacheKey = requiredText(input.cacheKey, "cacheKey");
  const leftRows = Object.freeze(input.leftRows.map((row) => freezeRow(row, fileId, "old")));
  const rightRows = Object.freeze(input.rightRows.map((row) => freezeRow(row, fileId, "new")));
  assertUnique([...leftRows, ...rightRows].map((row) => row.id), "duplicate row id");

  const segments = Object.freeze(input.segments.map((segment) => freezeSegment(segment)));
  assertUnique(segments.map((segment) => segment.id), "duplicate segment id");
  assertOrderedSegments(segments, leftRows.length, rightRows.length);

  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  for (const row of [...leftRows, ...rightRows]) {
    if (!segmentById.has(row.segmentId)) {
      throw new KeydexAlignedDiffModelError(`${row.id}: unknown segment ${row.segmentId}`);
    }
  }

  const changes = Object.freeze(input.changes.map((change) => freezeChange(change)));
  assertUnique(changes.map((change) => change.id), "duplicate change id");
  for (const change of changes) {
    const segment = segmentById.get(change.segmentId);
    if (!segment || segment.kind !== "change") {
      throw new KeydexAlignedDiffModelError(`${change.id}: change requires a change segment`);
    }
    if (!sameRange(change.left, segment.left) || !sameRange(change.right, segment.right)) {
      throw new KeydexAlignedDiffModelError(`${change.id}: change range must match its segment`);
    }
  }

  return Object.freeze({
    fileId,
    fileCacheKey,
    sourceVersion,
    modelVersion: KEYDEX_ALIGNED_DIFF_MODEL_VERSION,
    cacheKey,
    partial: input.partial,
    leftRows,
    rightRows,
    segments,
    changes,
  });
}

function freezeRow(row: DiffPaneRow, fileId: string, side: DiffPaneSide): DiffPaneRow {
  if (row.fileId !== fileId) throw new KeydexAlignedDiffModelError(`${row.id}: fileId mismatch`);
  if (row.side !== side) throw new KeydexAlignedDiffModelError(`${row.id}: pane side mismatch`);
  assertNonNegativeInteger(row.sourceIndex, `${row.id}.sourceIndex`);
  if (row.lineNumber !== null && (!Number.isInteger(row.lineNumber) || row.lineNumber <= 0)) {
    throw new KeydexAlignedDiffModelError(`${row.id}: lineNumber must be positive or null`);
  }
  if (!Number.isFinite(row.estimatedHeight) || row.estimatedHeight <= 0) {
    throw new KeydexAlignedDiffModelError(`${row.id}: estimatedHeight must be positive`);
  }
  return Object.freeze({
    ...row,
    id: requiredText(row.id, "row.id"),
    segmentId: requiredText(row.segmentId, `${row.id}.segmentId`),
    changeId: optionalText(row.changeId),
    hunkId: optionalText(row.hunkId),
    tokens: Object.freeze(row.tokens.map(freezeToken)),
  });
}

function freezeToken(token: DiffTokenNode): DiffTokenNode {
  if (token.type === "text") return Object.freeze({ type: "text", value: token.value });
  return Object.freeze({
    type: "span",
    classNames: Object.freeze(token.classNames.filter(Boolean)),
    ...(token.attributes ? { attributes: freezeTokenAttributes(token.attributes) } : {}),
    children: Object.freeze(token.children.map(freezeToken)),
  });
}

function freezeTokenAttributes(attributes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!/^(?:data|aria)-[a-z0-9_.:-]+$/u.test(name)) {
      throw new KeydexAlignedDiffModelError(`unsafe token attribute ${name}`);
    }
    safe[name] = String(value);
  }
  return Object.freeze(safe);
}

function freezeSegment(segment: DiffAlignmentSegment): DiffAlignmentSegment {
  return Object.freeze({
    ...segment,
    id: requiredText(segment.id, "segment.id"),
    left: freezeRange(segment.left, `${segment.id}.left`),
    right: freezeRange(segment.right, `${segment.id}.right`),
    hunkId: optionalText(segment.hunkId),
    changeId: optionalText(segment.changeId),
  });
}

function freezeChange(change: DiffChangeBlock): DiffChangeBlock {
  return Object.freeze({
    ...change,
    id: requiredText(change.id, "change.id"),
    segmentId: requiredText(change.segmentId, `${change.id}.segmentId`),
    left: freezeRange(change.left, `${change.id}.left`),
    right: freezeRange(change.right, `${change.id}.right`),
  });
}

function freezeRange(range: DiffSideRange, name: string): DiffSideRange {
  assertNonNegativeInteger(range.startRow, `${name}.startRow`);
  assertNonNegativeInteger(range.endRow, `${name}.endRow`);
  if (range.endRow < range.startRow) {
    throw new KeydexAlignedDiffModelError(`${name}: endRow must not precede startRow`);
  }
  for (const [part, value] of [["startLine", range.startLine], ["endLine", range.endLine]] as const) {
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      throw new KeydexAlignedDiffModelError(`${name}.${part} must be positive or null`);
    }
  }
  return Object.freeze({ ...range });
}

function assertOrderedSegments(
  segments: readonly DiffAlignmentSegment[],
  leftLength: number,
  rightLength: number,
): void {
  let leftEnd = 0;
  let rightEnd = 0;
  for (const segment of segments) {
    if (segment.left.startRow < leftEnd || segment.right.startRow < rightEnd) {
      throw new KeydexAlignedDiffModelError(`${segment.id}: segments must be ordered and non-overlapping`);
    }
    if (segment.left.endRow > leftLength || segment.right.endRow > rightLength) {
      throw new KeydexAlignedDiffModelError(`${segment.id}: segment range exceeds pane rows`);
    }
    leftEnd = segment.left.endRow;
    rightEnd = segment.right.endRow;
  }
}

function sameRange(left: DiffSideRange, right: DiffSideRange): boolean {
  return left.startRow === right.startRow
    && left.endRow === right.endRow
    && left.startLine === right.startLine
    && left.endLine === right.endLine;
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new KeydexAlignedDiffModelError(`${name} is required`);
  return normalized;
}

function optionalText(value: string | null): string | null {
  return value?.trim() || null;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new KeydexAlignedDiffModelError(`${name} must be a non-negative integer`);
  }
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) {
    throw new KeydexAlignedDiffModelError(message);
  }
}
