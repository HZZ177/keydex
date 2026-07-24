import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BrowserEventEnvelope } from "@/renderer/features/browser/domain";
import { BrowserPanelRuntimeController } from "@/renderer/features/browser/runtime/BrowserPanelRuntime";
import { createBrowserRuntimeStore } from "@/renderer/features/browser/state";
import type { BrowserPanelState } from "@/renderer/components/layout/rightSidebar/types";

const NOW = "2026-07-22T00:00:00.000Z";

function panel(id: string, profileMode: "persistent" | "incognito" = "persistent"): BrowserPanelState {
  return {
    id,
    kind: "browser",
    schemaVersion: 1,
    title: id,
    restoreUrl: `https://example.com/${id}`,
    restoreUrlSanitized: false,
    profileMode,
    zoomFactor: 1,
    createdAt: NOW,
    lastActivatedAt: NOW,
  };
}

function ready(panelId: string, surfaceId: string, generation: number): BrowserEventEnvelope<"surface.ready"> {
  return {
    schemaVersion: 2,
    kind: "surface.ready",
    panelId,
    surfaceId,
    generation,
    sequence: 1,
    occurredAt: NOW,
    payload: { profileMode: "persistent", capabilities: [] },
  };
}

function failed(
  panelId: string,
  surfaceId: string,
  generation: number,
  scope: "renderer" | "browser",
  crashCount: number,
  sequence = 2,
): BrowserEventEnvelope<"process.failed"> {
  return {
    schemaVersion: 2,
    kind: "process.failed",
    panelId,
    surfaceId,
    generation,
    sequence,
    occurredAt: NOW,
    payload: { scope, reasonCategory: `${scope}_process_exited`, crashCount },
  };
}

function harness() {
  let subscriber: ((event: BrowserEventEnvelope) => void) | null = null;
  const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
  const runtime = new BrowserPanelRuntimeController({
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((next: (event: BrowserEventEnvelope) => void) => {
      subscriber = next;
      return vi.fn();
    }),
    send,
  } as never, createBrowserRuntimeStore());
  return { runtime, send, emit: (event: BrowserEventEnvelope) => subscriber?.(event) };
}

describe("browser failure recovery", () => {
  it("singleflights duplicate renderer failure events and restores only by a safe GET URL", async () => {
    const { runtime, send, emit } = harness();
    const state = panel("panel-1");
    const generation = runtime.activate(state);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", expect.objectContaining({
      panelId: state.id,
      initialUrl: state.restoreUrl,
    })));
    emit(ready(state.id, "surface-1", generation));
    emit(failed(state.id, "surface-1", generation, "renderer", 1));
    emit(failed(state.id, "surface-1", generation, "renderer", 1, 3));
    await vi.waitFor(() => expect(send.mock.calls.filter(([command]) => command === "browser_create_surface")).toHaveLength(2));
    expect(send.mock.calls.filter(([command]) => command === "browser_destroy_surface")).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command === "browser_create_surface")[1]?.[1]).toEqual(expect.objectContaining({
      panelId: state.id,
      generation: generation + 1,
      initialUrl: state.restoreUrl,
    }));
  });

  it("rebuilds an environment but eagerly restores only the active panel", async () => {
    const { runtime, send, emit } = harness();
    const first = panel("panel-1");
    const second = panel("panel-2");
    const firstGeneration = runtime.activate(first);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", expect.objectContaining({ panelId: first.id })));
    emit(ready(first.id, "surface-1", firstGeneration));
    runtime.deactivate(first.id, firstGeneration);
    const secondGeneration = runtime.activate(second);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", expect.objectContaining({ panelId: second.id })));
    emit(ready(second.id, "surface-2", secondGeneration));
    emit(failed(second.id, "surface-2", secondGeneration, "browser", 1));
    await vi.waitFor(() => expect(send.mock.calls.filter(([command]) => command === "browser_destroy_surface")).toHaveLength(2));
    await vi.waitFor(() => expect(send.mock.calls.filter(([command]) => command === "browser_create_surface")).toHaveLength(3));
    const creates = send.mock.calls.filter(([command]) => command === "browser_create_surface");
    expect(creates.filter(([, payload]) => payload.panelId === first.id)).toHaveLength(1);
    expect(creates.filter(([, payload]) => payload.panelId === second.id)).toHaveLength(2);
  });

  it("opens the runtime-only circuit at the third browser crash without affecting the main app", async () => {
    const { runtime, send, emit } = harness();
    const state = panel("panel-1");
    const generation = runtime.activate(state);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", expect.anything()));
    emit(ready(state.id, "surface-1", generation));
    emit(failed(state.id, "surface-1", generation, "browser", 3));
    await vi.waitFor(() => expect(runtime.store.getState().surfaces[state.id]?.status).toBe("failed"));
    expect(send.mock.calls.filter(([command]) => command === "browser_create_surface")).toHaveLength(1);
    expect(runtime.store.getState().surfaces[state.id]?.commandError).toContain("主任务仍可继续使用");
  });

  it("clears surface-bound protections before rebuilding and does not replay them", async () => {
    const { runtime, send, emit } = harness();
    const state = panel("panel-1");
    const firstGeneration = runtime.activate(state);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", expect.anything()));
    emit(ready(state.id, "surface-1", firstGeneration));
    for (const reason of ["navigation", "permission", "download", "selection", "annotation_draft"]) {
      runtime.setProtection(state.id, reason, true);
    }

    emit(failed(state.id, "surface-1", firstGeneration, "renderer", 1));
    await vi.waitFor(() => expect(send.mock.calls.filter(([command]) => command === "browser_create_surface")).toHaveLength(2));
    const secondGeneration = firstGeneration + 1;
    emit(ready(state.id, "surface-2", secondGeneration));
    runtime.deactivate(state.id, secondGeneration);
    runtime.handleMemoryPressure();

    await vi.waitFor(() => expect(send.mock.calls.filter(([command]) => command === "browser_destroy_surface")).toHaveLength(2));
    expect(runtime.store.getState().surfaces[state.id]?.resourceState).toBe("discarded");
    const creates = send.mock.calls.filter(([command]) => command === "browser_create_surface");
    expect(creates[1]?.[1]).not.toHaveProperty("permissionRequestId");
    expect(creates[1]?.[1]).not.toHaveProperty("downloadId");
    expect(creates[1]?.[1]).not.toHaveProperty("selectionId");
  });

  it("binds the browser panel to the recovered runtime generation", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/ui/BrowserTabSurface.tsx"),
      "utf8",
    );
    expect(source).toContain("const generation = runtime?.generation ?? activatedGeneration");
    expect(source).toContain("generationRef.current = generation");
  });
});
