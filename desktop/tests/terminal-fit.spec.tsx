import { useLayoutEffect, useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TERMINAL_NATIVE_RESIZE_SETTLE_MS,
  useTerminalFit,
} from "@/renderer/features/terminal/useTerminalFit";
import type { TerminalXtermHandle } from "@/renderer/features/terminal/terminalXtermRegistry";

let observerCallback: ResizeObserverCallback | null = null;
const observe = vi.fn();
const disconnect = vi.fn();

describe("useTerminalFit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    observe.mockClear();
    disconnect.mockClear();
    observerCallback = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observerCallback = callback;
        }
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fits immediately but commits only the final settled size to the native PTY", () => {
    const handle = fakeHandle();
    const onResize = vi.fn();
    const { unmount } = render(<FitHarness handle={handle} active visible onResize={onResize} />);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(handle.fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(handle.terminal.focus).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(TERMINAL_NATIVE_RESIZE_SETTLE_MS));
    expect(handle.terminal.focus).toHaveBeenCalledTimes(1);
    expect(handle.terminal.refresh).toHaveBeenCalledWith(0, 29);
    expect(onResize).toHaveBeenCalledWith({ cols: 100, rows: 30, pixelWidth: 640, pixelHeight: 320 });

    act(() => {
      Object.defineProperty(screen.getByTestId("fit-host"), "clientHeight", { configurable: true, value: 20 });
      Object.defineProperty(handle.terminal, "rows", { configurable: true, value: 2 });
      observerCallback?.([], {} as ResizeObserver);
      vi.advanceTimersByTime(TERMINAL_NATIVE_RESIZE_SETTLE_MS / 2);
    });
    expect(handle.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledTimes(1);

    act(() => {
      Object.defineProperty(screen.getByTestId("fit-host"), "clientHeight", { configurable: true, value: 320 });
      Object.defineProperty(handle.terminal, "rows", { configurable: true, value: 30 });
      observerCallback?.([], {} as ResizeObserver);
      vi.advanceTimersByTime(TERMINAL_NATIVE_RESIZE_SETTLE_MS);
    });
    expect(handle.fitAddon.fit).toHaveBeenCalledTimes(3);
    expect(onResize).toHaveBeenCalledTimes(1);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not observe or focus an inactive or hidden surface", () => {
    const handle = fakeHandle();
    const { rerender } = render(<FitHarness handle={handle} active={false} visible onResize={vi.fn()} />);
    expect(observe).not.toHaveBeenCalled();
    expect(handle.terminal.focus).not.toHaveBeenCalled();
    rerender(<FitHarness handle={handle} active visible={false} onResize={vi.fn()} />);
    expect(observe).not.toHaveBeenCalled();
  });
});

function FitHarness({
  handle,
  active,
  visible,
  onResize,
}: {
  handle: TerminalXtermHandle;
  active: boolean;
  visible: boolean;
  onResize: (size: { cols: number; rows: number; pixelWidth: number; pixelHeight: number }) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    Object.defineProperty(ref.current, "clientWidth", { configurable: true, value: 640 });
    Object.defineProperty(ref.current, "clientHeight", { configurable: true, value: 320 });
  }, []);
  useTerminalFit({ hostRef: ref, handle, active, visible, onResize });
  return <div ref={ref} data-testid="fit-host" />;
}

function fakeHandle(): TerminalXtermHandle {
  return {
    terminalId: "terminal-1",
    terminal: {
      cols: 100,
      rows: 30,
      focus: vi.fn(),
      refresh: vi.fn(),
    } as unknown as TerminalXtermHandle["terminal"],
    fitAddon: { fit: vi.fn() } as unknown as TerminalXtermHandle["fitAddon"],
    searchAddon: {} as TerminalXtermHandle["searchAddon"],
    webLinksAddon: {} as TerminalXtermHandle["webLinksAddon"],
    opened: true,
    host: null,
    dispose: vi.fn(),
  };
}
