import type { AnnotationRecord } from "@/runtime/annotations";
import type { ResolvedAnnotationIndex } from "@/renderer/features/annotations/domain/resolutions";
import {
  MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
  assertValidMarkdownSnapshotOnce,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
  type MarkdownSnapshotOutlineEntry,
} from "../document/MarkdownSnapshot";
import { decodeSelectedMarkdownSnapshot } from "./codec";
import type { MarkdownStreamTailPatch } from "../streaming/StreamTailPatch";

export { MARKDOWN_SNAPSHOT_SCHEMA_VERSION } from "../document/MarkdownSnapshot";

export const MARKDOWN_WORKER_PROTOCOL_VERSION = "markdown-worker/v1";

export type MarkdownSurface = "file" | "message";
export type MarkdownRendererProfile = "file-preview" | "conversation";
export type MarkdownParseMode = "canonical" | "stream-tail";
export type MarkdownWorkerCapability =
  | "canonical-parse"
  | "stream-tail-parse"
  | "find-index"
  | "annotation-resolve"
  | "snapshot-hydration"
  | "transferable-array-buffer";

export interface MarkdownWorkerIdentity {
  readonly protocol_version: typeof MARKDOWN_WORKER_PROTOCOL_VERSION;
  readonly surface: MarkdownSurface;
  readonly document_id: string;
  readonly revision: string;
  readonly request_id: string;
}

export type MarkdownSourcePayload =
  | {
      readonly kind: "text";
      readonly encoding: "utf-8";
      readonly content: string;
      readonly byte_length: number;
    }
  | {
      readonly kind: "utf8-buffer";
      readonly encoding: "utf-8";
      readonly data: ArrayBuffer;
      readonly byte_length: number;
    };

export interface MarkdownParseOptionsPayload {
  readonly renderer_profile: MarkdownRendererProfile;
  readonly enable_html: boolean;
  readonly enable_mdx: boolean;
}

export type MarkdownWorkerBlockPayload = MarkdownSnapshotBlock;
export type MarkdownWorkerOutlinePayload = MarkdownSnapshotOutlineEntry;
export type MarkdownSnapshotPayload = MarkdownSnapshot;
export type MarkdownStreamTailPatchPayload = MarkdownStreamTailPatch;

export interface MarkdownFindMatchPayload {
  readonly id: string;
  readonly block_id: string;
  readonly block_index: number;
  readonly block_local_start: number;
  readonly block_local_end: number;
  readonly logical_start: number;
  readonly logical_end: number;
  readonly source_start: number;
  readonly source_end: number;
  readonly match_text: string;
  readonly snippet: string;
}

export type MarkdownWorkerRequest =
  | (MarkdownWorkerIdentity & {
      readonly type: "capabilities";
      readonly payload: { readonly requested: readonly MarkdownWorkerCapability[] };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "parse-canonical";
      readonly payload: {
        readonly source: MarkdownSourcePayload;
        readonly options: MarkdownParseOptionsPayload;
      };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "parse-stream-tail";
      readonly payload: {
        readonly base_revision: string;
        readonly base_source_bytes: number;
        readonly stream_epoch: number;
        readonly final: boolean;
        readonly append: MarkdownSourcePayload;
        readonly options: MarkdownParseOptionsPayload;
      };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "hydrate-snapshot";
      readonly payload: {
        readonly source: string;
        readonly snapshot: MarkdownSnapshotPayload;
      };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "query-find";
      readonly payload: {
        readonly query: string;
        readonly case_sensitive: boolean;
        readonly whole_word: boolean;
        readonly limit: number;
      };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "resolve-annotations";
      readonly payload: {
        readonly path: string;
        readonly workspace_id: string;
        readonly records: readonly AnnotationRecord[];
      };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "cancel";
      readonly payload: { readonly target_request_id: string; readonly reason?: string };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "dispose";
      readonly payload: { readonly reason?: string };
    });

