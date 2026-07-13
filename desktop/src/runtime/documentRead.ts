export const DOCUMENT_READ_PROTOCOL_VERSION = "document-read/v1";
export const DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_DOCUMENT_CHUNK_BYTES = 256 * 1024;

export type DocumentReadSource = "workspace" | "local-preview" | "tauri";
export type DocumentReadTransport = "whole" | "chunked";
export type DocumentReadErrorCode =
  | "not_found"
  | "too_large"
  | "unsupported_encoding"
  | "revision_conflict"
  | "changed_during_read"
  | "cancelled"
  | "invalid_request"
  | "invalid_chunk"
  | "missing_chunks"
  | "io_error";

export interface DocumentReadRequest {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly document_id: string;
  readonly source: DocumentReadSource;
  readonly path: string;
  readonly expected_revision?: string | null;
  readonly preferred_transport: "auto" | DocumentReadTransport;
  readonly chunk_size_bytes: number;
  readonly max_bytes: number;
}

export interface DocumentReadStartMessage {
  readonly protocol_version: string;
  readonly type: "start";
  readonly request_id: string;
  readonly document_id: string;
  readonly source: DocumentReadSource;
  readonly path: string;
  readonly revision: string;
  readonly encoding: "utf-8";
  readonly transport: DocumentReadTransport;
  readonly total_bytes: number;
  readonly chunk_size_bytes: number;
  readonly chunk_count: number;
}

export interface DocumentReadChunkMessage {
  readonly protocol_version: string;
  readonly type: "chunk";
  readonly request_id: string;
  readonly document_id: string;
  readonly revision: string;
  readonly chunk_index: number;
  readonly offset_bytes: number;
  readonly byte_length: number;
  readonly content: string;
}

export interface DocumentReadCompleteMessage {
  readonly protocol_version: string;
  readonly type: "complete";
  readonly request_id: string;
  readonly document_id: string;
  readonly revision: string;
  readonly total_bytes: number;
  readonly chunk_count: number;
}

export interface DocumentReadErrorMessage {
  readonly protocol_version: string;
  readonly type: "error";
  readonly request_id: string;
  readonly document_id: string;
  readonly revision?: string | null;
  readonly code: DocumentReadErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type DocumentReadMessage =
  | DocumentReadStartMessage
  | DocumentReadChunkMessage
  | DocumentReadCompleteMessage
  | DocumentReadErrorMessage;

export interface DocumentReadResult {
  readonly document_id: string;
  readonly source: DocumentReadSource;
  readonly path: string;
  readonly revision: string;
  readonly encoding: "utf-8";
  readonly total_bytes: number;
  readonly content: string;
}

export class DocumentReadProtocolError extends Error {
  constructor(
    readonly code: DocumentReadErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DocumentReadProtocolError";
  }
}

export class DocumentReadAssembler {
  private startMessage: DocumentReadStartMessage | null = null;
  private readonly chunks = new Map<number, DocumentReadChunkMessage>();
  private result: DocumentReadResult | null = null;
  private cancelled = false;

  constructor(readonly request: DocumentReadRequest) {
    validateRequest(request);
  }

  push(message: DocumentReadMessage): "accepted" | "duplicate" | DocumentReadResult {
    this.assertActive();
    validateEnvelope(this.request, message);
    if (message.type === "error") {
      throw new DocumentReadProtocolError(message.code, message.message, message.retryable);
    }
    if (message.type === "start") {
      return this.acceptStart(message);
    }
    const start = this.requireStart();
    validateMessageRevision(start, message);
    if (message.type === "chunk") {
      return this.acceptChunk(start, message);
    }
    return this.acceptComplete(start, message);
  }

  cancel(message = "Document preview read cancelled"): DocumentReadErrorMessage {
    this.cancelled = true;
    return Object.freeze({
      protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
      type: "error",
      request_id: this.request.request_id,
      document_id: this.request.document_id,
      revision: this.startMessage?.revision ?? null,
      code: "cancelled",
      message,
      retryable: true,
    });
  }

  get completed(): DocumentReadResult | null {
    return this.result;
  }

