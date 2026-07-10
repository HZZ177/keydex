import type {
  A2UIDebugBlockState,
  A2UIDebugRawEvent,
  A2UIObject,
  AgentChatMessage,
} from "@/types/protocol";

import {
  applyA2UIEventToDebug,
  buildA2UIDebugKey,
  createA2UIDebugState,
  extractA2UIEventSnapshot,
  mergeA2UIDebugSnapshot,
  normalizeA2UIAction,
  parseA2UIArgsBuffer,
  type A2UIEventSnapshot,
  type A2UIEventAction,
} from "./protocol";

interface A2UIStreamIngressRuntime {
  argsBuffer: string;
  argsTextLength: number;
  chunkCount: number;
  lastPublishedAt: number;
  lastPublishedLength: number;
  latestChunk: string;
  rawEvents: A2UIDebugRawEvent[];
  seenEventKeys: Set<string>;
}

const A2UI_STREAM_PUBLISH_INTERVAL_MS = 50;
const A2UI_STREAM_PUBLISH_MIN_CHARS = 48;
const A2UI_STREAM_RUNTIME_LIMIT = 512;
const a2uiStreamIngressRuntimes = new Map<string, A2UIStreamIngressRuntime>();

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
    for (const message of this.messages) {
      releaseA2UIStreamIngressRuntime(message.sessionId, message.a2uiDebug?.id);
    }
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
  const existingMessage = existingIndex >= 0 ? messages[existingIndex] : null;
  const previousDebugId = existingMessage?.a2uiDebug?.id || key;
  const runtimeKey = a2uiStreamIngressRuntimeKey(options.sessionId, previousDebugId);
  if (normalized === "a2ui_stream_start") {
    a2uiStreamIngressRuntimes.delete(runtimeKey);
  }
  let ingressRuntime: A2UIStreamIngressRuntime | null = null;
  if (normalized === "a2ui_stream_chunk") {
    ingressRuntime = getOrCreateA2UIStreamIngressRuntime(runtimeKey, existingMessage?.a2uiDebug, now);
    const accepted = ingestA2UIStreamChunk(
      ingressRuntime,
      normalized,
      snapshot,
      data,
      options.eventId,
      now,
    );
    if (!accepted || !shouldPublishA2UIStreamIngress(ingressRuntime, now)) {
      return {
        action: normalized,
        created: false,
        debug: null,
        message: null,
        messages,
      };
    }
  }
  const nextMessages = [...messages];
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
    : cloneMessage(messages[index]);
  const hadWeakIdentity = !hasStrongA2UIMessageIdentity(message);

  if (!message.a2uiDebug) {
    message.a2uiDebug = createA2UIDebugState(key, snapshot, now);
  } else {
    message.a2uiDebug = cloneDebug(message.a2uiDebug);
  }
  const pendingIngress = ingressRuntime ?? a2uiStreamIngressRuntimes.get(runtimeKey) ?? null;
  if (pendingIngress && normalized !== "a2ui_stream_chunk" && normalized !== "a2ui_stream_start") {
    applyA2UIIngressBufferSnapshot(pendingIngress, snapshot);
    hydrateA2UIDebugFromIngress(message.a2uiDebug, pendingIngress, false);
  }
  if (
    normalized !== "a2ui_stream_chunk" &&
    !created &&
    isDuplicateA2UIEvent(message.a2uiDebug, normalized, snapshot)
  ) {
    return {
      action: normalized,
      created: false,
      debug: null,
      message: null,
      messages,
    };
  }

  if (normalized === "a2ui_stream_chunk" && ingressRuntime) {
    mergeA2UIDebugSnapshot(message.a2uiDebug, snapshot, now);
    hydrateA2UIDebugFromIngress(message.a2uiDebug, ingressRuntime, false);
    markA2UIStreamIngressPublished(ingressRuntime, now);
  } else {
    applyA2UIEventToDebug(message.a2uiDebug, normalized, data, {
      eventId: options.eventId,
      now,
    });
  }
  if (hadWeakIdentity && hasStrongA2UISnapshotIdentity(snapshot)) {
    message.a2uiDebug.id = key;
  }
  message.streaming = normalized === "a2ui_stream_start" || normalized === "a2ui_stream_chunk";
  message.timestamp = now;
  if (isA2UIObject(message.a2uiDebug.a2ui)) {
    message.a2ui = message.a2uiDebug.a2ui;
  }
  if (normalized === "a2ui_stream_start") {
    setA2UIStreamIngressRuntime(
      a2uiStreamIngressRuntimeKey(options.sessionId, message.a2uiDebug.id),
      createA2UIStreamIngressRuntime(message.a2uiDebug, now),
    );
  } else if (normalized === "a2ui_stream_chunk" && ingressRuntime) {
    const nextRuntimeKey = a2uiStreamIngressRuntimeKey(options.sessionId, message.a2uiDebug.id);
    if (nextRuntimeKey !== runtimeKey) {
      a2uiStreamIngressRuntimes.delete(runtimeKey);
    }
    setA2UIStreamIngressRuntime(nextRuntimeKey, ingressRuntime);
  } else if (normalized === "a2ui_stream_finish" || normalized === "a2ui_created") {
    a2uiStreamIngressRuntimes.delete(runtimeKey);
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
    rawEvents: [...debug.rawEvents],
    a2ui: isA2UIObject(debug.a2ui) ? { ...debug.a2ui } : debug.a2ui,
    createdFrame: debug.createdFrame ? { ...debug.createdFrame } : undefined,
    inputSchema: debug.inputSchema ? { ...debug.inputSchema } : undefined,
    interaction: debug.interaction ? { ...debug.interaction } : undefined,
    submitSchema: debug.submitSchema ? { ...debug.submitSchema } : undefined,
  };
}

