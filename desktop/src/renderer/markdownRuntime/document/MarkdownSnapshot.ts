export const MARKDOWN_SNAPSHOT_SCHEMA_VERSION = "markdown-snapshot/v1";

export type MarkdownSnapshotSurface = "file" | "message";
export type MarkdownSnapshotRendererProfile = "file-preview" | "conversation";
export type MarkdownSnapshotBlockKind =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "list"
  | "code"
  | "mermaid"
  | "table"
  | "image"
  | "math"
  | "html"
  | "thematic-break"
  | "frontmatter"
  | "unknown";
export type MarkdownSnapshotInlineKind =
  | "text"
  | "emphasis"
  | "strong"
  | "strikethrough"
  | "code"
  | "link"
  | "image"
  | "math"
  | "softbreak"
  | "hardbreak"
  | "html";
export type MarkdownSnapshotResourceKind = "image" | "mermaid" | "math" | "html" | "link";

export interface MarkdownSnapshotRange {
  readonly source_start: number;
  readonly source_end: number;
  readonly logical_start: number;
  readonly logical_end: number;
}

export interface MarkdownSnapshotInlineSpan extends MarkdownSnapshotRange {
  readonly id: string;
  readonly kind: MarkdownSnapshotInlineKind;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MarkdownSnapshotBlockMetadata {
  readonly heading_level?: 1 | 2 | 3 | 4 | 5 | 6;
  readonly language?: string;
  readonly fence_markup?: string;
  readonly fence_closed?: boolean;
  readonly list?: {
    readonly ordered: boolean;
    readonly start: number | null;
    readonly tight: boolean;
    readonly item_count: number;
    readonly items?: readonly {
      readonly depth: number;
      readonly ordered: boolean;
      readonly ordinal: number | null;
      readonly checked: boolean | null;
      readonly logical_start: number;
      readonly logical_end: number;
    }[];
  };
  readonly table?: {
    readonly columns: number;
    readonly alignments: readonly ("left" | "center" | "right" | null)[];
  };
  readonly task?: { readonly checked: boolean | null };
  readonly html_policy?: "escaped" | "sanitized";
  readonly frontmatter_language?: string;
}

export interface MarkdownSnapshotBlock extends MarkdownSnapshotRange {
  readonly id: string;
  readonly identity_key: string;
  readonly content_hash: string;
  readonly index: number;
  readonly kind: MarkdownSnapshotBlockKind;
  readonly parent_id: string | null;
  readonly depth: number;
  readonly line_start: number;
  readonly line_end: number;
  readonly inline_spans: readonly MarkdownSnapshotInlineSpan[];
  readonly metadata: MarkdownSnapshotBlockMetadata;
}

export interface MarkdownSnapshotResource extends MarkdownSnapshotRange {
  readonly id: string;
  readonly block_id: string;
  readonly kind: MarkdownSnapshotResourceKind;
  readonly cache_key: string;
  readonly url: string | null;
  readonly alt: string | null;
  readonly content_hash: string;
}

export interface MarkdownSnapshotOutlineEntry {
  readonly id: string;
  readonly block_id: string;
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly title: string;
  readonly source_line: number;
}

export type MarkdownSnapshotStreamState =
  | { readonly kind: "canonical"; readonly finalized: true }
  | {
      readonly kind: "streaming";
      readonly epoch: number;
      readonly prefix_revision: string;
      readonly prefix_block_count: number;
      readonly tail_block_start: number;
      readonly tail_source_start: number;
      readonly tail_complete: boolean;
    };

export interface MarkdownSnapshotIndexReferences {
  readonly line_map_revision: string;
  readonly logical_projection_revision: string;
  readonly source_index_revision: string;
  readonly find_index_revision: string | null;
  readonly annotation_index_revision: string | null;
}

export interface MarkdownSnapshot {
  readonly schema_version: typeof MARKDOWN_SNAPSHOT_SCHEMA_VERSION;
  readonly surface: MarkdownSnapshotSurface;
  readonly document_id: string;
  readonly revision: string;
  readonly renderer_profile: MarkdownSnapshotRendererProfile;
  readonly mode: "canonical" | "stream-tail";
  readonly source_bytes: number;
  readonly source_characters: number;
  readonly logical_text: string;
  readonly line_count: number;
  readonly blocks: readonly MarkdownSnapshotBlock[];
  readonly outline: readonly MarkdownSnapshotOutlineEntry[];
  readonly resources: readonly MarkdownSnapshotResource[];
  readonly stream: MarkdownSnapshotStreamState;
  readonly indexes: MarkdownSnapshotIndexReferences;
  readonly estimated_bytes: number;
}

export type MarkdownSnapshotInput = Omit<
  MarkdownSnapshot,
  "schema_version" | "estimated_bytes"
>;

export class MarkdownSnapshotContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownSnapshotContractError";
  }
}

