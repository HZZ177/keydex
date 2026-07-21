import type {
  AgentActionEnvelope,
  AgentChatMessage,
  AgentChatMessagePayload,
  AgentCompletedPayload,
  AgentContextItem,
  A2UIDebugBlockState,
  A2UIDebugRawEvent,
  AgentErrorData,
  AgentFirstTokenData,
  CommandApprovalRequest,
  AgentGhostStats,
  AgentHistoryResponse,
  AgentPendingInput,
  AgentPendingInputEventData,
  AgentPendingInputsReorderedEventData,
  AgentMiddlewareProgressData,
  AgentReasoningData,
  AgentReasoningKind,
  AgentSession,
  AgentSessionStatus,
  AgentSessionType,
  AgentStreamActionData,
  AgentSubagentItem,
  AgentSubagentToolItem,
  AgentThreadTaskStatusData,
  AgentFileChange,
  AgentToolCall,
  AgentToolEventData,
  AgentToolProgressData,
  AgentToolStatus,
  AgentTurnStartedData,
  TurnError,
  ThreadTask,
  ThreadTaskEventData,
  ThreadTaskRun,
  ThreadTaskRunEventData,
  Workspace,
  McpElicitationRequest,
} from "@/types/protocol";
import { normalizeRuntimeErrorEnvelope } from "@/runtime/errors";
import { normalizeMessageContent } from "@/renderer/utils/messageContent";
import { shouldDisplayAgentTranscriptMessage } from "@/renderer/utils/agentTranscriptVisibility";
import {
  getA2UIAckResumeStatus,
  hasWaitingA2UIInput,
  mergeA2UIEventIntoMessages,
} from "@/renderer/pages/conversation/messages/a2ui";

export type AgentSessionRuntimeState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "cancelling"
  | "failed"
  | "closed";
const DEFAULT_MCP_ELICITATION_TITLE = "MCP 请求补充信息";

export interface AgentSessionViewState {
  sessionId: string;
  sceneId: string;
  userId: string;
  status: AgentSessionStatus;
  messages: AgentChatMessage[];
  runtimeState: AgentSessionRuntimeState;
  isStreaming: boolean;
  isCancelling: boolean;
  chatBound: boolean;
  hydrated: boolean;
  historyLoading: boolean;
  historyCursor: string | null;
  historyHasMoreOlder: boolean;
  hasUnread: boolean;
  pendingApproval: CommandApprovalRequest | null;
  pendingElicitation: McpElicitationRequest | null;
  pendingInputs: AgentPendingInput[];
  threadTasks: ThreadTask[];
  activeTask: ThreadTask | null;
  runningTaskRun: ThreadTaskRun | null;
  recentTaskRun: ThreadTaskRun | null;
  firstTokenAtMs: number | null;
  stale: boolean;
}

export interface AgentConversationState {
  sessionIds: string[];
  sessionsById: Record<string, AgentSession>;
  selectedSessionId: string | null;
  sessionStateById: Record<string, AgentSessionViewState>;
  processedEventIds: Record<string, true>;
  messageSeq: number;
}

export type AgentConversationAction =
  | { type: "sessions/set"; sessions: AgentSession[] }
  | { type: "session/upsert"; session: AgentSession }
  | { type: "session/select"; sessionId: string | null }
  | { type: "history/loaded"; sessionId: string; history: AgentHistoryResponse }
  | { type: "history/olderLoaded"; sessionId: string; history: AgentHistoryResponse }
  | { type: "tasks/loaded"; sessionId: string; tasks: ThreadTask[] }
  | {
      type: "message/addUser";
      sessionId: string;
      content: string;
      attachments?: AgentChatMessage["attachments"];
      contextItems?: AgentChatMessage["contextItems"];
      id?: string;
      timestamp?: number;
    }
  | { type: "runtime/setState"; sessionId: string; runtimeState: AgentSessionRuntimeState }
  | { type: "event/receive"; event: AgentActionEnvelope };

export function createInitialAgentConversationState(): AgentConversationState {
  return {
    sessionIds: [],
    sessionsById: {},
    selectedSessionId: null,
    sessionStateById: {},
    processedEventIds: {},
    messageSeq: 0,
  };
}

export function agentConversationReducer(
  state: AgentConversationState,
  action: AgentConversationAction,
): AgentConversationState {
  switch (action.type) {
    case "sessions/set":
      return setSessions(state, action.sessions);
    case "session/upsert":
      return upsertSession(state, action.session, { select: false });
    case "session/select":
      return selectSession(state, action.sessionId);
    case "history/loaded":
      return loadHistory(state, action.sessionId, action.history);
    case "history/olderLoaded":
      return prependHistory(state, action.sessionId, action.history);
    case "tasks/loaded":
      return loadThreadTasks(state, action.sessionId, action.tasks);
    case "message/addUser":
      return addUserMessage(state, action);
    case "runtime/setState":
      return setRuntimeState(state, action.sessionId, action.runtimeState);
    case "event/receive":
      return reduceAgentWsEvent(state, action.event);
  }
}

export function reduceAgentWsEvent(
  state: AgentConversationState,
  event: AgentActionEnvelope,
): AgentConversationState {
  const eventKey = eventIdentity(event);
  if (eventKey && state.processedEventIds[eventKey]) {
    return state;
  }

  let next = state;
  switch (event.action) {
    case "session_created":
      next = handleSessionCreated(state, event.data);
      break;
    case "bind_ok":
      next = markChatBound(state, sessionIdFromData(event.data), true);
      break;
    case "unbind_ok":
      next = markChatBound(state, sessionIdFromData(event.data), false);
      break;
    case "stream":
      next = handleStream(state, event.data as unknown as AgentStreamActionData);
      break;
    case "llm_first_token":
      next = handleFirstToken(state, event.data as unknown as AgentFirstTokenData);
      break;
    case "a2ui_stream_start":
    case "a2ui_stream_chunk":
    case "a2ui_stream_finish":
    case "a2ui_created":
    case "waiting_input":
    case "a2ui_submit_ack":
    case "a2ui_cancel_ack":
    case "a2ui_resume":
    case "a2ui_waiting_input":
      next = handleA2UIEvent(state, event.action, event.data);
      break;
    case "turn_started":
      next = handleTurnStarted(state, event.data as unknown as AgentTurnStartedData);
      break;
    case "thread_task_status":
      next = handleThreadTaskStatus(state, event.data as unknown as AgentThreadTaskStatusData);
      break;
    case "system_message":
      next = handleSystemMessage(state, event.data);
      break;
    case "user_message":
      next = handleUserMessage(state, event.data);
      break;
    case "reasoning":
      next = handleReasoning(state, event.data as unknown as AgentReasoningData);
      break;
    case "middleware_progress":
      next = handleMiddlewareProgress(state, event.data as unknown as AgentMiddlewareProgressData);
      break;
    case "pending_input_submitted":
    case "pending_input_updated":
    case "pending_input_converted":
    case "pending_input_paused":
    case "pending_input_resumed":
      next = handlePendingInputUpsert(state, event.data as unknown as AgentPendingInputEventData);
      break;
    case "pending_inputs_reordered":
      next = handlePendingInputsReordered(state, event.data as unknown as AgentPendingInputsReorderedEventData);
      break;
    case "pending_input_cancelled":
    case "pending_input_delivered":
    case "pending_input_failed":
      next = handlePendingInputTerminal(state, event.data as unknown as AgentPendingInputEventData);
      break;
    case "tool_start":
      next = handleToolStart(state, event.data as unknown as AgentToolEventData);
      break;
    case "tool_progress":
      next = handleToolProgress(state, event.data as unknown as AgentToolProgressData);
      break;
    case "tool_end":
      next = handleToolEnd(state, event.data as unknown as AgentToolEventData);
      break;
    case "approval_requested":
      next = handleApprovalRequested(state, event.data);
      break;
    case "approval_resolved":
      next = handleApprovalResolved(state, event.data);
      break;
    case "mcp_elicitation_requested":
      next = handleMcpElicitationRequested(state, event.data);
      break;
    case "mcp_elicitation_resolved":
      next = handleMcpElicitationResolved(state, event.data);
      break;
    case "subagent_start":
      next = handleSubagentStart(state, event.data);
      break;
    case "subagent_end":
      next = handleSubagentEnd(state, event.data);
      break;
    case "subagent_error":
      next = handleSubagentError(state, event.data);
      break;
    case "subagent_run_updated":
    case "subagent_runs_snapshot":
    case "subagent_run_snapshot":
    case "subagent_control_result":
      // Addressable Runtime events are consumed by SubagentRunStore, never the
      // legacy inline transcript projection above.
      next = state;
      break;
    case "completed":
      next = handleCompleted(state, event.data as unknown as AgentCompletedPayload);
      break;
    case "cancelled":
      next = handleCancelled(state, event.data);
      break;
    case "command_terminated":
      next = handleCommandTerminated(state, event.data);
      break;
    case "error":
      next = handleError(state, event.data as AgentErrorData);
      break;
    case "status":
      next = handleStatus(state, event.data);
      break;
    case "session_closed":
      next = handleSessionClosed(state, event.data);
      break;
    case "session_title_updated":
      next = handleSessionTitleUpdated(state, event.data);
      break;
    case "task_updated":
      next = handleTaskUpdated(state, event.data as unknown as ThreadTaskEventData);
      break;
    case "task_deleted":
      next = handleTaskDeleted(state, event.data as unknown as ThreadTaskEventData);
      break;
    case "task_run_started":
      next = handleTaskRunStarted(state, event.data as unknown as ThreadTaskRunEventData);
      break;
    case "task_run_finished":
      next = handleTaskRunFinished(state, event.data as unknown as ThreadTaskRunEventData);
      break;
    case "keydexWorkspaceChanged":
      next = state;
      break;
    case "pong":
    case "task_result":
      next = state;
      break;
  }

  next = markUnreadFromEvent(next, event);
  if (!eventKey) {
    return next;
  }
  return {
    ...next,
    processedEventIds: {
      ...next.processedEventIds,
      [eventKey]: true,
    },
  };
}

export function selectAgentSessions(state: AgentConversationState): AgentSession[] {
  return state.sessionIds
    .map((id) => state.sessionsById[id])
    .filter(isDefined)
    .filter((session) => !isInternalAgentSession(session));
}

export function isInternalAgentSession(session: AgentSession | null | undefined): boolean {
  return session?.visibility === "internal" || session?.agent_kind === "subagent";
}

export function selectCurrentAgentSession(state: AgentConversationState): AgentSession | null {
  return state.selectedSessionId ? state.sessionsById[state.selectedSessionId] ?? null : null;
}

export function selectAgentSessionState(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): AgentSessionViewState | null {
  return sessionId ? state.sessionStateById[sessionId] ?? null : null;
}

export function selectAgentMessages(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): AgentChatMessage[] {
  return selectAgentSessionState(state, sessionId)?.messages ?? [];
}

export function selectAgentRuntimeState(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): AgentSessionRuntimeState {
  return selectAgentSessionState(state, sessionId)?.runtimeState ?? "idle";
}

export function selectAgentThreadTasks(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): ThreadTask[] {
  return selectAgentSessionState(state, sessionId)?.threadTasks ?? [];
}

export function selectAgentPendingInputs(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): AgentPendingInput[] {
  return selectAgentSessionState(state, sessionId)?.pendingInputs ?? [];
}

export function selectAgentActiveThreadTask(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): ThreadTask | null {
  return selectAgentSessionState(state, sessionId)?.activeTask ?? null;
}

export function selectAgentThreadTaskRuns(
  state: AgentConversationState,
  sessionId = state.selectedSessionId ?? "",
): { runningTaskRun: ThreadTaskRun | null; recentTaskRun: ThreadTaskRun | null } {
  const view = selectAgentSessionState(state, sessionId);
  return {
    runningTaskRun: view?.runningTaskRun ?? null,
    recentTaskRun: view?.recentTaskRun ?? null,
  };
}

function selectSession(state: AgentConversationState, sessionId: string | null): AgentConversationState {
  const next = cloneState(state);
  next.selectedSessionId = sessionId;
  if (sessionId) {
    ensureSessionState(next, sessionId).hasUnread = false;
  }
  return next;
}

const TERMINAL_UNREAD_SESSION_ACTIONS = new Set([
  "completed",
  "cancelled",
  "command_terminated",
  "error",
  "task_result",
]);

function markUnreadFromEvent(
  state: AgentConversationState,
  event: AgentActionEnvelope,
): AgentConversationState {
  if (!TERMINAL_UNREAD_SESSION_ACTIONS.has(event.action)) {
    return state;
  }
  const sessionId = sessionIdFromData(event.data);
  if (!sessionId || sessionId === state.selectedSessionId) {
    return state;
  }
  if (isInternalAgentSession(state.sessionsById[sessionId])) {
    return state;
  }
  const currentView = state.sessionStateById[sessionId];
  if (
    currentView?.isStreaming ||
    currentView?.runtimeState === "running" ||
    currentView?.runtimeState === "waiting_approval" ||
    currentView?.runtimeState === "waiting_input" ||
    currentView?.runtimeState === "cancelling"
  ) {
    return state;
  }
  const next = cloneState(state);
  ensureSessionState(next, sessionId).hasUnread = true;
  return next;
}

function runningSessionIdsFromStatus(data: Record<string, unknown>): string[] {
  const value = data.running_sessions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        return stringValue((item as { session_id?: unknown }).session_id);
      }
      return "";
    })
    .filter(Boolean);
}

function waitingApprovalSessionIdsFromStatus(data: Record<string, unknown>): string[] {
  const value = data.waiting_approval_sessions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        return stringValue((item as { session_id?: unknown }).session_id);
      }
      return "";
    })
    .filter(Boolean);
}

function waitingInputSessionIdsFromStatus(data: Record<string, unknown>): string[] {
  const value = data.waiting_input_sessions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        return stringValue((item as { session_id?: unknown }).session_id);
      }
      return "";
    })
    .filter(Boolean);
}

function setSessions(state: AgentConversationState, sessions: AgentSession[]): AgentConversationState {
  let next = cloneState(state);
  next.sessionsById = { ...state.sessionsById };
  for (const session of sessions) {
    const merged = mergeSessionRecord(state.sessionsById[session.id], session);
    next.sessionsById[session.id] = merged;
    ensureSessionState(next, session.id, metaFromSession(merged));
  }
  next.sessionIds = sortSessionIds(Object.values(next.sessionsById));
  next.selectedSessionId = state.selectedSessionId ?? next.sessionIds[0] ?? null;
  return next;
}

function upsertSession(
  state: AgentConversationState,
  session: AgentSession,
  options: { select: boolean },
): AgentConversationState {
  const next = cloneState(state);
  const merged = mergeSessionRecord(state.sessionsById[session.id], session);
  next.sessionsById = {
    ...state.sessionsById,
    [session.id]: merged,
  };
  next.sessionIds = sortSessionIds(Object.values(next.sessionsById));
  if (options.select || !next.selectedSessionId) {
    next.selectedSessionId = session.id;
  }
  ensureSessionState(next, session.id, metaFromSession(merged));
  return next;
}

function mergeSessionRecord(existing: AgentSession | undefined, incoming: AgentSession): AgentSession {
  if (!existing) {
    return incoming;
  }
  return {
    ...incoming,
    context_window_usage: incoming.context_window_usage ?? existing.context_window_usage ?? null,
  };
}

function loadHistory(
  state: AgentConversationState,
  sessionId: string,
  history: AgentHistoryResponse,
): AgentConversationState {
  const previousView = state.sessionStateById[sessionId];
  let next = upsertSession(state, history.session, { select: true });
  next = cloneState(next);
  const view = ensureSessionState(next, sessionId, metaFromSession(history.session));
  const hydratedMessages = history.list
    .filter(shouldDisplayAgentTranscriptMessage)
    .map((payload, index) => historyMessageFromPayload(sessionId, payload, index));
  view.messages = mergeActiveLocalMessages(hydratedMessages, previousView);
  view.hydrated = true;
  view.historyLoading = false;
  view.historyCursor = history.next_cursor ?? null;
  view.historyHasMoreOlder = Boolean(history.has_more_older && history.next_cursor);
  view.hasUnread = false;
  view.stale = false;
  view.pendingInputs = normalizePendingInputs(history.pending_inputs ?? previousView?.pendingInputs ?? []);
  applyHydratedRuntimeState(view, previousView);
  return next;
}

function prependHistory(
  state: AgentConversationState,
  sessionId: string,
  history: AgentHistoryResponse,
): AgentConversationState {
  const previousView = state.sessionStateById[sessionId];
  let next = upsertSession(state, history.session, { select: true });
  next = cloneState(next);
  const view = ensureSessionState(next, sessionId, metaFromSession(history.session));
  const incoming = history.list
    .filter(shouldDisplayAgentTranscriptMessage)
    .map((payload, index) => historyMessageFromPayload(sessionId, payload, index));
  const incomingIds = new Set(incoming.map((message) => message.id));
  view.messages = [...incoming, ...view.messages.filter((message) => !incomingIds.has(message.id))];
  view.historyCursor = history.next_cursor ?? null;
  view.historyHasMoreOlder = Boolean(history.has_more_older && history.next_cursor);
  view.hasUnread = false;
  view.historyLoading = false;
  view.hydrated = true;
  view.stale = false;
  view.pendingInputs = previousView?.pendingInputs?.map(clonePendingInput) ?? view.pendingInputs;
  applyHydratedRuntimeState(view, previousView);
  return next;
}

function loadThreadTasks(
  state: AgentConversationState,
  sessionId: string,
  tasks: ThreadTask[],
): AgentConversationState {
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.threadTasks = sortThreadTasks(tasks.map(cloneThreadTask));
  view.activeTask = firstOpenThreadTask(view.threadTasks);
  if (view.runningTaskRun && !view.threadTasks.some((task) => task.id === view.runningTaskRun?.task_id)) {
    view.runningTaskRun = null;
  }
  return next;
}

function handleTaskUpdated(state: AgentConversationState, data: ThreadTaskEventData): AgentConversationState {
  const task = threadTaskFromData(data.task);
  if (!task) {
    return state;
  }
  const sessionId = stringValue(data.session_id) || task.session_id;
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  upsertThreadTask(view, task);
  return next;
}