function a2uiStreamIngressRuntimeKey(sessionId: string | undefined, debugId: string): string {
  return `${sessionId ?? ""}|${debugId}`;
}

function getOrCreateA2UIStreamIngressRuntime(
  runtimeKey: string,
  debug: A2UIDebugBlockState | undefined,
  now: number,
): A2UIStreamIngressRuntime {
  const existing = a2uiStreamIngressRuntimes.get(runtimeKey);
  if (existing) {
    return existing;
  }
  const created = createA2UIStreamIngressRuntime(debug, now);
  setA2UIStreamIngressRuntime(runtimeKey, created);
  return created;
}

function createA2UIStreamIngressRuntime(
  debug: A2UIDebugBlockState | undefined,
  now: number,
): A2UIStreamIngressRuntime {
  const rawEvents = debug?.rawEvents ? [...debug.rawEvents] : [];
  return {
    argsBuffer: debug?.argsBuffer ?? "",
    argsTextLength: debug?.argsTextLength ?? debug?.argsBuffer.length ?? 0,
    chunkCount: debug?.chunkCount ?? 0,
    lastPublishedAt: debug?.updatedAt ?? now,
    lastPublishedLength: debug?.argsBuffer.length ?? 0,
    latestChunk: debug?.latestChunk ?? "",
    rawEvents,
    seenEventKeys: new Set(
      rawEvents
        .map((event) => {
          const eventAction = normalizeA2UIAction(event.action);
          return eventAction
            ? buildA2UIEventSemanticKey(eventAction, extractA2UIEventSnapshot(event.data))
            : "";
        })
        .filter(Boolean),
    ),
  };
}

function setA2UIStreamIngressRuntime(runtimeKey: string, runtime: A2UIStreamIngressRuntime): void {
  a2uiStreamIngressRuntimes.delete(runtimeKey);
  a2uiStreamIngressRuntimes.set(runtimeKey, runtime);
  while (a2uiStreamIngressRuntimes.size > A2UI_STREAM_RUNTIME_LIMIT) {
    const oldestKey = a2uiStreamIngressRuntimes.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    a2uiStreamIngressRuntimes.delete(oldestKey);
  }
}

