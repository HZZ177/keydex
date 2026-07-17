import { stableMarkdownIdentityHash } from "@/renderer/markdownRuntime/document/identity";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ProcessedMessageItem } from "../messages/processMessages";

export type ConversationRenderUnitKind =
  | "turn-shell"
  | "user-markdown"
  | "assistant-markdown"
  | "reasoning"
  | "tool"
  | "tool-group"
  | "file-change"
  | "file-change-group"
  | "a2ui"
  | "approval"
  | "mcp-elicitation"
  | "error"
  | "skill"
  | "task-status"
  | "status"
  | "event"
  | "footer";

export type ConversationRenderOwner = "markdown-runtime" | "react" | "shell";
export type ConversationMeasurementPolicy = "estimate-once" | "observe-until-settled" | "observe-always";
export type ConversationPinPolicy = "never" | "while-active" | "while-interacting";

export interface ConversationRenderUnit {
  readonly id: string;
  readonly kind: ConversationRenderUnitKind;
  readonly owner: ConversationRenderOwner;
  readonly turnId: string | null;
  readonly turnIndex: number | null;
  readonly businessTurnIndex: number | null;
  readonly sourceMessageIds: readonly string[];
  readonly item: ProcessedMessageItem | null;
  readonly parentUnitId: string | null;
  readonly dynamic: boolean;
  readonly interactive: boolean;
  readonly pinPolicy: ConversationPinPolicy;
  readonly measurementPolicy: ConversationMeasurementPolicy;
  readonly estimatedHeight: number;
  readonly renderVersion: string;
}

export interface ConversationRenderTurn {
  readonly id: string;
  readonly items: readonly ProcessedMessageItem[];
  readonly turnMarker: ConversationMessage | null;
  readonly showThreadTaskContinuationNotice: boolean;
}

export type ConversationRenderSegment =
  | { readonly type: "event"; readonly id: string; readonly item: ProcessedMessageItem; readonly unitId: string }
  | { readonly type: "turn"; readonly id: string; readonly turn: ConversationRenderTurn; readonly turnIndex: number };

export interface ConversationRenderProjection {
  readonly segments: readonly ConversationRenderSegment[];
  readonly turns: readonly ConversationRenderTurn[];
  readonly units: readonly ConversationRenderUnit[];
  readonly unitIdsByTurn: ReadonlyMap<string, readonly string[]>;
}

export function projectConversationRenderUnits(
  displayItems: readonly ProcessedMessageItem[],
): ConversationRenderProjection {
  const segments: ConversationRenderSegment[] = [];
  const turns: ConversationRenderTurn[] = [];
  const units: ConversationRenderUnit[] = [];
  const unitIdsByTurn = new Map<string, readonly string[]>();
  let pendingTurnItems: ProcessedMessageItem[] = [];

  const flushTurns = () => {
    if (!pendingTurnItems.length) return;
    for (const turn of groupConversationItemsByTurn(pendingTurnItems)) {
      const turnIndex = turns.length;
      turns.push(turn);
      segments.push({ type: "turn", id: turn.id, turn, turnIndex });
      const turnUnits = unitsForTurn(turn, turnIndex);
      units.push(...turnUnits);
      unitIdsByTurn.set(turn.id, Object.freeze(turnUnits.map((unit) => unit.id)));
    }
    pendingTurnItems = [];
  };

  for (const item of displayItems) {
    if (isTimelineEventItem(item)) {
      flushTurns();
      const unit = unitForItem(item, null, null, null);
      units.push(unit);
      segments.push({ type: "event", id: `event:${item.id}`, item, unitId: unit.id });
      continue;
    }
    pendingTurnItems.push(item);
  }
  flushTurns();
  return Object.freeze({
    segments: Object.freeze(segments),
    turns: Object.freeze(turns),
    units: Object.freeze(units),
    unitIdsByTurn,
  });
}

