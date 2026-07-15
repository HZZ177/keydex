import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { conversationBaselineDiagnostics } from "./conversationBaselineDiagnostics";
import {
  buildWebTurnSourceRegistries,
  webSourceRegistryForMessage,
  type WebTurnSourceRegistry,
} from "./webSourceRegistry";

export type ProcessedMessageItem =
  | {
      type: "message";
      id: string;
      message: ConversationMessage;
      webSourceRegistry?: WebTurnSourceRegistry;
    }
  | {
      type: "group";
      id: string;
      groupKind: MessageGroupKind;
      messages: ConversationMessage[];
      sourceMessageIds: string[];
      createdAt: string;
      updatedAt: string;
      webSourceRegistry?: WebTurnSourceRegistry;
    };

export type MessageGroupKind = "tool_activity" | "file_changes";

export function processMessages(messages: ConversationMessage[]): ProcessedMessageItem[] {
  const startedAt = conversationBaselineDiagnostics.isEnabled() && typeof performance !== "undefined"
    ? performance.now()
    : null;
  const items: ProcessedMessageItem[] = [];
  const webSourceRegistries = buildWebTurnSourceRegistries(messages);
  let group: ConversationMessage[] = [];
  let groupKind: MessageGroupKind | null = null;
  let groupTurnIndex: number | null = null;

  const flush = () => {
    if (!group.length || !groupKind) {
      group = [];
      groupKind = null;
      groupTurnIndex = null;
      return;
    }
    if (group.length === 1) {
      const webSourceRegistry = webSourceRegistryForMessage(webSourceRegistries, group[0]);
      items.push({
        type: "message",
        id: group[0].id,
        message: group[0],
        ...(webSourceRegistry ? { webSourceRegistry } : {}),
      });
    } else {
      items.push({
        type: "group",
        id: `${groupKind}:${group[0].id}`,
        groupKind,
        messages: group,
        sourceMessageIds: group.map((message) => message.id),
        createdAt: group[0].createdAt,
        updatedAt: group[group.length - 1].updatedAt,
        ...(webSourceRegistryForMessage(webSourceRegistries, group[0])
          ? { webSourceRegistry: webSourceRegistryForMessage(webSourceRegistries, group[0]) ?? undefined }
          : {}),
      });
    }
    group = [];
    groupKind = null;
    groupTurnIndex = null;
  };

  for (const message of messages) {
    const nextKind = groupKindForMessage(message);
    const nextTurnIndex = messageBusinessTurnIndex(message);
    if (!nextKind) {
      flush();
      const webSourceRegistry = webSourceRegistryForMessage(webSourceRegistries, message);
      items.push({
        type: "message",
        id: message.id,
        message,
        ...(webSourceRegistry ? { webSourceRegistry } : {}),
      });
      continue;
    }

    if (
      groupKind &&
      (groupKind !== nextKind ||
        (groupTurnIndex !== null && nextTurnIndex !== null && groupTurnIndex !== nextTurnIndex))
    ) {
      flush();
    }
    groupKind = nextKind;
    if (groupTurnIndex === null && nextTurnIndex !== null) {
      groupTurnIndex = nextTurnIndex;
    }
    group.push(message);
  }

  flush();
  if (startedAt !== null) {
    conversationBaselineDiagnostics.record({
      stage: "process-messages",
      itemCount: messages.length,
      durationMs: performance.now() - startedAt,
    });
  }
  return items;
}

function groupKindForMessage(message: ConversationMessage): MessageGroupKind | null {
  if (message.kind === "tool" || message.kind === "command") {
    return "tool_activity";
  }
  if (message.kind === "file_change") {
    return "file_changes";
  }
  return null;
}

function messageBusinessTurnIndex(message: ConversationMessage): number | null {
  const value = message.payload.turnIndex ?? message.payload.turn_index;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
