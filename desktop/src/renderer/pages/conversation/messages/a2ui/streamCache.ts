import type {
  A2UIDebugBlockState,
  A2UIDebugRawEvent,
  A2UIObject,
  AgentChatMessage,
} from "@/types/protocol";

import {
  applyA2UIEventToDebug,
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
  const identity = resolveA2UIEventIdentity(normalized, snapshot);
  if (!identity) {
    return { action: normalized, created: false, debug: null, message: null, messages };
  }
  const key = identity.value;
  const existingIndex = findA2UIMessageIndex(messages, identity);
  if (existingIndex < 0 && normalized !== "a2ui_stream_start" && normalized !== "a2ui_created") {
    return { action: normalized, created: false, debug: null, message: null, messages };
  }
  const existingMessage = existingIndex >= 0 ? messages[existingIndex] : null;
  const runtimeKey = a2uiStreamIngressRuntimeKey(options.sessionId, key);
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
  message.a2uiDebug.id = key;
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
  const resolvedMessages = normalized === "a2ui_created"
    ? removeResolvedA2UIRetryFailures(nextMessages, message)
    : nextMessages;

  return {
    action: normalized,
    created,
    debug: message.a2uiDebug,
    message,
    messages: resolvedMessages,
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

interface A2UIEventIdentity {
  kind: "stream" | "interaction";
  value: string;
}

function resolveA2UIEventIdentity(
  action: A2UIEventAction,
  snapshot: A2UIEventSnapshot,
): A2UIEventIdentity | null {
  if (
    action === "a2ui_stream_start" ||
    action === "a2ui_stream_chunk" ||
    action === "a2ui_stream_finish" ||
    action === "a2ui_created" ||
    action === "a2ui_waiting_input"
  ) {
    return snapshot.streamId ? { kind: "stream", value: snapshot.streamId } : null;
  }
  if (snapshot.interactionId) {
    return { kind: "interaction", value: snapshot.interactionId };
  }
  if (snapshot.streamId) {
    return { kind: "stream", value: snapshot.streamId };
  }
  return null;
}

function findA2UIMessageIndex(
  messages: AgentChatMessage[],
  identity: A2UIEventIdentity,
): number {
  return messages.findIndex((message) => {
    if (message.role !== "a2ui" || !message.a2uiDebug) {
      return false;
    }
    if (identity.kind === "stream") {
      return message.a2uiDebug.streamId === identity.value || message.a2ui?.stream_id === identity.value;
    }
    return message.a2uiDebug.interactionId === identity.value ||
      message.a2ui?.interaction?.interaction_id === identity.value;
  });
}

function removeResolvedA2UIRetryFailures(
  messages: AgentChatMessage[],
  current: AgentChatMessage,
): AgentChatMessage[] {
  const streamGroupId = current.a2uiDebug?.streamGroupId;
  if (!streamGroupId) {
    return messages;
  }
  return messages.filter((message) => {
    if (message === current) {
      return true;
    }
    const debug = message.a2uiDebug;
    return !debug || debug.streamGroupId !== streamGroupId || !isRetryableA2UIFailure(debug);
  });
}

function isRetryableA2UIFailure(debug: A2UIDebugBlockState): boolean {
  return debug.status === "failed" && debug.finishReason === "tool_error";
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
  const identity = action === "a2ui_submit_ack" || action === "a2ui_cancel_ack" || action === "a2ui_resume"
    ? snapshot.interactionId
    : snapshot.streamId;
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
    if (
      action === "a2ui_stream_finish" &&
      snapshot.streamStatus === "failed" &&
      snapshot.finishReason === "tool_error"
    ) {
      return [action, scope, "failed", "tool_error"].join("|");
    }
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
