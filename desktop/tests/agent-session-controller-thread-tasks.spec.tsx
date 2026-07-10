import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import type {
  AgentActionEnvelope,
  AgentHistoryResponse,
  AgentSession,
  ThreadTask,
} from "@/types/protocol";

describe("useAgentSessionController thread tasks", () => {
  it("loads active thread tasks after opening a session and after bind events", async () => {
    const task = threadTask("task-1");
    const listThreadTasks = vi.fn().mockResolvedValue([task]);
    const { runtime, emit } = fakeRuntime({ listThreadTasks });

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.activeTask?.id).toBe("task-1");
    });
    expect(listThreadTasks).toHaveBeenCalledWith("ses-1");

    act(() => {
      emit({ action: "bind_ok", data: { session_id: "ses-1" } });
    });

    await waitFor(() => {
      expect(listThreadTasks).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps history usable when task loading fails", async () => {
    const listThreadTasks = vi.fn().mockRejectedValue(new Error("task api down"));
    const { runtime } = fakeRuntime({
      listThreadTasks,
      history: [{ role: "assistant", content: "历史回答" }],
    });

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.agentMessages[0]?.content).toBe("历史回答");
    });
    expect(result.current.activeTask).toBeNull();
    expect(result.current.runtimeDetail).toBeNull();
  });

  it("does not request thread tasks when task sync is disabled", async () => {
    const listThreadTasks = vi.fn().mockResolvedValue([threadTask("task-1")]);
    const { runtime } = fakeRuntime({ listThreadTasks });

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        syncThreadTasks: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    expect(listThreadTasks).not.toHaveBeenCalled();
    expect(result.current.activeTask).toBeNull();
  });

  it("waits until enabled before opening the channel and loading session history", async () => {
    const listThreadTasks = vi.fn().mockResolvedValue([threadTask("task-1")]);
    const { runtime } = fakeRuntime({ listThreadTasks });

    const { rerender, result } = renderHook(
      ({ enabled }) =>
        useAgentSessionController({
          runtime,
          sessionId: "ses-1",
          enabled,
        }),
      { initialProps: { enabled: false } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(true);
    expect(runtime.conversation.openChatChannel).not.toHaveBeenCalled();
    expect(runtime.conversation.loadHistory).not.toHaveBeenCalled();
    expect(listThreadTasks).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => {
      expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("ses-1", {
        allTurns: true,
        direction: "older",
        pageSize: undefined,
      });
    });
    expect(runtime.conversation.openChatChannel).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(listThreadTasks).toHaveBeenCalledWith("ses-1");
    });
  });

  it("sends running-session text as a pending input payload without an optimistic user message", async () => {
    const { runtime, emit, channel } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        conversationSendDefaultMode: "steer",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    act(() => {
      emit({ action: "status", data: { session_id: "ses-1", status: "running" } });
    });
    await waitFor(() => {
      expect(result.current.runtimeState).toBe("running");
    });

    let sent = false;
    await act(async () => {
      sent = await result.current.sendText("运行中补充", selectedModel(), {
        allowWhileBusy: true,
        contextItems: [
          { id: "file-alpha", type: "file", label: "alpha.py", content: "alpha.py", path: "alpha.py" },
        ],
        runtimeParams: { message_injection: [{ type: "follow", role: "HumanMessage", content: "alpha.py" }] },
      });
    });

    expect(sent).toBe(true);
    expect(channel.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "ses-1",
        message: "运行中补充",
        provider_id: "provider-1",
        model: "qwen-coder",
        delivery_mode: "steer",
        client_input_id: expect.any(String),
        runtime_params: {
          message_injection: [{ type: "follow", role: "HumanMessage", content: "alpha.py" }],
          message_context_items: [
            { id: "file-alpha", type: "file", label: "alpha.py", content: "alpha.py", path: "alpha.py" },
          ],
        },
      }),
    );
    expect(result.current.agentMessages).toEqual([]);
  });

  it("uses Ctrl+Enter reverse mode against the configured default send behavior", async () => {
    const { runtime, emit, channel } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        conversationSendDefaultMode: "queue",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    act(() => {
      emit({ action: "status", data: { session_id: "ses-1", status: "running" } });
    });
    await waitFor(() => {
      expect(result.current.runtimeState).toBe("running");
    });

    await act(async () => {
      await result.current.sendText("默认排队", selectedModel(), {
        allowWhileBusy: true,
      });
      await result.current.sendText("反向引导", selectedModel(), {
        allowWhileBusy: true,
        reverseDeliveryMode: true,
      });
    });

    expect(channel.chat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "默认排队", delivery_mode: "queue" }),
    );
    expect(channel.chat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "反向引导", delivery_mode: "steer" }),
    );
  });

  it("fills the composer draft and cancels the original pending input when editing", async () => {
    const { channel, runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });

    await act(async () => {
      await result.current.editPendingInput({
        id: "pending-1",
        pending_input_id: "pending-1",
        session_id: "ses-1",
        mode: "queue",
        status: "queued",
        message: "回填这条待发送消息",
      });
    });

    expect(result.current.draft).toBe("回填这条待发送消息");
    expect(channel.cancelPendingInput).toHaveBeenCalledWith("ses-1", "pending-1", "user");
  });

  it("sends the complete pending input order when reordering", async () => {
    const { channel, runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });

    await act(async () => {
      await result.current.reorderPendingInputs(["pending-2", "pending-1"]);
    });

    expect(channel.reorderPendingInputs).toHaveBeenCalledWith({
      session_id: "ses-1",
      pending_input_ids: ["pending-2", "pending-1"],
    });
  });

  it("resumes one pending input or a complete mode group", async () => {
    const { channel, runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    await act(async () => {
      await result.current.resumePendingInputs({ pendingInputId: "pending-1" });
      await result.current.resumePendingInputs({ mode: "queue" });
    });

    expect(channel.resumePendingInputs).toHaveBeenNthCalledWith(1, {
      session_id: "ses-1",
      pending_input_id: "pending-1",
    });
    expect(channel.resumePendingInputs).toHaveBeenNthCalledWith(2, {
      session_id: "ses-1",
      mode: "queue",
    });
  });
});

