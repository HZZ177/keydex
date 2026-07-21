import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentToolDetailRef, AgentToolDetails } from "@/types/protocol";

export function toolDetailRefFromMessage(message: ConversationMessage): AgentToolDetailRef | null {
  const ref = asRecord(message.payload.toolDetailRef);
  if (!ref) {
    return null;
  }
  const startEventId = nullableString(ref.startEventId);
  const endEventId = nullableString(ref.endEventId);
  if (!startEventId && !endEventId) {
    return null;
  }
  return {
    startEventId,
    endEventId,
    runId: nullableString(ref.runId),
    toolCallId: nullableString(ref.toolCallId),
  };
}

export function toolDetailCacheKey(sessionId: string, ref: AgentToolDetailRef): string {
  return [
    sessionId,
    ref.startEventId ?? "",
    ref.endEventId ?? "",
    ref.runId ?? "",
    ref.toolCallId ?? "",
  ].join(":");
}

export function conversationPatchFromToolDetails(
  message: ConversationMessage,
  detail: AgentToolDetails,
): Partial<ConversationMessage> {
  const currentCall = asRecord(message.payload.call);
  const currentResult = asRecord(message.payload.result);
  const status = conversationStatusFromToolDetail(detail, message.status);
  const resultStatus =
    detail.status === "cancelled"
      ? "cancelled"
      : detail.error || detail.toolError || detail.status === "error" || detail.status === "failed"
      ? "error"
      : detail.status === "running"
        ? "running"
        : "success";
  const payload: Record<string, unknown> = {
    call: {
      ...currentCall,
      name: detail.toolName ?? stringValue(currentCall?.name),
      arguments: detail.toolParams ?? currentCall?.arguments ?? {},
    },
    result: {
      ...currentResult,
      status: resultStatus,
      model_content: detail.toolResult ?? "",
      duration_ms: detail.toolDurationMs,
      error: detail.error ?? detail.toolError ?? undefined,
      ui_payload: detail.uiPayload ?? undefined,
      files: detail.fileChanges ?? [],
    },
    files: detail.fileChanges ?? [],
    duration_ms: detail.toolDurationMs,
    metadata: detail.metadata ?? message.payload.metadata,
    toolDetailRef: detail.detailRef ?? message.payload.toolDetailRef,
    toolDetailsDeferred: false,
    toolSummary: message.payload.toolSummary,
  };
  return {
    status,
    payload,
  };
}

export function conversationStatusFromToolDetail(
  detail: AgentToolDetails,
  fallback: ConversationMessage["status"],
): ConversationMessage["status"] {
  if (detail.status === "running") {
    return "running";
  }
  if (detail.status === "cancelled") {
    return "cancelled";
  }
  if (detail.error || detail.toolError || detail.status === "error" || detail.status === "failed") {
    return "failed";
  }
  return fallback === "pending" || fallback === "running" ? fallback : "completed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
