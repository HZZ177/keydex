import type {
  AgentActionEnvelope,
  AgentChatMessage,
  AgentChatMessagePayload,
  AgentCompletedPayload,
  AgentErrorData,
  CommandApprovalRequest,
  AgentGhostStats,
  AgentHistoryResponse,
  AgentMiddlewareProgressData,
  AgentReasoningData,
  AgentReasoningKind,
  AgentSession,
  AgentSessionStatus,
  AgentSessionType,
  AgentStreamActionData,
  AgentSubagentItem,
  AgentSubagentToolItem,
  AgentFileChange,
  AgentToolCall,
  AgentToolEventData,
  AgentToolProgressData,
  AgentToolStatus,
  Workspace,
} from "@/types/protocol";

export type AgentSessionRuntimeState = "idle" | "running" | "waiting_approval" | "cancelling" | "failed" | "closed";

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
    case "system_message":
      next = handleSystemMessage(state, event.data);
      break;
    case "reasoning":
      next = handleReasoning(state, event.data as unknown as AgentReasoningData);
      break;
    case "middleware_progress":
      next = handleMiddlewareProgress(state, event.data as unknown as AgentMiddlewareProgressData);
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
    case "subagent_start":
      next = handleSubagentStart(state, event.data);
      break;
    case "subagent_end":
      next = handleSubagentEnd(state, event.data);
      break;
    case "subagent_error":
      next = handleSubagentError(state, event.data);
      break;
    case "completed":
      next = handleCompleted(state, event.data as unknown as AgentCompletedPayload);
      break;
    case "cancelled":
      next = handleCancelled(state, event.data);
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
    case "workspaceSkillsChanged":
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
  return state.sessionIds.map((id) => state.sessionsById[id]).filter(isDefined);
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
  const currentView = state.sessionStateById[sessionId];
  if (
    currentView?.isStreaming ||
    currentView?.runtimeState === "running" ||
    currentView?.runtimeState === "waiting_approval" ||
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
  const hydratedMessages = history.list.map((payload, index) => historyMessageFromPayload(sessionId, payload, index));
  view.messages = mergeActiveLocalMessages(hydratedMessages, previousView);
  view.hydrated = true;
  view.historyLoading = false;
  view.historyCursor = history.next_cursor ?? null;
  view.historyHasMoreOlder = Boolean(history.has_more_older && history.next_cursor);
  view.hasUnread = false;
  view.stale = false;
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
  const incoming = history.list.map((payload, index) => historyMessageFromPayload(sessionId, payload, index));
  const incomingIds = new Set(incoming.map((message) => message.id));
  view.messages = [...incoming, ...view.messages.filter((message) => !incomingIds.has(message.id))];
  view.historyCursor = history.next_cursor ?? null;
  view.historyHasMoreOlder = Boolean(history.has_more_older && history.next_cursor);
  view.hasUnread = false;
  view.historyLoading = false;
  view.hydrated = true;
  view.stale = false;
  applyHydratedRuntimeState(view, previousView);
  return next;
}

