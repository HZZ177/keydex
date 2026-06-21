import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";

describe("SendBox", () => {
  it("renders a Codex-like floating input shell without unavailable actions", () => {
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        statusText="回车发送"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("继续输入")).not.toBeNull();
    expect(screen.getByPlaceholderText("要求后续变更")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
    expect(screen.queryByText("按需审批")).toBeNull();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tracks focus state and submits when sending is allowed", () => {
    const onSend = vi.fn();
    render(
      <SendBox
        value="继续修改"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    const form = input.closest("form");
    expect(form?.getAttribute("data-focused")).toBe("false");

    fireEvent.focus(input);
    expect(form?.getAttribute("data-focused")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps runtime controls immediately before the send button", () => {
    render(
      <SendBox
        value="继续修改"
        runtimeState="idle"
        canSend
        canStop={false}
        statusText="回车发送"
        rightControls={<button type="button" aria-label="选择模型">qwen-coder</button>}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const status = screen.getByText("回车发送");
    const model = screen.getByRole("button", { name: "选择模型" });
    const send = screen.getByRole("button", { name: "发送" });

    expect(Boolean(status.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(model.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("switches to stop button while running and prevents repeated send", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(
      <SendBox
        value="继续修改"
        runtimeState="running"
        canSend={false}
        canStop
        onChange={vi.fn()}
        onSend={onSend}
        onStop={onStop}
      />,
    );

    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect((screen.getByLabelText("继续输入") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "继续对话输入" }));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables stop while cancelling and restores send after failure", () => {
    const { rerender } = render(
      <SendBox
        value="继续修改"
        runtimeState="cancelling"
        canSend={false}
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <SendBox
        value="继续修改"
        runtimeState="failed"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "发送" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the composer height adaptive for long multiline input", () => {
    const props = {
      runtimeState: "idle" as const,
      canSend: true,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<SendBox value="短文本" {...props} />);
    const input = screen.getByLabelText("继续输入") as HTMLTextAreaElement;

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 220 });
    rerender(<SendBox value={"第一行\n第二行\n第三行\n第四行"} {...props} />);
    expect(input.style.height).toBe("188px");

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 82 });
    rerender(<SendBox value={"第一行\n第二行"} {...props} />);
    expect(input.style.height).toBe("82px");
  });
});