export type MarkdownWorkerResponse =
  | (MarkdownWorkerIdentity & {
      readonly type: "capabilities-result";
      readonly payload: {
        readonly supported: readonly MarkdownWorkerCapability[];
        readonly max_transfer_bytes: number;
      };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "snapshot-result";
      readonly payload: MarkdownSnapshotPayload;
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "stream-tail-patch-result";
      readonly payload: MarkdownStreamTailPatchPayload;
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "hydrated";
      readonly payload: { readonly estimated_bytes: number };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "find-result";
      readonly payload: { readonly query: string; readonly matches: readonly MarkdownFindMatchPayload[] };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "annotations-result";
      readonly payload: { readonly result: ResolvedAnnotationIndex };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "cancelled";
      readonly payload: { readonly target_request_id: string };
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "disposed";
      readonly payload: Record<string, never>;
    })
  | (MarkdownWorkerIdentity & {
      readonly type: "error";
      readonly payload: {
        readonly code: MarkdownWorkerErrorCode;
        readonly message: string;
        readonly stage: MarkdownWorkerStage;
        readonly retryable: boolean;
      };
    });

export type MarkdownWorkerStage = "protocol" | "parse" | "index" | "find" | "annotations" | "lifecycle";
export type MarkdownWorkerErrorCode =
  | "invalid-message"
  | "unsupported-version"
  | "unsupported-operation"
  | "invalid-payload"
  | "cancelled"
  | "parse-failed"
  | "worker-failed";

export class MarkdownWorkerProtocolError extends Error {
  constructor(
    readonly code: MarkdownWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarkdownWorkerProtocolError";
  }
}

export function validateMarkdownWorkerRequest(value: unknown): MarkdownWorkerRequest {
  const message = validateEnvelope(value);
  if (message.type !== "hydrate-snapshot") assertNoRendererObjects(message);
  switch (message.type) {
    case "capabilities":
      assertCapabilityArrayField(message.payload, "requested");
      break;
    case "parse-canonical":
      validateParsePayload(message.payload);
      break;
    case "parse-stream-tail":
      assertRecord(message.payload, "stream-tail payload");
      assertNonEmptyString(message.payload.base_revision, "base_revision");
      assertNonNegativeInteger(message.payload.base_source_bytes, "base_source_bytes");
      assertNonNegativeInteger(message.payload.stream_epoch, "stream_epoch");
      if (typeof message.payload.final !== "boolean") invalid("final must be a boolean");
      validateSource(message.payload.append);
      validateParseOptions(message.payload.options);
      break;
    case "hydrate-snapshot":
      assertRecord(message.payload, "hydrate payload");
      if (typeof message.payload.source !== "string") invalid("hydrate source must be a string");
      validateSnapshot(message.payload.snapshot);
      decodeSelectedMarkdownSnapshot(message.payload.snapshot);
      if (message.payload.snapshot.surface !== message.surface
        || message.payload.snapshot.document_id !== message.document_id
        || message.payload.snapshot.revision !== message.revision) {
        invalid("hydrated snapshot identity does not match request envelope");
      }
      if (message.payload.source.length !== message.payload.snapshot.source_characters) {
        invalid("hydrate source length does not match snapshot");
      }
      break;
    case "query-find":
      assertRecord(message.payload, "find payload");
      if (typeof message.payload.query !== "string") invalid("query must be a string");
      if (typeof message.payload.case_sensitive !== "boolean") invalid("case_sensitive must be a boolean");
      if (typeof message.payload.whole_word !== "boolean") invalid("whole_word must be a boolean");
      assertNonNegativeInteger(message.payload.limit, "limit");
      break;
    case "resolve-annotations":
      assertRecord(message.payload, "annotation payload");
      assertNonEmptyString(message.payload.path, "path");
      assertNonEmptyString(message.payload.workspace_id, "workspace_id");
      if (!Array.isArray(message.payload.records)) invalid("records must be an array");
      break;
    case "cancel":
      assertRecord(message.payload, "cancel payload");
      assertNonEmptyString(message.payload.target_request_id, "target_request_id");
      assertOptionalString(message.payload.reason, "reason");
      break;
    case "dispose":
      assertRecord(message.payload, "dispose payload");
      assertOptionalString(message.payload.reason, "reason");
      break;
    default:
      throw new MarkdownWorkerProtocolError(
        "unsupported-operation",
        `Unsupported Markdown Worker request ${(message as { type?: unknown }).type as string}`,
      );
  }
  return message as unknown as MarkdownWorkerRequest;
}

