import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WorkspaceSkillsResponse, WsConnectionStatus } from "@/runtime";
import { ConversationPage } from "@/renderer/pages/conversation";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import type { AgentActionEnvelope, AgentHistoryResponse, AgentSession, Workspace } from "@/types/protocol";

describe("ConversationPage skill errors", () => {
  it("force reloads workspace skills and clears the skill capsule when skill_not_found arrives", async () => {
    let forceReloadCount = 0;
    const workspaceListSkills = vi.fn().mockImplementation(
      (_params: { sessionId: string }, options?: { forceReload?: boolean }) => {
        if (options?.forceReload) {
          forceReloadCount += 1;
          return Promise.resolve(forceReloadCount >= 2 ? skillsResponse({ skills: [] }) : skillsResponse());
        }
        return Promise.resolve(skillsResponse());
      },
    );
    const { runtime, emit } = fakeRuntime({ workspaceListSkills });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await waitFor(() => {
      expect(workspaceListSkills).toHaveBeenCalledWith({ sessionId: "ses-1" }, { forceReload: false });
    });
    typeComposer("/");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /^Skill\b/ }));
    const input = screen.getByLabelText("继续输入");
    await screen.findByRole("option", { name: /dev-plan/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("dev-plan")).not.toBeNull();

    act(() => {
      emit(agentEvent("error", {
        session_id: "ses-1",
        code: "skill_not_found",
        message: "Skill does not exist or has been deleted",
      }));
    });

    await waitFor(() => {
      expect(workspaceListSkills).toHaveBeenCalledWith({ sessionId: "ses-1" }, { forceReload: true });
    });
    expect(screen.queryByText("dev-plan")).toBeNull();
    expect((await screen.findByTestId("notification-item")).textContent).toContain("已刷新 Skill 列表");
  });
});

function renderConversation(ui: ReactElement) {
  return render(
    <NotificationProvider>
      <PreviewProvider>{ui}</PreviewProvider>
    </NotificationProvider>,
  );
}

function typeComposer(value: string) {
  const input = screen.getByLabelText("继续输入");
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

function fakeRuntime({
  workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse()),
  wsStatus = "open",
}: {
  workspaceListSkills?: ReturnType<typeof vi.fn>;
  wsStatus?: WsConnectionStatus;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const session = agentSession({
    session_type: "workspace",
    workspace_id: "ws-1",
    cwd: "D:/repo",
    workspace_roots: ["D:/repo"],
    workspace: workspace("ws-1", "repo", "D:/repo"),
  });
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => wsStatus),
    getSessionId: vi.fn(() => session.id),
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
  const runtime = {
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(historyResponse(session)),
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
      getExtensionSettings: vi.fn().mockResolvedValue(defaultExtensionSettings()),
    },
    models: {
      listProviders: vi.fn().mockResolvedValue([modelProvider()]),
    },
    workspace: {
      listSkills: workspaceListSkills,
      listDirectory: vi.fn().mockResolvedValue({ root: "D:/repo", entries: [] }),
      readFile: vi.fn(),
      readMedia: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    },
  } as unknown as RuntimeBridge;
  return {
    runtime,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
  };
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

function agentSession(patch: Partial<AgentSession> = {}): AgentSession {
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
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
    ...patch,
  };
}

function workspace(id: string, name: string, rootPath: string): Workspace {
  return {
    id,
    name,
    root_path: rootPath,
    normalized_root_path: rootPath.replace(/\\/g, "/").toLowerCase(),
    type: "project",
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    last_opened_at: null,
    is_deleted: false,
  };
}

function skillsResponse({
  skills = [
    {
      name: "dev-plan",
      description: "Plan work from a design doc",
      source: "workspace" as const,
      label: "/dev-plan",
      locator: ".keydex/skills/dev-plan/SKILL.md",
    },
  ],
}: {
  skills?: WorkspaceSkillsResponse["skills"];
} = {}): WorkspaceSkillsResponse {
  return {
    workspace_root: "D:/repo",
    fingerprint: "fp-1",
    loaded_at: "2026-06-25T12:00:00Z",
    skills,
    diagnostics: [],
  };
}

function agentEvent(action: AgentActionEnvelope["action"], data: Record<string, unknown>): AgentActionEnvelope {
  return { action, data } as AgentActionEnvelope;
}