  private acceptStart(message: DocumentReadStartMessage): "accepted" | "duplicate" {
    validateStart(this.request, message);
    if (this.startMessage) {
      if (sameStart(this.startMessage, message)) return "duplicate";
      throw new DocumentReadProtocolError("invalid_request", "Conflicting document read start message");
    }
    this.startMessage = message;
    return "accepted";
  }

  private acceptChunk(
    start: DocumentReadStartMessage,
    message: DocumentReadChunkMessage,
  ): "accepted" | "duplicate" {
    validateChunk(start, message);
    const existing = this.chunks.get(message.chunk_index);
    if (existing) {
      if (sameChunk(existing, message)) return "duplicate";
      throw new DocumentReadProtocolError("invalid_chunk", `Conflicting duplicate chunk ${message.chunk_index}`);
    }
    this.chunks.set(message.chunk_index, message);
    return "accepted";
  }

  private acceptComplete(
    start: DocumentReadStartMessage,
    message: DocumentReadCompleteMessage,
  ): DocumentReadResult {
    if (message.total_bytes !== start.total_bytes || message.chunk_count !== start.chunk_count) {
      throw new DocumentReadProtocolError("changed_during_read", "Document size or chunk count changed during read", true);
    }
    const missing = Array.from({ length: start.chunk_count }, (_value, index) => index)
      .filter((index) => !this.chunks.has(index));
    if (missing.length) {
      throw new DocumentReadProtocolError("missing_chunks", `Missing document chunks: ${missing.join(",")}`, true);
    }
    const ordered = Array.from(this.chunks.values()).sort((left, right) => left.chunk_index - right.chunk_index);
    let offset = 0;
    for (const chunk of ordered) {
      if (chunk.offset_bytes !== offset) {
        throw new DocumentReadProtocolError("invalid_chunk", `Chunk ${chunk.chunk_index} has a non-contiguous offset`);
      }
      offset += chunk.byte_length;
    }
    if (offset !== start.total_bytes) {
      throw new DocumentReadProtocolError("missing_chunks", `Assembled ${offset} of ${start.total_bytes} bytes`, true);
    }
    const content = ordered.map((chunk) => chunk.content).join("");
    if (utf8Length(content) !== start.total_bytes) {
      throw new DocumentReadProtocolError("invalid_chunk", "Assembled UTF-8 byte length does not match start message");
    }
    this.result = Object.freeze({
      document_id: start.document_id,
      source: start.source,
      path: start.path,
      revision: start.revision,
      encoding: start.encoding,
      total_bytes: start.total_bytes,
      content,
    });
    return this.result;
  }

  private requireStart(): DocumentReadStartMessage {
    if (!this.startMessage) {
      throw new DocumentReadProtocolError("invalid_request", "Document chunk arrived before start message");
    }
    return this.startMessage;
  }