export function validateMarkdownWorkerResponse(value: unknown): MarkdownWorkerResponse {
  const message = validateEnvelope(value);
  if (message.type !== "snapshot-result") assertNoRendererObjects(message);
  switch (message.type) {
    case "capabilities-result":
      assertCapabilityArrayField(message.payload, "supported");
      assertRecord(message.payload, "capabilities payload");
      assertNonNegativeInteger(message.payload.max_transfer_bytes, "max_transfer_bytes");
      break;
    case "snapshot-result":
      validateSnapshot(message.payload);
      decodeSelectedMarkdownSnapshot(message.payload);
      if (message.payload.surface !== message.surface
        || message.payload.document_id !== message.document_id
        || message.payload.revision !== message.revision) {
        invalid("snapshot identity does not match response envelope");
      }
      break;
    case "stream-tail-patch-result":
      validateStreamTailPatch(message.payload);
      break;
    case "hydrated":
      assertRecord(message.payload, "hydrated payload");
      assertNonNegativeInteger(message.payload.estimated_bytes, "estimated_bytes");
      break;
    case "find-result":
      assertRecord(message.payload, "find result payload");
      if (typeof message.payload.query !== "string" || !Array.isArray(message.payload.matches)) {
        invalid("find result payload is malformed");
      }
      message.payload.matches.forEach(validateFindMatch);
      break;
    case "annotations-result":
      assertRecord(message.payload, "annotations result payload");
      validateAnnotationsResult(message.payload.result);
      break;
    case "cancelled":
      assertRecord(message.payload, "cancelled payload");
      assertNonEmptyString(message.payload.target_request_id, "target_request_id");
      break;
    case "disposed":
      assertRecord(message.payload, "disposed payload");
      break;
    case "error":
      assertRecord(message.payload, "error payload");
      if (!WORKER_ERROR_CODES.has(String(message.payload.code))) invalid("error code is unsupported");
      assertNonEmptyString(message.payload.message, "error message");
      if (!WORKER_STAGES.has(String(message.payload.stage))) invalid("error stage is unsupported");
      if (typeof message.payload.retryable !== "boolean") invalid("retryable must be a boolean");
      break;
    default:
      throw new MarkdownWorkerProtocolError(
        "unsupported-operation",
        `Unsupported Markdown Worker response ${(message as { type?: unknown }).type as string}`,
      );
  }
  return message as unknown as MarkdownWorkerResponse;
}

function validateStreamTailPatch(value: unknown): asserts value is MarkdownStreamTailPatchPayload {
  assertRecord(value, "stream tail patch");
  if (value.schema_version !== MARKDOWN_SNAPSHOT_SCHEMA_VERSION) invalid("stream tail patch schema version mismatch");
  assertNonEmptyString(value.base_revision, "stream tail patch base_revision");
  if (value.renderer_profile !== "file-preview" && value.renderer_profile !== "conversation") {
    invalid("stream tail patch renderer_profile is invalid");
  }
  if (value.mode !== "canonical" && value.mode !== "stream-tail") invalid("stream tail patch mode is invalid");
  for (const field of [
    "source_bytes",
    "source_characters",
    "logical_prefix_characters",
    "logical_delete_characters",
    "line_count",
    "estimated_bytes",
  ] as const) assertNonNegativeInteger(value[field], `stream tail patch ${field}`);
  if (typeof value.logical_append !== "string") invalid("stream tail patch logical_append must be a string");
  validateTailCollectionPatch(value.blocks, "blocks");
  validateTailCollectionPatch(value.outline, "outline");
  validateTailCollectionPatch(value.resources, "resources");
  assertRecord(value.stream, "stream tail patch stream");
  assertRecord(value.indexes, "stream tail patch indexes");
}

