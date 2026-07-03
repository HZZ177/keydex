import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { ConversationPage } from "@/renderer/pages/conversation";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import type { AgentActionEnvelope, AgentHistoryResponse, AgentSession, ThreadTask } from "@/types/protocol";

describe("ConversationPage goal task creation", () => {
  it("creates a goal task from the slash command and sends the seed turn as chat", async () => {
    const chat = vi.fn();
    const createThreadTask = vi.fn().mockResolvedValue(threadTask({ objective: "完成需求" }));
    const { runtime } = fakeRuntime({ chat, createThreadTask });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("/目标");
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect((await screen.findByTestId("goal-mode-accessory")).textContent).toContain("目标");
    expect(screen.queryByLabelText("目标内容")).toBeNull();

    typeComposer("完成需求");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(createThreadTask).toHaveBeenCalled();
    });
    const taskPayload = createThreadTask.mock.calls[0][1];
    expect(taskPayload.type).toBe("goal");
    expect(taskPayload.objective).toBe("完成需求");
    expect(taskPayload.metadata.seed_turn_context).toMatchObject({
      schema_version: 1,
      source: "goal_composer",
      message: "完成需求",
      context_items: [],
      runtime_params: {},
      attachments: [],
    });
    await waitFor(() => {
      expect(chat).toHaveBeenCalled();
    });
    const chatPayload = chat.mock.calls[0][0];
    expect(chatPayload).toMatchObject({
      session_id: "ses-1",
      message: "完成需求",
      provider_id: "provider-1",
      model: "qwen-coder",
      runtime_params: {
        message_context_items: [
          expect.objectContaining({
            type: "goal",
            label: "目标",
            content: "完成需求",
            source: "goal",
            metadata: expect.objectContaining({
              kind: "goal",
              objective: "完成需求",
            }),
          }),
        ],
      },
    });
    const goalContext = screen.getByLabelText("目标上下文");
    expect(within(goalContext).getByText("目标")).not.toBeNull();
    expect(within(goalContext).queryByText("完成需求")).toBeNull();
    const goalPreviewTrigger = within(goalContext).getByText("目标").closest("[data-preview-open]");
    if (!goalPreviewTrigger) {
      throw new Error("goal preview trigger not found");
    }
    fireEvent.mouseEnter(goalPreviewTrigger);
    await waitFor(() => {
      expect(
        Array.from(document.body.querySelectorAll("[data-floating-placement]")).some((card) =>
          card.textContent?.includes("完成需求"),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("goal-mode-accessory")).toBeNull();
    });
  });

  it("keeps empty goal task creation disabled on the client", async () => {
    const createThreadTask = vi.fn();
    const { runtime } = fakeRuntime({ createThreadTask });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("/目标");
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(await screen.findByTestId("goal-mode-accessory")).not.toBeNull();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(createThreadTask).not.toHaveBeenCalled();
  });

  it("does not open goal mode when an active task already exists", async () => {
    const existingTask = threadTask({ objective: "已有目标" });
    const createThreadTask = vi.fn();
    const listThreadTasks = vi.fn().mockResolvedValue([existingTask]);
    const { runtime } = fakeRuntime({ createThreadTask, listThreadTasks });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await waitFor(() => {
      expect(listThreadTasks).toHaveBeenCalledWith("ses-1");
    });
    typeComposer("/目标");
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(screen.queryByTestId("goal-mode-accessory")).toBeNull();
    expect(screen.getAllByText("已有目标").length).toBeGreaterThanOrEqual(1);
    expect(createThreadTask).not.toHaveBeenCalled();
  });

  it("refreshes active tasks when the create API reports an already-open task", async () => {
    const existingTask = threadTask({ objective: "后端已有目标" });
    const createThreadTask = vi.fn().mockRejectedValue({
      name: "RuntimeHttpError",
      status: 409,
      code: "task_already_open",
      message: "task_already_open",
    });
    const listThreadTasks = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([existingTask]);
    const { runtime } = fakeRuntime({ createThreadTask, listThreadTasks });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("/目标");
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });
    typeComposer("新的目标");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(listThreadTasks).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("当前已有进行中的目标")).not.toBeNull();
    expect(screen.getAllByText("后端已有目标").length).toBeGreaterThanOrEqual(1);
  });

  it("closes goal mode without clearing the composer draft", async () => {
    const createThreadTask = vi.fn();
    const { runtime } = fakeRuntime({ createThreadTask });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("/目标");
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    await screen.findByTestId("goal-mode-accessory");
    typeComposer("这是一条普通输入");
    fireEvent.click(screen.getByRole("button", { name: "关闭目标模式" }));

    expect(screen.queryByTestId("goal-mode-accessory")).toBeNull();
    expect(screen.getByLabelText("继续输入").textContent).toBe("这是一条普通输入");
    expect(createThreadTask).not.toHaveBeenCalled();
  });

  it("updates a task from the composer task capsule", async () => {
    const existingTask = threadTask({ objective: "可暂停目标" });
    const updateThreadTask = vi.fn().mockResolvedValue(threadTask({ status: "paused", objective: "可暂停目标" }));
    const { runtime } = fakeRuntime({
      listThreadTasks: vi.fn().mockResolvedValue([existingTask]),
      updateThreadTask,
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByTestId("thread-task-pill");
    fireEvent.click(screen.getByRole("button", { name: "暂停目标" }));

    await waitFor(() => {
      expect(updateThreadTask).toHaveBeenCalledWith("ses-1", "task-1", { status: "paused" });
    });
  });
});

