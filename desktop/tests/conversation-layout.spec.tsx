import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge } from "@/runtime";
import { ChatLayout } from "@/renderer/pages/conversation/ChatLayout";
import { ConversationPage } from "@/renderer/pages/conversation";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import type { AgentHistoryResponse, AgentSession } from "@/types/protocol";

describe("ChatLayout", () => {
  it("renders a centered document layout without persistent workspace panels by default", () => {
    render(
      <ChatLayout title="对话 thread-1">
        <div data-testid="message-flow">真实消息流</div>
      </ChatLayout>,
    );

    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
    expect(screen.queryByLabelText("更多对话操作")).toBeNull();
    expect(screen.getByTestId("chat-reading-column")).not.toBeNull();
    expect(screen.getByTestId("conversation-composer")).not.toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows the current workspace in the top bar when provided", () => {
    render(
      <ChatLayout title="对话 thread-1" workspaceLabel="keydex" workspaceTitle={"keydex\nD:/repo/keydex"}>
        <div data-testid="message-flow">消息流</div>
      </ChatLayout>,
    );

    const meta = screen.getByTestId("chat-workspace-meta");
    const topBarText = meta.parentElement?.textContent ?? "";
    expect(meta.textContent).toContain("工作区");
    expect(meta.textContent).toContain("keydex");
    expect(meta.getAttribute("title")).toBe("keydex\nD:/repo/keydex");
    expect(topBarText.indexOf("keydex")).toBeLessThan(topBarText.indexOf("对话 thread-1"));
  });

  it("keeps the message flow mounted when the conversation menu opens", () => {
    let mounts = 0;
    const onExport = vi.fn();
    const onFork = vi.fn();
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onRefresh = vi.fn();
    function MessageFlow() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div data-testid="message-flow">消息流</div>;
    }

    render(
      <ChatLayout
        title="对话 thread-1"
        sessionActions={{
          canExport: true,
          onExport,
          canFork: true,
          onFork,
          canMutate: true,
          onRename,
          onArchive,
          showRefresh: true,
          onRefresh,
        }}
      >
        <MessageFlow />
      </ChatLayout>,
    );

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByTestId("message-flow")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("更多对话操作"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "导出对话记录",
      "从对话派生",
      "重命名",
      "归档",
      "刷新",
    ]);
    expect(screen.queryByRole("menuitem", { name: "复制标题" })).toBeNull();
    expect(screen.getByTestId("session-archive-icon")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "归档会话" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("更多对话操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "对话操作菜单" })).toBeNull();
    expect(screen.queryByText("已连接")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(mounts).toBe(1);
  });
});

describe("ConversationPage", () => {
  it("renders the document chat shell for a thread", async () => {
    render(
      <PreviewProvider>
        <ConversationPage threadId="thread-1" runtime={fakeRuntime()} />
      </PreviewProvider>,
    );

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
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
    archived_at: null,
    archive_origin: null,
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
    submitA2UI: vi.fn(),
    cancelA2UI: vi.fn(),
    approvalDecision: vi.fn(),
    cancel: vi.fn(),
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
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
      getModelDefaults: vi.fn().mockResolvedValue(modelDefaultsResponse()),
      getExtensionSettings: vi.fn().mockResolvedValue(defaultExtensionSettings()),
    },
    models: {
      listProviders: vi.fn().mockResolvedValue([modelProvider()]),
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

function defaultExtensionSettings() {
  return {
    file_edit_tool_style: "claude_code",
    auto_title: { enabled: false, only_when_default_title: true, max_title_length: 20 },
    duplicate_tool_call_guard: { enabled: true, max_repeats: 3 },
    context_compression: { enabled: true, context_window_tokens: 256000, trigger_fraction: 0.8 },
    a2ui: { enabled: true, debug_info_enabled: false },
  };
}

function modelDefaultsResponse() {
  return {
    defaults: {
      default_chat: {
        scope: "default_chat",
        configured: true,
        provider_id: "provider-1",
        provider_name: "默认模型服务",
        model: "qwen-coder",
        provider_enabled: true,
        model_enabled: true,
        missing_reason: null,
      },
      fast: {
        scope: "fast",
        configured: false,
        provider_id: null,
        provider_name: null,
        model: null,
        provider_enabled: null,
        model_enabled: null,
        missing_reason: "not_configured",
      },
    },
  };
}

function modelProvider() {
  return {
    id: "provider-1",
    name: "默认模型服务",
    base_url: "https://api.example/v1",
    enabled: true,
    api_key_set: true,
    api_key_preview: "sk-***",
    models: ["qwen-coder"],
    model_enabled: {},
    health: {},
  };
}