function validateTailCollectionPatch(value: unknown, label: string): void {
  assertRecord(value, `stream tail patch ${label}`);
  assertNonNegativeInteger(value.prefix_count, `stream tail patch ${label}.prefix_count`);
  assertNonNegativeInteger(value.delete_count, `stream tail patch ${label}.delete_count`);
  if (!Array.isArray(value.items)) invalid(`stream tail patch ${label}.items must be an array`);
}

export function responseMatchesRequest(
  request: MarkdownWorkerRequest,
  response: MarkdownWorkerResponse,
): boolean {
  return request.surface === response.surface
    && request.document_id === response.document_id
    && request.revision === response.revision
    && request.request_id === response.request_id;
}

export function transferableSource(source: MarkdownSourcePayload): Transferable[] {
  return source.kind === "utf8-buffer" ? [source.data] : [];
}

function validateEnvelope(value: unknown): Record<string, unknown> {
  assertRecord(value, "message");
  if (value.protocol_version !== MARKDOWN_WORKER_PROTOCOL_VERSION) {
    throw new MarkdownWorkerProtocolError(
      "unsupported-version",
      `Unsupported Markdown Worker protocol ${String(value.protocol_version)}`,
    );
  }
  if (value.surface !== "file" && value.surface !== "message") invalid("surface must be file or message");
  assertNonEmptyString(value.document_id, "document_id");
  assertNonEmptyString(value.revision, "revision");
  assertNonEmptyString(value.request_id, "request_id");
  assertNonEmptyString(value.type, "type");
  return value;
}

function validateParsePayload(value: unknown): void {
  assertRecord(value, "parse payload");
  validateSource(value.source);
  validateParseOptions(value.options);
}

function validateSource(value: unknown): void {
  assertRecord(value, "source payload");
  if (value.encoding !== "utf-8") invalid("source encoding must be utf-8");
  assertNonNegativeInteger(value.byte_length, "byte_length");
  if (value.kind === "text") {
    if (typeof value.content !== "string") invalid("text source content must be a string");
    if (utf8ByteLength(value.content) !== value.byte_length) invalid("text source byte_length mismatch");
    return;
  }
  if (value.kind === "utf8-buffer") {
    if (!isArrayBuffer(value.data)) invalid("buffer source data must be an ArrayBuffer");
    if (value.data.byteLength !== value.byte_length) invalid("buffer source byte_length mismatch");
    return;
  }
  invalid("source kind is unsupported");
}

function validateParseOptions(value: unknown): void {
  assertRecord(value, "parse options");
  if (value.renderer_profile !== "file-preview" && value.renderer_profile !== "conversation") {
    invalid("renderer_profile is unsupported");
  }
  if (typeof value.enable_html !== "boolean" || typeof value.enable_mdx !== "boolean") {
    invalid("parse feature flags must be boolean");
  }
}

