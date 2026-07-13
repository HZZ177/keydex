import {
  MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
  createMarkdownSnapshot,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
  type MarkdownSnapshotIndexReferences,
  type MarkdownSnapshotOutlineEntry,
  type MarkdownSnapshotResource,
  type MarkdownSnapshotStreamState,
} from "../document/MarkdownSnapshot";

export interface MarkdownTailCollectionPatch<T> {
  readonly prefix_count: number;
  readonly delete_count: number;
  readonly items: readonly T[];
}

export interface MarkdownStreamTailPatch {
  readonly schema_version: typeof MARKDOWN_SNAPSHOT_SCHEMA_VERSION;
  readonly base_revision: string;
  readonly renderer_profile: "file-preview" | "conversation";
  readonly mode: "canonical" | "stream-tail";
  readonly source_bytes: number;
  readonly source_characters: number;
  readonly logical_prefix_characters: number;
  readonly logical_delete_characters: number;
  readonly logical_append: string;
  readonly line_count: number;
  readonly blocks: MarkdownTailCollectionPatch<MarkdownSnapshotBlock>;
  readonly outline: MarkdownTailCollectionPatch<MarkdownSnapshotOutlineEntry>;
  readonly resources: MarkdownTailCollectionPatch<MarkdownSnapshotResource>;
  readonly stream: MarkdownSnapshotStreamState;
  readonly indexes: MarkdownSnapshotIndexReferences;
  readonly estimated_bytes: number;
}

export interface CreateMarkdownStreamTailPatchOptions {
  /** Parser-proven prefix used by the plain-text append fast path. */
  readonly logicalPrefixCharacters?: number;
  /** Parser-proven append paired with logicalPrefixCharacters. */
  readonly logicalAppend?: string;
}

export function createMarkdownStreamTailPatch(
  previous: MarkdownSnapshot,
  next: MarkdownSnapshot,
  options: CreateMarkdownStreamTailPatchOptions = {},
): MarkdownStreamTailPatch {
  if (previous.surface !== next.surface
    || previous.document_id !== next.document_id
    || previous.renderer_profile !== next.renderer_profile) {
    throw new Error("Streaming Markdown patch identity does not match its base Snapshot");
  }
  const logicalPrefixCharacters = options.logicalPrefixCharacters === undefined
    ? commonStringPrefix(previous.logical_text, next.logical_text)
    : options.logicalPrefixCharacters;
  const logicalAppend = options.logicalAppend === undefined
    ? next.logical_text.slice(logicalPrefixCharacters)
    : options.logicalAppend;
  if (!Number.isSafeInteger(logicalPrefixCharacters)
    || logicalPrefixCharacters < 0
    || logicalPrefixCharacters > previous.logical_text.length
    || logicalPrefixCharacters > next.logical_text.length
    || logicalPrefixCharacters + logicalAppend.length !== next.logical_text.length) {
    throw new Error("Streaming Markdown logical patch prefix is invalid");
  }
  if (options.logicalPrefixCharacters === undefined
    && previous.logical_text.slice(0, logicalPrefixCharacters) !== next.logical_text.slice(0, logicalPrefixCharacters)) {
    throw new Error("Streaming Markdown logical patch prefix content is invalid");
  }
  return Object.freeze({
    schema_version: MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
    base_revision: previous.revision,
    renderer_profile: next.renderer_profile,
    mode: next.mode,
    source_bytes: next.source_bytes,
    source_characters: next.source_characters,
    logical_prefix_characters: logicalPrefixCharacters,
    logical_delete_characters: previous.logical_text.length - logicalPrefixCharacters,
    logical_append: logicalAppend,
    line_count: next.line_count,
    blocks: collectionPatch(previous.blocks, next.blocks, equalBlock),
    outline: collectionPatch(previous.outline, next.outline, equalOutline),
    resources: collectionPatch(previous.resources, next.resources, equalResource),
    stream: Object.freeze({ ...next.stream }),
    indexes: Object.freeze({ ...next.indexes }),
    estimated_bytes: next.estimated_bytes,
  });
}

