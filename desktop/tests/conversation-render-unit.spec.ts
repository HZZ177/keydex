import { describe, expect, it } from "vitest";

import { processMessages } from "@/renderer/pages/conversation/messages/processMessages";
import { messageFromRun } from "@/renderer/pages/conversation/subagents/subagentTimeline";
import {
  projectConversationRenderUnits,
  type ConversationRenderUnitKind,
} from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { normalizeSubagentRunSnapshot } from "@/types/subagents";
import subagentRunFixture from "./fixtures/subagent-run-snapshot.json";

describe("Conversation RenderUnit projection", () => {
  it("keeps unit identity stable across normal status/content updates while changing renderVersion", () => {
    const initialMessages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Partial", "running"),
    ];
    const initial = projectConversationRenderUnits(processMessages(initialMessages));
    const updated = projectConversationRenderUnits(processMessages([
      initialMessages[0],
      { ...initialMessages[1], content: "Completed answer", status: "completed" },
    ]));
    const initialAssistant = unit(initial, "assistant-markdown");
    const updatedAssistant = unit(updated, "assistant-markdown");
    const initialFooter = unit(initial, "footer");
    const updatedFooter = unit(updated, "footer");

    expect(updatedAssistant.id).toBe(initialAssistant.id);
    expect(updatedAssistant.renderVersion).not.toBe(initialAssistant.renderVersion);
    expect(updatedAssistant).toMatchObject({ dynamic: false, pinPolicy: "never", measurementPolicy: "estimate-once" });
    expect(initialAssistant).toMatchObject({ dynamic: true, pinPolicy: "while-active", measurementPolicy: "observe-until-settled" });
    expect(updatedFooter.id).toBe(initialFooter.id);
    expect(updatedFooter.parentUnitId).toBe(updatedAssistant.id);
    expect(updatedFooter).toMatchObject({ interactive: false, pinPolicy: "never" });
  });

  it("projects Markdown ownership separately from React tool and interactive ownership", () => {
    const projection = projectConversationRenderUnits(processMessages([
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
      message("thinking-1", "thinking", "Reasoning", "running"),
      tool("tool-1"),
      tool("tool-2"),
      fileChange("file-1"),
      fileChange("file-2"),
      message("a2ui-1", "a2ui", "", "pending", { a2ui: { render_key: "choice" } }),
      message("approval-1", "approval", "Approve", "pending"),
      message("mcp-1", "mcp_elicitation", "Input", "pending"),
    ]));
    const byKind = new Map(projection.units.map((entry) => [entry.kind, entry]));

    expect(byKind.get("user-markdown")?.owner).toBe("markdown-runtime");
    expect(byKind.get("assistant-markdown")?.owner).toBe("markdown-runtime");
    expect(byKind.get("reasoning")).toMatchObject({ owner: "react", dynamic: true });
    expect(byKind.get("tool-group")).toMatchObject({ owner: "react", sourceMessageIds: ["tool-1", "tool-2"] });
    expect(byKind.get("file-change-group")).toMatchObject({ sourceMessageIds: ["file-1", "file-2"] });
    expect(byKind.get("a2ui")).toMatchObject({
      dynamic: false,
      interactive: false,
      pinPolicy: "never",
      measurementPolicy: "estimate-once",
    });
    for (const kind of ["approval", "mcp-elicitation"] as const) {
      expect(byKind.get(kind)).toMatchObject({
        interactive: true,
        pinPolicy: "while-interacting",
        measurementPolicy: "observe-always",
      });
    }
  });

  it("pins only a genuinely live A2UI stream, not a settled waiting-input card", () => {
    const projection = projectConversationRenderUnits(processMessages([
      message("a2ui-live", "a2ui", "", "running", { a2uiDebug: { status: "streaming" } }),
    ]));

    expect(unit(projection, "a2ui")).toMatchObject({
      dynamic: true,
      interactive: false,
      pinPolicy: "while-active",
      measurementPolicy: "observe-until-settled",
    });
  });

  it("changes the A2UI render version when only hydrated interaction state changes", () => {
    const initialMessage = message("a2ui-history", "a2ui", "", "completed", {
      historyHydrated: true,
      a2ui: {
        render_key: "choice",
        stream_id: "stream-history",
        interaction: {
          interaction_id: "interaction-history",
          status: "submitted",
          can_submit: false,
          submit_result: { selected_values: ["primary"] },
        },
      },
    });
    const updatedMessage = {
      ...initialMessage,
      payload: {
        ...initialMessage.payload,
        a2ui: {
          ...(initialMessage.payload.a2ui as Record<string, unknown>),
          interaction: {
            interaction_id: "interaction-history",
            status: "cancelled",
            can_submit: false,
          },
        },
      },
    };
    const initial = unit(projectConversationRenderUnits(processMessages([initialMessage])), "a2ui");
    const updated = unit(projectConversationRenderUnits(processMessages([updatedMessage])), "a2ui");

    expect(updated.id).toBe(initial.id);
    expect(updated.renderVersion).not.toBe(initial.renderVersion);
  });

  it("changes a running tool render version when streamed file details advance", () => {
    const initialMessage = message("tool-stream", "tool", "apply_patch", "running", {
      call: {
        id: "call-stream",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Update File: docs/guide" },
      },
      files: [{ path: "docs/guide", operation: "update", added_lines: 0, deleted_lines: 0 }],
      result: {
        status: "running",
        files: [{ path: "docs/guide", operation: "update", added_lines: 0, deleted_lines: 0 }],
      },
    });
    const namedMessage = message("tool-stream", "tool", "apply_patch", "running", {
      call: {
        id: "call-stream",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Update File: docs/guide.md\n" },
      },
      files: [{ path: "docs/guide.md", operation: "update", added_lines: 0, deleted_lines: 0 }],
      result: {
        status: "running",
        files: [{ path: "docs/guide.md", operation: "update", added_lines: 0, deleted_lines: 0 }],
      },
    });
    const countedMessage = message("tool-stream", "tool", "apply_patch", "running", {
      call: {
        id: "call-stream",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Update File: docs/guide.md\n@@\n-old\n+new" },
      },
      files: [{ path: "docs/guide.md", operation: "update", added_lines: 1, deleted_lines: 1 }],
      result: {
        status: "running",
        files: [{ path: "docs/guide.md", operation: "update", added_lines: 1, deleted_lines: 1 }],
      },
    });
    const initial = unit(projectConversationRenderUnits(processMessages([initialMessage])), "tool");
    const named = unit(projectConversationRenderUnits(processMessages([namedMessage])), "tool");
    const counted = unit(projectConversationRenderUnits(processMessages([countedMessage])), "tool");

    expect(named.id).toBe(initial.id);
    expect(counted.id).toBe(initial.id);
    expect(named.renderVersion).not.toBe(initial.renderVersion);
    expect(counted.renderVersion).not.toBe(named.renderVersion);
  });

  it("changes a running command render version when termination and output progress arrive", () => {
    const initialMessage = message("command-stream", "command", "", "running", {
      call: {
        id: "call-command",
        name: "run_git_bash",
        arguments: { command: "sleep 50", cwd: "." },
      },
      result: {
        status: "running",
        ui_payload: {
          kind: "command_progress",
          command: "sleep 50",
          status: "running",
        },
      },
    });
    const terminableMessage = message("command-stream", "command", "", "running", {
      ...initialMessage.payload,
      result: {
        status: "running",
        ui_payload: {
          kind: "command_progress",
          command_id: "cmd-1",
          command: "sleep 50",
          status: "running",
          can_terminate: true,
          output_bytes: 0,
        },
      },
    });
    const outputMessage = message("command-stream", "command", "", "running", {
      ...terminableMessage.payload,
      result: {
        status: "running",
        ui_payload: {
          ...((terminableMessage.payload.result as Record<string, unknown>).ui_payload as Record<string, unknown>),
          output_bytes: 5,
          combined_tail: "ready",
        },
      },
    });
    const initial = unit(projectConversationRenderUnits(processMessages([initialMessage])), "tool");
    const terminable = unit(projectConversationRenderUnits(processMessages([terminableMessage])), "tool");
    const output = unit(projectConversationRenderUnits(processMessages([outputMessage])), "tool");

    expect(terminable.id).toBe(initial.id);
    expect(output.id).toBe(initial.id);
    expect(terminable.renderVersion).not.toBe(initial.renderVersion);
    expect(output.renderVersion).not.toBe(terminable.renderVersion);
  });

  it("invalidates only the changed parallel Sub-Agent capsule across queued, running and blocked updates", () => {
    const queuedA = subagentRun({
      run_id: "run-a",
      subagent_id: "subagent-a",
      parent_timeline_sequence: 1,
      state: "queued",
      version: 1,
      started_at: null,
      updated_at: subagentRunFixture.queued_at,
    });
    const queuedB = subagentRun({
      run_id: "run-b",
      subagent_id: "subagent-b",
      parent_timeline_sequence: 2,
      state: "queued",
      version: 1,
      started_at: null,
      updated_at: subagentRunFixture.queued_at,
    });
    const runningA = subagentRun({
      ...queuedA,
      state: "running",
      version: 2,
      started_at: subagentRunFixture.started_at,
      updated_at: subagentRunFixture.started_at,
    });
    const blockedA = subagentRun({
      ...runningA,
      version: 3,
      blocked_on: "approval",
      updated_at: "2026-07-18T13:00:01.500Z",
    });

    const queuedProjection = projectConversationRenderUnits(processMessages([
      messageFromRun(queuedA, "turn-1"),
      messageFromRun(queuedB, "turn-1"),
    ]));
    const runningProjection = projectConversationRenderUnits(processMessages([
      messageFromRun(runningA, "turn-1"),
      messageFromRun(queuedB, "turn-1"),
    ]));
    const blockedProjection = projectConversationRenderUnits(processMessages([
      messageFromRun(blockedA, "turn-1"),
      messageFromRun(queuedB, "turn-1"),
    ]));
    const queuedUnits = unitsBySourceMessage(queuedProjection);
    const runningUnits = unitsBySourceMessage(runningProjection);
    const blockedUnits = unitsBySourceMessage(blockedProjection);
    const runAMessageId = "subagent-run:run-a";
    const runBMessageId = "subagent-run:run-b";

    expect(runningUnits.get(runAMessageId)?.id).toBe(queuedUnits.get(runAMessageId)?.id);
    expect(runningUnits.get(runAMessageId)?.renderVersion).not.toBe(
      queuedUnits.get(runAMessageId)?.renderVersion,
    );
    expect(blockedUnits.get(runAMessageId)?.renderVersion).not.toBe(
      runningUnits.get(runAMessageId)?.renderVersion,
    );
    expect(runningUnits.get(runBMessageId)?.renderVersion).toBe(
      queuedUnits.get(runBMessageId)?.renderVersion,
    );
    expect(runningUnits.get(runAMessageId)).toMatchObject({
      dynamic: true,
      pinPolicy: "while-active",
      measurementPolicy: "observe-until-settled",
    });
  });

  it("covers error, skill, task, status, command, and file-change families", () => {
    const cases: Array<[ConversationMessage["kind"], ConversationRenderUnitKind]> = [
      ["error", "error"],
      ["cancelled", "error"],
      ["llm_retry", "error"],
      ["skill", "skill"],
      ["thread_task_status", "task-status"],
      ["status", "status"],
      ["command", "tool"],
      ["file_change", "file-change"],
    ];
    for (const [messageKind, unitKind] of cases) {
      const projection = projectConversationRenderUnits(processMessages([
        message(`kind-${messageKind}`, messageKind, messageKind, "completed"),
      ]));
      expect(projection.units.some((entry) => entry.kind === unitKind)).toBe(true);
    }
  });

  it("keeps context compression as an independent event segment between turns", () => {
    const projection = projectConversationRenderUnits(processMessages([
      message("user-1", "user", "One"),
      message("assistant-1", "assistant", "Answer one"),
      message("compression-1", "context_compression", "Compressed"),
      message("user-2", "user", "Two"),
      message("assistant-2", "assistant", "Answer two"),
    ]));

    expect(projection.segments.map((segment) => segment.type)).toEqual(["turn", "event", "turn"]);
    expect(projection.turns).toHaveLength(2);
    expect(projection.units.filter((entry) => entry.kind === "event")).toHaveLength(1);
    expect(projection.units.find((entry) => entry.kind === "event")?.turnId).toBeNull();
  });

  it("preserves goal-continuation marker ownership and business turn index", () => {
    const marker = message("marker-7", "turn_marker", "", "completed", {
      turnIndex: 7,
      metadata: {
        source: "thread_task",
        thread_task: { trigger: "task_continue", type: "goal" },
      },
    });
    const projection = projectConversationRenderUnits(processMessages([
      marker,
      message("assistant-7", "assistant", "Continue", "completed", { turnIndex: 7 }),
    ]));
    const shell = unit(projection, "turn-shell");

    expect(projection.turns[0]).toMatchObject({
      id: "turn:marker-7",
      turnMarker: marker,
      showThreadTaskContinuationNotice: true,
    });
    expect(shell).toMatchObject({ businessTurnIndex: 7, sourceMessageIds: ["marker-7"], estimatedHeight: 36 });
  });

  it("keeps identities stable through reorder/remove and emits one footer for the last assistant", () => {
    const first = message("assistant-1", "assistant", "One");
    const second = message("assistant-2", "assistant", "Two");
    const original = projectConversationRenderUnits(processMessages([message("user-1", "user", "Question"), first, second]));
    const reordered = projectConversationRenderUnits(processMessages([message("user-1", "user", "Question"), second, first]));
    const originalIds = new Map(original.units.map((entry) => [entry.sourceMessageIds.join(",") + entry.kind, entry.id]));

    for (const entry of reordered.units.filter((candidate) => candidate.kind !== "footer" && candidate.kind !== "turn-shell")) {
      expect(entry.id).toBe(originalIds.get(entry.sourceMessageIds.join(",") + entry.kind));
    }
    expect(original.units.filter((entry) => entry.kind === "footer")).toHaveLength(1);
    expect(unit(original, "footer").sourceMessageIds).toEqual(["assistant-2"]);
    expect(unit(reordered, "footer").sourceMessageIds).toEqual(["assistant-1"]);
    expect(unit(reordered, "footer").id).toBe(unit(original, "footer").id);
  });

  it("freezes projection collections and provides every turn a unit index", () => {
    const projection = projectConversationRenderUnits(processMessages([
      message("user-1", "user", "One"),
      message("assistant-1", "assistant", "Answer"),
    ]));
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.units)).toBe(true);
    expect(Object.isFrozen(projection.turns)).toBe(true);
    expect(projection.unitIdsByTurn.get(projection.turns[0].id)).toEqual(
      projection.units.filter((entry) => entry.turnId === projection.turns[0].id).map((entry) => entry.id),
    );
  });
});

