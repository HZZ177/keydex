import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

export type ToolDetailsLoader = (message: ConversationMessage) => Promise<Partial<ConversationMessage>>;

interface ToolDetailsState {
  error: boolean;
  loading: boolean;
  message: ConversationMessage;
  load: () => Promise<void>;
}

export function useLazyToolDetails(
  message: ConversationMessage,
  loadDetails?: ToolDetailsLoader,
): ToolDetailsState {
  const [loadedPatch, setLoadedPatch] = useState<Partial<ConversationMessage> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const detailKey = useMemo(() => toolDetailKey(message), [message]);

  useEffect(() => {
    setLoadedPatch(null);
    setLoading(false);
    setError(false);
  }, [detailKey]);

  const load = useCallback(async () => {
    if (!loadDetails || !isDeferredToolMessage(message) || loading || loadedPatch) {
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const patch = await loadDetails(message);
      setLoadedPatch(patch);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [loadDetails, loadedPatch, loading, message]);

  return {
    error,
    loading,
    message: loadedPatch ? mergeMessagePatch(message, loadedPatch) : message,
    load,
  };
}

function mergeMessagePatch(
  message: ConversationMessage,
  patch: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    ...message,
    ...patch,
    payload: {
      ...message.payload,
      ...(patch.payload ?? {}),
      toolDetailsDeferred: false,
    },
  };
}

function isDeferredToolMessage(message: ConversationMessage): boolean {
  return message.payload.toolDetailsDeferred === true;
}

function toolDetailKey(message: ConversationMessage): string {
  const ref = asRecord(message.payload.toolDetailRef);
  return [
    message.id,
    stringValue(ref?.startEventId),
    stringValue(ref?.endEventId),
    stringValue(ref?.runId),
    stringValue(ref?.toolCallId),
  ].join(":");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
