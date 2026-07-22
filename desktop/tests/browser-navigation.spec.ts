import { describe, expect, it, vi } from "vitest";

import {
  persistableBrowserMetadata,
  resolveBrowserAddress,
  sanitizeBrowserFaviconUrl,
  sanitizeBrowserRestoreUrl,
  sanitizeBrowserTitle,
} from "../src/renderer/features/browser/domain/browserNavigation";
import { BrowserNavigationController } from "../src/renderer/features/browser/runtime/BrowserNavigationController";
import { BrowserHostClient } from "../src/renderer/features/browser/runtime/BrowserHostClient";
import { createBrowserRuntimeStore } from "../src/renderer/features/browser/state/browserRuntimeStore";

describe("browser address and persisted navigation metadata", () => {
  it("resolves explicit URLs, domains, localhost, IDN, and searches", () => {
    expect(resolveBrowserAddress("https://example.com/docs")).toMatchObject({
      kind: "url",
      url: "https://example.com/docs",
    });
    expect(resolveBrowserAddress("example.com/docs")).toMatchObject({
      kind: "domain",
      url: "https://example.com/docs",
    });
    expect(resolveBrowserAddress("localhost:4173/probe")).toMatchObject({
      kind: "domain",
      url: "https://localhost:4173/probe",
    });
    expect(resolveBrowserAddress("网页批注 设计")).toEqual({
      kind: "search",
      url: "https://www.bing.com/search?q=%E7%BD%91%E9%A1%B5%E6%89%B9%E6%B3%A8%20%E8%AE%BE%E8%AE%A1",
    });
    expect(() => resolveBrowserAddress("javascript:alert(1)")).toThrow("不支持此地址协议");
    expect(() => resolveBrowserAddress("file:///C:/secret.txt")).toThrow("不支持此地址协议");
  });

  it("keeps runtime URLs visible but strips one-time secrets from restore URLs", () => {
    const result = sanitizeBrowserRestoreUrl(
      "https://user:pass@example.com/callback?code=one-time&state=keep&access_token=secret#token=fragment",
    );
    expect(result).toEqual({
      restoreUrl: "https://example.com/callback?state=keep",
      sanitized: true,
    });
    expect(sanitizeBrowserRestoreUrl("about:blank")).toEqual({ restoreUrl: null, sanitized: true });
    expect(sanitizeBrowserRestoreUrl(
      "https://example.com/login?password=hunter&client_secret=hidden&view=full",
    )).toEqual({ restoreUrl: "https://example.com/login?view=full", sanitized: true });
  });

  it("bounds titles and accepts only same-origin HTTP favicons", () => {
    expect(sanitizeBrowserTitle("  Example\u0000\n Page  ")).toBe("Example Page");
    expect(sanitizeBrowserTitle("x".repeat(800))).toHaveLength(512);
    expect(sanitizeBrowserFaviconUrl(
      "https://example.com/favicon.ico",
      "https://example.com/docs",
    )).toBe("https://example.com/favicon.ico");
    expect(sanitizeBrowserFaviconUrl(
      "https://tracker.example/favicon.ico",
      "https://example.com/docs",
    )).toBeUndefined();
    expect(sanitizeBrowserFaviconUrl("data:image/png;base64,abc", "https://example.com")).toBeUndefined();
  });

  it("derives persistable metadata from the latest runtime redirect", () => {
    expect(persistableBrowserMetadata({
      navigation: {
        url: "https://example.com/final?session_id=secret&tab=docs",
        title: " Final page ",
        faviconUrl: "https://example.com/favicon.ico",
      },
    })).toEqual({
      title: "Final page",
      faviconUrl: "https://example.com/favicon.ico",
      restoreUrl: "https://example.com/final?tab=docs",
      restoreUrlSanitized: true,
    });
  });
});

describe("BrowserNavigationController", () => {
  it("correlates navigate/history/reload/stop with the current surface", async () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 1, "persistent", "about:blank");
    store.getState().applyEvent({
      schemaVersion: 1,
      kind: "surface.ready",
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 1,
      sequence: 1,
      occurredAt: "2026-07-21T12:00:00.000Z",
      payload: { profileMode: "persistent", capabilities: ["navigation"] },
    });
    let requestSequence = 0;
    const invoke = vi.fn(async (_command: string, args: Readonly<Record<string, unknown>>) => ({
      ok: true,
      requestId: args.requestId,
    }));
    const client = new BrowserHostClient({
      invoke,
      requestId: () => `request-${++requestSequence}`,
    });
    const controller = new BrowserNavigationController({
      client,
      store,
      panelId: "panel-1",
      generation: 1,
    });

    await controller.navigate("example.com");
    await controller.goBack();
    await controller.goForward();
    await controller.reload();
    await controller.stop();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "browser_navigate",
      "browser_go_back",
      "browser_go_forward",
      "browser_reload",
      "browser_stop",
    ]);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      requestId: "request-1",
      payload: {
        panelId: "panel-1",
        surfaceId: "surface-1",
        generation: 1,
        navigationId: "panel-1-navigation-1",
        url: "https://example.com/",
      },
    });
  });

  it("does not dispatch before the current generation is ready", async () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 2, "persistent", "about:blank");
    const controller = new BrowserNavigationController({
      client: new BrowserHostClient({
        invoke: vi.fn(),
        requestId: () => "request-unused",
      }),
      store,
      panelId: "panel-1",
      generation: 2,
    });
    await expect(controller.navigate("example.com")).rejects.toThrow("尚未就绪");
  });
});
