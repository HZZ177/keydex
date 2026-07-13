import { describe, expect, it } from "vitest";

import {
  MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  MarkdownWorkerProtocolError,
  responseMatchesRequest,
  transferableSource,
  validateMarkdownWorkerRequest,
  validateMarkdownWorkerResponse,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import { createMarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { createMarkdownStreamTailPatch } from "@/renderer/markdownRuntime/streaming/StreamTailPatch";

function identity(surface: "file" | "message" = "file") {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface,
    document_id: `${surface}:README.md`,
    revision: "sha256:r1",
    request_id: "request-1",
  } as const;
}

function parseRequest(surface: "file" | "message" = "file"): MarkdownWorkerRequest {
  const content = surface === "file" ? "# File" : "streamed message";
  return {
    ...identity(surface),
    type: "parse-canonical",
    payload: {
      source: {
        kind: "text",
        encoding: "utf-8",
        content,
        byte_length: new TextEncoder().encode(content).byteLength,
      },
      options: {
        renderer_profile: surface === "file" ? "file-preview" : "conversation",
        enable_html: true,
        enable_mdx: false,
      },
    },
  };
}

function snapshotResponse(request: MarkdownWorkerRequest): MarkdownWorkerResponse {
  return {
    ...identity(request.surface),
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
    type: "snapshot-result",
    payload: createMarkdownSnapshot({
      surface: request.surface,
      document_id: request.document_id,
      revision: request.revision,
      renderer_profile: request.surface === "file" ? "file-preview" : "conversation",
      mode: "canonical",
      source_bytes: 6,
      source_characters: 6,
      logical_text: "File",
      line_count: 1,
      blocks: [{
        id: "block-1",
        identity_key: "heading:File",
        content_hash: "hash:file",
        index: 0,
        kind: "heading",
        source_start: 0,
        source_end: 6,
        logical_start: 0,
        logical_end: 4,
        parent_id: null,
        depth: 0,
        line_start: 0,
        line_end: 1,
        inline_spans: [],
        metadata: { heading_level: 1 },
      }],
      outline: [{ id: "outline-1", block_id: "block-1", level: 1, title: "File", source_line: 1 }],
      resources: [],
      stream: { kind: "canonical", finalized: true },
      indexes: {
        line_map_revision: request.revision,
        logical_projection_revision: request.revision,
        source_index_revision: request.revision,
        find_index_revision: null,
        annotation_index_revision: null,
      },
    }),
  };
}

describe("surface-neutral Markdown Worker protocol", () => {
  it.each(["file", "message"] as const)("accepts canonical parse for the %s surface", (surface) => {
    expect(validateMarkdownWorkerRequest(parseRequest(surface))).toEqual(parseRequest(surface));
  });

  it("transfers canonical UTF-8 source buffers without DOM or parser objects", () => {
    const data = new TextEncoder().encode("# transferable").buffer;
    const request: MarkdownWorkerRequest = {
      ...identity(),
      type: "parse-canonical",
      payload: {
        source: { kind: "utf8-buffer", encoding: "utf-8", data, byte_length: data.byteLength },
        options: { renderer_profile: "file-preview", enable_html: true, enable_mdx: false },
      },
    };
    const transfer = transferableSource(request.payload.source);
    const cloned = structuredClone(request, { transfer });

    expect(transfer).toEqual([data]);
    expect(data.byteLength).toBe(0);
    expect(validateMarkdownWorkerRequest(cloned)).toMatchObject({ type: "parse-canonical" });
  });

  it("covers stream-tail parse identity and epoch fields for conversation streaming", () => {
    const request: MarkdownWorkerRequest = {
      ...identity("message"),
      revision: "stream:42",
      type: "parse-stream-tail",
      payload: {
        base_revision: "stream:41",
        base_source_bytes: 1024,
        stream_epoch: 7,
        final: false,
        append: { kind: "text", encoding: "utf-8", content: " tail", byte_length: 5 },
        options: { renderer_profile: "conversation", enable_html: true, enable_mdx: false },
      },
    };

    expect(validateMarkdownWorkerRequest(request)).toEqual(request);
  });

  it("covers find, annotation resolution, cancel, dispose, and capabilities", () => {
    const requests: MarkdownWorkerRequest[] = [
      {
        ...identity(),
        type: "query-find",
        payload: { query: "target", case_sensitive: false, whole_word: false, limit: 100 },
      },
      {
        ...identity(),
        type: "resolve-annotations",
        payload: {
          path: "README.md",
          workspace_id: "workspace-1",
          records: [],
        },
      },
      {
        ...identity(),
        type: "cancel",
        payload: { target_request_id: "parse-1", reason: "superseded" },
      },
      {
        ...identity(),
        type: "dispose",
        payload: { reason: "last consumer detached" },
      },
      {
        ...identity(),
        type: "capabilities",
        payload: { requested: ["canonical-parse", "transferable-array-buffer"] },
      },
    ];

    expect(requests.map((request) => validateMarkdownWorkerRequest(request).type)).toEqual([
      "query-find",
      "resolve-annotations",
      "cancel",
      "dispose",
      "capabilities",
    ]);
  });

  it.each(["surface", "document_id", "revision", "request_id"] as const)(
    "rejects a request missing identity field %s",
    (field) => {
      const request = { ...parseRequest() } as Record<string, unknown>;
      delete request[field];
      expect(() => validateMarkdownWorkerRequest(request)).toThrowError(
        expect.objectContaining({ name: "MarkdownWorkerProtocolError" }),
      );
    },
  );

  it("rejects unknown operations and protocol versions", () => {
    expect(() => validateMarkdownWorkerRequest({ ...parseRequest(), type: "render-dom" }))
      .toThrowError(expect.objectContaining({ code: "unsupported-operation" }));
    expect(() => validateMarkdownWorkerRequest({ ...parseRequest(), protocol_version: "markdown-worker/v0" }))
      .toThrowError(expect.objectContaining({ code: "unsupported-version" }));
  });

  it("rejects malformed source, stream, find, and annotation payloads", () => {
    const malformed = [
      { ...parseRequest(), payload: { source: { kind: "utf8-buffer", encoding: "utf-8", data: {}, byte_length: 1 } } },
      { ...identity("message"), type: "parse-stream-tail", payload: { stream_epoch: -1 } },
      { ...identity(), type: "query-find", payload: { query: 42 } },
      { ...identity(), type: "resolve-annotations", payload: { path: "README.md", workspace_id: "ws", records: {} } },
    ];

    for (const value of malformed) {
      expect(() => validateMarkdownWorkerRequest(value)).toThrowError(
        expect.objectContaining({ code: "invalid-payload" }),
      );
    }
  });

  it.each(["dom", "element", "node", "rect", "pixel", "parser_tree"])(
    "rejects renderer-owned payload field %s",
    (field) => {
      const request = parseRequest() as Extract<MarkdownWorkerRequest, { type: "parse-canonical" }>;
      expect(() => validateMarkdownWorkerRequest({
        ...request,
        payload: { ...request.payload, [field]: {} },
      })).toThrowError(expect.objectContaining({ code: "invalid-payload" }));
    },
  );

  it("validates snapshot, find, annotation, lifecycle, capability, and error responses", () => {
    const request = parseRequest();
    const snapshot = snapshotResponse(request) as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>;
    const nextSnapshot = createMarkdownSnapshot({
      ...snapshot.payload,
      revision: "sha256:r2",
      logical_text: "File next",
      source_characters: 9,
      source_bytes: 9,
      blocks: [],
      outline: [],
    });
    const responses: MarkdownWorkerResponse[] = [
      snapshot,
      {
        ...identity(),
        revision: "sha256:r2",
        type: "stream-tail-patch-result",
        payload: createMarkdownStreamTailPatch(snapshot.payload, nextSnapshot),
      },
      { ...identity(), type: "find-result", payload: { query: "x", matches: [] } },
      {
        ...identity(),
        type: "annotations-result",
        payload: {
          result: {
            ambiguous: [], annotationSetRevision: "a1", byId: {}, changed: [], document: [],
            ordered: [], resolved: [], textRevision: "r1",
          },
        },
      },
      { ...identity(), type: "cancelled", payload: { target_request_id: "parse-1" } },
      { ...identity(), type: "disposed", payload: {} },
      {
        ...identity(),
        type: "capabilities-result",
        payload: { supported: ["canonical-parse"], max_transfer_bytes: 20 * 1024 * 1024 },
      },
      {
        ...identity(),
        type: "error",
        payload: { code: "parse-failed", message: "bad block", stage: "parse", retryable: false },
      },
    ];

    expect(responses.map((response) => validateMarkdownWorkerResponse(response).type)).toEqual(
      responses.map((response) => response.type),
    );
  });

  it("rejects malformed snapshots and error payloads", () => {
    const request = parseRequest();
    const snapshot = snapshotResponse(request);
    expect(() => validateMarkdownWorkerResponse({
      ...snapshot,
      payload: { ...(snapshot as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>).payload, blocks: {} },
    })).toThrowError(expect.objectContaining({ code: "invalid-payload" }));
    expect(() => validateMarkdownWorkerResponse({
      ...identity("message"),
      type: "stream-tail-patch-result",
      payload: { base_revision: "r1", logical_append: "x", blocks: { items: {} } },
    })).toThrowError(expect.objectContaining({ code: "invalid-payload" }));
    expect(() => validateMarkdownWorkerResponse({
      ...identity(),
      type: "error",
      payload: { code: "parse-failed", message: "bad", stage: "parse", retryable: "yes" },
    })).toThrowError(expect.objectContaining({ code: "invalid-payload" }));
  });

  it("detects stale request, revision, document, and surface responses", () => {
    const request = parseRequest();
    const response = snapshotResponse(request);
    expect(responseMatchesRequest(request, response)).toBe(true);
    expect(responseMatchesRequest(request, { ...response, request_id: "old-request" })).toBe(false);
    expect(responseMatchesRequest(request, { ...response, revision: "sha256:old" })).toBe(false);
    expect(responseMatchesRequest(request, { ...response, document_id: "file:other.md" })).toBe(false);
    expect(responseMatchesRequest(request, { ...response, surface: "message" })).toBe(false);
  });

  it("exposes stable protocol errors without carrying source text", () => {
    const error = new MarkdownWorkerProtocolError("invalid-message", "message identity mismatch");
    expect(error).toMatchObject({ name: "MarkdownWorkerProtocolError", code: "invalid-message" });
    expect(JSON.stringify(error)).not.toContain("# File");
  });
});
