import {
  createMarkdownSnapshot,
  createMarkdownSnapshotFromImmutableParts,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
  type MarkdownSnapshotBlockMetadata,
  type MarkdownSnapshotResource,
  type MarkdownSnapshotSurface,
} from "../document/MarkdownSnapshot";
import { stableMarkdownIdentityHash } from "../document/identity";
import { parseCanonicalMarkdownSnapshot } from "../worker/parser";

export interface StreamingTailParserOptions {
  readonly surface: MarkdownSnapshotSurface;
  readonly documentId: string;
  readonly rendererProfile: "file-preview" | "conversation";
  readonly initialSource?: string;
  readonly initialSnapshot?: MarkdownSnapshot | null;
  readonly initialEpoch?: number;
}

export interface StreamingTailParserUpdate {
  readonly source: string;
  readonly revision: string;
  readonly epoch: number;
  readonly final?: boolean;
  /** Trusted append decoded from the validated Worker request. */
  readonly append?: string;
}

export interface StreamingTailParserDiagnostics {
  readonly epoch: number;
  readonly revision: string;
  readonly canonical: boolean;
  readonly parsedSourceStart: number;
  readonly parsedCharacters: number;
  readonly sourceCharacters: number;
  readonly reusedPrefixBlocks: number;
  readonly tailBlocks: number;
  readonly stablePrefixCharacters: number;
}

export interface StreamingTailParserResult {
  readonly snapshot: MarkdownSnapshot;
  readonly diagnostics: StreamingTailParserDiagnostics;
  readonly logicalPrefixCharacters?: number;
  readonly logicalAppend?: string;
}

export class StreamingTailParserStaleEpochError extends Error {
  constructor(readonly expectedEpoch: number, readonly receivedEpoch: number) {
    super(`Stale streaming Markdown epoch ${receivedEpoch}; current epoch is ${expectedEpoch}`);
    this.name = "AbortError";
  }
}

export class StreamingTailParser {
  private source: string;
  private currentSnapshot: MarkdownSnapshot | null;
  private epoch: number;
  private sourceBytes: number;

  constructor(private readonly options: StreamingTailParserOptions) {
    required(options.documentId, "documentId");
    this.source = options.initialSource ?? "";
    this.currentSnapshot = options.initialSnapshot ?? null;
    this.epoch = nonNegativeInteger(options.initialEpoch ?? 0, "initialEpoch");
    this.sourceBytes = new TextEncoder().encode(this.source).byteLength;
    if (this.currentSnapshot) {
      if (
        this.currentSnapshot.surface !== options.surface
        || this.currentSnapshot.document_id !== options.documentId
        || this.currentSnapshot.renderer_profile !== options.rendererProfile
      ) {
        throw new Error("Initial streaming Markdown Snapshot identity does not match parser options");
      }
      if (this.currentSnapshot.source_characters !== this.source.length) {
        throw new Error("Initial streaming Markdown source does not match Snapshot length");
      }
    }
  }

  current(): MarkdownSnapshot | null {
    return this.currentSnapshot;
  }

  currentSource(): string {
    return this.source;
  }

