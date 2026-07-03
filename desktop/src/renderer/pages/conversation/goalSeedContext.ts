import type { AgentContextItem, AgentFileAttachment } from "@/types/protocol";
import type { RuntimeParamsWithInjection } from "@/renderer/utils/messageInjection";

export const GOAL_CONTEXT_ITEM_TYPE = "goal";
export const GOAL_MESSAGE_CONTEXT_ITEMS_KEY = "message_context_items";

export function goalSeedContextMetadata({
  attachments,
  contextItems,
  message,
  runtimeParams,
}: {
  message: string;
  contextItems: AgentContextItem[];
  runtimeParams?: RuntimeParamsWithInjection;
  attachments: AgentFileAttachment[];
}): Record<string, unknown> {
  return {
    seed_turn_context: {
      schema_version: 1,
      source: "goal_composer",
      message,
      context_items: contextItems,
      runtime_params: runtimeParams ?? {},
      attachments,
    },
  };
}

export function goalContextItem(objective: string, title = "目标"): AgentContextItem {
  const normalizedObjective = objective.trim();
  return {
    id: `goal:${hashGoalContext(normalizedObjective || title)}`,
    type: GOAL_CONTEXT_ITEM_TYPE,
    label: title,
    content: normalizedObjective,
    source: "goal",
    metadata: {
      kind: GOAL_CONTEXT_ITEM_TYPE,
      label: title,
      title,
      objective: normalizedObjective,
      source: "goal_composer",
    },
  };
}

export function runtimeParamsWithGoalContextItem(
  runtimeParams: RuntimeParamsWithInjection | undefined,
  item: AgentContextItem,
): RuntimeParamsWithInjection {
  const next: RuntimeParamsWithInjection = { ...(runtimeParams ?? {}) };
  const existing = Array.isArray(next[GOAL_MESSAGE_CONTEXT_ITEMS_KEY])
    ? (next[GOAL_MESSAGE_CONTEXT_ITEMS_KEY] as unknown[])
    : [];
  next[GOAL_MESSAGE_CONTEXT_ITEMS_KEY] = [
    ...existing.filter((value): value is AgentContextItem => Boolean(value && typeof value === "object")),
    item,
  ];
  return next;
}

function hashGoalContext(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
