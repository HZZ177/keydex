import { useLayoutEffect, useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalFit } from "@/renderer/features/terminal/useTerminalFit";
import type { TerminalXtermHandle } from "@/renderer/features/terminal/terminalXtermRegistry";

let observerCallback: ResizeObserverCallback | null = null;
const observe = vi.fn();
const disconnect = vi.fn();

describe("useTerminalFit", () => {
  beforeEach(() => {
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
    vi.unstubAllGlobals();
  });

  it("fits only a visible active surface, focuses it and deduplicates native resize", () => {
    const handle = fakeHandle();
    const onResize = vi.fn();
    const { unmount } = render(<FitHarness handle={handle} active visible onResize={onResize} />);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(handle.fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(handle.terminal.focus).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith({ cols: 100, rows: 30, pixelWidth: 640, pixelHeight: 320 });

    act(() => observerCallback?.([], {} as ResizeObserver));
    expect(handle.fitAddon.fit).toHaveBeenCalledTimes(2);
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
  return <div ref={ref} />;
}

function fakeHandle(): TerminalXtermHandle {
  return {
    terminalId: "terminal-1",
    terminal: {
      cols: 100,
      rows: 30,
      focus: vi.fn(),
    } as unknown as TerminalXtermHandle["terminal"],
    fitAddon: { fit: vi.fn() } as unknown as TerminalXtermHandle["fitAddon"],
    searchAddon: {} as TerminalXtermHandle["searchAddon"],
    webLinksAddon: {} as TerminalXtermHandle["webLinksAddon"],
    opened: true,
    host: null,
    dispose: vi.fn(),
  };
}
