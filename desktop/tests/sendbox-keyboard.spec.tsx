import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import { isReverseSubmitFromKeyboard, shouldSubmitFromKeyboard } from "@/renderer/components/chat/SendBox/keyboard";

describe("SendBox keyboard and IME", () => {
  it("detects send keyboard intent without treating Shift+Enter or composition as submit", () => {
    expect(shouldSubmitFromKeyboard({ key: "Enter" }, false)).toBe(true);
    expect(shouldSubmitFromKeyboard({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: "Enter" }, true)).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: "Enter", nativeEvent: { isComposing: true } }, false)).toBe(false);
    expect(isReverseSubmitFromKeyboard({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isReverseSubmitFromKeyboard({ key: "Enter", metaKey: true })).toBe(true);
    expect(isReverseSubmitFromKeyboard({ key: "Enter" })).toBe(false);
  });

  it("submits on Enter and preserves Shift+Enter", () => {
    const onSend = vi.fn();
    render(<KeyboardSendBox onSend={onSend} />);

    const input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("prevents Enter from inserting a newline when submit is unavailable", () => {
    const onSend = vi.fn();
    render(<KeyboardSendBox value="" onSend={onSend} />);

    const input = screen.getByLabelText("继续输入");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the editable viewport pinned to the bottom after Shift+Enter", () => {
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    try {
      render(<KeyboardSendBox onSend={vi.fn()} />);

      const input = screen.getByLabelText("继续输入") as HTMLDivElement;
      Object.defineProperty(input, "scrollHeight", { configurable: true, value: 180 });
      Object.defineProperty(input, "scrollTop", { configurable: true, writable: true, value: 0 });

      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

      expect(input.scrollTop).toBe(180);
    } finally {
      requestAnimationFrame.mockRestore();
    }
  });

  it("keeps keyboard submit enabled while the runtime is running", () => {
    const onSend = vi.fn();
    render(<KeyboardSendBox runtimeState="running" onSend={onSend} />);

    const input = screen.getByLabelText("继续输入");
    expect(input.getAttribute("aria-disabled")).toBe("false");
    expect(input.getAttribute("contenteditable")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][3]).toEqual({ reverseDeliveryMode: false });
  });

  it("submits Ctrl+Enter as the reverse pending-input delivery behavior", () => {
    const onSend = vi.fn();
    render(<KeyboardSendBox runtimeState="running" onSend={onSend} />);

    const input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][3]).toEqual({ reverseDeliveryMode: true });
  });

  it("does not submit while Chinese IME composition is active", () => {
    const onSend = vi.fn();
    render(<KeyboardSendBox onSend={onSend} />);

    const input = screen.getByLabelText("继续输入");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

function KeyboardSendBox({
  value = "中文输入",
  runtimeState = "idle",
  onSend,
}: {
  value?: string;
  runtimeState?: "idle" | "starting" | "running" | "waiting_approval" | "cancelling" | "failed";
  onSend: () => void;
}) {
  return (
    <SendBox
      value={value}
      runtimeState={runtimeState}
      canSend={runtimeState !== "cancelling" && value.trim().length > 0}
      canStop={runtimeState === "running"}
      onChange={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
    />
  );
}
