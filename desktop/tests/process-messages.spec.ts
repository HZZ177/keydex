import { describe, expect, it } from "vitest";

import { processMessages } from "@/renderer/pages/conversation/messages/processMessages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("processMessages", () => {
  it("groups consecutive tool activity while keeping normal message order", () => {
    const result = processMessages([
      message("u1", "user"),
      message("t1", "tool"),
      message("c1", "command"),
      message("a1", "assistant"),
      message("t2", "tool"),
    ]);

    expect(result.map((item) => item.type === "message" ? item.message.id : item.sourceMessageIds)).toEqual([
      "u1",
      ["t1", "c1"],
      "a1",
      "t2",
    ]);
    expect(result[1]).toMatchObject({
      type: "group",
      groupKind: "tool_activity",
      sourceMessageIds: ["t1", "c1"],
    });
  });

  it("groups consecutive file changes separately from tool activity", () => {
    const result = processMessages([
      message("f1", "file_change"),
      message("f2", "file_change"),
      message("t1", "tool"),
      message("f3", "file_change"),
    ]);

    expect(result.map((item) => item.type === "message" ? item.message.id : item.sourceMessageIds)).toEqual([
      ["f1", "f2"],
      "t1",
      "f3",
    ]);
    expect(result[0]).toMatchObject({
      type: "group",
      groupKind: "file_changes",
      sourceMessageIds: ["f1", "f2"],
    });
  });
});

function message(id: string, kind: ConversationMessage["kind"]): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    kind,
    status: "completed",
    content: id,
    payload: {},
    createdAt: `2026-06-17T10:00:0${id.slice(-1)}Z`,
    updatedAt: `2026-06-17T10:00:0${id.slice(-1)}Z`,
  };
}