function handleTaskDeleted(state: AgentConversationState, data: ThreadTaskEventData): AgentConversationState {
  const taskId = stringValue(data.task_id) || stringValue(data.task?.id);
  const sessionId = stringValue(data.session_id) || stringValue(data.task?.session_id);
  if (!sessionId || !taskId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.threadTasks = view.threadTasks.filter((task) => task.id !== taskId);
  if (view.activeTask?.id === taskId) {
    view.activeTask = firstOpenThreadTask(view.threadTasks);
  }
  if (view.runningTaskRun?.task_id === taskId) {
    view.runningTaskRun = null;
  }
  return next;
}

function handleTaskRunStarted(state: AgentConversationState, data: ThreadTaskRunEventData): AgentConversationState {
  const run = threadTaskRunFromData(data.run);
  const sessionId = stringValue(data.session_id) || run?.session_id || "";
  if (!sessionId || !run) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const task = threadTaskFromData(data.task);
  if (task) {
    upsertThreadTask(view, task);
  }
  view.runningTaskRun = cloneThreadTaskRun(run);
  view.recentTaskRun = cloneThreadTaskRun(run);
  return next;
}

function handleTaskRunFinished(state: AgentConversationState, data: ThreadTaskRunEventData): AgentConversationState {
  const run = threadTaskRunFromData(data.run);
  const sessionId = stringValue(data.session_id) || run?.session_id || "";
  if (!sessionId || !run) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const task = threadTaskFromData(data.task);
  if (task) {
    upsertThreadTask(view, task);
  }
  if (view.runningTaskRun?.id === run.id) {
    view.runningTaskRun = null;
  }
  view.recentTaskRun = cloneThreadTaskRun(run);
  return next;
}

function mergeActiveLocalMessages(
  hydratedMessages: AgentChatMessage[],
  previousView?: AgentSessionViewState,
): AgentChatMessage[] {
  const hydratedWithA2UIDebug = mergeHydratedA2UIDebugMessages(hydratedMessages, previousView);
  const hydratedWithStableA2UI = preserveStableLocalA2UIMessages(hydratedWithA2UIDebug, previousView);
  if (!previousView || !isActiveRuntimeState(previousView.runtimeState)) {
    return hydratedWithStableA2UI;
  }

  const merged = [...hydratedWithStableA2UI];
  for (const message of previousView.messages) {
    if (!shouldPreserveActiveLocalMessage(message)) {
      continue;
    }
    if (merged.some((candidate) => isEquivalentHydratedMessage(candidate, message))) {
      continue;
    }
    merged.push(cloneMessage(message));
  }
  return merged;
}

function preserveStableLocalA2UIMessages(
  hydratedMessages: AgentChatMessage[],
  previousView?: AgentSessionViewState,
): AgentChatMessage[] {
  if (!previousView) {
    return hydratedMessages;
  }
  const localA2UIMessages = previousView.messages.filter((message) => message.role === "a2ui");
  if (!localA2UIMessages.length) {
    return hydratedMessages;
  }
  return hydratedMessages.map((message) => {
    if (message.role !== "a2ui") {
      return message;
    }
    const local = findMatchingLocalA2UIMessage(message, localA2UIMessages);
    if (!local) {
      return message;
    }
    return {
      ...message,
      id: local.id,
      timestamp: local.timestamp,
      hydratedFromHistory: shouldPreserveLiveA2UIPlayback(local)
        ? local.hydratedFromHistory
        : message.hydratedFromHistory,
      a2ui: message.a2ui ?? local.a2ui,
      a2uiDebug: message.a2uiDebug ?? local.a2uiDebug,
      contentType: message.contentType ?? local.contentType ?? "a2ui",
      content_type: message.content_type ?? local.content_type ?? "a2ui",
    };
  });
}

function mergeHydratedA2UIDebugMessages(
  hydratedMessages: AgentChatMessage[],
  previousView?: AgentSessionViewState,
): AgentChatMessage[] {
  if (!previousView) {
    return hydratedMessages;
  }
  const localA2UIMessages = previousView.messages.filter((message) => message.role === "a2ui" && message.a2uiDebug);
  if (!localA2UIMessages.length) {
    return hydratedMessages;
  }
  return hydratedMessages.map((message) => {
    if (message.role !== "a2ui" || !message.a2uiDebug) {
      return message;
    }
    const local = findMatchingLocalA2UIMessage(message, localA2UIMessages);
    if (!local?.a2uiDebug || !isRicherA2UIDebug(local.a2uiDebug, message.a2uiDebug)) {
      return message;
    }
    return {
      ...message,
      a2ui: message.a2ui ?? local.a2ui,
      a2uiDebug: mergeA2UIDebugForHydration(message.a2uiDebug, local.a2uiDebug),
      contentType: message.contentType ?? "a2ui",
      content_type: message.content_type ?? "a2ui",
    };
  });
}

function findMatchingLocalA2UIMessage(
  hydrated: AgentChatMessage,
  localMessages: AgentChatMessage[],
): AgentChatMessage | undefined {
  const streamId = a2UIStreamId(hydrated);
  return streamId
    ? localMessages.find((candidate) => a2UIStreamId(candidate) === streamId)
    : undefined;
}

function a2UIStreamId(message: AgentChatMessage): string {
  return stringValue(message.a2ui?.stream_id) || stringValue(message.a2uiDebug?.streamId);
}

function shouldPreserveLiveA2UIPlayback(message: AgentChatMessage): boolean {
  if (message.hydratedFromHistory === true) {
    return false;
  }
  const debug = message.a2uiDebug;
  if (!debug) {
    return false;
  }
  return (
    Number(debug.chunkCount ?? 0) > 0 ||
    stringValue(debug.argsBuffer).length > 0 ||
    (debug.rawEvents ?? []).some((event) => stringValue(event.action).startsWith("a2ui_stream_"))
  );
}

function isRicherA2UIDebug(local: A2UIDebugBlockState, hydrated: A2UIDebugBlockState): boolean {
  return a2UIDebugRichness(local) > a2UIDebugRichness(hydrated);
}

function a2UIDebugRichness(debug: A2UIDebugBlockState): number {
  return Number(debug.chunkCount ?? 0) * 10_000
    + (debug.rawEvents?.length ?? 0) * 100
    + stringValue(debug.argsBuffer).length;
}

function mergeA2UIDebugForHydration(
  hydrated: A2UIDebugBlockState,
  local: A2UIDebugBlockState,
): A2UIDebugBlockState {
  const localBufferIsRicher = stringValue(local.argsBuffer).length > stringValue(hydrated.argsBuffer).length;
  const rawEvents = mergeA2UIDebugRawEvents(local.rawEvents ?? [], hydrated.rawEvents ?? []);
  return {
    ...hydrated,
    argsBuffer: localBufferIsRicher ? local.argsBuffer : hydrated.argsBuffer,
    argsTextLength: Math.max(Number(hydrated.argsTextLength ?? 0), Number(local.argsTextLength ?? 0)),
    chunkCount: Math.max(Number(hydrated.chunkCount ?? 0), Number(local.chunkCount ?? 0)),
    finishReason: hydrated.finishReason ?? local.finishReason,
    jsonParseStatus: localBufferIsRicher ? local.jsonParseStatus : hydrated.jsonParseStatus,
    latestChunk: local.latestChunk ?? hydrated.latestChunk,
    parseError: hydrated.parseError ?? local.parseError,
    parsedArgs: local.parsedArgs ?? hydrated.parsedArgs,
    rawEvents,
    updatedAt: Math.max(Number(hydrated.updatedAt ?? 0), Number(local.updatedAt ?? 0)),
  };
}

function mergeA2UIDebugRawEvents(
  localEvents: A2UIDebugRawEvent[],
  hydratedEvents: A2UIDebugRawEvent[],
): A2UIDebugRawEvent[] {
  const merged: A2UIDebugRawEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...localEvents, ...hydratedEvents]) {
    const key = a2UIRawEventKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      ...event,
      data: { ...event.data },
    });
  }
  return merged.sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0));
}

function a2UIRawEventKey(event: A2UIDebugRawEvent): string {
  if (event.id && !event.id.startsWith("a2ui-event:")) {
    return event.id;
  }
  return `${event.action}:${event.timestamp}:${stableJsonStringify(event.data)}`;
}

function shouldPreserveActiveLocalMessage(message: AgentChatMessage): boolean {
  if (!shouldDisplayAgentTranscriptMessage(message)) {
    return false;
  }
  if (message.id.startsWith("hist:")) {
    return false;
  }
  if (message.role === "user") {
    return true;
  }
  return Boolean(
    message.streaming ||
      message.status === "running" ||
      message.status === "streaming" ||
      message.status === "pending",
  );
}

function isEquivalentHydratedMessage(candidate: AgentChatMessage, localMessage: AgentChatMessage): boolean {
  if (candidate.id === localMessage.id) {
    return true;
  }
  if (
    localMessage.messageEventId &&
    candidate.messageEventId &&
    candidate.messageEventId === localMessage.messageEventId
  ) {
    return true;
  }
  if (candidate.role !== localMessage.role) {
    return false;
  }
  const localCompressionNoticeId = compressionNoticeIdFromMessage(localMessage);
  if (
    localCompressionNoticeId &&
    compressionNoticeIdFromMessage(candidate) === localCompressionNoticeId
  ) {
    return true;
  }
  if (localMessage.role === "a2ui") {
    const localStreamId = a2UIStreamId(localMessage);
    return Boolean(localStreamId && a2UIStreamId(candidate) === localStreamId);
  }
  if (localMessage.role === "user") {
    return (
      candidate.content === localMessage.content &&
      Boolean(candidate.messageEventId || candidate.id.startsWith("hist:"))
    );
  }
  if (localMessage.role === "approval") {
    return Boolean(localMessage.approval?.id && candidate.approval?.id === localMessage.approval.id);
  }
  if (localMessage.runId && candidate.runId === localMessage.runId) {
    return true;
  }
  if (localMessage.toolCallId && candidate.toolCallId === localMessage.toolCallId) {
    return true;
  }
  return false;
}

function applyHydratedRuntimeState(view: AgentSessionViewState, previousView?: AgentSessionViewState): void {
  const hasStreamingMessage = view.messages.some((message) => Boolean(message.streaming));
  const pendingApproval = pendingApprovalForHydratedView(view.messages, previousView);
  const pendingElicitation = pendingElicitationForHydratedView(view.messages, previousView);
  const pendingA2UIInput = hasWaitingA2UIInput(view.messages);
  let runtimeState = pendingApproval || pendingElicitation
    ? "waiting_approval"
    : pendingA2UIInput
      ? "waiting_input"
      : hasStreamingMessage
        ? "running"
        : runtimeStateFromSessionStatus(view.status);

  if (runtimeState === "idle" && previousView && isActiveRuntimeState(previousView.runtimeState)) {
    runtimeState = previousView.runtimeState === "waiting_approval" ? runtimeState : previousView.runtimeState;
  }

  view.runtimeState = runtimeState;
  view.pendingApproval = pendingApproval;
  view.pendingElicitation = pendingElicitation;
  view.isStreaming = hasStreamingMessage || (runtimeState === "running" && previousView?.isStreaming === true);
  view.isCancelling = runtimeState === "cancelling";
}

function addUserMessage(
  state: AgentConversationState,
  action: Extract<AgentConversationAction, { type: "message/addUser" }>,
): AgentConversationState {
  const next = cloneState(state);
  const view = ensureSessionState(next, action.sessionId);
  view.messages.push({
    id: action.id ?? nextMessageId(next, "user", action.sessionId),
    sessionId: action.sessionId,
    role: "user",
    content: action.content,
    attachments: action.attachments,
    contextItems: action.contextItems,
    timestamp: action.timestamp ?? Date.now(),
  });
  next.selectedSessionId = action.sessionId;
  view.hasUnread = false;
  return next;
}

function setRuntimeState(
  state: AgentConversationState,
  sessionId: string,
  runtimeState: AgentSessionRuntimeState,
): AgentConversationState {
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.runtimeState = runtimeState;
  view.isStreaming = runtimeState === "running";
  view.isCancelling = runtimeState === "cancelling";
  return next;
}

function handleSessionCreated(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const session = sessionFromData(data);
  if (!session) {
    const sessionId = sessionIdFromData(data);
    return sessionId ? selectSessionId(state, sessionId) : state;
  }
  return upsertSession(state, session, { select: true });
}

function selectSessionId(state: AgentConversationState, sessionId: string): AgentConversationState {
  const next = cloneState(state);
  ensureSessionState(next, sessionId);
  next.selectedSessionId = sessionId;
  return next;
}

function markChatBound(
  state: AgentConversationState,
  sessionId: string,
  chatBound: boolean,
): AgentConversationState {
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.chatBound = chatBound;
  return next;
}

