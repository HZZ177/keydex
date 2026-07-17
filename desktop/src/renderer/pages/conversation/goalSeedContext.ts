import type { AgentContextItem, ThreadTask } from "@/types/protocol";
import type { RuntimeParamsWithInjection } from "@/renderer/utils/messageInjection";

export const GOAL_CONTEXT_ITEM_TYPE = "goal";
export const GOAL_MESSAGE_CONTEXT_ITEMS_KEY = "message_context_items";
export const GOAL_INITIAL_THREAD_TASK_KEY = "initial_thread_task";

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

export function runtimeParamsWithInitialGoalTask(
  runtimeParams: RuntimeParamsWithInjection | undefined,
  task: ThreadTask,
): RuntimeParamsWithInjection {
  return {
    ...(runtimeParams ?? {}),
    [GOAL_INITIAL_THREAD_TASK_KEY]: {
      task_id: task.id,
      type: task.type || GOAL_CONTEXT_ITEM_TYPE,
      trigger: "task_start",
    },
  };
}

function hashGoalContext(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
