import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { agentMessageToConversationMessage } from "@/renderer/pages/conversation/conversationMessageAdapter";
import { MessageList } from "@/renderer/pages/conversation/messages";
import {
  buildA2UICancelPayload,
  buildA2UISubmitPayload,
} from "@/renderer/pages/conversation/messages/a2ui";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject, AgentChatMessage } from "@/types/protocol";

describe("MessageList A2UI callback contract", () => {
  it("keeps submit and cancel callbacks action-shaped for runtime sending", () => {
    const onSubmit = vi.fn((interactionId: string, submitResult: Record<string, unknown>, sessionId: string) =>
      buildA2UISubmitPayload(sessionId, interactionId, submitResult, "req-submit"),
    );
    const onCancel = vi.fn((interactionId: string, cancelReason: string, sessionId: string) =>
      buildA2UICancelPayload(sessionId, interactionId, cancelReason, "req-cancel"),
    );

    expect(onSubmit("int-1", { selected_values: ["now"] }, "ses-1")).toEqual({
      action: "a2ui_submit",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-submit",
      submit_result: { selected_values: ["now"] },
    });
    expect(onCancel("int-1", "user_cancelled", "ses-1")).toEqual({
      action: "a2ui_cancel",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-cancel",
      cancel_reason: "user_cancelled",
    });
  });

  it("renders A2UI messages through the dedicated MessageList branch", () => {
    render(
      <MessageList
        messages={[conversationA2UIMessage()]}
        onA2UISubmit={vi.fn()}
        onA2UICancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("data-render-key")).toBe("choice");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("true");
    expect(screen.queryByRole("button", { name: "查看 A2UI 调试信息" })).toBeNull();
    expect(screen.getAllByText("选择发布方式").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("等待输入")).toBeTruthy();
  });

  it("shows the A2UI debug entry only when enabled by settings", () => {
    render(
      <MessageList
        messages={[conversationA2UIMessage()]}
        a2uiDebugInfoEnabled
        onA2UISubmit={vi.fn()}
        onA2UICancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "查看 A2UI 调试信息" })).not.toBeNull();
  });

  it("renders same render-key A2UI cards with independent statuses", () => {
    render(
      <MessageList
        messages={[
          conversationA2UIMessageWith({
            streamId: "stream-submitted",
            interaction: {
              interaction_id: "int-submitted",
              status: "submitted",
              can_submit: false,
              submit_result: { selected_values: ["now"] },
              resume_status: "succeeded",
            },
          }),
          conversationA2UIMessageWith({
            streamId: "stream-waiting",
            interaction: {
              interaction_id: "int-waiting",
              status: "waiting_user_input",
              can_submit: true,
              resume_status: "not_started",
            },
          }),
        ]}
        onA2UISubmit={vi.fn()}
        onA2UICancel={vi.fn()}
      />,
    );

    const blocks = screen.getAllByTestId("a2ui-block");
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.getAttribute("data-render-key"))).toEqual(["choice", "choice"]);
    expect(blocks.map((block) => block.getAttribute("data-status"))).toEqual(["submitted", "waiting_input"]);
    expect(screen.queryByText("已提交选择")).toBeNull();
    expect(screen.getAllByText("立即发布").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("等待输入")).toBeTruthy();
  });

  it("uses the normal message-list bottom follow instead of A2UI stream anchors", async () => {
    const scrollRecorder = installScrollIntoViewRecorder();
    try {
      render(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "streaming"),
          ]}
          isProcessing
        />,
      );

      await nextAnimationFrame();
      expect(screen.getAllByTestId("a2ui-block")).toHaveLength(2);
      expect(screen.getByTestId("message-list-scroll").getAttribute("data-a2ui-stream-anchor-message-id")).toBeNull();
      expect(scrollRecorder.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scrollRecorder.restore();
    }
  });

  it("does not pull the viewport back after manual scrolling while A2UI streams", async () => {
    const scrollRecorder = installScrollIntoViewRecorder();
    try {
      const { rerender } = render(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "streaming"),
          ]}
          isProcessing
        />,
      );

      const scroller = screen.getByTestId("message-list-scroll");
      defineScrollMetric(scroller, "clientHeight", 400);
      defineScrollMetric(scroller, "scrollHeight", 2000);
      scroller.scrollTop = 520;
      fireEvent.wheel(scroller, { deltaY: -160 });
      fireEvent.scroll(scroller);
      await waitFor(() => expect(screen.getByRole("button", { name: "滚动到底" })).toBeTruthy());

      scrollRecorder.clear();
      rerender(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "created"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "streaming"),
          ]}
          isProcessing
        />,
      );

      await nextAnimationFrame();
      expect(scrollRecorder.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scrollRecorder.restore();
    }
  });

  it("adapts agent A2UI transcript messages without falling back to status", () => {
    const converted = agentMessageToConversationMessage(
      {
        id: "a2ui-1",
        sessionId: "ses-1",
        role: "a2ui",
        content: "",
        contentType: "a2ui",
        timestamp: 1_700_000_000_000,
        a2ui: a2uiObject(),
        a2uiDebug: a2uiDebug(),
      } as AgentChatMessage,
      0,
    );

    expect(converted.kind).toBe("a2ui");
    expect(converted.status).toBe("pending");
    expect(converted.payload).toMatchObject({
      a2ui: { render_key: "choice", stream_id: "stream-1" },
      renderKey: "choice",
      interactionId: "int-1",
    });
  });
});

