import { describe, expect, it } from "vitest";

import { replayRuntimeEvents } from "@/renderer/pages/conversation/messages/reducer";
import { createInitialConversationState } from "@/renderer/stores/conversationStore";
import type { RuntimeEvent } from "@/types/protocol";

describe("event replay", () => {
  it("replays runtime events into projection", () => {
    const state = createInitialConversationState();
    const events: RuntimeEvent[] = [
      {
        event_id: "evt_1",
        thread_id: "thr_1",
        turn_id: "turn_1",
        item_id: null,
        seq: 1,
        type: "turn.started",
        created_at: "2026-06-15T00:00:00Z",
        payload: {
          turn: {
            id: "turn_1",
            thread_id: "thr_1",
            status: "in_progress",
            started_at: "2026-06-15T00:00:00Z",
            completed_at: null,
            duration_ms: null,
            error: null,
          },
        },
      },
    ];

    const next = replayRuntimeEvents(state, events);

    expect(next.turnsById.turn_1.status).toBe("in_progress");
    expect(next.runtimeStateByThread.thr_1).toBe("running");
  });
});
