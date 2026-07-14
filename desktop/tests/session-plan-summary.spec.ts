import { describe, expect, it } from "vitest";

import {
  activePlanEntryIndex,
  buildSessionPlanSummary,
  type SessionPlanEntry,
} from "@/renderer/pages/conversation/sessionPlanSummary";
import type { ConversationMessage, ConversationMessageKind } from "@/renderer/stores/conversationStore";

describe("session plan summary", () => {
  it("selects the latest non-pending step instead of prioritizing an earlier failure", () => {
    expect(activePlanEntryIndex(entries(["completed", "failed", "completed"]))).toBe(2);
  });

  it("keeps the running step selected when it is the latest non-pending step", () => {
    expect(activePlanEntryIndex(entries(["completed", "failed", "in_progress", "pending"]))).toBe(2);
  });

  it("falls back to the first pending step before work starts", () => {
    expect(activePlanEntryIndex(entries(["pending", "pending", "pending"]))).toBe(0);
  });

  it("returns -1 for an empty plan", () => {
    expect(activePlanEntryIndex([])).toBe(-1);
  });

  it("keeps the current plan across later user messages in the same session", () => {
    const summary = buildSessionPlanSummary([
      planMessage({
        entries: [
          { content: "分析需求", status: "completed" },
          { content: "继续实现", status: "in_progress" },
        ],
      }),
      message("user", { text: "继续" }),
    ]);

    expect(summary?.entries[1]?.content).toBe("继续实现");
    expect(summary?.activeIndex).toBe(1);
  });

  it("removes omitted steps when a newer complete snapshot replaces the plan", () => {
    const summary = buildSessionPlanSummary([
      planMessage({
        entries: [
          { content: "保留分析", status: "completed" },
          { content: "移除旧实现", status: "pending" },
          { content: "继续验证", status: "in_progress" },
        ],
      }),
      planMessage({
        entries: [
          { content: "保留分析", status: "completed" },
          { content: "继续验证", status: "in_progress" },
        ],
      }),
    ]);

    expect(summary?.entries.map((entry) => entry.content)).toEqual(["保留分析", "继续验证"]);
    expect(summary?.activeIndex).toBe(1);
  });

  it("does not revive an older plan when the latest snapshot is empty", () => {
    const summary = buildSessionPlanSummary([
      planMessage({
        entries: [{ content: "旧计划", status: "completed" }],
      }),
      message("user", { text: "开始新任务" }),
      planMessage({
        entries: [],
      }),
    ]);

    expect(summary).toBeNull();
  });

  it("recognizes a streaming empty plan from tool call arguments", () => {
    const summary = buildSessionPlanSummary([
      planMessage({
        entries: [{ content: "旧计划", status: "completed" }],
      }),
      message("plan", {
        call: {
          arguments: JSON.stringify({
            plan: [],
          }),
        },
      }),
    ]);

    expect(summary).toBeNull();
  });

  it("allows a newer plan to replace an empty snapshot", () => {
    const summary = buildSessionPlanSummary([
      planMessage({
        entries: [{ content: "旧计划", status: "completed" }],
      }),
      planMessage({
        entries: [],
      }),
      planMessage({
        entries: [{ content: "新计划", status: "in_progress" }],
      }),
    ]);

    expect(summary?.entries[0]?.content).toBe("新计划");
  });

  it("ignores a failed empty snapshot and retains the previous plan", () => {
    const failedEmptySnapshot = planMessage(
      { entries: [] },
      "failed",
    );
    const summary = buildSessionPlanSummary([
      planMessage({
        entries: [{ content: "保留计划", status: "in_progress" }],
      }),
      failedEmptySnapshot,
    ]);

    expect(summary?.entries[0]?.content).toBe("保留计划");
  });
});

function entries(statuses: SessionPlanEntry["status"][]): SessionPlanEntry[] {
  return statuses.map((status, index) => ({
    content: `Step ${index + 1}`,
    status,
  }));
}

function planMessage(
  payload: Record<string, unknown>,
  status: ConversationMessage["status"] = "completed",
): ConversationMessage {
  return message("plan", { uiPayload: payload }, status);
}

function message(
  kind: ConversationMessageKind,
  payload: Record<string, unknown>,
  status: ConversationMessage["status"] = "completed",
): ConversationMessage {
  return {
    id: `${kind}-message`,
    threadId: "ses-plan",
    turnId: null,
    itemId: null,
    kind,
    status,
    content: "",
    payload,
    createdAt: "2026-07-14T00:00:00Z",
    updatedAt: "2026-07-14T00:00:00Z",
  };
}
