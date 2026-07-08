import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

describe("A2ConfirmBlock", () => {
  it("submits a confirmed result with optional note after danger acknowledgement", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={confirmMessage({
          payload: {
            title: "确认预算调整",
            description: "将华东区预算增加 10%",
            confirm_label: "执行调整",
            cancel_label: "暂不调整",
            danger: true,
          },
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const submitButton = screen.getByRole("button", { name: "执行调整" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("我已了解风险"));
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "已和负责人确认" } });
    fireEvent.click(screen.getByRole("button", { name: "执行调整" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-1", {
        confirmed: true,
        note: "已和负责人确认",
      }, "ses-1");
    });
  });

  it("sends cancel with a reason from the note field", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={confirmMessage()} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "需要先补充审批" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("int-1", "需要先补充审批", "ses-1");
    });
  });

  it("renders submitted confirm state as read-only", () => {
    render(
      <A2UIBlock
        message={confirmMessage({
          interaction: {
            interaction_id: "int-1",
            status: "submitted",
            can_submit: false,
            submit_result: { confirmed: true, note: "已完成确认" },
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("a2ui-confirm-result")).not.toBeNull();
    expect(screen.getByText("已提交确认")).not.toBeNull();
    expect(screen.getByText("备注：已完成确认")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("renders cancelled confirm state as read-only", () => {
    render(
      <A2UIBlock
        message={confirmMessage({
          interaction: {
            interaction_id: "int-1",
            status: "cancelled",
            can_submit: false,
            cancel_reason: "用户取消",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-confirm-result"));
    expect(result.getByText("已取消")).not.toBeNull();
    expect(result.getByText("原因：用户取消")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("streams confirm payload data while keeping waiting controls available", () => {
    vi.useFakeTimers();
    try {
      render(
        <A2UIBlock
          message={withStreamedDebug(confirmMessage({
            payload: {
              title: "确认高风险操作",
              description: "操作会影响当前项目配置",
              danger: true,
              risk_tags: ["高风险", "不可逆"],
            },
          }))}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      const confirm = screen.getByTestId("a2ui-confirm");
      expect(confirm.getAttribute("data-a2ui-reveal-enabled")).toBe("true");
      expect(screen.getByText("操作会影响当前项目配置")).not.toBeNull();
      expect(screen.getByTestId("a2ui-confirm-danger")).not.toBeNull();
      expect(screen.getByText("高风险")).not.toBeNull();
      expect(screen.queryByText("不可逆")).toBeNull();
      expect(screen.getByRole("button", { name: "确认" })).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1_900);
      });

      expect(screen.getByTestId("a2ui-confirm-danger")).not.toBeNull();
      expect(screen.getByText("高风险")).not.toBeNull();
      expect(screen.getByText("不可逆")).not.toBeNull();
      expect(screen.getByRole("button", { name: "确认" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function confirmMessage(options: {
  payload?: Record<string, unknown>;
  interaction?: A2UIInteractionState;
} = {}): ConversationMessage {
  const interaction = options.interaction ?? {
    interaction_id: "int-1",
    status: "waiting_user_input",
    can_submit: true,
  };
  const a2ui = confirmObject(options.payload ?? {}, interaction);
  return {
    id: "agent:a2ui-confirm-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-confirm-1",
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: confirmDebug(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: "confirm",
      streamId: "stream-1",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function confirmObject(payload: Record<string, unknown>, interaction: A2UIInteractionState): A2UIObject {
  return {
    render_key: "confirm",
    mode: "interactive",
    stream_id: "stream-1",
    tool_call_id: "tool-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "确认发布",
      description: "发布后用户可见",
      ...payload,
    },
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function confirmDebug(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  return {
    id: "stream-1",
    status: interaction.status === "waiting_user_input" ? "waiting_input" : interaction.status === "submitted" ? "submitted" : "cancelled",
    renderKey: "confirm",
    mode: "interactive",
    streamId: "stream-1",
    interactionId: interaction.interaction_id,
    toolCallId: "tool-1",
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
        chunkCount: 24,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs: a2ui.payload,
      },
    },
  };
}
