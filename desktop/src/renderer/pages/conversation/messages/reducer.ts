import type {
  ApprovalRequest,
  RuntimeEvent,
  Thread,
  ThreadItem,
  ThreadItemType,
  Turn,
  TurnError,
} from "@/types/protocol";
import { normalizeRuntimeErrorEnvelope } from "@/runtime/errors";
import {
  conversationReducer,
  hasProcessedEvent,
  selectMessagesForThread,
  type ConversationMessage,
  type ConversationMessageKind,
  type ConversationState,
} from "@/renderer/stores/conversationStore";

export function reduceRuntimeEvent(state: ConversationState, event: RuntimeEvent): ConversationState {
  if (hasProcessedEvent(state, event)) {
    return state;
  }

  let next = conversationReducer(state, { type: "event/record", event });

  switch (event.type) {
    case "thread.created":
      return reduceThreadCreated(next, event);
    case "thread.updated":
      return reduceThreadUpdated(next, event);
    case "turn.started":
      return reduceTurn(next, event, "running");
    case "turn.completed":
      return reduceTurn(next, event, "idle");
    case "turn.failed":
      return reduceTurnFailed(next, event);
    case "turn.cancelled":
      return conversationReducer(next, {
        type: "runtime/setState",
        threadId: event.thread_id,
        runtimeState: "idle",
      });
    case "item.started":
      return reduceItemStarted(next, event);
    case "item.delta":
      return reduceItemDelta(next, event);
    case "item.completed":
      return reduceItemCompleted(next, event);
    case "approval.requested":
      return reduceApprovalRequested(next, event);
    case "approval.resolved":
      return reduceApprovalResolved(next, event);
    case "runtime.error":
      return reduceRuntimeError(next, event);
  }
}

export function replayRuntimeEvents(
  initialState: ConversationState,
  events: RuntimeEvent[],
): ConversationState {
  return events.reduce(reduceRuntimeEvent, initialState);
}

function reduceThreadCreated(state: ConversationState, event: RuntimeEvent): ConversationState {
  const thread = event.payload.thread as Thread | undefined;
  return thread ? conversationReducer(state, { type: "thread/upsert", thread }) : state;
}

function reduceThreadUpdated(state: ConversationState, event: RuntimeEvent): ConversationState {
  const existing = state.threadsById[event.thread_id];
  const patch = event.payload.patch as Partial<Thread> | undefined;
  if (!existing || !patch) {
    return state;
  }
  return conversationReducer(state, {
    type: "thread/upsert",
    thread: { ...existing, ...patch },
  });
}

function reduceTurn(
  state: ConversationState,
  event: RuntimeEvent,
  runtimeState: "running" | "idle" | "failed",
): ConversationState {
  const turn = event.payload.turn as Turn | undefined;
  let next = turn ? conversationReducer(state, { type: "turn/upsert", turn }) : state;
  next = conversationReducer(next, {
    type: "runtime/setState",
    threadId: event.thread_id,
    runtimeState,
  });
  return next;
}

function reduceTurnFailed(state: ConversationState, event: RuntimeEvent): ConversationState {
  let next = reduceTurn(state, event, "failed");
  const error = normalizeTurnFailedError(event.payload);
  next = upsertErrorMessage(next, event, error, `turn-error:${event.turn_id ?? event.event_id}`);
  return next;
}

function reduceRuntimeError(state: ConversationState, event: RuntimeEvent): ConversationState {
  const next = conversationReducer(state, {
    type: "runtime/setState",
    threadId: event.thread_id,
    runtimeState: "failed",
  });
  const error = normalizeRuntimeErrorEnvelope(event.payload, {
    fallbackCode: "runtime_error",
    fallbackMessage: "运行时错误",
  });
  return upsertErrorMessage(next, event, error, `runtime-error:${event.event_id}`);
}

function reduceItemStarted(state: ConversationState, event: RuntimeEvent): ConversationState {
  const item = event.payload.item as ThreadItem | undefined;
  if (!item) {
    return state;
  }
  const next = conversationReducer(state, { type: "item/upsert", item });
  return conversationReducer(next, {
    type: "message/upsert",
    message: messageFromItem(item, undefined, event.seq),
  });
}

function reduceItemDelta(state: ConversationState, event: RuntimeEvent): ConversationState {
  if (!event.item_id) {
    return state;
  }
  const message = state.messagesById[messageIdForItem(event.item_id)];
  if (!message) {
    return state;
  }
  const delta = extractDelta(event.payload);
  const mergedPayload = mergePayloadDelta(message.payload, delta);
  const updated: ConversationMessage = {
    ...message,
    content: appendDeltaContent(message, delta),
    payload: sortPayloadForDelta(message, mergedPayload, delta, event.seq),
    updatedAt: event.created_at,
  };
  return conversationReducer(state, { type: "message/upsert", message: updated });
}