function handleTurnStarted(state: AgentConversationState, data: AgentTurnStartedData): AgentConversationState {
  const sessionId = stringValue(data.session_id);
  const turnIndex = numberValue(data.turn_index);
  if (!sessionId || turnIndex === null) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.firstTokenAtMs = null;
  const traceId = nullableString(data.trace_id);
  const threadTask = asRecord(data.thread_task);
  const runtimeParams = asRecord(data.runtime_params);
  const id = `turn:${sessionId}:${turnIndex}`;
  const metadata = {
    kind: "turn_started",
    source: stringValue(data.source) || "user",
    source_label: nullableString(data.source_label) ?? "",
    thread_task: threadTask,
    runtime_params: runtimeParams ?? (threadTask ? { thread_task: threadTask } : undefined),
  };
  const patch: Partial<AgentChatMessage> = {
    role: "turn",
    content: "",
    timestamp: timestampFromData(data),
    turnIndex,
    traceId: traceId ?? undefined,
    metadata,
    streaming: false,
    status: "completed",
  };
  const existing = view.messages.find(
    (message) => message.id === id || (message.role === "turn" && message.turnIndex === turnIndex),
  );
  if (existing) {
    Object.assign(existing, patch);
  } else {
    view.messages.push({
      id,
      sessionId,
      role: "turn",
      content: "",
      timestamp: patch.timestamp ?? Date.now(),
      turnIndex,
      traceId: traceId ?? undefined,
      metadata,
      streaming: false,
      status: "completed",
    });
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleThreadTaskStatus(
  state: AgentConversationState,
  data: AgentThreadTaskStatusData,
): AgentConversationState {
  const sessionId = stringValue(data.session_id);
  const turnIndex = numberValue(data.turn_index);
  if (!sessionId || turnIndex === null) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const task = threadTaskFromData(data.task);
  if (task) {
    upsertThreadTask(view, task);
  }
  const taskId = nullableString(data.task_id) ?? task?.id ?? "";
  const runId = nullableString(data.run_id) ?? task?.current_run_id ?? "";
  const status = stringValue(data.status) || task?.status || "";
  const summary = stringValue(data.summary);
  const id = ["thread-task-status", sessionId, turnIndex, runId || taskId || status].filter(Boolean).join(":");
  const uiPayload = asRecord(data.ui_payload) ?? { task: data.task ?? task ?? null };
  const toolParams = asRecord(data.payload) ?? {};
  const metadata = {
    kind: "thread_task_status",
    task_id: taskId || undefined,
    run_id: runId || undefined,
    type: stringValue(data.type) || task?.type || "goal",
    status,
    summary,
  };
  const patch: Partial<AgentChatMessage> = {
    role: "thread_task",
    content: summary || status || "目标状态已更新",
    timestamp: timestampFromData(data),
    turnIndex,
    traceId: nullableString(data.trace_id) ?? undefined,
    toolName: "update_thread_task",
    toolParams,
    uiPayload,
    status: "completed",
    metadata,
    streaming: false,
  };
  const existing = view.messages.find((message) => message.id === id);
  if (existing) {
    Object.assign(existing, patch);
  } else {
    view.messages.push({
      id,
      sessionId,
      role: "thread_task",
      content: patch.content ?? "",
      timestamp: patch.timestamp ?? Date.now(),
      turnIndex,
      traceId: patch.traceId,
      toolName: "update_thread_task",
      toolParams,
      uiPayload,
      status: "completed",
      metadata,
      streaming: false,
    });
  }
  view.isStreaming = hasStreamingMessage(view);
  return next;
}

function handleStream(state: AgentConversationState, data: AgentStreamActionData): AgentConversationState {
  const sessionId = data.session_id;
  const content = stringValue(data.content) || stringValue(data.text);
  if (!sessionId || !content) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const eventTimestamp = timestampFromData(data);
  const turnIndex = numberValue(data.turn_index);
  const traceId = stringValue(data.trace_id);
  if (data.is_subagent && data.subagent_id) {
    const message = ensureSubagentMessage(next, view, data.subagent_id, {
      subagentName: data.subagent_name ?? "",
      streaming: true,
      timestamp: eventTimestamp,
    });
    message.content += content;
    appendSubagentTextItem(next, message, content, eventTimestamp);
  } else {
    const last = view.messages[view.messages.length - 1];
    const message =
      last?.role === "assistant" && last.streaming && isSameBusinessTurn(last, turnIndex) ? last : undefined;
    if (message) {
      message.content += content;
      applyTurnFields(message, turnIndex, traceId);
    } else {
      closeTopLevelTextStreams(view, eventTimestamp);
      view.messages.push({
        id: nextMessageId(next, "assistant", sessionId),
        sessionId,
        role: "assistant",
        content,
        timestamp: eventTimestamp,
        turnIndex,
        ...(traceId ? { traceId } : {}),
        streaming: true,
        status: "streaming",
      });
    }
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleFirstToken(state: AgentConversationState, data: AgentFirstTokenData): AgentConversationState {
  const sessionId = data.session_id || state.selectedSessionId || "";
  const firstTokenAtMs = nonNegativeNumber(data.first_token_at_ms);
  if (!sessionId || firstTokenAtMs === null) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  if (view.firstTokenAtMs === null || firstTokenAtMs < view.firstTokenAtMs) {
    view.firstTokenAtMs = Math.trunc(firstTokenAtMs);
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleA2UIEvent(
  state: AgentConversationState,
  action: string,
  data: Record<string, unknown>,
): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const eventTimestamp = timestampFromData(data);
  if (action === "a2ui_stream_start") {
    closeTopLevelTextStreams(view, eventTimestamp);
  }
  const pendingInteractions = Array.isArray(data.pending_interactions) ? data.pending_interactions : [];
  let result = action === "a2ui_waiting_input" && pendingInteractions.length > 0
    ? {
        action: null,
        created: false,
        debug: null,
        message: null,
        messages: view.messages,
      }
    : mergeA2UIEventIntoMessages(view.messages, action, data, {
        idFactory: () => nextMessageId(next, "a2ui", sessionId),
        now: eventTimestamp,
        sessionId,
      });
  for (const pendingInteraction of pendingInteractions) {
    const pendingRecord = asRecord(pendingInteraction);
    result = mergeA2UIEventIntoMessages(result.messages, "waiting_input", {
      session_id: sessionId,
      interaction: pendingInteraction,
      interaction_id: pendingRecord ? stringValue(pendingRecord.interaction_id) : "",
    }, {
      idFactory: () => nextMessageId(next, "a2ui", sessionId),
      now: eventTimestamp,
      sessionId,
    });
  }
  if (!result.message || !result.debug) {
    if (action === "a2ui_waiting_input") {
      applyWaitingInputRuntimeState(next, view, sessionId);
      return next;
    }
    return state;
  }
  view.messages = result.messages;
  result.message.sessionId = sessionId;
  applyTurnFields(result.message, numberValue(data.turn_index), stringValue(data.trace_id));
  const activeStreamFrame = action === "a2ui_stream_start" || action === "a2ui_stream_chunk";
  const shouldPreserveWaitingInput =
    !activeStreamFrame &&
    hasWaitingA2UIInput(view.messages) &&
    (action === "a2ui_created" || view.runtimeState === "waiting_input");
  if (shouldPreserveWaitingInput) {
    applyWaitingInputRuntimeState(next, view, sessionId);
    return next;
  }
  if (action === "a2ui_stream_start" || action === "a2ui_stream_chunk") {
    view.isStreaming = true;
    markTurnInProgress(view);
    updateSessionStatus(next, sessionId, "running");
  } else if (action === "waiting_input" || action === "a2ui_waiting_input") {
    applyWaitingInputRuntimeState(next, view, sessionId);
  } else if (action === "a2ui_submit_ack" || action === "a2ui_cancel_ack") {
    applyA2UIAckRuntimeState(next, view, sessionId, getA2UIAckResumeStatus(data));
  } else if (action === "a2ui_resume") {
    applyA2UIResumeRuntimeState(next, view, sessionId, stringValue(data.resume_status));
  } else {
    view.isStreaming = hasStreamingMessage(view);
    markTurnInProgress(view);
    updateSessionStatus(next, sessionId, "running");
  }
  return next;
}

function closeAllMessageStreams(view: AgentSessionViewState): void {
  for (const message of view.messages) {
    if (message.streaming) {
      message.streaming = false;
      if (message.status === "streaming") {
        message.status = undefined;
      }
    }
    if (message.role === "subagent") {
      closeSubagentTextStreams(message);
    }
  }
}

function applyA2UIAckRuntimeState(
  state: AgentConversationState,
  view: AgentSessionViewState,
  sessionId: string,
  resumeStatus: string | undefined,
): void {
  const normalized = resumeStatus?.toLowerCase();
  if (normalized === "deferred" || hasWaitingA2UIInput(view.messages)) {
    view.runtimeState = "waiting_input";
    view.isStreaming = false;
    view.isCancelling = false;
    updateSessionStatus(state, sessionId, "waiting_input");
    return;
  }
  if (normalized === "failed") {
    if (hasWaitingA2UIInput(view.messages)) {
      view.runtimeState = "waiting_input";
      view.isStreaming = false;
      view.isCancelling = false;
      updateSessionStatus(state, sessionId, "waiting_input");
      return;
    }
    view.runtimeState = "failed";
    view.isStreaming = false;
    view.isCancelling = false;
    updateSessionStatus(state, sessionId, "failed");
    return;
  }
  if (normalized === "succeeded" || normalized === "not_started") {
    settleA2UITerminalRuntimeState(state, view, sessionId);
    return;
  }
  view.runtimeState = "running";
  view.isStreaming = true;
  view.isCancelling = false;
  updateSessionStatus(state, sessionId, "running");
}

function applyA2UIResumeRuntimeState(
  state: AgentConversationState,
  view: AgentSessionViewState,
  sessionId: string,
  resumeStatus: string,
): void {
  const normalized = resumeStatus.toLowerCase();
  if (normalized === "deferred") {
    view.runtimeState = "waiting_input";
    view.isStreaming = false;
    view.isCancelling = false;
    updateSessionStatus(state, sessionId, "waiting_input");
    return;
  }
  if (normalized === "failed") {
    if (hasWaitingA2UIInput(view.messages)) {
      view.runtimeState = "waiting_input";
      view.isStreaming = false;
      view.isCancelling = false;
      updateSessionStatus(state, sessionId, "waiting_input");
      return;
    }
    view.runtimeState = "failed";
    view.isStreaming = false;
    view.isCancelling = false;
    updateSessionStatus(state, sessionId, "failed");
    return;
  }
  if (normalized === "succeeded") {
    settleA2UITerminalRuntimeState(state, view, sessionId);
    return;
  }
  if (normalized === "started") {
    if (hasWaitingA2UIInput(view.messages)) {
      view.runtimeState = "waiting_input";
      view.isStreaming = false;
      view.isCancelling = false;
      updateSessionStatus(state, sessionId, "waiting_input");
      return;
    }
    view.runtimeState = "running";
    view.isStreaming = true;
    view.isCancelling = false;
    updateSessionStatus(state, sessionId, "running");
  }
}

function settleA2UITerminalRuntimeState(
  state: AgentConversationState,
  view: AgentSessionViewState,
  sessionId: string,
): void {
  closeAllMessageStreams(view);
  view.isCancelling = false;
  if (hasWaitingA2UIInput(view.messages)) {
    view.runtimeState = "waiting_input";
    view.isStreaming = false;
    updateSessionStatus(state, sessionId, "waiting_input");
    return;
  }
  view.runtimeState = "idle";
  view.isStreaming = false;
  updateSessionStatus(state, sessionId, "active");
}

function updateSessionStatus(
  state: AgentConversationState,
  sessionId: string,
  status: AgentSessionStatus,
): void {
  const view = state.sessionStateById[sessionId];
  if (view) {
    view.status = status;
  }
  const existing = state.sessionsById[sessionId];
  if (!existing) {
    return;
  }
  state.sessionsById = {
    ...state.sessionsById,
    [sessionId]: { ...existing, status },
  };
}

function handleSystemMessage(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  const content = stringValue(data.content) || stringValue(data.text);
  if (!sessionId || !content) {
    return state;
  }
  if (isInternalTranscriptContextMessage(data)) {
    return state;
  }
  const messageEventId = stringValue(data.message_event_id) || stringValue(data.event_id) || stringValue(data.id);
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  if (messageEventId && view.messages.some((message) => message.messageEventId === messageEventId)) {
    return state;
  }
  const compression = asRecord(data.compression);
  view.messages.push({
    id: messageEventId ? `system:${sessionId}:${messageEventId}` : nextMessageId(next, "system", sessionId),
    sessionId,
    messageEventId: messageEventId || undefined,
    turnIndex: numberValue(data.turn_index),
    role: "system",
    content,
    timestamp: timestampFromData(data),
    metadata: compression ? { compression } : undefined,
    streaming: false,
  });
  view.isStreaming = hasStreamingMessage(view);
  return next;
}

function isInternalTranscriptContextMessage(data: Record<string, unknown>): boolean {
  const source = stringValue(data.source);
  const metadata = asRecord(data.metadata);
  const metadataSource = metadata ? stringValue(metadata.source) : "";
  const compact = metadata ? asRecord(metadata.keydex_context_compression) : null;
  const content = (stringValue(data.content) || stringValue(data.text)).trim();
  return (
    isContextCompressionProtocolContent(content) ||
    stringValue(compact?.kind) === "summary" ||
    metadata?.is_compact_summary === true ||
    metadata?.isCompactSummary === true ||
    source === "message_context_item" ||
    source === "message_injection" ||
    source === "skill_activation" ||
    metadataSource === "message_context_item" ||
    metadataSource === "message_injection" ||
    metadataSource === "skill_activation"
  );
}

function isContextCompressionProtocolContent(content: string): boolean {
  return content.startsWith("<keydex_context_compression");
}

function handleMiddlewareProgress(
  state: AgentConversationState,
  data: AgentMiddlewareProgressData,
): AgentConversationState {
  if (isLLMRetryProgress(data)) {
    return handleLLMRetryProgress(state, data);
  }
  if (data.middleware !== "ContextCompressionMiddleware") {
    return state;
  }
  const stage = stringValue(data.stage);
  if (!isVisibleCompressionProgressStage(stage)) {
    return state;
  }
  const sessionId = stringValue(data.session_id) || stringValue(data.active_session_id) || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }

  const noticeId = contextCompressionNoticeId(data, sessionId);
  const metadata = {
    compression: {
      kind: "context_compression",
      stage,
      mode: contextCompressionMode(data, stage),
      notice_id: noticeId,
      reason: data.reason ?? null,
      compression_reason: data.compression_reason ?? null,
    },
  };
  const patch: Partial<AgentChatMessage> = {
    role: "system",
    content: contextCompressionContent(stage),
    timestamp: timestampFromData(data),
    metadata,
    streaming: false,
    status: contextCompressionStatus(stage),
  };

  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const existingIndex = view.messages.findIndex(
    (message) => compressionNoticeIdFromMessage(message) === noticeId,
  );
  if (existingIndex >= 0) {
    Object.assign(view.messages[existingIndex], patch);
    view.messages = view.messages.filter(
      (message, index) => index === existingIndex || compressionNoticeIdFromMessage(message) !== noticeId,
    );
  } else {
    view.messages.push({
      id: `compression:${sessionId}:${noticeId}`,
      sessionId,
      role: "system",
      content: patch.content ?? "",
      timestamp: patch.timestamp ?? Date.now(),
      metadata,
      streaming: false,
      status: patch.status,
    });
  }
  view.isStreaming = hasStreamingMessage(view);
  return next;
}

function handleLLMRetryProgress(
  state: AgentConversationState,
  data: AgentMiddlewareProgressData,
): AgentConversationState {
  const sessionId = stringValue(data.session_id) || stringValue(data.active_session_id) || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }
  const stage = stringValue(data.stage) || "retrying";
  const noticeId = llmRetryNoticeId(data, sessionId);
  const metadata = {
    retry: {
      kind: "llm_retry",
      stage,
      notice_id: noticeId,
      attempt: numberValue(data.attempt),
      retry_index: llmRetryIndex(data),
      max_retries: llmMaxRetries(data),
      max_attempts: numberValue(data.max_attempts),
      retry_after_ms: numberValue(data.retry_after_ms),
      gateway_trace_id: stringValue(data.gateway_trace_id),
      error: stringValue(data.error),
      error_type: stringValue(data.error_type),
    },
  };
  const patch: Partial<AgentChatMessage> = {
    role: "system",
    content: llmRetryContent(data, stage),
    timestamp: timestampFromData(data),
    metadata,
    streaming: false,
    status: llmRetryStatus(stage),
  };

  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const existing = view.messages.find((message) => {
    const retry = asRecord(message.metadata?.retry);
    return stringValue(retry?.notice_id) === noticeId;
  });
  if (existing) {
    Object.assign(existing, patch);
  } else {
    view.messages.push({
      id: `llm-retry:${sessionId}:${noticeId}`,
      sessionId,
      role: "system",
      content: patch.content ?? "",
      timestamp: patch.timestamp ?? Date.now(),
      metadata,
      streaming: false,
      status: patch.status,
    });
  }
  if (stage === "retrying") {
    view.isStreaming = true;
    markTurnInProgress(view);
  } else {
    view.isStreaming = hasStreamingMessage(view);
  }
  return next;
}

function handleApprovalRequested(
  state: AgentConversationState,
  data: Record<string, unknown>,
): AgentConversationState {
  const approval = approvalFromData(data);
  const sessionId = approval?.session_id || sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId || !approval) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  upsertApprovalMessage(next, view, approval);
  applyApprovalStateToCommandMessage(view, approval);
  view.pendingApproval = firstPendingApproval(view.messages);
  view.runtimeState = view.pendingApproval ? "waiting_approval" : "running";
  view.isStreaming = !view.pendingApproval;
  view.isCancelling = false;
  const existing = next.sessionsById[sessionId];
  if (existing) {
    next.sessionsById = {
      ...next.sessionsById,
      [sessionId]: { ...existing, status: view.pendingApproval ? "waiting_approval" : "running" },
    };
  }
  return next;
}

function handleApprovalResolved(
  state: AgentConversationState,
  data: Record<string, unknown>,
): AgentConversationState {
  const approval = approvalFromData(data);
  const sessionId = approval?.session_id || sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId || !approval) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  upsertApprovalMessage(next, view, approval);
  applyApprovalStateToCommandMessage(view, approval);
  view.pendingApproval = firstPendingApproval(view.messages);
  view.runtimeState = view.pendingApproval ? "waiting_approval" : "running";
  view.isStreaming = !view.pendingApproval;
  view.isCancelling = false;
  const existing = next.sessionsById[sessionId];
  if (existing) {
    next.sessionsById = {
      ...next.sessionsById,
      [sessionId]: { ...existing, status: view.pendingApproval ? "waiting_approval" : "running" },
    };
  }
  return next;
}

function handleMcpElicitationRequested(
  state: AgentConversationState,
  data: Record<string, unknown>,
): AgentConversationState {
  const elicitation = elicitationFromData(data, state.selectedSessionId ?? "");
  const sessionId = elicitation?.session_id || sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId || !elicitation) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  upsertElicitationMessage(next, view, { ...elicitation, status: "pending" });
  view.pendingElicitation = { ...elicitation, status: "pending" };
  view.runtimeState = "waiting_approval";
  view.isStreaming = false;
  view.isCancelling = false;
  const existing = next.sessionsById[sessionId];
  if (existing) {
    next.sessionsById = {
      ...next.sessionsById,
      [sessionId]: { ...existing, status: "waiting_approval" },
    };
  }
  return next;
}

function handleMcpElicitationResolved(
  state: AgentConversationState,
  data: Record<string, unknown>,
): AgentConversationState {
  const source = asRecord(data.elicitation) ?? data;
  const elicitationId = stringValue(source.elicitation_id) || stringValue(source.id);
  const fallbackSessionId =
    sessionIdFromData(data) ||
    sessionIdForPendingElicitation(state, elicitationId) ||
    state.selectedSessionId ||
    "";
  const elicitation = elicitationFromData(data, fallbackSessionId);
  const sessionId = elicitation?.session_id || sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId || !elicitation) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  upsertElicitationMessage(next, view, elicitation);
  if (view.pendingElicitation?.elicitation_id === elicitation.elicitation_id) {
    view.pendingElicitation = null;
  } else {
    view.pendingElicitation = firstPendingElicitation(view.messages);
  }
  view.runtimeState = view.pendingApproval || view.pendingElicitation ? "waiting_approval" : "running";
  view.isStreaming = !view.pendingApproval && !view.pendingElicitation;
  view.isCancelling = false;
  const existing = next.sessionsById[sessionId];
  if (existing) {
    next.sessionsById = {
      ...next.sessionsById,
      [sessionId]: { ...existing, status: view.runtimeState === "waiting_approval" ? "waiting_approval" : "running" },
    };
  }
  return next;
}

