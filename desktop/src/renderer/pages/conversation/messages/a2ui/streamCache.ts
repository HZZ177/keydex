import type { A2UIDebugBlockState, A2UIObject, AgentChatMessage } from "@/types/protocol";

import {
  applyA2UIEventToDebug,
  buildA2UIDebugKey,
  createA2UIDebugState,
  extractA2UIEventSnapshot,
  normalizeA2UIAction,
  type A2UIEventAction,
} from "./protocol";

export interface A2UIMessageMergeResult {
  action: A2UIEventAction | null;
  created: boolean;
  debug: A2UIDebugBlockState | null;
  message: AgentChatMessage | null;
  messages: AgentChatMessage[];
}

export interface A2UIMessageMergeOptions {
  eventId?: string;
  idFactory?: () => string;
  now?: number;
  sessionId?: string;
}

export class A2UIStreamCache {
  private messages: AgentChatMessage[] = [];

  apply(action: string, data: unknown, options: A2UIMessageMergeOptions = {}): A2UIMessageMergeResult {
    const result = mergeA2UIEventIntoMessages(this.messages, action, data, options);
    this.messages = result.messages;
    return result;
  }

  snapshot(): AgentChatMessage[] {
    return this.messages.map(cloneMessage);
  }

  reset(): void {
    this.messages = [];
  }
}

export function mergeA2UIEventIntoMessages(
  messages: AgentChatMessage[],
  action: string,
  data: unknown,
  options: A2UIMessageMergeOptions = {},
): A2UIMessageMergeResult {
  const normalized = normalizeA2UIAction(action);
  if (!normalized) {
    return { action: null, created: false, debug: null, message: null, messages };
  }

  const now = options.now ?? Date.now();
  const snapshot = extractA2UIEventSnapshot(data);
  const key = buildA2UIDebugKey(normalized, snapshot);
  const existingIndex = messages.findIndex((message) => isA2UIMessageMatch(message, key, snapshot));
  const nextMessages = messages.map(cloneMessage);
  const index = existingIndex >= 0 ? existingIndex : nextMessages.length;
  const created = existingIndex < 0;
  const message = created
    ? createA2UIMessage({
        debugId: key,
        id: options.idFactory?.() ?? `a2ui:${key}`,
        now,
        sessionId: options.sessionId ?? "",
        snapshot,
      })
    : nextMessages[index];

  if (!message.a2uiDebug) {
    message.a2uiDebug = createA2UIDebugState(key, snapshot, now);
  } else {
    message.a2uiDebug = cloneDebug(message.a2uiDebug);
  }

  applyA2UIEventToDebug(message.a2uiDebug, normalized, data, {
    eventId: options.eventId,
    now,
  });
  message.streaming = normalized === "a2ui_stream_start" || normalized === "a2ui_stream_chunk";
  message.timestamp = now;
  if (isA2UIObject(message.a2uiDebug.a2ui)) {
    message.a2ui = message.a2uiDebug.a2ui;
  }

  if (created) {
    nextMessages.push(message);
  } else {
    nextMessages[index] = message;
  }

  return {
    action: normalized,
    created,
    debug: message.a2uiDebug,
    message,
    messages: nextMessages,
  };
}

export function createA2UIMessage({
  debugId,
  id,
  now,
  sessionId,
  snapshot,
}: {
  debugId: string;
  id: string;
  now: number;
  sessionId: string;
  snapshot: ReturnType<typeof extractA2UIEventSnapshot>;
}): AgentChatMessage {
  return {
    id,
    sessionId,
    role: "a2ui",
    content: "",
    contentType: "a2ui",
    content_type: "a2ui",
    timestamp: now,
    streaming: false,
    a2uiDebug: createA2UIDebugState(debugId, snapshot, now),
  };
}

function isA2UIMessageMatch(
  message: AgentChatMessage,
  key: string,
  snapshot: ReturnType<typeof extractA2UIEventSnapshot>,
): boolean {
  const debug = message.a2uiDebug;
  if (message.role !== "a2ui" || !debug) {
    return false;
  }
  return (
    debug.id === key ||
    Boolean(snapshot.streamId && debug.streamId === snapshot.streamId) ||
    Boolean(snapshot.interactionId && debug.interactionId === snapshot.interactionId) ||
    Boolean(snapshot.toolCallId && debug.toolCallId === snapshot.toolCallId)
  );
}

function cloneMessage(message: AgentChatMessage): AgentChatMessage {
  return {
    ...message,
    a2ui: message.a2ui ? { ...message.a2ui } : message.a2ui,
    a2uiDebug: message.a2uiDebug ? cloneDebug(message.a2uiDebug) : undefined,
  };
}

function cloneDebug(debug: A2UIDebugBlockState): A2UIDebugBlockState {
  return {
    ...debug,
    rawEvents: debug.rawEvents.map((event) => ({
      ...event,
      data: { ...event.data },
    })),
    a2ui: isA2UIObject(debug.a2ui) ? { ...debug.a2ui } : debug.a2ui,
    createdFrame: debug.createdFrame ? { ...debug.createdFrame } : undefined,
    inputSchema: debug.inputSchema ? { ...debug.inputSchema } : undefined,
    interaction: debug.interaction ? { ...debug.interaction } : undefined,
    submitSchema: debug.submitSchema ? { ...debug.submitSchema } : undefined,
  };
}

function isA2UIObject(value: unknown): value is A2UIObject {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { render_key?: unknown }).render_key === "string"
    && typeof (value as { mode?: unknown }).mode === "string";
}
