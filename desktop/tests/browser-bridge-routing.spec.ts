import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BrowserEventEnvelope, BrowserSurfaceRef } from "../src/renderer/features/browser/domain";
import {
  BrowserBridgeRouter,
  type BrowserBridgeRouteFailure,
} from "../src/renderer/features/browser/runtime";

interface BridgeFixture {
  readonly pageToHost: Record<string, unknown>[];
}

const fixture = JSON.parse(readFileSync(resolve(
  process.cwd(), "..", "test-fixtures", "sidebar-browser", "contracts", "web-annotation-bridge-v1.json",
), "utf8")) as BridgeFixture;
const pageBridgeSource = readFileSync(resolve(
  process.cwd(), "src-tauri", "src", "browser", "page_bridge.js",
), "utf8");

const surface: BrowserSurfaceRef = { panelId: "panel-1", surfaceId: "surface-1", generation: 2 };

describe("browser bridge frame broker and React routing", () => {
  it("ships one static parseable bundle with fixed command/response and teardown routes", () => {
    const rendered = pageBridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 2,
    }));
    expect(() => new Function(rendered)).not.toThrow();
    expect(rendered).toContain("keydex:web-annotation-command");
    expect(rendered).toContain("keydex:web-annotation-response");
    expect(rendered).not.toContain("FrameChildFrameCreatedEventHandler");
    expect(rendered).toContain("removeEventListener");
    expect(rendered).toContain("pagehide");
    expect(rendered).not.toContain("__KEYDEX_BRIDGE_BOOTSTRAP__");
  });

  it("routes native-validated main and child frame messages and rejects stale cursors", () => {
    const router = new BrowserBridgeRouter(surface);
    const routed = vi.fn();
    const failures: BrowserBridgeRouteFailure[] = [];
    router.subscribe(routed);
    router.subscribeErrors((failure) => failures.push(failure));

    const mainReady = structuredClone(fixture.pageToHost[0]);
    expect(router.applyHostEvent(bridgeEvent(mainReady, 1))).toBe(true);
    expect(routed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "bridge.ready", frameKey: "main" }));

    const childReady = {
      ...structuredClone(fixture.pageToHost[0]),
      navigationId: "navigation:frame-1",
      frameKey: "frame:0",
      payload: { href: "https://frame.example.test/article", top: false },
    };
    expect(router.applyHostEvent(bridgeEvent(childReady, 2))).toBe(true);

    const childGeometry = {
      ...structuredClone(fixture.pageToHost[5]),
      navigationId: "navigation:frame-1",
      frameKey: "frame:0",
      sequence: 2,
    };
    expect(router.applyHostEvent(bridgeEvent(childGeometry, 3))).toBe(true);
    expect(router.applyHostEvent(bridgeEvent(childGeometry, 4))).toBe(false);
    expect(failures.at(-1)?.code).toBe("out_of_order");

    const frameReload = { ...childReady, navigationId: "navigation:frame-2" };
    expect(router.applyHostEvent(bridgeEvent(frameReload, 5))).toBe(true);
    expect(router.applyHostEvent(bridgeEvent({ ...childGeometry, sequence: 3 }, 6))).toBe(false);
    expect(failures.at(-1)?.code).toBe("stale_navigation");
  });

  it("accepts the first Rust-validated response when React attaches after bridge.ready", () => {
    const router = new BrowserBridgeRouter(surface);
    const routed = vi.fn();
    router.subscribe(routed);
    const submitted = structuredClone(fixture.pageToHost[3]);

    expect(router.applyHostEvent(bridgeEvent(submitted, 1))).toBe(true);
    expect(routed).toHaveBeenCalledWith(expect.objectContaining({
      kind: "annotation.submit",
      requestId: "request-result",
    }));
  });

  it("clears frame registrations on navigation and destroy and forwards stable host errors", () => {
    const router = new BrowserBridgeRouter(surface);
    const failures: BrowserBridgeRouteFailure[] = [];
    router.subscribeErrors((failure) => failures.push(failure));
    const ready = structuredClone(fixture.pageToHost[0]);
    expect(router.applyHostEvent(bridgeEvent(ready, 1))).toBe(true);

    expect(router.applyHostEvent(hostEvent("navigation.started", 2, {
      url: "https://example.test/next",
      isMainFrame: true,
    }))).toBe(true);
    const result = structuredClone(fixture.pageToHost[2]);
    expect(router.applyHostEvent(bridgeEvent(result, 3))).toBe(false);
    expect(failures.at(-1)?.code).toBe("stale_frame");

    expect(router.applyHostEvent(hostEvent("bridge.error", 4, { code: "source_mismatch" }))).toBe(true);
    expect(failures.at(-1)).toEqual({ code: "host_bridge_error", hostCode: "source_mismatch" });
    expect(router.applyHostEvent(hostEvent("surface.destroyed", 5, { reason: "panel_closed" }))).toBe(true);
  });

  it("rejects forged surface and frame identity even after Rust routing", () => {
    const router = new BrowserBridgeRouter(surface);
    const failures: BrowserBridgeRouteFailure[] = [];
    router.subscribeErrors((failure) => failures.push(failure));
    const forgedSurface = { ...structuredClone(fixture.pageToHost[0]), surfaceId: "surface-forged" };
    expect(router.applyHostEvent(bridgeEvent(forgedSurface, 1))).toBe(false);
    expect(failures.at(-1)?.code).toBe("stale_surface");

    const forgedFrame = {
      ...structuredClone(fixture.pageToHost[0]),
      frameKey: "main",
      payload: { href: "https://example.test/frame", top: false },
    };
    expect(router.applyHostEvent(bridgeEvent(forgedFrame, 2))).toBe(false);
    expect(failures.at(-1)?.code).toBe("frame_identity_mismatch");
  });
});

function bridgeEvent(bridgeEnvelope: Record<string, unknown>, sequence: number): BrowserEventEnvelope {
  return hostEvent("bridge.message", sequence, { bridgeEnvelope });
}

function hostEvent<K extends BrowserEventEnvelope["kind"]>(
  kind: K,
  sequence: number,
  payload: Extract<BrowserEventEnvelope, { kind: K }>["payload"],
): BrowserEventEnvelope {
  return {
    schemaVersion: 1,
    kind,
    ...surface,
    sequence,
    navigationId: "host-navigation-1",
    occurredAt: "2026-07-22T00:00:00.000Z",
    payload,
  } as BrowserEventEnvelope;
}