  update(input: StreamingTailParserUpdate): StreamingTailParserResult {
    required(input.revision, "revision");
    nonNegativeInteger(input.epoch, "epoch");
    if (input.epoch < this.epoch) throw new StreamingTailParserStaleEpochError(this.epoch, input.epoch);
    const newEpoch = input.epoch > this.epoch;
    const append = newEpoch ? "" : verifiedAppend(this.source, input.source, input.append);
    const nextSourceBytes = newEpoch
      ? new TextEncoder().encode(input.source).byteLength
      : this.sourceBytes + new TextEncoder().encode(append).byteLength;

    if (!input.final && !newEpoch && append) {
      const fastSnapshot = appendPlainTextSnapshot(this.currentSnapshot, input, append, nextSourceBytes);
      if (fastSnapshot) {
        const previousLogicalLength = this.currentSnapshot!.logical_text.length;
        this.source = input.source;
        this.sourceBytes = fastSnapshot.source_bytes;
        this.currentSnapshot = fastSnapshot;
        this.epoch = input.epoch;
        return freezeResult(fastSnapshot, {
          epoch: input.epoch,
          revision: input.revision,
          canonical: false,
          parsedSourceStart: this.source.length - append.length,
          parsedCharacters: append.length,
          sourceCharacters: input.source.length,
          reusedPrefixBlocks: Math.max(0, fastSnapshot.blocks.length - 1),
          tailBlocks: 1,
          stablePrefixCharacters: fastSnapshot.stream.kind === "streaming"
            ? fastSnapshot.stream.tail_source_start
            : input.source.length,
        }, previousLogicalLength, append);
      }
    }

    if (input.final) {
      const snapshot = parseCanonicalMarkdownSnapshot({
        surface: this.options.surface,
        documentId: this.options.documentId,
        revision: input.revision,
        source: input.source,
        rendererProfile: this.options.rendererProfile,
      }, { previousSnapshot: newEpoch ? null : this.currentSnapshot });
      this.source = input.source;
      this.sourceBytes = new TextEncoder().encode(input.source).byteLength;
      this.currentSnapshot = snapshot;
      this.epoch = input.epoch;
      return freezeResult(snapshot, {
        epoch: input.epoch,
        revision: input.revision,
        canonical: true,
        parsedSourceStart: 0,
        parsedCharacters: input.source.length,
        sourceCharacters: input.source.length,
        reusedPrefixBlocks: 0,
        tailBlocks: 0,
        stablePrefixCharacters: input.source.length,
      });
    }

    const previous = newEpoch ? null : this.currentSnapshot;
    const previousTail = previous ? tailBoundary(previous) : { blockCount: 0, sourceStart: 0 };
    const tailSourceStart = newEpoch ? 0 : previousTail.sourceStart;
    const prefixBlockCount = newEpoch ? 0 : previousTail.blockCount;
    const tailSource = input.source.slice(tailSourceStart);
    const tailSnapshot = parseCanonicalMarkdownSnapshot({
      surface: this.options.surface,
      documentId: `${this.options.documentId}:stream-tail:${input.epoch}:${tailSourceStart}`,
      revision: `${input.revision}:tail`,
      source: tailSource,
      rendererProfile: this.options.rendererProfile,
    });
    const snapshot = composeStreamingSnapshot({
      options: this.options,
      revision: input.revision,
      epoch: input.epoch,
      source: input.source,
      tailSourceStart,
      previous,
      prefixBlockCount,
      tailSnapshot,
      sourceBytes: nextSourceBytes,
    });
    this.source = input.source;
    this.sourceBytes = nextSourceBytes;
    this.currentSnapshot = snapshot;
    this.epoch = input.epoch;
    return freezeResult(snapshot, {
      epoch: input.epoch,
      revision: input.revision,
      canonical: false,
      parsedSourceStart: tailSourceStart,
      parsedCharacters: tailSource.length,
      sourceCharacters: input.source.length,
      reusedPrefixBlocks: prefixBlockCount,
      tailBlocks: snapshot.stream.kind === "streaming"
        ? snapshot.blocks.length - snapshot.stream.prefix_block_count
        : 0,
      stablePrefixCharacters: snapshot.stream.kind === "streaming"
        ? snapshot.stream.tail_source_start
        : input.source.length,
    });
  }
}

