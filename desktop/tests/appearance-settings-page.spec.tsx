import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceSettingsPage } from "@/renderer/pages/settings/appearance";
import { FontProvider } from "@/renderer/providers/FontProvider";
import { installIndexedDbMock } from "./helpers/indexedDbMock";

const MAPLE_FONT_CSS = '@font-face{font-family:"Maple Mono CN";src:local("Maple Mono CN"),url("./font.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+4E00-9FFF;}';
const JETBRAINS_FONT_CSS = "@font-face{font-family:'JetBrains Mono';font-style:normal;font-display:swap;font-weight:400;src:url(./files/jetbrains-mono-latin-400-normal.woff2) format('woff2');unicode-range:U+0000-00FF;}";

function renderPage() {
  return render(
    <FontProvider>
      <AppearanceSettingsPage />
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
    if (url.includes("@fontsource/jetbrains-mono") && url.endsWith(".css")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "text/css" }),
        text: () => Promise.resolve(JETBRAINS_FONT_CSS),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JETBRAINS_FONT_CSS).buffer),
      } as Response);
    }

    return Promise.resolve({
      ok: true,
      headers: new Headers({ "content-type": "font/woff2" }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as Response);
  });
}

describe("AppearanceSettingsPage", () => {
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

  it("shows application display and the three font choices on the appearance page", () => {
    renderPage();

    expect(screen.getByTestId("appearance-settings-page")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "外观" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "应用显示" })).not.toBeNull();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: /JetBrains Mono/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads Maple Mono CN and hides progress after completion", async () => {
    mockSuccessfulFontDownload();
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("downloads JetBrains Mono and hides progress after completion", async () => {
    mockSuccessfulFontDownload();
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /JetBrains Mono/ }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /JetBrains Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("shows Maple Mono download loading state and byte-level progress", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));

    const progress = await screen.findByRole("progressbar");
    const option = screen.getByRole("radio", { name: /Maple Mono/ });
    expect(option.querySelector(".lucide-loader-circle")).not.toBeNull();
    expect(option.querySelector(".lucide-download")).toBeNull();
    expect(progress.textContent).toContain("0 B / 34.8 MB");
    expect(progress.textContent).toContain("0/944");
  });

  it("shows JetBrains Mono download loading state and byte-level progress", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /JetBrains Mono/ }));

    const progress = await screen.findByRole("progressbar");
    const option = screen.getByRole("radio", { name: /JetBrains Mono/ });
    expect(option.querySelector(".lucide-loader-circle")).not.toBeNull();
    expect(option.querySelector(".lucide-download")).toBeNull();
    expect(progress.textContent).toContain("0 B / 109 KB");
    expect(progress.textContent).toContain("0/10");
  });

  it("keeps the local font cache after switching back to system", async () => {
    mockSuccessfulFontDownload();
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );

    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(screen.getAllByRole("radio")[0].getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("progressbar")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );

    expect(fetch).toHaveBeenCalledTimes(8);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