function conversationA2UIMessage(): ConversationMessage {
  const a2ui = a2uiObject();
  return {
    id: "agent:a2ui-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-1",
    kind: "a2ui",
    status: "pending",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: a2uiDebug(),
      interaction: a2ui.interaction,
      interactionId: a2ui.interaction?.interaction_id,
      renderKey: a2ui.render_key,
      streamId: a2ui.stream_id,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function conversationA2UIMessageWith({
  streamId,
  interaction,
}: {
  streamId: string;
  interaction: A2UIInteractionState;
}): ConversationMessage {
  const a2ui = a2uiObjectWith(streamId, interaction);
  return {
    id: `agent:${streamId}`,
    threadId: "ses-1",
    turnId: null,
    itemId: streamId,
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: a2uiDebugWith(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: a2ui.render_key,
      streamId: a2ui.stream_id,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function conversationStreamingA2UIMessage(
  id: string,
  status: "started" | "streaming" | "finished" | "created",
): ConversationMessage {
  const streamId = id.replace(/^agent:/, "");
  return {
    id,
    threadId: "ses-1",
    turnId: null,
    itemId: streamId,
    kind: "a2ui",
    status: status === "created" ? "completed" : "running",
    content: "",
    payload: {
      a2uiDebug: a2uiChartDebug(streamId, status),
      renderKey: "chart",
      streamId,
      turnIndex: 1,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function a2uiChartDebug(
  streamId: string,
  status: "started" | "streaming" | "finished" | "created",
): A2UIDebugBlockState {
  const payload = {
    title: `图表 ${streamId}`,
    charts: [
      {
        type: "column",
        title: "活跃用户",
        series: [
          {
            name: "活跃用户",
            items: [
              { name: "一月", value: 12 },
              { name: "二月", value: 18 },
            ],
          },
        ],
      },
    ],
  };
  return {
    id: streamId,
    status,
    renderKey: "chart",
    mode: "render",
    streamId,
    interactionId: "",
    toolCallId: "tool-chart",
    traceId: "trace-1",
    turnIndex: 1,
    chunkCount: status === "created" ? 8 : 4,
    argsBuffer: JSON.stringify(payload),
    argsTextLength: JSON.stringify(payload).length,
    jsonParseStatus: "valid",
    parsedArgs: payload,
    payload: status === "created" ? payload : {},
    inputSchema: {},
    submitSchema: {},
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
  };
}

function a2uiObject(): A2UIObject {
  return a2uiObjectWith("stream-1", {
    interaction_id: "int-1",
    status: "waiting_user_input",
    can_submit: true,
  });
}

function a2uiObjectWith(streamId: string, interaction: A2UIInteractionState): A2UIObject {
  return {
    render_key: "choice",
    mode: "interactive",
    stream_id: streamId,
    tool_call_id: "tool-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "选择发布方式",
      description: "选择后继续",
      options: [{ label: "立即发布", value: "now" }],
    },
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function a2uiDebug(): A2UIDebugBlockState {
  const a2ui = a2uiObject();
  return a2uiDebugWith(a2ui, a2ui.interaction as A2UIInteractionState);
}

function a2uiDebugWith(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  return {
    id: a2ui.stream_id,
    status: interaction.status === "waiting_user_input" ? "waiting_input" : interaction.status === "submitted" ? "submitted" : "cancelled",
    renderKey: "choice",
    mode: "interactive",
    streamId: a2ui.stream_id,
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

function installScrollIntoViewRecorder() {
  const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return {
    scrollIntoView,
    clear: () => {
      scrollIntoView.mockClear();
    },
    restore: () => {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element["scrollIntoView"] }).scrollIntoView;
      }
    },
  };
}

function defineScrollMetric(element: HTMLElement, key: "clientHeight" | "scrollHeight", value: number): void {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
