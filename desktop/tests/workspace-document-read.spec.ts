import { describe, expect, it, vi } from "vitest";

import {
  createDocumentReadMessages,
  createHttpClient,
  createWorkspaceRuntime,
  type DocumentReadRequest,
} from "@/runtime";

function streamingResponse(request: DocumentReadRequest, content: string, revision: string): Response {
  const messages = createDocumentReadMessages({ request, content, revision });
  const bytes = new TextEncoder().encode(messages.map((message) => JSON.stringify(message)).join("\n"));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 17, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("WorkspaceRuntime document read", () => {
  it.each([
    [{ sessionId: "session-1" } as const, "/api/sessions/session-1/workspace/read/document"],
    [{ workspaceId: "workspace-1" } as const, "/api/workspaces/workspace-1/read/document"],
  ])("streams %o through %s", async (scope, expectedPath) => {
    const content = "# Workspace\n\n批注";
    const diagnostics = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`http://127.0.0.1:8765${expectedPath}`);
      const readRequest = JSON.parse(String(init?.body)) as DocumentReadRequest;
      expect(readRequest).toMatchObject({
        source: "workspace",
        path: "docs/README.md",
        expected_revision: "sha256:before",
      });
      return streamingResponse(readRequest, content, "sha256:before");
    });
    const runtime = createWorkspaceRuntime(createHttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher,
    }));

    const result = await runtime.readDocument(scope, "docs/README.md", {
      consumerId: "view-1",
      expectedRevision: "sha256:before",
      onDiagnostics: diagnostics,
    });

    expect(result).toMatchObject({
      source: "workspace",
      path: "docs/README.md",
      revision: "sha256:before",
      content,
    });
    expect(diagnostics).toHaveBeenCalled();
    expect(diagnostics.mock.calls.at(-1)?.[0]).toMatchObject({ complete: true });
  });

  it("shares one network response when two views request the same document", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const readRequest = JSON.parse(String(init?.body)) as DocumentReadRequest;
      await Promise.resolve();
      return streamingResponse(readRequest, "shared", "sha256:shared");
    });
    const runtime = createWorkspaceRuntime(createHttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher,
    }));
    const scope = { workspaceId: "workspace-1" } as const;

    const first = runtime.readDocument(scope, "shared.md", { consumerId: "view-1" });
    const second = runtime.readDocument(scope, "shared.md", { consumerId: "view-2" });

    await expect(first).resolves.toMatchObject({ content: "shared" });
    await expect(second).resolves.toMatchObject({ content: "shared" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts the shared request after its final consumer releases", async () => {
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        networkSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const runtime = createWorkspaceRuntime(createHttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher,
    }));
    const pending = runtime.readDocument(
      { workspaceId: "workspace-1" },
      "pending.md",
      { consumerId: "view-1" },
    );
    await Promise.resolve();

    runtime.releaseDocumentConsumer("view-1");

    await expect(pending).rejects.toBeDefined();
    expect(networkSignal?.aborted).toBe(true);
  });
});