function renderConversation(ui: ReactElement) {
  return render(<PreviewProvider>{ui}</PreviewProvider>);
}

function typeComposer(value: string) {
  const input = screen.getByLabelText("继续输入");
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

function fakeRuntime({
  chat = vi.fn(),
  createThreadTask = vi.fn().mockResolvedValue(threadTask()),
  updateThreadTask = vi.fn().mockResolvedValue(threadTask()),
  deleteThreadTask = vi.fn().mockResolvedValue(threadTask({ deleted_at: "2026-07-03T00:00:00Z", is_open: false })),
  listThreadTasks = vi.fn().mockResolvedValue([]),
  wsStatus = "open",
}: {
  chat?: ReturnType<typeof vi.fn>;
  createThreadTask?: ReturnType<typeof vi.fn>;
  updateThreadTask?: ReturnType<typeof vi.fn>;
  deleteThreadTask?: ReturnType<typeof vi.fn>;
  listThreadTasks?: ReturnType<typeof vi.fn>;
  wsStatus?: WsConnectionStatus;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const session = agentSession();
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => wsStatus),
    getSessionId: vi.fn(() => session.id),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat,
    approvalDecision: vi.fn(),
    cancel: vi.fn(),
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
    ping: vi.fn(),
  };
  const runtime = {
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(historyResponse(session)),
      listThreadTasks,
      createThreadTask,
      updateThreadTask,
      deleteThreadTask,
      openChatChannel: vi.fn((onEvent: (event: AgentActionEnvelope) => void, options?: { onStatus?: (status: WsConnectionStatus) => void }) => {
        handler = onEvent;
        options?.onStatus?.(wsStatus);
        return channel;
      }),
    },
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
    },
    models: {
      listProviders: vi.fn().mockResolvedValue([modelProvider()]),
    },
    workspace: {
      listSkills: vi.fn().mockResolvedValue({
        workspace_root: null,
        fingerprint: "",
        loaded_at: "2026-07-03T00:00:00Z",
        skills: [],
        diagnostics: [],
      }),
      listDirectory: vi.fn().mockResolvedValue({ root: "D:/repo", entries: [] }),
      readFile: vi.fn(),
      readMedia: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    },
  } as unknown as RuntimeBridge;
  return {
    runtime,
    channel,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
  };
}

function historyResponse(session: AgentSession): AgentHistoryResponse {
  return {
    list: [],
    total: 0,
    page: 1,
    page_size: 50,
    session,
    event_total: 0,
    turn_indexes: [],
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

function agentSession(): AgentSession {
  return {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "test",
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
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
  };
}

function threadTask(patch: Partial<ThreadTask> = {}): ThreadTask {
  return {
    id: "task-1",
    session_id: "ses-1",
    type: "goal",
    type_label: "目标",
    title: "目标",
    objective: "完成目标",
    status: "active",
    metadata: {},
    evidence: [],
    blocked_audit: {},
    system_stop_reason: null,
    current_run_id: null,
    turn_count: 0,
    elapsed_seconds: 0,
    token_usage: {},
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    deleted_at: null,
    is_open: true,
    is_terminal: false,
    ...patch,
  };
}
