import type { ConversationMessage } from "@/renderer/stores/conversationStore";

export type ProcessedMessageItem =
  | {
      type: "message";
      id: string;
      message: ConversationMessage;
    }
  | {
      type: "group";
      id: string;
      groupKind: MessageGroupKind;
      messages: ConversationMessage[];
      sourceMessageIds: string[];
      createdAt: string;
      updatedAt: string;
    };

export type MessageGroupKind = "tool_activity" | "file_changes";

export function processMessages(messages: ConversationMessage[]): ProcessedMessageItem[] {
  const items: ProcessedMessageItem[] = [];
  let group: ConversationMessage[] = [];
  let groupKind: MessageGroupKind | null = null;

  const flush = () => {
    if (!group.length || !groupKind) {
      group = [];
      groupKind = null;
      return;
    }
    if (group.length === 1) {
      items.push({ type: "message", id: group[0].id, message: group[0] });
    } else {
      items.push({
        type: "group",
        id: `${groupKind}:${group.map((message) => message.id).join(",")}`,
        groupKind,
        messages: group,
        sourceMessageIds: group.map((message) => message.id),
        createdAt: group[0].createdAt,
        updatedAt: group[group.length - 1].updatedAt,
      });
    }
    group = [];
    groupKind = null;
  };

  for (const message of messages) {
    const nextKind = groupKindForMessage(message);
    if (!nextKind) {
      flush();
      items.push({ type: "message", id: message.id, message });
      continue;
    }

    if (groupKind && groupKind !== nextKind) {
      flush();
    }
    groupKind = nextKind;
    group.push(message);
  }

  flush();
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
