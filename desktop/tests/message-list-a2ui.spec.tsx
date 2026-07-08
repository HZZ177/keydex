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

    expect(onSubmit("int-1", { confirmed: true }, "ses-1")).toEqual({
      action: "a2ui_submit",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-submit",
      submit_result: { confirmed: true },
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

    expect(screen.getByTestId("a2ui-block").getAttribute("data-render-key")).toBe("confirm");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("true");
    expect(screen.getByRole("button", { name: "查看 A2UI 调试信息" })).not.toBeNull();
    expect(screen.getByText("确认发布")).toBeTruthy();
    expect(screen.getByText("等待输入")).toBeTruthy();
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
              submit_result: { confirmed: true },
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
    expect(blocks.map((block) => block.getAttribute("data-render-key"))).toEqual(["confirm", "confirm"]);
    expect(blocks.map((block) => block.getAttribute("data-status"))).toEqual(["submitted", "waiting_input"]);
    expect(screen.getByText("已提交确认")).toBeTruthy();
    expect(screen.getByText("等待输入")).toBeTruthy();
  });

  it("anchors concurrent streaming A2UI auto-scroll to the first active component", async () => {
    const scrollRecorder = installA2UIScrollIntoViewRecorder();
    try {
      const { rerender } = render(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-3", "streaming"),
          ]}
          isProcessing
        />,
      );

      await waitFor(() => expect(scrollRecorder.messageIds).toContain("agent:a2ui-1"));
      expect(scrollRecorder.messageIds).toEqual(["agent:a2ui-1"]);

      rerender(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "created"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-3", "streaming"),
          ]}
          isProcessing
        />,
      );

      await waitFor(() => expect(scrollRecorder.messageIds).toContain("agent:a2ui-2"));
      expect(scrollRecorder.messageIds).toEqual(["agent:a2ui-1", "agent:a2ui-2"]);
    } finally {
      scrollRecorder.restore();
    }
  });

  it("skips completed A2UI components when advancing the streaming auto-scroll anchor", async () => {
    const scrollRecorder = installA2UIScrollIntoViewRecorder();
    try {
      const { rerender } = render(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "streaming"),
            conversationStreamingA2UIMessage("agent:a2ui-3", "streaming"),
          ]}
          isProcessing
        />,
      );

      await waitFor(() => expect(scrollRecorder.messageIds).toContain("agent:a2ui-1"));
      rerender(
        <MessageList
          messages={[
            conversationStreamingA2UIMessage("agent:a2ui-1", "created"),
            conversationStreamingA2UIMessage("agent:a2ui-2", "created"),
            conversationStreamingA2UIMessage("agent:a2ui-3", "streaming"),
          ]}
          isProcessing
        />,
      );

      await waitFor(() => expect(scrollRecorder.messageIds).toContain("agent:a2ui-3"));
      expect(scrollRecorder.messageIds).toEqual(["agent:a2ui-1", "agent:a2ui-3"]);
    } finally {
      scrollRecorder.restore();
    }
  });

  it("does not pull the viewport back to the A2UI stream anchor after manual scrolling", async () => {
    const scrollRecorder = installA2UIScrollIntoViewRecorder();
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

      await waitFor(() => expect(scrollRecorder.messageIds).toContain("agent:a2ui-1"));
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
      a2ui: { render_key: "confirm", stream_id: "stream-1" },
      renderKey: "confirm",
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
    render_key: "confirm",
    mode: "interactive",
    stream_id: streamId,
    tool_call_id: "tool-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "确认发布",
      description: "发布后用户可见",
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
    renderKey: "confirm",
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

function installA2UIScrollIntoViewRecorder() {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  const messageIds: string[] = [];
  const scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
    messageIds.push((this as HTMLElement).dataset.a2uiMessageId ?? "");
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return {
    messageIds,
    scrollIntoView,
    clear: () => {
      messageIds.length = 0;
      scrollIntoView.mockClear();
    },
    restore: () => {
      if (descriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", descriptor);
        return;
      }
      delete (Element.prototype as { scrollIntoView?: Element["scrollIntoView"] }).scrollIntoView;
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