const validatedMarkdownSnapshotIdentities = new WeakSet<object>();

export function createMarkdownSnapshot(input: MarkdownSnapshotInput): MarkdownSnapshot {
  const snapshot = {
    ...input,
    schema_version: MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
    blocks: input.blocks.map(cloneBlock),
    outline: input.outline.map((entry) => ({ ...entry })),
    resources: input.resources.map((resource) => ({ ...resource })),
    stream: { ...input.stream },
    indexes: { ...input.indexes },
    estimated_bytes: 0,
  } satisfies MarkdownSnapshot;
  assertValidMarkdownSnapshot(snapshot);
  snapshot.estimated_bytes = estimateMarkdownSnapshotBytes(snapshot);
  const frozen = deepFreeze(snapshot);
  validatedMarkdownSnapshotIdentities.add(frozen);
  return frozen;
}

/**
 * Builds a Snapshot from already immutable parser-owned parts. Streaming uses
 * this path so a frozen stable prefix is structurally shared instead of deep
 * cloned on every append. The full contract is still validated before publish.
 */
export function createMarkdownSnapshotFromImmutableParts(input: MarkdownSnapshotInput): MarkdownSnapshot {
  const snapshot = {
    ...input,
    schema_version: MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
    blocks: Object.freeze([...input.blocks]),
    outline: Object.freeze([...input.outline]),
    resources: Object.freeze([...input.resources]),
    stream: Object.freeze({ ...input.stream }),
    indexes: Object.freeze({ ...input.indexes }),
    estimated_bytes: 0,
  } satisfies MarkdownSnapshot;
  assertValidMarkdownSnapshot(snapshot);
  snapshot.estimated_bytes = estimateMarkdownSnapshotBytes(snapshot);
  const frozen = deepFreeze(snapshot);
  validatedMarkdownSnapshotIdentities.add(frozen);
  return frozen;
}

export function assertValidMarkdownSnapshot(value: unknown): asserts value is MarkdownSnapshot {
  assertRecord(value, "snapshot");
  if (value.schema_version !== MARKDOWN_SNAPSHOT_SCHEMA_VERSION) fail("snapshot schema version mismatch");
  if (value.surface !== "file" && value.surface !== "message") fail("snapshot surface is invalid");
  nonEmpty(value.document_id, "document_id");
  nonEmpty(value.revision, "revision");
  if (value.renderer_profile !== "file-preview" && value.renderer_profile !== "conversation") {
    fail("renderer_profile is invalid");
  }
  if (value.mode !== "canonical" && value.mode !== "stream-tail") fail("snapshot mode is invalid");
  if (typeof value.logical_text !== "string") fail("snapshot logical text must be a string");
  integer(value.source_bytes, "source_bytes");
  integer(value.source_characters, "source_characters");
  integer(value.line_count, "line_count");
  if (!Array.isArray(value.blocks) || !Array.isArray(value.outline) || !Array.isArray(value.resources)) {
    fail("snapshot collections must be arrays");
  }
  const sourceCharacters = value.source_characters as number;
  const logicalText = value.logical_text as string;
  const lineCount = value.line_count as number;
  validateStream(value.stream, value.blocks.length, sourceCharacters, value.mode);
  validateIndexes(value.indexes);
  const blockIds = new Set<string>();
  let previousSourceEnd = 0;
  value.blocks.forEach((block, index) => {
    validateBlock(block, index, sourceCharacters, logicalText.length, lineCount);
    if (blockIds.has(block.id)) fail(`duplicate block id ${block.id}`);
    if (block.source_start < previousSourceEnd) fail(`block ${block.id} overlaps its predecessor`);
    blockIds.add(block.id);
    previousSourceEnd = block.source_end;
  });
  const outlineIds = new Set<string>();
  value.outline.forEach((entry) => {
    assertRecord(entry, "outline entry");
    nonEmpty(entry.id, "outline id");
    nonEmpty(entry.block_id, "outline block_id");
    nonEmpty(entry.title, "outline title");
    integer(entry.level, "outline level");
    integer(entry.source_line, "outline source_line");
    if (!blockIds.has(entry.block_id as string)) fail(`outline block ${String(entry.block_id)} is missing`);
    if (outlineIds.has(entry.id as string)) fail(`duplicate outline id ${String(entry.id)}`);
    outlineIds.add(entry.id as string);
  });
  const resourceIds = new Set<string>();
  value.resources.forEach((resource) => {
    validateResource(resource, blockIds, sourceCharacters, logicalText.length);
    if (resourceIds.has(resource.id as string)) fail(`duplicate resource id ${String(resource.id)}`);
    resourceIds.add(resource.id as string);
  });
  assertNoRendererState(value);
}

