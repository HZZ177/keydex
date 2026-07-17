import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRafPanelResize } from "@/renderer/components/layout/useRafPanelResize";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRafPanelResize", () => {
  it("coalesces pointer previews and commits the final width only after pointerup", () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 17;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(<ResizeHarness onPreview={onPreview} onCommit={onCommit} />);

    const separator = screen.getByRole("separator", { name: "测试分界线" });
    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 120 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 145 }));

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(frame).not.toBeNull();
    flushFrame(frame);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith(145);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientX: 145 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(145);
  });

  it("uses the vertical coordinate and row resize cursor for horizontal separators", () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 23;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(<ResizeHarness axis="y" onPreview={onPreview} onCommit={onCommit} />);

    const separator = screen.getByRole("separator", { name: "测试分界线" });
    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 200 }));
    expect(document.body.style.cursor).toBe("row-resize");
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientY: 160 }));
    flushFrame(frame);
    expect(onPreview).toHaveBeenLastCalledWith(60);
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientY: 160 }));
    expect(onCommit).toHaveBeenLastCalledWith(60);
    expect(document.body.style.cursor).toBe("");
  });
});

function ResizeHarness({
  axis = "x",
  onPreview,
  onCommit,
}: {
  axis?: "x" | "y";
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const [width, setWidth] = useState(100);
  const resize = useRafPanelResize({
    axis,
    disabled: false,
    width,
    getWidth: (startWidth, startCoordinate, coordinate) => startWidth + coordinate - startCoordinate,
    onPreview,
    onCommit: (value) => {
      setWidth(value);
      onCommit(value);
    },
  });
  return (
    <div
      role="separator"
      aria-label="测试分界线"
      aria-valuenow={width}
      onPointerDown={resize.startDrag}
    />
  );
}

function flushFrame(frame: FrameRequestCallback | null): void {
  if (!frame) throw new Error("RAF 回调未调度");
  frame(performance.now());
}
