import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createDocumentReadMessages,
  createHttpClient,
  createLocalPreviewRuntime,
  type DocumentReadRequest,
  type LocalPreviewFileResponse,
  type TauriInvoke,
} from "@/runtime";

function tauriRuntime(
  reader: (path: string) => Promise<LocalPreviewFileResponse>,
) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    expect(command).toBe("read_text_file");
    return reader(String(args?.path ?? ""));
  }) as unknown as TauriInvoke;
  return {
    invoke,
    runtime: createLocalPreviewRuntime(createHttpClient(), {
      invoke,
      isTauriRuntime: () => true,
    }),
  };
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

describe("LocalPreviewRuntime document-read/v1", () => {
  it("writes Tauri-opened local files through the guarded backend endpoint", async () => {
    const path = "D:/notes/local.md";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8765/api/local-preview/write/document");
      expect(JSON.parse(String(init?.body))).toEqual({
        protocol_version: "document-write/v1",
        path,
        content: "after",
        expected_revision: "sha256:before",
      });
      return Response.json({
        protocol_version: "document-write/v1",
        path,
        revision: "sha256:after",
        encoding: "utf-8",
        total_bytes: 5,
      });
    });
    const runtime = createLocalPreviewRuntime(
      createHttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }),
      { isTauriRuntime: () => true },
    );

    await expect(runtime.writeDocument(path, "after", {
      expectedRevision: "sha256:before",
    })).resolves.toMatchObject({ revision: "sha256:after" });
  });

  it.each([1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024])(
    "adapts a %i-byte Tauri response through the shared snapshot pipeline",
    async (size) => {
      const content = "x".repeat(size);
      const path = "D:/中文 目录/large file.md";
      const { runtime } = tauriRuntime(async () => ({ path, content, encoding: "utf-8" }));

      const result = await runtime.readDocument(path);

      expect(result).toEqual({
        document_id: `tauri:${path}`,
        source: "tauri",
        path,
        revision: sha256(content),
        encoding: "utf-8",
        total_bytes: size,
        content,
      });
    },
    30_000,
  );

  it("changes revision after an external modification without mutating the old snapshot", async () => {
    let content = "before";
    const path = "D:/notes/revision.md";
    const { runtime } = tauriRuntime(async () => ({ path, content, encoding: "utf-8" }));

    const before = await runtime.readDocument(path);
    content = "after";
    const after = await runtime.readDocument(path);

    expect(before.content).toBe("before");
    expect(after.content).toBe("after");
    expect(before.revision).toBe(sha256("before"));
    expect(after.revision).toBe(sha256("after"));
    expect(after.revision).not.toBe(before.revision);
  });

  it.each([
    ["The system cannot find the file specified", "not_found"],
    ["stream did not contain valid UTF-8", "unsupported_encoding"],
    ["Access is denied. (os error 5)", "io_error"],
  ] as const)("normalizes Tauri failure %s to %s", async (message, code) => {
    const { runtime } = tauriRuntime(async () => {
      throw new Error(message);
    });

    await expect(runtime.readDocument("D:/notes/failure.md")).rejects.toMatchObject({
      name: "DocumentReadProtocolError",
      code,
    });
  });

  it("honors cancellation after the in-flight Tauri command returns", async () => {
    let resolveRead!: (value: LocalPreviewFileResponse) => void;
    const pending = new Promise<LocalPreviewFileResponse>((resolve) => {
      resolveRead = resolve;
    });
    const { runtime } = tauriRuntime(() => pending);
    const controller = new AbortController();

    const result = runtime.readDocument("D:/notes/cancel.md", { signal: controller.signal });
    controller.abort();
    resolveRead({ path: "D:/notes/cancel.md", content: "late", encoding: "utf-8" });

    await expect(result).rejects.toMatchObject({ code: "cancelled", retryable: true });
  });

  it("keeps fast A/B reads isolated when B resolves first", async () => {
    const resolvers = new Map<string, (value: LocalPreviewFileResponse) => void>();
    const { runtime } = tauriRuntime((path) => new Promise((resolve) => resolvers.set(path, resolve)));

    const readA = runtime.readDocument("D:/A.md");
    const readB = runtime.readDocument("D:/B.md");
    await Promise.resolve();
    resolvers.get("D:/B.md")?.({ path: "D:/B.md", content: "B", encoding: "utf-8" });
    resolvers.get("D:/A.md")?.({ path: "D:/A.md", content: "A", encoding: "utf-8" });

    await expect(readB).resolves.toMatchObject({ path: "D:/B.md", content: "B" });
    await expect(readA).resolves.toMatchObject({ path: "D:/A.md", content: "A" });
  });

  it("assembles Browser local preview NDJSON with the same result semantics", async () => {
    const path = "C:/outside/browser.md";
    const content = "# Browser\n\n批注";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as DocumentReadRequest;
      expect(request.source).toBe("local-preview");
      expect(request.path).toBe(path);
      const messages = createDocumentReadMessages({
        request,
        revision: sha256(content),
        content,
      });
      return new Response(messages.map((message) => JSON.stringify(message)).join("\n"), {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    const runtime = createLocalPreviewRuntime(
      createHttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }),
      { isTauriRuntime: () => false },
    );

    await expect(runtime.readDocument(path)).resolves.toEqual({
      document_id: `local-preview:${path}`,
      source: "local-preview",
      path,
      revision: sha256(content),
      encoding: "utf-8",
      total_bytes: new TextEncoder().encode(content).byteLength,
      content,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects Tauri content above the 20MiB preview contract", async () => {
    const path = "D:/too-large.md";
    const { runtime } = tauriRuntime(async () => ({
      path,
      content: "x".repeat(20 * 1024 * 1024 + 1),
      encoding: "utf-8",
    }));

    await expect(runtime.readDocument(path)).rejects.toMatchObject({
      name: "DocumentReadProtocolError",
      code: "too_large",
    });
  });
});
