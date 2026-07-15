import type {
  RuntimeEvent,
  ApprovalStatus,
  Thread,
  ThreadDetail,
  ThreadItem,
  ThreadItemStatus,
  ThreadItemType,
  Turn,
  TurnStatus,
} from "@/types/protocol";

export type ConversationRuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "cancelling"
  | "failed";

export type ConversationMessageKind =
  | "user"
  | "assistant"
  | "thinking"
  | "plan"
  | "skill"
  | "tool"
  | "web_activity"
  | "command"
  | "file_change"
  | "approval"
  | "mcp_elicitation"
  | "a2ui"
  | "error"
  | "cancelled"
  | "context_compression"
  | "turn_marker"
  | "thread_task_status"
  | "llm_retry"
  | "status";

export interface ConversationMessage {
  id: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  kind: ConversationMessageKind;
  itemType?: ThreadItemType;
  status?: ThreadItemStatus | TurnStatus | ApprovalStatus;
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationState {
  threadIds: string[];
  threadsById: Record<string, Thread>;
  selectedThreadId: string | null;
  turnIdsByThread: Record<string, string[]>;
  turnsById: Record<string, Turn>;
  activeTurnIdByThread: Record<string, string | null>;
  itemIdsByThread: Record<string, string[]>;
  itemsById: Record<string, ThreadItem>;
  messageIdsByThread: Record<string, string[]>;
  messagesById: Record<string, ConversationMessage>;
  lastSeqByThread: Record<string, number>;
  processedEventIds: Record<string, true>;
  runtimeStateByThread: Record<string, ConversationRuntimeState>;
}

export type ConversationAction =
  | { type: "threads/set"; threads: Thread[] }
  | { type: "thread/upsert"; thread: Thread }
  | { type: "thread/select"; threadId: string | null }
  | { type: "thread/detailLoaded"; detail: ThreadDetail }
  | { type: "turn/upsert"; turn: Turn }
  | { type: "item/upsert"; item: ThreadItem }
  | { type: "message/upsert"; message: ConversationMessage }
  | { type: "message/remove"; messageId: string }
  | { type: "runtime/setState"; threadId: string; runtimeState: ConversationRuntimeState }
  | { type: "event/record"; event: RuntimeEvent };

export function createInitialConversationState(): ConversationState {
  return {
    threadIds: [],
    threadsById: {},
    selectedThreadId: null,
    turnIdsByThread: {},
    turnsById: {},
    activeTurnIdByThread: {},
    itemIdsByThread: {},
    itemsById: {},
    messageIdsByThread: {},
    messagesById: {},
    lastSeqByThread: {},
    processedEventIds: {},
    runtimeStateByThread: {},
  };
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "threads/set":
      return setThreads(state, action.threads);
    case "thread/upsert":
      return upsertThread(state, action.thread);
    case "thread/select":
      return { ...state, selectedThreadId: action.threadId };
    case "thread/detailLoaded":
      return loadThreadDetail(state, action.detail);
    case "turn/upsert":
      return upsertTurn(state, action.turn);
    case "item/upsert":
      return upsertItem(state, action.item);
    case "message/upsert":
      return upsertMessage(state, action.message);
    case "message/remove":
      return removeMessage(state, action.messageId);
    case "runtime/setState":
      return {
        ...state,
        runtimeStateByThread: {
          ...state.runtimeStateByThread,
          [action.threadId]: action.runtimeState,
        },
      };
    case "event/record":
      return recordEvent(state, action.event);
  }
}

export function selectThreads(state: ConversationState): Thread[] {
  return state.threadIds.map((id) => state.threadsById[id]).filter(isDefined);
}

export function selectSelectedThread(state: ConversationState): Thread | null {
  return state.selectedThreadId ? state.threadsById[state.selectedThreadId] ?? null : null;
}

export function selectTurnsForThread(state: ConversationState, threadId: string): Turn[] {
  return (state.turnIdsByThread[threadId] ?? []).map((id) => state.turnsById[id]).filter(isDefined);
}

export function selectItemsForThread(state: ConversationState, threadId: string): ThreadItem[] {
  return (state.itemIdsByThread[threadId] ?? []).map((id) => state.itemsById[id]).filter(isDefined);
}

export function selectMessagesForThread(
  state: ConversationState,
  threadId: string,
): ConversationMessage[] {
  return (state.messageIdsByThread[threadId] ?? [])
    .map((id) => state.messagesById[id])
    .filter(isDefined);
}

export function selectActiveTurn(state: ConversationState, threadId: string): Turn | null {
  const turnId = state.activeTurnIdByThread[threadId];
  return turnId ? state.turnsById[turnId] ?? null : null;
}

export function selectRuntimeState(
  state: ConversationState,
  threadId: string,
): ConversationRuntimeState {
  return state.runtimeStateByThread[threadId] ?? "idle";
}