function handleReasoning(
  state: AgentConversationState,
  data: AgentReasoningData,
): AgentConversationState {
  const sessionId = data.session_id;
  const kind = data.kind ?? "status_update";
  if (!sessionId) {
    return state;
  }

  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const eventTimestamp = timestampFromData(data);
  const turnIndex = numberValue(data.turn_index);
  const traceId = stringValue(data.trace_id);
  if (data.done) {
    closeReasoningStream(view, kind, eventTimestamp, nonNegativeNumber(data.duration_ms));
    view.isStreaming = hasStreamingMessage(view);
    markTurnInProgress(view);
    return next;
  }

  const content = stringValue(data.content) || stringValue(data.text);
  if (!content) {
    return next;
  }
  const last = view.messages[view.messages.length - 1];
  if (last?.role === "reasoning" && last.reasoningKind === kind && last.streaming && isSameBusinessTurn(last, turnIndex)) {
    last.content += content;
    applyTurnFields(last, turnIndex, traceId);
  } else {
    closeTopLevelTextStreams(view, eventTimestamp);
    view.messages.push({
      id: nextMessageId(next, "reasoning", sessionId),
      sessionId,
      role: "reasoning",
      content,
      reasoningKind: kind,
      timestamp: eventTimestamp,
      turnIndex,
      ...(traceId ? { traceId } : {}),
      streaming: true,
      status: "streaming",
    });
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleToolStart(state: AgentConversationState, data: AgentToolEventData): AgentConversationState {
  const sessionId = data.session_id ?? state.selectedSessionId ?? "";
  if (!sessionId || !data.run_id) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const toolName = toolNameFromData(data);
  if (isThreadTaskToolName(toolName)) {
    return state;
  }
  if (data.is_subagent && data.subagent_id) {
    const subagent = ensureSubagentMessage(next, view, data.subagent_id, {
      subagentName: data.subagent_name ?? "",
      streaming: true,
      timestamp: timestampFromData(data),
    });
    closeSubagentTextStreams(subagent);
    const tool = findSubagentTool(subagent, data.run_id);
    if (tool) {
      Object.assign(tool, toolCallFromStart(data, toolName));
    } else {
      const toolItem = {
        ...toolCallFromStart(data, toolName),
        id: nextMessageId(next, "subagent-tool", sessionId),
        type: "tool" as const,
        timestamp: timestampFromData(data),
      };
      subagent.subagentToolCalls = [...(subagent.subagentToolCalls ?? []), toolItem];
      subagent.subagentItems = [...(subagent.subagentItems ?? []), toolItem];
    }
    subagent.streaming = true;
  } else {
    closeTopLevelTextStreams(view, timestampFromData(data));
    const existing =
      view.messages.find((message) => message.role === "tool" && message.runId === data.run_id) ??
      findMatchingProgressTool(view, data, toolName);
    const patch = toolCallFromStart(data, toolName);
    if (existing) {
      Object.assign(existing, patch);
      applyTurnFields(existing, numberValue(data.turn_index), stringValue(data.trace_id));
    } else {
      view.messages.push({
        id: nextMessageId(next, "tool", sessionId),
        sessionId,
        role: "tool",
        content: "",
        timestamp: timestampFromData(data),
        turnIndex: numberValue(data.turn_index),
        ...(stringValue(data.trace_id) ? { traceId: stringValue(data.trace_id) } : {}),
        ...patch,
      });
    }
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleToolEnd(state: AgentConversationState, data: AgentToolEventData): AgentConversationState {
  const sessionId = data.session_id ?? state.selectedSessionId ?? "";
  if (!sessionId || !data.run_id) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const result = toolResultFromData(data);
  const errorEnvelope =
    data.error == null
      ? undefined
      : normalizeRuntimeErrorEnvelope(data.error, {
          fallbackCode: "tool_execution_failed",
          fallbackMessage: "工具执行失败",
        });
  const error = errorEnvelope?.message ?? "";
  const errorType = errorEnvelope?.code ?? stringValue(data.error_type);
  const status = toolStatusFromEnd(data.status, error);
  const toolName = toolNameFromData(data);
  if (isThreadTaskToolName(toolName)) {
    return state;
  }

  if (data.is_subagent && data.subagent_id) {
    const subagent = view.messages.find(
      (message) => message.role === "subagent" && message.subagentId === data.subagent_id,
    );
    if (subagent) {
      const tool = findSubagentTool(subagent, data.run_id);
      if (tool) {
        applyToolEnd(tool, result, data.duration_ms, status, error, errorType, errorEnvelope, data);
      }
      for (const call of subagent.subagentToolCalls ?? []) {
        if (call !== tool && call.runId === data.run_id) {
          applyToolEnd(call, result, data.duration_ms, status, error, errorType, errorEnvelope, data);
        }
      }
    }
  } else {
    const message = view.messages.find((item) => item.role === "tool" && item.runId === data.run_id);
    const target = message ?? findMatchingProgressTool(view, data, toolName);
    if (target) {
      applyToolEnd(target, result, data.duration_ms, status, error, errorType, errorEnvelope, data);
      applyTurnFields(target, numberValue(data.turn_index), stringValue(data.trace_id));
    } else {
      view.messages.push({
        id: nextMessageId(next, "tool", sessionId),
        sessionId,
        role: "tool",
        content: "",
        timestamp: timestampFromData(data),
        turnIndex: numberValue(data.turn_index),
        ...(stringValue(data.trace_id) ? { traceId: stringValue(data.trace_id) } : {}),
        ...toolCallFromStart(data, toolName),
        status,
        toolResult: result,
        toolDurationMs: data.duration_ms,
        toolError: error || undefined,
        toolErrorType: errorType || undefined,
        error: errorEnvelope,
      });
    }
  }
  view.isStreaming = hasStreamingMessage(view);
  markTurnInProgress(view);
  return next;
}

function handleSubagentStart(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  const subagentId = stringValue(data.subagent_id) || stringValue(data.node_id) || stringValue(data.run_id);
  if (!sessionId || !subagentId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  ensureSubagentMessage(next, view, subagentId, {
    subagentName: stringValue(data.subagent_name) || stringValue(data.agent_name) || stringValue(data.name),
    subagentTask: stringValue(data.task) || stringValue(data.input),
    subagentRunId: stringValue(data.run_id),
    streaming: true,
    timestamp: timestampFromData(data),
  });
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleSubagentEnd(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  const subagentId = stringValue(data.subagent_id) || stringValue(data.node_id) || stringValue(data.run_id);
  if (!sessionId || !subagentId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const message = view.messages.find((item) => item.role === "subagent" && item.subagentId === subagentId);
  if (message) {
    const result = stringValue(data.result_summary) || stringValue(data.result);
    if (result && !message.content.includes(result)) {
      message.content += message.content ? `\n\n${result}` : result;
      appendSubagentTextItem(next, message, result, timestampFromData(data));
    }
    message.streaming = false;
    closeSubagentTextStreams(message);
  }
  view.isStreaming = hasStreamingMessage(view);
  markTurnInProgress(view);
  return next;
}

function handleSubagentError(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  const subagentId = stringValue(data.subagent_id) || stringValue(data.node_id) || stringValue(data.run_id);
  if (!sessionId || !subagentId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const message = ensureSubagentMessage(next, view, subagentId, {
    subagentName: stringValue(data.subagent_name) || stringValue(data.agent_name) || stringValue(data.name),
    streaming: false,
    timestamp: timestampFromData(data),
  });
  const errorText = `\n\n[错误: ${stringValue(data.error) || stringValue(data.message) || "子任务失败"}]`;
  message.content += errorText;
  appendSubagentTextItem(next, message, errorText, timestampFromData(data));
  message.streaming = false;
  message.status = "failed";
  closeSubagentTextStreams(message);
  view.isStreaming = hasStreamingMessage(view);
  markTurnInProgress(view);
  return next;
}

function handleCompleted(state: AgentConversationState, payload: AgentCompletedPayload): AgentConversationState {
  const sessionId = payload.session_id || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const finalContent = stringValue(payload.final_content);
  const payloadTurnIndex = numberValue(payload.turn_index);
  const payloadTraceId = stringValue(payload.trace_id);
  const completedAt = timestampFromData(payload);
  const target = findCompletedAssistantTarget(view, payloadTurnIndex, payloadTraceId);

  let completedTarget = target;
  if (!completedTarget && finalContent) {
    completedTarget = {
      id: nextMessageId(next, "assistant", sessionId),
      sessionId,
      role: "assistant",
      content: finalContent,
      timestamp: timestampFromData(payload),
      turnIndex: payloadTurnIndex,
      ...(stringValue(payload.trace_id) ? { traceId: stringValue(payload.trace_id) } : {}),
      streaming: false,
    };
    view.messages.push(completedTarget);
  } else if (completedTarget && !completedTarget.content && finalContent) {
    completedTarget.content = finalContent;
  }

  const ghostStats = buildCompletedGhostStats(payload);
  if (completedTarget && ghostStats) {
    completedTarget.ghostStats = ghostStats;
    completedTarget.traceQueryContext = payload.trace_query_context ?? payload.ghost_footer?.trace_query_context;
  }
  if (completedTarget && payload.trace_id && !completedTarget.traceId) {
    completedTarget.traceId = payload.trace_id;
  }
  if (completedTarget) {
    applyTurnFields(completedTarget, payloadTurnIndex, stringValue(payload.trace_id));
  }
  const threadTask = threadTaskContextFromPayload(payload);
  if (completedTarget && threadTask) {
    applyThreadTaskMetadata(completedTarget, threadTask);
  }
  completeTurnDuration(
    view,
    completedAt,
    payloadTurnIndex,
    payloadTraceId,
    nonNegativeNumber(payload.first_token_at_ms) ?? view.firstTokenAtMs,
    completedTarget,
  );

  for (const message of view.messages) {
    if (message.role === "reasoning" && message.streaming) {
      completeReasoningDuration(message, completedAt);
    }
    message.streaming = false;
    if (message.status === "streaming") {
      message.status = message.role === "reasoning" ? "completed" : undefined;
    }
    if (message.role === "subagent") {
      closeSubagentTextStreams(message);
    }
  }
  view.isStreaming = false;
  view.isCancelling = false;
  view.stale = false;
  view.pendingApproval = null;
  view.pendingElicitation = null;
  view.firstTokenAtMs = null;
  if (payload.status !== "failed" && hasWaitingA2UIInput(view.messages)) {
    applyWaitingInputRuntimeState(next, view, sessionId);
  } else {
    view.runtimeState = payload.status === "failed" ? "failed" : "idle";
  }
  return next;
}

function findCompletedAssistantTarget(
  view: AgentSessionViewState,
  turnIndex: number | null,
  traceId: string,
): AgentChatMessage | undefined {
  const candidates = [...view.messages]
    .reverse()
    .filter(
      (message) =>
        message.role === "assistant" &&
        !message.cancelled &&
        message.status !== "cancelled",
    );
  return (
    candidates.find((message) => isSameBusinessTurn(message, turnIndex) && message.content.trim()) ??
    candidates.find((message) => isSameBusinessTurn(message, turnIndex)) ??
    (traceId ? candidates.find((message) => message.traceId === traceId && message.content.trim()) : undefined) ??
    (traceId ? candidates.find((message) => message.traceId === traceId) : undefined)
  );
}

function handleCancelled(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data);
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const completedAt = timestampFromData(data);
  const traceId = stringValue(data.trace_id);
  const turnIndex = numberValue(data.turn_index);
  completeTurnDuration(
    view,
    completedAt,
    turnIndex,
    traceId,
    nonNegativeNumber(data.first_token_at_ms) ?? view.firstTokenAtMs,
  );
  for (const message of view.messages) {
    if (message.role === "reasoning" && message.streaming) {
      completeReasoningDuration(message, completedAt);
    }
    if (message.streaming) {
      message.streaming = false;
    }
    if (message.status === "streaming") {
      message.status = undefined;
    }
    if (message.role === "tool" && message.status === "running") {
      message.status = "cancelled";
    }
    if (message.role === "subagent") {
      closeSubagentTextStreams(message);
      for (const tool of message.subagentToolCalls ?? []) {
        if (tool.status === "running") {
          tool.status = "cancelled";
        }
      }
      for (const item of message.subagentItems ?? []) {
        if (item.type === "tool" && item.status === "running") {
          item.status = "cancelled";
        }
      }
    }
  }
  const last = view.messages.at(-1);
  const threadTask = threadTaskContextFromPayload(data);
  if (last?.role === "assistant" && last.cancelled && last.status === "cancelled") {
    if (traceId && !last.traceId) {
      last.traceId = traceId;
    }
    applyTurnFields(last, turnIndex, traceId);
    if (threadTask) {
      applyThreadTaskMetadata(last, threadTask);
    }
  } else {
    const metadata = threadTask ? threadTaskMetadata(threadTask) : undefined;
    view.messages.push({
      id: nextMessageId(next, "cancelled", sessionId),
      sessionId,
      role: "assistant",
      content: "",
      timestamp: timestampFromData(data),
      turnIndex,
      status: "cancelled",
      cancelled: true,
      ...(traceId ? { traceId } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }
  view.isStreaming = false;
  view.isCancelling = false;
  view.pendingApproval = null;
  view.pendingElicitation = null;
  view.firstTokenAtMs = null;
  view.runtimeState = "idle";
  return next;
}

function handleCommandTerminated(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data);
  const commandId = stringValue(data.command_id);
  if (!sessionId || !commandId || data.terminated === false) {
    return state;
  }
  const next = cloneState(state);
  const view = next.sessionStateById[sessionId];
  if (!view) {
    return next;
  }
  const command = view.messages.find(
    (message) => message.role === "tool" && commandIdFromMessage(message) === commandId,
  );
  if (!command || command.status === "completed" || command.status === "error") {
    return next;
  }
  command.status = "cancelled";
  command.uiPayload = {
    ...(asRecord(command.uiPayload) ?? {}),
    command_id: commandId,
    status: "cancelled",
    cancel_reason: "user",
    can_terminate: false,
  };
  return next;
}

function handleError(state: AgentConversationState, data: AgentErrorData): AgentConversationState {
  // The shared socket also carries project/file/Git failures. Only an error
  // with an explicit session scope is allowed to become conversation history.
  const sessionId = stringValue(data.session_id).trim();
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const completedAt = timestampFromData(data);
  const error = turnErrorFromData(data);
  const traceId = stringValue(data.trace_id);
  const turnIndex = numberValue(data.turn_index);
  const threadTask = threadTaskContextFromPayload(data);
  const activeTurnFailed = view.isStreaming || view.runtimeState === "running" || hasStreamingMessage(view);
  const attachedToAssistant =
    activeTurnFailed && attachTurnErrorToLatestAssistant(view, error, traceId, threadTask, turnIndex);
  completeTurnDuration(
    view,
    completedAt,
    turnIndex,
    traceId,
    nonNegativeNumber(data.first_token_at_ms) ?? view.firstTokenAtMs,
  );
  if (!attachedToAssistant) {
    const metadata = threadTask ? threadTaskMetadata(threadTask, { turnError: error }) : { turnError: error };
    view.messages.push({
      id: nextMessageId(next, "error", sessionId),
      sessionId,
      role: "error",
      content: error.message,
      timestamp: timestampFromData(data),
      turnIndex,
      ...(traceId ? { traceId } : {}),
      status: "failed",
      metadata,
    });
  }
  for (const message of view.messages) {
    if (message.role === "reasoning" && message.streaming) {
      completeReasoningDuration(message, completedAt);
      if (message.status === "streaming") {
        message.status = "failed";
      }
    }
    message.streaming = false;
    if (message.role === "subagent") {
      closeSubagentTextStreams(message);
    }
  }
  view.isStreaming = false;
  view.isCancelling = false;
  view.pendingApproval = null;
  view.pendingElicitation = null;
  view.firstTokenAtMs = null;
  view.runtimeState = "failed";
  return next;
}

function turnErrorFromData(data: AgentErrorData): TurnError {
  return normalizeRuntimeErrorEnvelope(data, {
    fallbackCode: "runtime_error",
    fallbackMessage: "对话执行失败",
  });
}

function attachTurnErrorToLatestAssistant(
  view: AgentSessionViewState,
  error: TurnError,
  traceId: string,
  threadTask: Record<string, unknown> | null,
  turnIndex: number | null,
): boolean {
  const message = [...view.messages]
    .reverse()
    .find((item) => {
      if (item.role !== "assistant" || item.cancelled || item.status === "cancelled") {
        return false;
      }
      if (!isSameBusinessTurn(item, turnIndex)) {
        return false;
      }
      return normalizeMessageContent(item.content).trim().length > 0;
    });
  if (!message) {
    return false;
  }
  message.status = "failed";
  message.streaming = false;
  if (traceId) {
    message.traceId = traceId;
  }
  applyTurnFields(message, turnIndex, traceId);
  message.metadata = {
    ...(message.metadata ?? {}),
    turnError: error,
  };
  if (threadTask) {
    applyThreadTaskMetadata(message, threadTask);
  }
  return true;
}

function threadTaskContextFromPayload(payload: object): Record<string, unknown> | null {
  const record = payload as Record<string, unknown>;
  return asRecord(record.thread_task) ?? asRecord(record.threadTask);
}

function applyThreadTaskMetadata(message: AgentChatMessage, threadTask: Record<string, unknown>): void {
  message.metadata = threadTaskMetadata(threadTask, message.metadata);
}

function threadTaskMetadata(
  threadTask: Record<string, unknown>,
  existingMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = existingMetadata ?? {};
  const runtimeParams = asRecord(metadata.runtime_params) ?? {};
  const context = { ...threadTask };
  return {
    ...metadata,
    thread_task: context,
    runtime_params: {
      ...runtimeParams,
      thread_task: context,
    },
  };
}

function handleStatus(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const explicitSessionId = sessionIdFromData(data);
  const sessionId = explicitSessionId;
  const next = cloneState(state);
  const runningSessionIds = runningSessionIdsFromStatus(data);
  const waitingApprovalSessionIds = waitingApprovalSessionIdsFromStatus(data);
  const waitingInputSessionIds = waitingInputSessionIdsFromStatus(data);
  const liveSessionIds = new Set([
    ...runningSessionIds,
    ...waitingApprovalSessionIds,
    ...waitingInputSessionIds,
  ]);
  for (const runningSessionId of runningSessionIds) {
    const runningView = ensureSessionState(next, runningSessionId);
    if (!runningView.pendingApproval) {
      runningView.runtimeState = "running";
      runningView.isStreaming = true;
    }
    runningView.isCancelling = false;
  }
  for (const waitingSessionId of waitingApprovalSessionIds) {
    const waitingView = ensureSessionState(next, waitingSessionId);
    waitingView.runtimeState = "waiting_approval";
    waitingView.isStreaming = false;
    waitingView.isCancelling = false;
    updateSessionStatus(next, waitingSessionId, "waiting_approval");
  }
  for (const waitingSessionId of waitingInputSessionIds) {
    const waitingView = ensureSessionState(next, waitingSessionId);
    waitingView.runtimeState = "waiting_input";
    waitingView.isStreaming = false;
    waitingView.isCancelling = false;
    updateSessionStatus(next, waitingSessionId, "waiting_input");
  }
  if (!explicitSessionId) {
    for (const [knownSessionId, knownView] of Object.entries(next.sessionStateById)) {
      if (
        !liveSessionIds.has(knownSessionId)
        && (knownView.runtimeState === "running" || knownView.runtimeState === "cancelling")
      ) {
        settleMissingRunRuntimeState(next, knownView, knownSessionId);
      }
    }
    return next;
  }
  const view = ensureSessionState(next, sessionId);
  const pendingInputs = pendingInputsFromUnknown(data.pending_inputs);
  if (pendingInputs.length || Array.isArray(data.pending_inputs)) {
    view.pendingInputs = normalizePendingInputs(pendingInputs);
  }
  const status = stringValue(data.status);
  if (isAgentSessionStatus(status)) {
    view.status = status;
    view.runtimeState = runtimeStateFromSessionStatus(status);
  } else if (isRuntimeState(status)) {
    view.runtimeState = status;
  }
  if (view.runtimeState === "idle") {
    settleMissingRunRuntimeState(next, view, sessionId);
  } else if (view.runtimeState !== "running") {
    view.isStreaming = false;
  }
  return next;
}

function settleMissingRunRuntimeState(
  state: AgentConversationState,
  view: AgentSessionViewState,
  sessionId: string,
): void {
  closeAllMessageStreams(view);
  for (const message of view.messages) {
    if (message.role === "tool" && message.status === "running") {
      message.status = "cancelled";
    }
    if (message.role === "subagent") {
      for (const tool of message.subagentToolCalls ?? []) {
        if (tool.status === "running") {
          tool.status = "cancelled";
        }
      }
      for (const item of message.subagentItems ?? []) {
        if (item.type === "tool" && item.status === "running") {
          item.status = "cancelled";
        }
      }
    }
  }
  view.runtimeState = "idle";
  view.isStreaming = false;
  view.isCancelling = false;
  view.pendingApproval = null;
  view.pendingElicitation = null;
  view.firstTokenAtMs = null;
  updateSessionStatus(state, sessionId, "active");
}

function applyWaitingInputRuntimeState(
  state: AgentConversationState,
  view: AgentSessionViewState,
  sessionId: string,
): void {
  closeAllMessageStreams(view);
  view.runtimeState = "waiting_input";
  view.isStreaming = false;
  view.isCancelling = false;
  updateSessionStatus(state, sessionId, "waiting_input");
}

function handleUserMessage(
  state: AgentConversationState,
  data: Record<string, unknown>,
): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }
  const pendingInputId = stringValue(data.pending_input_id);
  const deliveryMode = stringValue(data.delivery_mode);
  const messageId = pendingInputId
    ? `pending-user:${pendingInputId}`
    : stringValue(data.message_event_id) || stringValue(data.event_id) || nextMessageId(state, "user", sessionId);
  const currentView = state.sessionStateById[sessionId];
  if (currentView?.messages.some((message) => message.id === messageId)) {
    return state;
  }
  const rawContextItems = Array.isArray(data.contextItems)
    ? data.contextItems
    : Array.isArray(data.context_items)
      ? data.context_items
      : [];
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.messages.push({
    id: messageId,
    sessionId,
    role: "user",
    content: stringValue(data.content) || stringValue(data.message),
    contextItems: rawContextItems.filter(
      (item): item is AgentContextItem => Boolean(item && typeof item === "object"),
    ),
    attachments: pendingInputAttachments(data.attachments),
    ...(pendingInputId ? { pendingInputId } : {}),
    ...(pendingInputId && isPendingInputMode(deliveryMode) ? { deliveryMode } : {}),
    timestamp: timestampFromData(data),
    turnIndex: numberValue(data.turn_index),
    ...(stringValue(data.trace_id) ? { traceId: stringValue(data.trace_id) } : {}),
  });
  return next;
}

function handlePendingInputUpsert(
  state: AgentConversationState,
  data: AgentPendingInputEventData,
): AgentConversationState {
  const pendingInput = pendingInputFromData(data);
  if (!pendingInput) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, pendingInput.session_id);
  upsertPendingInput(view, pendingInput);
  return next;
}

function handlePendingInputTerminal(
  state: AgentConversationState,
  data: AgentPendingInputEventData,
): AgentConversationState {
  const pendingInput = pendingInputFromData(data);
  if (!pendingInput) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, pendingInput.session_id);
  view.pendingInputs = view.pendingInputs.filter((item) => pendingInputId(item) !== pendingInputId(pendingInput));
  return next;
}

function handlePendingInputsReordered(
  state: AgentConversationState,
  data: AgentPendingInputsReorderedEventData,
): AgentConversationState {
  const sessionId = stringValue(data.session_id);
  if (!sessionId || !Array.isArray(data.pending_inputs)) {
    return state;
  }
  const next = cloneState(state);
  ensureSessionState(next, sessionId).pendingInputs = normalizePendingInputs(
    pendingInputsFromUnknown(data.pending_inputs),
  );
  return next;
}

function upsertPendingInput(view: AgentSessionViewState, input: AgentPendingInput): void {
  if (!isActivePendingInputStatus(input.status)) {
    view.pendingInputs = view.pendingInputs.filter((item) => pendingInputId(item) !== pendingInputId(input));
    return;
  }
  const normalized = clonePendingInput(input);
  const targetId = pendingInputId(normalized);
  const existingIndex = view.pendingInputs.findIndex((item) => pendingInputId(item) === targetId);
  if (existingIndex >= 0) {
    view.pendingInputs = view.pendingInputs.map((item, index) => (index === existingIndex ? normalized : item));
  } else {
    view.pendingInputs = [...view.pendingInputs, normalized];
  }
  view.pendingInputs = normalizePendingInputs(view.pendingInputs);
}

function pendingInputFromData(data: AgentPendingInputEventData | Record<string, unknown>): AgentPendingInput | null {
  const nested = asRecord((data as AgentPendingInputEventData).pending_input);
  const raw = nested ?? (data as Record<string, unknown>);
  const id = stringValue(raw.id) || stringValue(raw.pending_input_id);
  const sessionId = stringValue(raw.session_id);
  const mode = stringValue(raw.mode);
  const status = stringValue(raw.status);
  if (!id || !sessionId || !isPendingInputMode(mode) || !isPendingInputStatus(status)) {
    return null;
  }
  return {
    id,
    pending_input_id: stringValue(raw.pending_input_id) || id,
    session_id: sessionId,
    client_input_id: nullableString(raw.client_input_id),
    mode,
    status,
    message: stringValue(raw.message),
    provider_id: nullableString(raw.provider_id),
    model: nullableString(raw.model),
    user_id: nullableString(raw.user_id),
    scene_id: nullableString(raw.scene_id),
    runtime_params: asRecord(raw.runtime_params) ?? {},
    attachments: pendingInputAttachments(raw.attachments),
    target_turn_index: numberValue(raw.target_turn_index),
    target_trace_id: nullableString(raw.target_trace_id),
    promoted_turn_index: numberValue(raw.promoted_turn_index),
    promoted_trace_id: nullableString(raw.promoted_trace_id),
    queue_position: numberValue(raw.queue_position),
    error_code: nullableString(raw.error_code),
    error_message: nullableString(raw.error_message),
    created_at: nullableString(raw.created_at) ?? undefined,
    updated_at: nullableString(raw.updated_at) ?? undefined,
    delivered_at: nullableString(raw.delivered_at),
    cancelled_at: nullableString(raw.cancelled_at),
    paused_at: nullableString(raw.paused_at),
    pause_reason: nullableString(raw.pause_reason),
    paused: Boolean(raw.paused) || nullableString(raw.paused_at) !== null,
  };
}

function pendingInputsFromUnknown(value: unknown): AgentPendingInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (item && typeof item === "object" ? pendingInputFromData(item as Record<string, unknown>) : null))
    .filter(isDefined);
}

function normalizePendingInputs(inputs: AgentPendingInput[]): AgentPendingInput[] {
  const merged = new Map<string, AgentPendingInput>();
  for (const input of inputs) {
    if (!isActivePendingInputStatus(input.status)) {
      merged.delete(pendingInputId(input));
      continue;
    }
    merged.set(pendingInputId(input), clonePendingInput(input));
  }
  return [...merged.values()].sort(comparePendingInputs);
}

function comparePendingInputs(left: AgentPendingInput, right: AgentPendingInput): number {
  const leftPosition = Number(left.queue_position ?? 0);
  const rightPosition = Number(right.queue_position ?? 0);
  if (leftPosition !== rightPosition) {
    return leftPosition - rightPosition;
  }
  const leftCreated = Date.parse(left.created_at ?? "");
  const rightCreated = Date.parse(right.created_at ?? "");
  if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }
  return pendingInputId(left).localeCompare(pendingInputId(right));
}

function pendingInputAttachments(value: unknown): AgentPendingInput["attachments"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is NonNullable<AgentPendingInput["attachments"]>[number] =>
    Boolean(item && typeof item === "object"),
  );
}

function pendingInputId(input: AgentPendingInput): string {
  return input.pending_input_id || input.id;
}

function clonePendingInput(input: AgentPendingInput): AgentPendingInput {
  return {
    ...input,
    runtime_params: { ...(input.runtime_params ?? {}) },
    attachments: input.attachments ? input.attachments.map((item) => ({ ...item })) : [],
  };
}

function isPendingInputMode(value: string): value is AgentPendingInput["mode"] {
  return value === "steer" || value === "queue";
}

function isPendingInputStatus(value: string): value is AgentPendingInput["status"] {
  return (
    value === "pending_steer" ||
    value === "queued" ||
    value === "starting" ||
    value === "running" ||
    value === "delivered" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "converted"
  );
}

function isActivePendingInputStatus(value: AgentPendingInput["status"]): boolean {
  return value === "pending_steer" || value === "queued" || value === "starting" || value === "running";
}

function handleToolProgress(state: AgentConversationState, data: AgentToolProgressData): AgentConversationState {
  const sessionId = data.session_id ?? state.selectedSessionId ?? "";
  const commandPayload = commandPayloadFromToolData(data);
  const progressRunId = data.run_id || data.tool_call_id || stringValue(commandPayload?.command_id);
  if (!sessionId || !progressRunId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const toolName = toolNameFromData(data);
  if (isThreadTaskToolName(toolName)) {
    return state;
  }
  const existing =
    view.messages.find(
      (message) =>
        message.role === "tool" &&
        (message.runId === progressRunId ||
          commandIdFromMessage(message) === progressRunId ||
          Boolean(data.tool_call_id && message.toolCallId === data.tool_call_id)),
    ) ?? findMatchingProgressTool(view, data, toolName);
  if (existing) {
    if (shouldIgnoreLateCommandProgress(existing, data)) {
      return state;
    }
    applyToolProgress(existing, data, toolName);
    applyTurnFields(existing, numberValue(data.turn_index), stringValue(data.trace_id));
  } else {
    const created: AgentChatMessage = {
      id: nextMessageId(next, "tool-progress", sessionId),
      sessionId,
      role: "tool",
      content: "",
      timestamp: timestampFromData(data),
      turnIndex: numberValue(data.turn_index),
      ...(stringValue(data.trace_id) ? { traceId: stringValue(data.trace_id) } : {}),
      runId: progressRunId,
      toolCallId: data.tool_call_id,
      toolName,
      toolParams: data.params ?? data.input_data ?? commandToolParams(commandPayload),
      status: toolStatusFromCommandPayload(commandPayload, data.status),
      fileChanges: normalizedFileChanges(data.files),
      uiPayload: mergeToolFilesIntoUiPayload(commandPayload ?? data.ui_payload, data.files),
      metadata: toolMetadataFromData(data),
    };
    view.messages.push(created);
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleSessionClosed(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.status = "closed";
  view.runtimeState = "closed";
  view.isStreaming = false;
  view.isCancelling = false;
  const existing = next.sessionsById[sessionId];
  if (existing) {
    next.sessionsById = {
      ...next.sessionsById,
      [sessionId]: { ...existing, status: "closed" },
    };
  }
  return next;
}

function handleSessionTitleUpdated(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionPayload = asRecord(data.session);
  const source = sessionPayload ?? data;
  const sessionId = stringValue(source.id) || sessionIdFromData(data);
  const title = nullableString(source.title);
  if (!sessionId || title === null) {
    return state;
  }
  const existing = state.sessionsById[sessionId];
  if (!existing) {
    return state;
  }
  const next = cloneState(state);
  next.sessionsById = {
    ...next.sessionsById,
    [sessionId]: {
      ...existing,
      title,
      title_source: nullableString(source.title_source) as AgentSession["title_source"],
      updated_at: stringValue(source.updated_at) || existing.updated_at,
    },
  };
  next.sessionIds = sortSessionIds(Object.values(next.sessionsById));
  return next;
}

function historyMessageFromPayload(
  sessionId: string,
  payload: AgentChatMessagePayload,
  index: number,
): AgentChatMessage {
  const content = normalizeMessageContent(payload.content);
  const traceId = payload.traceId || payload.traceQueryContext?.trace_id;
  const ghostStats =
    payload.ghostStats ??
    (traceId
      ? {
          traceId,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
        }
      : undefined);

  const message: AgentChatMessage = {
    ...payload,
    id: payload.id ?? historyMessageId(sessionId, payload, index, content),
    sessionId: payload.sessionId ?? sessionId,
    timestamp: payload.timestamp ?? Date.now() + index,
    content,
    hydratedFromHistory: true,
    ghostStats,
    streaming: false,
    status: normalizeHistoryStatus(payload),
    subagentItems: payload.subagentItems?.map(normalizeSubagentHistoryItem),
    subagentToolCalls: payload.subagentToolCalls?.map(normalizeToolHistoryCall),
  };
  if (message.role !== "a2ui" || !message.a2ui) {
    return message;
  }
  const restored = mergeA2UIEventIntoMessages([], "a2ui_created", {
    ...payload,
    session_id: sessionId,
    a2ui: message.a2ui,
    interaction: message.a2ui.interaction ?? undefined,
  }, {
    idFactory: () => message.id,
    now: message.timestamp,
    sessionId,
  }).message;
  if (!restored?.a2uiDebug) {
    return message;
  }
  return {
    ...message,
    contentType: message.contentType ?? "a2ui",
    content_type: message.content_type ?? "a2ui",
    a2uiDebug: restored.a2uiDebug,
    streaming: false,
  };
}

function historyMessageId(
  sessionId: string,
  payload: AgentChatMessagePayload,
  index: number,
  content: string,
): string {
  if (payload.turnIndex === undefined && payload.timestamp === undefined) {
    return `hist:${sessionId}:${index + 1}`;
  }
  const turn = payload.turnIndex ?? "turnless";
  const timestamp = payload.timestamp ?? "notime";
  const run = payload.runId ?? payload.subagentRunId ?? payload.toolName ?? "";
  const contentHash = hashHistoryText(content);
  return `hist:${sessionId}:${turn}:${payload.role}:${timestamp}:${run}:${index}:${contentHash}`;
}

function hashHistoryText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeHistoryStatus(payload: AgentChatMessagePayload): AgentChatMessage["status"] {
  if (payload.status) {
    return payload.status;
  }
  if (payload.role === "tool") {
    return payload.error || payload.toolError ? "error" : "completed";
  }
  return undefined;
}

function normalizeSubagentHistoryItem(item: AgentSubagentItem): AgentSubagentItem {
  if (item.type === "tool") {
    return {
      ...normalizeToolHistoryCall(item),
      id: item.id,
      type: "tool",
      timestamp: item.timestamp,
    };
  }
  return {
    ...item,
    content: normalizeMessageContent(item.content),
    streaming: false,
  };
}

function normalizeToolHistoryCall(tool: AgentToolCall): AgentToolCall {
  return {
    ...tool,
    status: tool.status ?? (tool.error || tool.toolError ? "error" : "completed"),
  };
}

function buildCompletedGhostStats(payload?: AgentCompletedPayload): AgentGhostStats | undefined {
  if (!payload) {
    return undefined;
  }
  const tokenUsage =
    payload.latest_llm_token_usage ??
    payload.chain_token_usage ??
    payload.ghost_footer?.latest_llm_token_usage ??
    payload.ghost_footer?.chain_token_usage;
  const traceId = payload.trace_id?.trim() || payload.ghost_footer?.trace_id?.trim() || "";
  if (!traceId && !tokenUsage) {
    return undefined;
  }
  return {
    traceId,
    inputTokens: tokenUsage?.input_tokens ?? 0,
    cacheReadTokens: tokenUsage?.cache_read_tokens ?? 0,
    outputTokens: tokenUsage?.output_tokens ?? 0,
  };
}

function ensureSessionState(
  state: AgentConversationState,
  sessionId: string,
  meta: Partial<AgentSessionViewState> = {},
): AgentSessionViewState {
  const existing = state.sessionStateById[sessionId];
  if (existing) {
    const runtimeState = mergeIncomingRuntimeState(existing.runtimeState, meta.runtimeState);
    const cloned = {
      ...existing,
      ...meta,
      runtimeState,
      messages: existing.messages.map(cloneMessage),
      pendingInputs: existing.pendingInputs.map(clonePendingInput),
      threadTasks: existing.threadTasks.map(cloneThreadTask),
      activeTask: existing.activeTask ? cloneThreadTask(existing.activeTask) : null,
      runningTaskRun: existing.runningTaskRun ? cloneThreadTaskRun(existing.runningTaskRun) : null,
      recentTaskRun: existing.recentTaskRun ? cloneThreadTaskRun(existing.recentTaskRun) : null,
    };
    state.sessionStateById[sessionId] = cloned;
    return cloned;
  }
  const created: AgentSessionViewState = {
    sessionId,
    sceneId: meta.sceneId ?? "",
    userId: meta.userId ?? "",
    status: meta.status ?? "active",
    messages: meta.messages?.map(cloneMessage) ?? [],
    runtimeState: meta.runtimeState ?? runtimeStateFromSessionStatus(meta.status ?? "active"),
    isStreaming: meta.isStreaming ?? false,
    isCancelling: meta.isCancelling ?? false,
    chatBound: meta.chatBound ?? false,
    hydrated: meta.hydrated ?? false,
    historyLoading: meta.historyLoading ?? false,
    historyCursor: meta.historyCursor ?? null,
    historyHasMoreOlder: meta.historyHasMoreOlder ?? false,
    hasUnread: meta.hasUnread ?? false,
    pendingApproval: meta.pendingApproval ?? null,
    pendingElicitation: meta.pendingElicitation ?? null,
    pendingInputs: meta.pendingInputs?.map(clonePendingInput) ?? [],
    threadTasks: meta.threadTasks?.map(cloneThreadTask) ?? [],
    activeTask: meta.activeTask ? cloneThreadTask(meta.activeTask) : null,
    runningTaskRun: meta.runningTaskRun ? cloneThreadTaskRun(meta.runningTaskRun) : null,
    recentTaskRun: meta.recentTaskRun ? cloneThreadTaskRun(meta.recentTaskRun) : null,
    firstTokenAtMs: meta.firstTokenAtMs ?? null,
    stale: meta.stale ?? false,
  };
  state.sessionStateById[sessionId] = created;
  return created;
}

function approvalFromData(data: Record<string, unknown>): CommandApprovalRequest | null {
  const approval = asRecord(data.approval);
  if (!approval) {
    return null;
  }
  const id = stringValue(approval.id);
  const sessionId = stringValue(approval.session_id) || stringValue(approval.thread_id);
  if (!id || !sessionId) {
    return null;
  }
  const status = stringValue(approval.status);
  const decision = stringValue(approval.decision);
  const trustScope = stringValue(approval.trust_scope);
  const ruleMatchType = stringValue(approval.rule_match_type);
  return {
    id,
    session_id: sessionId,
    thread_id: stringValue(approval.thread_id) || sessionId,
    turn_id: stringValue(approval.turn_id),
    item_id: stringValue(approval.item_id),
    call_id: stringValue(approval.call_id),
    run_id: nullableString(approval.run_id),
    tool_name: stringValue(approval.tool_name) || "command",
    kind: stringValue(approval.kind) || "exec",
    title: stringValue(approval.title) || "是否允许执行命令？",
    description: stringValue(approval.description),
    details: asRecord(approval.details) ?? {},
    status: isApprovalStatus(status) ? status : "pending",
    decision: isApprovalDecision(decision) ? decision : null,
    trust_scope: isTrustScope(trustScope) ? trustScope : null,
    rule_match_type: isRuleMatchType(ruleMatchType) ? ruleMatchType : null,
    reject_message: nullableString(approval.reject_message),
    trusted_rule_id: nullableString(approval.trusted_rule_id),
    metadata: approvalMetadataFromData(approval),
    server_id: nullableString(approval.server_id),
    server_name: nullableString(approval.server_name),
    raw_tool_name: nullableString(approval.raw_tool_name),
    model_tool_name: nullableString(approval.model_tool_name),
    snapshot_id: nullableString(approval.snapshot_id),
    created_at: stringValue(approval.created_at) || new Date().toISOString(),
    resolved_at: nullableString(approval.resolved_at),
  };
}

function approvalMetadataFromData(approval: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = asRecord(approval.metadata);
  const mcp = mcpMetadataFromApprovalData(approval);
  if (!metadata && !mcp) {
    return undefined;
  }
  const result = metadata ? { ...metadata } : {};
  if (mcp) {
    result.mcp = {
      ...(asRecord(result.mcp) ?? {}),
      ...mcp,
    };
  }
  return result;
}

function mcpMetadataFromApprovalData(approval: Record<string, unknown>): Record<string, unknown> | undefined {
  const existing = asRecord(asRecord(approval.metadata)?.mcp);
  const kind = stringValue(approval.kind) || stringValue(existing?.kind);
  const serverId = stringValue(approval.server_id) || stringValue(existing?.server_id);
  const rawToolName = stringValue(approval.raw_tool_name) || stringValue(existing?.raw_tool_name);
  const modelToolName =
    stringValue(approval.model_tool_name) ||
    stringValue(existing?.model_tool_name) ||
    stringValue(existing?.model_name);
  if (kind !== "mcp_tool_call" && kind !== "mcp_tool" && !(serverId && rawToolName && modelToolName)) {
    return undefined;
  }
  const mcp: Record<string, unknown> = {
    ...(existing ?? {}),
    kind: "mcp_tool",
  };
  setIfPresent(mcp, "snapshot_id", stringValue(approval.snapshot_id) || stringValue(existing?.snapshot_id));
  setIfPresent(mcp, "server_id", serverId);
  setIfPresent(mcp, "server_name", nullableString(approval.server_name) ?? nullableString(existing?.server_name));
  setIfPresent(mcp, "raw_tool_name", rawToolName);
  setIfPresent(mcp, "model_tool_name", modelToolName);
  setIfPresent(mcp, "model_name", stringValue(existing?.model_name) || modelToolName);
  return mcp;
}

function elicitationFromData(data: Record<string, unknown>, fallbackSessionId = ""): McpElicitationRequest | null {
  const source = asRecord(data.elicitation) ?? data;
  const id = stringValue(source.elicitation_id) || stringValue(source.id);
  const sessionId = stringValue(source.session_id) || sessionIdFromData(data) || fallbackSessionId;
  if (!id || !sessionId) {
    return null;
  }
  const status = normalizeElicitationStatus(source.status);
  return {
    elicitation_id: id,
    id,
    session_id: sessionId,
    server_id: stringValue(source.server_id),
    server_name: nullableString(source.server_name),
    raw_tool_name: nullableString(source.raw_tool_name),
    title: stringValue(source.title) || DEFAULT_MCP_ELICITATION_TITLE,
    schema: asRecord(source.schema) ?? {},
    status,
    values: asRecord(source.values),
    created_at: stringValue(source.created_at) || new Date().toISOString(),
  };
}

function normalizeElicitationStatus(value: unknown): McpElicitationRequest["status"] {
  const status = stringValue(value);
  if (status === "submitted" || status === "cancelled" || status === "timeout") {
    return status;
  }
  return "pending";
}

function pendingElicitationForHydratedView(
  messages: AgentChatMessage[],
  previousView?: AgentSessionViewState,
): McpElicitationRequest | null {
  const pending = firstPendingElicitation(messages);
  if (pending) {
    return pending;
  }
  const previous = previousView?.pendingElicitation;
  if (!previous || previous.status !== "pending") {
    return null;
  }
  if (hasElicitationMessage(messages, previous.elicitation_id)) {
    return null;
  }
  return previous;
}

function firstPendingElicitation(messages: AgentChatMessage[]): McpElicitationRequest | null {
  for (const message of messages) {
    if (message.role === "mcp_elicitation" && message.status === "pending") {
      const elicitation = elicitationFromMessage(message);
      if (elicitation?.status === "pending") {
        return elicitation;
      }
    }
  }
  return null;
}

function hasElicitationMessage(messages: AgentChatMessage[], elicitationId: string): boolean {
  return messages.some((message) => message.role === "mcp_elicitation" && elicitationFromMessage(message)?.elicitation_id === elicitationId);
}

function sessionIdForPendingElicitation(state: AgentConversationState, elicitationId: string): string {
  if (!elicitationId) {
    return "";
  }
  for (const [sessionId, view] of Object.entries(state.sessionStateById)) {
    if (view.pendingElicitation?.elicitation_id === elicitationId || hasElicitationMessage(view.messages, elicitationId)) {
      return sessionId;
    }
  }
  return "";
}

function upsertElicitationMessage(
  state: AgentConversationState,
  view: AgentSessionViewState,
  elicitation: McpElicitationRequest,
) {
  const existing = view.messages.find(
    (message) => message.role === "mcp_elicitation" && elicitationFromMessage(message)?.elicitation_id === elicitation.elicitation_id,
  );
  const merged = mergeElicitationForDisplay(existing ? elicitationFromMessage(existing) : null, elicitation);
  const status = elicitation.status === "pending"
    ? "pending"
    : elicitation.status === "cancelled"
      ? "cancelled"
      : elicitation.status === "timeout"
        ? "error"
        : "completed";
  const patch: Partial<AgentChatMessage> = {
    role: "mcp_elicitation",
    content: merged.title,
    status,
    timestamp: Date.parse(merged.created_at) || Date.now(),
    metadata: {
      ...(existing?.metadata ?? {}),
      mcp_elicitation: merged,
    },
  };
  if (existing) {
    Object.assign(existing, patch);
    return;
  }
  view.messages.push({
    id: `mcp-elicitation:${elicitation.elicitation_id}`,
    sessionId: view.sessionId,
    role: "mcp_elicitation",
    content: merged.title,
    timestamp: Date.parse(merged.created_at) || Date.now(),
    status,
    metadata: {
      mcp_elicitation: merged,
    },
  });
  state.messageSeq += 1;
}

function elicitationFromMessage(message: AgentChatMessage): McpElicitationRequest | null {
  const metadata = asRecord(message.metadata);
  return elicitationFromData(asRecord(metadata?.mcp_elicitation) ?? {}, message.sessionId);
}

function mergeElicitationForDisplay(
  existing: McpElicitationRequest | null,
  incoming: McpElicitationRequest,
): McpElicitationRequest {
  if (!existing) {
    return incoming;
  }
  return {
    ...existing,
    ...incoming,
    server_id: incoming.server_id || existing.server_id,
    server_name: incoming.server_name ?? existing.server_name,
    raw_tool_name: incoming.raw_tool_name ?? existing.raw_tool_name,
    title: incoming.title === DEFAULT_MCP_ELICITATION_TITLE ? existing.title : incoming.title,
    schema: Object.keys(incoming.schema).length ? incoming.schema : existing.schema,
    values: incoming.values ?? existing.values,
    created_at: incoming.created_at || existing.created_at,
  };
}

function pendingApprovalForHydratedView(
  messages: AgentChatMessage[],
  previousView?: AgentSessionViewState,
): CommandApprovalRequest | null {
  const pendingApproval = firstPendingApproval(messages);
  if (pendingApproval) {
    return pendingApproval;
  }
  const previousApproval = previousView?.pendingApproval;
  if (!previousApproval || previousApproval.status !== "pending") {
    return null;
  }
  if (hasApprovalMessage(messages, previousApproval.id)) {
    return null;
  }
  return previousApproval;
}

function firstPendingApproval(messages: AgentChatMessage[]): CommandApprovalRequest | null {
  for (const message of messages) {
    if (message.role === "approval" && message.approval?.status === "pending") {
      return message.approval;
    }
  }
  return null;
}

function hasApprovalMessage(messages: AgentChatMessage[], approvalId: string): boolean {
  return messages.some((message) => message.role === "approval" && message.approval?.id === approvalId);
}

function upsertApprovalMessage(
  state: AgentConversationState,
  view: AgentSessionViewState,
  approval: CommandApprovalRequest,
) {
  const existing = view.messages.find((message) => message.role === "approval" && message.approval?.id === approval.id);
  const patch: Partial<AgentChatMessage> = {
    role: "approval",
    content: approvalContent(approval),
    approval,
    status: approval.status,
    timestamp: Date.parse(approval.resolved_at || approval.created_at) || Date.now(),
  };
  if (existing) {
    Object.assign(existing, patch);
    return;
  }
  view.messages.push({
    id: nextMessageId(state, "approval", view.sessionId),
    sessionId: view.sessionId,
    content: approvalContent(approval),
    timestamp: Date.parse(approval.created_at) || Date.now(),
    role: "approval",
    approval,
    status: approval.status,
  });
}

function approvalContent(approval: CommandApprovalRequest): string {
  const command = stringValue(approval.details.command);
  if (approval.status === "approved") {
    return command ? `已允许执行命令: ${command}` : "已允许执行命令";
  }
  if (approval.status === "rejected") {
    return command ? `已拒绝执行命令: ${command}` : "已拒绝执行命令";
  }
  return command ? `等待批准执行命令: ${command}` : approval.title;
}

function applyApprovalStateToCommandMessage(
  view: AgentSessionViewState,
  approval: CommandApprovalRequest,
): void {
  const target = findCommandMessageForApproval(view, approval);
  if (!target) {
    return;
  }
  const commandStatus = commandStatusFromApproval(approval);
  const existingUiPayload = asRecord(target.uiPayload) ?? {};
  const nextUiPayload: Record<string, unknown> = {
    ...existingUiPayload,
    approval: commandApprovalPayload(approval),
  };
  const commandId = stringValue(approval.details.command_id ?? approval.details.commandId);
  if (commandId) {
    nextUiPayload.command_id = commandId;
  }
  const timeoutSeconds = approval.details.timeout_seconds ?? approval.details.timeoutSeconds;
  const timeoutSource = approval.details.timeout_source ?? approval.details.timeoutSource;
  if (timeoutSeconds !== undefined) {
    nextUiPayload.timeout_seconds = timeoutSeconds;
  }
  if (timeoutSource !== undefined) {
    nextUiPayload.timeout_source = timeoutSource;
  }
  const preserveTerminalStatus = shouldPreserveTerminalCommandUiStatus(existingUiPayload, commandStatus);
  if (!preserveTerminalStatus) {
    nextUiPayload.status = commandStatus;
  }
  if (commandStatus === "running" && !preserveTerminalStatus) {
    nextUiPayload.can_terminate = true;
  } else if (commandStatus === "approval_pending" || commandStatus === "rejected") {
    nextUiPayload.can_terminate = false;
  }
  const params = commandParamsFromApproval(approval);
  if (params && !target.toolParams) {
    target.toolParams = params;
  }
  target.uiPayload = nextUiPayload;
  if (commandStatus === "rejected") {
    target.status = "error";
  } else if (!isTerminalToolStatus(target.status)) {
    target.status = "running";
  }
}

function findCommandMessageForApproval(
  view: AgentSessionViewState,
  approval: CommandApprovalRequest,
): AgentChatMessage | undefined {
  const toolName = commandToolNameFromApproval(approval);
  if (!toolName) {
    return undefined;
  }
  const ids = [approval.run_id, approval.call_id, approval.item_id].map((value) => stringValue(value)).filter(Boolean);
  if (ids.length) {
    const idMatch = [...view.messages].reverse().find((message) => {
      if (message.role !== "tool" || message.toolName !== toolName) {
        return false;
      }
      return ids.some((id) => message.runId === id || message.toolCallId === id || commandIdFromMessage(message) === id);
    });
    if (idMatch) {
      return idMatch;
    }
  }
  const params = commandParamsFromApproval(approval);
  if (!params) {
    return undefined;
  }
  return [...view.messages].reverse().find((message) => {
    if (message.role !== "tool" || message.toolName !== toolName || isTerminalToolStatus(message.status)) {
      return false;
    }
    return commandParamsMatch(asRecord(message.toolParams), params);
  });
}

function commandToolNameFromApproval(approval: CommandApprovalRequest): string {
  const toolName = stringValue(approval.tool_name);
  if (isCommandToolName(toolName)) {
    return toolName;
  }
  const detailToolName = stringValue(approval.details.tool_name) || stringValue(approval.details.tool);
  return isCommandToolName(detailToolName) ? detailToolName : "";
}

function commandParamsFromApproval(approval: CommandApprovalRequest): Record<string, unknown> | undefined {
  const details = approval.details;
  const params: Record<string, unknown> = {};
  const command = stringValue(details.command);
  const description = stringValue(details.description) || approval.description;
  const cwd = stringValue(details.cwd);
  const timeoutSeconds = details.timeout_seconds ?? details.timeoutSeconds;
  if (command) {
    params.command = command;
  }
  if (description) {
    params.description = description;
  }
  if (cwd) {
    params.cwd = cwd;
  }
  if (timeoutSeconds !== undefined) {
    params.timeout_seconds = timeoutSeconds;
  }
  return Object.keys(params).length ? params : undefined;
}

function commandStatusFromApproval(approval: CommandApprovalRequest): string {
  if (approval.status === "pending") {
    return "approval_pending";
  }
  if (approval.status === "rejected") {
    return "rejected";
  }
  return "running";
}

function commandApprovalPayload(approval: CommandApprovalRequest): Record<string, unknown> {
  return {
    required: true,
    approval_id: approval.id,
    status: approval.status,
    decision: approval.decision,
    trust_scope: approval.trust_scope,
    trusted_rule_id: approval.trusted_rule_id,
    reject_message: approval.reject_message,
  };
}

function shouldPreserveTerminalCommandUiStatus(
  existingUiPayload: Record<string, unknown>,
  nextStatus: string,
): boolean {
  return nextStatus === "running" && isTerminalCommandUiStatus(stringValue(existingUiPayload.status));
}

function ensureSubagentMessage(
  state: AgentConversationState,
  view: AgentSessionViewState,
  subagentId: string,
  options: {
    subagentName?: string;
    subagentTask?: string;
    subagentRunId?: string;
    streaming?: boolean;
    timestamp?: number;
  } = {},
): AgentChatMessage {
  const existing = view.messages.find(
    (message) => message.role === "subagent" && message.subagentId === subagentId,
  );
  if (existing) {
    if (options.subagentName) {
      existing.subagentName = options.subagentName;
    }
    if (options.subagentTask !== undefined) {
      existing.subagentTask = options.subagentTask;
    }
    if (options.subagentRunId) {
      existing.subagentRunId = options.subagentRunId;
    }
    if (options.streaming !== false) {
      existing.streaming = true;
      existing.status = "streaming";
    }
    existing.subagentToolCalls = existing.subagentToolCalls ?? [];
    existing.subagentItems = existing.subagentItems ?? [];
    return existing;
  }

  const created: AgentChatMessage = {
    id: nextMessageId(state, "subagent", view.sessionId),
    sessionId: view.sessionId,
    role: "subagent",
    content: "",
    timestamp: options.timestamp ?? Date.now(),
    subagentId,
    subagentName: options.subagentName ?? "",
    subagentRunId: options.subagentRunId,
    subagentTask: options.subagentTask ?? "",
    streaming: options.streaming ?? true,
    status: options.streaming === false ? undefined : "streaming",
    subagentToolCalls: [],
    subagentItems: [],
  };
  view.messages.push(created);
  return created;
}

function appendSubagentTextItem(
  state: AgentConversationState,
  message: AgentChatMessage,
  content: string,
  timestamp = Date.now(),
) {
  if (!content) {
    return;
  }
  message.subagentItems = message.subagentItems ?? [];
  const last = message.subagentItems[message.subagentItems.length - 1];
  if (last?.type === "text") {
    last.content += content;
    last.streaming = true;
    return;
  }
  closeSubagentTextStreams(message);
  message.subagentItems.push({
    id: nextMessageId(state, "subagent-text", message.sessionId),
    type: "text",
    content,
    timestamp,
    streaming: true,
  });
}

function closeSubagentTextStreams(message: AgentChatMessage) {
  for (const item of message.subagentItems ?? []) {
    if (item.type === "text") {
      item.streaming = false;
    }
  }
}

function closeReasoningStream(
  view: AgentSessionViewState,
  kind: AgentReasoningKind,
  completedAt: number,
  durationMs: number | null = null,
) {
  const message = [...view.messages]
    .reverse()
    .find((item) => item.role === "reasoning" && item.reasoningKind === kind && item.streaming);
  if (message) {
    completeReasoningDuration(message, completedAt, durationMs);
    message.streaming = false;
    if (message.status === "streaming") {
      message.status = undefined;
    }
  }
}

function closeTopLevelTextStreams(view: AgentSessionViewState, completedAt = Date.now()) {
  for (const message of view.messages) {
    if ((message.role === "assistant" || message.role === "reasoning") && message.streaming) {
      if (message.role === "reasoning") {
        completeReasoningDuration(message, completedAt);
      }
      message.streaming = false;
      if (message.status === "streaming") {
        message.status = undefined;
      }
    }
  }
}

function completeReasoningDuration(
  message: AgentChatMessage,
  completedAt: number,
  explicitDurationMs: number | null = null,
) {
  const elapsed = explicitDurationMs ?? completedAt - message.timestamp;
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    message.reasoningDurationMs = Math.trunc(elapsed);
  }
}

function completeTurnDuration(
  view: AgentSessionViewState,
  completedAt: number,
  turnIndex: number | null,
  traceId: string,
  firstTokenAtMs: number | null,
  preferredTarget?: AgentChatMessage,
) {
  const boundaryIndex = view.messages.findLastIndex((message) => {
    if (message.role !== "user" && message.role !== "turn") {
      return false;
    }
    return isSameBusinessTurn(message, turnIndex);
  });
  const shouldFilterByTrace = turnIndex === null && boundaryIndex < 0 && Boolean(traceId);
  const turnOutputMessages = view.messages
    .slice(boundaryIndex + 1)
    .filter((message) => {
      if (!isTurnOutputMessage(message) || message.cancelled || message.status === "cancelled") {
        return false;
      }
      if (!isSameBusinessTurn(message, turnIndex)) {
        return false;
      }
      return !shouldFilterByTrace || !message.traceId || message.traceId === traceId;
    });
  const assistantMessages = turnOutputMessages.filter(
    (message) => message.role === "assistant" && normalizeMessageContent(message.content).trim(),
  );
  const firstOutput = turnOutputMessages[0];
  const target =
    (preferredTarget && assistantMessages.includes(preferredTarget) ? preferredTarget : undefined) ??
    assistantMessages.at(-1);
  if (!firstOutput || !target || nonNegativeNumber(target.turnDurationMs) !== null) {
    return;
  }
  const elapsed = completedAt - (firstTokenAtMs ?? firstOutput.timestamp);
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    target.turnDurationMs = Math.trunc(elapsed);
  }
}

function isTurnOutputMessage(message: AgentChatMessage): boolean {
  if (message.role === "assistant" || message.role === "reasoning") {
    return Boolean(normalizeMessageContent(message.content).trim());
  }
  return (
    message.role === "tool" ||
    message.role === "subagent" ||
    message.role === "a2ui"
  );
}

function latestStreamingMessage(
  view: AgentSessionViewState,
  role: AgentChatMessage["role"],
): AgentChatMessage | undefined {
  return [...view.messages].reverse().find((message) => message.role === role && message.streaming);
}

function hasStreamingMessage(view: AgentSessionViewState): boolean {
  return view.messages.some((message) => {
    if (message.streaming) {
      return true;
    }
    if (message.role === "tool" && message.status === "running") {
      return true;
    }
    if (message.role !== "subagent") {
      return false;
    }
    return message.subagentItems?.some((item) =>
      item.type === "text" ? item.streaming : item.status === "running",
    ) ?? false;
  });
}

function markTurnInProgress(view: AgentSessionViewState) {
  if (view.runtimeState !== "cancelling" && view.runtimeState !== "closed") {
    view.runtimeState = "running";
  }
}

function isSameBusinessTurn(message: AgentChatMessage, turnIndex: number | null): boolean {
  if (turnIndex === null || message.turnIndex === undefined || message.turnIndex === null) {
    return true;
  }
  return message.turnIndex === turnIndex;
}

function applyTurnFields(message: AgentChatMessage, turnIndex: number | null, traceId: string): void {
  if (turnIndex !== null && (message.turnIndex === undefined || message.turnIndex === null)) {
    message.turnIndex = turnIndex;
  }
  if (traceId && !message.traceId) {
    message.traceId = traceId;
  }
}

function findSubagentTool(
  message: AgentChatMessage,
  runId: string,
): (AgentSubagentToolItem | AgentToolCall) | undefined {
  const item = message.subagentItems?.find(
    (entry): entry is AgentSubagentToolItem => entry.type === "tool" && entry.runId === runId,
  );
  return item ?? message.subagentToolCalls?.find((tool) => tool.runId === runId);
}

function toolCallFromStart(data: AgentToolEventData, toolName: string): AgentToolCall {
  const fileChanges = normalizedFileChanges(data.files);
  const call: AgentToolCall = {
    runId: data.run_id,
    parentRunId: data.parent_run_id ?? null,
    toolName,
    toolParams: data.params ?? data.input_data,
    status: "running",
    uiPayload: mergeToolFilesIntoUiPayload(data.ui_payload, fileChanges),
    metadata: toolMetadataFromData(data),
  };
  if (data.tool_call_id) {
    call.toolCallId = data.tool_call_id;
  }
  if (fileChanges.length) {
    call.fileChanges = fileChanges;
  }
  return call;
}

function applyToolProgress(
  target: AgentToolCall | AgentChatMessage,
  data: AgentToolProgressData,
  toolName: string,
) {
  const commandPayload = commandPayloadFromToolData(data);
  if (data.run_id && shouldAcceptProgressRunId(target, data)) {
    target.runId = data.run_id;
  }
  target.toolCallId = data.tool_call_id ?? target.toolCallId;
  target.toolName = toolName || target.toolName;
  target.toolParams = data.params ?? data.input_data ?? commandToolParams(commandPayload) ?? target.toolParams;
  target.status = toolStatusFromCommandPayload(commandPayload, data.status);
  const fileChanges = normalizedFileChanges(data.files);
  if (fileChanges.length) {
    target.fileChanges = fileChanges;
    target.uiPayload = mergeToolFilesIntoUiPayload(
      commandPayload ? { ...(target.uiPayload ?? {}), ...commandPayload } : data.ui_payload ?? target.uiPayload,
      fileChanges,
    );
  } else {
    target.uiPayload = commandPayload ? { ...(target.uiPayload ?? {}), ...commandPayload } : data.ui_payload ?? target.uiPayload;
  }
  target.metadata = toolMetadataFromData(data) ?? target.metadata;
}

function shouldAcceptProgressRunId(
  target: AgentToolCall | AgentChatMessage,
  data: AgentToolProgressData,
): boolean {
  if (!target.runId) {
    return true;
  }
  if (!target.toolCallId) {
    return true;
  }
  return target.runId === target.toolCallId || target.runId === data.tool_call_id;
}

function applyToolEnd(
  target: AgentToolCall | AgentChatMessage,
  result: string,
  durationMs: number | undefined,
  status: AgentToolStatus,
  error: string,
  errorType: string,
  errorEnvelope: TurnError | undefined,
  data: AgentToolEventData,
) {
  target.status = status;
  target.toolResult = result;
  target.toolDurationMs = durationMs;
  target.toolError = error || undefined;
  target.toolErrorType = errorType || undefined;
  target.error = errorEnvelope;
  const structured = structuredToolOutput(data);
  target.uiPayload = data.ui_payload ?? structured ?? target.uiPayload;
  const fileChanges = normalizedFileChanges(
    data.files ?? fileChangesFromUiPayload(target.uiPayload),
  );
  if (fileChanges.length) {
    target.fileChanges = fileChanges;
    target.uiPayload = mergeToolFilesIntoUiPayload(target.uiPayload, fileChanges);
  }
  target.metadata = toolMetadataFromData(data) ?? target.metadata;
}

function toolMetadataFromData(
  data: AgentToolEventData | AgentToolProgressData,
): Record<string, unknown> | undefined {
  const existing = asRecord(data.metadata);
  const mcp = mcpMetadataFromToolData(data);
  if (!existing && !mcp) {
    return undefined;
  }
  const metadata = existing ? { ...existing } : {};
  if (mcp) {
    metadata.mcp = {
      ...(asRecord(metadata.mcp) ?? {}),
      ...mcp,
    };
  }
  return metadata;
}

function mcpMetadataFromToolData(
  data: AgentToolEventData | AgentToolProgressData,
): Record<string, unknown> | undefined {
  const record = asRecord(data) ?? {};
  const existing = asRecord(asRecord(data.metadata)?.mcp);
  const kind = stringValue(record.kind) || stringValue(existing?.kind);
  const serverId = stringValue(record.server_id) || stringValue(existing?.server_id);
  const rawToolName = stringValue(record.raw_tool_name) || stringValue(existing?.raw_tool_name);
  const modelToolName =
    stringValue(record.model_tool_name) ||
    stringValue(existing?.model_tool_name) ||
    stringValue(existing?.model_name);
  if (kind !== "mcp_tool" && !(serverId && rawToolName && modelToolName)) {
    return undefined;
  }
  const mcp: Record<string, unknown> = {
    ...(existing ?? {}),
    kind: "mcp_tool",
  };
  setIfPresent(mcp, "snapshot_id", stringValue(record.snapshot_id) || stringValue(existing?.snapshot_id));
  setIfPresent(mcp, "server_id", serverId);
  setIfPresent(mcp, "server_name", nullableString(record.server_name) ?? nullableString(existing?.server_name));
  setIfPresent(mcp, "raw_tool_name", rawToolName);
  setIfPresent(mcp, "model_tool_name", modelToolName);
  setIfPresent(mcp, "model_name", stringValue(existing?.model_name) || modelToolName);
  setIfPresent(mcp, "approval_mode", stringValue(record.approval_mode) || stringValue(existing?.approval_mode));
  return mcp;
}

function setIfPresent(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined && value !== null && value !== "") {
    target[key] = value;
  }
}

function toolNameFromData(data: AgentToolEventData): string {
  return stringValue(data.tool_name) || stringValue(data.tool) || data.run_id;
}

function commandPayloadFromToolData(data: AgentToolEventData | AgentToolProgressData): Record<string, unknown> | undefined {
  const direct = asRecord(data);
  const uiPayload = asRecord(data.ui_payload);
  if (uiPayload && isCommandPayload(uiPayload)) {
    return uiPayload;
  }
  if (direct && isCommandPayload(direct)) {
    return direct;
  }
  return undefined;
}

function isCommandPayload(value: Record<string, unknown>): boolean {
  const kind = stringValue(value.kind);
  return kind === "command_progress" || kind === "command_result" || Boolean(stringValue(value.command_id));
}

function commandToolParams(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined;
  }
  const command = stringValue(payload.command);
  const cwd = stringValue(payload.cwd);
  const timeoutSeconds = payload.timeout_seconds;
  const description = stringValue(payload.description);
  const params: Record<string, unknown> = {};
  if (command) {
    params.command = command;
  }
  if (description) {
    params.description = description;
  }
  if (cwd) {
    params.cwd = cwd;
  }
  if (timeoutSeconds !== undefined) {
    params.timeout_seconds = timeoutSeconds;
  }
  return Object.keys(params).length ? params : undefined;
}

