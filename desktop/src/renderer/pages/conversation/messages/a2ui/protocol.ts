import type {
  A2UIAckActionData,
  A2UICancelActionPayload,
  A2UICreatedActionData,
  A2UIDebugBlockState,
  A2UIDebugLifecycleStatus,
  A2UIInteractionState,
  A2UIJsonParseStatus,
  A2UIObject,
  A2UIRenderKey,
  A2UIResumeActionData,
  A2UIStreamActionData,
  A2UISubmitActionPayload,
  A2UIWaitingInputActionData,
  AgentChatMessage,
} from "@/types/protocol";

import { parsePartialJson } from "./parsePartialJson";

export type A2UIEventAction =
  | "a2ui_stream_start"
  | "a2ui_stream_chunk"
  | "a2ui_stream_finish"
  | "a2ui_created"
  | "waiting_input"
  | "a2ui_submit_ack"
  | "a2ui_cancel_ack"
  | "a2ui_resume"
  | "a2ui_waiting_input";

export interface A2UIEventSnapshot {
  traceId?: string;
  turnIndex?: number;
  renderKey?: A2UIRenderKey;
  mode?: string;
  streamId?: string;
  streamGroupId?: string;
  interactionId?: string;
  toolCallId?: string | null;
  argsDelta?: string;
  argsText?: string;
  argsTextLength?: number;
  chunkIndex?: number;
  finishReason?: string;
  error?: string;
  streamStatus?: string;
  a2ui?: A2UIObject;
  interaction?: A2UIInteractionState | Record<string, unknown>;
  payload?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  submitSchema?: Record<string, unknown>;
  resume?: Record<string, unknown>;
}

export interface A2UIBufferParseResult {
  jsonParseStatus: A2UIJsonParseStatus;
  parsedArgs?: unknown;
  parseError?: string;
}

const A2UI_ACTION_ALIASES: Record<string, A2UIEventAction> = {
  "a2ui.stream.start": "a2ui_stream_start",
  "a2ui.stream.chunk": "a2ui_stream_chunk",
  "a2ui.stream.finish": "a2ui_stream_finish",
  "a2ui.created": "a2ui_created",
  a2ui_stream_start: "a2ui_stream_start",
  a2ui_stream_chunk: "a2ui_stream_chunk",
  a2ui_stream_finish: "a2ui_stream_finish",
  a2ui_created: "a2ui_created",
  waiting_input: "waiting_input",
  a2ui_submit_ack: "a2ui_submit_ack",
  a2ui_cancel_ack: "a2ui_cancel_ack",
  a2ui_resume: "a2ui_resume",
  a2ui_waiting_input: "a2ui_waiting_input",
};

export const A2UI_EVENT_ACTIONS = new Set<A2UIEventAction>(Object.values(A2UI_ACTION_ALIASES));

export function normalizeA2UIAction(action: string): A2UIEventAction | null {
  return A2UI_ACTION_ALIASES[action] ?? null;
}

export function isA2UIEventAction(action: string): action is A2UIEventAction {
  return normalizeA2UIAction(action) !== null;
}

export function parseA2UIArgsBuffer(buffer: string, final = false): A2UIBufferParseResult {
  if (!buffer.trim()) {
    return { jsonParseStatus: "empty" };
  }
  const result = parsePartialJson(buffer);
  if (result.complete) {
    return { jsonParseStatus: "valid", parsedArgs: result.value };
  }
  if (result.value !== undefined) {
    return {
      jsonParseStatus: final ? "invalid" : "partial",
      parsedArgs: result.value,
      parseError: final ? "Incomplete JSON stream" : result.error,
    };
  }
  return {
    jsonParseStatus: final ? "invalid" : "partial",
    parseError: final ? result.error || "Incomplete JSON stream" : result.error,
  };
}

