import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingMcpPromptDrafts,
  emitInsertMcpPromptDraft,
  subscribeInsertMcpPromptDraft,
} from "@/renderer/events/mcpPromptDraft";

describe("mcp prompt draft events", () => {
  afterEach(() => {
    clearPendingMcpPromptDrafts();
  });

  it("queues unconsumed prompt drafts and flushes them to the next matching subscriber", () => {
    const consumedImmediately = emitInsertMcpPromptDraft({
      text: "  user:\nSummarize MCP  ",
      serverId: "srv_1",
      promptId: "prompt_summary",
      rawName: "summarize_fixture",
    });
    const listener = vi.fn(() => true);

    expect(consumedImmediately).toBe(false);
    const unsubscribe = subscribeInsertMcpPromptDraft(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      text: "user:\nSummarize MCP",
      serverId: "srv_1",
      promptId: "prompt_summary",
      rawName: "summarize_fixture",
      sessionId: null,
    });

    unsubscribe();
    subscribeInsertMcpPromptDraft(listener)();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not queue prompt drafts that are consumed by an active subscriber", () => {
    const listener = vi.fn(() => true);
    const unsubscribe = subscribeInsertMcpPromptDraft(listener);

    expect(
      emitInsertMcpPromptDraft({
        text: "user:\nAlready visible",
        serverId: "srv_1",
        promptId: "prompt_summary",
        rawName: "summarize_fixture",
      }),
    ).toBe(true);

    unsubscribe();
    subscribeInsertMcpPromptDraft(listener)();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
