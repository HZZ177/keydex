import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeBridge,
  WorkspaceSkillsResponse,
} from "@/runtime";
import { HomePage } from "@/renderer/pages/home";
import type { AgentSession, ModelInfo, Workspace } from "@/types/protocol";

describe("HomePage skill activation", () => {
  it("loads selected workspace skills and forwards skill activation to the new conversation", async () => {
    const workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse());
    const runtime = fakeRuntime({ model: "qwen-coder", workspaceListSkills });
    const onNavigateToConversation = vi.fn();

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(workspaceListSkills).toHaveBeenCalledWith({ workspaceId: "ws-1" }, { forceReload: false });
    });
    typePrompt("/");
    await screen.findByRole("option", { name: /^Skill\b/ });
    const input = screen.getByLabelText("输入需求");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("option", { name: /dev-plan/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("dev-plan")).not.toBeNull();

    typePrompt("implement this design");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "implement this design",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-1",
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
      "implement this design",
      expect.objectContaining({
        contextItems: [
          expect.objectContaining({
            type: "skill",
            label: "/dev-plan",
            skill_name: "dev-plan",
          }),
        ],
        runtimeParams: {
          skill_activation: {
            skill_name: "dev-plan",
            source: "workspace",
            origin: "slash",
          },
        },
      }),
    );
  });
});

function typePrompt(value: string) {
  const input = screen.getByLabelText("输入需求");
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

function fakeRuntime({
  model,
  models = model ? [{ id: model }] : [],
  workspaces = [workspace("ws-1", "keydex")],
  workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse()),
}: {
  model: string;
  models?: ModelInfo[];
  workspaces?: Workspace[];
  workspaceListSkills?: ReturnType<typeof vi.fn>;
}): RuntimeBridge {
  const session: AgentSession = {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "implement this design",
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
    current_model_provider_id: model ? "provider-1" : null,
    current_model: model || null,
  };

  return {
    settings: {
      getSettings: vi.fn().mockResolvedValue({
        model: {
          base_url: "https://api.example/v1",
          model,
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
      }),
      getModelDefaults: vi.fn().mockResolvedValue({
        defaults: {
          default_chat: {
            scope: "default_chat",
            configured: Boolean(model),
            provider_id: model ? "provider-1" : null,
            provider_name: model ? "默认模型服务" : null,
            model: model || null,
            provider_enabled: model ? true : null,
            model_enabled: model ? true : null,
            missing_reason: model ? null : "not_configured",
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
      }),
    },
    models: {
      listProviders: vi.fn().mockResolvedValue(
        model
          ? [
              {
                id: "provider-1",
                name: "默认模型服务",
                base_url: "https://api.example/v1",
                enabled: true,
                api_key_set: true,
                api_key_preview: "sk-***",
                models: models.map((item) => item.id),
                model_enabled: {},
                health: {},
              },
            ]
          : [],
      ),
    },
    workspaces: {
      list: vi.fn().mockResolvedValue({ list: workspaces, total: workspaces.length }),
      create: vi.fn(),
    },
    workspace: {
      listSkills: workspaceListSkills,
      listDirectory: vi.fn().mockResolvedValue({ root: "D:/repo", entries: [] }),
      readFile: vi.fn(),
      readMedia: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    },
    desktopPicker: {
      isDirectoryPickerAvailable: vi.fn(() => false),
      pickDirectory: vi.fn().mockResolvedValue(null),
    },
    conversation: {
      createSession: vi.fn().mockResolvedValue(session),
    },
  } as unknown as RuntimeBridge;
}

function workspace(id: string, name: string, rootPath = `D:\\Pycharm Projects\\${name}`): Workspace {
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

function skillsResponse(): WorkspaceSkillsResponse {
  return {
    workspace_root: "D:/repo",
    fingerprint: "fp-1",
    loaded_at: "2026-06-25T12:00:00Z",
    skills: [
      {
        name: "dev-plan",
        description: "Plan work from a design doc",
        source: "workspace",
        label: "/dev-plan",
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    ],
    diagnostics: [],
  };
}
