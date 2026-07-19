import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEYDEX_DIFF_SPLIT_THRESHOLDS,
  KeydexDiffLayoutBridge,
  resolveKeydexDiffLayout,
} from "@/renderer/components/diff/DiffLayoutBridge";

let resizeCallback: ResizeObserverCallback | null = null;

beforeEach(() => {
  resizeCallback = null;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Keydex Diff layout bridge", () => {
  it.each([
    ["compact", "stacked", 1200, "stacked", false],
    ["review", "stacked", 400, "stacked", false],
    ["review", "split", 700, "split", false],
    ["git", "split", 900, "split", false],
    ["git", "split", 620, "stacked", true],
    ["preview", "split", 700, "stacked", true],
    ["preview", "stacked", 300, "stacked", false],
  ] as const)(
    "%s + %s at %d px resolves to %s",
    (profile, preferredLayout, width, effectiveLayout, autoDowngraded) => {
      const decision = resolveKeydexDiffLayout({ profile, preferredLayout, width, wrap: true });
      expect(decision.effectiveLayout).toBe(effectiveLayout);
      expect(decision.autoDowngraded).toBe(autoDowngraded);
      expect(decision.wrap).toBe(true);
    },
  );

  it("uses hysteresis so split does not flicker while a divider is dragged", () => {
    const threshold = KEYDEX_DIFF_SPLIT_THRESHOLDS.git;
    expect(resolveKeydexDiffLayout({
      profile: "git",
      preferredLayout: "split",
      wrap: false,
      width: threshold.collapse - 1,
    }).effectiveLayout).toBe("stacked");
    expect(resolveKeydexDiffLayout({
      profile: "git",
      preferredLayout: "split",
      wrap: false,
      width: threshold.collapse + 20,
      wasAutoDowngraded: true,
    }).effectiveLayout).toBe("stacked");
    expect(resolveKeydexDiffLayout({
      profile: "git",
      preferredLayout: "split",
      wrap: false,
      width: threshold.recover,
      wasAutoDowngraded: true,
    }).effectiveLayout).toBe("split");
  });

  it("does not overwrite the preferred split layout when the effective layout degrades", () => {
    const decision = resolveKeydexDiffLayout({
      profile: "git",
      preferredLayout: "split",
      wrap: false,
      width: 320,
    });
    expect(decision.preferredLayout).toBe("split");
    expect(decision.effectiveLayout).toBe("stacked");
    expect(decision.splitDisabledReason).toContain("已暂时使用统一布局");
  });

  it("observes host width, downgrades and restores without replacing content", () => {
    const { container } = render(
      <KeydexDiffLayoutBridge profile="git" preferredLayout="split" wrap={false}>
        {(decision) => <span data-testid="content">{decision.effectiveLayout}</span>}
      </KeydexDiffLayoutBridge>,
    );
    const bridge = container.querySelector("[data-keydex-diff-layout-bridge]") as HTMLDivElement;
    const content = screen.getByTestId("content");
    act(() => publishResize(bridge, 600));
    expect(content.textContent).toBe("stacked");
    expect(bridge.getAttribute("data-preferred-layout")).toBe("split");
    act(() => publishResize(bridge, 760));
    expect(content.textContent).toBe("split");
    expect(screen.getByTestId("content")).toBe(content);
  });

  it("keeps wrapping independent from automatic layout fallback", () => {
    const decision = resolveKeydexDiffLayout({
      profile: "preview",
      preferredLayout: "split",
      wrap: true,
      width: 400,
    });
    expect(decision.effectiveLayout).toBe("stacked");
    expect(decision.wrap).toBe(true);
  });

  it("uses the actual container mode for embedded review and preview thresholds", () => {
    const reviewFull = resolveKeydexDiffLayout({
      profile: "review",
      preferredLayout: "split",
      wrap: true,
      width: 720,
      embedded: false,
    });
    const reviewEmbedded = resolveKeydexDiffLayout({
      profile: "review",
      preferredLayout: "split",
      wrap: true,
      width: 720,
      embedded: true,
    });
    expect(reviewFull.effectiveLayout).toBe("split");
    expect(reviewEmbedded.effectiveLayout).toBe("stacked");
    expect(reviewEmbedded.preferredLayout).toBe("split");
    expect(reviewEmbedded.splitCollapseWidth).toBe(760);

    const previewEmbedded = resolveKeydexDiffLayout({
      profile: "preview",
      preferredLayout: "split",
      wrap: true,
      width: 750,
      embedded: true,
    });
    expect(previewEmbedded.effectiveLayout).toBe("stacked");
    expect(previewEmbedded.splitCollapseWidth).toBe(760);
  });

  it("does not reconcile the Git Diff tree for width changes inside the same layout bucket", () => {
    const renderedWidths: number[] = [];
    const { container } = render(
      <KeydexDiffLayoutBridge profile="git" preferredLayout="split" wrap={false}>
        {(decision) => {
          renderedWidths.push(decision.width);
          return <span>{decision.effectiveLayout}</span>;
        }}
      </KeydexDiffLayoutBridge>,
    );
    const bridge = container.querySelector("[data-keydex-diff-layout-bridge]") as HTMLDivElement;

    act(() => publishResize(bridge, 900));
    const splitRenderCount = renderedWidths.length;
    act(() => publishResize(bridge, 860));
    expect(renderedWidths).toHaveLength(splitRenderCount);
    act(() => publishResize(bridge, 600));
    expect(renderedWidths).toHaveLength(splitRenderCount + 1);
    expect(bridge.getAttribute("data-layout")).toBe("stacked");
  });

  it("remembers a wide container while stacked so a later split preference is not downgraded from width zero", () => {
    const { container, rerender } = render(
      <KeydexDiffLayoutBridge profile="preview" preferredLayout="stacked" wrap={false}>
        {(decision) => <span data-testid="layout-width">{decision.effectiveLayout}:{decision.width}</span>}
      </KeydexDiffLayoutBridge>,
    );
    const bridge = container.querySelector("[data-keydex-diff-layout-bridge]") as HTMLDivElement;
    act(() => publishResize(bridge, 1_200));

    rerender(
      <KeydexDiffLayoutBridge profile="preview" preferredLayout="split" wrap={false}>
        {(decision) => <span data-testid="layout-width">{decision.effectiveLayout}:{decision.width}</span>}
      </KeydexDiffLayoutBridge>,
    );

    expect(screen.getByTestId("layout-width").textContent).toBe("split:1200");
    expect(bridge.getAttribute("data-auto-downgraded")).toBe("false");
  });

  it("contains horizontal overflow at the Diff host instead of the page", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffLayoutBridge.module.css"), "utf8");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("max-width: 100%");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("contain: inline-size");
  });
});

function publishResize(target: Element, width: number) {
  if (!resizeCallback) throw new Error("ResizeObserver 未初始化");
  resizeCallback([
    {
      target,
      contentRect: { width } as DOMRectReadOnly,
    } as ResizeObserverEntry,
  ], {} as ResizeObserver);
}
