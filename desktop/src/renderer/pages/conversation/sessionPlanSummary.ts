import type { ConversationMessage } from "@/renderer/stores/conversationStore";

export type PlanStatus = "pending" | "in_progress" | "completed" | "failed";

export interface SessionPlanEntry {
  content: string;
  status: PlanStatus;
}

export interface SessionPlanSummary {
  activeEntry: SessionPlanEntry | null;
  activeIndex: number;
  completedCount: number;
  entries: SessionPlanEntry[];
  explanation: string | null;
  failedCount: number;
  totalCount: number;
}

type PlanSnapshotResolution =
  | { found: false; summary: null }
  | { found: true; summary: SessionPlanSummary | null };

export function buildSessionPlanSummary(messages: ConversationMessage[]): SessionPlanSummary | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind !== "plan" || message.status === "failed") {
      continue;
    }
    const resolution = resolvePlanSnapshot(message);
    if (resolution.found) {
      return resolution.summary;
    }
  }
  return null;
}

export function planSummaryFromMessage(message: ConversationMessage): SessionPlanSummary | null {
  return resolvePlanSnapshot(message).summary;
}

function resolvePlanSnapshot(message: ConversationMessage): PlanSnapshotResolution {
  const sources = planPayloadSources(message);

  for (const source of sources) {
    const rawEntries = rawEntriesFromSource(source);
    if (rawEntries === null) {
      continue;
    }
    const entries = rawEntries.map(normalizeEntry).filter((entry): entry is SessionPlanEntry => Boolean(entry));
    if (!entries.length) {
      return { found: true, summary: null };
    }
    const completedCount = entries.filter((entry) => entry.status === "completed").length;
    const failedCount = entries.filter((entry) => entry.status === "failed").length;
    const activeIndex = activePlanEntryIndex(entries);
    return {
      found: true,
      summary: {
        activeEntry: entries[activeIndex] ?? null,
        activeIndex,
        completedCount,
        entries,
        explanation: stringValue(source.explanation),
        failedCount,
        totalCount: entries.length,
      },
    };
  }

  return { found: false, summary: null };
}

function planPayloadSources(message: ConversationMessage): Record<string, unknown>[] {
  const payload = message.payload;
  const directUiPayload = asRecord(payload.ui_payload) ?? asRecord(payload.uiPayload);
  const result = asRecord(payload.result);
  const resultUiPayload = asRecord(result?.ui_payload) ?? asRecord(result?.uiPayload);
  const nestedUiPayload = asRecord(directUiPayload?.ui_payload) ?? asRecord(resultUiPayload?.ui_payload);
  const outputData = asRecord(payload.output_data);
  const outputResult = asRecord(outputData?.result);
  const call = asRecord(payload.call);
  const callArguments = parseMaybeJson(call?.arguments);
  return [
    nestedUiPayload,
    directUiPayload,
    resultUiPayload,
    outputResult,
    asRecord(result?.result),
    asRecord(payload),
    callArguments,
  ].filter((source): source is Record<string, unknown> => Boolean(source));
}

export function activePlanEntryIndex(entries: SessionPlanEntry[]): number {
  if (!entries.length) {
    return -1;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.status !== "pending") {
      return index;
    }
  }
  return 0;
}

function rawEntriesFromSource(source: Record<string, unknown>): unknown[] | null {
  const nested = asRecord(source.ui_payload) ?? asRecord(source.uiPayload);
  if (Array.isArray(source.entries)) {
    return source.entries;
  }
  if (Array.isArray(source.plan)) {
    return source.plan;
  }
  return nested ? rawEntriesFromSource(nested) : null;
}

function normalizeEntry(value: unknown): SessionPlanEntry | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const content = stringValue(record.content) ?? stringValue(record.step);
  if (!content) {
    return null;
  }
  return {
    content,
    status: normalizeStatus(record.status),
  };
}

function normalizeStatus(value: unknown): PlanStatus {
  if (value === "completed" || value === "in_progress" || value === "pending" || value === "failed") {
    return value;
  }
  return "pending";
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