function reduceItemCompleted(state: ConversationState, event: RuntimeEvent): ConversationState {
  const item = event.payload.item as ThreadItem | undefined;
  if (!item) {
    return state;
  }
  let next = conversationReducer(state, { type: "item/upsert", item });
  const existing = next.messagesById[messageIdForItem(item.id)];
  const completed = existing
    ? completeMessage(existing, item, event.payload.result as Record<string, unknown> | undefined)
    : messageFromItem(item, event.payload.result as Record<string, unknown> | undefined, event.seq);
  next = conversationReducer(next, { type: "message/upsert", message: completed });
  return next;
}

function reduceApprovalRequested(state: ConversationState, event: RuntimeEvent): ConversationState {
  const approval = event.payload.approval as ApprovalRequest | undefined;
  if (!approval) {
    return state;
  }
  const message: ConversationMessage = {
    id: messageIdForApproval(approval.id),
    threadId: approval.thread_id,
    turnId: approval.turn_id,
    itemId: approval.item_id,
    kind: "approval",
    status: approval.status,
    content: approval.title || approval.description,
    payload: { approval },
    createdAt: approval.created_at,
    updatedAt: event.created_at,
  };
  const next = conversationReducer(state, { type: "message/upsert", message });
  return conversationReducer(next, {
    type: "runtime/setState",
    threadId: approval.thread_id,
    runtimeState: "waiting_approval",
  });
}

function reduceApprovalResolved(state: ConversationState, event: RuntimeEvent): ConversationState {
  const approval = event.payload.approval as ApprovalRequest | undefined;
  if (!approval) {
    return state;
  }
  const existing = state.messagesById[messageIdForApproval(approval.id)];
  const message: ConversationMessage = {
    ...(existing ?? {
      id: messageIdForApproval(approval.id),
      threadId: approval.thread_id,
      turnId: approval.turn_id,
      itemId: approval.item_id,
      kind: "approval" as const,
      content: approval.title || approval.description,
      payload: {},
      createdAt: approval.created_at,
    }),
    status: approval.status,
    payload: { ...existing?.payload, approval, response: event.payload.response },
    updatedAt: event.created_at,
  };
  const next = conversationReducer(state, { type: "message/upsert", message });
  if (state.runtimeStateByThread[approval.thread_id] !== "waiting_approval") {
    return next;
  }
  return conversationReducer(next, {
    type: "runtime/setState",
    threadId: approval.thread_id,
    runtimeState: state.activeTurnIdByThread[approval.thread_id] ? "running" : "idle",
  });
}

function upsertErrorMessage(
  state: ConversationState,
  event: RuntimeEvent,
  error: TurnError,
  messageId: string,
): ConversationState {
  const message: ConversationMessage = {
    id: messageId,
    threadId: event.thread_id,
    turnId: event.turn_id,
    itemId: event.item_id,
    kind: "error",
    status: "failed",
    content: error.message,
    payload: { error },
    createdAt: event.created_at,
    updatedAt: event.created_at,
  };
  return conversationReducer(state, { type: "message/upsert", message });
}

