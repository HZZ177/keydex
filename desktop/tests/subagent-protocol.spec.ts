import { describe, expect, it } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import {
  SubagentProtocolError,
  normalizeDelegateSubagentResult,
  normalizeSubagentHandle,
  normalizeSubagentInstanceSummary,
  normalizeSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "@/types/protocol";


describe("Sub-Agent protocol DTO", () => {
  it("normalizes the Python-compatible full Run snapshot without dropping fields", () => {
    const normalized = normalizeSubagentRunSnapshot(snapshotFixture);

    expect(normalized).toEqual(snapshotFixture);
    expect(normalized satisfies SubagentRunSnapshot).toBe(normalized);
  });

  it.each([
    ["schema version", { ...snapshotFixture, schema_version: 2 }],
    ["role", { ...snapshotFixture, role: "general-purpose" }],
    ["state", { ...snapshotFixture, state: "paused" }],
    ["blocked_on", { ...snapshotFixture, state: "running", blocked_on: "model" }],
    ["initiator", { ...snapshotFixture, initiated_by: "system" }],
  ])("rejects unknown %s without a silent fallback", (_label, value) => {
    expect(() => normalizeSubagentRunSnapshot(value)).toThrow(SubagentProtocolError);
  });

  it("validates state-dependent report, error and timing invariants", () => {
    expect(() => normalizeSubagentRunSnapshot({ ...snapshotFixture, final_report: null })).toThrow(
      /completed Runs require only final_report/,
    );
    expect(() =>
      normalizeSubagentRunSnapshot({
        ...snapshotFixture,
        state: "failed",
        final_report: null,
        error_code: "SUBAGENT_RUN_FAILED",
        error_message: "failed",
        finished_at: null,
      }),
    ).toThrow(/terminal Runs require finished_at/);
  });

  it("normalizes Handle and instance identity contracts", () => {
    const queued = {
      ...snapshotFixture,
      state: "queued",
      version: 1,
      final_report: null,
      started_at: null,
      finished_at: null,
      updated_at: "2026-07-18T13:00:00Z",
    };
    expect(
      normalizeSubagentHandle({
        schema_version: 1,
        subagent_id: queued.subagent_id,
        run_id: queued.run_id,
        child_session_id: queued.child_session_id,
        parent_session_id: queued.parent_session_id,
        role: queued.role,
        initial_snapshot: queued,
      }).initial_snapshot.state,
    ).toBe("queued");
    expect(
      normalizeSubagentInstanceSummary({
        schema_version: 1,
        subagent_id: queued.subagent_id,
        child_session_id: queued.child_session_id,
        parent_session_id: queued.parent_session_id,
        role: queued.role,
        state: "running",
        active_run_id: queued.run_id,
        closed_at: null,
      }).active_run_id,
    ).toBe(queued.run_id);
  });

  it("normalizes completed and non-success tool terminal results as a strict union", () => {
    expect(
      normalizeDelegateSubagentResult({
        schema_version: 1,
        ok: true,
        state: "completed",
        subagent_id: "subagent-1",
        run_id: "run-1",
        child_session_id: "child-1",
        role: "explorer",
        final_report: "done",
        report_truncated: false,
      }),
    ).toMatchObject({ ok: true, state: "completed", final_report: "done" });
    expect(
      normalizeDelegateSubagentResult({
        schema_version: 1,
        ok: false,
        state: "interrupted",
        subagent_id: "subagent-1",
        run_id: "run-1",
        child_session_id: "child-1",
        role: "worker",
        error: { code: "SUBAGENT_INTERRUPTED", message: "interrupted", retryable: true },
      }),
    ).toMatchObject({ ok: false, state: "interrupted", error: { retryable: true } });
    expect(() =>
      normalizeDelegateSubagentResult({
        schema_version: 1,
        ok: true,
        state: "failed",
        subagent_id: "subagent-1",
        run_id: "run-1",
        child_session_id: "child-1",
        role: "worker",
      }),
    ).toThrow(SubagentProtocolError);
  });
});
