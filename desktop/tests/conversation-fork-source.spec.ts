import { describe, expect, it, vi } from "vitest";

import {
  createBtwConversationFromSession,
  createBtwConversationHistorySnapshot,
  filterBtwConversationVisibleMessages,
  selectBtwConversationVisibleMessages,
} from "@/renderer/pages/conversation/conversationForkSource";
import type { RuntimeBridge } from "@/runtime";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentSession } from "@/types/protocol";

describe("bypass conversation history snapshot", () => {
  it("creates a checkpoint-only bypass conversation without loading source history", async () => {
    const forkedSession = agentSession({ id: "btw-1", session_tag: "btw" });
    const loadHistory = vi.fn();
    const forkSession = vi.fn().mockResolvedValue({
      session: forkedSession,
      source: { source_type: "latest_checkpoint", turn_index: null },
    });
    const runtime = {
      conversation: {
        loadHistory,
        forkSession,
      },
    } as unknown as RuntimeBridge;

    await expect(createBtwConversationFromSession(runtime, "source-1")).resolves.toMatchObject({
      session: forkedSession,
      loadedHistoryTurnCount: 0,
    });
    expect(loadHistory).not.toHaveBeenCalled();
    expect(forkSession).toHaveBeenCalledWith("source-1", {
      sessionTag: "btw",
      title: "旁路对话",
    });
  });

  it("keeps the loaded turn count fixed and hides reloaded historical messages", () => {
    const initialHistory = [
      conversationMessage("agent:hist:btw-1:1:user", "user", "历史用户消息 1", 1),
      conversationMessage("agent:hist:btw-1:1:assistant", "assistant", "历史助手消息 1", 1),
      conversationMessage("agent:hist:btw-1:2:user", "user", "历史用户消息 2", 2),
      conversationMessage("agent:hist:btw-1:2:assistant", "assistant", "历史助手消息 2", 2),
    ];
    const snapshot = createBtwConversationHistorySnapshot("btw-1", initialHistory);

    expect(snapshot.loadedTurnCount).toBe(2);
    expect(
      filterBtwConversationVisibleMessages(
        [
          ...initialHistory,
          conversationMessage("agent:user:btw-1:1", "user", "新问题"),
        ],
        snapshot,
      ).map((message) => message.content),
    ).toEqual(["新问题"]);

    const refreshedMessages = [
      conversationMessage("agent:hist:btw-1:changed-1:user", "user", "历史用户消息 1", 1),
      conversationMessage("agent:hist:btw-1:changed-1:assistant", "assistant", "历史助手消息 1", 1),
      conversationMessage("agent:hist:btw-1:changed-2:user", "user", "历史用户消息 2", 2),
      conversationMessage("agent:hist:btw-1:changed-2:assistant", "assistant", "历史助手消息 2", 2),
      conversationMessage("agent:hist:btw-1:3:user", "user", "新问题", 3),
      conversationMessage("agent:hist:btw-1:3:assistant", "assistant", "新回答", 3),
    ];

    expect(filterBtwConversationVisibleMessages(refreshedMessages, snapshot).map((message) => message.content)).toEqual(
      ["新问题", "新回答"],
    );
    expect(snapshot.loadedTurnCount).toBe(2);
  });

  it("keeps checkpoint-only bypass messages visible after the panel remounts", () => {
    const ownHistory = [
      conversationMessage("agent:user:btw-1:1", "user", "旁路问题", 1),
      conversationMessage("agent:assistant:btw-1:1", "assistant", "仍在流式的旁路回答", 1),
    ];
    const remountedSnapshot = createBtwConversationHistorySnapshot("btw-1", ownHistory, {
      loadedTurnCount: 0,
    });

    expect(selectBtwConversationVisibleMessages(ownHistory, remountedSnapshot, 0)).toBe(ownHistory);
  });
});

function agentSession(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "测试对话",
    session_tag: "chat",
    session_type: "chat",
    workspace_id: null,
    cwd: null,
    workspace_roots: [],
    workspace: null,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: true,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
    ...patch,
  } as AgentSession;
}

function conversationMessage(
  id: string,
  kind: ConversationMessage["kind"],
  content: string,
  turnIndex?: number,
): ConversationMessage {
  return {
    id,
    threadId: "btw-1",
    turnId: null,
    itemId: null,
    kind,
    content,
    payload: {
      turnIndex,
      turn_index: turnIndex,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
