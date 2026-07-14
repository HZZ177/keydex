import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  validateMarkdownWorkerRequest,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "./protocol";
import { MarkdownParserCancelledError, parseCanonicalMarkdownSnapshot } from "./parser";
import {
  createMarkdownSnapshotChunkHeader,
  type MarkdownSnapshot,
} from "../document/MarkdownSnapshot";
import { StreamingTailParser } from "../streaming/StreamingTailParser";
import { createMarkdownStreamTailPatch } from "../streaming/StreamTailPatch";
import { encodeSelectedMarkdownSnapshot } from "./codec";
import { buildMarkdownFindIndex, MarkdownFindCancelledError } from "../find/findIndex";
import {
  createMarkdownTextModel,
  type MarkdownTextModel,
} from "@/renderer/features/annotations/document/MarkdownTextModel";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";

const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: MarkdownWorkerResponse, transfer?: Transferable[]): void;
};
const cancelledRequests = new Set<string>();
const snapshots = new Map<string, MarkdownSnapshot>();
const sources = new Map<string, string>();
const sourceByteLengths = new Map<string, number>();
const annotationModels = new Map<string, MarkdownTextModel>();
const tailParsers = new Map<string, StreamingTailParser>();

const CHUNKED_SNAPSHOT_THRESHOLD_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_CHUNK_ITEMS = 512;
const SNAPSHOT_CHUNKS_PER_YIELD = 4;

scope.addEventListener("message", (event) => {
  void handleMessage(event);
});

