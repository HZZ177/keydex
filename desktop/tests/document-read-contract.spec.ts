import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
  DOCUMENT_READ_PROTOCOL_VERSION,
  DocumentReadAssembler,
  DocumentReadProtocolError,
  createDocumentReadMessages,
  createDocumentReadRequest,
  createWholeDocumentReadResult,
  type DocumentReadChunkMessage,
  type DocumentReadCompleteMessage,
  type DocumentReadStartMessage,
} from "@/runtime/documentRead";

function request(expectedRevision?: string) {
  return createDocumentReadRequest({
    request_id: "request-1",
    document_id: "workspace:fixture.md",
    source: "workspace",
    path: "fixture.md",
    expected_revision: expectedRevision,
    preferred_transport: "auto",
  });
}

function assemble(messages: ReturnType<typeof createDocumentReadMessages>, readRequest = request()) {
  const assembler = new DocumentReadAssembler(readRequest);
  let result = null;
  for (const message of messages) {
    const next = assembler.push(message);
    if (typeof next === "object") result = next;
  }
  return result;
}

describe("document read contract", () => {
  it("expresses 512 KiB minus/exact/plus one and a 10 MiB document", () => {
    for (const size of [512 * 1024 - 1, 512 * 1024, 512 * 1024 + 1, 10 * 1024 * 1024]) {
      const content = "x".repeat(size);
      const messages = createDocumentReadMessages({ request: request(), revision: `revision-${size}`, content });
      const result = assemble(messages);
      expect(result?.total_bytes).toBe(size);
      expect(result?.content.length).toBe(size);
    }
    expect(DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it("keeps UTF-8 code points intact at chunk boundaries", () => {
    const readRequest = createDocumentReadRequest({
      request_id: "utf8",
      document_id: "local:中文.md",
      source: "local-preview",
      path: "中文.md",
      preferred_transport: "chunked",
      chunk_size_bytes: 5,
    });
    const content = "甲乙丙丁👩🏽‍💻tail";
    const messages = createDocumentReadMessages({ request: readRequest, revision: "utf8-revision", content });
    const chunks = messages.filter((message): message is DocumentReadChunkMessage => message.type === "chunk");
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk.content).byteLength === chunk.byte_length)).toBe(true);
    expect(assemble(messages, readRequest)?.content).toBe(content);
  });

  it("accepts out-of-order chunks and identical duplicate delivery", () => {
    const readRequest = createDocumentReadRequest({
      request_id: "ordered",
      document_id: "workspace:ordered.md",
      source: "workspace",
      path: "ordered.md",
      preferred_transport: "chunked",
      chunk_size_bytes: 6,
    });
    const messages = createDocumentReadMessages({ request: readRequest, revision: "r1", content: "alpha beta gamma" });
    const start = messages[0] as DocumentReadStartMessage;
    const chunks = messages.slice(1, -1) as DocumentReadChunkMessage[];
    const complete = messages.at(-1) as DocumentReadCompleteMessage;
    const assembler = new DocumentReadAssembler(readRequest);
    assembler.push(start);
    expect(assembler.push(chunks[1])).toBe("accepted");
    expect(assembler.push(chunks[1])).toBe("duplicate");
    expect(assembler.push(chunks[0])).toBe("accepted");
    expect(assembler.push(chunks[2])).toBe("accepted");
    expect(assembler.push(complete)).toMatchObject({ content: "alpha beta gamma", revision: "r1" });
  });

  it("rejects conflicting duplicate and missing chunks", () => {
    const readRequest = createDocumentReadRequest({
      request_id: "missing",
      document_id: "workspace:missing.md",
      source: "workspace",
      path: "missing.md",
      preferred_transport: "chunked",
      chunk_size_bytes: 6,
    });
    const messages = createDocumentReadMessages({ request: readRequest, revision: "r1", content: "alpha beta gamma" });
    const start = messages[0] as DocumentReadStartMessage;
    const chunk = messages[1] as DocumentReadChunkMessage;
    const complete = messages.at(-1) as DocumentReadCompleteMessage;
    const duplicateAssembler = new DocumentReadAssembler(readRequest);
    duplicateAssembler.push(start);
    duplicateAssembler.push(chunk);
    expect(() => duplicateAssembler.push({ ...chunk, content: "different" })).toThrowError(
      expect.objectContaining({ code: "invalid_chunk" }),
    );

    const missingAssembler = new DocumentReadAssembler(readRequest);
    missingAssembler.push(start);
    missingAssembler.push(chunk);
    expect(() => missingAssembler.push(complete)).toThrowError(expect.objectContaining({ code: "missing_chunks" }));
  });

  it("rejects revision conflict and a file changing during read", () => {
    const expected = request("expected-revision");
    const messages = createDocumentReadMessages({ request: expected, revision: "actual-revision", content: "content" });
    expect(() => new DocumentReadAssembler(expected).push(messages[0])).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );

    const stableRequest = request();
    const stableMessages = createDocumentReadMessages({ request: stableRequest, revision: "r1", content: "content" });
    const assembler = new DocumentReadAssembler(stableRequest);
    for (const message of stableMessages.slice(0, -1)) assembler.push(message);
    expect(() => assembler.push({ ...(stableMessages.at(-1) as DocumentReadCompleteMessage), revision: "r2" })).toThrowError(
      expect.objectContaining({ code: "changed_during_read" }),
    );
  });

  it("cancels without accepting later chunks", () => {
    const readRequest = request();
    const messages = createDocumentReadMessages({ request: readRequest, revision: "r1", content: "content" });
    const assembler = new DocumentReadAssembler(readRequest);
    assembler.push(messages[0]);
    expect(assembler.cancel()).toMatchObject({ code: "cancelled", retryable: true });
    expect(() => assembler.push(messages[1])).toThrowError(expect.objectContaining({ code: "cancelled" }));
  });

  it("adapts whole UTF-8 content without materializing a second message copy", () => {
    const readRequest = request();
    const content = "批注 👩🏽‍💻\n".repeat(100);
    const byteLength = new TextEncoder().encode(content).byteLength;

    expect(createWholeDocumentReadResult({
      request: readRequest,
      revision: "sha256:whole",
      content,
      byteLength,
    })).toEqual({
      document_id: readRequest.document_id,
      source: "workspace",
      path: readRequest.path,
      revision: "sha256:whole",
      encoding: "utf-8",
      total_bytes: byteLength,
      content,
    });
    expect(() => createWholeDocumentReadResult({
      request: readRequest,
      revision: "sha256:whole",
      content,
      byteLength: byteLength - 1,
    })).toThrowError(expect.objectContaining({ code: "invalid_chunk" }));
  });

  it("rejects non UTF-8 start metadata and stable producer errors", () => {
    const readRequest = request();
    const assembler = new DocumentReadAssembler(readRequest);
    const badStart = {
      ...(createDocumentReadMessages({ request: readRequest, revision: "r1", content: "content" })[0] as DocumentReadStartMessage),
      encoding: "utf-16",
    } as unknown as DocumentReadStartMessage;
    expect(() => assembler.push(badStart)).toThrowError(expect.objectContaining({ code: "unsupported_encoding" }));
    expect(() => assembler.push({
      protocol_version: DOCUMENT_READ_PROTOCOL_VERSION,
      type: "error",
      request_id: readRequest.request_id,
      document_id: readRequest.document_id,
      code: "io_error",
      message: "read failed",
      retryable: true,
    })).toThrowError(expect.objectContaining({ code: "io_error", retryable: true }));
  });

  it("keeps the Agent read_file 512 KiB boundary outside this preview contract", () => {
    expect(DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DocumentReadProtocolError).toBeDefined();
  });
});
