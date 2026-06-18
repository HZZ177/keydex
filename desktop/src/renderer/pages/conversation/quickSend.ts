export interface QueuedQuickChatSend {
  id: string;
  sessionId: string;
  model: string;
  message: string;
}

const quickChatSends = new Map<string, QueuedQuickChatSend>();

export function queueQuickChatSend(input: Omit<QueuedQuickChatSend, "id">): QueuedQuickChatSend {
  const pending = {
    id: createQuickChatSendId(),
    ...input,
  };
  quickChatSends.set(pending.id, pending);
  return pending;
}

export function consumeQuickChatSend(id: string, sessionId: string): QueuedQuickChatSend | null {
  const pending = quickChatSends.get(id);
  if (!pending || pending.sessionId !== sessionId) {
    return null;
  }
  quickChatSends.delete(id);
  return pending;
}

export function clearQuickChatSendQueue() {
  quickChatSends.clear();
}

function createQuickChatSendId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `quick:${crypto.randomUUID()}`;
  }
  return `quick:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}
