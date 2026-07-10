import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY } from "@/runtime/closeWindowBehaviorStore";
import { GeneralSettingsPage } from "@/renderer/pages/settings/general";
import { FontProvider } from "@/renderer/providers/FontProvider";
import type { GeneralSettings } from "@/types/protocol";
import { installIndexedDbMock } from "./helpers/indexedDbMock";

const MAPLE_FONT_CSS = '@font-face{font-family:"Maple Mono CN";src:local("Maple Mono CN"),url("./font.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+4E00-9FFF;}';
const JETBRAINS_FONT_CSS = "@font-face{font-family:'JetBrains Mono';font-style:normal;font-display:swap;font-weight:400;src:url(./files/jetbrains-mono-latin-400-normal.woff2) format('woff2');unicode-range:U+0000-00FF;}";

function renderPage(runtime: RuntimeBridge = fakeRuntime()) {
  return render(
    <FontProvider>
      <GeneralSettingsPage runtime={runtime} />
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

  it("offers system, Maple Mono, and JetBrains Mono font choices", async () => {
    renderPage();

    expect(screen.getByTestId("general-settings-page")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "常规" })).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /关闭窗口后行为/ }).hasAttribute("disabled")).toBe(false),
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: /JetBrains Mono/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads Maple Mono CN when selected and hides progress after completion", async () => {
    mockSuccessfulFontDownload();

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Maple Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("downloads JetBrains Mono when selected and hides progress after completion", async () => {
    mockSuccessfulFontDownload();

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /JetBrains Mono/ }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /JetBrains Mono/ }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("shows byte-level progress while Maple Mono CN is downloading", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /Maple Mono/ }));

    const progress = await screen.findByRole("progressbar");
    expect(progress.textContent).toContain("0 B / 34.8 MB");
    expect(progress.textContent).toContain("0/944");
  });

  it("shows byte-level progress while JetBrains Mono is downloading", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));

    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: /JetBrains Mono/ }));

    const progress = await screen.findByRole("progressbar");
    expect(progress.textContent).toContain("0 B / 109 KB");
    expect(progress.textContent).toContain("0/10");
  });

  it("keeps the local cache state after switching back to system", async () => {
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

  it("saves the close window behavior from the general page", async () => {
    const runtime = fakeRuntime();

    renderPage(runtime);

    const trigger = await screen.findByRole("button", { name: /关闭窗口后行为/ });
    fireEvent.click(trigger);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(screen.queryByRole("option", { name: /未设置/ })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /最小化到托盘/ }));

    await waitFor(() =>
      expect(runtime.settings.saveGeneralSettings).toHaveBeenCalledWith({
        close_window_behavior: "minimize_to_tray",
        conversation_send_default_mode: "steer",
      }),
    );
    expect(localStorage.getItem(CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY)).toBe("minimize_to_tray");
    expect(screen.getByRole("button", { name: /最小化到托盘/ })).not.toBeNull();
  });

  it("saves the default conversation send behavior from the general page", async () => {
    const runtime = fakeRuntime({
      close_window_behavior: null,
      conversation_send_default_mode: "steer",
    });

    renderPage(runtime);

    const trigger = await screen.findByRole("button", { name: /对话中发送消息默认行为/ });
    expect(trigger.textContent).toContain("引导当前回复");
    expect(screen.getByText("回复中发送时默认引导当前回复，Ctrl+Enter 临时加入等待队列")).not.toBeNull();

    fireEvent.click(trigger);
    const queueOption = screen
      .getAllByRole("option")
      .find((option) => within(option).queryByText("加入等待队列"));
    expect(queueOption).not.toBeUndefined();
    fireEvent.click(queueOption as HTMLElement);

    await waitFor(() =>
      expect(runtime.settings.saveGeneralSettings).toHaveBeenCalledWith({
        close_window_behavior: null,
        conversation_send_default_mode: "queue",
      }),
    );
    expect(screen.getByRole("button", { name: /加入等待队列/ })).not.toBeNull();
  });
});

function fakeRuntime(general: GeneralSettings = { close_window_behavior: null }): RuntimeBridge {
  const response = {
    model: {
      base_url: "",
      model: "",
      timeout_seconds: 60,
      api_key_set: false,
      api_key_preview: null,
    },
    general,
    appearance: {
      font_family: "system" as const,
    },
    command: {
      selected_shell: "cmd" as const,
      shell_path: "C:/Windows/System32/cmd.exe",
      shell_label: "CMD",
      shell_edition: null,
      require_approval_for_untrusted: true,
      allow_persistent_trust: true,
      file_access_mode: "workspace_trusted" as const,
      default_timeout_seconds: 60,
      max_timeout_seconds: 600,
      inline_output_max_chars: 20000,
      tail_max_chars: 20000,
      output_file_max_bytes: 8388608,
      progress_interval_ms: 500,
    },
  };
  return {
    settings: {
      getSettings: vi.fn(() => Promise.resolve(response)),
      saveGeneralSettings: vi.fn((nextGeneral: GeneralSettings) =>
        Promise.resolve({ ...response, general: nextGeneral }),
      ),
    },
  } as unknown as RuntimeBridge;
}
