import { describe, expect, it, vi } from "vitest";

import { AnnotationViewRegistry } from "@/renderer/features/annotations/navigation/AnnotationViewRegistry";
import type {
  AnnotationViewAdapter,
  AnnotationViewId,
} from "@/renderer/features/annotations/navigation/types";

describe("AnnotationViewRegistry", () => {
  it("registers source and markdown adapters per registry instance", () => {
    const first = new AnnotationViewRegistry();
    const second = new AnnotationViewRegistry();
    first.register(adapter("source"));
    first.register(adapter("markdown"));

    expect(first.mountedViewIds()).toEqual(["source", "markdown"]);
    expect(second.mountedViewIds()).toEqual([]);
  });

  it("replaces a view id atomically and stale unregister cannot remove the replacement", () => {
    const registry = new AnnotationViewRegistry();
    const original = adapter("source");
    const replacement = adapter("source");
    const unregisterOriginal = registry.register(original);
    const unregisterReplacement = registry.register(replacement);

    unregisterOriginal();
    expect(registry.get("source")).toBe(replacement);
    unregisterReplacement();
    expect(registry.get("source")).toBeNull();
  });

  it("waits for mount and the adapter-owned ready lifecycle without polling", async () => {
    const registry = new AnnotationViewRegistry();
    const controller = new AbortController();
    let ready!: () => void;
    const view = adapter("markdown", new Promise<void>((resolve) => {
      ready = resolve;
    }));
    const waiting = registry.waitUntilReady("markdown", controller.signal);

    registry.register(view);
    ready();

    await expect(waiting).resolves.toBe(view);
  });

  it("aborts an unmounted wait and rejects a view replaced before ready", async () => {
    const registry = new AnnotationViewRegistry();
    const aborted = new AbortController();
    const missing = registry.waitUntilReady("source", aborted.signal);
    aborted.abort();
    await expect(missing).rejects.toMatchObject({ name: "AbortError" });

    let ready!: () => void;
    const original = adapter("markdown", new Promise<void>((resolve) => {
      ready = resolve;
    }));
    registry.register(original);
    const replaced = registry.waitUntilReady("markdown", new AbortController().signal);
    registry.register(adapter("markdown"));
    ready();
    await expect(replaced).rejects.toThrow("replaced");
  });

  it("disposes mount waiters and refuses future registration", async () => {
    const registry = new AnnotationViewRegistry();
    const waiting = registry.waitUntilReady("source", new AbortController().signal);

    registry.dispose();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(() => registry.register(adapter("source"))).toThrow("disposed");
  });
});

function adapter(id: AnnotationViewId, ready: Promise<void> = Promise.resolve()): AnnotationViewAdapter {
  return {
    id,
    flashMarker: vi.fn(),
    geometry: vi.fn().mockReturnValue({
      documentHeight: 0,
      markers: {},
      revision: 0,
      scrollOffset: 0,
      viewportHeight: 0,
      viewportWidth: 0,
    }),
    isReady: vi.fn().mockReturnValue(true),
    render: vi.fn(),
    reveal: vi.fn().mockResolvedValue(undefined),
    selection: vi.fn().mockReturnValue(null),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    whenReady: vi.fn().mockImplementation(() => ready),
  };
}