function validateSnapshot(value: unknown): asserts value is MarkdownSnapshot {
  try {
    assertValidMarkdownSnapshotOnce(value);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function assertNoRendererObjects(value: unknown, depth = 0): void {
  if (depth > 24) invalid("payload nesting exceeds protocol limit");
  if (typeof value === "function" || typeof value === "symbol") invalid("payload is not structured-clone safe");
  if (value === null || typeof value !== "object" || isArrayBuffer(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoRendererObjects(entry, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PROHIBITED_RENDERER_KEYS.has(key.toLowerCase())) {
      invalid(`Worker payload must not contain renderer-owned field ${key}`);
    }
    assertNoRendererObjects(entry, depth + 1);
  }
}

const PROHIBITED_RENDERER_KEYS = new Set([
  "dom",
  "element",
  "node",
  "rect",
  "pixel",
  "parser_object",
  "parser_tree",
]);

function assertCapabilityArrayField(value: unknown, field: string): void {
  assertRecord(value, `${field} payload`);
  const entries = value[field];
  if (!Array.isArray(entries) || entries.some((entry) => !WORKER_CAPABILITIES.has(String(entry)))) {
    invalid(`${field} contains an unsupported capability`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isArrayBuffer(value)) {
    invalid(`${label} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${field} must be a non-negative integer`);
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") invalid(`${field} must be a string when present`);
}

function validateBlock(value: unknown): void {
  assertRecord(value, "snapshot block");
  assertNonEmptyString(value.id, "block id");
  assertNonEmptyString(value.kind, "block kind");
  for (const field of ["source_start", "source_end", "logical_start", "logical_end", "depth"] as const) {
    assertNonNegativeInteger(value[field], field);
  }
  if ((value.source_end as number) < (value.source_start as number)) invalid("block source range is reversed");
  if ((value.logical_end as number) < (value.logical_start as number)) invalid("block logical range is reversed");
  if (value.parent_id !== null && typeof value.parent_id !== "string") invalid("parent_id must be string or null");
  assertRecord(value.attributes, "block attributes");
  for (const attribute of Object.values(value.attributes)) {
    if (attribute !== null && !["string", "number", "boolean"].includes(typeof attribute)) {
      invalid("block attribute must be a scalar");
    }
  }
}

function validateOutline(value: unknown): void {
  assertRecord(value, "snapshot outline entry");
  assertNonEmptyString(value.id, "outline id");
  assertNonEmptyString(value.block_id, "outline block_id");
  assertNonEmptyString(value.title, "outline title");
  assertNonNegativeInteger(value.level, "outline level");
  assertNonNegativeInteger(value.source_line, "outline source_line");
}

function validateFindMatch(value: unknown): void {
  assertRecord(value, "find match");
  assertNonEmptyString(value.id, "find match id");
  assertNonEmptyString(value.block_id, "find match block_id");
  for (const field of [
    "block_index", "block_local_start", "block_local_end",
    "logical_start", "logical_end", "source_start", "source_end",
  ] as const) {
    assertNonNegativeInteger(value[field], field);
  }
  if (typeof value.match_text !== "string" || typeof value.snippet !== "string") {
    invalid("find match text is malformed");
  }
  if ((value.block_local_end as number) < (value.block_local_start as number)) invalid("find block range is reversed");
  if ((value.logical_end as number) < (value.logical_start as number)) invalid("find logical range is reversed");
  if ((value.source_end as number) < (value.source_start as number)) invalid("find source range is reversed");
}

function validateAnnotationsResult(value: unknown): void {
  assertRecord(value, "annotations result");
  assertNonEmptyString(value.annotationSetRevision, "annotationSetRevision");
  assertNonEmptyString(value.textRevision, "textRevision");
  assertRecord(value.byId, "annotation byId");
  for (const field of ["ambiguous", "changed", "document", "ordered", "resolved"] as const) {
    if (!Array.isArray(value[field])) invalid(`annotation result ${field} must be an array`);
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value !== null
    && typeof value === "object"
    && Object.prototype.toString.call(value) === "[object ArrayBuffer]"
    && typeof (value as ArrayBuffer).byteLength === "number";
}

const WORKER_CAPABILITIES = new Set<string>([
  "canonical-parse",
  "stream-tail-parse",
  "find-index",
  "annotation-resolve",
  "snapshot-hydration",
  "transferable-array-buffer",
]);
const WORKER_ERROR_CODES = new Set<string>([
  "invalid-message",
  "unsupported-version",
  "unsupported-operation",
  "invalid-payload",
  "cancelled",
  "parse-failed",
  "worker-failed",
]);
const WORKER_STAGES = new Set<string>([
  "protocol",
  "parse",
  "index",
  "find",
  "annotations",
  "lifecycle",
]);

function invalid(message: string): never {
  throw new MarkdownWorkerProtocolError("invalid-payload", message);
}
