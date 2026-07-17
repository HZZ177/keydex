import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEYDEX_DIFF_SCROLL_OWNERS,
  KeydexDiffScrollMemory,
  createKeydexDiffScrollRestoreKey,
  resolveKeydexDiffScrollOwner,
  useKeydexDiffScrollBridge,
  type KeydexDiffViewportMetrics,
} from "@/renderer/components/diff/diffScroll";

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

describe("Keydex Diff scroll contract", () => {
  it("keeps compact content in its message host and all CodeViews off window scrolling", () => {
    expect(KEYDEX_DIFF_SCROLL_OWNERS).toEqual({
      compact: "host",
      review: "code_view",
      git: "code_view",
      preview: "code_view",
    });
    expect(resolveKeydexDiffScrollOwner("git")).toBe("code_view");
    expect(Object.values(KEYDEX_DIFF_SCROLL_OWNERS)).not.toContain("window");
  });

  it("creates isolated restore keys for profile, host scope, document and source version", () => {
    const base = {
      profile: "git" as const,
      scopeKey: "workspace:repo-a",
      documentId: "git:diff-a",
      sourceVersion: "sha-1",
    };
    const key = createKeydexDiffScrollRestoreKey(base);
    expect(key).toContain("keydex-diff-scroll-v1:git:");
    expect(createKeydexDiffScrollRestoreKey({ ...base })).toBe(key);
    expect(createKeydexDiffScrollRestoreKey({ ...base, sourceVersion: "sha-2" })).not.toBe(key);
    expect(createKeydexDiffScrollRestoreKey({ ...base, scopeKey: "workspace:repo-b" })).not.toBe(key);
  });

  it("bounds restored positions and evicts the oldest scope", () => {
    const memory = new KeydexDiffScrollMemory(2);
    memory.capture("a", 12);
    memory.capture("b", -10);
    memory.capture("c", 30);
    expect(memory.restore("a")).toBeNull();
    expect(memory.restore("b")).toBe(0);
    expect(memory.restore("c")).toBe(30);
    expect(memory.size()).toBe(2);
  });

  it("restores once on mount and once after display:none becomes visible", () => {
    const memory = new KeydexDiffScrollMemory();
    const key = createKeydexDiffScrollRestoreKey({
      profile: "git",
      scopeKey: "repo",
      documentId: "doc",
      sourceVersion: "v1",
    });
    memory.capture(key, 220);
    const restore = vi.fn();
    const metrics = vi.fn<(value: KeydexDiffViewportMetrics) => void>();
    render(<Harness memory={memory} restore={restore} metrics={metrics} />);
    const viewport = screen.getByTestId("viewport");

    act(() => publishResize(viewport, 800, 500));
    expect(restore).toHaveBeenLastCalledWith(220);
    act(() => publishResize(viewport, 0, 0));
    expect(metrics).toHaveBeenLastCalledWith({ width: 0, height: 0, visible: false });
    act(() => publishResize(viewport, 640, 360));
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenLastCalledWith(220);
  });

  it("captures CodeView scroll without subscribing to window scroll", () => {
    const memory = new KeydexDiffScrollMemory();
    const windowListener = vi.spyOn(window, "addEventListener");
    render(<Harness memory={memory} restore={vi.fn()} metrics={vi.fn()} />);
    screen.getByRole("button", { name: "记录滚动" }).click();
    const key = createKeydexDiffScrollRestoreKey({
      profile: "git",
      scopeKey: "repo",
      documentId: "doc",
      sourceVersion: "v1",
    });
    expect(memory.restore(key)).toBe(144);
    expect(windowListener.mock.calls.some(([event]) => event === "scroll")).toBe(false);
  });

  it("keeps CodeView as the single contained scroll owner", () => {
    const css = readFileSync(resolve(
      process.cwd(),
      "src/renderer/components/diff/engine/PierreCodeView.module.css",
    ), "utf8");
    expect(css).toContain("min-height: 0");
    expect(css).toContain("height: 100%");
    expect(css).toContain("overflow: auto");
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("bounds PatchDiff scrolling and gives the Git flex item a definite height", () => {
    const viewCss = readFileSync(resolve(
      process.cwd(),
      "src/renderer/components/diff/KeydexDiffView.module.css",
    ), "utf8");
    const gitCss = readFileSync(resolve(
      process.cwd(),
      "src/renderer/features/git/components/GitToolWindow.module.css",
    ), "utf8");
    expect(viewCss).toMatch(/\.patchViewport\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
    expect(viewCss).toMatch(/\.patchViewport\s*\{[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s);
    expect(viewCss).toMatch(/\.patchViewport\s*>\s*\*\s*\{[^}]*min-height:\s*100%;/s);
    expect(gitCss).toMatch(/data-keydex-diff-wrapper="git"[^}]*\{[^}]*height:\s*0;[^}]*min-height:\s*0;[^}]*flex:\s*1 1 0;/s);
    expect(gitCss).not.toMatch(/data-keydex-diff-wrapper="git"[^}]*\{[^}]*height:\s*auto;/s);
  });
});

function Harness({
  memory,
  restore,
  metrics,
}: {
  readonly memory: KeydexDiffScrollMemory;
  readonly restore: (position: number) => void;
  readonly metrics: (value: KeydexDiffViewportMetrics) => void;
}) {
  const bridge = useKeydexDiffScrollBridge({
    profile: "git",
    scopeKey: "repo",
    documentId: "doc",
    sourceVersion: "v1",
    memory,
    onRestoreRequested: restore,
    onViewportMetrics: metrics,
  });
  return (
    <div>
      <div ref={bridge.containerRef} data-testid="viewport" />
      <button type="button" onClick={() => bridge.onScroll(144)}>记录滚动</button>
    </div>
  );
}

function publishResize(target: Element, width: number, height: number) {
  if (!resizeCallback) throw new Error("ResizeObserver 未初始化");
  resizeCallback([{
    target,
    contentRect: { width, height } as DOMRectReadOnly,
  } as ResizeObserverEntry], {} as ResizeObserver);
}
