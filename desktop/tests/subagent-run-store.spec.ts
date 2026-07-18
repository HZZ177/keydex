import { describe, expect, it } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import {
  createInitialSubagentRunsState,
  mergeSubagentRunSnapshot,
  reduceSubagentRunEvent,
  replaceParentSubagentRuns,
  selectParentSubagentRuns,
  selectSubagentHistory,
  selectSubagentRun,
  markSubagentRunRead,
} from "@/renderer/stores/subagentRunStore";
import { normalizeSubagentRunSnapshot } from "@/types/subagents";


describe("SubagentRunStore foundation", () => {
  it("projects all six lifecycle states and running block reasons as independent capsules", () => {
    const states = ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const;
    let state = createInitialSubagentRunsState();
    for (const [index, lifecycle] of states.entries()) {
      const value = snapshotForState(lifecycle, {
        run_id: `run-${lifecycle}`,
        subagent_id: `subagent-${lifecycle}`,
        parent_timeline_sequence: index,
        version: index + 1,
      });
      state = reduceSubagentRunEvent(state, {
        action: "subagent_run_updated",
        data: { ...value },
      });
    }
    const blocked = snapshotForState("running", {
      run_id: "run-blocked",
      subagent_id: "subagent-blocked",
      parent_timeline_sequence: states.length,
      blocked_on: "approval",
    });
    state = reduceSubagentRunEvent(state, {
      action: "subagent_run_updated",
      data: { ...blocked },
    });

    const projected = selectParentSubagentRuns(state, snapshotFixture.parent_session_id);
    expect(projected.map((run) => run.state)).toEqual([...states, "running"]);
    expect(projected.at(-1)?.blocked_on).toBe("approval");
    expect(Object.keys(state.unreadRunIds)).toHaveLength(7);
  });

  it("normalizes by parent and run while preserving multiple Explorer and Worker Runs", () => {
    const explorer = snapshot({
      run_id: "run-explorer",
      subagent_id: "subagent-explorer",
      role: "explorer",
      parent_timeline_sequence: 1,
    });
    const worker = snapshot({
      run_id: "run-worker",
      subagent_id: "subagent-worker",
      role: "worker",
      parent_timeline_sequence: 0,
    });
    let state = createInitialSubagentRunsState();
    state = mergeSubagentRunSnapshot(state, explorer);
    state = mergeSubagentRunSnapshot(state, worker);

    expect(Object.keys(state.runsById)).toHaveLength(2);
    expect(selectParentSubagentRuns(state, snapshotFixture.parent_session_id).map((run) => run.run_id)).toEqual([
      "run-worker",
      "run-explorer",
    ]);
    expect(selectSubagentRun(state, "run-explorer")).toEqual(explorer);
  });

  it("keeps resumed Runs under one stable Sub-Agent instance", () => {
    const first = snapshot({ run_id: "run-first", parent_timeline_sequence: 1 });
    const resumed = snapshot({
      run_id: "run-resumed",
      parent_timeline_sequence: 2,
      initiated_by: "user",
      parent_trace_id: null,
      parent_tool_call_id: null,
    });
    let state = createInitialSubagentRunsState();
    state = mergeSubagentRunSnapshot(state, first);
    state = mergeSubagentRunSnapshot(state, resumed);

    expect(selectSubagentHistory(state, snapshotFixture.subagent_id).map((run) => run.run_id)).toEqual([
      "run-first",
      "run-resumed",
    ]);
  });

  it("treats one parent's list snapshot as authoritative without touching another parent", () => {
    const firstParent = snapshot({ run_id: "run-old" });
    const secondParent = snapshot({
      run_id: "run-other",
      subagent_id: "subagent-other",
      parent_session_id: "parent-other",
    });
    const refreshed = snapshot({ run_id: "run-refreshed", parent_timeline_sequence: 3 });
    let state = createInitialSubagentRunsState();
    state = mergeSubagentRunSnapshot(state, firstParent);
    state = mergeSubagentRunSnapshot(state, secondParent);

    state = replaceParentSubagentRuns(state, snapshotFixture.parent_session_id, [refreshed]);

    expect(selectParentSubagentRuns(state, snapshotFixture.parent_session_id)).toEqual([
      refreshed,
    ]);
    expect(selectParentSubagentRuns(state, "parent-other")).toEqual([secondParent]);
    expect(selectSubagentRun(state, "run-old")).toBeNull();
    expect(selectSubagentHistory(state, firstParent.subagent_id)).toEqual([refreshed]);
  });

  it("removes rewound Runs, indexes and unread state from an empty parent snapshot", () => {
    const running = activeSnapshot({ run_id: "run-rewound" });
    const state = reduceSubagentRunEvent(createInitialSubagentRunsState(), {
      action: "subagent_run_updated",
      data: { ...running },
    });

    const reconciled = reduceSubagentRunEvent(state, {
      action: "subagent_runs_snapshot",
      data: { session_id: running.parent_session_id, list: [] },
    });

    expect(selectParentSubagentRuns(reconciled, running.parent_session_id)).toEqual([]);
    expect(selectSubagentRun(reconciled, running.run_id)).toBeNull();
    expect(selectSubagentHistory(reconciled, running.subagent_id)).toEqual([]);
    expect(reconciled.unreadRunIds[running.run_id]).toBeUndefined();
  });

  it("is idempotent, ignores stale versions and never rolls a terminal Run back", () => {
    const running = activeSnapshot({ state: "running", version: 2 });
    const completed = snapshot({ version: 3 });
    let state = mergeSubagentRunSnapshot(createInitialSubagentRunsState(), running);
    const duplicate = mergeSubagentRunSnapshot(state, running);
    expect(duplicate).toBe(state);

    state = mergeSubagentRunSnapshot(state, completed);
    expect(selectSubagentRun(state, completed.run_id)?.state).toBe("completed");
    const afterStale = mergeSubagentRunSnapshot(
      state,
      activeSnapshot({ state: "running", version: 2 }),
    );
    const afterTerminalRollback = mergeSubagentRunSnapshot(
      state,
      activeSnapshot({ state: "running", version: 4 }),
    );
    expect(afterStale).toBe(state);
    expect(afterTerminalRollback).toBe(state);
  });

  it("rejects conflicting equal versions and routes only new Runtime events", () => {
    const snapshotValue = snapshot({});
    const state = mergeSubagentRunSnapshot(createInitialSubagentRunsState(), snapshotValue);
    expect(() =>
      mergeSubagentRunSnapshot(state, { ...snapshotValue, final_report: "conflict" }),
    ).toThrow(/conflicting Sub-Agent snapshot/);

    const unchanged = reduceSubagentRunEvent(state, {
      action: "subagent_start",
      data: { session_id: snapshotValue.parent_session_id, run_id: "legacy" },
    });
    expect(unchanged).toBe(state);

    const newer = snapshot({ run_id: "run-new", parent_timeline_sequence: 7 });
    const merged = reduceSubagentRunEvent(state, {
      action: "subagent_runs_snapshot",
      data: { session_id: snapshotValue.parent_session_id, list: [snapshotValue, newer] },
    });
    expect(selectParentSubagentRuns(merged, snapshotValue.parent_session_id)).toHaveLength(2);
  });

  it("rejects cross-parent snapshot contamination and ignores child transcript events", () => {
    const value = snapshot({});
    const initial = mergeSubagentRunSnapshot(createInitialSubagentRunsState(), value);
    expect(() =>
      replaceParentSubagentRuns(initial, value.parent_session_id, [
        snapshot({ run_id: "foreign-run", parent_session_id: "foreign-parent" }),
      ]),
    ).toThrow(/another parent/);

    const childMessage = reduceSubagentRunEvent(initial, {
      action: "stream",
      data: {
        session_id: value.child_session_id,
        role: "assistant",
        content: "child-only transcript",
      },
    });
    expect(childMessage).toBe(initial);
    expect(selectParentSubagentRuns(childMessage, value.parent_session_id)).toEqual([value]);
  });

  it("tracks capsule unread state independently from ordinary Session unread state", () => {
    const running = activeSnapshot({ version: 2 });
    const state = reduceSubagentRunEvent(createInitialSubagentRunsState(), {
      action: "subagent_run_updated",
      data: { ...running },
    });
    expect(state.unreadRunIds[running.run_id]).toBe(true);

    const read = markSubagentRunRead(state, running.run_id);
    expect(read.unreadRunIds[running.run_id]).toBeUndefined();
    expect(markSubagentRunRead(read, running.run_id)).toBe(read);
  });
});


function snapshot(overrides: Record<string, unknown>) {
  return normalizeSubagentRunSnapshot({ ...snapshotFixture, ...overrides });
}


function activeSnapshot(overrides: Record<string, unknown>) {
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    state: "running",
    version: 2,
    final_report: null,
    error_code: null,
    error_message: null,
    started_at: snapshotFixture.started_at,
    finished_at: null,
    updated_at: snapshotFixture.started_at,
    ...overrides,
  });
}


function snapshotForState(
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted",
  overrides: Record<string, unknown>,
) {
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(state);
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    state,
    version: 1,
    started_at: state === "queued" ? null : snapshotFixture.started_at,
    finished_at: terminal ? snapshotFixture.finished_at : null,
    final_report: state === "completed" ? "done" : null,
    error_code: state === "failed" ? "FAILED" : null,
    error_message: state === "failed" ? "child failed" : null,
    blocked_on: null,
    ...overrides,
  });
}
