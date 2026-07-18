import { describe, expect, it } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import {
  mergeSubagentRunsIntoConversation,
  messageFromRun,
} from "@/renderer/pages/conversation/subagents/subagentTimeline";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { normalizeSubagentRunSnapshot } from "@/types/subagents";

describe("Sub-Agent parent timeline", () => {
  it("anchors parallel Runs after their tool call and preserves Run sequence after out-of-order completion", () => {
    const tool = message("tool", "subagent_invocation", {
      toolCallId: "call-1",
      call: { id: "call-1", name: "delegate_subagent" },
    });
    const assistant = message("assistant", "assistant", {});
    const later = snapshot({ run_id: "run-later", parent_timeline_sequence: 2, version: 8, parent_tool_call_id: "call-1" });
    const earlier = snapshot({ run_id: "run-earlier", parent_timeline_sequence: 1, version: 3, parent_tool_call_id: "call-1" });

    const merged = mergeSubagentRunsIntoConversation([tool, assistant], [later, earlier]);

    expect(merged.map((item) => item.id)).toEqual([
      "subagent-run:run-earlier",
      "subagent-run:run-later",
      "assistant",
    ]);
  });

  it("keeps a semantic invocation capsule while the first Run event is still in flight", () => {
    const invocation = message("tool", "subagent_invocation", {
      toolCallId: "call-pending",
      call: {
        id: "call-pending",
        name: "delegate_subagent",
        arguments: { type: "worker", task: "implement the bounded change" },
      },
    });

    expect(mergeSubagentRunsIntoConversation([invocation], [])).toEqual([invocation]);
  });

  it("replaces a continued invocation with the new Run anchored to its current tool call", () => {
    const invocation = message("continue", "subagent_invocation", {
      toolCallId: "call-continue",
      call: {
        id: "call-continue",
        name: "continue_subagent",
        arguments: { subagent_id: "subagent-fixture-1", task: "follow up" },
      },
    });
    const continued = snapshot({
      run_id: "run-continued",
      subagent_id: "subagent-fixture-1",
      parent_timeline_sequence: 3,
      parent_tool_call_id: "call-continue",
      initiated_by: "main_agent",
    });

    const merged = mergeSubagentRunsIntoConversation([invocation], [continued]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "subagent-run:run-continued",
      kind: "subagent_run",
      itemId: "call-continue",
    });
  });

  it("keeps ordinary ToolBlocks when a message is not a Sub-Agent invocation", () => {
    const ordinaryTool = message("tool", "tool", {
      toolCallId: "call-read",
      call: { id: "call-read", name: "read_file" },
    });

    expect(mergeSubagentRunsIntoConversation([ordinaryTool], [])).toEqual([ordinaryTool]);
  });

  it("appends user-resumed Runs as independent items and never merges two Runs of one instance", () => {
    const first = snapshot({ run_id: "run-first", parent_timeline_sequence: 4 });
    const resumed = snapshot({
      run_id: "run-resumed",
      parent_timeline_sequence: 5,
      initiated_by: "user",
      parent_tool_call_id: null,
      parent_trace_id: null,
    });

    const merged = mergeSubagentRunsIntoConversation([message("answer", "assistant", {})], [resumed, first]);

    expect(merged.map((item) => item.id)).toEqual([
      "answer",
      "subagent-run:run-first",
      "subagent-run:run-resumed",
    ]);
  });

  it("maps queued and running Runs to distinct live message states", () => {
    const queued = snapshot({
      state: "queued",
      version: 1,
      started_at: null,
      finished_at: null,
      final_report: null,
      updated_at: snapshotFixture.queued_at,
    });
    const running = snapshot({
      state: "running",
      version: 2,
      finished_at: null,
      final_report: null,
      updated_at: snapshotFixture.started_at,
    });

    expect(messageFromRun(queued, "turn-1").status).toBe("pending");
    expect(messageFromRun(running, "turn-1").status).toBe("running");
  });
});

function snapshot(overrides: Record<string, unknown>) {
  return normalizeSubagentRunSnapshot({ ...snapshotFixture, ...overrides });
}

function message(id: string, kind: ConversationMessage["kind"], payload: Record<string, unknown>): ConversationMessage {
  return {
    id,
    threadId: snapshotFixture.parent_session_id,
    turnId: "turn-1",
    itemId: null,
    kind,
    content: id,
    payload,
    createdAt: snapshotFixture.created_at,
    updatedAt: snapshotFixture.created_at,
  };
}
