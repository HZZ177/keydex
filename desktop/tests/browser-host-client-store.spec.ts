import { describe, expect, it, vi } from "vitest";

import {
  BrowserHostClient,
  BrowserHostCommandError,
  BrowserHostUnavailableError,
  isBrowserHostRuntimeAvailable,
} from "../src/renderer/features/browser/runtime/BrowserHostClient";
import {
  createBrowserRuntimeStore,
} from "../src/renderer/features/browser/state/browserRuntimeStore";
import type { BrowserEventEnvelope } from "../src/renderer/features/browser/domain";

function event(
  kind: BrowserEventEnvelope["kind"],
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
  overrides: Partial<BrowserEventEnvelope> = {},
): BrowserEventEnvelope {
  return {
    schemaVersion: 1,
    kind,
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence,
    occurredAt: "2026-07-21T12:00:00.000Z",
    payload,
    ...overrides,
  } as unknown as BrowserEventEnvelope;
}

describe("BrowserHostClient", () => {
  it("fails before loading Tauri APIs in an ordinary Web runtime", async () => {
    expect(isBrowserHostRuntimeAvailable()).toBe(false);
    await expect(new BrowserHostClient().connect()).rejects.toBeInstanceOf(
      BrowserHostUnavailableError,
    );
  });

  it("validates commands and correlates native responses", async () => {
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) => ({
      ok: true,
      requestId: args.requestId,
    }));
    const client = new BrowserHostClient({ invoke, requestId: () => "request-1" });

    await client.send("browser_create_surface", {
      panelId: "panel-1",
      generation: 1,
      profileMode: "persistent",
      initialUrl: "https://example.com",
      theme: "dark",
      backgroundColor: { red: 40, green: 42, blue: 54, alpha: 255 },
    });

    expect(invoke).toHaveBeenCalledWith("browser_create_surface", {
      requestId: "request-1",
      payload: {
        panelId: "panel-1",
        generation: 1,
        profileMode: "persistent",
        initialUrl: "https://example.com",
        theme: "dark",
        backgroundColor: { red: 40, green: 42, blue: 54, alpha: 255 },
      },
    });
  });

  it("rejects native failures and drops invalid event envelopes", async () => {
    const listener: { current?: (event: { payload: unknown }) => void } = {};
    const protocolError = vi.fn();
    const client = new BrowserHostClient({
      requestId: () => "request-2",
      invoke: async () => ({
        ok: false,
        requestId: "request-2",
        error: { code: "surface_not_found", message: "missing", retryable: false },
      }),
      listen: async (_topic, callback) => {
        listener.current = callback;
        return () => undefined;
      },
      onProtocolError: protocolError,
    });
    await client.connect();
    listener.current?.({ payload: { schemaVersion: 99 } });
    expect(protocolError).toHaveBeenCalledOnce();
    await expect(client.send("browser_destroy_surface", {
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 1,
    })).rejects.toBeInstanceOf(BrowserHostCommandError);
  });
});

describe("browserRuntimeStore", () => {
  it("keeps the internal about:blank bootstrap URL out of renderer state", () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 1, "persistent", "about:blank");
    expect(store.getState().surfaces["panel-1"]?.navigation.url).toBe("");

    store.getState().applyEvent(event("surface.ready", 1, {
      profileMode: "persistent",
      capabilities: ["navigation"],
    }));
    store.getState().applyEvent(event("navigation.completed", 2, {
      url: "about:blank",
      isMainFrame: true,
    }));

    expect(store.getState().surfaces["panel-1"]?.navigation.url).toBe("");
  });

  it("accepts the current surface and rejects stale, old-navigation, and out-of-order events", () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 1, "persistent", "about:blank");
    expect(store.getState().applyEvent(event("surface.ready", 1, {
      profileMode: "persistent",
      capabilities: ["navigation"],
    }))).toBe(true);
    expect(store.getState().applyEvent(event("navigation.started", 2, {
      url: "https://example.com",
      isMainFrame: true,
    }, { navigationId: "navigation-1" }))).toBe(true);
    expect(store.getState().applyEvent(event("page.title", 3, {
      title: "Wrong navigation",
    }, { navigationId: "navigation-old" }))).toBe(false);
    expect(store.getState().applyEvent(event("page.title", 2, {
      title: "Out of order",
    }, { navigationId: "navigation-1" }))).toBe(false);
    expect(store.getState().applyEvent(event("page.title", 3, {
      title: "Example",
    }, { navigationId: "navigation-1" }))).toBe(true);
    expect(store.getState().applyEvent(event("page.title", 4, {
      title: "Stale generation",
    }, { generation: 2, surfaceId: "surface-2" }))).toBe(false);
    expect(store.getState().surfaces["panel-1"]?.navigation.title).toBe("Example");
  });

  it("never lets a late command failure overwrite a newer generation", () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 2, "incognito", "about:blank");
    store.getState().failCommand("panel-1", 1, "late");
    expect(store.getState().surfaces["panel-1"]?.commandError).toBeNull();
    store.getState().forget("panel-1", 1);
    expect(store.getState().surfaces["panel-1"]).toBeDefined();
  });

  it("reconciles a failed download navigation back to the still-live page", () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 1, "persistent", "https://example.com/releases");
    store.getState().applyEvent(event("surface.ready", 1, {
      profileMode: "persistent",
      capabilities: ["navigation", "downloads"],
    }));
    store.getState().applyEvent(event("navigation.failed", 2, {
      url: "https://cdn.example.com/setup.exe",
      isMainFrame: true,
      errorCategory: "connection",
    }));

    expect(store.getState().surfaces["panel-1"]?.navigation.errorCategory).toBe("connection");

    store.getState().applyEvent(event("download.requested", 3, {
      downloadId: "download-1",
      url: "https://cdn.example.com/setup.exe",
      suggestedFilename: "setup.exe",
      totalBytes: 1024,
      mimeType: "application/octet-stream",
      dangerKind: "safe",
    }));

    expect(store.getState().surfaces["panel-1"]?.navigation).toMatchObject({
      loading: false,
      errorCategory: null,
    });
  });
});