async function handleMessage(event: MessageEvent<unknown>): Promise<void> {
  let request: MarkdownWorkerRequest;
  try {
    request = validateMarkdownWorkerRequest(event.data);
  } catch (error) {
    const candidate = event.data as Partial<MarkdownWorkerRequest>;
    if (!candidate.surface || !candidate.document_id || !candidate.revision || !candidate.request_id) return;
    scope.postMessage({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: candidate.surface,
      document_id: candidate.document_id,
      revision: candidate.revision,
      request_id: candidate.request_id,
      type: "error",
      payload: {
        code: "invalid-message",
        message: error instanceof Error ? error.message : String(error),
        stage: "protocol",
        retryable: false,
      },
    });
    return;
  }
  if (request.type === "capabilities") {
    scope.postMessage({
      ...identity(request),
      type: "capabilities-result",
      payload: {
        supported: [
          "canonical-parse",
          "stream-tail-parse",
          "find-index",
          "annotation-resolve",
          "snapshot-hydration",
          "chunked-snapshot",
          "transferable-array-buffer",
        ],
        max_transfer_bytes: 20 * 1024 * 1024,
      },
    });
    return;
  }
  if (request.type === "cancel") {
    cancelledRequests.add(request.payload.target_request_id);
    scope.postMessage({
      ...identity(request),
      type: "cancelled",
      payload: { target_request_id: request.payload.target_request_id },
    });
    return;
  }
  if (request.type === "dispose") {
    const key = documentKey(request);
    snapshots.delete(key);
    sources.delete(key);
    sourceByteLengths.delete(key);
    annotationModels.delete(key);
    tailParsers.delete(key);
    scope.postMessage({ ...identity(request), type: "disposed", payload: {} });
    return;
  }
  if (request.type === "hydrate-snapshot") {
    const key = documentKey(request);
    snapshots.set(key, request.payload.snapshot);
    sources.set(key, request.payload.source);
    sourceByteLengths.set(key, new TextEncoder().encode(request.payload.source).byteLength);
    annotationModels.delete(key);
    tailParsers.delete(key);
    scope.postMessage({
      ...identity(request),
      type: "hydrated",
      payload: { estimated_bytes: request.payload.snapshot.estimated_bytes },
    });
    return;
  }
  if (request.type === "parse-canonical") {
    try {
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownParserCancelledError();
      const source = request.payload.source.kind === "text"
        ? request.payload.source.content
        : new TextDecoder("utf-8", { fatal: true }).decode(request.payload.source.data);
      const snapshot = parseCanonicalMarkdownSnapshot({
        surface: request.surface,
        documentId: request.document_id,
        revision: request.revision,
        source,
        rendererProfile: request.payload.options.renderer_profile,
      }, {
        shouldCancel: () => cancelledRequests.has(request.request_id),
        previousSnapshot: snapshots.get(documentKey(request)),
      });
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownParserCancelledError();
      const key = documentKey(request);
      snapshots.set(key, snapshot);
      sources.set(key, source);
      sourceByteLengths.set(key, request.payload.source.byte_length);
      annotationModels.delete(key);
      tailParsers.delete(key);
      await postSnapshotResult(request, snapshot);
    } catch (error) {
      const cancelled = error instanceof MarkdownParserCancelledError;
      scope.postMessage({
        ...identity(request),
        type: "error",
        payload: {
          code: cancelled ? "cancelled" : "parse-failed",
          message: cancelled ? "Markdown parse cancelled" : error instanceof Error ? error.message : String(error),
          stage: "parse",
          retryable: cancelled,
        },
      });
    }
    return;
  }
  if (request.type === "parse-stream-tail") {
    try {
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownParserCancelledError();
      const key = documentKey(request);
      const baseSnapshot = snapshots.get(key);
      const baseSource = sources.get(key);
      const baseSourceByteLength = sourceByteLengths.get(key);
      if (!baseSnapshot || baseSource === undefined || baseSnapshot.revision !== request.payload.base_revision) {
        throw new Error("Streaming tail parse requires the current base revision");
      }
      if (baseSourceByteLength === undefined) throw new Error("Streaming tail parse requires the current source byte length");
      const source = sourceWithAppend(
        baseSource,
        baseSourceByteLength,
        request.payload.base_source_bytes,
        request.payload.append,
      );
      const appendText = sourcePayloadText(request.payload.append);
      const initialEpoch = baseSnapshot.stream.kind === "streaming"
        ? baseSnapshot.stream.epoch
        : request.payload.stream_epoch;
      const parser = tailParsers.get(key) ?? new StreamingTailParser({
        surface: request.surface,
        documentId: request.document_id,
        rendererProfile: request.payload.options.renderer_profile,
        initialSource: baseSource,
        initialSnapshot: baseSnapshot,
        initialEpoch,
      });
      tailParsers.set(key, parser);
      const result = parser.update({
        source,
        revision: request.revision,
        epoch: request.payload.stream_epoch,
        final: request.payload.final,
        append: request.payload.base_source_bytes === baseSourceByteLength ? appendText : undefined,
      });
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownParserCancelledError();
      snapshots.set(key, result.snapshot);
      sources.set(key, source);
      sourceByteLengths.set(key, request.payload.base_source_bytes + request.payload.append.byte_length);
      annotationModels.delete(key);
      if (request.payload.final) tailParsers.delete(key);
      if (request.payload.final) {
        await postSnapshotResult(request, result.snapshot);
      } else {
        const patch = createMarkdownStreamTailPatch(baseSnapshot, result.snapshot, {
          logicalPrefixCharacters: result.logicalPrefixCharacters,
          logicalAppend: result.logicalAppend,
        });
        scope.postMessage({ ...identity(request), type: "stream-tail-patch-result", payload: patch });
      }
    } catch (error) {
      const cancelled = error instanceof MarkdownParserCancelledError;
      scope.postMessage({
        ...identity(request),
        type: "error",
        payload: {
          code: cancelled ? "cancelled" : "parse-failed",
          message: cancelled ? "Markdown stream tail parse cancelled" : error instanceof Error ? error.message : String(error),
          stage: "parse",
          retryable: cancelled,
        },
      });
    }
    return;
  }
  if (request.type === "query-find") {
    try {
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownFindCancelledError();
      const snapshot = snapshots.get(documentKey(request));
      if (!snapshot || snapshot.revision !== request.revision) {
        scope.postMessage({
          ...identity(request),
          type: "error",
          payload: {
            code: "invalid-payload",
            message: "Markdown find requires the current parsed revision",
            stage: "find",
            retryable: true,
          },
        });
        return;
      }
      const index = buildMarkdownFindIndex(snapshot, request.payload.query, {
        caseSensitive: request.payload.case_sensitive,
        wholeWord: request.payload.whole_word,
        limit: request.payload.limit,
        shouldCancel: () => cancelledRequests.has(request.request_id),
      });
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownFindCancelledError();
      scope.postMessage({
        ...identity(request),
        type: "find-result",
        payload: {
          query: index.query,
          matches: index.matches.map((match) => ({
            id: match.id,
            block_id: match.blockId,
            block_index: match.blockIndex,
            block_local_start: match.blockLocalStart,
            block_local_end: match.blockLocalEnd,
            logical_start: match.logicalStart,
            logical_end: match.logicalEnd,
            source_start: match.sourceStart,
            source_end: match.sourceEnd,
            match_text: match.matchText,
            snippet: match.snippet,
          })),
        },
      });
    } catch (error) {
      const cancelled = error instanceof MarkdownFindCancelledError;
      scope.postMessage({
        ...identity(request),
        type: "error",
        payload: {
          code: cancelled ? "cancelled" : "worker-failed",
          message: cancelled ? "Markdown find cancelled" : error instanceof Error ? error.message : String(error),
          stage: "find",
          retryable: cancelled,
        },
      });
    }
    return;
  }
  if (request.type === "resolve-annotations") {
    try {
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownFindCancelledError();
      const key = documentKey(request);
      const snapshot = snapshots.get(key);
      const source = sources.get(key);
      if (!snapshot || source === undefined || snapshot.revision !== request.revision) {
        scope.postMessage({
          ...identity(request),
          type: "error",
          payload: {
            code: "invalid-payload",
            message: "Markdown annotation resolution requires the current parsed revision",
            stage: "annotations",
            retryable: true,
          },
        });
        return;
      }
      const model = annotationModels.get(key)
        ?? createMarkdownTextModel(source, request.revision, snapshot);
      annotationModels.set(key, model);
      const result = resolveDocumentAnnotations(model, request.payload.records);
      if (cancelledRequests.delete(request.request_id)) throw new MarkdownFindCancelledError();
      scope.postMessage({ ...identity(request), type: "annotations-result", payload: { result } });
    } catch (error) {
      const cancelled = error instanceof MarkdownFindCancelledError;
      scope.postMessage({
        ...identity(request),
        type: "error",
        payload: {
          code: cancelled ? "cancelled" : "worker-failed",
          message: cancelled ? "Markdown annotation resolution cancelled" : error instanceof Error ? error.message : String(error),
          stage: "annotations",
          retryable: cancelled,
        },
      });
    }
    return;
  }
  const unsupported = request as unknown as MarkdownWorkerRequest;
  scope.postMessage({
    ...identity(unsupported),
    type: "error",
    payload: {
      code: "unsupported-operation",
      message: `${unsupported.type} is not installed in the shared Worker yet`,
      stage: "lifecycle",
      retryable: false,
    },
  });
}

