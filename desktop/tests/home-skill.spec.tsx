import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  EffectiveSkillsResponse,
  RuntimeBridge,
  SkillSummary,
} from "@/runtime";
import { HomePage } from "@/renderer/pages/home";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
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
      expect(workspaceListSkills).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
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

  it("loads system winners for project-free chat without creating a hidden session", async () => {
    const systemListSkills = vi.fn().mockResolvedValue(
      skillsResponse([skill("review", "system")], "system_only"),
    );
    const workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse());
    const runtime = fakeRuntime({
      model: "qwen-coder",
      systemListSkills,
      workspaceListSkills,
    });
    const onNavigateToConversation = vi.fn();

    render(
      <HomePage
        runtime={runtime}
        initialSessionType="chat"
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(systemListSkills).toHaveBeenCalledWith(
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
    });
    expect(workspaceListSkills).not.toHaveBeenCalled();
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("添加附件")).toBeNull();

    selectFirstSkill("review");
    typePrompt("review the proposal");
    const sendButton = screen.getByLabelText("发送") as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "review the proposal",
        session_tag: "chat",
        sessionType: "chat",
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
      "review the proposal",
      expect.objectContaining({
        runtimeParams: {
          skill_activation: {
            skill_name: "review",
            source: "system",
            origin: "slash",
          },
        },
      }),
    );
  });

  it("keeps ordinary chat usable when the system skill bootstrap fails", async () => {
    const systemListSkills = vi.fn().mockRejectedValue(new Error("system catalog unavailable"));
    const runtime = fakeRuntime({ model: "qwen-coder", systemListSkills });

    render(
      <HomePage
        runtime={runtime}
        initialSessionType="chat"
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => expect(systemListSkills).toHaveBeenCalled());
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
    typePrompt("chat without skills");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(runtime.conversation.createSession).toHaveBeenCalled());
  });

  it("ignores a late system response after the default project scope wins", async () => {
    const pendingSystem = deferred<EffectiveSkillsResponse>();
    const systemListSkills = vi.fn().mockReturnValue(pendingSystem.promise);
    const workspaceListSkills = vi.fn().mockResolvedValue(
      skillsResponse([skill("project-review", "workspace")]),
    );
    const runtime = fakeRuntime({ model: "qwen-coder", systemListSkills, workspaceListSkills });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => expect(workspaceListSkills).toHaveBeenCalled());
    typePrompt("/project");
    expect(await screen.findByRole("option", { name: /project-review/u })).not.toBeNull();

    pendingSystem.resolve(skillsResponse([skill("system-late", "system")], "system_only"));
    await Promise.resolve();

    expect(screen.queryByRole("option", { name: /system-late/u })).toBeNull();
    expect(screen.getByRole("option", { name: /project-review/u })).not.toBeNull();
  });

  it("clears a selected project winner when chat resolves the same name from system", async () => {
    const systemListSkills = vi.fn().mockResolvedValue(
      skillsResponse([skill("shared", "system")], "system_only"),
    );
    const workspaceListSkills = vi.fn().mockResolvedValue(
      skillsResponse([skill("shared", "workspace")]),
    );
    const runtime = fakeRuntime({ model: "qwen-coder", systemListSkills, workspaceListSkills });

    render(
      <NotificationProvider>
        <HomePage
          runtime={runtime}
          onNavigateToConversation={vi.fn()}
          onOpenModelSettings={vi.fn()}
        />
      </NotificationProvider>,
    );

    await waitFor(() => expect(workspaceListSkills).toHaveBeenCalled());
    selectFirstSkill("shared");
    expect(screen.getByLabelText("删除 Skill /shared")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: /无项目聊天/u }));

    await waitFor(() => expect(systemListSkills).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByLabelText("删除 Skill /shared")).toBeNull());
    expect(screen.getByTestId("notification-item").textContent).toContain(
      "同名 Skill 的有效来源已变化",
    );
  });
});

function selectFirstSkill(name: string) {
  typePrompt("/");
  fireEvent.mouseDown(screen.getByRole("option", { name: /^Skill\b/u }));
  fireEvent.mouseDown(screen.getByRole("option", { name: new RegExp(name, "u") }));
}

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
  systemListSkills = vi.fn().mockResolvedValue(skillsResponse([], "system_only")),
  workspaceListSkills = vi.fn().mockResolvedValue(skillsResponse()),
}: {
  model: string;
  models?: ModelInfo[];
  workspaces?: Workspace[];
  systemListSkills?: ReturnType<typeof vi.fn>;
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
    archived_at: null,
    archive_origin: null,
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
    skills: {
      listSystem: systemListSkills,
      listSession: workspaceListSkills,
      listWorkspace: workspaceListSkills,
    },
    workspace: {
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
    archived_at: null,
  };
}

function skillsResponse(
  skills: SkillSummary[] = [skill("dev-plan", "workspace")],
  mode: EffectiveSkillsResponse["mode"] = "workspace_effective",
): EffectiveSkillsResponse {
  return {
    mode,
    workspace_root: mode === "system_only" ? null : "D:/repo",
    fingerprint: "fp-1",
    loaded_at: "2026-06-25T12:00:00Z",
    skills,
    diagnostics: [],
  };
}

function skill(name: string, source: SkillSummary["source"]): SkillSummary {
  return {
    name,
    description: `${source} ${name}`,
    source,
    label: `/${name}`,
    locator: `.keydex/skills/${name}/SKILL.md`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