function toolStatusFromCommandPayload(
  payload: Record<string, unknown> | undefined,
  fallback: AgentToolEventData["status"],
): AgentToolStatus {
  const commandStatus = stringValue(payload?.status);
  if (commandStatus === "running" || commandStatus === "terminating") {
    return "running";
  }
  if (commandStatus === "cancelled") {
    return "cancelled";
  }
  if (commandStatus === "completed") {
    return "completed";
  }
  if (commandStatus) {
    return "error";
  }
  if (fallback === "cancelled") {
    return "cancelled";
  }
  if (fallback === "completed" || fallback === "success") {
    return "completed";
  }
  if (fallback === "failed" || fallback === "error") {
    return "error";
  }
  return "running";
}

function shouldIgnoreLateCommandProgress(
  target: AgentToolCall | AgentChatMessage,
  data: AgentToolProgressData,
): boolean {
  const payload = commandPayloadFromToolData(data);
  if (!payload || !["running", "terminating"].includes(stringValue(payload.status))) {
    return false;
  }
  return isTerminalToolStatus(target.status);
}

function commandIdFromMessage(message: AgentChatMessage): string {
  return stringValue(asRecord(message.uiPayload)?.command_id);
}

function isTerminalToolStatus(status: AgentToolStatus | AgentChatMessage["status"] | undefined): boolean {
  return status === "completed" || status === "cancelled" || status === "error";
}

