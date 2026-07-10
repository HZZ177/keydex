import type { ApprovalRequest, RuntimeEvent, Thread, ThreadItem, ThreadItemType, Turn } from "@/types/protocol";

export const eventReplayThreadId = "dev-thread-replay";

export function createEventReplayFixture(): RuntimeEvent[] {
  return [
    event(1, "thread.created", { thread: thread("running") }),
    event(2, "turn.started", { turn: turn("in_progress") }, { turnId: "turn-replay" }),
    itemStarted(3, item("item-user", "user_message", "completed", { input: [{ type: "text", text: "请分析项目并修改代码" }] })),
    itemCompleted(4, item("item-user", "user_message", "completed", { input: [{ type: "text", text: "请分析项目并修改代码" }] })),
    itemStarted(5, item("item-thinking", "reasoning", "running", { text: "" })),
    itemDelta(6, "item-thinking", "reasoning", { text: "正在检查代码结构。" }),
    itemCompleted(
      7,
      item("item-thinking", "reasoning", "completed", { text: "正在检查代码结构。", duration_ms: 2400 }),
      { text: "正在检查代码结构。", duration_ms: 2400 },
    ),
    itemStarted(8, item("item-assistant", "assistant_message", "running", { text: "" })),
    itemDelta(9, "item-assistant", "assistant_message", { text: "我会先定位入口，然后补充测试。" }),
    itemCompleted(
      10,
      item("item-assistant", "assistant_message", "completed", { text: "我会先定位入口，然后补充测试。" }),
      { text: "我会先定位入口，然后补充测试。" },
    ),
    itemStarted(11, item("item-tool", "tool_call", "running", { call: { id: "call-read", name: "read_file", arguments: { path: "src/main.ts" } } })),
    itemCompleted(
      12,
      item("item-tool", "tool_call", "completed", { call: { id: "call-read", name: "read_file", arguments: { path: "src/main.ts" } } }),
      { status: "success", model_content: "读取完成", duration_ms: 86 },
    ),
    itemStarted(13, item("item-command", "command_execution", "running", { command: "pnpm test", stdout: "" })),
    itemDelta(14, "item-command", "command_execution", { stdout: "24 passed\n" }),
    itemCompleted(15, item("item-command", "command_execution", "completed", { command: "pnpm test", stdout: "24 passed\n", exit_code: 0, duration_ms: 2300 })),
    itemStarted(16, item("item-file", "file_change", "completed", {
      files: [
        { path: "src/main.ts", additions: 1, deletions: 1, diff: "@@\n-old\n+new" },
      ],
      applied: true,
    })),
    itemCompleted(17, item("item-file", "file_change", "completed", {
      files: [
        { path: "src/main.ts", additions: 1, deletions: 1, diff: "@@\n-old\n+new" },
      ],
      applied: true,
    })),
    approvalRequested(18, approval("pending")),
    approvalResolved(19, approval("approved")),
    event(20, "runtime.error", {
      error: {
        code: "provider_error",
        message: "模型网关返回错误示例",
        details: { status: 502, provider: "openai-compatible" },
      },
    }),
    event(21, "turn.completed", { turn: turn("completed") }, { turnId: "turn-replay" }),
  ];
}

function event(
  seq: number,
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
  options: { eventId?: string; turnId?: string | null; itemId?: string | null } = {},
): RuntimeEvent {
  return {
    event_id: options.eventId ?? `replay-event-${seq}`,
    thread_id: eventReplayThreadId,
    turn_id: options.turnId ?? null,
    item_id: options.itemId ?? null,
    seq,
    type,
    created_at: `2026-06-17T10:00:${String(seq).padStart(2, "0")}Z`,
    payload,
  };
}

function thread(status: Thread["status"]): Thread {
  return {
    id: eventReplayThreadId,
    title: "事件回放",
    preview: "",
    cwd: "D:/repo",
    workspace_roots: ["D:/repo"],
    model: "qwen-coder",
    permission_mode: "workspace_write",
    status,
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    archived: false,
  };
}

function turn(status: Turn["status"]): Turn {
  return {
    id: "turn-replay",
    thread_id: eventReplayThreadId,
    status,
    started_at: "2026-06-17T10:00:00Z",
    completed_at: status === "in_progress" ? null : "2026-06-17T10:00:21Z",
    duration_ms: status === "in_progress" ? null : 21_000,
    error: null,
  };
}

function item(id: string, type: ThreadItemType, status: ThreadItem["status"], payload: Record<string, unknown>): ThreadItem {
  return {
    id,
    thread_id: eventReplayThreadId,
    turn_id: "turn-replay",
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
  return event(seq, "item.started", { item_type: itemValue.type, item: itemValue }, {
    turnId: itemValue.turn_id,
    itemId: itemValue.id,
  });
}

function itemDelta(seq: number, itemId: string, itemType: ThreadItemType, delta: Record<string, unknown>): RuntimeEvent {
  return event(seq, "item.delta", { item_type: itemType, delta, ...delta }, {
    turnId: "turn-replay",
    itemId,
  });
}

function itemCompleted(seq: number, itemValue: ThreadItem, result: Record<string, unknown> = {}): RuntimeEvent {
  return event(seq, "item.completed", { item_type: itemValue.type, item: itemValue, result }, {
    turnId: itemValue.turn_id,
    itemId: itemValue.id,
  });
}

function approval(status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id: "approval-replay",
    thread_id: eventReplayThreadId,
    turn_id: "turn-replay",
    item_id: "item-command",
    call_id: "call-command",
    kind: "exec",
    title: "允许执行测试命令",
    description: "智能体请求运行 pnpm test 验证改动。",
    details: { command: "pnpm test", cwd: "D:/repo" },
    status,
    created_at: "2026-06-17T10:00:18Z",
  };
}

function approvalRequested(seq: number, approvalValue: ApprovalRequest): RuntimeEvent {
  return event(seq, "approval.requested", { approval: approvalValue }, {
    turnId: approvalValue.turn_id,
    itemId: approvalValue.item_id,
  });
}

function approvalResolved(seq: number, approvalValue: ApprovalRequest): RuntimeEvent {
  return event(seq, "approval.resolved", {
    approval: approvalValue,
    response: { decision: "approved", remember: false },
  }, {
    turnId: approvalValue.turn_id,
    itemId: approvalValue.item_id,
  });
}