function mergeActiveLocalMessages(
  hydratedMessages: AgentChatMessage[],
  previousView?: AgentSessionViewState,
): AgentChatMessage[] {
  if (!previousView || !isActiveRuntimeState(previousView.runtimeState)) {
    return hydratedMessages;
  }

  const merged = [...hydratedMessages];
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

function shouldPreserveActiveLocalMessage(message: AgentChatMessage): boolean {
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
  let runtimeState = pendingApproval
    ? "waiting_approval"
    : hasStreamingMessage
      ? "running"
      : runtimeStateFromSessionStatus(view.status);

  if (runtimeState === "idle" && previousView && isActiveRuntimeState(previousView.runtimeState)) {
    runtimeState = previousView.runtimeState === "waiting_approval" ? runtimeState : previousView.runtimeState;
  }

  view.runtimeState = runtimeState;
  view.pendingApproval = pendingApproval;
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

function handleStream(state: AgentConversationState, data: AgentStreamActionData): AgentConversationState {
  const sessionId = data.session_id;
  const content = stringValue(data.content) || stringValue(data.text);
  if (!sessionId || !content) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const eventTimestamp = timestampFromData(data);
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
    const message = last?.role === "assistant" && last.streaming ? last : undefined;
    if (message) {
      message.content += content;
    } else {
      closeTopLevelTextStreams(view);
      view.messages.push({
        id: nextMessageId(next, "assistant", sessionId),
        sessionId,
        role: "assistant",
        content,
        timestamp: eventTimestamp,
        streaming: true,
        status: "streaming",
      });
    }
  }
  view.isStreaming = true;
  markTurnInProgress(view);
  return next;
}

function handleSystemMessage(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  const content = stringValue(data.content) || stringValue(data.text);
  if (!sessionId || !content) {
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

function handleMiddlewareProgress(
  state: AgentConversationState,
  data: AgentMiddlewareProgressData,
): AgentConversationState {
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

  const noticeId = contextCompressionNoticeId(data, stage, sessionId);
  const metadata = {
    compression: {
      kind: "context_compression",
      stage,
      mode: contextCompressionMode(data, stage),
      notice_id: noticeId,
      reason: data.reason ?? null,
      staging_id: data.staging_id ?? null,
      anchor_message_id: data.anchor_message_id ?? null,
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
  const existing = view.messages.find((message) => {
    const compression = asRecord(message.metadata?.compression);
    return stringValue(compression?.notice_id) === noticeId;
  });
  if (existing) {
    Object.assign(existing, patch);
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
  if (data.done) {
    closeReasoningStream(view, kind);
    view.isStreaming = hasStreamingMessage(view);
    markTurnInProgress(view);
    return next;
  }

  const content = stringValue(data.content) || stringValue(data.text);
  if (!content) {
    return next;
  }
  const last = view.messages[view.messages.length - 1];
  if (last?.role === "reasoning" && last.reasoningKind === kind && last.streaming) {
    last.content += content;
  } else {
    closeTopLevelTextStreams(view);
    view.messages.push({
      id: nextMessageId(next, "reasoning", sessionId),
      sessionId,
      role: "reasoning",
      content,
      reasoningKind: kind,
      timestamp: timestampFromData(data),
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
    closeTopLevelTextStreams(view);
    const existing =
      view.messages.find((message) => message.role === "tool" && message.runId === data.run_id) ??
      findMatchingProgressTool(view, data, toolName);
    const patch = toolCallFromStart(data, toolName);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      view.messages.push({
        id: nextMessageId(next, "tool", sessionId),
        sessionId,
        role: "tool",
        content: "",
        timestamp: timestampFromData(data),
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
  const error = stringValue(data.error);
  const errorType = stringValue(data.error_type);
  const status = toolStatusFromEnd(data.status, error);

  if (data.is_subagent && data.subagent_id) {
    const subagent = view.messages.find(
      (message) => message.role === "subagent" && message.subagentId === data.subagent_id,
    );
    if (subagent) {
      const tool = findSubagentTool(subagent, data.run_id);
      if (tool) {
        applyToolEnd(tool, result, data.duration_ms, status, error, errorType, data);
      }
      for (const call of subagent.subagentToolCalls ?? []) {
        if (call !== tool && call.runId === data.run_id) {
          applyToolEnd(call, result, data.duration_ms, status, error, errorType, data);
        }
      }
    }
  } else {
    const message = view.messages.find((item) => item.role === "tool" && item.runId === data.run_id);
    const target = message ?? findMatchingProgressTool(view, data, toolNameFromData(data));
    if (target) {
      applyToolEnd(target, result, data.duration_ms, status, error, errorType, data);
    } else {
      view.messages.push({
        id: nextMessageId(next, "tool", sessionId),
        sessionId,
        role: "tool",
        content: "",
        timestamp: timestampFromData(data),
        ...toolCallFromStart(data, toolNameFromData(data)),
        status,
        toolResult: result,
        toolDurationMs: data.duration_ms,
        toolError: error || undefined,
        toolErrorType: errorType || undefined,
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
  const target =
    [...view.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          !message.cancelled &&
          message.status !== "cancelled" &&
          message.content.trim(),
      ) ??
    [...view.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          !message.cancelled &&
          message.status !== "cancelled",
      );

  let completedTarget = target;
  if (!completedTarget && finalContent) {
    completedTarget = {
      id: nextMessageId(next, "assistant", sessionId),
      sessionId,
      role: "assistant",
      content: finalContent,
      timestamp: timestampFromData(payload),
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

  for (const message of view.messages) {
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
  view.runtimeState = payload.status === "failed" ? "failed" : "idle";
  return next;
}

function handleCancelled(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data);
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  for (const message of view.messages) {
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
  if (!(last?.role === "assistant" && last.cancelled && last.status === "cancelled")) {
    const traceId = stringValue(data.trace_id);
    view.messages.push({
      id: nextMessageId(next, "cancelled", sessionId),
      sessionId,
      role: "assistant",
      content: "",
      timestamp: timestampFromData(data),
      status: "cancelled",
      cancelled: true,
      ...(traceId ? { traceId } : {}),
    });
  }
  view.isStreaming = false;
  view.isCancelling = false;
  view.pendingApproval = null;
  view.runtimeState = "idle";
  return next;
}

function handleError(state: AgentConversationState, data: AgentErrorData): AgentConversationState {
  const sessionId = data.session_id ?? state.selectedSessionId ?? "";
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  view.messages.push({
    id: nextMessageId(next, "error", sessionId),
    sessionId,
    role: "error",
    content: data.message || data.error || data.code || "对话执行失败",
    timestamp: timestampFromData(data),
    traceId: data.trace_id,
    status: "failed",
  });
  for (const message of view.messages) {
    message.streaming = false;
    if (message.role === "subagent") {
      closeSubagentTextStreams(message);
    }
  }
  view.isStreaming = false;
  view.isCancelling = false;
  view.pendingApproval = null;
  view.runtimeState = "failed";
  return next;
}

function handleStatus(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  const next = cloneState(state);
  const runningSessionIds = runningSessionIdsFromStatus(data);
  for (const runningSessionId of runningSessionIds) {
    const runningView = ensureSessionState(next, runningSessionId);
    if (!runningView.pendingApproval) {
      runningView.runtimeState = "running";
      runningView.isStreaming = true;
    }
    runningView.isCancelling = false;
  }
  for (const waitingSessionId of waitingApprovalSessionIdsFromStatus(data)) {
    const waitingView = ensureSessionState(next, waitingSessionId);
    waitingView.runtimeState = "waiting_approval";
    waitingView.isStreaming = false;
    waitingView.isCancelling = false;
  }
  if (!sessionId) {
    return next;
  }
  const view = ensureSessionState(next, sessionId);
  const status = stringValue(data.status);
  if (isAgentSessionStatus(status)) {
    view.status = status;
    view.runtimeState = runtimeStateFromSessionStatus(status);
  } else if (isRuntimeState(status)) {
    view.runtimeState = status;
  }
  if (view.runtimeState !== "running") {
    view.isStreaming = false;
  }
  return next;
}

function handleToolProgress(state: AgentConversationState, data: AgentToolProgressData): AgentConversationState {
  const sessionId = data.session_id ?? state.selectedSessionId ?? "";
  const progressRunId = data.run_id || data.tool_call_id || "";
  if (!sessionId || !progressRunId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const toolName = toolNameFromData(data);
  const existing =
    view.messages.find(
      (message) =>
        message.role === "tool" &&
        (message.runId === progressRunId ||
          Boolean(data.tool_call_id && message.toolCallId === data.tool_call_id)),
    ) ?? findMatchingProgressTool(view, data, toolName);
  if (existing) {
    applyToolProgress(existing, data, toolName);
  } else {
    const created: AgentChatMessage = {
      id: nextMessageId(next, "tool-progress", sessionId),
      sessionId,
      role: "tool",
      content: "",
      timestamp: timestampFromData(data),
      runId: progressRunId,
      toolCallId: data.tool_call_id,
      toolName,
      toolParams: data.params ?? data.input_data,
      status: "running",
      fileChanges: normalizedFileChanges(data.files),
      uiPayload: mergeToolFilesIntoUiPayload(data.ui_payload, data.files),
      metadata: data.metadata,
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
  const session = sessionFromData(data);
  if (session) {
    return upsertSession(state, session, { select: false });
  }
  const sessionId = sessionIdFromData(data);
  const title = nullableString(data.title);
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
      title_source: nullableString(data.title_source) as AgentSession["title_source"],
      updated_at: stringValue(data.updated_at) || existing.updated_at,
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

  return {
    ...payload,
    id: payload.id ?? historyMessageId(sessionId, payload, index),
    sessionId: payload.sessionId ?? sessionId,
    timestamp: payload.timestamp ?? Date.now() + index,
    content: payload.content ?? "",
    ghostStats,
    streaming: false,
    status: normalizeHistoryStatus(payload),
    subagentItems: payload.subagentItems?.map(normalizeSubagentHistoryItem),
    subagentToolCalls: payload.subagentToolCalls?.map(normalizeToolHistoryCall),
  };
}

function historyMessageId(sessionId: string, payload: AgentChatMessagePayload, index: number): string {
  if (payload.turnIndex === undefined && payload.timestamp === undefined) {
    return `hist:${sessionId}:${index + 1}`;
  }
  const turn = payload.turnIndex ?? "turnless";
  const timestamp = payload.timestamp ?? "notime";
  const run = payload.runId ?? payload.subagentRunId ?? payload.toolName ?? "";
  const contentHash = hashHistoryText(payload.content ?? "");
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
    return payload.toolError ? "error" : "completed";
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
    streaming: false,
  };
}

function normalizeToolHistoryCall(tool: AgentToolCall): AgentToolCall {
  return {
    ...tool,
    status: tool.status ?? (tool.toolError ? "error" : "completed"),
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
    tool_name: stringValue(approval.tool_name) || "run_command",
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
    created_at: stringValue(approval.created_at) || new Date().toISOString(),
    resolved_at: nullableString(approval.resolved_at),
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

function closeReasoningStream(view: AgentSessionViewState, kind: AgentReasoningKind) {
  const message = [...view.messages]
    .reverse()
    .find((item) => item.role === "reasoning" && item.reasoningKind === kind && item.streaming);
  if (message) {
    message.streaming = false;
    if (message.status === "streaming") {
      message.status = undefined;
    }
  }
}

function closeTopLevelTextStreams(view: AgentSessionViewState) {
  for (const message of view.messages) {
    if ((message.role === "assistant" || message.role === "reasoning") && message.streaming) {
      message.streaming = false;
      if (message.status === "streaming") {
        message.status = undefined;
      }
    }
  }
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
    metadata: data.metadata,
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
  if (data.run_id && shouldAcceptProgressRunId(target, data)) {
    target.runId = data.run_id;
  }
  target.toolCallId = data.tool_call_id ?? target.toolCallId;
  target.toolName = toolName || target.toolName;
  target.toolParams = data.params ?? data.input_data ?? target.toolParams;
  target.status = "running";
  const fileChanges = normalizedFileChanges(data.files);
  if (fileChanges.length) {
    target.fileChanges = fileChanges;
    target.uiPayload = mergeToolFilesIntoUiPayload(data.ui_payload ?? target.uiPayload, fileChanges);
  } else {
    target.uiPayload = data.ui_payload ?? target.uiPayload;
  }
  target.metadata = data.metadata ?? target.metadata;
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
  data: AgentToolEventData,
) {
  target.status = status;
  target.toolResult = result;
  target.toolDurationMs = durationMs;
  target.toolError = error || undefined;
  target.toolErrorType = errorType || undefined;
  const structured = structuredToolOutput(data);
  target.uiPayload = data.ui_payload ?? structured ?? target.uiPayload;
  const fileChanges = normalizedFileChanges(
    data.files ?? fileChangesFromUiPayload(target.uiPayload),
  );
  if (fileChanges.length) {
    target.fileChanges = fileChanges;
    target.uiPayload = mergeToolFilesIntoUiPayload(target.uiPayload, fileChanges);
  }
  target.metadata = data.metadata ?? target.metadata;
}

function toolNameFromData(data: AgentToolEventData): string {
  return stringValue(data.tool_name) || stringValue(data.tool) || data.run_id;
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
    is_deleted: Boolean(workspace.is_deleted),
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
  return state === "running" || state === "waiting_approval" || state === "cancelling";
}

function sessionIdFromData(data: Record<string, unknown>): string {
  return stringValue(data.session_id) || stringValue(data.id);
}

function eventIdentity(event: AgentActionEnvelope): string {
  const data = event.data;
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

function isVisibleCompressionProgressStage(stage: string): boolean {
  return [
    "staging_applied",
    "emergency_triggered",
    "emergency_failed",
    "emergency_replacement_failed",
    "emergency_completed",
  ].includes(stage);
}

function contextCompressionContent(stage: string): string {
  if (stage === "emergency_triggered") {
    return "正在自动压缩中";
  }
  if (stage === "emergency_failed" || stage === "emergency_replacement_failed") {
    return "自动压缩失败";
  }
  if (stage === "emergency_completed") {
    return "自动压缩成功";
  }
  return "上下文已自动压缩";
}

function contextCompressionStatus(stage: string): AgentChatMessage["status"] {
  if (stage === "emergency_triggered") {
    return "running";
  }
  if (stage === "emergency_failed" || stage === "emergency_replacement_failed") {
    return "failed";
  }
  return "completed";
}

function contextCompressionMode(data: AgentMiddlewareProgressData, stage: string): string {
  const mode = stringValue(data.compression_mode);
  if (mode) {
    return mode;
  }
  return stage.startsWith("emergency_") ? "emergency" : "background";
}

function contextCompressionNoticeId(
  data: AgentMiddlewareProgressData,
  stage: string,
  sessionId: string,
): string {
  const noticeId = stringValue(data.notice_id);
  if (noticeId) {
    return noticeId;
  }
  if (stage.startsWith("emergency_")) {
    return `context-compression:emergency:${stringValue(data.trace_id) || sessionId}`;
  }
  const stagingFallback = stringValue(data.active_session_id) || sessionId;
  return `context-compression:staging:${String(data.staging_id ?? stagingFallback)}`;
}

function nextMessageId(state: AgentConversationState, prefix: string, sessionId: string): string {
  state.messageSeq += 1;
  return `${prefix}:${sessionId}:${state.messageSeq}`;
}

function sortSessionIds(sessions: AgentSession[]): string[] {
  return uniqueById(sessions)
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

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  return value === "active" || value === "running" || value === "waiting_approval" || value === "closed" || value === "failed";
}

function isRuntimeState(value: string): value is AgentSessionRuntimeState {
  return value === "idle" || value === "running" || value === "waiting_approval" || value === "cancelling" || value === "failed" || value === "closed";
}

function isApprovalStatus(value: string): value is CommandApprovalRequest["status"] {
  return ["pending", "approved", "rejected", "expired", "cancelled"].includes(value);
}

function isApprovalDecision(value: string): value is NonNullable<CommandApprovalRequest["decision"]> {
  return value === "approved" || value === "rejected";
}

function isTrustScope(value: string): value is NonNullable<CommandApprovalRequest["trust_scope"]> {
  return value === "once" || value === "persistent";
}

function isRuleMatchType(value: string): value is NonNullable<CommandApprovalRequest["rule_match_type"]> {
  return value === "exact" || value === "prefix";
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
