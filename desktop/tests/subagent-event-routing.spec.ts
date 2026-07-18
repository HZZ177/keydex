import { describe, expect, it } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import {
  routeSubagentEvent,
  snapshotsFromSubagentEvent,
} from "@/renderer/stores/subagentEventRouting";
import {
  createInitialAgentConversationState,
  reduceAgentWsEvent,
  selectAgentMessages,
} from "@/renderer/stores/agentSessionStore";
import type { AgentActionEnvelope } from "@/types/protocol";


describe("Sub-Agent old/new event isolation", () => {
  it("routes versioned Runtime snapshots and legacy inline lifecycle exclusively", () => {
    expect(routeSubagentEvent(event("subagent_run_updated", snapshotFixture))).toBe("runtime");
    expect(routeSubagentEvent(event("subagent_start", { subagent_id: "legacy-1" }))).toBe(
      "legacy_inline",
    );
    expect(routeSubagentEvent(event("stream", { content: "ordinary" }))).toBe("none");
  });

  it("does not project a new Runtime snapshot into the legacy inline transcript", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(
      state,
      event("subagent_start", {
        session_id: "parent-fixture-1",
        subagent_id: "legacy-1",
        run_id: "legacy-run-1",
        task: "legacy task",
      }),
    );
    expect(selectAgentMessages(state, "parent-fixture-1")).toHaveLength(1);

    state = reduceAgentWsEvent(
      state,
      event("subagent_run_updated", { ...snapshotFixture, session_id: "parent-fixture-1" }),
    );

    expect(selectAgentMessages(state, "parent-fixture-1")).toHaveLength(1);
    expect(selectAgentMessages(state, "parent-fixture-1")[0].subagentId).toBe("legacy-1");
  });

  it("extracts only versioned Runtime snapshots and never upgrades legacy payloads", () => {
    expect(
      snapshotsFromSubagentEvent(
        event("subagent_runs_snapshot", { list: [snapshotFixture] }),
      ),
    ).toEqual([snapshotFixture]);
    expect(
      snapshotsFromSubagentEvent(
        event("subagent_start", { session_id: "parent-fixture-1", run_id: "legacy-run" }),
      ),
    ).toEqual([]);
  });
});


function event(action: AgentActionEnvelope["action"], data: Record<string, unknown>): AgentActionEnvelope {
  return { action, data };
}