export function applyMarkdownStreamTailPatch(
  previous: MarkdownSnapshot,
  revision: string,
  patch: MarkdownStreamTailPatch,
): MarkdownSnapshot {
  if (patch.schema_version !== MARKDOWN_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Streaming Markdown patch schema version mismatch");
  }
  if (previous.revision !== patch.base_revision) {
    throw new Error(`Streaming Markdown patch requires base ${patch.base_revision}, received ${previous.revision}`);
  }
  const logicalPrefixEnd = patch.logical_prefix_characters;
  const logicalDeleteEnd = logicalPrefixEnd + patch.logical_delete_characters;
  if (logicalPrefixEnd > previous.logical_text.length || logicalDeleteEnd !== previous.logical_text.length) {
    throw new Error("Streaming Markdown patch logical range does not match its base Snapshot");
  }
  return createMarkdownSnapshot({
    surface: previous.surface,
    document_id: previous.document_id,
    revision,
    renderer_profile: patch.renderer_profile,
    mode: patch.mode,
    source_bytes: patch.source_bytes,
    source_characters: patch.source_characters,
    logical_text: previous.logical_text.slice(0, logicalPrefixEnd) + patch.logical_append,
    line_count: patch.line_count,
    blocks: applyCollectionPatch(previous.blocks, patch.blocks, "blocks"),
    outline: applyCollectionPatch(previous.outline, patch.outline, "outline"),
    resources: applyCollectionPatch(previous.resources, patch.resources, "resources"),
    stream: patch.stream,
    indexes: patch.indexes,
  });
}

function collectionPatch<T>(
  previous: readonly T[],
  next: readonly T[],
  equal: (left: T, right: T) => boolean,
): MarkdownTailCollectionPatch<T> {
  let prefixCount = 0;
  const limit = Math.min(previous.length, next.length);
  while (prefixCount < limit && equal(previous[prefixCount], next[prefixCount])) prefixCount += 1;
  return Object.freeze({
    prefix_count: prefixCount,
    delete_count: previous.length - prefixCount,
    items: Object.freeze(next.slice(prefixCount)),
  });
}

function applyCollectionPatch<T>(
  previous: readonly T[],
  patch: MarkdownTailCollectionPatch<T>,
  label: string,
): readonly T[] {
  if (!Number.isSafeInteger(patch.prefix_count)
    || !Number.isSafeInteger(patch.delete_count)
    || patch.prefix_count < 0
    || patch.delete_count < 0
    || patch.prefix_count + patch.delete_count !== previous.length) {
    throw new Error(`Streaming Markdown ${label} patch range does not match its base Snapshot`);
  }
  return [...previous.slice(0, patch.prefix_count), ...patch.items];
}

function commonStringPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  if (index > 0
    && index < left.length
    && index < right.length
    && isHighSurrogate(left.charCodeAt(index - 1))) index -= 1;
  return index;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function equalBlock(left: MarkdownSnapshotBlock, right: MarkdownSnapshotBlock): boolean {
  return left.id === right.id
    && left.content_hash === right.content_hash
    && left.index === right.index
    && left.source_start === right.source_start
    && left.source_end === right.source_end
    && left.logical_start === right.logical_start
    && left.logical_end === right.logical_end
    && left.line_start === right.line_start
    && left.line_end === right.line_end;
}

function equalOutline(left: MarkdownSnapshotOutlineEntry, right: MarkdownSnapshotOutlineEntry): boolean {
  return left.id === right.id
    && left.block_id === right.block_id
    && left.level === right.level
    && left.title === right.title
    && left.source_line === right.source_line;
}

function equalResource(left: MarkdownSnapshotResource, right: MarkdownSnapshotResource): boolean {
  return left.id === right.id
    && left.block_id === right.block_id
    && left.content_hash === right.content_hash
    && left.source_start === right.source_start
    && left.source_end === right.source_end
    && left.logical_start === right.logical_start
    && left.logical_end === right.logical_end;
}
