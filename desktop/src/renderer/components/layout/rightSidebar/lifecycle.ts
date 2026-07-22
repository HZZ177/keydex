import { RightSidebarDefinitionRegistry } from "./registry";
import type { RightSidebarLifecycleIntent } from "./reducer";
import type {
  RightSidebarPanelKind,
  RightSidebarPanelLifecycle,
  RightSidebarPanelLifecycleContext,
  RightSidebarPanelState,
  RightSidebarPanelStateFor,
} from "./types";

export interface RightSidebarLifecycleFailure {
  readonly intent: RightSidebarLifecycleIntent;
  readonly error: unknown;
}

export async function runRightSidebarLifecycleIntents(
  intents: readonly RightSidebarLifecycleIntent[],
  registry: RightSidebarDefinitionRegistry,
  context: RightSidebarPanelLifecycleContext,
  onFailure?: (failure: RightSidebarLifecycleFailure) => void,
): Promise<readonly RightSidebarLifecycleFailure[]> {
  const failures: RightSidebarLifecycleFailure[] = [];
  for (const intent of intents) {
    try {
      await runIntent(intent, registry, context);
    } catch (error) {
      const failure = { intent, error };
      failures.push(failure);
      onFailure?.(failure);
    }
  }
  return failures;
}

async function runIntent(
  intent: RightSidebarLifecycleIntent,
  registry: RightSidebarDefinitionRegistry,
  context: RightSidebarPanelLifecycleContext,
): Promise<void> {
  switch (intent.panel.kind) {
    case "files":
      return callLifecycle(registry.get("files").lifecycle, intent, intent.panel, context);
    case "conversation":
      return callLifecycle(registry.get("conversation").lifecycle, intent, intent.panel, context);
    case "review":
      return callLifecycle(registry.get("review").lifecycle, intent, intent.panel, context);
    case "browser":
      return callLifecycle(registry.get("browser").lifecycle, intent, intent.panel, context);
  }
}

async function callLifecycle<K extends RightSidebarPanelKind>(
  lifecycle: RightSidebarPanelLifecycle<K> | undefined,
  intent: RightSidebarLifecycleIntent,
  panel: RightSidebarPanelStateFor<K>,
  context: RightSidebarPanelLifecycleContext,
): Promise<void> {
  if (!lifecycle) return;
  switch (intent.type) {
    case "panel.mount":
      return lifecycle.mount?.(panel, context);
    case "panel.activate":
      return lifecycle.activate?.(panel, context);
    case "panel.deactivate":
      return lifecycle.deactivate?.(panel, context);
    case "panel.destroy":
      return lifecycle.destroy?.(panel, context);
  }
}

export function panelStateFromLifecycleIntent(
  intent: RightSidebarLifecycleIntent,
): RightSidebarPanelState {
  return intent.panel;
}