function isTerminalCommandUiStatus(status: string): boolean {
  return [
    "completed",
    "timed_out",
    "cancelled",
    "failed_to_start",
    "shell_not_available",
    "output_limit_exceeded",
    "rejected",
  ].includes(status);
}

function toolResultFromData(data: AgentToolEventData): string {
  if (typeof data.result === "string") {
    return data.result;
  }
  if (data.output_data !== undefined) {
    return JSON.stringify(data.output_data);
  }
  if (data.result !== undefined) {
    return JSON.stringify(data.result);
  }
  return "";
}

function structuredToolOutput(data: AgentToolEventData): Record<string, unknown> | undefined {
  if (data.output_data && typeof data.output_data === "object" && !Array.isArray(data.output_data)) {
    const result = data.output_data.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
  }
  if (data.result && typeof data.result === "object" && !Array.isArray(data.result)) {
    return data.result as Record<string, unknown>;
  }
  return undefined;
}

function findMatchingProgressTool(
  view: AgentSessionViewState,
  data: AgentToolEventData | AgentToolProgressData,
  toolName: string,
): AgentChatMessage | undefined {
  const commandPayload = commandPayloadFromToolData(data);
  const commandId = stringValue(commandPayload?.command_id);
  if (commandId && isCommandToolName(toolName)) {
    const commandMatch = [...view.messages].reverse().find((message) => {
      if (message.role !== "tool" || message.toolName !== toolName) {
        return false;
      }
      return commandIdFromMessage(message) === commandId;
    });
    if (commandMatch) {
      return commandMatch;
    }
  }
  const commandParams = commandParamsFromToolData(data, toolName);
  if (commandParams) {
    const commandMatch = [...view.messages].reverse().find((message) => {
      if (message.role !== "tool" || message.toolName !== toolName || isTerminalToolStatus(message.status)) {
        return false;
      }
      const existingCommandId = commandIdFromMessage(message);
      if (existingCommandId && commandId && existingCommandId !== commandId) {
        return false;
      }
      return commandParamsMatch(asRecord(message.toolParams), commandParams);
    });
    if (commandMatch) {
      return commandMatch;
    }
  }
  const targetPaths = fileChangePaths(normalizedFileChanges(data.files));
  const params = asRecord(data.params) ?? asRecord(data.input_data);
  const paramsPath = stringValue(params?.path);
  if (paramsPath) {
    targetPaths.add(paramsPath);
  }
  for (const path of fileChangePathsFromPatch(stringValue(params?.patch))) {
    targetPaths.add(path);
  }
  return [...view.messages]
    .reverse()
    .find((message) => {
      if (message.role !== "tool" || message.toolName !== toolName || message.status !== "running") {
        return false;
      }
      if (data.tool_call_id && message.toolCallId === data.tool_call_id) {
        return true;
      }
      if (!targetPaths.size) {
        return false;
      }
      const messagePaths = fileChangePaths(message.fileChanges ?? fileChangesFromUiPayload(message.uiPayload));
      const messageParamsPath = stringValue(asRecord(message.toolParams)?.path);
      if (messageParamsPath) {
        messagePaths.add(messageParamsPath);
      }
      for (const path of fileChangePathsFromPatch(stringValue(asRecord(message.toolParams)?.patch))) {
        messagePaths.add(path);
      }
      return [...targetPaths].some((path) => messagePaths.has(path));
    });
}