function messageFromItem(item: ThreadItem, result?: Record<string, unknown>, sortSeq?: number): ConversationMessage {
  const payload = result ? { ...item.payload, result } : item.payload;
  return {
    id: messageIdForItem(item.id),
    threadId: item.thread_id,
    turnId: item.turn_id,
    itemId: item.id,
    kind: kindFromItem(item),
    itemType: item.type,
    status: item.status,
    content: contentFromItem(item, result),
    payload: withSortSeq(payload, sortSeq),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function completeMessage(
  message: ConversationMessage,
  item: ThreadItem,
  result?: Record<string, unknown>,
): ConversationMessage {
  const content = contentFromItem(item, result);
  const payload = result ? { ...item.payload, result } : item.payload;
  return {
    ...message,
    itemType: item.type,
    status: item.status,
    content: content || message.content,
    payload: preserveSortSeq(message.payload, payload),
    updatedAt: item.updated_at,
  };
}

function appendDeltaContent(message: ConversationMessage, delta: Record<string, unknown>): string {
  if (typeof delta.text === "string" && (message.kind === "assistant" || message.kind === "thinking")) {
    return `${message.content}${delta.text}`;
  }
  if (message.kind === "command") {
    const stdout = typeof delta.stdout === "string" ? delta.stdout : "";
    const stderr = typeof delta.stderr === "string" ? delta.stderr : "";
    return `${message.content}${stdout}${stderr}`;
  }
  return message.content;
}

function sortPayloadForDelta(
  message: ConversationMessage,
  payload: Record<string, unknown>,
  delta: Record<string, unknown>,
  seq: number,
): Record<string, unknown> {
  if (
    typeof delta.text === "string" &&
    delta.text.length > 0 &&
    !message.content &&
    (message.kind === "assistant" || message.kind === "thinking")
  ) {
    return withSortSeq(payload, seq);
  }
  return payload;
}

function contentFromItem(item: ThreadItem, result?: Record<string, unknown>): string {
  if (typeof result?.text === "string") {
    return result.text;
  }
  if (typeof item.payload.text === "string") {
    return item.payload.text;
  }
  if (item.type === "user_message") {
    return formatUserInput(item.payload.input);
  }
  if (item.type === "tool_call") {
    const call = item.payload.call as { name?: unknown } | undefined;
    return typeof call?.name === "string" ? call.name : "工具调用";
  }
  if (item.type === "command_execution") {
    return [item.payload.stdout, item.payload.stderr].filter((value) => typeof value === "string").join("");
  }
  if (item.type === "file_change") {
    return typeof item.payload.path === "string" ? item.payload.path : "文件变更";
  }
  if (item.type === "error") {
    const error = normalizeRuntimeErrorEnvelope(item.payload, {
      fallbackCode: "item_error",
      fallbackMessage: "消息执行失败",
    });
    return error.message;
  }
  return "";
}

function kindFromItemType(type: ThreadItemType): ConversationMessageKind {
  switch (type) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "reasoning":
      return "thinking";
    case "tool_call":
      return "tool";
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "approval_request":
      return "approval";
    case "error":
      return "error";
    case "token_usage":
      return "status";
  }
}

function kindFromItem(item: ThreadItem): ConversationMessageKind {
  if (item.type === "tool_call" && toolCallName(item) === "update_plan") {
    return "plan";
  }
  if (item.type === "tool_call" && toolCallName(item) === "load_skill") {
    return "skill";
  }
  if (item.type === "tool_call" && isSubagentToolName(toolCallName(item))) {
    return "subagent_invocation";
  }
  return kindFromItemType(item.type);
}

function isSubagentToolName(value: string | null): boolean {
  return value === "delegate_subagent" || value === "continue_subagent";
}

function toolCallName(item: ThreadItem): string | null {
  const call = item.payload.call;
  if (!call || typeof call !== "object") {
    return null;
  }
  const name = (call as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function extractDelta(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.delta && typeof payload.delta === "object" && !Array.isArray(payload.delta)) {
    return payload.delta as Record<string, unknown>;
  }
  const { item_type: _itemType, delta: _delta, ...legacyDelta } = payload;
  return legacyDelta;
}

function mergePayloadDelta(
  payload: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...payload };
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === "string" && typeof merged[key] === "string") {
      merged[key] = `${merged[key]}${value}`;
    } else if (typeof value === "string" && (key === "text" || key === "stdout" || key === "stderr")) {
      merged[key] = `${merged[key] ?? ""}${value}`;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function withSortSeq(payload: Record<string, unknown>, sortSeq?: number): Record<string, unknown> {
  if (typeof sortSeq !== "number") {
    return payload;
  }
  return { ...payload, _sortSeq: sortSeq };
}

function preserveSortSeq(
  existingPayload: Record<string, unknown>,
  nextPayload: Record<string, unknown>,
): Record<string, unknown> {
  return typeof existingPayload._sortSeq === "number" ? { ...nextPayload, _sortSeq: existingPayload._sortSeq } : nextPayload;
}

function normalizeTurnFailedError(payload: Record<string, unknown>): TurnError {
  const turn = payload.turn as Record<string, unknown> | undefined;
  const hasDirectError =
    payload.error !== undefined ||
    payload.code !== undefined ||
    payload.message !== undefined ||
    payload.details !== undefined;
  return normalizeRuntimeErrorEnvelope(
    hasDirectError ? payload : turn?.error,
    { fallbackCode: "turn_error", fallbackMessage: "对话执行失败" },
  );
}

function formatUserInput(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }
  return input
    .map((entry) => {
      if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
        return (entry as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageIdForItem(itemId: string): string {
  return `item:${itemId}`;
}

function messageIdForApproval(approvalId: string): string {
  return `approval:${approvalId}`;
}

export function findMessageByItemId(state: ConversationState, itemId: string): ConversationMessage | null {
  return selectMessagesForThread(state, state.itemsById[itemId]?.thread_id ?? "")
    .find((message) => message.itemId === itemId) ?? null;
}