async function postSnapshotResult(
  request: Extract<MarkdownWorkerRequest, { type: "parse-canonical" | "parse-stream-tail" }>,
  snapshot: MarkdownSnapshot,
): Promise<void> {
  if (snapshot.estimated_bytes < CHUNKED_SNAPSHOT_THRESHOLD_BYTES) {
    const encoded = encodeSelectedMarkdownSnapshot(snapshot);
    scope.postMessage(
      { ...identity(request), type: "snapshot-result", payload: encoded.payload },
      [...encoded.transfer],
    );
    return;
  }

  throwIfCancelled(request.request_id);
  const header = createMarkdownSnapshotChunkHeader(snapshot);
  scope.postMessage({ ...identity(request), type: "snapshot-start", payload: header });
  let chunksSinceYield = 0;

  for (let start = 0; start < snapshot.blocks.length; start += SNAPSHOT_CHUNK_ITEMS) {
    throwIfCancelled(request.request_id);
    scope.postMessage({
      ...identity(request),
      type: "snapshot-chunk",
      payload: {
        collection: "blocks",
        start,
        items: snapshot.blocks.slice(start, start + SNAPSHOT_CHUNK_ITEMS),
      },
    });
    chunksSinceYield = await yieldAfterChunk(chunksSinceYield);
  }
  for (let start = 0; start < snapshot.outline.length; start += SNAPSHOT_CHUNK_ITEMS) {
    throwIfCancelled(request.request_id);
    scope.postMessage({
      ...identity(request),
      type: "snapshot-chunk",
      payload: {
        collection: "outline",
        start,
        items: snapshot.outline.slice(start, start + SNAPSHOT_CHUNK_ITEMS),
      },
    });
    chunksSinceYield = await yieldAfterChunk(chunksSinceYield);
  }
  for (let start = 0; start < snapshot.resources.length; start += SNAPSHOT_CHUNK_ITEMS) {
    throwIfCancelled(request.request_id);
    scope.postMessage({
      ...identity(request),
      type: "snapshot-chunk",
      payload: {
        collection: "resources",
        start,
        items: snapshot.resources.slice(start, start + SNAPSHOT_CHUNK_ITEMS),
      },
    });
    chunksSinceYield = await yieldAfterChunk(chunksSinceYield);
  }

  throwIfCancelled(request.request_id);
  scope.postMessage({
    ...identity(request),
    type: "snapshot-complete",
    payload: {
      block_count: snapshot.blocks.length,
      outline_count: snapshot.outline.length,
      resource_count: snapshot.resources.length,
    },
  });
}