function isCommandToolName(value: string): boolean {
  return value === "run_git_bash" || value === "run_cmd" || value === "run_powershell";
}

function isThreadTaskToolName(value: string): boolean {
  return value === "update_thread_task" || value === "get_thread_task";
}

function commandParamsFromToolData(
  data: AgentToolEventData | AgentToolProgressData,
  toolName: string,
): Record<string, unknown> | undefined {
  if (!isCommandToolName(toolName)) {
    return undefined;
  }
  const payloadParams = commandToolParams(commandPayloadFromToolData(data));
  if (payloadParams) {
    return payloadParams;
  }
  return commandParamsFromRaw(asRecord(data.params) ?? asRecord(data.input_data));
}

function commandParamsFromRaw(value: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const params: Record<string, unknown> = {};
  const command = stringValue(value.command);
  const description = stringValue(value.description);
  const cwd = stringValue(value.cwd);
  const timeoutSeconds = value.timeout_seconds ?? value.timeoutSeconds;
  if (command) {
    params.command = command;
  }
  if (description) {
    params.description = description;
  }
  if (cwd) {
    params.cwd = cwd;
  }
  if (timeoutSeconds !== undefined) {
    params.timeout_seconds = timeoutSeconds;
  }
  return Object.keys(params).length ? params : undefined;
}

function commandParamsMatch(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): boolean {
  const existingCommand = stringValue(existing?.command).trim();
  const incomingCommand = stringValue(incoming.command).trim();
  if (!existingCommand || !incomingCommand || existingCommand !== incomingCommand) {
    return false;
  }
  return (
    commandOptionalParamCompatible(existing, incoming, "cwd") &&
    commandOptionalParamCompatible(existing, incoming, "description") &&
    commandOptionalParamCompatible(existing, incoming, "timeout_seconds")
  );
}

function commandOptionalParamCompatible(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  key: string,
): boolean {
  const left = commandScalarValue(existing?.[key]).trim();
  const right = commandScalarValue(incoming[key]).trim();
  return !left || !right || left === right;
}

function commandScalarValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function fileChangePathsFromPatch(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/u.exec(line.trim());
    if (match?.[1]) {
      paths.add(match[1]);
    }
  }
  return paths;
}

function normalizedFileChanges(value: unknown): AgentFileChange[] {
  const rawFiles = Array.isArray(value) ? value : [];
  return rawFiles.map((item, index) => normalizeFileChange(asRecord(item), index)).filter(isDefined);
}

function normalizeFileChange(record: Record<string, unknown> | null, index: number): AgentFileChange | null {
  if (!record) {
    return null;
  }
  const path = stringValue(record.path) || `file-${index + 1}`;
  const added = numberValue(record.added_lines) ?? numberValue(record.additions) ?? 0;
  const deleted =
    numberValue(record.deleted_lines) ??
    numberValue(record.removed_lines) ??
    numberValue(record.deletions) ??
    0;
  return {
    ...record,
    path,
    added_lines: added,
    deleted_lines: deleted,
    removed_lines: deleted,
    additions: added,
    deletions: deleted,
  };
}

