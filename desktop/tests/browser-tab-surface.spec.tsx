import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  BrowserTabHostAdapter,
  BrowserTabState,
} from "@/renderer/features/browser/domain";
import {
  BrowserTabSurface,
  browserAnnotationDisabledReason,
} from "@/renderer/features/browser/ui/BrowserTabSurface";

vi.mock("@/renderer/providers/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("@/renderer/providers/NotificationProvider", () => ({
  useNotifications: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

function state(id: string): BrowserTabState {
  return {
    id,
    title: "Shared Browser",
    restoreUrl: "",
    restoreUrlSanitized: false,
    profileMode: "persistent",
    zoomFactor: 1,
    createdAt: "2026-07-23T00:00:00.000Z",
    lastActivatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function host(kind: "agent" | "workbench"): BrowserTabHostAdapter {
  return {
    kind,
    scopeKey: kind === "agent" ? "session:agent-session" : "workspace:workspace-a",
    composerScopeKey: "session:current-session",
    active: true,
    state: state(`${kind}-tab`),
    updateState: vi.fn(),
    createTab: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
  };
}

describe("BrowserTabSurface", () => {
  it.each(["agent", "workbench"] as const)(
    "renders the same complete browser chrome for the %s host",
    async (kind) => {
      const adapter = host(kind);
      const view = render(<BrowserTabSurface host={adapter} />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(view.container.querySelector("[data-content='browser']")?.getAttribute(
        "data-browser-host",
      )).toBe(kind);
      expect(screen.getByRole("textbox", { name: "地址或搜索" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "刷新" })).not.toBeNull();
      expect(screen.getByRole("button", { name: /网页批注/ })).not.toBeNull();
      expect(screen.getByRole("button", { name: "下载" })).not.toBeNull();

      fireEvent.keyDown(window, { key: "w", ctrlKey: true });
      expect(adapter.closeTab).toHaveBeenCalledWith(adapter.state.id);
    },
  );

  it("keeps host failures isolated by runtime panel scope", () => {
    const agent = host("agent");
    const workbench = host("workbench");
    const first = render(<BrowserTabSurface host={agent} />);
    const second = render(<BrowserTabSurface host={workbench} />);

    expect(first.container.querySelector("[data-browser-host='agent']")).not.toBeNull();
    expect(second.container.querySelector("[data-browser-host='workbench']")).not.toBeNull();
    expect(agent.state.id).not.toBe(workbench.state.id);
  });

  it("shows an accessible non-Tauri fallback without an iframe and keeps Workbench tab close usable", async () => {
    const baseAdapter = host("workbench");
    const adapter: BrowserTabHostAdapter = {
      ...baseAdapter,
      state: {
        ...baseAdapter.state,
        restoreUrl: "file:///D:/workspace/index.html",
      },
    };
    const view = render(<BrowserTabSurface host={adapter} />);

    expect(
      (await screen.findByRole("alert")).getAttribute("data-browser-error"),
    ).toBe("desktop_runtime_required");
    expect(screen.getByText("需要 Keydex 桌面运行时")).not.toBeNull();
    expect(screen.getByText(/仍可关闭或切换此标签，并继续使用文件树和助手/)).not.toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("textbox", { name: "地址或搜索" })).not.toBeNull();

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(adapter.closeTab).toHaveBeenCalledWith("workbench-tab");
  });

  it("exposes distinct accessible reasons for preparing, incognito, and failed annotation states", () => {
    expect(browserAnnotationDisabledReason({
      profileMode: "persistent",
      ready: false,
      loading: true,
      failed: false,
    })).toBe("网页批注正在准备");
    expect(browserAnnotationDisabledReason({
      profileMode: "incognito",
      ready: true,
      loading: false,
      failed: false,
    })).toBe("无痕模式不保存网页批注");
    expect(browserAnnotationDisabledReason({
      profileMode: "persistent",
      ready: true,
      loading: false,
      failed: true,
    })).toBe("当前页面不可用，无法创建网页批注");
  });
});
