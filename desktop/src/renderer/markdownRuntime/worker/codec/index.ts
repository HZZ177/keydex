import {
  assertValidMarkdownSnapshot,
  assertValidMarkdownSnapshotOnce,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
  type MarkdownSnapshotBlockKind,
} from "../../document/MarkdownSnapshot";

export const MARKDOWN_SNAPSHOT_CODEC_SELECTION = "structured-clone/v1" as const;

export const MARKDOWN_SNAPSHOT_CODEC_DECISION = Object.freeze({
  selected: MARKDOWN_SNAPSHOT_CODEC_SELECTION,
  payload: "raw MarkdownSnapshot",
  transferables: false,
  signedRuntime: "WebView2/Chromium 150",
  evidence: ".dev/test/zed-class-markdown-runtime/worker-codec/results/webview2.json",
  reason: "Measured fastest aggregate latency and lowest worst heap delta; encoded formats add no material gain",
});

export function isMarkdownSnapshotCodecBenchmarkCurrent(runtimeVersion: string): boolean {
  const major = Number.parseInt(runtimeVersion.split(".", 1)[0] ?? "", 10);
  return major === 150;
}

export type MarkdownSnapshotCodecCandidate =
  | "structured-clone"
  | "json-transferable"
  | "columnar-transferable";

export type MarkdownSnapshotCodecWire =
  | { readonly codec: "structured-clone"; readonly snapshot: MarkdownSnapshot }
  | { readonly codec: "json-transferable"; readonly data: ArrayBuffer }
  | {
      readonly codec: "columnar-transferable";
      readonly header: ArrayBuffer;
      readonly logicalText: ArrayBuffer;
      readonly blockNumbers: ArrayBuffer;
      readonly blockObjects: ArrayBuffer;
      readonly outline: ArrayBuffer;
      readonly resources: ArrayBuffer;
    };

export interface EncodedMarkdownSnapshot {
  readonly wire: MarkdownSnapshotCodecWire;
  readonly transfer: readonly ArrayBuffer[];
  readonly encodedBytes: number;
}

export class MarkdownSnapshotCodecCancelledError extends Error {
  constructor() {
    super("Markdown Snapshot codec operation cancelled");
    this.name = "AbortError";
  }
}

export function encodeSelectedMarkdownSnapshot(snapshot: MarkdownSnapshot): {
  readonly payload: MarkdownSnapshot;
  readonly transfer: readonly Transferable[];
} {
  assertValidMarkdownSnapshotOnce(snapshot);
  return { payload: snapshot, transfer: [] };
}

export function decodeSelectedMarkdownSnapshot(payload: unknown): MarkdownSnapshot {
  assertValidMarkdownSnapshotOnce(payload);
  return payload;
}

export function encodeMarkdownSnapshotCandidate(
  snapshot: MarkdownSnapshot,
  codec: MarkdownSnapshotCodecCandidate,
  signal?: AbortSignal,
): EncodedMarkdownSnapshot {
  checkpoint(signal);
  assertValidMarkdownSnapshot(snapshot);
  if (codec === "structured-clone") {
    return { wire: { codec, snapshot }, transfer: [], encodedBytes: snapshot.estimated_bytes };
  }
  if (codec === "json-transferable") {
    const data = encodeJson(snapshot);
    checkpoint(signal);
    return { wire: { codec, data }, transfer: [data], encodedBytes: data.byteLength };
  }

  const header = encodeJson({
    schema_version: snapshot.schema_version,
    surface: snapshot.surface,
    document_id: snapshot.document_id,
    revision: snapshot.revision,
    renderer_profile: snapshot.renderer_profile,
    mode: snapshot.mode,
    source_bytes: snapshot.source_bytes,
    source_characters: snapshot.source_characters,
    line_count: snapshot.line_count,
    stream: snapshot.stream,
    indexes: snapshot.indexes,
    estimated_bytes: snapshot.estimated_bytes,
    block_count: snapshot.blocks.length,
  });
  const logicalText = new TextEncoder().encode(snapshot.logical_text).buffer;
  const numbers = new Uint32Array(snapshot.blocks.length * BLOCK_NUMBER_COLUMNS);
  const blockObjects = snapshot.blocks.map((block, index) => {
    const offset = index * BLOCK_NUMBER_COLUMNS;
    numbers.set([
      block.source_start,
      block.source_end,
      block.logical_start,
      block.logical_end,
      block.index,
      block.depth,
      block.line_start,
      block.line_end,
      blockKindCode(block.kind),
    ], offset);
    return {
      id: block.id,
      identity_key: block.identity_key,
      content_hash: block.content_hash,
      parent_id: block.parent_id,
      inline_spans: block.inline_spans,
      metadata: block.metadata,
    };
  });
  const blockNumbers = numbers.buffer;
  const encodedBlockObjects = encodeJson(blockObjects);
  const outline = encodeJson(snapshot.outline);
  const resources = encodeJson(snapshot.resources);
  checkpoint(signal);
  const transfer = [header, logicalText, blockNumbers, encodedBlockObjects, outline, resources];
  return {
    wire: {
      codec,
      header,
      logicalText,
      blockNumbers,
      blockObjects: encodedBlockObjects,
      outline,
      resources,
    },
    transfer,
    encodedBytes: transfer.reduce((total, entry) => total + entry.byteLength, 0),
  };
}