export function groupConversationItemsByTurn(
  displayItems: readonly ProcessedMessageItem[],
): ConversationRenderTurn[] {
  const turns: ConversationRenderTurn[] = [];
  let items: ProcessedMessageItem[] = [];
  let turnBusinessIndex: number | null = null;
  let turnMarker: ConversationMessage | null = null;
  const flush = () => {
    if (!items.length) {
      turnMarker = null;
      turnBusinessIndex = null;
      return;
    }
    turns.push(Object.freeze({
      id: turnIdFromItems(items, turnMarker),
      items: Object.freeze(items),
      turnMarker,
      showThreadTaskContinuationNotice: isGoalContinuationTurnMarker(turnMarker),
    }));
    items = [];
    turnBusinessIndex = null;
    turnMarker = null;
  };
  for (const item of displayItems) {
    if (isTurnMarkerItem(item)) {
      const markerTurnIndex = messageBusinessTurnIndex(item.message);
      if (isGoalContinuationTurnMarker(item.message)) {
        flush();
        turnMarker = item.message;
        turnBusinessIndex = markerTurnIndex;
        continue;
      }
      if (items.length && markerTurnIndex !== null && turnBusinessIndex !== null && markerTurnIndex !== turnBusinessIndex) flush();
      turnMarker = item.message;
      if (markerTurnIndex !== null) turnBusinessIndex = markerTurnIndex;
      continue;
    }
    if (isUserItem(item)) flush();
    const itemTurnIndex = itemBusinessTurnIndex(item);
    if (items.length && itemTurnIndex !== null && turnBusinessIndex !== null && itemTurnIndex !== turnBusinessIndex) flush();
    items.push(item);
    if (itemTurnIndex !== null) turnBusinessIndex = itemTurnIndex;
  }
  flush();
  return turns;
}

function unitsForTurn(turn: ConversationRenderTurn, turnIndex: number): ConversationRenderUnit[] {
  const businessTurnIndex = turn.items.map(itemBusinessTurnIndex).find((value) => value !== null)
    ?? (turn.turnMarker ? messageBusinessTurnIndex(turn.turnMarker) : null);
  const units: ConversationRenderUnit[] = [];
  if (turn.showThreadTaskContinuationNotice) {
    units.push(Object.freeze({
      id: `unit:turn-shell:${turn.id}`,
      kind: "turn-shell",
      owner: "shell",
      turnId: turn.id,
      turnIndex,
      businessTurnIndex,
      sourceMessageIds: Object.freeze(turn.turnMarker ? [turn.turnMarker.id] : []),
      item: null,
      parentUnitId: null,
      dynamic: false,
      interactive: false,
      pinPolicy: "never",
      measurementPolicy: "estimate-once",
      estimatedHeight: 36,
      renderVersion: `shell:1:${turn.turnMarker?.id ?? "none"}`,
    }));
  }
  const statusItems = turn.items.filter(isThreadTaskStatusItem);
  const renderableItems = turn.items.filter((item) => !isThreadTaskStatusItem(item));
  for (const item of [...renderableItems, ...statusItems]) {
    units.push(unitForItem(item, turn.id, turnIndex, businessTurnIndex));
  }
  const lastAssistant = [...turn.items]
    .reverse()
    .flatMap(messagesFromItem)
    .find((message) => message.kind === "assistant");
  const footerAnchor = lastAssistant ?? [...turn.items].reverse().flatMap(messagesFromItem)[0];
  if (footerAnchor) units.push(footerUnit(footerAnchor, turn.id, turnIndex, businessTurnIndex));
  return units;
}

function unitForItem(
  item: ProcessedMessageItem,
  turnId: string | null,
  turnIndex: number | null,
  businessTurnIndex: number | null,
): ConversationRenderUnit {
  const messages = messagesFromItem(item);
  const primary = messages[0];
  const kind = renderKind(item, primary);
  const dynamic = messages.some(isDynamicMessage);
  const interactive = messages.some(isInteractiveMessage);
  const sourceMessageIds = Object.freeze(messages.map((message) => message.id));
  return Object.freeze({
    id: unitIdentity(item, kind),
    kind,
    owner: kind === "user-markdown" || kind === "assistant-markdown" ? "markdown-runtime" : "react",
    turnId,
    turnIndex,
    businessTurnIndex: itemBusinessTurnIndex(item) ?? businessTurnIndex,
    sourceMessageIds,
    item,
    parentUnitId: null,
    dynamic,
    interactive,
    pinPolicy: interactive ? "while-interacting" : dynamic ? "while-active" : "never",
    measurementPolicy: interactive ? "observe-always" : dynamic ? "observe-until-settled" : "estimate-once",
    estimatedHeight: estimatedHeight(kind),
    renderVersion: renderVersion(kind, messages),
  });
}

function footerUnit(
  message: ConversationMessage,
  turnId: string,
  turnIndex: number,
  businessTurnIndex: number | null,
): ConversationRenderUnit {
  return Object.freeze({
    // The active footer must survive reasoning/tool/assistant segment changes
    // within the same turn. Keying it by the current tail message remounts the
    // footer while streaming and makes the bottom anchor jump between frames.
    id: `unit:footer:${turnId}`,
    kind: "footer",
    owner: "react",
    turnId,
    turnIndex,
    businessTurnIndex,
    sourceMessageIds: Object.freeze([message.id]),
    item: null,
    parentUnitId: `unit:assistant-markdown:${message.id}`,
    dynamic: message.status === "running" || message.status === "pending",
    // Footer buttons are pinned by native focus/selection state. Marking every
    // completed footer as intrinsically interactive would permanently pin one
    // unit per turn and defeat bounded virtualization on long conversations.
    interactive: false,
    pinPolicy: "never",
    measurementPolicy: "observe-until-settled",
    estimatedHeight: 40,
    renderVersion: `footer:${message.status ?? "unknown"}:${footerPayloadVersion(message.payload)}`,
  });
}