function unit(
  projection: ReturnType<typeof projectConversationRenderUnits>,
  kind: ConversationRenderUnitKind,
) {
  const value = projection.units.find((entry) => entry.kind === kind);
  expect(value, `missing ${kind}`).toBeDefined();
  return value!;
}

function unitsBySourceMessage(
  projection: ReturnType<typeof projectConversationRenderUnits>,
) {
  return new Map(
    projection.units
      .filter((entry) => entry.kind === "status" && entry.sourceMessageIds.length === 1)
      .map((entry) => [entry.sourceMessageIds[0], entry]),
  );
}

function subagentRun(overrides: Record<string, unknown>) {
  const state = String(overrides.state ?? subagentRunFixture.state);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(state);
  return normalizeSubagentRunSnapshot({
    ...subagentRunFixture,
    final_report: state === "completed" ? subagentRunFixture.final_report : null,
    error_code: state === "failed" ? "FAILED" : null,
    error_message: state === "failed" ? "failed" : null,
    finished_at: terminal ? subagentRunFixture.finished_at : null,
    blocked_on: null,
    ...overrides,
  });
}

function message(
  id: string,
  kind: ConversationMessage["kind"],
  content: string,
  status: ConversationMessage["status"] = "completed",
  payload: Record<string, unknown> = {},
): ConversationMessage {
  return {
    id,
    threadId: "session-1",
    turnId: "turn-1",
    itemId: id,
    kind,
    status,
    content,
    payload,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function tool(id: string): ConversationMessage {
  return message(id, "tool", "read_file", "completed", {
    call: { id: `call-${id}`, name: "read_file", arguments: { path: "README.md" } },
    result: { status: "success", model_content: "ok" },
  });
}

function fileChange(id: string): ConversationMessage {
  return message(id, "file_change", "src/main.ts", "completed", {
    path: "src/main.ts",
    operation: "update",
    diff: "@@\n+ok",
    additions: 1,
    deletions: 0,
  });
}
