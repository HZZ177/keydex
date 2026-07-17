import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeydexDiffAccessibilityBridge } from "@/renderer/components/diff/DiffAccessibility";
import {
  createKeydexDiffFocusReturn,
  keydexDiffScrollBehavior,
  prefersReducedMotion,
} from "@/renderer/components/diff/diffKeyboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Keydex Diff keyboard and focus bridge", () => {
  it("moves only among explicit Diff targets with arrows, Home and End", () => {
    render(<KeyboardHarness />);
    const first = screen.getByRole("button", { name: "文件一" });
    const second = screen.getByRole("button", { name: "文件二" });
    const third = screen.getByRole("button", { name: "文件三" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("activates non-native targets with Enter and Space", () => {
    const action = vi.fn();
    render(
      <KeydexDiffAccessibilityBridge profile="review">
        <div
          data-keydex-diff-focus-target="true"
          role="button"
          tabIndex={0}
          onClick={action}
        >
          打开文件
        </div>
      </KeydexDiffAccessibilityBridge>,
    );
    const target = screen.getByRole("button", { name: "打开文件" });
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.keyDown(target, { key: " " });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("clears Diff selection with Escape without handling inputs or app shortcuts", () => {
    const clear = vi.fn();
    render(
      <KeydexDiffAccessibilityBridge profile="git" onClearSelection={clear}>
        <button type="button" data-keydex-diff-focus-target="true">差异行</button>
        <input aria-label="筛选" />
      </KeydexDiffAccessibilityBridge>,
    );
    const row = screen.getByRole("button", { name: "差异行" });
    const input = screen.getByRole("textbox", { name: "筛选" });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(row, { key: "ArrowDown", ctrlKey: true });
    expect(clear).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("restores focus only while the original target remains connected", () => {
    const { unmount } = render(<button type="button">返回目标</button>);
    const target = screen.getByRole("button", { name: "返回目标" });
    target.focus();
    const restore = createKeydexDiffFocusReturn(target);
    document.body.focus();
    expect(restore()).toBe(true);
    expect(document.activeElement).toBe(target);
    unmount();
    expect(restore()).toBe(false);
  });

  it("downgrades smooth scrolling and reads the OS reduced-motion preference", () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    expect(prefersReducedMotion()).toBe(true);
    expect(keydexDiffScrollBehavior("smooth", true)).toBe("instant");
    expect(keydexDiffScrollBehavior("smooth", false)).toBe("smooth");
  });

  it("applies reduced-motion rules to the complete Keydex Diff surface", () => {
    const css = readFileSync(resolve(
      process.cwd(),
      "src/renderer/components/diff/DiffSurface.module.css",
    ), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("scroll-behavior: auto !important");
    expect(css).toContain("animation-duration: 0.01ms !important");
  });
});

function KeyboardHarness() {
  return (
    <KeydexDiffAccessibilityBridge profile="review">
      <button type="button" data-keydex-diff-focus-target="true">文件一</button>
      <button type="button" data-keydex-diff-focus-target="true">文件二</button>
      <button type="button" data-keydex-diff-focus-target="true">文件三</button>
    </KeydexDiffAccessibilityBridge>
  );
}