/**
 * Validates a Snapshot once per object identity for trusted runtime plumbing.
 * Public contract checks keep using assertValidMarkdownSnapshot so mutations
 * in tests or external callers can never be hidden by this internal cache.
 */
export function assertValidMarkdownSnapshotOnce(value: unknown): asserts value is MarkdownSnapshot {
  if (value !== null && typeof value === "object" && validatedMarkdownSnapshotIdentities.has(value)) return;
  assertValidMarkdownSnapshot(value);
  validatedMarkdownSnapshotIdentities.add(value as object);
}

export function estimateMarkdownSnapshotBytes(snapshot: Omit<MarkdownSnapshot, "estimated_bytes">): number {
  let total = 512;
  total += snapshot.logical_text.length * 2;
  total += stringBytes(snapshot.document_id, snapshot.revision, snapshot.renderer_profile);
  for (const block of snapshot.blocks) {
    total += 192 + stringBytes(block.id, block.identity_key, block.content_hash, block.kind);
    total += estimateObjectStrings(block.metadata);
    for (const span of block.inline_spans) {
      total += 112 + stringBytes(span.id, span.kind) + estimateObjectStrings(span.attributes);
    }
  }
  for (const entry of snapshot.outline) {
    total += 96 + stringBytes(entry.id, entry.block_id, entry.title);
  }
  for (const resource of snapshot.resources) {
    total += 144 + stringBytes(
      resource.id,
      resource.block_id,
      resource.kind,
      resource.cache_key,
      resource.url ?? "",
      resource.alt ?? "",
      resource.content_hash,
    );
  }
  total += estimateObjectStrings(snapshot.indexes) + estimateObjectStrings(snapshot.stream);
  return total;
}

export function cloneMarkdownSnapshot(snapshot: MarkdownSnapshot): MarkdownSnapshot {
  return createMarkdownSnapshot(structuredClone({
    ...snapshot,
    estimated_bytes: undefined,
    schema_version: undefined,
  }) as unknown as MarkdownSnapshotInput);
}

