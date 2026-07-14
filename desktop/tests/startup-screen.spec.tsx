import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StartupScreen } from "@/renderer/components/startup/StartupScreen";
import { NormalStartupBoundary } from "@/renderer/components/startup/NormalStartupBoundary";
import {
  STARTUP_EXIT_MS,
  STARTUP_MIN_VISIBLE_MS,
  remainingStartupVisibleMs,
} from "@/renderer/components/startup/startupTiming";

import { mockReducedMotionPreference } from "./helpers/motionPreference";

afterEach(() => {
  vi.useRealTimers();
});

describe("StartupScreen", () => {
  it("renders the approved text-free startup composition", () => {
    render(<StartupScreen />);

    const root = screen.getByTestId("startup-screen");
    const canvas = screen.getByTestId("startup-canvas");
    expect(root.dataset.phase).toBe("pending");
    expect(screen.getByTestId("titlebar").textContent).toBe("Keydex");
    expect(within(canvas).queryByRole("progressbar")).toBeNull();
    expect(within(canvas).queryByRole("button")).toBeNull();
    expect(canvas.textContent).toBe("");
    expect(canvas.querySelector("img")?.getAttribute("src")).toBe("/keydex-startup-mark.png");
  });

  it("locks the approved warm canvas and responsive logo scale", () => {
    const cssPath = resolve(process.cwd(), "src/renderer/components/startup/StartupScreen.module.css");
    const css = readFileSync(cssPath, "utf8").toLowerCase();
    expect(css).toContain("#f7f3ec");
    expect(css).toContain("clamp(220px, 26vw, 420px)");
    expect(css).not.toContain("progress");
    expect(css).not.toContain("#1677ff");
    expect(css).toContain("startup-signal-sweep 2400ms");
    expect(css).not.toContain("rotate(");
  });

  it("finishes the ready fade once in StrictMode", () => {
    vi.useFakeTimers();
    const onExitComplete = vi.fn();
    render(
      <StrictMode>
        <StartupScreen phase="exiting" onExitComplete={onExitComplete} />
      </StrictMode>,
    );

    act(() => vi.advanceTimersByTime(STARTUP_EXIT_MS - 1));
    expect(onExitComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });

  it("exposes reduced motion and the minimum visibility timing contract", () => {
    const restoreMotion = mockReducedMotionPreference(true);
    try {
      render(<StartupScreen />);
      expect(screen.getByTestId("startup-screen").dataset.reducedMotion).toBe("true");
      expect(STARTUP_MIN_VISIBLE_MS).toBe(550);
      expect(remainingStartupVisibleMs(100, 200)).toBe(450);
      expect(remainingStartupVisibleMs(100, 800)).toBe(0);
    } finally {
      restoreMotion();
    }
  });

  it("gates normal routes until the first ready transition completes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { rerender } = render(
      <NormalStartupBoundary launchIntent="normal" runtimeStatus="starting">
        <div>route-content</div>
      </NormalStartupBoundary>,
    );

    expect(screen.getByTestId("startup-screen").dataset.phase).toBe("pending");
    expect(screen.queryByText("route-content")).toBeNull();

    rerender(
      <NormalStartupBoundary launchIntent="normal" runtimeStatus="ready">
        <div>route-content</div>
      </NormalStartupBoundary>,
    );
    act(() => vi.advanceTimersByTime(STARTUP_MIN_VISIBLE_MS));
    expect(screen.getByTestId("startup-screen").dataset.phase).toBe("exiting");
    act(() => vi.advanceTimersByTime(STARTUP_EXIT_MS));
    expect(screen.getByText("route-content")).not.toBeNull();

    rerender(
      <NormalStartupBoundary launchIntent="normal" runtimeStatus="error">
        <div>route-content</div>
      </NormalStartupBoundary>,
    );
    expect(screen.getByText("route-content")).not.toBeNull();
    expect(screen.queryByTestId("startup-screen")).toBeNull();
  });

  it("keeps resolving visually static and bypasses external files immediately", () => {
    const { rerender } = render(
      <NormalStartupBoundary launchIntent="resolving" runtimeStatus="starting">
        <div>route-content</div>
      </NormalStartupBoundary>,
    );
    expect(screen.queryByTestId("startup-screen")).toBeNull();
    expect(screen.getByTestId("launch-intent-resolving")).not.toBeNull();
    expect(screen.queryByText("route-content")).toBeNull();

    rerender(
      <NormalStartupBoundary launchIntent="external-file" runtimeStatus="starting">
        <div>route-content</div>
      </NormalStartupBoundary>,
    );
    expect(screen.queryByTestId("startup-screen")).toBeNull();
    expect(screen.getByText("route-content")).not.toBeNull();
  });

  it("keeps startup status available to assistive technology without visible canvas copy", () => {
    render(<StartupScreen />);
    expect(screen.getByRole("status").textContent).toBe("本地服务正在启动");
    expect(screen.getByTestId("startup-canvas").textContent).toBe("");
  });

  it("shows one accessible icon-only retry for an initial normal error", () => {
    const retry = vi.fn();
    render(
      <NormalStartupBoundary launchIntent="normal" runtimeStatus="error" onRetry={retry}>
        <div>route-content</div>
      </NormalStartupBoundary>,
    );

    const canvas = screen.getByTestId("startup-canvas");
    const button = within(canvas).getByRole("button", { name: "重试启动本地服务" });
    expect(button.getAttribute("title")).toBe("重试启动本地服务");
    expect(canvas.textContent).toBe("");
    expect(screen.queryByText("route-content")).toBeNull();
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