export function selectLastSeq(state: ConversationState, threadId: string): number {
  return state.lastSeqByThread[threadId] ?? 0;
}

export function hasProcessedEvent(state: ConversationState, event: RuntimeEvent): boolean {
  return Boolean(state.processedEventIds[event.event_id]) || event.seq <= selectLastSeq(state, event.thread_id);
}

function setThreads(state: ConversationState, threads: Thread[]): ConversationState {
  const threadsById = { ...state.threadsById };
  for (const thread of threads) {
    threadsById[thread.id] = thread;
  }
  const threadIds = sortThreadIds(threads);
  return {
    ...state,
    threadsById,
    threadIds,
    selectedThreadId: state.selectedThreadId ?? threadIds[0] ?? null,
  };
}

function loadThreadDetail(state: ConversationState, detail: ThreadDetail): ConversationState {
  let next = upsertThread(state, detail.thread);
  const turnsById = { ...next.turnsById };
  const itemsById = { ...next.itemsById };
  const messagesById = { ...next.messagesById };
  for (const turn of detail.turns) {
    turnsById[turn.id] = turn;
  }
  for (const item of detail.items) {
    itemsById[item.id] = item;
    const message = messageFromThreadItem(item);
    if (message) {
      messagesById[message.id] = message;
    }
  }
  const messages = Object.values(messagesById).filter((message) => message.threadId === detail.thread.id);
  const activeTurnId = detail.turns.find((turn) => isActiveTurnStatus(turn.status))?.id ?? null;
  next = {
    ...next,
    selectedThreadId: detail.thread.id,
    turnsById,
    itemsById,
    messagesById,
    turnIdsByThread: {
      ...next.turnIdsByThread,
      [detail.thread.id]: sortTurnIds(detail.turns),
    },
    itemIdsByThread: {
      ...next.itemIdsByThread,
      [detail.thread.id]: sortItemIds(detail.items),
    },
    messageIdsByThread: {
      ...next.messageIdsByThread,
      [detail.thread.id]: sortMessageIds(messages),
    },
    activeTurnIdByThread: {
      ...next.activeTurnIdByThread,
      [detail.thread.id]: activeTurnId,
    },
    runtimeStateByThread: {
      ...next.runtimeStateByThread,
      [detail.thread.id]: activeTurnId ? "running" : runtimeStateFromThread(detail.thread),
    },
  };
  return next;
}

