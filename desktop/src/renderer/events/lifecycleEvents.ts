import type { AgentActionEnvelope } from "@/types/protocol";
import type { LifecycleEventPayload } from "@/runtime/archive";

const LIFECYCLE_EVENT = "keydex-lifecycle-event";
let lifecycleEventRevision = 0;
const TYPES = new Set<LifecycleEventPayload["type"]>([
  "session_archived",
  "session_restored",
  "session_purged",
  "workspace_archived",
  "workspace_restored",
  "workspace_purged",
  "workspace_sessions_purged",
]);

export function emitLifecycleEvent(event: LifecycleEventPayload): void {
  if (typeof window === "undefined" || !TYPES.has(event.type)) {
    return;
  }
  lifecycleEventRevision += 1;
  window.dispatchEvent(
    new CustomEvent<LifecycleEventPayload>(LIFECYCLE_EVENT, { detail: event }),
  );
}

export function getLifecycleEventRevision(): number {
  return lifecycleEventRevision;
}

export function emitLifecycleEventFromRuntimeEvent(event: AgentActionEnvelope): boolean {
  if (!TYPES.has(event.action as LifecycleEventPayload["type"])) {
    return false;
  }
  const data = event.data && typeof event.data === "object" ? event.data : {};
  emitLifecycleEvent({
    ...(data as Omit<LifecycleEventPayload, "type">),
    type: event.action as LifecycleEventPayload["type"],
  });
  return true;
}

export function subscribeLifecycleEvents(
  handler: (event: LifecycleEventPayload) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<LifecycleEventPayload>).detail;
    if (detail && TYPES.has(detail.type)) {
      handler(detail);
    }
  };
  window.addEventListener(LIFECYCLE_EVENT, listener);
  return () => window.removeEventListener(LIFECYCLE_EVENT, listener);
}

export function createLifecycleEventGate() {
  const latest = new Map<string, { revision: number; occurredAt: string; operationId: string }>();
  return (event: LifecycleEventPayload): boolean => {
    const entityId = event.session_id ?? event.workspace_id;
    if (!entityId) {
      return false;
    }
    const key = `${event.session_id ? "session" : "workspace"}:${entityId}`;
    const next = {
      revision: event.revision ?? 0,
      occurredAt: event.occurred_at ?? "",
      operationId: event.operation_id ?? "",
    };
    const previous = latest.get(key);
    if (
      previous &&
      (next.revision < previous.revision ||
        (next.revision === previous.revision && next.occurredAt < previous.occurredAt) ||
        (next.revision === previous.revision &&
          next.occurredAt === previous.occurredAt &&
          next.operationId <= previous.operationId))
    ) {
      return false;
    }
    latest.set(key, next);
    return true;
  };
}
