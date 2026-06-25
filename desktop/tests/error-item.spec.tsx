import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorItem, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("ErrorItem", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders real error message, code, http status and collapsible details", () => {
    render(<ErrorItem message={errorMessage()} />);

    expect(screen.getByText("模型请求失败：HTTP 400")).not.toBeNull();
    expect(screen.getByText("turn_error")).not.toBeNull();
    expect(screen.getByText("HTTP 400")).not.toBeNull();
    expect(screen.queryByText(/openai-compatible/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "错误详情" }));
    expect(screen.getByText(/openai-compatible/)).not.toBeNull();
  });

  it("summarizes verbose gateway rate-limit errors and folds the raw payload", () => {
    render(
      <ErrorItem
        message={errorMessage({
          code: "runtime_error",
          message:
            "Error code: 429 - {'error': {'code': '429001', 'message': 'rate limit exceeded on dimension: rpm', 'type': 'gateway_error', 'request_id': 'efa584bd-cc5e-403c-8202-61ece18f8b7f'}}",
          status: undefined,
        })}
      />,
    );

    expect(screen.getByText("请求过于频繁（rpm 限流），请稍后再试")).not.toBeNull();
    expect(screen.getByText("429001")).not.toBeNull();
    expect(screen.getByText("HTTP 429")).not.toBeNull();
    expect(screen.queryByText(/rate limit exceeded on dimension/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "错误详情" }));
    expect(screen.getByText(/rate limit exceeded on dimension/)).not.toBeNull();
  });

  it("copies structured error payload", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<ErrorItem message={errorMessage()} />);

    fireEvent.click(screen.getByRole("button", { name: "复制错误" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("模型请求失败：HTTP 400"));
    });
    expect(screen.getByText("已复制")).not.toBeNull();
  });

  it("keeps raw stack traces inside collapsed details", () => {
    render(
      <ErrorItem
        message={errorMessage({
          message: "Traceback (most recent call last):\n  File \"app.py\", line 1\nValueError: provider failed",
          details: { provider: "openai-compatible" },
        })}
      />,
    );

    expect(screen.getByText("运行失败，详细信息已折叠")).not.toBeNull();
    expect(screen.queryByText(/app.py/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "错误详情" }));
    expect(screen.getByText(/app.py/)).not.toBeNull();
  });

  it("is used by MessageList for error messages", () => {
    render(<MessageList messages={[errorMessage()]} />);

    expect(screen.getByTestId("error-item")).not.toBeNull();
    expect(screen.getByText("模型请求失败：HTTP 400")).not.toBeNull();
  });
});

function errorMessage(errorPatch: Record<string, unknown> = {}): ConversationMessage {
  return {
    id: "error-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    kind: "error",
    status: "failed",
    content: "模型请求失败：HTTP 400",
    payload: {
      error: {
        code: "turn_error",
        message: "模型请求失败：HTTP 400",
        status: 400,
        details: {
          provider: "openai-compatible",
          path: "/v1/chat/completions",
        },
        ...errorPatch,
      },
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:00Z",
  };
}
