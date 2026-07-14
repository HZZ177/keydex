import { describe, expect, it, vi } from "vitest";

import {
  createLifecycleEventGate,
  emitLifecycleEvent,
  emitLifecycleEventFromRuntimeEvent,
  getLifecycleEventRevision,
  subscribeLifecycleEvents,
} from "@/renderer/events/lifecycleEvents";

const baseEvent = {
  type: "session_archived" as const,
  session_id: "ses-1",
  workspace_id: null,
  operation_id: "op-1",
  request_id: "req-1",
  occurred_at: "2026-07-14T01:00:00Z",
  revision: 2,
  changed: true,
};

describe("lifecycle event contract", () => {
  it("delivers one typed event to every subscriber", () => {
    const revisionBefore = getLifecycleEventRevision();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeLifecycleEvents(first);
    const unsubscribeSecond = subscribeLifecycleEvents(second);

    emitLifecycleEvent(baseEvent);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(baseEvent);
    expect(getLifecycleEventRevision()).toBe(revisionBefore + 1);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("adapts runtime actions and rejects unrelated actions", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLifecycleEvents(listener);

    expect(
      emitLifecycleEventFromRuntimeEvent({
        action: "session_restored",
        data: { ...baseEvent, type: undefined },
      } as never),
    ).toBe(true);
    expect(
      emitLifecycleEventFromRuntimeEvent({ action: "session_title_updated", data: {} } as never),
    ).toBe(false);
    expect(listener.mock.calls[0][0].type).toBe("session_restored");
    unsubscribe();
  });

  it("keeps newer entity state when lifecycle events arrive out of order", () => {
    const accepts = createLifecycleEventGate();

    expect(accepts({ ...baseEvent, revision: 4, operation_id: "op-new" })).toBe(true);
    expect(accepts({ ...baseEvent, revision: 3, operation_id: "op-old" })).toBe(false);
    expect(
      accepts({
        ...baseEvent,
        revision: 4,
        occurred_at: "2026-07-14T00:59:00Z",
        operation_id: "op-older-time",
      }),
    ).toBe(false);
  });
});
