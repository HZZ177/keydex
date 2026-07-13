import { describe, expect, it, vi } from "vitest";

import {
  createDocumentReadMessages,
  createDocumentReadRequest,
  createHttpClient,
  createLocalPreviewRuntime,
  type TauriInvoke,
} from "@/runtime";
import { readDocumentNdjsonResponse } from "@/renderer/components/workspace/fileMarkdownAdapter/transport";
import { INGRESS_PERFORMANCE_CONTRACT } from "./fixtures/ingressPerformance";

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

describe("markdown ingress performance contract", () => {
  it("keeps formal, stress, and real desktop surface gates explicit", () => {
    expect(INGRESS_PERFORMANCE_CONTRACT.schemaVersion).toBe("markdown-ingress-performance/v1");
    expect(INGRESS_PERFORMANCE_CONTRACT.quickSizes).toEqual([
      512 * 1024 - 1,
      512 * 1024 + 1,
      1024 * 1024,
      5 * 1024 * 1024,
      10 * 1024 * 1024,
    ]);
    expect(INGRESS_PERFORMANCE_CONTRACT.stressSizes).toEqual([20 * 1024 * 1024]);
    expect(INGRESS_PERFORMANCE_CONTRACT.officialSurfaces).toContain("tauri-webview2");
    expect(INGRESS_PERFORMANCE_CONTRACT.actualTauriRequired).toBe(true);
    expect(INGRESS_PERFORMANCE_CONTRACT.chromeMaySubstituteTauri).toBe(false);
  });

  it("keeps the TypeScript Tauri adapter within its 10MiB quick gate", async () => {
    const content = "x".repeat(10 * 1024 * 1024);
    const invoke = vi.fn(async () => ({
      path: "D:/fixtures/10m.md",
      content,
      encoding: "utf-8",
    })) as unknown as TauriInvoke;
    const runtime = createLocalPreviewRuntime(createHttpClient(), {
      invoke,
      isTauriRuntime: () => true,
    });
    const durations: number[] = [];

    for (let index = 0; index < INGRESS_PERFORMANCE_CONTRACT.quickSamples; index += 1) {
      const startedAt = performance.now();
      const result = await runtime.readDocument("D:/fixtures/10m.md");
      durations.push(performance.now() - startedAt);
      expect(result.total_bytes).toBe(10 * 1024 * 1024);
    }

    expect(percentile(durations, 0.95)).toBeLessThan(
      INGRESS_PERFORMANCE_CONTRACT.budgets.tauriAdapter10MiBP95Ms,
    );
  }, 15_000);

  it("keeps incremental 10MiB NDJSON assembly within time and buffer gates", async () => {
    const content = "markdown block\n".repeat(Math.ceil((10 * 1024 * 1024) / 15)).slice(0, 10 * 1024 * 1024);
    const request = createDocumentReadRequest({
      request_id: "transport-10m",
      document_id: "workspace:10m.md",
      source: "workspace",
      path: "10m.md",
      preferred_transport: "chunked",
    });
    const messages = createDocumentReadMessages({ request, revision: "r1", content });
    const ndjson = new TextEncoder().encode(messages.map((message) => JSON.stringify(message)).join("\n"));
    let offset = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= ndjson.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, ndjson.byteLength);
        controller.enqueue(ndjson.slice(offset, end));
        offset = end;
      },
    }, { highWaterMark: 0 }));
    let peakBufferedTextBytes = 0;
    const startedAt = performance.now();
    const result = await readDocumentNdjsonResponse(response, request, {
      diagnosticsIntervalMs: 0,
      onDiagnostics: (sample) => {
        peakBufferedTextBytes = Math.max(peakBufferedTextBytes, sample.peakBufferedTextBytes);
      },
    });
    const duration = performance.now() - startedAt;

    expect(result.total_bytes).toBe(10 * 1024 * 1024);
    expect(duration).toBeLessThan(
      INGRESS_PERFORMANCE_CONTRACT.budgets.frontendTransport10MiBP95Ms,
    );
    expect(peakBufferedTextBytes).toBeLessThanOrEqual(
      INGRESS_PERFORMANCE_CONTRACT.budgets.maxBufferedTransportBytes,
    );
  }, 15_000);

  it.runIf(process.env.KEYDEX_MARKDOWN_STRESS === "1")(
    "keeps the opt-in 20MiB Tauri adapter stress path functional",
    async () => {
      const size = INGRESS_PERFORMANCE_CONTRACT.stressSizes[0];
      const content = "x".repeat(size);
      const invoke = vi.fn(async () => ({
        path: "D:/fixtures/20m.md",
        content,
        encoding: "utf-8",
      })) as unknown as TauriInvoke;
      const runtime = createLocalPreviewRuntime(createHttpClient(), {
        invoke,
        isTauriRuntime: () => true,
      });

      await expect(runtime.readDocument("D:/fixtures/20m.md")).resolves
        .toMatchObject({ total_bytes: size });
    },
    30_000,
  );
});
