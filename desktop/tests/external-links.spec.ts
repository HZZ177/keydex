import { describe, expect, it, vi } from "vitest";

import { openExternalUrl } from "@/runtime/externalLinks";

describe("openExternalUrl", () => {
  it("uses the native Tauri shell instead of a WebView popup", async () => {
    const nativeOpen = vi.fn().mockResolvedValue(undefined);
    const browserOpen = vi.fn();

    await openExternalUrl("https://app.tavily.com/home", {
      isTauriRuntime: () => true,
      openWindow: browserOpen,
      shellApi: { open: nativeOpen },
    });

    expect(nativeOpen).toHaveBeenCalledWith("https://app.tavily.com/home");
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("falls back to a browser popup outside the desktop runtime", async () => {
    const browserOpen = vi.fn().mockReturnValue(window);

    await openExternalUrl("https://alpha.example/account/keys", {
      isTauriRuntime: () => false,
      openWindow: browserOpen,
    });

    expect(browserOpen).toHaveBeenCalledWith(
      "https://alpha.example/account/keys",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("allows an explicit terminal-style HTTP link without enabling arbitrary protocols", async () => {
    const nativeOpen = vi.fn().mockResolvedValue(undefined);
    await openExternalUrl("http://127.0.0.1:5173", {
      allowHttp: true,
      isTauriRuntime: () => true,
      shellApi: { open: nativeOpen },
    });
    expect(nativeOpen).toHaveBeenCalledWith("http://127.0.0.1:5173/");
    await expect(
      openExternalUrl("javascript:alert(1)", {
        allowHttp: true,
        isTauriRuntime: () => true,
        shellApi: { open: nativeOpen },
      }),
    ).rejects.toThrow();
  });

  it.each(["http://example.test", "not a url"])("rejects unsafe or malformed targets: %s", async (target) => {
    const nativeOpen = vi.fn();

    await expect(openExternalUrl(target, {
      isTauriRuntime: () => true,
      shellApi: { open: nativeOpen },
    })).rejects.toThrow();

    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it("reports a blocked browser fallback", async () => {
    await expect(openExternalUrl("https://example.test", {
      isTauriRuntime: () => false,
      openWindow: vi.fn().mockReturnValue(null),
    })).rejects.toThrow("浏览器阻止了新窗口");
  });
});