export function extractA2UIEventSnapshot(data: unknown): A2UIEventSnapshot {
  const root = isRecord(data) ? data : {};
  const a2uiRecord = isRecord(root.a2ui) ? root.a2ui : undefined;
  const a2ui = isA2UIObject(a2uiRecord) ? a2uiRecord : undefined;
  const stream = isRecord(root.stream) ? root.stream : {};
  const interaction =
    (a2ui && isRecord(a2ui.interaction) ? a2ui.interaction : undefined) ||
    (isRecord(root.interaction) ? root.interaction : undefined);

  return {
    traceId: readNonEmptyString(root.trace_id, root.traceId, a2ui?.trace_id),
    turnIndex: readNumber(root.turn_index, root.turnIndex, a2ui?.turn_index),
    renderKey: readNonEmptyString(root.render_key, root.renderKey, a2ui?.render_key, a2uiRecord?.renderKey) as
      | A2UIRenderKey
      | undefined,
    mode: readNonEmptyString(root.mode, a2ui?.mode),
    streamId: readNonEmptyString(root.stream_id, root.streamId, a2ui?.stream_id, a2uiRecord?.streamId),
    streamGroupId: readNonEmptyString(root.stream_group_id, root.streamGroupId, a2uiRecord?.streamGroupId),
    interactionId: readNonEmptyString(
      root.interaction_id,
      root.interactionId,
      interaction?.interaction_id,
      interaction?.interactionId,
    ),
    toolCallId: readNonEmptyString(root.tool_call_id, root.toolCallId, a2ui?.tool_call_id, a2uiRecord?.toolCallId),
    argsDelta: readString(stream.args_delta, stream.argsDelta, root.args_delta),
    argsText: readString(stream.args_text, stream.argsText, root.args_text),
    argsTextLength: readNumber(stream.args_text_length, stream.argsTextLength, root.args_text_length),
    chunkIndex: readNumber(stream.chunk_index, stream.chunkIndex),
    finishReason: readNonEmptyString(stream.finish_reason, stream.finishReason),
    error: readNonEmptyString(stream.error, stream.message, root.error, root.message),
    streamStatus: readNonEmptyString(stream.status),
    a2ui,
    interaction,
    payload: isRecord(a2ui?.payload) ? a2ui.payload : undefined,
    inputSchema: isRecord(a2ui?.input_schema) ? a2ui.input_schema : undefined,
    submitSchema: isRecord(a2ui?.submit_schema) ? a2ui.submit_schema : undefined,
    resume: isRecord(root.resume) ? root.resume : undefined,
  };
}

export function buildA2UIDebugKey(action: string, snapshot: A2UIEventSnapshot): string {
  return (
    snapshot.streamId ||
    snapshot.streamGroupId ||
    snapshot.interactionId ||
    snapshot.toolCallId ||
    [
      "a2ui",
      snapshot.traceId || "trace",
      snapshot.turnIndex ?? "turn",
      snapshot.renderKey || "render",
      normalizeA2UIAction(action) || action,
    ].join(":")
  );
}

export function createA2UIDebugState(
  id: string,
  snapshot: A2UIEventSnapshot,
  now = Date.now(),
): A2UIDebugBlockState {
  return {
    id,
    status: "idle",
    renderKey: snapshot.renderKey,
    mode: snapshot.mode,
    streamId: snapshot.streamId,
    streamGroupId: snapshot.streamGroupId,
    interactionId: snapshot.interactionId,
    toolCallId: snapshot.toolCallId,
    traceId: snapshot.traceId,
    turnIndex: snapshot.turnIndex,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "empty",
    a2ui: snapshot.a2ui,
    payload: snapshot.payload,
    inputSchema: snapshot.inputSchema,
    submitSchema: snapshot.submitSchema,
    interaction: snapshot.interaction,
    rawEvents: [],
    updatedAt: now,
  };
}

export function mergeA2UIDebugSnapshot(
  debug: A2UIDebugBlockState,
  snapshot: A2UIEventSnapshot,
  now = Date.now(),
): void {
  debug.renderKey = snapshot.renderKey || debug.renderKey;
  debug.mode = snapshot.mode || debug.mode;
  debug.streamGroupId = snapshot.streamGroupId || debug.streamGroupId;
  debug.streamId = snapshot.streamId || debug.streamId;
  debug.interactionId = snapshot.interactionId || debug.interactionId;
  debug.toolCallId = snapshot.toolCallId || debug.toolCallId;
  debug.traceId = snapshot.traceId || debug.traceId;
  debug.turnIndex = snapshot.turnIndex ?? debug.turnIndex;
  debug.finishReason = snapshot.finishReason || debug.finishReason;
  debug.error = snapshot.error || debug.error;

  if (snapshot.a2ui) {
    debug.a2ui = {
      ...(isRecord(debug.a2ui) ? debug.a2ui : {}),
      ...snapshot.a2ui,
    };
    debug.payload = snapshot.payload ?? debug.payload;
    debug.inputSchema = snapshot.inputSchema ?? debug.inputSchema;
    debug.submitSchema = snapshot.submitSchema ?? debug.submitSchema;
  }
  if (snapshot.interaction) {
    mergeA2UIInteraction(debug, snapshot.interaction);
  }
  debug.updatedAt = now;
}

