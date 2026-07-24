import { describe, expect, it, vi } from "vitest";

import type { BrowserEventEnvelope } from "@/renderer/features/browser/domain";
import {
  BrowserPanelRuntimeController,
  type BrowserRuntimePanelState,
} from "@/renderer/features/browser/runtime/BrowserPanelRuntime";
import { createBrowserRuntimeStore } from "@/renderer/features/browser/state";

const NOW = "2026-07-22T00:00:00.000Z";

describe("browser resource runtime", () => {
  it("keeps only ten live surfaces while switching through eleven panels", async () => {
    const run = harness();
    let previous: { panelId: string; generation: number } | null = null;

    for (let index = 1; index <= 11; index += 1) {
      if (previous) run.runtime.deactivate(previous.panelId, previous.generation);
      const state = panel(index);
      const generation = run.runtime.activate(state);
      await settleMicrotasks();
      expect(commandCalls(run.send, "browser_create_surface")).toHaveLength(index);
      run.emit(ready(state.id, generation));
      previous = { panelId: state.id, generation };
    }

    await vi.waitFor(() => expect(commandCalls(run.send, "browser_destroy_surface")).toHaveLength(1));
    await vi.waitFor(() => {
      const surfaces = Object.values(run.runtime.store.getState().surfaces).flatMap(
        (surface) => surface ? [surface] : [],
      );
      expect(surfaces.filter((surface) => surface.surface !== null)).toHaveLength(10);
      expect(surfaces.filter((surface) => surface.resourceState === "visible")).toHaveLength(1);
      expect(surfaces.filter((surface) => surface.resourceState === "warm")).toHaveLength(4);
      expect(surfaces.filter((surface) => surface.resourceState === "native_suspended")).toHaveLength(5);
      expect(surfaces.filter((surface) => surface.resourceState === "discarded")).toHaveLength(1);
    });

    expect(commandCalls(run.send, "browser_destroy_surface")[0]?.[1]).toMatchObject({
      panelId: "panel-1",
      surfaceId: "surface-panel-1",
    });
    for (const [, payload] of commandCalls(run.send, "browser_set_resource_state")) {
      expect(Object.keys(payload as object).sort()).toEqual([
        "generation",
        "panelId",
        "reason",
        "state",
        "surfaceId",
      ]);
      expect(payload).not.toHaveProperty("url");
      expect(payload).not.toHaveProperty("title");
      expect(payload).not.toHaveProperty("annotation");
    }
  });

  it("releases runtime state and requests native destruction across one hundred close cycles", async () => {
    const run = harness();

    for (let index = 1; index <= 100; index += 1) {
      const state = panel(index);
      const generation = run.runtime.activate(state);
      await settleMicrotasks();
      expect(commandCalls(run.send, "browser_create_surface")).toHaveLength(index);
      run.emit(ready(state.id, generation));
      run.runtime.dispose(state.id, generation);
      expect(run.runtime.store.getState().surfaces[state.id]).toBeUndefined();
    }

    await vi.waitFor(() => expect(commandCalls(run.send, "browser_destroy_surface")).toHaveLength(100));
    expect(Object.keys(run.runtime.store.getState().surfaces)).toHaveLength(0);
  });

  it("keeps an inactive annotation-protected surface live until protection is released", async () => {
    const run = harness();
    const protectedPanel = panel(1);
    const protectedGeneration = run.runtime.activate(protectedPanel);
    await settleMicrotasks();
    run.emit(ready(protectedPanel.id, protectedGeneration));
    run.runtime.setProtection(protectedPanel.id, "annotation", true);
    run.runtime.deactivate(protectedPanel.id, protectedGeneration);

    for (let index = 2; index <= 12; index += 1) {
      const state = panel(index);
      const generation = run.runtime.activate(state);
      await settleMicrotasks();
      run.emit(ready(state.id, generation));
      if (index < 12) run.runtime.deactivate(state.id, generation);
    }

    await vi.waitFor(() => {
      expect(run.runtime.store.getState().surfaces[protectedPanel.id]?.resourceState)
        .not.toBe("discarded");
    });
    expect(commandCalls(run.send, "browser_destroy_surface")).not.toContainEqual([
      "browser_destroy_surface",
      expect.objectContaining({ panelId: protectedPanel.id }),
    ]);

    run.runtime.setProtection(protectedPanel.id, "annotation", false);

    await vi.waitFor(() => {
      expect(run.runtime.store.getState().surfaces[protectedPanel.id]?.resourceState)
        .toBe("discarded");
    });
  });
});

function panel(index: number): BrowserRuntimePanelState {
  const id = `panel-${index}`;
  return {
    id,
    restoreUrl: `https://example.test/${index}`,
    profileMode: "persistent",
  };
}

function ready(panelId: string, generation: number): BrowserEventEnvelope<"surface.ready"> {
  return {
    schemaVersion: 2,
    kind: "surface.ready",
    panelId,
    surfaceId: `surface-${panelId}`,
    generation,
    sequence: 1,
    occurredAt: NOW,
    payload: { profileMode: "persistent", capabilities: [] },
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
  return {
    runtime,
    send,
    emit(event: BrowserEventEnvelope) {
      if (!subscriber) throw new Error("Browser runtime subscriber is not connected");
      subscriber(event);
    },
  };
}

function commandCalls(send: ReturnType<typeof vi.fn>, command: string) {
  return send.mock.calls.filter(([candidate]) => candidate === command);
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
