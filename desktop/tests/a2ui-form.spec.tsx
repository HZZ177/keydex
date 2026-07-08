import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

describe("A2FormBlock", () => {
  it("validates required fields before submit", () => {
    const onSubmit = vi.fn();
    render(<A2UIBlock message={formMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "提交参数" }));

    expect(screen.getAllByText("请填写该字段")).toHaveLength(2);
    expect(screen.getByText("请勾选该字段")).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits normalized form values", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={formMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: "发布活动" } });
    fireEvent.change(screen.getByLabelText(/预算/), { target: { value: "1200" } });
    fireEvent.click(screen.getByLabelText(/渠道/));
    fireEvent.click(screen.getByRole("option", { name: "微信" }));
    fireEvent.click(screen.getByLabelText(/短信/));
    fireEvent.click(screen.getByLabelText(/邮件/));
    fireEvent.click(screen.getByLabelText(/确认执行/));
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "参数已确认" } });
    fireEvent.click(screen.getByRole("button", { name: "提交参数" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-form-1", {
        values: {
          title: "发布活动",
          budget: 1200,
          channel: "wechat",
          notify: ["sms", "email"],
          confirm: true,
        },
        note: "参数已确认",
      }, "ses-1");
    });
  });

  it("applies defaults, field help and numeric range validation", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={formMessage({
          payload: {
            fields: [
              {
                name: "budget",
                label: "预算",
                type: "number",
                required: true,
                default_value: "1200",
                min: 100,
                max: 1000,
                help: "填写本次执行预算",
              },
            ],
            submit_label: "确认参数",
          },
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("1 个字段，1 个必填")).not.toBeNull();
    expect(screen.getByText("填写本次执行预算")).not.toBeNull();
    expect((screen.getByLabelText(/预算/) as HTMLInputElement).value).toBe("1200");

    fireEvent.click(screen.getByRole("button", { name: "确认参数" }));

    expect(screen.getByText("不能大于 1000")).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/预算/), { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "确认参数" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-form-1", {
        values: { budget: 800 },
      }, "ses-1");
    });
  });

  it("sends cancel with a note reason", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={formMessage()} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "资料不足" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("int-form-1", "资料不足", "ses-1");
    });
  });

  it("renders submitted form values as a read-only summary", () => {
    render(
      <A2UIBlock
        message={formMessage({
          interaction: {
            interaction_id: "int-form-1",
            status: "submitted",
            can_submit: false,
            submit_result: {
              values: {
                title: "发布活动",
                budget: 1200,
                channel: "wechat",
                notify: ["sms"],
                confirm: true,
              },
              note: "已确认",
            },
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-form-result"));
    expect(result.getByText("发布活动")).not.toBeNull();
    expect(result.getByText("1200")).not.toBeNull();
    expect(result.getByText("微信")).not.toBeNull();
    expect(result.getByText("短信")).not.toBeNull();
    expect(result.getByText("是")).not.toBeNull();
    expect(result.getByText("备注")).not.toBeNull();
    expect(result.getByText("已确认")).not.toBeNull();
    expect(result.queryByText("已提交表单")).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "提交参数" })).toBeNull();
  });

  it("streams form fields while keeping waiting controls available", () => {
    vi.useFakeTimers();
    try {
      render(<A2UIBlock message={withStreamedDebug(formMessage())} onSubmit={vi.fn()} onCancel={vi.fn()} />);

      const form = screen.getByTestId("a2ui-form");
      expect(form.getAttribute("data-a2ui-reveal-enabled")).toBe("true");
      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.queryByLabelText(/预算/)).toBeNull();
      expect(screen.getByRole("button", { name: "提交参数" })).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1_900);
      });

      expect(screen.getByLabelText(/预算/)).not.toBeNull();
      expect(screen.getByRole("button", { name: "提交参数" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders streaming form debug payloads as form UI before the created object arrives", () => {
    const message = formMessage({
      payload: {
        fields: [
          { name: "title", label: "标题", type: "text", required: true },
          { name: "budget", label: "预算", type: "number" },
        ],
      },
    });

    render(<A2UIBlock message={withStreamingPlaceholderDebug(message)} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("a2ui-form")).not.toBeNull();
    expect(within(screen.getByTestId("a2ui-form")).getByText("请补充执行参数")).not.toBeNull();
    expect(screen.getByLabelText(/标题/)).not.toBeNull();
    expect(screen.queryByTestId("a2ui-payload-summary")).toBeNull();
    expect(screen.queryByTestId("a2ui-stream-preview")).toBeNull();
    expect((screen.getByRole("button", { name: "提交参数" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function formMessage(options: {
  interaction?: A2UIInteractionState;
  payload?: Record<string, unknown>;
} = {}): ConversationMessage {
  const interaction = options.interaction ?? {
    interaction_id: "int-form-1",
    status: "waiting_user_input",
    can_submit: true,
  };
  const a2ui = formObject(interaction, options.payload ?? {});
  return {
    id: "agent:a2ui-form-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-form-1",
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: formDebug(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: "form",
      streamId: "stream-form-1",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function formObject(interaction: A2UIInteractionState, payload: Record<string, unknown> = {}): A2UIObject {
  return {
    render_key: "form",
    mode: "interactive",
    stream_id: "stream-form-1",
    tool_call_id: "tool-form-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "请补充执行参数",
      description: "用于生成活动执行计划",
      submit_label: "提交参数",
      fields: [
        { name: "title", label: "标题", type: "text", required: true },
        { name: "budget", label: "预算", type: "number", required: true },
        {
          name: "channel",
          label: "渠道",
          type: "select",
          options: [
            { label: "微信", value: "wechat" },
            { label: "抖音", value: "douyin" },
          ],
        },
        {
          name: "notify",
          label: "通知方式",
          type: "multiselect",
          options: [
            { label: "短信", value: "sms" },
            { label: "邮件", value: "email" },
          ],
        },
        { name: "confirm", label: "确认执行", type: "boolean", required: true },
      ],
      ...payload,
    },
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function formDebug(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  return {
    id: "stream-form-1",
    status: interaction.status === "waiting_user_input" ? "waiting_input" : interaction.status === "submitted" ? "submitted" : "cancelled",
    renderKey: "form",
    mode: "interactive",
    streamId: "stream-form-1",
    interactionId: interaction.interaction_id,
    toolCallId: "tool-form-1",
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
        chunkCount: 48,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs: a2ui.payload,
      },
    },
  };
}

function withStreamingPlaceholderDebug(message: ConversationMessage): ConversationMessage {
  const a2ui = message.payload.a2ui as A2UIObject;
  const argsBuffer = JSON.stringify(a2ui.payload);
  return {
    ...message,
    payload: {
      ...message.payload,
      a2ui: null,
      interaction: undefined,
      interactionId: "",
      a2uiDebug: {
        id: "stream-form-placeholder",
        status: "streaming",
        renderKey: "form",
        mode: "interactive",
        streamId: "stream-form-placeholder",
        interactionId: "",
        toolCallId: "tool-form-placeholder",
        traceId: "trace-1",
        turnIndex: 1,
        chunkCount: 24,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs: a2ui.payload,
        payload: {},
        inputSchema: {},
        submitSchema: {},
        rawEvents: [],
        updatedAt: 1_700_000_000_010,
      } satisfies A2UIDebugBlockState,
    },
  };
}
