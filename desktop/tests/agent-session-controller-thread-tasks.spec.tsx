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
    approvalDecision: vi.fn(),
    cancel: vi.fn(),
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
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
    runtime,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
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
