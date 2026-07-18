import { describe, expect, it } from "vitest";

import type { ApprovalRequest, RuntimeEvent, Thread, ThreadItem, ThreadItemType, Turn } from "@/types/protocol";
import {
  createInitialConversationState,
  selectMessagesForThread,
  selectRuntimeState,
  selectTurnsForThread,
} from "@/renderer/stores/conversationStore";
import { reduceRuntimeEvent, replayRuntimeEvents } from "@/renderer/pages/conversation/messages/reducer";

describe("message reducer", () => {
  it("replays a complete runtime event fixture into chat messages", () => {
    const state = replayRuntimeEvents(createInitialConversationState(), [
      event(1, "thread.created", { thread: thread() }),
      event(2, "turn.started", { turn: turn("in_progress") }, { turnId: "turn-1" }),
      itemStarted(3, item("item-user", "user_message", "completed", { input: [{ type: "text", text: "请修改代码" }] })),
      itemCompleted(4, item("item-user", "user_message", "completed", { input: [{ type: "text", text: "请修改代码" }] })),
      itemStarted(5, item("item-assistant", "assistant_message", "running", { text: "" })),
      itemDelta(6, "item-assistant", "assistant_message", { text: "你" }),
      itemDelta(7, "item-assistant", "assistant_message", { text: "好" }),
      itemCompleted(8, item("item-assistant", "assistant_message", "completed", { text: "你好" }), { text: "你好" }),
      itemStarted(9, item("item-reasoning", "reasoning", "running", { text: "" })),
      itemDelta(10, "item-reasoning", "reasoning", { text: "思考" }),
      itemCompleted(11, item("item-reasoning", "reasoning", "completed", { text: "思考" }), { text: "思考" }),
      itemStarted(12, item("item-tool", "tool_call", "running", { call: { name: "read_file" } })),
      itemCompleted(13, item("item-tool", "tool_call", "completed", { call: { name: "read_file" } })),
      itemStarted(14, item("item-command", "command_execution", "running", { command: "echo ok", stdout: "" })),
      itemDelta(15, "item-command", "command_execution", { stdout: "ok\n" }),
      itemCompleted(16, item("item-command", "command_execution", "completed", { command: "echo ok", stdout: "ok\n" })),
      itemStarted(17, item("item-file", "file_change", "completed", { path: "src/main.py", diff: "@@" })),
      itemCompleted(18, item("item-file", "file_change", "completed", { path: "src/main.py", diff: "@@" })),
      approvalRequested(19, approval("pending")),
      approvalResolved(20, approval("approved")),
      event(21, "turn.completed", { turn: turn("completed") }, { turnId: "turn-1" }),
    ]);

    const messages = selectMessagesForThread(state, "thr-1");

    expect(messages.map((message) => message.kind)).toEqual([
      "user",
      "assistant",
      "thinking",
      "tool",
      "command",
      "file_change",
      "approval",
    ]);
    expect(messages.find((message) => message.kind === "user")?.content).toBe("请修改代码");
    expect(messages.find((message) => message.kind === "assistant")?.content).toBe("你好");
    expect(messages.find((message) => message.kind === "thinking")?.content).toBe("思考");
    expect(messages.find((message) => message.kind === "command")?.content).toBe("ok\n");
    expect(messages.find((message) => message.kind === "file_change")?.content).toBe("src/main.py");
    expect(messages.find((message) => message.kind === "approval")?.status).toBe("approved");
    expect(selectRuntimeState(state, "thr-1")).toBe("idle");
  });

  it("appends deltas by item id and ignores duplicate or stale events", () => {
    let state = createInitialConversationState();
    state = reduceRuntimeEvent(state, itemStarted(1, item("item-a", "assistant_message", "running", { text: "" })));
    state = reduceRuntimeEvent(state, itemStarted(2, item("item-command", "command_execution", "running", { stdout: "" })));
    state = reduceRuntimeEvent(state, itemDelta(3, "item-a", "assistant_message", { text: "A1" }, "evt-delta-a"));
    state = reduceRuntimeEvent(state, itemDelta(3, "item-a", "assistant_message", { text: "A1" }, "evt-delta-a"));
    state = reduceRuntimeEvent(state, itemDelta(2, "item-command", "command_execution", { stdout: "stale" }, "evt-stale"));

    const messages = selectMessagesForThread(state, "thr-1");
    const assistant = messages.find((message) => message.itemId === "item-a");
    const command = messages.find((message) => message.itemId === "item-command");

    expect(assistant?.content).toBe("A1");
    expect(command?.content).toBe("");
  });

  it("promotes delegate_subagent above the ordinary tool message kind", () => {
    const state = replayRuntimeEvents(createInitialConversationState(), [
      itemStarted(
        1,
        item("item-subagent", "tool_call", "running", {
          call: {
            id: "call-subagent",
            name: "delegate_subagent",
            arguments: { type: "explorer", task: "inspect the workspace" },
          },
        }),
      ),
    ]);

    expect(selectMessagesForThread(state, "thr-1")).toMatchObject([
      {
        kind: "subagent_invocation",
        itemId: "item-subagent",
        payload: { call: { name: "delegate_subagent" } },
      },
    ]);
  });

  it("promotes continue_subagent above the ordinary tool message kind", () => {
    const state = replayRuntimeEvents(createInitialConversationState(), [
      itemStarted(
        1,
        item("item-subagent-continue", "tool_call", "running", {
          call: {
            id: "call-subagent-continue",
            name: "continue_subagent",
            arguments: { subagent_id: "subagent-1", task: "continue with prior context" },
          },
        }),
      ),
    ]);

    expect(selectMessagesForThread(state, "thr-1")).toMatchObject([
      {
        kind: "subagent_invocation",
        itemId: "item-subagent-continue",
        payload: { call: { name: "continue_subagent" } },
      },
    ]);
  });

  it("orders thinking by first content delta instead of assistant placeholder creation", () => {
    const state = replayRuntimeEvents(createInitialConversationState(), [
      itemStarted(1, item("item-user", "user_message", "completed", { input: [{ type: "text", text: "分析问题" }] })),
      itemStarted(2, item("item-assistant", "assistant_message", "running", { text: "" })),
      itemStarted(3, item("item-reasoning", "reasoning", "running", { text: "" })),
      itemDelta(4, "item-reasoning", "reasoning", { text: "先检查上下文" }),
      itemDelta(5, "item-assistant", "assistant_message", { text: "结论" }),
    ]);

    const messages = selectMessagesForThread(state, "thr-1");

    expect(messages.map((message) => message.kind)).toEqual(["user", "thinking", "assistant"]);
    expect(messages[1].content).toBe("先检查上下文");
    expect(messages[2].content).toBe("结论");
  });

  it("projects turn and runtime errors into visible error messages", () => {
    const state = replayRuntimeEvents(createInitialConversationState(), [
      event(
        1,
        "turn.failed",
        {
          turn: turn("failed"),
          code: "llm_request_failed",
          message: "模型请求失败",
          error: "模型请求失败",
          details: {
            raw_message: "Error code: 402 - Insufficient Balance",
            status_code: 402,
          },
        },
        { turnId: "turn-1" },
      ),
      event(2, "runtime.error", {
        error: {
          code: "runtime_error",
          message: "WebSocket 断开",
          details: {},
        },
      }),
      event(3, "turn.failed", {
        error: {
          schema_version: 1,
          code: "llm_bad_request",
          message: "模型请求参数无效",
          details: {
            provider_code: "invalid_request_error",
            provider_message: "messages must not be empty",
          },
          retryable: false,
          status: 400,
        },
      }),
    ]);

    const messages = selectMessagesForThread(state, "thr-1");

    expect(selectTurnsForThread(state, "thr-1")[0].status).toBe("failed");
    expect(selectRuntimeState(state, "thr-1")).toBe("failed");
    expect(messages.filter((message) => message.kind === "error").map((message) => message.content)).toEqual([
      "模型请求失败",
      "WebSocket 断开",
      "模型请求参数无效",
    ]);
    expect(messages[0].payload.error).toMatchObject({
      code: "llm_request_failed",
      details: {
        status_code: 402,
      },
    });
    expect(messages[2].payload.error).toEqual({
      schema_version: 1,
      code: "llm_bad_request",
      message: "模型请求参数无效",
      details: {
        provider_code: "invalid_request_error",
        provider_message: "messages must not be empty",
      },
      retryable: false,
      status: 400,
    });
  });

  it("projects update_plan tool calls into plan messages", () => {
    const planPayload = {
      call: {
        name: "update_plan",
        arguments: {
          plan: [
            { step: "分析 AionUi 计划卡片", status: "completed" },
            { step: "复刻计划卡片", status: "in_progress" },
          ],
        },
      },
    };
    const state = replayRuntimeEvents(createInitialConversationState(), [
      itemStarted(1, item("item-plan", "tool_call", "running", planPayload)),
      itemCompleted(
        2,
        item("item-plan", "tool_call", "completed", {
          ...planPayload,
          ui_payload: {
            explanation: "计划同步完成",
            entries: [
              { content: "分析 AionUi 计划卡片", status: "completed" },
              { content: "复刻计划卡片", status: "in_progress" },
            ],
          },
        }),
        {
          status: "success",
          ui_payload: {
            explanation: "计划同步完成",
            entries: [
              { content: "分析 AionUi 计划卡片", status: "completed" },
              { content: "复刻计划卡片", status: "in_progress" },
            ],
          },
        },
      ),
    ]);

    const messages = selectMessagesForThread(state, "thr-1");

    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("plan");
    expect(messages[0].payload.ui_payload).toEqual({
      explanation: "计划同步完成",
      entries: [
        { content: "分析 AionUi 计划卡片", status: "completed" },
        { content: "复刻计划卡片", status: "in_progress" },
      ],
    });
  });

  it("moves runtime state into waiting approval until the approval is resolved", () => {
    let state = replayRuntimeEvents(createInitialConversationState(), [
      event(1, "thread.created", { thread: thread() }),
      event(2, "turn.started", { turn: turn("in_progress") }, { turnId: "turn-1" }),
    ]);

    state = reduceRuntimeEvent(state, approvalRequested(3, approval("pending")));
    expect(selectRuntimeState(state, "thr-1")).toBe("waiting_approval");

    state = reduceRuntimeEvent(state, approvalResolved(4, approval("approved")));
    expect(selectRuntimeState(state, "thr-1")).toBe("running");
  });
});