function composeStreamingSnapshot(input: {
  readonly options: StreamingTailParserOptions;
  readonly revision: string;
  readonly epoch: number;
  readonly source: string;
  readonly tailSourceStart: number;
  readonly previous: MarkdownSnapshot | null;
  readonly prefixBlockCount: number;
  readonly tailSnapshot: MarkdownSnapshot;
  readonly sourceBytes: number;
}): MarkdownSnapshot {
  const prefixBlocks = input.previous?.blocks.slice(0, input.prefixBlockCount) ?? [];
  const prefixIds = new Set(prefixBlocks.map((block) => block.id));
  const prefixResources = input.previous?.resources.filter((resource) => prefixIds.has(resource.block_id)) ?? [];
  const lineShift = input.previous?.blocks[input.prefixBlockCount]?.source_start === input.tailSourceStart
    ? input.previous.blocks[input.prefixBlockCount].line_start
    : lineCountBefore(input.source, input.tailSourceStart);
  const previousMutableTail = input.previous?.blocks[input.prefixBlockCount] ?? null;
  const tailBlocks = input.tailSnapshot.blocks.map((block, index, blocks) => {
    const absoluteSourceStart = block.source_start + input.tailSourceStart;
    const reusesPreviousTail = index === 0
      && previousMutableTail?.source_start === absoluteSourceStart
      && previousMutableTail.content_hash === block.content_hash;
    if (reusesPreviousTail) {
      return { ...block, id: previousMutableTail.id, identity_key: previousMutableTail.identity_key };
    }
    if (index === blocks.length - 1) {
      const id = `md-stream-tail-${stableMarkdownIdentityHash(input.options.documentId)}-${input.epoch}-${absoluteSourceStart.toString(36)}`;
      return { ...block, id, identity_key: id };
    }
    return block;
  });
  const blockInputs = tailBlocks.map((block, index) => ({
      block,
      resourceBlockId: input.tailSnapshot.blocks[index].id,
      snapshot: input.tailSnapshot,
      resources: input.tailSnapshot.resources,
      sourceShift: input.tailSourceStart,
      lineShift,
    }));
  const blocks: MarkdownSnapshotBlock[] = [...prefixBlocks];
  const resources: MarkdownSnapshotResource[] = [...prefixResources];
  const prefixLogicalEnd = prefixBlocks.at(-1)?.logical_end ?? 0;
  const logicalParts: string[] = prefixLogicalEnd > 0
    ? [input.previous!.logical_text.slice(0, prefixLogicalEnd)]
    : [];
  let logicalCursor = prefixLogicalEnd;
  for (const candidate of blockInputs) {
    if (blocks.length > 0) {
      logicalParts.push("\n");
      logicalCursor += 1;
    }
    const text = candidate.snapshot.logical_text.slice(candidate.block.logical_start, candidate.block.logical_end);
    const logicalStart = logicalCursor;
    const logicalDelta = logicalStart - candidate.block.logical_start;
    const block: MarkdownSnapshotBlock = {
      ...candidate.block,
      index: blocks.length,
      source_start: candidate.block.source_start + candidate.sourceShift,
      source_end: candidate.block.source_end + candidate.sourceShift,
      logical_start: logicalStart,
      logical_end: logicalStart + text.length,
      line_start: candidate.block.line_start + candidate.lineShift,
      line_end: candidate.block.line_end + candidate.lineShift,
      inline_spans: candidate.block.inline_spans.map((span) => ({
        ...span,
        source_start: span.source_start + candidate.sourceShift,
        source_end: span.source_end + candidate.sourceShift,
        logical_start: span.logical_start + logicalDelta,
        logical_end: span.logical_end + logicalDelta,
      })),
      metadata: shiftMetadata(candidate.block.metadata, logicalDelta),
    };
    blocks.push(block);
    for (const resource of candidate.resources) {
      if (resource.block_id !== candidate.resourceBlockId) continue;
      resources.push({
        ...resource,
        block_id: block.id,
        source_start: resource.source_start + candidate.sourceShift,
        source_end: resource.source_end + candidate.sourceShift,
        logical_start: resource.logical_start + logicalDelta,
        logical_end: resource.logical_end + logicalDelta,
      });
    }
    logicalParts.push(text);
    logicalCursor += text.length;
  }
  const logicalText = logicalParts.join("");
  const tailBlockCount = input.tailSnapshot.blocks.length > 0 ? 1 : 0;
  const prefixBlockCount = blocks.length - tailBlockCount;
  const tailSourceStart = tailBlockCount > 0
    ? blocks[prefixBlockCount].source_start
    : input.tailSourceStart;
  const prefixRevision = input.previous?.stream.kind === "streaming"
    && input.previous.stream.tail_source_start === tailSourceStart
    ? input.previous.stream.prefix_revision
    : `stream-prefix:${input.epoch}:${tailSourceStart.toString(36)}:${stableMarkdownIdentityHash(input.source.slice(0, tailSourceStart))}`;
  return createMarkdownSnapshotFromImmutableParts({
    surface: input.options.surface,
    document_id: input.options.documentId,
    revision: input.revision,
    renderer_profile: input.options.rendererProfile,
    mode: "stream-tail",
    source_bytes: input.sourceBytes,
    source_characters: input.source.length,
    logical_text: logicalText,
    line_count: input.source ? lineCountBefore(input.source, input.source.length) + 1 : 0,
    blocks,
    outline: blocks
      .filter((block) => block.kind === "heading" && block.metadata.heading_level)
      .map((block) => ({
        id: `${block.id}-outline`,
        block_id: block.id,
        level: block.metadata.heading_level!,
        title: logicalText.slice(block.logical_start, block.logical_end) || `Heading ${block.index + 1}`,
        source_line: block.line_start + 1,
      })),
    resources,
    stream: {
      kind: "streaming",
      epoch: input.epoch,
      prefix_revision: prefixRevision,
      prefix_block_count: prefixBlockCount,
      tail_block_start: prefixBlockCount,
      tail_source_start: tailSourceStart,
      tail_complete: false,
    },
    indexes: {
      line_map_revision: `${input.revision}:line-map`,
      logical_projection_revision: `${input.revision}:logical`,
      source_index_revision: `${input.revision}:source`,
      find_index_revision: null,
      annotation_index_revision: null,
    },
  });
}

