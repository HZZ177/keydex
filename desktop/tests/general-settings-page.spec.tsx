import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeneralSettingsPage } from "@/renderer/pages/settings/general";
import { FontProvider } from "@/renderer/providers/FontProvider";
import { installIndexedDbMock } from "./helpers/indexedDbMock";

const MAPLE_FONT_CSS = '@font-face{font-family:"Maple Mono CN";src:local("Maple Mono CN"),url("./font.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+4E00-9FFF;}';

function renderPage() {
  return render(
    <FontProvider>
      <GeneralSettingsPage />
    </FontProvider>,
  );
}

function mockSuccessfulFontDownload() {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith("/result.css")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "text/css" }),
        text: () => Promise.resolve(MAPLE_FONT_CSS),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(MAPLE_FONT_CSS).buffer),
      } as Response);
    }

    return Promise.resolve({
      ok: true,
      headers: new Headers({ "content-type": "font/woff2" }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as Response);
  });
}

describe("GeneralSettingsPage", () => {
  beforeEach(() => {
    installIndexedDbMock();
    localStorage.clear();
    indexedDB.deleteDatabase("keydex-font-cache");
    document.documentElement.removeAttribute("style");
    document.getElementById("keydex-custom-font-face")?.remove();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:font"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("offers system and Maple Mono font choices", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "外观" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: /系统默认/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("点击下载到本地后使用")).not.toBeNull();
    expect(screen.queryByRole("progressbar", { name: "字体下载进度" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads Maple Mono CN when selected and hides progress after completion", async () => {
    mockSuccessfulFontDownload();

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("progressbar", { name: "字体下载进度" })).toBeNull();
    expect(screen.getByText("已启用")).not.toBeNull();
    expect(screen.getByText("Maple Mono CN 已启用")).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("shows byte-level progress while Maple Mono CN is downloading", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));

    expect(await screen.findByRole("progressbar", { name: "字体下载进度" })).not.toBeNull();
    expect(screen.getByText("已下载 0 B / 34.8 MB（0/944）")).not.toBeNull();
    expect(screen.getByText("下载中 0 B / 34.8 MB")).not.toBeNull();
  });

  it("keeps the local cache state after switching back to system", async () => {
    mockSuccessfulFontDownload();

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );

    fireEvent.click(screen.getByRole("radio", { name: /系统默认/ }));

    expect(screen.getByRole("radio", { name: /系统默认/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("progressbar", { name: "字体下载进度" })).toBeNull();
    expect(screen.getByText("已下载到本地，点击启用")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );

    expect(fetch).toHaveBeenCalledTimes(8);
    expect(screen.queryByRole("progressbar", { name: "字体下载进度" })).toBeNull();
  });
});