function fakeRuntime({
  history = [],
  listThreadTasks = vi.fn().mockResolvedValue([]),
}: {
  history?: AgentHistoryResponse["list"];
  listThreadTasks?: ReturnType<typeof vi.fn>;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn((): WsConnectionStatus => "open"),
    getSessionId: vi.fn(() => "ses-1"),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat: vi.fn(),
    resumePendingInputs: vi.fn(),
    submitA2UI: vi.fn(),
    cancelA2UI: vi.fn(),
    approvalDecision: vi.fn(),
    cancel: vi.fn(),
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
    updatePendingInput: vi.fn(),
    reorderPendingInputs: vi.fn(),
    cancelPendingInput: vi.fn(),
    ping: vi.fn(),
  };
  const runtime = {
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(historyResponse(history)),
      listThreadTasks,
      openChatChannel: vi.fn(
        (onEvent: (event: AgentActionEnvelope) => void, options?: { onStatus?: (status: WsConnectionStatus) => void }) => {
          handler = onEvent;
          options?.onStatus?.("open");
          return channel;
        },
      ),
    },
  } as unknown as RuntimeBridge;
  return {
    channel,
    runtime,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
  };
}

function selectedModel() {
  return {
    providerId: "provider-1",
    model: "qwen-coder",
  };
}

function historyResponse(list: AgentHistoryResponse["list"]): AgentHistoryResponse {
  return {
    list,
    total: list.length,
    page: 1,
    page_size: 50,
    session: agentSession(),
    event_total: list.length,
    turn_indexes: list.length ? [1] : [],
  };
}

function agentSession(): AgentSession {
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
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
  };
}

function threadTask(id: string): ThreadTask {
  return {
    id,
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
  };
}
