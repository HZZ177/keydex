import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../src/renderer/stores/conversationStore";
import {
  conversationPatchFromToolDetails,
  conversationStatusFromToolDetail,
  toolDetailCacheKey,
  toolDetailRefFromMessage,
} from "../src/renderer/pages/conversation/conversationToolDetails";

describe("conversation tool detail helpers", () => {
  it("extracts a usable deferred tool reference from message payload", () => {
    expect(toolDetailRefFromMessage(toolMessage({ payload: {} }))).toBeNull();
    expect(
      toolDetailRefFromMessage(
        toolMessage({
          payload: {
            toolDetailRef: {
              startEventId: "",
              endEventId: "",
              runId: "run-1",
              toolCallId: "call-1",
            },
          },
        }),
      ),
    ).toBeNull();

    expect(
      toolDetailRefFromMessage(
        toolMessage({
          payload: {
            toolDetailRef: {
              startEventId: "start-1",
              endEventId: "end-1",
              runId: "run-1",
              toolCallId: "call-1",
            },
          },
        }),
      ),
    ).toEqual({
      startEventId: "start-1",
      endEventId: "end-1",
      runId: "run-1",
      toolCallId: "call-1",
    });
  });

  it("builds cache keys from the session and complete detail ref", () => {
    expect(
      toolDetailCacheKey("session-a", {
        startEventId: "start-1",
        endEventId: "end-1",
        runId: "run-1",
        toolCallId: "call-1",
      }),
    ).toBe("session-a:start-1:end-1:run-1:call-1");

    expect(toolDetailCacheKey("session-b", { endEventId: "end-2" })).toBe("session-b::end-2::");
  });

  it("merges loaded details into a deferred message without dropping existing summary metadata", () => {
    const patch = conversationPatchFromToolDetails(
      toolMessage({
        status: "completed",
        payload: {
          call: { name: "search_text", arguments: { query: "old" } },
          result: { status: "success", model_content: "old result" },
          metadata: { previous: true },
          toolDetailRef: { startEventId: "start-1" },
          toolDetailsDeferred: true,
          toolSummary: { label: "search" },
        },
      }),
      {
        detailRef: { startEventId: "start-1", endEventId: "end-1" },
        toolName: "search_text",
        toolParams: { query: "needle" },
        toolResult: "loaded result",
        toolDurationMs: 123,
        status: "completed",
        uiPayload: { matches: 2 },
        fileChanges: [{ path: "docs/a.md", operation: "read" }],
        metadata: { loaded: true },
      },
    );

    expect(patch.status).toBe("completed");
    expect(patch.payload).toMatchObject({
      call: { name: "search_text", arguments: { query: "needle" } },
      result: {
        status: "success",
        model_content: "loaded result",
        duration_ms: 123,
        ui_payload: { matches: 2 },
        files: [{ path: "docs/a.md", operation: "read" }],
      },
      files: [{ path: "docs/a.md", operation: "read" }],
      duration_ms: 123,
      metadata: { loaded: true },
      toolDetailRef: { startEventId: "start-1", endEventId: "end-1" },
      toolDetailsDeferred: false,
      toolSummary: { label: "search" },
    });
  });

  it("maps tool detail statuses to conversation statuses", () => {
    expect(conversationStatusFromToolDetail({ status: "running" }, "completed")).toBe("running");
    expect(conversationStatusFromToolDetail({ status: "cancelled" }, "completed")).toBe("cancelled");
    expect(conversationStatusFromToolDetail({ status: "error" }, "completed")).toBe("failed");
    expect(conversationStatusFromToolDetail({ status: "failed" }, "completed")).toBe("failed");
    expect(conversationStatusFromToolDetail({ toolError: "boom" }, "completed")).toBe("failed");
    expect(conversationStatusFromToolDetail({ status: "success" }, "pending")).toBe("pending");
    expect(conversationStatusFromToolDetail({ status: "success" }, "completed")).toBe("completed");
  });

  it("maps cancelled tool details to a cancelled result payload", () => {
    const patch = conversationPatchFromToolDetails(
      toolMessage({
        kind: "command",
        status: "running",
      }),
      {
        status: "cancelled",
        uiPayload: { status: "cancelled", can_terminate: false, cancel_reason: "turn_cancelled" },
      },
    );

    expect(patch.status).toBe("cancelled");
    expect(patch.payload?.result).toMatchObject({
      status: "cancelled",
      ui_payload: {
        status: "cancelled",
        can_terminate: false,
        cancel_reason: "turn_cancelled",
      },
    });
  });

  it("preserves canonical tool and MCP error details in deferred history", () => {
    const error = {
      schema_version: 1 as const,
      code: "server_offline",
      message: "MCP 服务器当前不可用",
      details: { server_id: "srv-1", model_tool_name: "mcp__srv_1__search" },
      retryable: true,
    };
    const patch = conversationPatchFromToolDetails(
      toolMessage({ status: "completed" }),
      { status: "failed", toolError: "MCP 服务器当前不可用", error },
    );

    expect(patch.status).toBe("failed");
    expect((patch.payload?.result as Record<string, unknown>).error).toEqual(error);
  });
});

function toolMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  const base: ConversationMessage = {
    id: "message-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "tool",
    status: "completed",
    content: "",
    payload: {},
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    payload: overrides.payload ?? base.payload,
  };
}
