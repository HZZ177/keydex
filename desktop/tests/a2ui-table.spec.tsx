import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

describe("A2TableBlock", () => {
  it("renders an editable virtualized table with Keydex interaction controls", async () => {
    render(<A2UIBlock message={tableMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const table = screen.getByTestId("a2ui-table");
    expect(within(table).getByRole("heading", { name: "项目计划审阅" })).not.toBeNull();
    expect(within(table).getByText("检查并调整计划后提交")).not.toBeNull();
    expect(within(table).getByText("3 列 · 2 行")).not.toBeNull();
    await waitFor(() => {
      expect(within(table).getByText("需求分析")).not.toBeNull();
      expect(within(table).getByText("开发实现")).not.toBeNull();
    });
    expect(within(table).getByRole("button", { name: "新增一行" })).not.toBeNull();
    expect(within(table).getByRole("button", { name: "以上表格不对！我来告诉 Keydex 应该怎么做" })).not.toBeNull();
    expect(within(table).getByRole("button", { name: "提交修改" })).not.toBeNull();
    expect(table.getAttribute("data-a2ui-player-enabled")).toBe("false");
  });

  it("submits edited cells, renamed headers and row mutations as a stable snapshot and diff", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={tableMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("需求分析")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "修改列名：任务" }));
    const headerInput = screen.getByLabelText("修改列名：任务");
    fireEvent.change(headerInput, { target: { value: "工作项" } });
    fireEvent.keyDown(headerInput, { key: "Enter" });

    const taskCell = screen.getByText("需求分析").closest("[role=gridcell]");
    expect(taskCell).not.toBeNull();
    fireEvent.click(taskCell!, { detail: 1 });
    const editor = await screen.findByDisplayValue("需求分析");
    expect(document.activeElement).toBe(editor);
    expect(taskCell!.classList.contains("ag-cell-inline-editing")).toBe(true);
    fireEvent.change(editor, { target: { value: "需求澄清" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("需求澄清")).not.toBeNull());

    fireEvent.click(screen.getAllByRole("button", { name: "删除该行" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "新增一行" }));
    fireEvent.click(screen.getByRole("button", { name: "提交修改" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [, submitResult, sessionId] = onSubmit.mock.calls[0];
    expect(sessionId).toBe("session-table");
    expect(submitResult.result_type).toBe("table");
    expect(submitResult.columns).toEqual([
      { key: "task", label: "工作项" },
      { key: "effort", label: "工作量" },
      { key: "priority", label: "优先级" },
    ]);
    expect(submitResult.rows[0]).toEqual({
      id: "row-1",
      values: { task: "需求澄清", effort: 2, priority: "high" },
    });
    expect(submitResult.changes.cells).toEqual([
      {
        row_id: "row-1",
        column_key: "task",
        old_value: "需求分析",
        new_value: "需求澄清",
      },
    ]);
    expect(submitResult.changes.column_labels).toEqual([
      { column_key: "task", old_label: "任务", new_label: "工作项" },
    ]);
    expect(submitResult.changes.deleted_row_ids).toEqual(["row-2"]);
    expect(submitResult.changes.added_row_ids).toHaveLength(1);
  });

  it("blocks submission when a newly added row leaves required cells empty", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={tableMessage({ requiredColumns: true })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("需求分析")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "新增一行" }));
    fireEvent.click(screen.getByRole("button", { name: "提交修改" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请检查 2 个必填单元格")).not.toBeNull();
  });

  it("resets and locks table operations when correction mode is selected", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={tableMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("需求分析")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "新增一行" }));
    expect(screen.getByText("3 列 · 3 行")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "以上表格不对！我来告诉 Keydex 应该怎么做" }));

    expect(screen.getByTestId("a2ui-table").getAttribute("data-correction-mode")).toBe("true");
    expect(screen.getByText("3 列 · 2 行")).not.toBeNull();
    expect((screen.getByRole("button", { name: "新增一行" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "提交修改" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "返回编辑表格" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回编辑表格" }));
    expect(screen.getByTestId("a2ui-table").getAttribute("data-correction-mode")).toBe("false");
    expect((screen.getByRole("button", { name: "新增一行" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "以上表格不对！我来告诉 Keydex 应该怎么做" }));

    fireEvent.change(screen.getByLabelText("我来告诉 Keydex 应该怎么做"), {
      target: { value: "请改成按负责人分组的表格" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修改" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("interaction-table", {
        result_type: "correction",
        columns: [],
        rows: [],
        changes: { cells: [], column_labels: [], added_row_ids: [], deleted_row_ids: [] },
        correction_note: "请改成按负责人分组的表格",
      }, "session-table");
    });
  });

  it("does not keep cancel state loading while another interaction remains pending", async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn(() => new Promise<void>(() => undefined));
      render(
        <StrictMode>
          <A2UIBlock message={tableMessage()} onSubmit={vi.fn()} onCancel={onCancel} />
        </StrictMode>,
      );

      fireEvent.click(screen.getByRole("button", { name: "取消" }));
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

  it("does not keep submit state loading under StrictMode", async () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
      render(
        <StrictMode>
          <A2UIBlock message={tableMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />
        </StrictMode>,
      );

      fireEvent.click(screen.getByRole("button", { name: "提交修改" }));
      expect(screen.getByRole("button", { name: "提交中" }).getAttribute("data-badge-state")).toBe("loading");

      await act(async () => {
        vi.advanceTimersByTime(120);
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

  it("renders the submitted table from the realtime ACK before the created snapshot is refreshed", async () => {
    const message = tableMessage();
    const submitted = submittedInteraction();
    const debug = message.payload.a2uiDebug as A2UIDebugBlockState;
    render(
      <A2UIBlock
        message={{
          ...message,
          status: "completed",
          payload: {
            ...message.payload,
            a2uiDebug: {
              ...debug,
              status: "submitted",
              interaction: submitted,
            },
            interaction: submitted,
          },
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("需求澄清")).not.toBeNull());
    expect(screen.queryByText("需求分析")).toBeNull();
    expect(screen.queryByRole("button", { name: "提交修改" })).toBeNull();
  });

  it("renders submitted and cancelled history as read-only sortable tables", async () => {
    const { rerender } = render(
      <A2UIBlock
        message={tableMessage({
          interaction: submittedInteraction(),
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("需求澄清")).not.toBeNull());
    expect(screen.getByText("本次表格修改已提交 · 修改 1 个单元格 · 修改 1 个列名")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "提交修改" })).toBeNull();
    expect(screen.queryByRole("button", { name: /修改列名/ })).toBeNull();

    rerender(
      <A2UIBlock
        message={tableMessage({ interaction: cancelledInteraction() })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("已取消本次表格修改")).not.toBeNull());
    expect(screen.queryByText(/取消原因/)).toBeNull();
    expect(screen.queryByText(/恢复状态/)).toBeNull();
  });

  it("keeps the full column structure stable while rows stream without overwriting edits", async () => {
    render(
      <A2UIBlock
        message={withStreamEvidence(tableMessage())}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const table = screen.getByTestId("a2ui-table");
    expect(table.getAttribute("data-a2ui-player-enabled")).toBe("true");
    expect(table.getAttribute("data-a2ui-reveal-visible")).toBe("1");
    expect(screen.getByText("3 列 · 1 行")).not.toBeNull();

    const firstTask = await screen.findByText("需求分析", {}, { timeout: 1_500 });
    expect(screen.queryByText("开发实现")).toBeNull();

    const firstTaskCell = firstTask.closest("[role=gridcell]");
    expect(firstTaskCell).not.toBeNull();
    fireEvent.click(firstTaskCell!, { detail: 1 });
    const editor = await screen.findByDisplayValue("需求分析");
    fireEvent.change(editor, { target: { value: "需求澄清" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("需求澄清")).not.toBeNull();
      expect(screen.getByText("开发实现")).not.toBeNull();
      expect(table.getAttribute("data-a2ui-reveal-visible")).toBe("2");
      expect(table.getAttribute("data-a2ui-player-running")).toBe("false");
    }, { timeout: 4_000 });
  }, 8_000);
});

function tableMessage(options: { interaction?: A2UIInteractionState; requiredColumns?: boolean } = {}): ConversationMessage {
  const interaction = options.interaction ?? waitingInteraction();
  const a2ui = tableObject(interaction, options.requiredColumns === true);
  return {
    id: "agent:a2ui-table",
    threadId: "session-table",
    turnId: null,
    itemId: "a2ui-table",
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: tableDebug(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: "table",
      streamId: "stream-table",
      historyHydrated: interaction.status !== "waiting_user_input",
    },
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function tableObject(interaction: A2UIInteractionState, requiredColumns = false): A2UIObject {
  return {
    render_key: "table",
    mode: "interactive",
    stream_id: "stream-table",
    tool_call_id: "tool-table",
    trace_id: "trace-table",
    turn_index: 1,
    payload: {
      title: "项目计划审阅",
      description: "检查并调整计划后提交",
      submit_label: "提交修改",
      allow_add_rows: true,
      allow_delete_rows: true,
      columns: [
        { key: "task", label: "任务", type: "text", required: requiredColumns },
        { key: "effort", label: "工作量", type: "number", required: requiredColumns },
        {
          key: "priority",
          label: "优先级",
          type: "select",
          options: [
            { label: "高", value: "high" },
            { label: "中", value: "medium" },
            { label: "低", value: "low" },
          ],
        },
      ],
      rows: [
        { id: "row-1", values: { task: "需求分析", effort: 2, priority: "high" } },
        { id: "row-2", values: { task: "开发实现", effort: 5, priority: "medium" } },
      ],
    },
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function waitingInteraction(): A2UIInteractionState {
  return {
    interaction_id: "interaction-table",
    status: "waiting_user_input",
    can_submit: true,
  };
}

function submittedInteraction(): A2UIInteractionState {
  return {
    interaction_id: "interaction-table",
    status: "submitted",
    can_submit: false,
    resume_status: "succeeded",
    submit_result: {
      result_type: "table",
      columns: [
        { key: "task", label: "工作项" },
        { key: "effort", label: "工作量" },
        { key: "priority", label: "优先级" },
      ],
      rows: [
        { id: "row-1", values: { task: "需求澄清", effort: 2, priority: "high" } },
        { id: "row-2", values: { task: "开发实现", effort: 5, priority: "medium" } },
      ],
      changes: {
        cells: [
          { row_id: "row-1", column_key: "task", old_value: "需求分析", new_value: "需求澄清" },
        ],
        column_labels: [
          { column_key: "task", old_label: "任务", new_label: "工作项" },
        ],
        added_row_ids: [],
        deleted_row_ids: [],
      },
    },
  };
}

function cancelledInteraction(): A2UIInteractionState {
  return {
    interaction_id: "interaction-table-cancelled",
    status: "cancelled",
    can_submit: false,
    resume_status: "succeeded",
    cancel_reason: "用户取消",
  };
}

function tableDebug(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  const status = interaction.status === "waiting_user_input"
    ? "waiting_input"
    : interaction.status === "submitted"
      ? "submitted"
      : interaction.status === "cancelled"
        ? "cancelled"
        : "created";
  return {
    id: "stream-table",
    status,
    renderKey: "table",
    mode: "interactive",
    streamId: "stream-table",
    interactionId: interaction.interaction_id,
    toolCallId: "tool-table",
    traceId: "trace-table",
    turnIndex: 1,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "valid",
    a2ui,
    payload: a2ui.payload,
    inputSchema: {},
    submitSchema: {},
    interaction,
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
  };
}

function withStreamEvidence(message: ConversationMessage): ConversationMessage {
  const a2ui = message.payload.a2ui as A2UIObject;
  const debug = message.payload.a2uiDebug as A2UIDebugBlockState;
  const argsBuffer = JSON.stringify(a2ui.payload);
  return {
    ...message,
    payload: {
      ...message.payload,
      a2uiDebug: {
        ...debug,
        chunkCount: 60,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        parsedArgs: a2ui.payload,
        rawEvents: [
          { id: "event-1", action: "a2ui_stream_start", timestamp: 1, data: {} },
          { id: "event-2", action: "a2ui_stream_finish", timestamp: 2, data: {} },
          { id: "event-3", action: "a2ui_created", timestamp: 3, data: {} },
        ],
      },
    },
  };
}
