import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge } from "@/runtime";
import { ChatLayout } from "@/renderer/pages/conversation/ChatLayout";
import { ConversationPage } from "@/renderer/pages/conversation";
import type { AgentHistoryResponse, AgentSession } from "@/types/protocol";

describe("ChatLayout", () => {
  it("renders a centered document layout without persistent workspace panels by default", () => {
    render(
      <ChatLayout title="对话 thread-1" subtitle="本地运行">
        <div data-testid="message-flow">真实消息流</div>
      </ChatLayout>,
    );

    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
    expect(screen.getByLabelText("更多对话操作")).not.toBeNull();
    expect(screen.getByTestId("chat-reading-column")).not.toBeNull();
    expect(screen.getByTestId("conversation-composer")).not.toBeNull();
    expect(screen.queryByLabelText("打开工作区")).toBeNull();
    expect(screen.queryByLabelText("打开预览")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "工作区" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "预览" })).toBeNull();
  });

  it("keeps the message flow mounted when a real preview panel is toggled", () => {
    let mounts = 0;
    function MessageFlow() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div data-testid="message-flow">消息流</div>;
    }

    render(
      <ChatLayout title="对话 thread-1" previewPanel={<div>真实预览内容</div>}>
        <MessageFlow />
      </ChatLayout>,
    );

    expect(screen.queryByLabelText("打开工作区")).toBeNull();
    expect(screen.getByRole("complementary", { name: "预览" })).not.toBeNull();
    expect(screen.getByTestId("message-flow")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("更多对话操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭预览" }));
    expect(screen.queryByRole("complementary", { name: "预览" })).toBeNull();
    expect(mounts).toBe(1);
  });
});

describe("ConversationPage", () => {
  it("renders the document chat shell for a thread", async () => {
    render(<ConversationPage threadId="thread-1" runtime={fakeRuntime()} />);

    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
    expect(await screen.findByTestId("conversation-empty")).not.toBeNull();
  });
});

function fakeRuntime(): RuntimeBridge {
  const session: AgentSession = {
    id: "thread-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "测试对话",
    session_tag: "chat",
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
  };
  const history: AgentHistoryResponse = {
    list: [],
    total: 0,
    page: 1,
    page_size: 50,
    session,
    event_total: 0,
    turn_indexes: [],
  };
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => "open" as const),
    getSessionId: vi.fn(() => "thread-1"),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat: vi.fn(),
    cancel: vi.fn(),
    ping: vi.fn(),
  };
  return {
    settings: {
      getSettings: vi.fn().mockResolvedValue({
        model: {
          base_url: "https://api.example/v1",
          model: "qwen-coder",
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
      }),
    },
    models: {
      listModels: vi.fn().mockResolvedValue({ models: [{ id: "qwen-coder" }], cached: true }),
    },
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(history),
      openChatChannel: vi.fn((_onEvent, options?: { onStatus?: (status: "open") => void }) => {
        options?.onStatus?.("open");
        return channel;
      }),
    },
  } as unknown as RuntimeBridge;
}
