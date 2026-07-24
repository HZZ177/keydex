import { describe, expect, it, vi } from "vitest";

import {
  BrowserFileAddressError,
  authorizeBrowserNavigation,
  canonicalizeBrowserFileAddress,
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
    expect(resolveBrowserAddress("file:///C:/work/index.html")).toEqual({
      kind: "file",
      url: "file:///C:/work/index.html",
    });
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

describe("Windows and file URL normalization", () => {
  it.each([
    ["D:\\workspace\\demo\\index.html", "file:///D:/workspace/demo/index.html"],
    ["d:/workspace/demo/index.html", "file:///D:/workspace/demo/index.html"],
    ["D:\\workspace\\.\\nested\\..\\index.html", "file:///D:/workspace/index.html"],
    ["D:\\workspace\\空 格\\100%#完成.html", "file:///D:/workspace/%E7%A9%BA%20%E6%A0%BC/100%25%23%E5%AE%8C%E6%88%90.html"],
    ["file:///d:/workspace/index.html", "file:///D:/workspace/index.html"],
    ["file:///D:/workspace/100%25%23done.html", "file:///D:/workspace/100%25%23done.html"],
    ["file:///D:/workspace/%E4%B8%AD%E6%96%87%20%E9%A1%B5.html", "file:///D:/workspace/%E4%B8%AD%E6%96%87%20%E9%A1%B5.html"],
    ["\\\\server\\share\\folder\\index.html", "file://server/share/folder/index.html"],
    ["file://SERVER/share/folder/index.html", "file://server/share/folder/index.html"],
    ["file:///D:/workspace/one/../two/index.html", "file:///D:/workspace/two/index.html"],
  ])("normalizes %s", (input, expected) => {
    expect(canonicalizeBrowserFileAddress(input).url).toBe(expected);
  });

  it("uses one case-insensitive canonical key for equivalent Windows inputs", () => {
    const first = canonicalizeBrowserFileAddress("D:\\Workspace\\Demo\\INDEX.HTML");
    const second = canonicalizeBrowserFileAddress("file:///d:/workspace/demo/index.html");

    expect(first.canonicalKey).toBe(second.canonicalKey);
    expect(first.windowsPath).toBe("D:\\Workspace\\Demo\\INDEX.HTML");
  });

  it.each([
    ["relative\\index.html", "relative_path"],
    ["D:relative\\index.html", "relative_path"],
    ["file:///D:/bad/%ZZ/index.html", "invalid_percent_encoding"],
    ["D:\\bad\u0000\\index.html", "control_character"],
    ["D:\\workspace\\folder\\", "directory_path"],
    ["file:///D:/workspace/folder/", "directory_path"],
    ["file://user:pass@server/share/index.html", "invalid_file_authority"],
    ["file:///tmp/index.html", "invalid_file_path"],
    ["\\\\server\\share", "invalid_file_authority"],
  ] as const)("classifies invalid input %s as %s", (input, code) => {
    try {
      canonicalizeBrowserFileAddress(input);
      throw new Error("Expected local file input to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserFileAddressError);
      expect((error as BrowserFileAddressError).code).toBe(code);
    }
  });

  it("keeps HTTP address and search behavior unchanged", () => {
    expect(resolveBrowserAddress("https://example.com/docs")).toEqual({
      kind: "url",
      url: "https://example.com/docs",
    });
    expect(resolveBrowserAddress("file annotations")).toMatchObject({
      kind: "search",
    });
  });

  it("keeps a literal percent sequence in a Windows filename instead of decoding it", () => {
    const file = canonicalizeBrowserFileAddress("D:\\workspace\\literal%20name.html");

    expect(file.url).toBe("file:///D:/workspace/literal%2520name.html");
    expect(file.windowsPath).toBe("D:\\workspace\\literal%20name.html");
  });
});

describe("renderer file navigation intent policy", () => {
  it.each([
    ["address_bar", undefined, true],
    ["app_preview", undefined, false],
    ["restore", undefined, false],
    ["page_link", "file:///D:/workspace/index.html", true],
    ["redirect", "file:///D:/workspace/index.html", false],
    ["popup", "file:///D:/workspace/index.html", true],
    ["history", "file:///D:/workspace/index.html", false],
  ] as const)("allows trusted %s navigation to a local file", (source, initiatorUrl, userGesture) => {
    expect(authorizeBrowserNavigation({
      target: "D:\\workspace\\nested\\page.html",
      intent: { source, initiatorUrl, userGesture },
    })).toMatchObject({
      targetKind: "local_file",
      url: "file:///D:/workspace/nested/page.html",
      intent: { source, userGesture },
    });
  });

  it.each([
    ["page_link", true],
    ["redirect", false],
    ["popup", true],
    ["history", false],
  ] as const)("rejects remote-origin %s navigation to file", (source, userGesture) => {
    expect(() => authorizeBrowserNavigation({
      target: "file:///D:/workspace/private.html",
      intent: {
        source,
        initiatorUrl: "https://example.test/article",
        userGesture,
      },
    })).toThrow("远程页面不能导航到本地文件");
  });

  it.each(["page_link", "popup"] as const)(
    "requires a user gesture for local-page %s file navigation",
    (source) => {
      expect(() => authorizeBrowserNavigation({
        target: "file:///D:/workspace/next.html",
        intent: {
          source,
          initiatorUrl: "file:///D:/workspace/index.html",
          userGesture: false,
        },
      })).toThrow("远程页面不能导航到本地文件");
    },
  );

  it("allows a local page to navigate to HTTP without widening file access", () => {
    expect(authorizeBrowserNavigation({
      target: "https://example.test/docs",
      intent: {
        source: "page_link",
        initiatorUrl: "file:///D:/workspace/index.html",
        userGesture: true,
      },
    })).toEqual({
      url: "https://example.test/docs",
      targetKind: "remote",
      intent: {
        source: "page_link",
        initiatorUrl: "file:///D:/workspace/index.html",
        userGesture: true,
      },
    });
  });
});

describe("BrowserNavigationController", () => {
  it("correlates navigate/history/reload/stop with the current surface", async () => {
    const store = createBrowserRuntimeStore();
    store.getState().beginCreate("panel-1", 1, "persistent", "about:blank");
    store.getState().applyEvent({
      schemaVersion: 2,
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
        intent: {
          source: "address_bar",
          userGesture: true,
        },
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
