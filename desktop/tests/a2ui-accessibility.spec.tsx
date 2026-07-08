import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject, A2UIRenderKey } from "@/types/protocol";

describe("A2UI accessibility and status states", () => {
  it("exposes interactive commands through role/name without icon noise", () => {
    render(
      <A2UIBlock
        message={a2uiMessage("confirm", {
          title: "确认预算调整",
          description: "将华东区预算增加 10%",
          confirm_label: "执行调整",
          cancel_label: "暂不调整",
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("aria-label")).toContain("确认 A2UI：确认预算调整");
    expect(screen.getByRole("button", { name: "执行调整" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "暂不调整" })).not.toBeNull();
    expect(screen.getByLabelText("备注")).not.toBeNull();
  });

  it("keeps waiting, submitted, cancelled and resume-running labels distinct", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <A2UIBlock message={a2uiMessage("confirm", { title: "确认发布" })} onSubmit={onSubmit} onCancel={onCancel} />,
    );

    expect(screen.getByTestId("a2ui-status").textContent).toBe("等待输入");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("true");

    rerender(
      <A2UIBlock
        message={a2uiMessage("confirm", { title: "确认发布" }, submittedInteraction({ resume_status: "started" }))}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId("a2ui-status").textContent).toBe("继续执行中");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("false");
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();

    rerender(
      <A2UIBlock
        message={a2uiMessage("confirm", { title: "确认发布" }, cancelledInteraction())}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId("a2ui-status").textContent).toBe("已取消");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("false");

    rerender(
      <A2UIBlock
        message={a2uiMessage("confirm", { title: "确认发布" }, submittedInteraction({ resume_status: "failed" }))}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId("a2ui-status").textContent).toBe("失败");
  });

  it("does not submit when the interaction is waiting but no longer submittable", () => {
    const onSubmit = vi.fn();
    render(
      <A2UIBlock
        message={a2uiMessage("choice", {
          title: "请选择方案",
          options: [{ label: "方案 A", value: "a" }],
        }, {
          interaction_id: "int-1",
          status: "waiting_user_input",
          can_submit: false,
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const submitButton = screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/方案 A/));
    fireEvent.click(submitButton);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("false");
  });
});

function a2uiMessage(
  renderKey: A2UIRenderKey,
  payload: Record<string, unknown>,
  interaction: A2UIInteractionState = waitingInteraction(),
): ConversationMessage {
  const a2ui = a2uiObject(renderKey, payload, interaction);
  return {
    id: `agent:a2ui-${renderKey}-a11y`,
    threadId: "ses-1",
    turnId: null,
    itemId: `a2ui-${renderKey}-a11y`,
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: a2uiDebug(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey,
      streamId: `stream-${renderKey}-a11y`,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function a2uiObject(renderKey: A2UIRenderKey, payload: Record<string, unknown>, interaction: A2UIInteractionState): A2UIObject {
  return {
    render_key: renderKey,
    mode: renderKey === "chart" ? "render" : "interactive",
    stream_id: `stream-${renderKey}-a11y`,
    tool_call_id: `tool-${renderKey}-a11y`,
    trace_id: "trace-a11y",
    turn_index: 1,
    payload,
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function a2uiDebug(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  return {
    id: a2ui.stream_id,
    status: interaction.status === "waiting_user_input" ? "waiting_input" : interaction.status === "submitted" ? "submitted" : "cancelled",
    renderKey: a2ui.render_key,
    mode: a2ui.mode,
    streamId: a2ui.stream_id,
    interactionId: interaction.interaction_id,
    toolCallId: a2ui.tool_call_id,
    traceId: a2ui.trace_id,
    turnIndex: a2ui.turn_index,
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

function waitingInteraction(): A2UIInteractionState {
  return {
    interaction_id: "int-1",
    status: "waiting_user_input",
    can_submit: true,
    resume_status: "not_started",
  };
}

function submittedInteraction(patch: Partial<A2UIInteractionState> = {}): A2UIInteractionState {
  return {
    interaction_id: "int-1",
    status: "submitted",
    can_submit: false,
    submit_result: { confirmed: true },
    resume_status: "succeeded",
    ...patch,
  };
}

function cancelledInteraction(): A2UIInteractionState {
  return {
    interaction_id: "int-1",
    status: "cancelled",
    can_submit: false,
    cancel_reason: "用户取消",
    resume_status: "succeeded",
  };
}