function tailBoundary(snapshot: MarkdownSnapshot): { readonly blockCount: number; readonly sourceStart: number } {
  if (snapshot.stream.kind === "streaming") {
    return {
      blockCount: snapshot.stream.prefix_block_count,
      sourceStart: snapshot.stream.tail_source_start,
    };
  }
  if (!snapshot.blocks.length) return { blockCount: 0, sourceStart: 0 };
  return {
    blockCount: snapshot.blocks.length - 1,
    sourceStart: snapshot.blocks.at(-1)!.source_start,
  };
}

function shiftMetadata(metadata: MarkdownSnapshotBlockMetadata, logicalDelta: number): MarkdownSnapshotBlockMetadata {
  if (!metadata.list?.items) return metadata;
  return {
    ...metadata,
    list: {
      ...metadata.list,
      items: metadata.list.items.map((item) => ({
        ...item,
        logical_start: item.logical_start + logicalDelta,
        logical_end: item.logical_end + logicalDelta,
      })),
    },
  };
}

function lineCountBefore(source: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) count += 1;
  return count;
}

function freezeResult(
  snapshot: MarkdownSnapshot,
  diagnostics: StreamingTailParserDiagnostics,
  logicalPrefixCharacters?: number,
  logicalAppend?: string,
): StreamingTailParserResult {
  return Object.freeze({
    snapshot,
    diagnostics: Object.freeze(diagnostics),
    ...(logicalPrefixCharacters === undefined ? {} : { logicalPrefixCharacters }),
    ...(logicalAppend === undefined ? {} : { logicalAppend }),
  });
}

function verifiedAppend(previous: string, next: string, trustedAppend?: string): string {
  if (trustedAppend !== undefined) {
    if (next.length !== previous.length + trustedAppend.length
      || next.slice(previous.length) !== trustedAppend) {
      throw new Error("Trusted streaming Markdown append does not match the next source");
    }
    return trustedAppend;
  }
  if (!next.startsWith(previous)) throw new Error("Streaming Markdown correction requires a new epoch");
  return next.slice(previous.length);
}

const SAFE_PLAIN_APPEND = /^[\p{L}\p{N}\p{M}\p{Zs},，。！？；;:'"“”‘’/]+$/u;

function appendPlainTextSnapshot(
  previous: MarkdownSnapshot | null,
  input: StreamingTailParserUpdate,
  append: string,
  nextSourceBytes: number,
): MarkdownSnapshot | null {
  if (!previous || previous.stream.kind !== "streaming" || !SAFE_PLAIN_APPEND.test(append)) return null;
  const tail = previous.blocks.at(-1);
  if (!tail
    || tail.kind !== "paragraph"
    || tail.source_end !== previous.source_characters
    || tail.logical_end !== previous.logical_text.length
    || tail.inline_spans.some((span) => span.kind !== "text")) return null;
  const lastSpan = tail.inline_spans.at(-1);
  const nextSourceEnd = tail.source_end + append.length;
  const nextLogicalEnd = tail.logical_end + append.length;
  const nextTail: MarkdownSnapshotBlock = {
    ...tail,
    content_hash: stableMarkdownIdentityHash(
      `stream-plain:${input.epoch}:${nextSourceEnd}:${append.slice(Math.max(0, append.length - 512))}`,
    ),
    source_end: nextSourceEnd,
    logical_end: nextLogicalEnd,
    inline_spans: lastSpan && lastSpan.source_end === tail.source_end && lastSpan.logical_end === tail.logical_end
      ? [
          ...tail.inline_spans.slice(0, -1),
          { ...lastSpan, source_end: nextSourceEnd, logical_end: nextLogicalEnd },
        ]
      : tail.inline_spans,
  };
  return createMarkdownSnapshotFromImmutableParts({
    surface: previous.surface,
    document_id: previous.document_id,
    revision: input.revision,
    renderer_profile: previous.renderer_profile,
    mode: "stream-tail",
    source_bytes: nextSourceBytes,
    source_characters: input.source.length,
    logical_text: previous.logical_text + append,
    line_count: previous.line_count,
    blocks: [...previous.blocks.slice(0, -1), nextTail],
    outline: previous.outline,
    resources: previous.resources,
    stream: { ...previous.stream, tail_complete: false },
    indexes: {
      line_map_revision: `${input.revision}:line-map`,
      logical_projection_revision: `${input.revision}:logical`,
      source_index_revision: `${input.revision}:source`,
      find_index_revision: null,
      annotation_index_revision: null,
    },
  });
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
