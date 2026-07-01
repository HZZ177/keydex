import type { RuntimeBridge } from "@/runtime";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentChatMessagePayload, AgentSession } from "@/types/protocol";

export const BTW_SESSION_TAG = "btw";
export const BTW_CONVERSATION_TITLE = "旁路对话";
export const BTW_FORK_HISTORY_PAGE_SIZE = 100;

export type ForkSourcePayload = { messageEventId: string } | { turnIndex: number };
export type CreateBtwConversationResult =
  | { session: AgentSession }
  | { error: "missing_session" | "no_source"; message: string };

const NON_FORKABLE_MESSAGE_STATUSES = new Set(["running", "streaming", "failed", "error", "cancelled", "cancelling"]);

export function latestCompleteForkSource(messages: AgentChatMessagePayload[]): ForkSourcePayload | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isCompleteAssistantForkMessage(message)) {
      continue;
    }
    const messageEventId = nonEmptyString(message.messageEventId);
    if (messageEventId) {
      return { messageEventId };
    }
    if (typeof message.turnIndex === "number" && Number.isInteger(message.turnIndex)) {
      return { turnIndex: message.turnIndex };
    }
  }
  return null;
}

export async function createBtwConversationFromSession(
  runtime: RuntimeBridge,
  sessionId: string,
): Promise<CreateBtwConversationResult> {
  const cleanedSessionId = sessionId.trim();
  if (!cleanedSessionId) {
    return { error: "missing_session", message: "当前会话无法开启旁路对话" };
  }
  const history = await runtime.conversation.loadHistory(cleanedSessionId, {
    pageSize: BTW_FORK_HISTORY_PAGE_SIZE,
  });
  const source = latestCompleteForkSource(history.list);
  if (!source) {
    return { error: "no_source", message: "没有可派生的完整轮次" };
  }
  const response = await runtime.conversation.forkSession(cleanedSessionId, {
    ...source,
    sessionTag: BTW_SESSION_TAG,
    title: BTW_CONVERSATION_TITLE,
  });
  return { session: response.session };
}

export function countLoadedConversationTurns(messages: ConversationMessage[]): number {
  const userTurnIndexes = new Set<number>();
  const allTurnIndexes = new Set<number>();
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  for (const message of messages) {
    if (message.kind === "user") {
      userMessageCount += 1;
    } else if (message.kind === "assistant") {
      assistantMessageCount += 1;
    }
    const turnIndex = numberValue(message.payload.turnIndex ?? message.payload.turn_index);
    if (turnIndex === null) {
      continue;
    }
    allTurnIndexes.add(turnIndex);
    if (message.kind === "user") {
      userTurnIndexes.add(turnIndex);
    }
  }

  if (userTurnIndexes.size > 0) {
    return userTurnIndexes.size;
  }
  if (allTurnIndexes.size > 0) {
    return allTurnIndexes.size;
  }
  if (userMessageCount > 0) {
    return userMessageCount;
  }
  return assistantMessageCount;
}

function isCompleteAssistantForkMessage(message: AgentChatMessagePayload): boolean {
  if (message.role !== "assistant" || message.streaming || message.cancelled) {
    return false;
  }
  const status = typeof message.status === "string" ? message.status.toLowerCase() : "";
  return !NON_FORKABLE_MESSAGE_STATUSES.has(status);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
