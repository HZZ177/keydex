import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

describe("A2UI debug info", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("keeps the debug button hidden by default", () => {
    render(<A2UIBlock message={debugMessage()} />);

    expect(screen.queryByRole("button", { name: "查看 A2UI 调试信息" })).toBeNull();
  });

  it("shows the debug button when enabled and opens a read-only detail panel", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <A2UIBlock
        message={debugMessage()}
        debugInfoEnabled
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    const debugButton = screen.getByRole("button", { name: "查看 A2UI 调试信息" });
    expect(debugButton.textContent).toBe("!");
    fireEvent.click(debugButton);

    expect(screen.getByTestId("a2ui-debug-modal")).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "A2UI 调试信息" })).toBe(screen.getByTestId("a2ui-debug-panel"));
    const panel = within(screen.getByTestId("a2ui-debug-panel"));
    expect(panel.getByText("message_id")).not.toBeNull();
    expect(panel.getByText("agent:a2ui-debug-1")).not.toBeNull();
    expect(panel.getByText("render_key")).not.toBeNull();
    expect(panel.getByText("choice")).not.toBeNull();
    expect(panel.getByText("interaction_id")).not.toBeNull();
    expect(panel.getByText("int-debug-1")).not.toBeNull();
    expect(panel.getByText("resume.status")).not.toBeNull();
    expect(panel.getByText("failed")).not.toBeNull();
    expect(panel.getByText("json_parse_status")).not.toBeNull();
    expect(panel.getAllByText("valid").length).toBeGreaterThan(0);
    expect(panel.getByText("Stream Buffer")).not.toBeNull();
    expect(panel.getByTestId("a2ui-debug-stream-buffer").textContent).toContain("选择发布方式");
    expect(panel.getByTestId("a2ui-debug-latest-chunk").textContent).toContain("立即发布");
    expect(panel.getByTestId("a2ui-debug-raw-event-1-chunk").textContent).toContain('"title":"选择发布方式"');
    expect(panel.getByTestId("a2ui-debug-raw-event-2-chunk").textContent).toContain('"label":"立即发布"');
    expect(panel.getByTestId("a2ui-debug-raw-events").textContent).toContain("a2ui_submit_ack");

    expect(panel.queryByRole("button", { name: "提交选择" })).toBeNull();
    expect(panel.queryByRole("button", { name: "取消" })).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes the modal debug panel from backdrop and Escape", () => {
    render(<A2UIBlock message={debugMessage()} debugInfoEnabled />);

    fireEvent.click(screen.getByRole("button", { name: "查看 A2UI 调试信息" }));
    expect(screen.getByRole("dialog", { name: "A2UI 调试信息" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "点击遮罩关闭 A2UI 调试信息" }));
    expect(screen.queryByRole("dialog", { name: "A2UI 调试信息" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 A2UI 调试信息" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "A2UI 调试信息" })).toBeNull();
  });

  it("hides the debug button when the centralized flag is disabled at the entry", () => {
    render(<A2UIBlock message={debugMessage()} debugInfoEnabled={false} />);

    expect(screen.queryByRole("button", { name: "查看 A2UI 调试信息" })).toBeNull();
  });

  it("copies the complete debug JSON", async () => {
    render(<A2UIBlock message={debugMessage()} debugInfoEnabled />);

    fireEvent.click(screen.getByRole("button", { name: "查看 A2UI 调试信息" }));
    fireEvent.click(screen.getByRole("button", { name: "复制调试 JSON" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    const copied = JSON.parse(writeText.mock.calls[0][0]);
    expect(copied.ids).toMatchObject({
      message_id: "agent:a2ui-debug-1",
      render_key: "choice",
      interaction_id: "int-debug-1",
    });
    expect(copied.lifecycle).toMatchObject({
      interaction_status: "submitted",
      resume_status: "failed",
      pending_count: 0,
    });
    expect(copied.stream_buffer).toMatchObject({
      chunkCount: 2,
      jsonParseStatus: "valid",
    });
    expect(copied.raw_event_timeline[1]).toMatchObject({
      action: "a2ui_stream_chunk",
      chunkText: '{"title":"选择发布方式"',
    });
    expect(copied.raw_events.some((event: { action: string }) => event.action === "a2ui_submit_ack")).toBe(true);
    expect(screen.getByRole("button", { name: "复制调试 JSON" }).getAttribute("data-copy-state")).toBe("copied");
  });

  it("opens independent debug panels for multiple cards", () => {
    render(
      <>
        <A2UIBlock
          message={debugMessage({ messageId: "agent:a2ui-debug-1", interactionId: "int-debug-1", rawAction: "a2ui_submit_ack" })}
          debugInfoEnabled
        />
        <A2UIBlock
          message={debugMessage({ messageId: "agent:a2ui-debug-2", interactionId: "int-debug-2", rawAction: "a2ui_cancel_ack" })}
          debugInfoEnabled
        />
      </>,
    );

    const buttons = screen.getAllByRole("button", { name: "查看 A2UI 调试信息" });
    fireEvent.click(buttons[1]);

    const panel = within(screen.getByTestId("a2ui-debug-panel"));
    expect(panel.getByText("agent:a2ui-debug-2")).not.toBeNull();
    expect(panel.getByText("int-debug-2")).not.toBeNull();
    expect(panel.getByTestId("a2ui-debug-raw-events").textContent).toContain("a2ui_cancel_ack");
  });
});

function debugMessage(options: {
  messageId?: string;
  interactionId?: string;
  rawAction?: string;
} = {}): ConversationMessage {
  const interaction = debugInteraction(options.interactionId ?? "int-debug-1");
  const a2ui = debugA2UI(interaction);
  const debug = debugState(a2ui, interaction, options.rawAction ?? "a2ui_submit_ack");
  const messageId = options.messageId ?? "agent:a2ui-debug-1";
  return {
    id: messageId,
    threadId: "ses-1",
    turnId: null,
    itemId: messageId.replace("agent:", ""),
    kind: "a2ui",
    status: "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: debug,
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: a2ui.render_key,
      streamId: a2ui.stream_id,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function debugInteraction(interactionId: string): A2UIInteractionState {
  return {
    interaction_id: interactionId,
    status: "submitted",
    can_submit: false,
    submit_request_id: "req-submit-debug",
    submit_result: { selected_values: ["now"], note: "已选择" },
    resume_status: "failed",
    resume_group_id: "resume-group-debug",
    pending_count: 0,
    resume_error: "resume failed",
  };
}

function debugA2UI(interaction: A2UIInteractionState): A2UIObject {
  return {
    render_key: "choice",
    mode: "interactive",
    stream_id: `stream-${interaction.interaction_id}`,
    tool_call_id: "tool-debug",
    trace_id: "trace-debug",
    turn_index: 3,
    payload: {
      title: "选择发布方式",
      description: "选择后继续",
      options: [{ label: "立即发布", value: "now" }],
    },
    input_schema: { type: "object" },
    submit_schema: { type: "object", properties: { selected_values: { type: "array" } } },
    interaction,
  };
}

function debugState(a2ui: A2UIObject, interaction: A2UIInteractionState, rawAction: string): A2UIDebugBlockState {
  return {
    id: a2ui.stream_id,
    status: "submitted",
    renderKey: a2ui.render_key,
    mode: a2ui.mode,
    streamId: a2ui.stream_id,
    interactionId: interaction.interaction_id,
    toolCallId: a2ui.tool_call_id,
    traceId: a2ui.trace_id,
    turnIndex: a2ui.turn_index,
    chunkCount: 2,
    argsBuffer: '{"title":"选择发布方式","options":[{"label":"立即发布","value":"now"}]}',
    argsTextLength: 69,
    latestChunk: '"label":"立即发布","value":"now"}]}',
    jsonParseStatus: "valid",
    parsedArgs: a2ui.payload,
    finishReason: "tool_call_done",
    a2ui,
    payload: a2ui.payload,
    inputSchema: a2ui.input_schema,
    submitSchema: a2ui.submit_schema,
    interaction,
    rawEvents: [
      {
        id: "raw-1",
        action: "a2ui_stream_start",
        timestamp: 1_700_000_000_000,
        data: {
          render_key: a2ui.render_key,
          stream_id: a2ui.stream_id,
          tool_call_id: a2ui.tool_call_id,
          stream: {
            status: "start",
            chunk_index: 0,
            args_text_length: 0,
          },
        },
      },
      {
        id: "raw-2",
        action: "a2ui_stream_chunk",
        timestamp: 1_700_000_000_010,
        data: {
          render_key: a2ui.render_key,
          stream_id: a2ui.stream_id,
          tool_call_id: a2ui.tool_call_id,
          stream: {
            status: "chunk",
            chunk_index: 1,
            args_delta: '{"title":"选择发布方式"',
            args_text_length: 16,
          },
        },
      },
      {
        id: "raw-3",
        action: "a2ui_stream_chunk",
        timestamp: 1_700_000_000_020,
        data: {
          render_key: a2ui.render_key,
          stream_id: a2ui.stream_id,
          tool_call_id: a2ui.tool_call_id,
          stream: {
            status: "chunk",
            chunk_index: 2,
            args_delta: ',"options":[{"label":"立即发布","value":"now"}]}',
            args_text_length: 69,
          },
        },
      },
      {
        id: "raw-4",
        action: "a2ui_stream_finish",
        timestamp: 1_700_000_000_030,
        data: {
          render_key: a2ui.render_key,
          stream_id: a2ui.stream_id,
          tool_call_id: a2ui.tool_call_id,
          stream: {
            status: "finish",
            args_text_length: 69,
            finish_reason: "tool_call_done",
          },
        },
      },
      {
        id: "raw-5",
        action: rawAction,
        timestamp: 1_700_000_000_040,
        data: {
          interaction_id: interaction.interaction_id,
          resume_status: interaction.resume_status,
        },
      },
    ],
    updatedAt: 1_700_000_000_001,
  };
}
