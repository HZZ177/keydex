import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

describe("A2ChoiceBlock", () => {
  it("submits a single selected value", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={choiceMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const submitButton = screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/方案 B/));
    fireEvent.change(screen.getByLabelText("不对！输入信息告诉 Keydex 应该怎么做"), { target: { value: "优先收益" } });
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: ["b"],
        note: "优先收益",
      }, "ses-1");
    });
  });

  it("validates minimum selection for multiple choice", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: { multiple: true, min_selected: 2, max_selected: 2 },
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText(/方案 A/));

    expect(screen.getByText("请至少选择 2 个选项")).not.toBeNull();
    expect((screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/方案 B/));
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: ["a", "b"],
      }, "ses-1");
    });
  });

  it("renders recommended, default and disabled options as decision metadata", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            default_values: ["b"],
            options: [
              { label: "方案 A", value: "a", description: "依赖较多", disabled: true, badge: "暂不可用" },
              { label: "方案 B", value: "b", description: "收益最高", recommended: true },
            ],
          },
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("推荐")).not.toBeNull();
    expect(screen.getByText("暂不可用")).not.toBeNull();
    expect(screen.getByText("已选 1 项 / 单选")).not.toBeNull();
    expect((screen.getByLabelText(/方案 A/) as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: ["b"],
      }, "ses-1");
    });
  });

  it("uses the interactive motion layer for choice scenes and option selection", () => {
    render(<A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-interactive-motion")).toBe("true");
    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("active");

    const option = screen.getByLabelText(/方案 A/).closest("label");
    expect(option?.getAttribute("data-a2ui-interactive-item")).toBe("true");
    expect(option?.getAttribute("data-a2ui-motion-variant")).toBe("option");
    expect(option?.getAttribute("tabindex")).toBeNull();
    expect(option?.querySelector("[data-a2ui-choice-morph]")).not.toBeNull();

    fireEvent.click(screen.getByLabelText(/方案 A/));

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("dirty");
    expect(option?.getAttribute("data-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "提交选择" }).getAttribute("data-a2ui-action-motion")).toBe("true");

    fireEvent.click(screen.getByLabelText(/方案 A/));

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("active");
    expect(option?.getAttribute("data-selected")).toBe("false");
    expect((screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("animates the action badge through loading and done states", async () => {
    vi.useFakeTimers();
    try {
      let resolveSubmit!: () => void;
      const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      }));
      render(<A2UIBlock message={choiceMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

      fireEvent.click(screen.getByLabelText(/方案 A/));
      fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

      expect(screen.getByRole("button", { name: "提交中" }).getAttribute("data-badge-state")).toBe("loading");

      await act(async () => {
        resolveSubmit();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已提交" }).getAttribute("data-badge-state")).toBe("done");

      await act(async () => {
        vi.advanceTimersByTime(420);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends cancel with a note reason", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText("不对！输入信息告诉 Keydex 应该怎么做"), { target: { value: "暂不选择" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("int-choice-1", "暂不选择", "ses-1");
    });
  });

  it("renders submitted choices as read-only labels", () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          interaction: {
            interaction_id: "int-choice-1",
            status: "submitted",
            can_submit: false,
            submit_result: { selected_values: ["a", "c"], note: "组合推进" },
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    expect(result.getByText("方案 A")).not.toBeNull();
    expect(result.getByText("方案 C")).not.toBeNull();
    expect(result.getByText("本次选择已提交 · 2 项")).not.toBeNull();
    expect(result.getByText("给 Keydex 的补充信息")).not.toBeNull();
    expect(result.getByText("组合推进")).not.toBeNull();
    expect(result.queryByText("已提交选择")).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "提交选择" })).toBeNull();
  });

  it("renders cancelled choices with an explicit interaction outcome", () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          interaction: {
            interaction_id: "int-choice-1",
            status: "cancelled",
            can_submit: false,
            cancel_reason: "用户取消",
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    expect(screen.getByTestId("a2ui-choice-result").getAttribute("data-result-status")).toBe("cancelled");
    expect(result.getByText("方案 A")).not.toBeNull();
    expect(result.getByText("方案 B")).not.toBeNull();
    expect(result.getByText("已取消本次选择")).not.toBeNull();
    expect(result.queryByText(/原因/)).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交选择" })).toBeNull();
  });

  it("streams choice options while keeping waiting controls available", () => {
    vi.useFakeTimers();
    try {
      render(<A2UIBlock message={withStreamedDebug(choiceMessage())} onSubmit={vi.fn()} onCancel={vi.fn()} />);

      const choice = screen.getByTestId("a2ui-choice");
      expect(choice.getAttribute("data-a2ui-reveal-enabled")).toBe("true");
      expect(screen.getByLabelText(/方案 A/)).not.toBeNull();
      expect(screen.queryByLabelText(/方案 B/)).toBeNull();
      const submitButton = screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement;
      expect(submitButton.disabled).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1_600);
      });

      expect(screen.getByLabelText(/方案 B/)).not.toBeNull();
      expect(screen.getByRole("button", { name: "提交选择" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function choiceMessage(options: {
  payload?: Record<string, unknown>;
  interaction?: A2UIInteractionState;
} = {}): ConversationMessage {
  const interaction = options.interaction ?? {
    interaction_id: "int-choice-1",
    status: "waiting_user_input",
    can_submit: true,
  };
  const a2ui = choiceObject(options.payload ?? {}, interaction);
  return {
    id: "agent:a2ui-choice-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-choice-1",
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: choiceDebug(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: "choice",
      streamId: "stream-choice-1",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function choiceObject(payload: Record<string, unknown>, interaction: A2UIInteractionState): A2UIObject {
  return {
    render_key: "choice",
    mode: "interactive",
    stream_id: "stream-choice-1",
    tool_call_id: "tool-choice-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "请选择方案",
      description: "选择一个后继续",
      options: [
        { label: "方案 A", value: "a", description: "低风险" },
        { label: "方案 B", value: "b", description: "高收益" },
        { label: "方案 C", value: "c", description: "折中" },
      ],
      ...payload,
    },
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function choiceDebug(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  return {
    id: "stream-choice-1",
    status: interaction.status === "waiting_user_input" ? "waiting_input" : interaction.status === "submitted" ? "submitted" : "cancelled",
    renderKey: "choice",
    mode: "interactive",
    streamId: "stream-choice-1",
    interactionId: interaction.interaction_id,
    toolCallId: "tool-choice-1",
    traceId: "trace-1",
    turnIndex: 1,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "valid",
    a2ui,
    payload: a2ui.payload,
    inputSchema: a2ui.input_schema,
    submitSchema: a2ui.submit_schema,
    interaction,
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
  };
}

function withStreamedDebug(message: ConversationMessage): ConversationMessage {
  const a2ui = message.payload.a2ui as A2UIObject;
  const debug = message.payload.a2uiDebug as A2UIDebugBlockState;
  const argsBuffer = JSON.stringify(a2ui.payload);
  return {
    ...message,
    payload: {
      ...message.payload,
      a2uiDebug: {
        ...debug,
        chunkCount: 32,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs: a2ui.payload,
      },
    },
  };
}