function renderKind(item: ProcessedMessageItem, message: ConversationMessage): ConversationRenderUnitKind {
  if (item.type === "group") return item.groupKind === "file_changes" ? "file-change-group" : "tool-group";
  switch (message.kind) {
    case "user": return "user-markdown";
    case "assistant": return "assistant-markdown";
    case "thinking": return "reasoning";
    case "tool": case "command": return "tool";
    case "file_change": return "file-change";
    case "a2ui": return "a2ui";
    case "approval": return "approval";
    case "mcp_elicitation": return "mcp-elicitation";
    case "error": case "cancelled": case "llm_retry": return "error";
    case "skill": return "skill";
    case "thread_task_status": return "task-status";
    case "context_compression": return "event";
    default: return "status";
  }
}

function unitIdentity(item: ProcessedMessageItem, kind: ConversationRenderUnitKind): string {
  return `unit:${kind}:${item.id}`;
}

function renderVersion(kind: ConversationRenderUnitKind, messages: readonly ConversationMessage[]): string {
  return stableMarkdownIdentityHash(messages.map((message) => {
    const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
    return [
      message.id,
      message.status ?? "",
      content.length,
      contentRenderFingerprint(message, content),
      a2uiRenderStateFingerprint(message),
      fileChangeRenderStateFingerprint(message),
      footerPayloadVersion(message.payload),
    ].join("\u0000");
  }).join("\u0001") + kind);
}

function a2uiRenderStateFingerprint(message: ConversationMessage): string {
  if (message.kind !== "a2ui") return "";
  // DocumentView preserves measured geometry by stable unit id. A2UI history
  // can settle through payload-only updates, so these fields must invalidate
  // both the React render and any retained expanded-state height.
  const a2ui = recordValue(message.payload.a2ui);
  const debug = recordValue(message.payload.a2uiDebug);
  return stableMarkdownIdentityHash(JSON.stringify({
    historyHydrated: message.payload.historyHydrated === true,
    renderKey: message.payload.renderKey ?? message.payload.render_key ?? a2ui?.render_key ?? debug?.renderKey,
    streamId: message.payload.streamId ?? message.payload.stream_id ?? a2ui?.stream_id ?? debug?.streamId,
    debugStatus: debug?.status,
    debugUpdatedAt: debug?.updatedAt,
    chunkCount: debug?.chunkCount,
    argsTextLength: debug?.argsTextLength,
    jsonParseStatus: debug?.jsonParseStatus,
    payloadInteraction: message.payload.interaction,
    a2uiInteraction: a2ui?.interaction,
    debugInteraction: debug?.interaction,
  }));
}

function fileChangeRenderStateFingerprint(message: ConversationMessage): string {
  if (message.kind !== "tool" && message.kind !== "file_change") return "";
  const payload = message.payload;
  const result = recordValue(payload.result);
  const directUiPayload = recordValue(payload.ui_payload) ?? recordValue(payload.uiPayload);
  const resultUiPayload = recordValue(result?.ui_payload) ?? recordValue(result?.uiPayload);
  const files = firstRecordList(
    payload.files,
    result?.files,
    directUiPayload?.files,
    directUiPayload?.changes,
    resultUiPayload?.files,
    resultUiPayload?.changes,
  );
  const records = files.length ? files : message.kind === "file_change" ? [payload] : [];
  if (!records.length) return "";
  return stableMarkdownIdentityHash(JSON.stringify(records.map((file) => ({
    path: file.path,
    oldPath: file.old_path ?? file.oldPath,
    newPath: file.new_path ?? file.newPath,
    operation: file.operation ?? file.change_type ?? file.changeType,
    additions: file.added_lines ?? file.additions,
    deletions: file.deleted_lines ?? file.removed_lines ?? file.deletions,
    source: file.source,
    patchComplete: file.patch_complete ?? file.patchComplete,
    patchPrecision: file.patch_precision ?? file.patchPrecision,
    diff: boundedTextRenderFingerprint(file.diff ?? file.raw_patch ?? file.rawPatch),
  }))));
}

function firstRecordList(...values: unknown[]): Record<string, unknown>[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const records = value.map(recordValue).filter((record): record is Record<string, unknown> => Boolean(record));
    if (records.length) return records;
  }
  return [];
}

