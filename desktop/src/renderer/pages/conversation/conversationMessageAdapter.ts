import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentChatMessage } from "@/types/protocol";

export function agentMessageToConversationMessage(message: AgentChatMessage, index: number): ConversationMessage {
  const kind = conversationKindFromAgent(message);
  const status = conversationStatusFromAgent(message);
  const payload = payloadFromAgentMessage(message);
  const createdAt = isoFromTimestamp(message.timestamp, index);
  return {
    id: `agent:${message.id}`,
    threadId: message.sessionId,
    turnId: null,
    itemId: message.runId ?? message.id,
    kind,
    status,
    content: message.content,
    payload: { ...payload, _sortSeq: index + 1 },
    createdAt,
    updatedAt: createdAt,
  };
}

export function conversationKindFromAgent(message: AgentChatMessage): ConversationMessage["kind"] {
  if (message.role === "system" && isContextCompressionMessage(message)) {
    return "context_compression";
  }
  if (message.cancelled || message.status === "cancelled") {
    return "cancelled";
  }
  if (message.role === "user") {
    return "user";
  }
  if (message.role === "assistant") {
    return "assistant";
  }
  if (message.role === "reasoning" || message.role === "subagent") {
    return "thinking";
  }
  if (message.role === "tool") {
    if (message.toolName === "update_plan") {
      return "plan";
    }
    if (message.toolName === "load_skill") {
      return "skill";
    }
    return message.toolName === "run_command" ? "command" : "tool";
  }
  if (message.role === "approval") {
    return "approval";
  }
  if (message.role === "error") {
    return "error";
  }
  return "status";
}

export function conversationStatusFromAgent(message: AgentChatMessage): ConversationMessage["status"] {
  if (message.cancelled) {
    return "cancelled";
  }
  if (message.streaming || message.status === "streaming" || message.status === "running") {
    return "running";
  }
  if (message.status === "failed" || message.status === "error") {
    return "failed";
  }
  if (message.status === "cancelled") {
    return "cancelled";
  }
  if (message.role === "approval") {
    return message.status === "pending" ? "pending" : "completed";
  }
  if (message.role === "system" && isContextCompressionMessage(message)) {
    return "completed";
  }
  if (message.role === "tool" || message.role === "assistant" || message.role === "reasoning" || message.role === "subagent") {
    return "completed";
  }
  return undefined;
}

export function payloadFromAgentMessage(message: AgentChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    messageEventId: message.messageEventId,
    turnIndex: message.turnIndex,
    turn_index: message.turnIndex,
    reasoningKind: message.reasoningKind,
    reasoning_kind: message.reasoningKind,
    ghostStats: message.ghostStats,
    traceId: message.traceId,
    traceQueryContext: message.traceQueryContext,
    forkSource: message.forkSource,
    cancelled: message.cancelled,
    contextItems: message.contextItems,
    attachments: message.attachments,
    toolDetailRef: message.toolDetailRef,
    toolDetailsDeferred: message.toolDetailsDeferred,
    toolSummary: message.toolSummary,
    metadata: message.metadata,
  };

  if (message.role === "tool") {
    return {
      ...base,
      call: {
        id: message.toolCallId,
        name: message.toolName,
        arguments: message.toolParams ?? {},
      },
      result: {
        status:
          message.toolError || message.status === "error"
            ? "error"
            : message.status === "running" || message.streaming
              ? "running"
              : "success",
        model_content: message.toolResult ?? "",
        duration_ms: message.toolDurationMs,
        error: message.toolError,
        ui_payload: message.uiPayload,
        files: message.fileChanges ?? fileChangesFromUiPayload(message.uiPayload),
      },
      files: message.fileChanges ?? fileChangesFromUiPayload(message.uiPayload),
      duration_ms: message.toolDurationMs,
      metadata: message.metadata,
      messageEventId: message.messageEventId,
      toolCallId: message.toolCallId,
      runId: message.runId,
      toolDetailRef: message.toolDetailRef,
      toolDetailsDeferred: message.toolDetailsDeferred,
      toolSummary: message.toolSummary,
    };
  }

  if (message.role === "approval") {
    return {
      ...base,
      approval: message.approval,
    };
  }

  if (message.role === "error") {
    return {
      ...base,
      error: {
        code: typeof message.status === "string" ? message.status : "runtime_error",
        message: message.content,
        details: {},
      },
    };
  }

  if (message.role === "subagent") {
    return {
      ...base,
      reasoningKind: "subagent",
      reasoning_kind: "subagent",
      subagentName: message.subagentName,
      subagentTask: message.subagentTask,
      subagentItems: message.subagentItems,
    };
  }

  return base;
}

function isContextCompressionMessage(message: AgentChatMessage): boolean {
  const compression = objectValue(message.metadata?.compression);
  const kind = stringValue(compression?.kind);
  return kind === "context_compression" || kind === "context_compressed";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fileChangesFromUiPayload(uiPayload: Record<string, unknown> | undefined): unknown[] {
  if (!uiPayload) {
    return [];
  }
  if (Array.isArray(uiPayload.files)) {
    return uiPayload.files;
  }
  if (Array.isArray(uiPayload.changes)) {
    return uiPayload.changes;
  }
  return [];
}

function isoFromTimestamp(timestamp: number, index: number): string {
  if (timestamp > 1_000_000_000_000) {
    return new Date(timestamp).toISOString();
  }
  return new Date(Date.now() + index).toISOString();
}
