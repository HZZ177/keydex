import { afterEach, describe, expect, it } from "vitest";

import { conversationBaselineDiagnostics } from "@/renderer/pages/conversation/messages/conversationBaselineDiagnostics";

describe("conversation baseline diagnostics", () => {
  afterEach(() => {
    conversationBaselineDiagnostics.enable(false);
    conversationBaselineDiagnostics.reset();
  });

  it("is inert until a benchmark explicitly enables it", () => {
    expect(conversationBaselineDiagnostics.isEnabled()).toBe(false);
    conversationBaselineDiagnostics.record({
      stage: "message-list-render",
      itemCount: 10_000,
    });

    expect(conversationBaselineDiagnostics.snapshot()).toEqual({
      enabled: false,
      events: [],
    });
  });

  it("records immutable timestamped events while enabled", () => {
    conversationBaselineDiagnostics.enable();
    expect(conversationBaselineDiagnostics.isEnabled()).toBe(true);
    conversationBaselineDiagnostics.record({
      stage: "markdown-model",
      messageId: "assistant-1",
      characters: 1_048_576,
      blockCount: 512,
      durationMs: 12.5,
    });

    const snapshot = conversationBaselineDiagnostics.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      stage: "markdown-model",
      messageId: "assistant-1",
      characters: 1_048_576,
      blockCount: 512,
      durationMs: 12.5,
    });
    expect(snapshot.events[0]?.atMs).toEqual(expect.any(Number));
    expect(Object.isFrozen(snapshot.events[0])).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
  });
});
