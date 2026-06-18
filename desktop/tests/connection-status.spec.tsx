import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionStatus } from "@/renderer/components/runtime";
import { createInitialRuntimeState, runtimeReducer } from "@/renderer/stores/runtimeStore";

describe("ConnectionStatus", () => {
  it("renders the active runtime error and clears it", () => {
    const onClearError = vi.fn();
    const state = runtimeReducer(createInitialRuntimeState(), {
      type: "error/record",
      source: "model",
      id: "err-model",
      now: "2026-06-17T10:00:00Z",
      error: { code: "provider_error", message: "模型服务返回 400" },
    });

    render(<ConnectionStatus state={state} onClearError={onClearError} />);

    expect(screen.getByTestId("connection-status").dataset.status).toBe("error");
    expect(screen.getByText("模型异常")).not.toBeNull();
    expect(screen.getByText("模型服务返回 400")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("清除当前错误"));
    expect(onClearError).toHaveBeenCalledWith("err-model");
  });
});