export function applyA2UIEventToDebug(
  debug: A2UIDebugBlockState,
  action: string,
  data: unknown,
  options: { eventId?: string; now?: number } = {},
): void {
  const normalized = normalizeA2UIAction(action);
  if (!normalized) {
    return;
  }
  const now = options.now ?? Date.now();
  const eventData = isRecord(data) ? data : {};
  const snapshot = extractA2UIEventSnapshot(eventData);
  mergeA2UIDebugSnapshot(debug, snapshot, now);
  debug.rawEvents.push({
    id: options.eventId || `a2ui-event:${now}:${debug.rawEvents.length + 1}`,
    action: normalized,
    timestamp: now,
    data: eventData,
  });

  if (normalized === "a2ui_stream_start") {
    debug.status = "started";
    applyStreamBufferSnapshot(debug, snapshot);
    debug.argsTextLength = snapshot.argsTextLength ?? debug.argsTextLength;
    applyBufferParse(debug, false);
    return;
  }

  if (normalized === "a2ui_stream_chunk") {
    const delta = snapshot.argsDelta ?? "";
    debug.status = "streaming";
    debug.latestChunk = delta;
    debug.chunkCount += 1;
    applyStreamBufferSnapshot(debug, snapshot);
    debug.argsTextLength = snapshot.argsTextLength ?? debug.argsBuffer.length;
    applyBufferParse(debug, false);
    return;
  }

  if (normalized === "a2ui_stream_finish") {
    debug.status = snapshot.streamStatus === "failed" ? "failed" : "finished";
    applyStreamBufferSnapshot(debug, snapshot);
    debug.argsTextLength = snapshot.argsTextLength ?? debug.argsBuffer.length;
    debug.finishReason = snapshot.finishReason || debug.finishReason;
    applyBufferParse(debug, true);
    debug.error = snapshot.error || debug.error;
    if (debug.status === "failed" && snapshot.error) {
      debug.parseError = snapshot.error;
    }
    return;
  }

  if (normalized === "a2ui_created") {
    debug.status = "created";
    debug.createdFrame = eventData;
    return;
  }

  if (normalized === "waiting_input" || normalized === "a2ui_waiting_input") {
    const terminalDebugStatus = mapInteractionStatusToDebugStatus(debug.interaction);
    if (terminalDebugStatus === "submitted" || terminalDebugStatus === "cancelled") {
      debug.status = terminalDebugStatus;
      return;
    }
    debug.status = "waiting_input";
    if (snapshot.interactionId && !debug.interaction) {
      debug.interaction = {
        interaction_id: snapshot.interactionId,
        status: "waiting_user_input",
        can_submit: true,
      };
    }
    return;
  }

  if (normalized === "a2ui_submit_ack") {
    debug.status = "submitted";
    mergeA2UIInteraction(debug, {
      ...(isRecord(eventData.interaction) ? eventData.interaction : {}),
      interaction_id: snapshot.interactionId || readNonEmptyString(eventData.interaction_id) || "",
      status: "submitted",
      can_submit: false,
      submit_result: isRecord(eventData.submit_result) ? eventData.submit_result : undefined,
      resume: snapshot.resume,
    });
    return;
  }

  if (normalized === "a2ui_cancel_ack") {
    debug.status = "cancelled";
    mergeA2UIInteraction(debug, {
      ...(isRecord(eventData.interaction) ? eventData.interaction : {}),
      interaction_id: snapshot.interactionId || readNonEmptyString(eventData.interaction_id) || "",
      status: "cancelled",
      can_submit: false,
      cancel_reason: readString(eventData.cancel_reason),
      resume: snapshot.resume,
    });
    return;
  }

  if (normalized === "a2ui_resume" && (snapshot.resume || readNonEmptyString(eventData.resume_status))) {
    mergeA2UIInteraction(debug, {
      ...(isRecord(debug.interaction) ? debug.interaction : {}),
      resume_status: readNonEmptyString(snapshot.resume?.status) || readNonEmptyString(eventData.resume_status),
      resume_group_id: readString(snapshot.resume?.resume_group_id, eventData.resume_group_id),
      pending_count: readNumber(snapshot.resume?.pending_count, eventData.pending_count),
      resume_error: readString(snapshot.resume?.error, eventData.error),
    });
  }
}

export function sanitizeA2UIPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  return sanitizeRecord(payload);
}

export function isA2UITerminalInteractionStatus(status: unknown): boolean {
  const normalized = normalizeInteractionStatus(status);
  return normalized === "submitted" || normalized === "cancelled";
}