async function yieldAfterChunk(chunksSinceYield: number): Promise<number> {
  const next = chunksSinceYield + 1;
  if (next < SNAPSHOT_CHUNKS_PER_YIELD) return next;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return 0;
}

function throwIfCancelled(requestId: string): void {
  if (cancelledRequests.delete(requestId)) throw new MarkdownParserCancelledError();
}

function identity(request: MarkdownWorkerRequest) {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: request.surface,
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
  } as const;
}

function documentKey(request: MarkdownWorkerRequest): string {
  return `${request.surface}\u0000${request.document_id}`;
}

function sourceWithAppend(
  baseSource: string,
  cachedBaseSourceBytes: number,
  baseSourceBytes: number,
  append: Extract<MarkdownWorkerRequest, { type: "parse-stream-tail" }>["payload"]["append"],
): string {
  const encoder = new TextEncoder();
  if (baseSourceBytes > cachedBaseSourceBytes) throw new Error("Streaming tail base_source_bytes exceeds current source");
  const suffix = append.kind === "text" ? encoder.encode(append.content) : new Uint8Array(append.data);
  if (suffix.byteLength !== append.byte_length) throw new Error("Streaming tail append byte length mismatch");
  const suffixText = append.kind === "text"
    ? append.content
    : new TextDecoder("utf-8", { fatal: true }).decode(suffix);
  if (baseSourceBytes === cachedBaseSourceBytes) return baseSource + suffixText;
  if (baseSourceBytes === 0) return suffixText;
  const base = encoder.encode(baseSource);
  const combined = new Uint8Array(baseSourceBytes + suffix.byteLength);
  combined.set(base.subarray(0, baseSourceBytes), 0);
  combined.set(suffix, baseSourceBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function sourcePayloadText(
  source: Extract<MarkdownWorkerRequest, { type: "parse-stream-tail" }>["payload"]["append"],
): string {
  return source.kind === "text"
    ? source.content
    : new TextDecoder("utf-8", { fatal: true }).decode(source.data);
}
