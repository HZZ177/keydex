import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserPanel } from "../src/renderer/features/browser/ui/BrowserPanel";

const surface = { panelId: "panel-1", surfaceId: "surface-1", generation: 1 } as const;

function renderPanel(overrides: Partial<React.ComponentProps<typeof BrowserPanel>> = {}) {
  const props: React.ComponentProps<typeof BrowserPanel> = {
    active: true,
    address: "https://example.com",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    profileMode: "persistent",
    surfaceReady: true,
    surface,
    title: "Example",
    zoomFactor: 1,
    onAddressChange: vi.fn(),
    onAddressSubmit: vi.fn(),
    onReload: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<div data-theme="light"><BrowserPanel {...props} /></div>) };
}

describe("BrowserPanel chrome", () => {
  it("mounts the geometry owner when the native surface becomes ready", () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const rect = {
      x: 120,
      y: 84,
      width: 640,
      height: 520,
      top: 84,
      right: 760,
      bottom: 604,
      left: 120,
      toJSON: () => ({}),
    } as DOMRect;
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const view = renderPanel({ active: true, surface: null, surfaceReady: false });

    act(() => callbacks.shift()?.(0));
    view.rerender(
      <div data-theme="light">
        <BrowserPanel {...view.props} active surface={surface} surfaceReady />
      </div>,
    );
    act(() => callbacks.shift()?.(1));

    expect(document.querySelector("[data-browser-native-surface='placeholder']")).not.toBeNull();
    bounds.mockRestore();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("keeps navigation state, profile, and native surface visually separated without a duplicate title row", () => {
    renderPanel({ loading: true, profileMode: "incognito" });
    expect((screen.getByRole("textbox", { name: "地址或搜索" }) as HTMLInputElement).value).toBe("https://example.com");
    expect(screen.getByLabelText("无痕浏览")).not.toBeNull();
    expect(screen.queryByText("Example")).toBeNull();
    expect(document.querySelector("[class*='pageIdentity']")).toBeNull();
    expect(document.querySelector("[class*='loadingTrack']")).not.toBeNull();
    expect(document.querySelector("[data-browser-native-surface='placeholder']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "后退" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "停止加载" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "新建浏览器面板" })).toBeNull();
  });

  it("mounts browser popovers inside the native-surface overlay instead of the layout accessory row", () => {
    const view = renderPanel({
      surfaceOverlay: <div data-browser-surface-occlusion="true">浮层内容</div>,
    });

    const overlay = view.container.querySelector("[class*='surfaceOverlay']");
    const accessory = view.container.querySelector("[class*='toolbarAccessory']");
    expect(overlay?.textContent).toContain("浮层内容");
    expect(accessory?.textContent).not.toContain("浮层内容");
  });

  it("submits the address by keyboard and exposes focus-visible native controls", () => {
    const onAddressSubmit = vi.fn();
    renderPanel({ onAddressSubmit });
    const address = screen.getByRole("textbox", { name: "地址或搜索" });
    address.focus();
    expect(document.activeElement).toBe(address);
    fireEvent.keyDown(address, { key: "Enter" });
    fireEvent.submit(address.closest("form")!);
    expect(onAddressSubmit).toHaveBeenCalledWith("https://example.com");
  });

  it("uses inherited theme state without injecting styles into the remote surface", () => {
    const view = renderPanel();
    const root = view.container.firstElementChild as HTMLElement;
    root.dataset.theme = "dark";
    expect(view.container.querySelector("[data-browser-panel='true']")?.hasAttribute("style")).toBe(false);
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  it("renders a themed startup state while the native surface is unavailable", () => {
    renderPanel({ surfaceReady: false, title: "" });
    expect(screen.getByRole("status").textContent).toContain("正在启动浏览器");
  });

  it("renders a themed new-tab page and prompts for a URL without exposing the native blank surface", () => {
    renderPanel({ address: "", empty: true, surfaceReady: true, title: "新标签页" });

    expect(screen.getByRole("textbox", { name: "地址或搜索" }).getAttribute("placeholder")).toBe("输入 URL");
    expect(screen.getByRole("status").textContent).toContain("开始浏览");
    expect(screen.getByRole("status").textContent).toContain("在顶部输入 URL 或搜索内容");
  });

  it("starts the current-page annotation mode from the themed toolbar badge", () => {
    const onAnnotations = vi.fn();
    renderPanel({ onAnnotations });

    const button = screen.getByRole("button", { name: "网页批注" });
    expect(button.getAttribute("data-active")).toBe("false");
    expect(button.querySelector(".lucide-mouse-pointer-click")).not.toBeNull();
    fireEvent.click(button);

    expect(onAnnotations).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /查看网页批注/ })).toBeNull();
  });

  it("uses the shared Keydex tooltip layer for browser toolbar buttons", () => {
    vi.useFakeTimers();
    renderPanel();

    fireEvent.pointerOver(screen.getByRole("button", { name: "刷新" }));
    act(() => vi.advanceTimersByTime(260));

    expect(screen.getByRole("tooltip").textContent).toBe("刷新");
    expect(screen.getByRole("tooltip").getAttribute("data-placement")).toBe("top");
    vi.useRealTimers();
  });

  it("shows the annotation button as an active toggle while inspecting the page", () => {
    const onAnnotations = vi.fn();
    renderPanel({ annotationActive: true, onAnnotations });

    const button = screen.getByRole("button", { name: "退出批注模式" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-active")).toBe("true");
    expect(button.querySelector(".lucide-mouse-pointer-click")).not.toBeNull();
    expect(button.querySelector('[data-mode-copy="active"]')?.textContent).toBe("批注模式");
    expect(button.querySelector('[data-mode-copy="close"]')?.textContent).toBe("点击关闭");
    expect(button.hasAttribute("data-tooltip-label")).toBe(false);
    fireEvent.click(button);
    expect(onAnnotations).toHaveBeenCalledTimes(1);
  });

  it("uses Globe for browser identity icons", () => {
    const view = renderPanel({ address: "", empty: true });
    expect(view.container.querySelectorAll(".lucide-globe").length).toBeGreaterThanOrEqual(2);
    expect(view.container.querySelector(".lucide-globe-2")).toBeNull();
  });

  it.each([
    ["loading", "下载进行中"],
    ["success", "下载完成"],
    ["error", "下载失败"],
  ] as const)("shows the %s download status on the toolbar indicator", (indicator, label) => {
    renderPanel({ downloadsIndicator: indicator, onDownloads: vi.fn() });

    expect(screen.getByRole("button", { name: label }).getAttribute("data-download-indicator")).toBe(indicator);
  });
});