export function mapInteractionStatusToDebugStatus(
  interaction?: Record<string, unknown> | A2UIInteractionState | null,
): A2UIDebugLifecycleStatus | undefined {
  const status = normalizeInteractionStatus(interaction?.status);
  if (!status) {
    return undefined;
  }
  if (status === "waiting_user_input") {
    return "waiting_input";
  }
  if (status === "submitted") {
    return "submitted";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "missing" || status === "failed") {
    return "failed";
  }
  return undefined;
}

export function isA2UIDebugWaitingForInput(debug?: A2UIDebugBlockState): boolean {
  if (!debug) {
    return false;
  }
  return debug.status === "waiting_input" || normalizeInteractionStatus(debug.interaction?.status) === "waiting_user_input";
}

export function hasWaitingA2UIInput(
  messages: Array<Pick<AgentChatMessage, "role" | "a2uiDebug">>,
): boolean {
  return messages.some((message) => message.role === "a2ui" && isA2UIDebugWaitingForInput(message.a2uiDebug));
}

export function getA2UIAckResumeStatus(data: unknown): string | undefined {
  const record = isRecord(data) ? data : {};
  const resume = isRecord(record.resume) ? record.resume : undefined;
  return readNonEmptyString(resume?.status)?.toLowerCase();
}

export function createA2UIRequestId(prefix: "submit" | "cancel", now = Date.now()): string {
  const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "") || Math.random().toString(36).slice(2, 14);
  return `${prefix}-${now.toString(36)}-${randomPart}`.slice(0, 64);
}

export function buildA2UISubmitPayload(
  sessionId: string,
  interactionId: string,
  submitResult: Record<string, unknown>,
  requestId = createA2UIRequestId("submit"),
): A2UISubmitActionPayload {
  return {
    action: "a2ui_submit",
    session_id: sessionId,
    interaction_id: interactionId,
    request_id: requestId,
    submit_result: sanitizeA2UIPayload(submitResult),
  };
}

export function buildA2UICancelPayload(
  sessionId: string,
  interactionId: string,
  cancelReason?: string | null,
  requestId = createA2UIRequestId("cancel"),
): A2UICancelActionPayload {
  return {
    action: "a2ui_cancel",
    session_id: sessionId,
    interaction_id: interactionId,
    request_id: requestId,
    cancel_reason: cancelReason ?? null,
  };
}

export type A2UIAnyActionData =
  | A2UIAckActionData
  | A2UICreatedActionData
  | A2UIResumeActionData
  | A2UIStreamActionData
  | A2UIWaitingInputActionData;

function applyBufferParse(debug: A2UIDebugBlockState, final: boolean): void {
  const parsed = parseA2UIArgsBuffer(debug.argsBuffer, final);
  debug.jsonParseStatus = parsed.jsonParseStatus;
  debug.parsedArgs = parsed.parsedArgs;
  debug.parseError = parsed.parseError;
}

function applyStreamBufferSnapshot(
  debug: A2UIDebugBlockState,
  snapshot: A2UIEventSnapshot,
): void {
  if (snapshot.argsText !== undefined) {
    debug.argsBuffer = snapshot.argsText;
    debug.argsTextLength = snapshot.argsTextLength ?? snapshot.argsText.length;
    return;
  }
  if (snapshot.argsDelta !== undefined) {
    debug.argsBuffer += snapshot.argsDelta;
    debug.argsTextLength = snapshot.argsTextLength ?? debug.argsBuffer.length;
  }
}

function mergeA2UIInteraction(
  debug: A2UIDebugBlockState,
  incoming: Record<string, unknown> | A2UIInteractionState,
): void {
  const existing = isRecord(debug.interaction) ? debug.interaction : {};
  if (isA2UITerminalInteractionStatus(existing.status) && !isA2UITerminalInteractionStatus(incoming.status)) {
    debug.interaction = { ...incoming, ...existing };
    return;
  }
  debug.interaction = { ...existing, ...incoming };
}

function normalizeInteractionStatus(status: unknown): string {
  if (typeof status !== "string") {
    return "";
  }
  return status.trim().toLowerCase();
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || typeof value === "function") {
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => (isRecord(item) ? sanitizeRecord(item) : item));
      continue;
    }
    if (isRecord(value)) {
      sanitized[key] = sanitizeRecord(value);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function isA2UIObject(value: unknown): value is A2UIObject {
  return isRecord(value) && typeof value.render_key === "string" && typeof value.mode === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readNonEmptyString(...values: unknown[]): string | undefined {
  const value = readString(...values);
  return value && value.trim() ? value : undefined;
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
