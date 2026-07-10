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

  it("renders the information assembly layout with collapsed correction entry", () => {
    render(<A2UIBlock message={formMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const form = within(screen.getByTestId("a2ui-form"));
    expect(form.getByRole("heading", { name: "请补充执行参数" })).not.toBeNull();
    expect(form.getByText("用于生成活动执行计划")).not.toBeNull();
    expect(screen.getByText("已完成 0/5 · 3 个必填")).not.toBeNull();
    expect(screen.getByText("已完成 0/5 · 必填 0/3")).not.toBeNull();
    expect(screen.getByRole("button", { name: "以上信息不对！我来告诉 Keydex 应该怎么做" })).not.toBeNull();
    expect(screen.queryByLabelText("我来告诉 Keydex 应该怎么做")).toBeNull();

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: "发布活动" } });

    expect(screen.getByText("已完成 1/5 · 3 个必填")).not.toBeNull();
    expect(screen.getByText("已完成 1/5 · 必填 1/3")).not.toBeNull();
  });

  it("owns exactly one semantic player instead of mounting the generic chart player", () => {
    render(<A2UIBlock message={formMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("a2ui-block").hasAttribute("data-a2ui-player-enabled")).toBe(false);
    expect(screen.getByTestId("a2ui-form").hasAttribute("data-a2ui-player-enabled")).toBe(true);
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
      }, "ses-1");
    });
  });

  it("submits correction note without requiring generated fields", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={formMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: "发布活动" } });
    expect((screen.getByLabelText(/标题/) as HTMLInputElement).value).toBe("发布活动");

    fireEvent.click(screen.getByRole("button", { name: "以上信息不对！我来告诉 Keydex 应该怎么做" }));

    expect((screen.getByLabelText(/标题/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/标题/) as HTMLInputElement).disabled).toBe(true);
    const submitButton = screen.getByRole("button", { name: "提交参数" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(screen.queryByText("请填写该字段")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "以上信息不对！我来告诉 Keydex 应该怎么做" }));

    expect((screen.getByLabelText(/标题/) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText(/标题/) as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "以上信息不对！我来告诉 Keydex 应该怎么做" }));

    fireEvent.change(screen.getByLabelText("我来告诉 Keydex 应该怎么做"), {
      target: { value: "字段不对，请先问我活动时间和负责人" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交参数" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-form-1", {
        values: {},
        result_type: "correction",
        correction_note: "字段不对，请先问我活动时间和负责人",
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

    expect(screen.getByText("已完成 1/1 · 1 个必填")).not.toBeNull();
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

  it("uses the interactive motion layer for form fields and floating select menus", () => {
    render(<A2UIBlock message={formMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("a2ui-form").getAttribute("data-a2ui-interactive-motion")).toBe("true");
    expect(screen.getByTestId("a2ui-form").getAttribute("data-a2ui-motion-state")).toBe("active");

    const titleField = screen.getByLabelText(/标题/).closest("[data-a2ui-interactive-item]");
    expect(titleField?.getAttribute("data-a2ui-motion-variant")).toBe("field");
    expect(titleField?.getAttribute("data-filled")).toBe("false");
    expect(titleField?.getAttribute("tabindex")).toBeNull();

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: "发布活动" } });

    expect(screen.getByLabelText(/标题/).closest("[data-a2ui-interactive-item]")?.getAttribute("data-filled")).toBe("true");
    expect(screen.getByTestId("a2ui-form").getAttribute("data-a2ui-motion-state")).toBe("dirty");

    fireEvent.click(screen.getByLabelText(/渠道/));

    expect(screen.getByRole("listbox").getAttribute("data-a2ui-floating-motion")).toBe("true");
    expect(screen.getByRole("option", { name: "微信" }).getAttribute("data-a2ui-floating-motion-item")).toBe("true");
    expect(screen.getByRole("button", { name: "提交参数" }).getAttribute("data-a2ui-action-motion")).toBe("true");
  });

  it("does not keep the submit badge loading when the transport promise hangs", async () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
      render(
        <A2UIBlock
          message={formMessage({ payload: { fields: [] } })}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "提交参数" }));

      expect(screen.getByRole("button", { name: "提交中" }).getAttribute("data-badge-state")).toBe("loading");

      await act(async () => {
        vi.advanceTimersByTime(120);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已提交" }).getAttribute("data-badge-state")).toBe("done");

      await act(async () => {
        vi.advanceTimersByTime(420);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已提交" }).getAttribute("data-badge-state")).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep the cancel badge loading when other interactions are still pending", async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn(() => new Promise<void>(() => undefined));
      render(
        <A2UIBlock
          message={formMessage({ payload: { fields: [] } })}
          onSubmit={vi.fn()}
          onCancel={onCancel}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "取消" }));

      expect(onCancel).toHaveBeenCalledWith("int-form-1", "用户取消", "ses-1");
      expect(screen.getByRole("button", { name: "取消中" }).getAttribute("data-badge-state")).toBe("loading");

      await act(async () => {
        vi.advanceTimersByTime(120);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已取消" }).getAttribute("data-badge-state")).toBe("done");

      await act(async () => {
        vi.advanceTimersByTime(420);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已取消" }).getAttribute("data-badge-state")).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends cancel with a note reason", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={formMessage()} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "以上信息不对！我来告诉 Keydex 应该怎么做" }));
    fireEvent.change(screen.getByLabelText("我来告诉 Keydex 应该怎么做"), { target: { value: "资料不足" } });
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
    expect(result.getByText("本次填写已提交")).not.toBeNull();
    expect(result.getByText("给 Keydex 的补充信息")).not.toBeNull();
    expect(result.getByText("已确认")).not.toBeNull();
    expect(result.queryByText("已提交表单")).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "提交参数" })).toBeNull();
  });

  it("renders cancelled forms with an explicit interaction outcome", () => {
    render(
      <A2UIBlock
        message={formMessage({
          interaction: {
            interaction_id: "int-form-1",
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

    const result = within(screen.getByTestId("a2ui-form-result"));
    expect(screen.getByTestId("a2ui-form-result").getAttribute("data-result-status")).toBe("cancelled");
    expect(result.getByText("标题")).not.toBeNull();
    expect(result.getAllByText("未填写").length).toBeGreaterThan(0);
    expect(result.getByText("已取消本次填写")).not.toBeNull();
    expect(result.queryByText(/原因/)).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
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
    expect(screen.getByText("正在生成字段中，请稍后...")).not.toBeNull();
    expect(screen.queryByTestId("a2ui-payload-summary")).toBeNull();
    expect(screen.queryByTestId("a2ui-stream-preview")).toBeNull();
    expect((screen.getByRole("button", { name: "提交参数" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps streamed form fields mounted when a later partial frame only contains metadata", () => {
    vi.useFakeTimers();
    try {
      const message = formMessage({
        payload: {
          fields: [
            { name: "title", label: "标题", type: "text", required: true },
            { name: "budget", label: "预算", type: "number" },
          ],
        },
      });
      const { rerender } = render(
        <A2UIBlock message={withStreamingPlaceholderDebug(message)} onSubmit={vi.fn()} onCancel={vi.fn()} />,
      );

      act(() => {
        vi.advanceTimersByTime(1_900);
      });

      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.getByLabelText(/预算/)).not.toBeNull();

      rerender(
        <A2UIBlock
          message={withStreamingPlaceholderDebug(message, {
            parsedArgs: {
              title: "请补充执行参数",
              description: "用于生成活动执行计划",
            },
            streamId: "",
            toolCallId: "",
          })}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.getByLabelText(/预算/)).not.toBeNull();
      expect(screen.queryByText("正在生成字段")).toBeNull();
      expect(screen.queryByText("暂无字段")).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("drains missing final form fields without replacing already streamed fields", () => {
    vi.useFakeTimers();
    try {
      const message = formMessage({
        payload: {
          fields: [
            { name: "title", label: "标题", type: "text", required: true },
            { name: "budget", label: "预算", type: "number" },
            { name: "owner", label: "负责人", type: "text" },
          ],
        },
      });
      const { rerender } = render(
        <A2UIBlock
          message={withStreamingPlaceholderDebug(message, {
            parsedArgs: {
              title: "请补充执行参数",
              description: "用于生成活动执行计划",
              fields: [{ name: "title", label: "标题", type: "text", required: true }],
            },
          })}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.queryByLabelText(/预算/)).toBeNull();

      rerender(<A2UIBlock message={withStreamedDebug(message)} onSubmit={vi.fn()} onCancel={vi.fn()} />);

      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.queryByLabelText(/预算/)).toBeNull();

      act(() => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByLabelText(/预算/)).not.toBeNull();
      expect(screen.queryByLabelText(/负责人/)).toBeNull();

      act(() => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByLabelText(/负责人/)).not.toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

function withStreamingPlaceholderDebug(
  message: ConversationMessage,
  options: {
    parsedArgs?: Record<string, unknown>;
    streamId?: string;
    toolCallId?: string;
  } = {},
): ConversationMessage {
  const a2ui = message.payload.a2ui as A2UIObject;
  const parsedArgs = options.parsedArgs ?? a2ui.payload;
  const argsBuffer = JSON.stringify(parsedArgs);
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
        streamId: options.streamId ?? "stream-form-placeholder",
        interactionId: "",
        toolCallId: options.toolCallId ?? "tool-form-placeholder",
        traceId: "trace-1",
        turnIndex: 1,
        chunkCount: 24,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs,
        payload: {},
        inputSchema: {},
        submitSchema: {},
        rawEvents: [],
        updatedAt: 1_700_000_000_010,
      } satisfies A2UIDebugBlockState,
    },
  };
}