export function decodeMarkdownSnapshotCandidate(
  wire: MarkdownSnapshotCodecWire,
  signal?: AbortSignal,
): MarkdownSnapshot {
  checkpoint(signal);
  if (wire.codec === "structured-clone") {
    assertValidMarkdownSnapshot(wire.snapshot);
    return wire.snapshot;
  }
  if (wire.codec === "json-transferable") {
    const snapshot = decodeJson(wire.data) as MarkdownSnapshot;
    assertValidMarkdownSnapshot(snapshot);
    checkpoint(signal);
    return snapshot;
  }

  const header = decodeJson(wire.header) as Omit<MarkdownSnapshot, "logical_text" | "blocks" | "outline" | "resources"> & {
    readonly block_count: number;
  };
  const logicalText = new TextDecoder("utf-8", { fatal: true }).decode(wire.logicalText);
  const numbers = new Uint32Array(wire.blockNumbers);
  const objects = decodeJson(wire.blockObjects) as Array<Pick<
    MarkdownSnapshotBlock,
    "id" | "identity_key" | "content_hash" | "parent_id" | "inline_spans" | "metadata"
  >>;
  if (numbers.length !== header.block_count * BLOCK_NUMBER_COLUMNS || objects.length !== header.block_count) {
    throw new Error("Columnar Markdown Snapshot block table is inconsistent");
  }
  const blocks = objects.map((entry, index): MarkdownSnapshotBlock => {
    const offset = index * BLOCK_NUMBER_COLUMNS;
    return {
      ...entry,
      source_start: numbers[offset],
      source_end: numbers[offset + 1],
      logical_start: numbers[offset + 2],
      logical_end: numbers[offset + 3],
      index: numbers[offset + 4],
      depth: numbers[offset + 5],
      line_start: numbers[offset + 6],
      line_end: numbers[offset + 7],
      kind: BLOCK_KINDS[numbers[offset + 8]] ?? "unknown",
    };
  });
  const { block_count: _blockCount, ...snapshotHeader } = header;
  const snapshot: MarkdownSnapshot = {
    ...snapshotHeader,
    logical_text: logicalText,
    blocks,
    outline: decodeJson(wire.outline) as MarkdownSnapshot["outline"],
    resources: decodeJson(wire.resources) as MarkdownSnapshot["resources"],
  };
  assertValidMarkdownSnapshot(snapshot);
  checkpoint(signal);
  return snapshot;
}

function encodeJson(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function decodeJson(value: ArrayBuffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
}

function checkpoint(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MarkdownSnapshotCodecCancelledError();
}

function blockKindCode(kind: MarkdownSnapshotBlockKind): number {
  return Math.max(0, BLOCK_KINDS.indexOf(kind));
}

const BLOCK_NUMBER_COLUMNS = 9;
const BLOCK_KINDS: readonly MarkdownSnapshotBlockKind[] = [
  "paragraph", "heading", "blockquote", "list", "code", "mermaid", "table", "image",
  "math", "html", "thematic-break", "frontmatter", "unknown",
];
