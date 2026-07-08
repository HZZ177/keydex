import type { A2UIDebugBlockState, A2UIObject, AgentChatMessage } from "@/types/protocol";

import {
  applyA2UIEventToDebug,
  buildA2UIDebugKey,
  createA2UIDebugState,
  extractA2UIEventSnapshot,
  normalizeA2UIAction,
  type A2UIEventSnapshot,
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
  const directIndex = messages.findIndex((message) => isA2UIMessageMatch(message, key, snapshot));
  const upgradeIndex = directIndex >= 0 ? -1 : findUpgradeableWeakA2UIMessageIndex(messages, snapshot);
  const existingIndex = directIndex >= 0 ? directIndex : upgradeIndex;
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
  const hadWeakIdentity = !hasStrongA2UIMessageIdentity(message);

  if (!message.a2uiDebug) {
    message.a2uiDebug = createA2UIDebugState(key, snapshot, now);
  } else {
    message.a2uiDebug = cloneDebug(message.a2uiDebug);
  }
  if (!created && isDuplicateA2UIEvent(message.a2uiDebug, normalized, snapshot)) {
    return {
      action: normalized,
      created: false,
      debug: null,
      message: null,
      messages,
    };
  }

  applyA2UIEventToDebug(message.a2uiDebug, normalized, data, {
    eventId: options.eventId,
    now,
  });
  if (hadWeakIdentity && hasStrongA2UISnapshotIdentity(snapshot)) {
    message.a2uiDebug.id = key;
  }
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
  if (isDiscardedA2UIStreamFinish(normalized, snapshot)) {
    return {
      action: normalized,
      created,
      debug: message.a2uiDebug,
      message,
      messages: nextMessages.filter((item) => item !== message),
    };
  }
  const mergedMessages = removeDuplicateWeakA2UIPlaceholders(nextMessages, message, snapshot);

  return {
    action: normalized,
    created,
    debug: message.a2uiDebug,
    message,
    messages: mergedMessages,
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
    Boolean(snapshot.streamGroupId && debug.streamGroupId === snapshot.streamGroupId) ||
    Boolean(snapshot.streamId && debug.streamId === snapshot.streamId) ||
    Boolean(snapshot.interactionId && debug.interactionId === snapshot.interactionId) ||
    Boolean(snapshot.toolCallId && debug.toolCallId === snapshot.toolCallId)
  );
}

function findUpgradeableWeakA2UIMessageIndex(
  messages: AgentChatMessage[],
  snapshot: ReturnType<typeof extractA2UIEventSnapshot>,
): number {
  const indexes = messages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => isUpgradeableWeakA2UIMessage(message, snapshot))
    .map(({ index }) => index);
  return indexes.length === 1 ? indexes[0] : -1;
}

function removeDuplicateWeakA2UIPlaceholders(
  messages: AgentChatMessage[],
  current: AgentChatMessage,
  snapshot: ReturnType<typeof extractA2UIEventSnapshot>,
): AgentChatMessage[] {
  if (!hasStrongA2UISnapshotIdentity(snapshot)) {
    return messages;
  }
  return messages.filter((message) => message === current || !isUpgradeableWeakA2UIMessage(message, snapshot));
}

function isUpgradeableWeakA2UIMessage(
  message: AgentChatMessage,
  snapshot: ReturnType<typeof extractA2UIEventSnapshot>,
): boolean {
  const debug = message.a2uiDebug;
  if (
    message.role !== "a2ui" ||
    !debug ||
    !hasStrongA2UISnapshotIdentity(snapshot) ||
    hasStrongA2UIMessageIdentity(message) ||
    !isA2UIStreamLifecycleMessage(message)
  ) {
    return false;
  }
  const sameRenderKey = Boolean(debug.renderKey && snapshot.renderKey && debug.renderKey === snapshot.renderKey);
  const sameTrace = Boolean(debug.traceId && snapshot.traceId && debug.traceId === snapshot.traceId);
  const sameTurn = typeof debug.turnIndex === "number" &&
    typeof snapshot.turnIndex === "number" &&
    debug.turnIndex === snapshot.turnIndex;
  return sameRenderKey && sameTrace && sameTurn;
}

function hasStrongA2UISnapshotIdentity(snapshot: ReturnType<typeof extractA2UIEventSnapshot>): boolean {
  return Boolean(snapshot.streamGroupId || snapshot.streamId || snapshot.interactionId || snapshot.toolCallId);
}

function hasStrongA2UIMessageIdentity(message: AgentChatMessage): boolean {
  return Boolean(
    message.a2ui?.stream_id ||
      message.a2uiDebug?.streamGroupId ||
      message.a2ui?.interaction?.interaction_id ||
      message.a2ui?.tool_call_id ||
      message.a2uiDebug?.streamId ||
      message.a2uiDebug?.interactionId ||
      message.a2uiDebug?.toolCallId,
  );
}

function isA2UIStreamLifecycleMessage(message: AgentChatMessage): boolean {
  const debug = message.a2uiDebug;
  return Boolean(
    message.streaming ||
      debug?.status === "started" ||
      debug?.status === "streaming" ||
      debug?.status === "finished" ||
      debug?.rawEvents?.some((event) => event.action.startsWith("a2ui_stream_")),
  );
}

function isDiscardedA2UIStreamFinish(
  action: A2UIEventAction,
  snapshot: A2UIEventSnapshot,
): boolean {
  if (action !== "a2ui_stream_finish") {
    return false;
  }
  const reason = snapshot.finishReason || "";
  return reason === "invalid_tool_call" || reason === "turn_cancelled" || reason === "a2ui_waiting_input";
}

function isDuplicateA2UIEvent(
  debug: A2UIDebugBlockState,
  action: A2UIEventAction,
  snapshot: A2UIEventSnapshot,
): boolean {
  const incomingKey = buildA2UIEventSemanticKey(action, snapshot);
  if (!incomingKey) {
    return false;
  }
  return debug.rawEvents.some((event) => {
    const existingAction = normalizeA2UIAction(event.action);
    if (existingAction !== action) {
      return false;
    }
    return buildA2UIEventSemanticKey(existingAction, extractA2UIEventSnapshot(event.data)) === incomingKey;
  });
}

function buildA2UIEventSemanticKey(action: A2UIEventAction, snapshot: A2UIEventSnapshot): string {
  const identity = snapshot.streamId || snapshot.streamGroupId || snapshot.interactionId || snapshot.toolCallId;
  if (!identity) {
    return "";
  }
  const scope = [
    snapshot.traceId || "",
    snapshot.turnIndex ?? "",
    snapshot.renderKey || "",
    identity,
  ].join("|");
  if (action === "a2ui_stream_start" || action === "a2ui_stream_chunk" || action === "a2ui_stream_finish") {
    return [
      action,
      scope,
      snapshot.streamStatus || "",
      snapshot.chunkIndex ?? "",
      snapshot.argsTextLength ?? "",
      snapshot.finishReason || "",
    ].join("|");
  }
  if (action === "a2ui_created") {
    return [action, scope, snapshot.mode || "", snapshot.interactionId || ""].join("|");
  }
  return "";
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