function boundedTextRenderFingerprint(value: unknown): string {
  const text = stringValue(value);
  if (!text) return "";
  return stableMarkdownIdentityHash(`${text.length}\u0000${text.slice(0, 128)}\u0000${text.slice(-256)}`);
}

function contentRenderFingerprint(message: ConversationMessage, content: string): string {
  const streaming = message.status === "running" || message.status === "pending";
  if (!streaming || content.length <= 8_192) return stableMarkdownIdentityHash(content);
  // The protocol timestamp catches same-length corrections; the bounded head
  // and tail fingerprint catches ordinary append/tail replacement without
  // rescanning the immutable prefix for every streamed token batch.
  return stableMarkdownIdentityHash([
    message.updatedAt ?? "",
    content.slice(0, 256),
    content.slice(-1_024),
  ].join("\u0000"));
}

function footerPayloadVersion(payload: Record<string, unknown>): string {
  return stableMarkdownIdentityHash(JSON.stringify({
    duration: payload.turnDurationMs ?? payload.turn_duration_ms ?? payload.duration_ms ?? payload.durationMs,
    fork: payload.fork ?? payload.fork_source ?? payload.forkSource,
    firstToken: payload.first_token_at_ms ?? payload.firstTokenAtMs,
  }));
}

function estimatedHeight(kind: ConversationRenderUnitKind): number {
  switch (kind) {
    case "turn-shell": return 1;
    case "user-markdown": return 72;
    case "assistant-markdown": return 120;
    case "reasoning": return 88;
    case "a2ui": return 300;
    case "approval": case "mcp-elicitation": return 220;
    case "tool-group": case "file-change-group": return 76;
    case "tool": case "file-change": return 68;
    case "error": return 100;
    case "footer": return 40;
    default: return 56;
  }
}

function isDynamicMessage(message: ConversationMessage): boolean {
  if (message.kind === "a2ui") return isLiveA2UIStreamMessage(message);
  return message.status === "pending" || message.status === "running"
    || message.kind === "thinking" && message.status !== "completed";
}

function isInteractiveMessage(message: ConversationMessage): boolean {
  // A settled A2UI card is not intrinsically active. Focus, dirty input and
  // expanded state are tracked by ConversationPinRegistry while the user is
  // actually interacting with the mounted card. Treating the message kind as
  // permanently interactive keeps every historical card mounted forever.
  return message.kind === "approval" && message.status === "pending"
    || message.kind === "mcp_elicitation" && message.status === "pending"
    || message.kind === "command" && message.status === "running";
}

export function isLiveA2UIStreamMessage(message: ConversationMessage): boolean {
  if (recordValue(message.payload.a2ui)) return false;
  const debug = recordValue(message.payload.a2uiDebug);
  const status = stringValue(debug?.status).toLowerCase();
  return status === "started" || status === "streaming" || status === "finished";
}

function isTimelineEventItem(item: ProcessedMessageItem): boolean {
  return item.type === "message" && item.message.kind === "context_compression";
}

function isUserItem(item: ProcessedMessageItem): boolean {
  return item.type === "message" && item.message.kind === "user";
}

function isTurnMarkerItem(item: ProcessedMessageItem): item is Extract<ProcessedMessageItem, { type: "message" }> {
  return item.type === "message" && item.message.kind === "turn_marker";
}

function isThreadTaskStatusItem(item: ProcessedMessageItem): boolean {
  return item.type === "message" && item.message.kind === "thread_task_status";
}

function itemBusinessTurnIndex(item: ProcessedMessageItem): number | null {
  for (const message of messagesFromItem(item)) {
    const turnIndex = messageBusinessTurnIndex(message);
    if (turnIndex !== null) return turnIndex;
  }
  return null;
}

function messageBusinessTurnIndex(message: ConversationMessage): number | null {
  const value = message.payload.turnIndex ?? message.payload.turn_index;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function messagesFromItem(item: ProcessedMessageItem): ConversationMessage[] {
  return item.type === "message" ? [item.message] : item.messages;
}

function isGoalContinuationTurnMarker(message: ConversationMessage | null): boolean {
  if (!message || message.kind !== "turn_marker") return false;
  const metadata = recordValue(message.payload.metadata);
  const source = stringValue(metadata?.source) || stringValue(message.payload.source);
  const task = recordValue(message.payload.thread_task)
    ?? recordValue(metadata?.thread_task)
    ?? recordValue(recordValue(message.payload.runtime_params)?.thread_task);
  return source === "thread_task" && stringValue(task?.trigger) === "task_continue" && stringValue(task?.type) === "goal";
}

function turnIdFromItems(items: readonly ProcessedMessageItem[], marker: ConversationMessage | null): string {
  const user = items.find((item) => item.type === "message" && item.message.kind === "user");
  return `turn:${user?.id ?? marker?.id ?? items[0].id}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