function messageFromThreadItem(item: ThreadItem): ConversationMessage | null {
  const kind = messageKindFromThreadItem(item);
  if (!kind) {
    return null;
  }
  return {
    id: `item:${item.id}`,
    threadId: item.thread_id,
    turnId: item.turn_id,
    itemId: item.id,
    kind,
    itemType: item.type,
    status: item.status,
    content: messageContentFromThreadItem(item),
    payload: withThreadItemSortSeq(item.payload, item.seq_start),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function messageKindFromThreadItem(item: ThreadItem): ConversationMessageKind | null {
  if (item.type === "tool_call" && toolCallName(item) === "update_plan") {
    return "plan";
  }
  switch (item.type) {
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
    default:
      return null;
  }
}

function messageContentFromThreadItem(item: ThreadItem): string {
  if (typeof item.payload.text === "string") {
    return item.payload.text;
  }
  if (item.type === "user_message") {
    return inputTextFromPayload(item.payload.input);
  }
  if (item.type === "tool_call") {
    const call = asRecord(item.payload.call);
    return stringValue(call?.name) || "工具调用";
  }
  if (item.type === "command_execution") {
    return [item.payload.stdout, item.payload.stderr].filter((value) => typeof value === "string").join("");
  }
  if (item.type === "file_change") {
    return stringValue(item.payload.path) || "文件变更";
  }
  if (item.type === "error") {
    const error = asRecord(item.payload.error) ?? item.payload;
    return stringValue(error.message) || "消息执行失败";
  }
  return "";
}

function inputTextFromPayload(input: unknown): string {
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

function toolCallName(item: ThreadItem): string | null {
  const call = asRecord(item.payload.call);
  return stringValue(call?.name) || null;
}

function withThreadItemSortSeq(payload: Record<string, unknown>, sortSeq: number | null): Record<string, unknown> {
  return typeof sortSeq === "number" ? { ...payload, _sortSeq: sortSeq } : payload;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function upsertThread(state: ConversationState, thread: Thread): ConversationState {
  const threadsById = { ...state.threadsById, [thread.id]: thread };
  const threadIds = sortThreadIds(Object.values(threadsById));
  return {
    ...state,
    threadsById,
    threadIds,
  };
}

function upsertTurn(state: ConversationState, turn: Turn): ConversationState {
  const turnsById = { ...state.turnsById, [turn.id]: turn };
  const existingIds = state.turnIdsByThread[turn.thread_id] ?? [];
  const turnIds = sortTurnIds([...existingIds.map((id) => turnsById[id]).filter(isDefined), turn]);
  const activeTurnId = isActiveTurnStatus(turn.status)
    ? turn.id
    : state.activeTurnIdByThread[turn.thread_id] === turn.id
      ? null
      : state.activeTurnIdByThread[turn.thread_id] ?? null;
  return {
    ...state,
    turnsById,
    turnIdsByThread: {
      ...state.turnIdsByThread,
      [turn.thread_id]: turnIds,
    },
    activeTurnIdByThread: {
      ...state.activeTurnIdByThread,
      [turn.thread_id]: activeTurnId,
    },
    runtimeStateByThread: {
      ...state.runtimeStateByThread,
      [turn.thread_id]: runtimeStateFromTurn(turn, activeTurnId),
    },
  };
}

function upsertItem(state: ConversationState, item: ThreadItem): ConversationState {
  const itemsById = { ...state.itemsById, [item.id]: item };
  const existingIds = state.itemIdsByThread[item.thread_id] ?? [];
  const itemIds = sortItemIds([...existingIds.map((id) => itemsById[id]).filter(isDefined), item]);
  return {
    ...state,
    itemsById,
    itemIdsByThread: {
      ...state.itemIdsByThread,
      [item.thread_id]: itemIds,
    },
  };
}

function upsertMessage(state: ConversationState, message: ConversationMessage): ConversationState {
  const messagesById = { ...state.messagesById, [message.id]: message };
  const existingIds = state.messageIdsByThread[message.threadId] ?? [];
  const messageIds = sortMessageIds([
    ...existingIds.map((id) => messagesById[id]).filter(isDefined),
    message,
  ]);
  return {
    ...state,
    messagesById,
    messageIdsByThread: {
      ...state.messageIdsByThread,
      [message.threadId]: messageIds,
    },
  };
}

function removeMessage(state: ConversationState, messageId: string): ConversationState {
  const existing = state.messagesById[messageId];
  if (!existing) {
    return state;
  }
  const messagesById = { ...state.messagesById };
  delete messagesById[messageId];
  return {
    ...state,
    messagesById,
    messageIdsByThread: {
      ...state.messageIdsByThread,
      [existing.threadId]: (state.messageIdsByThread[existing.threadId] ?? []).filter((id) => id !== messageId),
    },
  };
}

function recordEvent(state: ConversationState, event: RuntimeEvent): ConversationState {
  if (hasProcessedEvent(state, event)) {
    return state;
  }
  return {
    ...state,
    processedEventIds: {
      ...state.processedEventIds,
      [event.event_id]: true,
    },
    lastSeqByThread: {
      ...state.lastSeqByThread,
      [event.thread_id]: Math.max(selectLastSeq(state, event.thread_id), event.seq),
    },
  };
}

function isActiveTurnStatus(status: TurnStatus): boolean {
  return status === "queued" || status === "in_progress";
}

function runtimeStateFromTurn(turn: Turn, activeTurnId: string | null): ConversationRuntimeState {
  if (turn.status === "failed") {
    return "failed";
  }
  if (activeTurnId) {
    return "running";
  }
  return "idle";
}

function runtimeStateFromThread(thread: Thread): ConversationRuntimeState {
  if (thread.status === "running") {
    return "running";
  }
  if (thread.status === "waiting_approval") {
    return "waiting_approval";
  }
  if (thread.status === "waiting_input") {
    return "waiting_input";
  }
  if (thread.status === "failed") {
    return "failed";
  }
  return "idle";
}

function sortThreadIds(threads: Thread[]): string[] {
  return uniqueById(threads)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .map((thread) => thread.id);
}

function sortTurnIds(turns: Turn[]): string[] {
  return uniqueById(turns)
    .sort((left, right) => (left.started_at ?? "").localeCompare(right.started_at ?? ""))
    .map((turn) => turn.id);
}

function sortItemIds(items: ThreadItem[]): string[] {
  return uniqueById(items)
    .sort((left, right) => {
      const leftSeq = left.seq_start ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.seq_start ?? Number.MAX_SAFE_INTEGER;
      if (leftSeq !== rightSeq) {
        return leftSeq - rightSeq;
      }
      return left.created_at.localeCompare(right.created_at);
    })
    .map((item) => item.id);
}

function sortMessageIds(messages: ConversationMessage[]): string[] {
  return uniqueById(messages)
    .sort((left, right) => {
      const leftSeq = messageSortSeq(left);
      const rightSeq = messageSortSeq(right);
      if (leftSeq !== rightSeq) {
        return leftSeq - rightSeq;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })
    .map((message) => message.id);
}

function messageSortSeq(message: ConversationMessage): number {
  const value = message.payload._sortSeq;
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