export function serializeMarkdownSnapshot(snapshot: MarkdownSnapshot): string {
  assertValidMarkdownSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

export function deserializeMarkdownSnapshot(serialized: string): MarkdownSnapshot {
  const parsed = JSON.parse(serialized) as MarkdownSnapshot;
  assertValidMarkdownSnapshot(parsed);
  return createMarkdownSnapshot({
    ...parsed,
    schema_version: undefined,
    estimated_bytes: undefined,
  } as unknown as MarkdownSnapshotInput);
}

function cloneBlock(block: MarkdownSnapshotBlock): MarkdownSnapshotBlock {
  const { list, table, task, ...metadata } = block.metadata;
  return {
    ...block,
    inline_spans: block.inline_spans.map((span) => ({
      ...span,
      attributes: { ...span.attributes },
    })),
    metadata: {
      ...metadata,
      ...(list ? {
        list: {
          ...list,
          ...(list.items ? { items: list.items.map((item) => ({ ...item })) } : {}),
        },
      } : {}),
      ...(table ? { table: { ...table, alignments: [...table.alignments] } } : {}),
      ...(task ? { task: { ...task } } : {}),
    },
  };
}

function validateBlock(
  value: unknown,
  expectedIndex: number,
  sourceLength: number,
  logicalLength: number,
  lineCount: number,
): void {
  assertRecord(value, "block");
  nonEmpty(value.id, "block id");
  nonEmpty(value.identity_key, "block identity_key");
  nonEmpty(value.content_hash, "block content_hash");
  if (!BLOCK_KINDS.has(String(value.kind))) fail(`unsupported block kind ${String(value.kind)}`);
  integer(value.index, "block index");
  if (value.index !== expectedIndex) fail(`block ${String(value.id)} index mismatch`);
  integer(value.depth, "block depth");
  integer(value.line_start, "block line_start");
  integer(value.line_end, "block line_end");
  if ((value.line_end as number) < (value.line_start as number) || (value.line_end as number) > lineCount) {
    fail(`block ${String(value.id)} line range is invalid`);
  }
  if (value.parent_id !== null && typeof value.parent_id !== "string") fail("block parent_id is invalid");
  validateRange(value, sourceLength, logicalLength, `block ${String(value.id)}`);
  if (!Array.isArray(value.inline_spans)) fail("block inline_spans must be an array");
  value.inline_spans.forEach((span) => validateInlineSpan(span, value, sourceLength, logicalLength));
  validateMetadata(value.metadata, value.kind as MarkdownSnapshotBlockKind);
}

function validateInlineSpan(
  value: unknown,
  block: Record<string, unknown>,
  sourceLength: number,
  logicalLength: number,
): void {
  assertRecord(value, "inline span");
  nonEmpty(value.id, "inline id");
  if (!INLINE_KINDS.has(String(value.kind))) fail(`unsupported inline kind ${String(value.kind)}`);
  validateRange(value, sourceLength, logicalLength, `inline ${String(value.id)}`);
  if ((value.source_start as number) < (block.source_start as number)
    || (value.source_end as number) > (block.source_end as number)) {
    fail(`inline ${String(value.id)} is outside its block`);
  }
  assertScalarRecord(value.attributes, "inline attributes");
}

function validateMetadata(value: unknown, kind: MarkdownSnapshotBlockKind): void {
  assertRecord(value, "block metadata");
  if (value.heading_level !== undefined) {
    integer(value.heading_level, "heading_level");
    if ((value.heading_level as number) < 1 || (value.heading_level as number) > 6) fail("heading_level is invalid");
  }
  if (kind === "heading" && value.heading_level === undefined) fail("heading block requires heading_level");
  if (value.list !== undefined) {
    assertRecord(value.list, "list metadata");
    if (typeof value.list.ordered !== "boolean" || typeof value.list.tight !== "boolean") fail("list flags are invalid");
    integer(value.list.item_count, "list item_count");
    if (value.list.items !== undefined) {
      if (!Array.isArray(value.list.items) || value.list.items.length !== value.list.item_count) {
        fail("list item metadata count mismatch");
      }
      value.list.items.forEach((item) => {
        assertRecord(item, "list item metadata");
        integer(item.depth, "list item depth");
        integer(item.logical_start, "list item logical_start");
        integer(item.logical_end, "list item logical_end");
        if (item.logical_end < item.logical_start) fail("list item logical range is invalid");
        if (typeof item.ordered !== "boolean") fail("list item ordered flag is invalid");
        if (item.ordinal !== null) integer(item.ordinal, "list item ordinal");
        if (item.checked !== null && typeof item.checked !== "boolean") fail("list item checked flag is invalid");
      });
    }
  }
  if (kind === "list" && value.list === undefined) fail("list block requires list metadata");
  if (value.table !== undefined) {
    assertRecord(value.table, "table metadata");
    integer(value.table.columns, "table columns");
    if (!Array.isArray(value.table.alignments) || value.table.alignments.length !== value.table.columns) {
      fail("table alignments mismatch");
    }
  }
  if (kind === "table" && value.table === undefined) fail("table block requires table metadata");
  assertNoRendererState(value);
}

function validateResource(
  value: unknown,
  blockIds: ReadonlySet<string>,
  sourceLength: number,
  logicalLength: number,
): void {
  assertRecord(value, "resource");
  nonEmpty(value.id, "resource id");
  nonEmpty(value.block_id, "resource block_id");
  nonEmpty(value.cache_key, "resource cache_key");
  nonEmpty(value.content_hash, "resource content_hash");
  if (!RESOURCE_KINDS.has(String(value.kind))) fail(`unsupported resource kind ${String(value.kind)}`);
  if (!blockIds.has(value.block_id as string)) fail(`resource block ${String(value.block_id)} is missing`);
  if (value.url !== null && typeof value.url !== "string") fail("resource url is invalid");
  if (value.alt !== null && typeof value.alt !== "string") fail("resource alt is invalid");
  validateRange(value, sourceLength, logicalLength, `resource ${String(value.id)}`);
}

function validateRange(
  value: Record<string, unknown>,
  sourceLength: number,
  logicalLength: number,
  label: string,
): void {
  for (const field of ["source_start", "source_end", "logical_start", "logical_end"] as const) {
    integer(value[field], `${label} ${field}`);
  }
  if ((value.source_end as number) < (value.source_start as number)
    || (value.source_end as number) > sourceLength) fail(`${label} source range is invalid`);
  if ((value.logical_end as number) < (value.logical_start as number)
    || (value.logical_end as number) > logicalLength) fail(`${label} logical range is invalid`);
}

function validateStream(
  value: unknown,
  blockCount: number,
  sourceLength: number,
  mode: unknown,
): void {
  assertRecord(value, "stream state");
  if (value.kind === "canonical") {
    if (value.finalized !== true || mode !== "canonical") fail("canonical stream state mismatch");
    return;
  }
  if (value.kind !== "streaming" || mode !== "stream-tail") fail("streaming state mismatch");
  nonEmpty(value.prefix_revision, "prefix_revision");
  for (const field of ["epoch", "prefix_block_count", "tail_block_start", "tail_source_start"] as const) {
    integer(value[field], field);
  }
  if ((value.prefix_block_count as number) > blockCount
    || (value.tail_block_start as number) > blockCount
    || (value.tail_source_start as number) > sourceLength) fail("streaming prefix/tail bounds are invalid");
  if (typeof value.tail_complete !== "boolean") fail("tail_complete must be boolean");
}

function validateIndexes(value: unknown): void {
  assertRecord(value, "index references");
  for (const field of ["line_map_revision", "logical_projection_revision", "source_index_revision"] as const) {
    nonEmpty(value[field], field);
  }
  for (const field of ["find_index_revision", "annotation_index_revision"] as const) {
    if (value[field] !== null && typeof value[field] !== "string") fail(`${field} must be string or null`);
  }
}

function assertNoRendererState(value: unknown, depth = 0): void {
  if (depth > 32) fail("snapshot nesting exceeds contract limit");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoRendererState(entry, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail(`snapshot must not contain renderer/parser field ${key}`);
    assertNoRendererState(entry, depth + 1);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function estimateObjectStrings(value: object): number {
  let total = 32;
  for (const [key, entry] of Object.entries(value)) {
    total += key.length * 2 + 16;
    if (typeof entry === "string") total += entry.length * 2;
    else if (Array.isArray(entry)) total += entry.length * 16 + entry.join("").length * 2;
    else if (entry && typeof entry === "object") total += estimateObjectStrings(entry);
    else total += 8;
  }
  return total;
}

function stringBytes(...values: string[]): number {
  return values.reduce((total, value) => total + value.length * 2 + 16, 0);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertScalarRecord(value: unknown, label: string): void {
  assertRecord(value, label);
  for (const entry of Object.values(value)) {
    if (entry !== null && !["string", "number", "boolean"].includes(typeof entry)) {
      fail(`${label} values must be scalar`);
    }
  }
}

function integer(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
}

function fail(message: string): never {
  throw new MarkdownSnapshotContractError(message);
}

const BLOCK_KINDS = new Set<string>([
  "paragraph", "heading", "blockquote", "list", "code", "mermaid", "table", "image",
  "math", "html", "thematic-break", "frontmatter", "unknown",
]);
const INLINE_KINDS = new Set<string>([
  "text", "emphasis", "strong", "strikethrough", "code", "link", "image", "math",
  "softbreak", "hardbreak", "html",
]);
const RESOURCE_KINDS = new Set<string>(["image", "mermaid", "math", "html", "link"]);
const FORBIDDEN_KEYS = new Set([
  "tokens",
  "token_tree",
  "parser",
  "parser_object",
  "dom",
  "element",
  "node",
  "glyph",
  "rect",
  "pixel",
  "display_command",
  "webgpu",
]);
