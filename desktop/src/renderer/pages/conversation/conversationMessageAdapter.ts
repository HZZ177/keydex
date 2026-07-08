import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { normalizeMessageContent } from "@/renderer/utils/messageContent";
import type { AgentChatMessage, TurnError } from "@/types/protocol";

export function agentMessageToConversationMessage(message: AgentChatMessage, index: number): ConversationMessage {
  const kind = conversationKindFromAgent(message);
  const status = conversationStatusFromAgent(message);
  const payload = payloadFromAgentMessage(message);
  const createdAt = isoFromTimestamp(message.timestamp, index);
  const content = normalizeMessageContent(message.content);
  return {
    id: `agent:${message.id}`,
    threadId: message.sessionId,
    turnId: null,
    itemId: message.runId ?? message.id,
    kind,
    status,
    content,
    payload: { ...payload, _sortSeq: index + 1 },
    createdAt,
    updatedAt: createdAt,
  };
}

export function conversationKindFromAgent(message: AgentChatMessage): ConversationMessage["kind"] {
  if (message.role === "turn") {
    return "turn_marker";
  }
  if (message.role === "thread_task") {
    return "thread_task_status";
  }
  if (message.role === "system" && isLLMRetryMessage(message)) {
    return "llm_retry";
  }
  if (message.role === "system" && isContextCompressionMessage(message)) {
    return "context_compression";
  }
  if (message.role === "tool") {
    if (message.toolName === "update_plan") {
      return "plan";
    }
    if (message.toolName === "load_skill") {
      return "skill";
    }
    return isCommandToolName(message.toolName) ? "command" : "tool";
  }
  if (message.role === "a2ui" || message.contentType === "a2ui" || message.content_type === "a2ui") {
    return "a2ui";
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
  if (message.role === "approval") {
    return "approval";
  }
  if (message.role === "mcp_elicitation") {
    return "mcp_elicitation";
  }
  if (message.role === "error") {
    return "error";
  }
  return "status";
}

function isCommandToolName(value: string | undefined): boolean {
  return value === "run_git_bash" || value === "run_cmd" || value === "run_powershell";
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
  if (message.role === "mcp_elicitation") {
    const status = String(message.status ?? "");
    if (status === "pending") {
      return "pending";
    }
    if (status === "cancelled") {
      return "cancelled";
    }
    if (status === "error") {
      return "failed";
    }
    return "completed";
  }
  if (message.role === "a2ui" || message.contentType === "a2ui" || message.content_type === "a2ui") {
    const status = String(message.a2uiDebug?.status ?? message.a2ui?.interaction?.status ?? message.status ?? "");
    if (status === "started" || status === "streaming" || status === "finished") {
      return "running";
    }
    if (status === "waiting_input" || status === "waiting_user_input") {
      return "pending";
    }
    if (status === "failed" || status === "missing") {
      return "failed";
    }
    if (status === "cancelled") {
      return "cancelled";
    }
    return "completed";
  }
  if (message.role === "system" && isContextCompressionMessage(message)) {
    return "completed";
  }
  if (message.role === "turn" || message.role === "thread_task") {
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
    historyHydrated: message.hydratedFromHistory,
  };
  const turnError = turnErrorFromMessage(message);
  if (turnError) {
    base.error = turnError;
  }

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
              : message.status === "cancelled"
                ? "cancelled"
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

  if (message.role === "thread_task") {
    const resultStatus =
      message.status === "running" || message.streaming
        ? "running"
        : message.status === "cancelled"
          ? "cancelled"
          : message.status === "failed" || message.status === "error"
            ? "error"
            : "success";
    return {
      ...base,
      call: {
        id: message.toolCallId ?? message.runId,
        name: message.toolName ?? "update_thread_task",
        arguments: message.toolParams ?? {},
      },
      result: {
        status: resultStatus,
        model_content: "",
        ui_payload: message.uiPayload,
      },
      ui_payload: message.uiPayload,
      metadata: message.metadata,
      messageEventId: message.messageEventId,
      runId: message.runId,
    };
  }

  if (message.role === "approval") {
    return {
      ...base,
      approval: message.approval,
    };
  }

  if (message.role === "mcp_elicitation") {
    const metadata = objectValue(message.metadata);
    return {
      ...base,
      elicitation: metadata?.mcp_elicitation,
    };
  }

  if (message.role === "a2ui" || message.contentType === "a2ui" || message.content_type === "a2ui") {
    return {
      ...base,
      a2ui: message.a2ui,
      a2uiDebug: message.a2uiDebug,
      contentType: message.contentType,
      content_type: message.content_type,
      renderKey: message.a2ui?.render_key ?? message.a2uiDebug?.renderKey,
      render_key: message.a2ui?.render_key ?? message.a2uiDebug?.renderKey,
      streamId: message.a2ui?.stream_id ?? message.a2uiDebug?.streamId,
      stream_id: message.a2ui?.stream_id ?? message.a2uiDebug?.streamId,
      interaction: message.a2ui?.interaction ?? message.a2uiDebug?.interaction,
      interactionId: message.a2ui?.interaction?.interaction_id ?? message.a2uiDebug?.interactionId,
      interaction_id: message.a2ui?.interaction?.interaction_id ?? message.a2uiDebug?.interactionId,
    };
  }

  if (message.role === "error") {
    return {
      ...base,
      error: turnError ?? fallbackErrorFromMessage(message),
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
  if (kind === "context_compression" || kind === "context_compressed") {
    return true;
  }
  const content = normalizeMessageContent(message.content).trim();
  return content.startsWith("<keydex_context_compression>");
}

function isLLMRetryMessage(message: AgentChatMessage): boolean {
  const retry = objectValue(message.metadata?.retry);
  return stringValue(retry?.kind) === "llm_retry";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function scalarStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function turnErrorFromMessage(message: AgentChatMessage): TurnError | null {
  const source = objectValue(message.metadata?.turnError);
  if (!source) {
    return null;
  }
  return {
    code: scalarStringValue(source.code) || "runtime_error",
    message: normalizeMessageContent(stringValue(source.message)).trim() || "对话执行失败",
    details: objectValue(source.details) ?? {},
  };
}

function fallbackErrorFromMessage(message: AgentChatMessage): TurnError {
  return {
    code: typeof message.status === "string" ? message.status : "runtime_error",
    message: normalizeMessageContent(message.content).trim() || "对话执行失败",
    details: {},
  };
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