  private assertActive(): void {
    if (this.cancelled) {
      throw new DocumentReadProtocolError("cancelled", "Document preview read was cancelled", true);
    }
    if (this.result) {
      throw new DocumentReadProtocolError("invalid_request", "Document preview read is already complete");
    }
  }
}

export function createDocumentReadRequest(
  options: Omit<DocumentReadRequest, "protocol_version" | "chunk_size_bytes" | "max_bytes"> & {
    readonly chunk_size_bytes?: number;
    readonly max_bytes?: number;
  },
): DocumentReadRequest {
  const request = Object.freeze({
    ...options,
    protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
    chunk_size_bytes: options.chunk_size_bytes ?? DEFAULT_DOCUMENT_CHUNK_BYTES,
    max_bytes: options.max_bytes ?? DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
  });
  validateRequest(request);
  return request;
}

export function createDocumentReadMessages(options: {
  readonly request: DocumentReadRequest;
  readonly revision: string;
  readonly content: string;
  readonly transport?: DocumentReadTransport;
}): readonly DocumentReadMessage[] {
  const { request, revision, content } = options;
  validateRequest(request);
  if (!revision.trim()) throw new DocumentReadProtocolError("invalid_request", "Document revision is required");
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > request.max_bytes) {
    throw new DocumentReadProtocolError("too_large", `Document exceeds preview limit ${request.max_bytes}`);
  }
  const transport = options.transport ?? selectTransport(request, bytes.byteLength);
  const rawChunks = transport === "whole"
    ? (bytes.byteLength ? [{ offset: 0, bytes }] : [])
    : splitUtf8Bytes(bytes, request.chunk_size_bytes);
  const start: DocumentReadStartMessage = Object.freeze({
    protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
    type: "start",
    request_id: request.request_id,
    document_id: request.document_id,
    source: request.source,
    path: request.path,
    revision,
    encoding: "utf-8",
    transport,
    total_bytes: bytes.byteLength,
    chunk_size_bytes: transport === "whole" ? Math.max(1, bytes.byteLength) : request.chunk_size_bytes,
    chunk_count: rawChunks.length,
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: DocumentReadChunkMessage[] = rawChunks.map((chunk, index) => Object.freeze({
    protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
    type: "chunk",
    request_id: request.request_id,
    document_id: request.document_id,
    revision,
    chunk_index: index,
    offset_bytes: chunk.offset,
    byte_length: chunk.bytes.byteLength,
    content: decoder.decode(chunk.bytes),
  }));
  const complete: DocumentReadCompleteMessage = Object.freeze({
    protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
    type: "complete",
    request_id: request.request_id,
    document_id: request.document_id,
    revision,
    total_bytes: bytes.byteLength,
    chunk_count: chunks.length,
  });
  return Object.freeze([start, ...chunks, complete]);
}

export function createWholeDocumentReadResult(options: {
  readonly request: DocumentReadRequest;
  readonly revision: string;
  readonly content: string;
  readonly byteLength: number;
}): DocumentReadResult {
  const { request, revision, content, byteLength } = options;
  validateRequest(request);
  if (!revision.trim()) throw new DocumentReadProtocolError("invalid_request", "Document revision is required");
  if (byteLength > request.max_bytes) {
    throw new DocumentReadProtocolError("too_large", `Document exceeds preview limit ${request.max_bytes}`);
  }
  const chunkCount = byteLength === 0 ? 0 : 1;
  const assembler = new DocumentReadAssembler(request);
  assembler.push(Object.freeze({
    protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
    type: "start",
    request_id: request.request_id,
    document_id: request.document_id,
    source: request.source,
    path: request.path,
    revision,
    encoding: "utf-8",
    transport: "whole",
    total_bytes: byteLength,
    chunk_size_bytes: Math.max(1, byteLength),
    chunk_count: chunkCount,
  }));
  if (chunkCount) {
    assembler.push(Object.freeze({
      protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
      type: "chunk",
      request_id: request.request_id,
      document_id: request.document_id,
      revision,
      chunk_index: 0,
      offset_bytes: 0,
      byte_length: byteLength,
      content,
    }));
  }
  const result = assembler.push(Object.freeze({
    protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
    type: "complete",
    request_id: request.request_id,
    document_id: request.document_id,
    revision,
    total_bytes: byteLength,
    chunk_count: chunkCount,
  }));
  if (typeof result !== "object") {
    throw new DocumentReadProtocolError("missing_chunks", "Whole document did not produce a result", true);
  }
  return result;
}

function validateRequest(request: DocumentReadRequest): void {
  if (request.protocol_version !== DOCUMENT_READ_PROTOCOL_VERSION) {
    throw new DocumentReadProtocolError("invalid_request", `Unsupported document read protocol ${request.protocol_version}`);
  }
  if (!request.request_id.trim() || !request.document_id.trim() || !request.path.trim()) {
    throw new DocumentReadProtocolError("invalid_request", "request_id, document_id, and path are required");
  }
  if (!Number.isSafeInteger(request.chunk_size_bytes) || request.chunk_size_bytes < 4) {
    throw new DocumentReadProtocolError("invalid_request", "chunk_size_bytes must be an integer >= 4");
  }
  if (!Number.isSafeInteger(request.max_bytes) || request.max_bytes < 0) {
    throw new DocumentReadProtocolError("invalid_request", "max_bytes must be a non-negative integer");
  }
}

function validateEnvelope(request: DocumentReadRequest, message: DocumentReadMessage): void {
  if (message.protocol_version !== DOCUMENT_READ_PROTOCOL_VERSION) {
    throw new DocumentReadProtocolError("invalid_request", `Unsupported message protocol ${message.protocol_version}`);
  }
  if (message.request_id !== request.request_id || message.document_id !== request.document_id) {
    throw new DocumentReadProtocolError("invalid_request", "Document read message identity mismatch");
  }
}

function validateStart(request: DocumentReadRequest, message: DocumentReadStartMessage): void {
  if ((message.encoding as string).toLowerCase() !== "utf-8") {
    throw new DocumentReadProtocolError("unsupported_encoding", `Unsupported preview encoding ${message.encoding}`);
  }
  if (!message.revision.trim()) {
    throw new DocumentReadProtocolError("invalid_request", "Document revision is required");
  }
  if (request.expected_revision && request.expected_revision !== message.revision) {
    throw new DocumentReadProtocolError("revision_conflict", "Document revision does not match expected revision", true);
  }
  if (!Number.isSafeInteger(message.total_bytes) || message.total_bytes < 0 || message.total_bytes > request.max_bytes) {
    throw new DocumentReadProtocolError("too_large", `Document byte size ${message.total_bytes} exceeds preview contract`);
  }
  if (!Number.isSafeInteger(message.chunk_count) || message.chunk_count < 0) {
    throw new DocumentReadProtocolError("invalid_request", "Invalid document chunk count");
  }
  if (message.transport === "whole" && message.chunk_count !== (message.total_bytes === 0 ? 0 : 1)) {
    throw new DocumentReadProtocolError("invalid_request", "Whole transport must contain zero or one chunk");
  }
}

function validateMessageRevision(
  start: DocumentReadStartMessage,
  message: DocumentReadChunkMessage | DocumentReadCompleteMessage,
): void {
  if (message.revision !== start.revision) {
    throw new DocumentReadProtocolError("changed_during_read", "Document revision changed during read", true);
  }
}

function validateChunk(start: DocumentReadStartMessage, message: DocumentReadChunkMessage): void {
  if (!Number.isSafeInteger(message.chunk_index) || message.chunk_index < 0 || message.chunk_index >= start.chunk_count) {
    throw new DocumentReadProtocolError("invalid_chunk", `Chunk index ${message.chunk_index} is out of range`);
  }
  if (!Number.isSafeInteger(message.offset_bytes) || message.offset_bytes < 0) {
    throw new DocumentReadProtocolError("invalid_chunk", "Chunk offset must be non-negative");
  }
  if (utf8Length(message.content) !== message.byte_length) {
    throw new DocumentReadProtocolError("invalid_chunk", `Chunk ${message.chunk_index} UTF-8 byte length mismatch`);
  }
  if (message.offset_bytes + message.byte_length > start.total_bytes) {
    throw new DocumentReadProtocolError("invalid_chunk", `Chunk ${message.chunk_index} exceeds document byte size`);
  }
}

function splitUtf8Bytes(bytes: Uint8Array, maxBytes: number): Array<{ offset: number; bytes: Uint8Array }> {
  const chunks: Array<{ offset: number; bytes: Uint8Array }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + maxBytes, bytes.byteLength);
    while (end < bytes.byteLength && end > offset && isUtf8Continuation(bytes[end])) end -= 1;
    if (end === offset) {
      end = Math.min(offset + 1, bytes.byteLength);
      while (end < bytes.byteLength && isUtf8Continuation(bytes[end])) end += 1;
    }
    chunks.push({ offset, bytes: bytes.slice(offset, end) });
    offset = end;
  }
  return chunks;
}

function selectTransport(request: DocumentReadRequest, totalBytes: number): DocumentReadTransport {
  if (request.preferred_transport !== "auto") return request.preferred_transport;
  return totalBytes <= request.chunk_size_bytes ? "whole" : "chunked";
}

function isUtf8Continuation(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function sameStart(left: DocumentReadStartMessage, right: DocumentReadStartMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameChunk(left: DocumentReadChunkMessage, right: DocumentReadChunkMessage): boolean {
  return left.offset_bytes === right.offset_bytes
    && left.byte_length === right.byte_length
    && left.content === right.content
    && left.revision === right.revision;
}