function event(
  seq: number,
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
  options: { eventId?: string; turnId?: string | null; itemId?: string | null } = {},
): RuntimeEvent {
  return {
    event_id: options.eventId ?? `evt-${seq}`,
    thread_id: "thr-1",
    turn_id: options.turnId ?? null,
    item_id: options.itemId ?? null,
    seq,
    type,
    created_at: `2026-06-17T10:00:${String(seq).padStart(2, "0")}Z`,
    payload,
  };
}

function thread(): Thread {
  return {
    id: "thr-1",
    title: "测试会话",
    preview: "",
    cwd: "D:/repo",
    workspace_roots: ["D:/repo"],
    model: "qwen-coder",
    permission_mode: "workspace_write",
    status: "running",
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    archived_at: null,
    archive_origin: null,
  };
}

function turn(status: Turn["status"], error: Turn["error"] = null): Turn {
  return {
    id: "turn-1",
    thread_id: "thr-1",
    status,
    started_at: "2026-06-17T10:00:00Z",
    completed_at: status === "in_progress" ? null : "2026-06-17T10:00:21Z",
    duration_ms: status === "in_progress" ? null : 21_000,
    error,
  };
}

function item(
  id: string,
  type: ThreadItemType,
  status: ThreadItem["status"],
  payload: Record<string, unknown>,
): ThreadItem {
  return {
    id,
    thread_id: "thr-1",
    turn_id: "turn-1",
    type,
    status,
    payload,
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    seq_start: null,
    seq_end: null,
  };
}

