import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppTooltipLayer } from "@/renderer/components/tooltip";
import { AppProviders } from "@/renderer/providers/AppProviders";

describe("AppTooltipLayer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows scoped button labels with the custom tooltip layer", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
        <button type="button" aria-label="复制消息" data-tooltip-label="复制消息">
          copy
        </button>
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "复制消息" }));
    act(() => vi.advanceTimersByTime(20));

    expect(screen.getByRole("tooltip").textContent).toBe("复制消息");
  });

  it("lets a nested owned layer handle its target without duplicate ancestor tooltips", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="parent">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='parent']" delayMs={20} />
        <div data-tooltip-scope="child" data-app-tooltip-owner="child-diff">
          <AppTooltipLayer
            scopeSelector="[data-tooltip-scope='child']"
            ownerId="child-diff"
            delayMs={20}
          />
          <button type="button" aria-label="复制补丁" data-tooltip-label="复制补丁">
            copy
          </button>
        </div>
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "复制补丁" }));
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getAllByRole("tooltip", { name: "复制补丁" })).toHaveLength(1);
  });

  it("suppresses native titles while hovering and restores them after hide", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
        <button type="button" aria-label="定位当前文件" data-tooltip="true" title="定位当前文件">
          locate
        </button>
      </div>,
    );

    const button = screen.getByRole("button", { name: "定位当前文件" });
    fireEvent.pointerOver(button);
    expect(button.getAttribute("title")).toBeNull();

    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole("tooltip").textContent).toBe("定位当前文件");

    fireEvent.pointerOut(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("定位当前文件");
  });

  it("converts native button titles into the custom tooltip without per-button opt-in", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer
          scopeSelector="[data-tooltip-scope='true']"
          delayMs={20}
          targetMode="native-interactive-title"
        />
        <button type="button" title="关闭预览">
          关闭
        </button>
      </div>,
    );

    const button = screen.getByRole("button", { name: "关闭" });
    fireEvent.pointerOver(button);
    expect(button.getAttribute("title")).toBeNull();

    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole("tooltip").textContent).toBe("关闭预览");

    fireEvent.pointerOut(button);
    expect(button.getAttribute("title")).toBe("关闭预览");
  });

  it("converts titled interactive links that are visually used as controls", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer
          scopeSelector="[data-tooltip-scope='true']"
          delayMs={20}
          targetMode="native-interactive-title"
        />
        <a href="#source" aria-label="查看来源 1" title="查看对应来源">
          1
        </a>
      </div>,
    );

    const link = screen.getByRole("link", { name: "查看来源 1" });
    fireEvent.pointerOver(link);
    expect(link.getAttribute("title")).toBeNull();

    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole("tooltip").textContent).toBe("查看对应来源");

    fireEvent.pointerOut(link);
    expect(link.getAttribute("title")).toBe("查看对应来源");
  });

  it("mounts the native button title fallback for the whole application", () => {
    vi.useFakeTimers();
    const starter = vi.fn(() => new Promise<never>(() => undefined));
    render(
      <AppProviders runtimeConnection={{ starter }}>
        <button type="button" title="应用级操作">
          操作
        </button>
      </AppProviders>,
    );

    const button = screen.getByRole("button", { name: "操作" });
    fireEvent.pointerOver(button);
    expect(button.getAttribute("title")).toBeNull();

    act(() => vi.advanceTimersByTime(420));
    expect(screen.getByRole("tooltip").textContent).toBe("应用级操作");
  });

  it("prefers explicit functional labels over contextual accessible names", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
        <button type="button" aria-label="置顶 初次问候与自我介绍 分支" data-tooltip-label="置顶">
          <span aria-hidden="true">pin</span>
        </button>
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "置顶 初次问候与自我介绍 分支" }));
    act(() => vi.advanceTimersByTime(20));

    expect(screen.getByRole("tooltip").textContent).toBe("置顶");
  });

  it("supports multiline explanatory tooltips without truncating their content", () => {
    vi.useFakeTimers();
    const explanation = "免费计划每月提供 1,000 API Credits，基础搜索每次消耗 1 Credit。";
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
        <button
          type="button"
          aria-label="额度说明"
          data-tooltip-label={explanation}
          data-tooltip-multiline="true"
        >
          info
        </button>
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "额度说明" }));
    act(() => vi.advanceTimersByTime(20));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe(explanation);
    expect(tooltip.getAttribute("data-multiline")).toBe("true");
  });

  it("does not infer contextual labels for visible text buttons without an explicit tooltip", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
        <button type="button" aria-label="置顶 初次问候与自我介绍 分支">
          置顶
        </button>
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "置顶 初次问候与自我介绍 分支" }));
    act(() => vi.advanceTimersByTime(20));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("does not infer labels from aria-label without an explicit tooltip opt-in", () => {
    vi.useFakeTimers();
    render(
      <div data-tooltip-scope="true">
        <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
        <button type="button" aria-label="展开工具详情">
          <span aria-hidden="true">⌄</span>
        </button>
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "展开工具详情" }));
    act(() => vi.advanceTimersByTime(20));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps edge tooltips inside the viewport", () => {
    vi.useFakeTimers();
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const element = this as HTMLElement;
      if (element.getAttribute("role") === "tooltip") {
        const left = Number.parseFloat(element.style.left || "0");
        const top = Number.parseFloat(element.style.top || "0");
        return domRect({
          left: left - 60,
          right: left + 60,
          top: top - 24,
          bottom: top - 4,
          width: 120,
          height: 20,
        });
      }
      if (element.dataset.edgeTarget === "true") {
        return domRect({ left: 780, right: 800, top: 100, bottom: 120, width: 20, height: 20 });
      }
      return originalRect.call(this);
    };

    try {
      render(
        <div data-tooltip-scope="true">
          <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
          <button type="button" aria-label="打开文件" data-edge-target="true" data-tooltip-label="打开文件">
            open
          </button>
        </div>,
      );

      fireEvent.pointerOver(screen.getByRole("button", { name: "打开文件" }));
      act(() => vi.advanceTimersByTime(20));

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toBe("打开文件");
      expect(Number.parseFloat(tooltip.style.left)).toBe(732);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("does not loop when a half-pixel edge correction rounds to the current position", () => {
    vi.useFakeTimers();
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const element = this as HTMLElement;
      if (element.getAttribute("role") === "tooltip") {
        return domRect({ left: 680.5, right: 792.5, top: 76, bottom: 96, width: 112, height: 20 });
      }
      if (element.dataset.subpixelEdgeTarget === "true") {
        return domRect({ left: 722, right: 742, top: 100, bottom: 120, width: 20, height: 20 });
      }
      return originalRect.call(this);
    };

    try {
      render(
        <div data-tooltip-scope="true">
          <AppTooltipLayer scopeSelector="[data-tooltip-scope='true']" delayMs={20} />
          <button
            type="button"
            aria-label="批注整个 HTML 预览"
            data-subpixel-edge-target="true"
            data-tooltip-label="批注整个 HTML 预览"
          >
            annotate
          </button>
        </div>,
      );

      fireEvent.pointerOver(screen.getByRole("button", { name: "批注整个 HTML 预览" }));
      expect(() => act(() => vi.advanceTimersByTime(20))).not.toThrow();

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toBe("批注整个 HTML 预览");
      expect(Number.parseFloat(tooltip.style.left)).toBe(732);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });
});

function domRect({
  left,
  right,
  top,
  bottom,
  width,
  height,
}: {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    left,
    right,
    top,
    bottom,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