function releaseA2UIStreamIngressRuntime(sessionId: string | undefined, debugId: string | undefined): void {
  if (!debugId) {
    return;
  }
  a2uiStreamIngressRuntimes.delete(a2uiStreamIngressRuntimeKey(sessionId, debugId));
}

function ingestA2UIStreamChunk(
  runtime: A2UIStreamIngressRuntime,
  action: A2UIEventAction,
  snapshot: A2UIEventSnapshot,
  data: unknown,
  eventId: string | undefined,
  now: number,
): boolean {
  const semanticKey = buildA2UIEventSemanticKey(action, snapshot) || eventId || "";
  if (semanticKey && runtime.seenEventKeys.has(semanticKey)) {
    return false;
  }
  if (semanticKey) {
    runtime.seenEventKeys.add(semanticKey);
  }
  const eventData = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  runtime.rawEvents.push({
    id: eventId || `a2ui-event:${now}:${runtime.rawEvents.length + 1}`,
    action,
    timestamp: now,
    data: eventData,
  });
  const previousBuffer = runtime.argsBuffer;
  applyA2UIIngressBufferSnapshot(runtime, snapshot);
  runtime.latestChunk = snapshot.argsDelta ?? (
    runtime.argsBuffer.length > previousBuffer.length
      ? runtime.argsBuffer.slice(previousBuffer.length)
      : ""
  );
  runtime.chunkCount += 1;
  return true;
}

function applyA2UIIngressBufferSnapshot(
  runtime: A2UIStreamIngressRuntime,
  snapshot: A2UIEventSnapshot,
): void {
  if (snapshot.argsText !== undefined) {
    if (snapshot.argsText.length >= runtime.argsBuffer.length) {
      runtime.argsBuffer = snapshot.argsText;
    }
  } else if (snapshot.argsDelta !== undefined) {
    runtime.argsBuffer += snapshot.argsDelta;
  }
  runtime.argsTextLength = Math.max(
    runtime.argsTextLength,
    snapshot.argsTextLength ?? runtime.argsBuffer.length,
  );
}

function shouldPublishA2UIStreamIngress(runtime: A2UIStreamIngressRuntime, now: number): boolean {
  if (runtime.chunkCount <= 1) {
    return true;
  }
  return (
    runtime.argsBuffer.length - runtime.lastPublishedLength >= A2UI_STREAM_PUBLISH_MIN_CHARS ||
    Math.max(0, now - runtime.lastPublishedAt) >= A2UI_STREAM_PUBLISH_INTERVAL_MS
  );
}

function markA2UIStreamIngressPublished(runtime: A2UIStreamIngressRuntime, now: number): void {
  runtime.lastPublishedAt = now;
  runtime.lastPublishedLength = runtime.argsBuffer.length;
}

function hydrateA2UIDebugFromIngress(
  debug: A2UIDebugBlockState,
  runtime: A2UIStreamIngressRuntime,
  final: boolean,
): void {
  const parsed = parseA2UIArgsBuffer(runtime.argsBuffer, final);
  debug.status = final ? "finished" : "streaming";
  debug.argsBuffer = runtime.argsBuffer;
  debug.argsTextLength = runtime.argsTextLength;
  debug.chunkCount = runtime.chunkCount;
  debug.latestChunk = runtime.latestChunk;
  debug.jsonParseStatus = parsed.jsonParseStatus;
  debug.parsedArgs = parsed.parsedArgs;
  debug.parseError = parsed.parseError;
  debug.rawEvents = [...runtime.rawEvents];
}

function isA2UIObject(value: unknown): value is A2UIObject {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { render_key?: unknown }).render_key === "string"
    && typeof (value as { mode?: unknown }).mode === "string";
}
