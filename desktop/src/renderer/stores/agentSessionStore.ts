import type {
  AgentActionEnvelope,
  AgentChatMessage,
  AgentChatMessagePayload,
  AgentCompletedPayload,
  AgentErrorData,
  AgentGhostStats,
  AgentHistoryResponse,
  AgentReasoningData,
  AgentReasoningKind,
  AgentSession,
  AgentSessionStatus,
  AgentStreamActionData,
  AgentSubagentItem,
  AgentSubagentToolItem,
  AgentToolCall,
  AgentToolEventData,
  AgentToolStatus,
} from "@/types/protocol";

export type AgentSessionRuntimeState = "idle" | "running" | "cancelling" | "failed" | "closed";

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
  | {
      type: "message/addUser";
      sessionId: string;
      content: string;
      attachments?: AgentChatMessage["attachments"];
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
      return { ...state, selectedSessionId: action.sessionId };
    case "history/loaded":
      return loadHistory(state, action.sessionId, action.history);
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
    case "reasoning":
      next = handleReasoning(state, event.data as unknown as AgentReasoningData);
      break;
    case "tool_start":
      next = handleToolStart(state, event.data as unknown as AgentToolEventData);
      break;
    case "tool_end":
      next = handleToolEnd(state, event.data as unknown as AgentToolEventData);
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
      next = handleCancelled(state, sessionIdFromData(event.data));
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
    case "pong":
    case "task_result":
      next = state;
      break;
  }

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

function setSessions(state: AgentConversationState, sessions: AgentSession[]): AgentConversationState {
  let next = cloneState(state);
  next.sessionsById = { ...state.sessionsById };
  for (const session of sessions) {
    next.sessionsById[session.id] = session;
    ensureSessionState(next, session.id, metaFromSession(session));
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
  next.sessionsById = {
    ...state.sessionsById,
    [session.id]: session,
  };
  next.sessionIds = sortSessionIds(Object.values(next.sessionsById));
  if (options.select || !next.selectedSessionId) {
    next.selectedSessionId = session.id;
  }
  ensureSessionState(next, session.id, metaFromSession(session));
  return next;
}

function loadHistory(
  state: AgentConversationState,
  sessionId: string,
  history: AgentHistoryResponse,
): AgentConversationState {
  let next = upsertSession(state, history.session, { select: true });
  next = cloneState(next);
  const view = ensureSessionState(next, sessionId, metaFromSession(history.session));
  view.messages = history.list.map((payload, index) => historyMessageFromPayload(sessionId, payload, index));
  view.hydrated = true;
  view.historyLoading = false;
  view.stale = false;
  view.isStreaming = view.messages.some((message) => Boolean(message.streaming));
  view.runtimeState = view.isStreaming ? "running" : runtimeStateFromSessionStatus(view.status);
  return next;
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
    timestamp: action.timestamp ?? Date.now(),
  });
  next.selectedSessionId = action.sessionId;
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
    const message = latestStreamingMessage(view, "assistant");
    if (message) {
      message.content += content;
    } else {
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
  next.selectedSessionId = sessionId;
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
    closeReasoningStream(view, kind);
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
    const existing = view.messages.find((message) => message.role === "tool" && message.runId === data.run_id);
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
    if (message) {
      applyToolEnd(message, result, data.duration_ms, status, error, errorType, data);
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
      .find((message) => (message.role === "assistant" || message.role === "reasoning") && message.content.trim()) ??
    [...view.messages]
      .reverse()
      .find((message) => message.role === "assistant" || message.role === "reasoning");

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
  view.runtimeState = payload.status === "failed" ? "failed" : "idle";
  return next;
}

function handleCancelled(state: AgentConversationState, sessionId: string): AgentConversationState {
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  for (const message of view.messages) {
    if (message.streaming) {
      message.streaming = false;
    }
    if (message.role === "subagent") {
      closeSubagentTextStreams(message);
    }
  }
  const last = [...view.messages]
    .reverse()
    .find((message) => message.role === "assistant" || message.role === "subagent" || message.role === "reasoning");
  if (last) {
    last.cancelled = true;
  }
  view.isStreaming = false;
  view.isCancelling = false;
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
  view.runtimeState = "failed";
  return next;
}

function handleStatus(state: AgentConversationState, data: Record<string, unknown>): AgentConversationState {
  const sessionId = sessionIdFromData(data) || state.selectedSessionId || "";
  if (!sessionId) {
    return state;
  }
  const next = cloneState(state);
  const view = ensureSessionState(next, sessionId);
  const status = stringValue(data.status);
  if (isAgentSessionStatus(status)) {
    view.status = status;
    view.runtimeState = runtimeStateFromSessionStatus(status);
  } else if (isRuntimeState(status)) {
    view.runtimeState = status;
  }
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
    id: payload.id ?? `hist:${sessionId}:${index + 1}`,
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
    const cloned = {
      ...existing,
      ...meta,
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
    stale: meta.stale ?? false,
  };
  state.sessionStateById[sessionId] = created;
  return created;
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
  return {
    runId: data.run_id,
    parentRunId: data.parent_run_id ?? null,
    toolName,
    toolParams: data.params ?? data.input_data,
    status: "running",
    uiPayload: data.ui_payload,
    metadata: data.metadata,
  };
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
  target.uiPayload = data.ui_payload ?? structuredToolOutput(data) ?? target.uiPayload;
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
  return {
    id: stringValue(data.id) || stringValue(data.session_id),
    user_id: stringValue(data.user_id) || "local-user",
    scene_id: stringValue(data.scene_id) || "desktop-agent",
    status: isAgentSessionStatus(status) ? status : "active",
    title: typeof data.title === "string" ? data.title : null,
    session_tag: stringValue(data.session_tag) || "chat",
    active_session_id: nullableString(data.active_session_id),
    parent_session_id: nullableString(data.parent_session_id),
    child_session_id: nullableString(data.child_session_id),
    source_trace_id: nullableString(data.source_trace_id),
    created_at: stringValue(data.created_at) || now,
    updated_at: stringValue(data.updated_at) || now,
    is_debug: Boolean(data.is_debug),
    is_scheduled: Boolean(data.is_scheduled),
    is_current: Boolean(data.is_current),
    scene_version_seq: typeof data.scene_version_seq === "number" ? data.scene_version_seq : null,
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
  if (status === "failed") {
    return "failed";
  }
  if (status === "closed") {
    return "closed";
  }
  return "idle";
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
    attachments: message.attachments ? [...message.attachments] : undefined,
    subagentToolCalls: message.subagentToolCalls?.map((tool) => ({ ...tool })),
    subagentItems: message.subagentItems?.map((item) => ({ ...item })),
  };
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

function isAgentSessionStatus(value: string): value is AgentSessionStatus {
  return value === "active" || value === "running" || value === "closed" || value === "failed";
}

function isRuntimeState(value: string): value is AgentSessionRuntimeState {
  return value === "idle" || value === "running" || value === "cancelling" || value === "failed" || value === "closed";
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