function fileChangesFromUiPayload(uiPayload: Record<string, unknown> | undefined): AgentFileChange[] {
  if (!uiPayload) {
    return [];
  }
  const source = Array.isArray(uiPayload.files) ? uiPayload.files : uiPayload.changes;
  return normalizedFileChanges(source);
}

function mergeToolFilesIntoUiPayload(
  uiPayload: Record<string, unknown> | undefined,
  files: unknown,
): Record<string, unknown> | undefined {
  const fileChanges = normalizedFileChanges(files);
  if (!uiPayload && !fileChanges.length) {
    return undefined;
  }
  return {
    ...(uiPayload ?? {}),
    ...(fileChanges.length ? { files: fileChanges } : {}),
  };
}

function fileChangePaths(files: AgentFileChange[]): Set<string> {
  return new Set(files.map((file) => file.path).filter(Boolean));
}

function toolStatusFromEnd(status: AgentToolEventData["status"], error: string): AgentToolStatus {
  if (error) {
    return "error";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "success") {
    return "completed";
  }
  return status ?? "completed";
}

function sessionFromData(data: Record<string, unknown>): AgentSession | null {
  const session = asRecord(data.session);
  if (session && typeof session.id === "string") {
    return normalizeSession(session);
  }
  const sessionId = sessionIdFromData(data);
  return sessionId ? normalizeSession({ ...data, id: sessionId }) : null;
}

function normalizeSession(data: Record<string, unknown>): AgentSession {
  const now = new Date(0).toISOString();
  const status = stringValue(data.status);
  const sessionType = stringValue(data.session_type);
  const pinnedAt = nullableString(data.pinned_at);
  return {
    id: stringValue(data.id) || stringValue(data.session_id),
    user_id: stringValue(data.user_id) || "local-user",
    scene_id: stringValue(data.scene_id) || "desktop-agent",
    status: isAgentSessionStatus(status) ? status : "active",
    title: typeof data.title === "string" ? data.title : null,
    title_source: nullableString(data.title_source) as AgentSession["title_source"],
    session_tag: stringValue(data.session_tag) || "chat",
    session_type: isAgentSessionType(sessionType) ? sessionType : "chat",
    workspace_id: nullableString(data.workspace_id),
    cwd: nullableString(data.cwd),
    workspace_roots: stringArray(data.workspace_roots),
    workspace: normalizeWorkspace(data.workspace),
    active_session_id: nullableString(data.active_session_id),
    parent_session_id: nullableString(data.parent_session_id),
    child_session_id: nullableString(data.child_session_id),
    source_trace_id: nullableString(data.source_trace_id),
    source_active_session_id: nullableString(data.source_active_session_id),
    source_checkpoint_id: nullableString(data.source_checkpoint_id),
    source_checkpoint_ns: nullableString(data.source_checkpoint_ns),
    fork_source: normalizeSessionFork(data.fork_source),
    created_at: stringValue(data.created_at) || now,
    updated_at: stringValue(data.updated_at) || now,
    archived_at: nullableString(data.archived_at),
    archive_origin:
      data.archive_origin === "manual" || data.archive_origin === "project"
        ? data.archive_origin
        : null,
    is_debug: Boolean(data.is_debug),
    is_scheduled: Boolean(data.is_scheduled),
    is_current: Boolean(data.is_current),
    current_model_provider_id: nullableString(data.current_model_provider_id),
    current_model: nullableString(data.current_model),
    context_window_usage: normalizeContextWindowUsageSnapshot(data.context_window_usage),
    pinned: data.pinned === true || Boolean(pinnedAt),
    pinned_at: pinnedAt,
    scene_version_seq: typeof data.scene_version_seq === "number" ? data.scene_version_seq : null,
  };
}

function normalizeContextWindowUsageSnapshot(value: unknown): AgentMiddlewareProgressData | null {
  const data = asRecord(value);
  if (!data) {
    return null;
  }
  const tokenCount = numberValue(data.token_count);
  const contextWindow = numberValue(data.context_window);
  if (tokenCount === null || contextWindow === null) {
    return null;
  }
  return data as AgentMiddlewareProgressData;
}

function normalizeSessionFork(value: unknown): AgentSession["fork_source"] {
  const data = asRecord(value);
  if (!data) {
    return null;
  }
  const id = stringValue(data.id);
  const sourceSessionId = stringValue(data.source_session_id);
  const targetSessionId = stringValue(data.target_session_id);
  const sourceMessageEventId = stringValue(data.source_message_event_id);
  const targetMessageEventId = stringValue(data.target_message_event_id);
  if (!id || !sourceSessionId || !targetSessionId || !sourceMessageEventId || !targetMessageEventId) {
    return null;
  }
  return {
    id,
    source_session_id: sourceSessionId,
    target_session_id: targetSessionId,
    source_message_event_id: sourceMessageEventId,
    target_message_event_id: targetMessageEventId,
    source_turn_index: numberValue(data.source_turn_index) ?? 0,
    target_turn_index: numberValue(data.target_turn_index) ?? 0,
    source_trace_id: nullableString(data.source_trace_id),
    source_active_session_id: nullableString(data.source_active_session_id),
    source_checkpoint_id: nullableString(data.source_checkpoint_id),
    source_checkpoint_ns: nullableString(data.source_checkpoint_ns),
    relation_type: stringValue(data.relation_type) || "fork",
    created_at: stringValue(data.created_at) || new Date(0).toISOString(),
    updated_at: stringValue(data.updated_at) || new Date(0).toISOString(),
    target_title: nullableString(data.target_title),
    source_title: nullableString(data.source_title),
  };
}

function normalizeWorkspace(value: unknown): Workspace | null {
  const workspace = asRecord(value);
  if (!workspace || !stringValue(workspace.id)) {
    return null;
  }
  return {
    id: stringValue(workspace.id),
    name: stringValue(workspace.name),
    root_path: stringValue(workspace.root_path),
    normalized_root_path: stringValue(workspace.normalized_root_path),
    type: stringValue(workspace.type) || "project",
    created_at: stringValue(workspace.created_at),
    updated_at: stringValue(workspace.updated_at),
    last_opened_at: nullableString(workspace.last_opened_at),
    archived_at: nullableString(workspace.archived_at),
  };
}

function metaFromSession(session: AgentSession): Partial<AgentSessionViewState> {
  return {
    sessionId: session.id,
    sceneId: session.scene_id,
    userId: session.user_id,
    status: session.status,
    runtimeState: runtimeStateFromSessionStatus(session.status),
  };
}

function runtimeStateFromSessionStatus(status: AgentSessionStatus): AgentSessionRuntimeState {
  if (status === "running") {
    return "running";
  }
  if (status === "waiting_approval") {
    return "waiting_approval";
  }
  if (status === "waiting_input") {
    return "waiting_input";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "closed") {
    return "closed";
  }
  return "idle";
}

function mergeIncomingRuntimeState(
  current: AgentSessionRuntimeState,
  incoming: AgentSessionRuntimeState | undefined,
): AgentSessionRuntimeState {
  if (!incoming) {
    return current;
  }
  if (incoming === "idle" && isActiveRuntimeState(current)) {
    return current;
  }
  return incoming;
}

function isActiveRuntimeState(state: AgentSessionRuntimeState): boolean {
  return state === "running" || state === "waiting_approval" || state === "waiting_input" || state === "cancelling";
}

function sessionIdFromData(data: Record<string, unknown>): string {
  return stringValue(data.session_id) || stringValue(data.id);
}

function eventIdentity(event: AgentActionEnvelope): string {
  const data = event.data;
  if (event.action.startsWith("pending_input_")) {
    const pendingInputId = stringValue(data.pending_input_id) || stringValue(data.id);
    if (!pendingInputId) {
      return "";
    }
    const sessionId = sessionIdFromData(data);
    const revision = [
      stringValue(data.status),
      stringValue(data.mode),
      stringValue(data.updated_at),
      stringValue(data.delivered_at),
      stringValue(data.cancelled_at),
      stringValue(data.paused_at),
      stringValue(data.pause_reason),
    ].filter(Boolean).join(":");
    return [event.action, sessionId, pendingInputId, revision].filter(Boolean).join(":");
  }
  const raw =
    stringValue(data.event_id) ||
    stringValue(data.message_event_id) ||
    stringValue(data.id) ||
    stringValue(data.seq);
  if (!raw) {
    return "";
  }
  const sessionId = sessionIdFromData(data);
  return [event.action, sessionId, raw].filter(Boolean).join(":");
}

function cloneState(state: AgentConversationState): AgentConversationState {
  return {
    ...state,
    sessionIds: [...state.sessionIds],
    sessionsById: { ...state.sessionsById },
    sessionStateById: { ...state.sessionStateById },
    processedEventIds: { ...state.processedEventIds },
  };
}

function cloneMessage(message: AgentChatMessage): AgentChatMessage {
  return {
    ...message,
    approval: message.approval ? { ...message.approval, details: { ...message.approval.details } } : undefined,
    attachments: message.attachments ? [...message.attachments] : undefined,
    subagentToolCalls: message.subagentToolCalls?.map((tool) => ({ ...tool })),
    subagentItems: message.subagentItems?.map((item) => ({ ...item })),
  };
}

function cloneThreadTask(task: ThreadTask): ThreadTask {
  return {
    ...task,
    metadata: { ...task.metadata },
    evidence: [...task.evidence],
    blocked_audit: { ...task.blocked_audit },
    token_usage: { ...task.token_usage },
  };
}

function cloneThreadTaskRun(run: ThreadTaskRun): ThreadTaskRun {
  return {
    ...run,
    summary: { ...run.summary },
    error: { ...run.error },
  };
}

function upsertThreadTask(view: AgentSessionViewState, incoming: ThreadTask): void {
  const task = cloneThreadTask(incoming);
  const existingIndex = view.threadTasks.findIndex((item) => item.id === task.id);
  if (existingIndex >= 0) {
    view.threadTasks = view.threadTasks.map((item, index) => (index === existingIndex ? task : item));
  } else {
    view.threadTasks = [task, ...view.threadTasks];
  }
  view.threadTasks = sortThreadTasks(view.threadTasks);
  view.activeTask = firstOpenThreadTask(view.threadTasks);
}

function sortThreadTasks(tasks: ThreadTask[]): ThreadTask[] {
  return [...tasks].sort((left, right) => {
    const updatedDiff = Date.parse(right.updated_at || "") - Date.parse(left.updated_at || "");
    if (updatedDiff) {
      return updatedDiff;
    }
    return right.id.localeCompare(left.id);
  });
}

function firstOpenThreadTask(tasks: ThreadTask[]): ThreadTask | null {
  return tasks.find(isOpenThreadTask) ?? null;
}

function isOpenThreadTask(task: ThreadTask): boolean {
  return Boolean(task.is_open && !task.is_terminal && !task.deleted_at);
}

function threadTaskFromData(value: unknown): ThreadTask | null {
  const data = asRecord(value);
  if (!data) {
    return null;
  }
  const id = stringValue(data.id);
  const sessionId = stringValue(data.session_id);
  const objective = stringValue(data.objective);
  if (!id || !sessionId || !objective) {
    return null;
  }
  const status = stringValue(data.status) as ThreadTask["status"];
  const type = stringValue(data.type) as ThreadTask["type"];
  const createdAt = stringValue(data.created_at) || new Date(0).toISOString();
  const updatedAt = stringValue(data.updated_at) || createdAt;
  return {
    id,
    session_id: sessionId,
    type: type || "goal",
    type_label: stringValue(data.type_label) || "任务",
    title: nullableString(data.title),
    objective,
    status: status || "active",
    metadata: asRecord(data.metadata) ?? {},
    evidence: Array.isArray(data.evidence) ? [...data.evidence] : [],
    blocked_audit: asRecord(data.blocked_audit) ?? {},
    system_stop_reason: nullableString(data.system_stop_reason),
    current_run_id: nullableString(data.current_run_id),
    turn_count: numberValue(data.turn_count) ?? 0,
    elapsed_seconds: numberValue(data.elapsed_seconds) ?? 0,
    token_usage: asRecord(data.token_usage) ?? {},
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: nullableString(data.deleted_at),
    is_open: data.is_open === undefined ? !Boolean(data.is_terminal) : Boolean(data.is_open),
    is_terminal: Boolean(data.is_terminal),
  };
}

function threadTaskRunFromData(value: unknown): ThreadTaskRun | null {
  const data = asRecord(value);
  if (!data) {
    return null;
  }
  const id = stringValue(data.id);
  const taskId = stringValue(data.task_id);
  const sessionId = stringValue(data.session_id);
  if (!id || !taskId || !sessionId) {
    return null;
  }
  const status = stringValue(data.status) as ThreadTaskRun["status"];
  const createdAt = stringValue(data.created_at) || new Date(0).toISOString();
  const updatedAt = stringValue(data.updated_at) || createdAt;
  return {
    id,
    task_id: taskId,
    session_id: sessionId,
    turn_index: numberValue(data.turn_index),
    trace_id: nullableString(data.trace_id),
    status: status || "running",
    summary: asRecord(data.summary) ?? {},
    error: asRecord(data.error) ?? {},
    started_at: nullableString(data.started_at),
    finished_at: nullableString(data.finished_at),
    created_at: createdAt,
    updated_at: updatedAt,
    is_running: data.is_running === undefined ? status === "running" : Boolean(data.is_running),
  };
}

function isVisibleCompressionProgressStage(stage: string): boolean {
  return ["compression_started", "compression_completed", "compression_failed"].includes(stage);
}

function isLLMRetryProgress(data: AgentMiddlewareProgressData): boolean {
  return data.middleware === "LLMRetry" || data.kind === "llm_retry";
}

function llmRetryNoticeId(data: AgentMiddlewareProgressData, sessionId: string): string {
  return (
    stringValue(data.notice_id) ||
    `llm-retry:${stringValue(data.trace_id) || sessionId}`
  );
}

function llmRetryContent(data: AgentMiddlewareProgressData, stage: string): string {
  const retryIndex = llmRetryIndex(data);
  const maxRetries = llmMaxRetries(data);
  if (stage === "recovered" || stage === "completed") {
    return "LLM 请求重试成功";
  }
  if (stage === "failed") {
    return `LLM 请求重试失败 ${retryIndex}/${maxRetries}`;
  }
  return `LLM 请求正在重试 ${retryIndex}/${maxRetries}`;
}

function llmRetryStatus(stage: string): AgentChatMessage["status"] {
  if (stage === "failed") {
    return "failed";
  }
  if (stage === "recovered" || stage === "completed") {
    return "completed";
  }
  return "running";
}

function llmRetryIndex(data: AgentMiddlewareProgressData): number {
  return numberValue(data.retry_index) ?? 1;
}

function llmMaxRetries(data: AgentMiddlewareProgressData): number {
  return numberValue(data.max_retries) ?? 3;
}

function contextCompressionContent(stage: string): string {
  if (stage === "compression_started") {
    return "正在压缩上下文";
  }
  if (stage === "compression_completed") {
    return "上下文压缩已完成";
  }
  if (stage === "compression_failed") {
    return "上下文压缩失败";
  }
  return "上下文压缩已完成";
}

function contextCompressionStatus(stage: string): AgentChatMessage["status"] {
  if (stage === "compression_started") {
    return "running";
  }
  if (stage === "compression_failed") {
    return "failed";
  }
  return "completed";
}

function contextCompressionMode(data: AgentMiddlewareProgressData, stage: string): string {
  const mode = stringValue(data.compression_mode);
  if (mode) {
    return mode;
  }
  return "context";
}

function contextCompressionNoticeId(data: AgentMiddlewareProgressData, sessionId: string): string {
  const noticeId = stringValue(data.notice_id);
  if (noticeId) {
    return noticeId;
  }
  const noticeKey = stringValue(data.trace_id) || sessionId;
  const operationId = stringValue(data.compression_operation_id) || stringValue(data.boundary_id);
  return operationId
    ? `context-compression:${noticeKey}:${operationId}`
    : `context-compression:${noticeKey}`;
}

function compressionNoticeIdFromMessage(message: AgentChatMessage): string {
  const compression = asRecord(message.metadata?.compression);
  return stringValue(compression?.notice_id);
}

function nextMessageId(state: AgentConversationState, prefix: string, sessionId: string): string {
  state.messageSeq += 1;
  return `${prefix}:${sessionId}:${state.messageSeq}`;
}

function sortSessionIds(sessions: AgentSession[]): string[] {
  return uniqueById(sessions)
    .filter((session) => !isInternalAgentSession(session))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .map((session) => session.id);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stableJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function scalarStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampFromData(data: object): number {
  const record = data as { messageTimeMs?: unknown; timestamp_ms?: unknown; timestamp?: unknown };
  const timestamp =
    realTimestampMs(record.messageTimeMs) ?? realTimestampMs(record.timestamp_ms) ?? realTimestampMs(record.timestamp);
  return timestamp ?? Date.now();
}

function realTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1_000_000_000_000) {
    return null;
  }
  return Math.trunc(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isAgentSessionType(value: string): value is AgentSessionType {
  return value === "chat" || value === "workspace";
}

function isAgentSessionStatus(value: string): value is AgentSessionStatus {
  return value === "active"
    || value === "running"
    || value === "waiting_approval"
    || value === "waiting_input"
    || value === "closed"
    || value === "failed";
}

function isRuntimeState(value: string): value is AgentSessionRuntimeState {
  return value === "idle"
    || value === "running"
    || value === "waiting_approval"
    || value === "waiting_input"
    || value === "cancelling"
    || value === "failed"
    || value === "closed";
}

function isApprovalStatus(value: string): value is CommandApprovalRequest["status"] {
  return ["pending", "approved", "rejected", "expired", "cancelled"].includes(value);
}

function isApprovalDecision(value: string): value is NonNullable<CommandApprovalRequest["decision"]> {
  return value === "approved" || value === "rejected";
}

function isTrustScope(value: string): value is NonNullable<CommandApprovalRequest["trust_scope"]> {
  return value === "once"
    || value === "persistent"
    || value === "session"
    || value === "persistent_tool"
    || value === "persistent_server";
}

function isRuleMatchType(value: string): value is NonNullable<CommandApprovalRequest["rule_match_type"]> {
  return value === "exact" || value === "prefix";
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
