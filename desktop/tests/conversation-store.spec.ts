import { describe, expect, it } from "vitest";

import type { RuntimeEvent, Thread, ThreadDetail, ThreadItem, Turn } from "@/types/protocol";
import {
  conversationReducer,
  createInitialConversationState,
  hasProcessedEvent,
  selectActiveTurn,
  selectItemsForThread,
  selectLastSeq,
  selectMessagesForThread,
  selectRuntimeState,
  selectSelectedThread,
  selectThreads,
  selectTurnsForThread,
  type ConversationMessage,
} from "@/renderer/stores/conversationStore";

describe("conversationStore reducer", () => {
  it("normalizes thread lists and selects the newest thread by default", () => {
    const state = conversationReducer(createInitialConversationState(), {
      type: "threads/set",
      threads: [thread("thr-old", "2026-06-17T10:00:00Z"), thread("thr-new", "2026-06-17T11:00:00Z")],
    });

    expect(state.threadIds).toEqual(["thr-new", "thr-old"]);
    expect(selectThreads(state).map((item) => item.id)).toEqual(["thr-new", "thr-old"]);
    expect(selectSelectedThread(state)?.id).toBe("thr-new");
  });

  it("loads thread detail into normalized turns and items with active turn tracking", () => {
    const detail: ThreadDetail = {
      thread: thread("thr-1", "2026-06-17T10:00:00Z", "running"),
      turns: [
        turn("turn-done", "thr-1", "completed", "2026-06-17T10:01:00Z"),
        turn("turn-active", "thr-1", "in_progress", "2026-06-17T10:02:00Z"),
      ],
      items: [
        item("item-2", "thr-1", "turn-active", "assistant_message", 2),
        item("item-1", "thr-1", "turn-active", "user_message", 1),
      ],
    };

    const state = conversationReducer(createInitialConversationState(), {
      type: "thread/detailLoaded",
      detail,
    });

    expect(state.selectedThreadId).toBe("thr-1");
    expect(selectTurnsForThread(state, "thr-1").map((entry) => entry.id)).toEqual(["turn-done", "turn-active"]);
    expect(selectItemsForThread(state, "thr-1").map((entry) => entry.id)).toEqual(["item-1", "item-2"]);
    expect(selectMessagesForThread(state, "thr-1").map((entry) => entry.id)).toEqual(["item:item-1", "item:item-2"]);
    expect(selectActiveTurn(state, "thr-1")?.id).toBe("turn-active");
    expect(selectRuntimeState(state, "thr-1")).toBe("running");
  });

  it("stores messages separately from raw thread items", () => {
    const message: ConversationMessage = {
      id: "msg-1",
      threadId: "thr-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "assistant",
      itemType: "assistant_message",
      status: "running",
      content: "你好",
      payload: { text: "你好" },
      createdAt: "2026-06-17T10:00:00Z",
      updatedAt: "2026-06-17T10:00:00Z",
    };
    const state = conversationReducer(createInitialConversationState(), {
      type: "message/upsert",
      message,
    });

    expect(state.messagesById["msg-1"]).toEqual(message);
    expect(selectMessagesForThread(state, "thr-1")).toEqual([message]);
  });

  it("records event ids and last seq monotonically", () => {
    let state = createInitialConversationState();
    state = conversationReducer(state, { type: "event/record", event: event("evt-1", 2) });
    const unchanged = conversationReducer(state, { type: "event/record", event: event("evt-old", 1) });

    expect(selectLastSeq(state, "thr-1")).toBe(2);
    expect(hasProcessedEvent(state, event("evt-1", 2))).toBe(true);
    expect(unchanged).toBe(state);
  });
});

function thread(id: string, updatedAt: string, status: Thread["status"] = "idle"): Thread {
  return {
    id,
    title: id,
    preview: "",
    cwd: "D:/repo",
    workspace_roots: ["D:/repo"],
    model: "qwen-coder",
    permission_mode: "workspace_write",
    status,
    created_at: "2026-06-17T09:00:00Z",
    updated_at: updatedAt,
    archived: false,
  };
}

function turn(id: string, threadId: string, status: Turn["status"], startedAt: string): Turn {
  return {
    id,
    thread_id: threadId,
    status,
    started_at: startedAt,
    completed_at: status === "completed" ? "2026-06-17T10:03:00Z" : null,
    duration_ms: null,
    error: null,
  };
}

function item(
  id: string,
  threadId: string,
  turnId: string,
  type: ThreadItem["type"],
  seq: number,
): ThreadItem {
  return {
    id,
    thread_id: threadId,
    turn_id: turnId,
    type,
    status: "running",
    payload: {},
    created_at: `2026-06-17T10:00:0${seq}Z`,
    updated_at: `2026-06-17T10:00:0${seq}Z`,
    seq_start: seq,
    seq_end: null,
  };
}

function event(eventId: string, seq: number): RuntimeEvent {
  return {
    event_id: eventId,
    thread_id: "thr-1",
    turn_id: null,
    item_id: null,
    seq,
    type: "thread.updated",
    created_at: "2026-06-17T10:00:00Z",
    payload: {},
  };
}
