import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import { shouldSubmitFromKeyboard } from "@/renderer/components/chat/SendBox/keyboard";

describe("SendBox keyboard and IME", () => {
  it("detects send keyboard intent without treating Shift+Enter or composition as submit", () => {
    expect(shouldSubmitFromKeyboard({ key: "Enter" }, false)).toBe(true);
    expect(shouldSubmitFromKeyboard({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: "Enter" }, true)).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: "Enter", nativeEvent: { isComposing: true } }, false)).toBe(false);
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

  it("keeps keyboard submit disabled while the runtime is busy", () => {
    const onSend = vi.fn();
    render(<KeyboardSendBox runtimeState="running" onSend={onSend} />);

    const input = screen.getByLabelText("继续输入") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
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
  runtimeState = "idle",
  onSend,
}: {
  runtimeState?: "idle" | "starting" | "running" | "waiting_approval" | "cancelling" | "failed";
  onSend: () => void;
}) {
  return (
    <SendBox
      value="中文输入"
      runtimeState={runtimeState}
      canSend={runtimeState === "idle"}
      canStop={runtimeState === "running"}
      onChange={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
    />
  );
}