function itemStarted(seq: number, itemValue: ThreadItem): RuntimeEvent {
  return event(
    seq,
    "item.started",
    {
      item_type: itemValue.type,
      status: itemValue.status,
      item: itemValue,
    },
    { turnId: itemValue.turn_id, itemId: itemValue.id },
  );
}

function itemDelta(
  seq: number,
  itemId: string,
  itemType: ThreadItemType,
  delta: Record<string, unknown>,
  eventId?: string,
): RuntimeEvent {
  return event(
    seq,
    "item.delta",
    {
      item_type: itemType,
      delta,
      ...delta,
    },
    { eventId, turnId: "turn-1", itemId },
  );
}

function itemCompleted(seq: number, itemValue: ThreadItem, result: Record<string, unknown> = {}): RuntimeEvent {
  return event(
    seq,
    "item.completed",
    {
      item_type: itemValue.type,
      status: itemValue.status,
      item: itemValue,
      result,
    },
    { turnId: itemValue.turn_id, itemId: itemValue.id },
  );
}

function approval(status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id: "approval-1",
    thread_id: "thr-1",
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-1",
    kind: "exec",
    title: "允许执行命令",
    description: "请求执行回显命令。",
    details: { command: "echo ok" },
    status,
    created_at: "2026-06-17T10:00:19Z",
  };
}

function approvalRequested(seq: number, approvalValue: ApprovalRequest): RuntimeEvent {
  return event(seq, "approval.requested", { approval: approvalValue }, {
    turnId: approvalValue.turn_id,
    itemId: approvalValue.item_id,
  });
}

function approvalResolved(seq: number, approvalValue: ApprovalRequest): RuntimeEvent {
  return event(
    seq,
    "approval.resolved",
    { approval: approvalValue, response: { decision: "approved", remember: false } },
    {
      turnId: approvalValue.turn_id,
      itemId: approvalValue.item_id,
    },
  );
}
