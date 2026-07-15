import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, EffectiveSkillsResponse, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { ConversationPage } from "@/renderer/pages/conversation";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { AgentActionEnvelope, AgentHistoryResponse, AgentSession, Workspace } from "@/types/protocol";

describe("ConversationPage skill activation", () => {
  it("sends selected workspace skill as runtime skill activation", async () => {
    const chat = vi.fn();
    const workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse());
    const { runtime } = fakeRuntime({ chat, workspaceListSkills });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await waitFor(() => {
      expect(workspaceListSkills).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
    });
    typeComposer("/");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /^Skill\b/ }));
    const input = screen.getByLabelText("继续输入");
    await screen.findByRole("option", { name: /dev-plan/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("dev-plan")).not.toBeNull();

    typeComposer("implement this design");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(chat).toHaveBeenCalledWith({
        client_input_id: expect.any(String),
        delivery_mode: "steer",
        session_id: "ses-1",
        message: "implement this design",
        provider_id: "provider-1",
        model: "qwen-coder",
        runtime_params: {
          message_context_items: [
            expect.objectContaining({
              id: "skill:workspace:dev-plan",
              skill_name: "dev-plan",
              source: "workspace",
              type: "skill",
            }),
          ],
          skill_activation: {
            skill_name: "dev-plan",
            source: "workspace",
            origin: "slash",
          },
        },
      });
    });
  });

  it("loads and sends a system skill in a pure Chat session without workspace capabilities", async () => {
    const chat = vi.fn();
    const listSession = vi.fn().mockResolvedValue(skillsResponse({ source: "system" }));
    const { runtime } = fakeRuntime({
      chat,
      workspaceListSkills: listSession,
      session: agentSession({ session_type: "chat", workspace_id: null, cwd: null, workspace_roots: [], workspace: null }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await waitFor(() => {
      expect(listSession).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
    });
    typeComposer("/");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /^Skill\b/ }));
    const input = screen.getByLabelText("继续输入");
    await screen.findByRole("option", { name: /dev-plan/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("dev-plan")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));
    await waitFor(() => {
      expect(screen.getByTestId("skill-preview-request").textContent).toBe(
        "skill-resource:system:dev-plan:SKILL.md",
      );
    });
    typeComposer("plan this chat");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(chat).toHaveBeenCalledWith(expect.objectContaining({
        session_id: "ses-1",
        message: "plan this chat",
        runtime_params: {
          message_context_items: [expect.objectContaining({
            id: "skill:system:dev-plan",
            skill_name: "dev-plan",
            source: "system",
            type: "skill",
          })],
          skill_activation: {
            skill_name: "dev-plan",
            source: "system",
            origin: "slash",
          },
        },
      }));
    });
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });
});

function renderConversation(ui: ReactElement) {
  return render(
    <PreviewProvider>
      {ui}
      <PreviewRequestProbe />
    </PreviewProvider>,
  );
}

function PreviewRequestProbe() {
  const preview = usePreview();
  const request = preview.activeEntry?.request;
  return (
    <output data-testid="skill-preview-request">
      {request?.type === "skill-resource"
        ? `${request.type}:${request.skillSource}:${request.skillName}:${request.resourcePath}`
        : request?.type ?? ""}
    </output>
  );
}

function typeComposer(value: string) {
  const input = screen.getByLabelText("继续输入");
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

function fakeRuntime({
  chat = vi.fn(),
  workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse()),
  wsStatus = "open",
  session,
}: {
  chat?: ReturnType<typeof vi.fn>;
  workspaceListSkills?: ReturnType<typeof vi.fn>;
  wsStatus?: WsConnectionStatus;
  session?: AgentSession;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const activeSession = session ?? agentSession({
    session_type: "workspace",
    workspace_id: "ws-1",
    cwd: "D:/repo",
    workspace_roots: ["D:/repo"],
    workspace: workspace("ws-1", "repo", "D:/repo"),
  });
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => wsStatus),
    getSessionId: vi.fn(() => activeSession.id),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat,
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
      loadHistory: vi.fn().mockResolvedValue(historyResponse(activeSession)),
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
    skills: {
      listSession: workspaceListSkills,
      listWorkspace: workspaceListSkills,
      readSessionResource: vi.fn((_sessionId, request) => Promise.resolve({
        skill_name: request.skill_name,
        source: request.source,
        resource_path: request.resource_path,
        locator: `${request.source}:skills/${request.skill_name}/${request.resource_path}`,
        content: "# Skill resource",
        encoding: "utf-8",
        revision: `sha256:${request.source}:${request.resource_path}`,
        fingerprint: "sha256:catalog",
      })),
    },
    workspace: {
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
    archived_at: null,
    archive_origin: null,
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
    archived_at: null,
  };
}

function skillsResponse({ source = "workspace" }: { source?: "system" | "workspace" } = {}): EffectiveSkillsResponse {
  return {
    mode: source === "system" ? "system_only" : "workspace_effective",
    workspace_root: source === "system" ? null : "D:/repo",
    fingerprint: "fp-1",
    loaded_at: "2026-06-25T12:00:00Z",
    skills: [
      {
        name: "dev-plan",
        description: "Plan work from a design doc",
        source,
        label: "/dev-plan",
        locator: source === "system" ? "system:skills/dev-plan/SKILL.md" : ".keydex/skills/dev-plan/SKILL.md",
      },
    ],
    diagnostics: [],
  };
}
