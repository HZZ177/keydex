import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceTreeResponse } from "@/runtime";
import { HomePage } from "@/renderer/pages/home";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { AgentSession, ModelInfo, Workspace } from "@/types/protocol";

describe("HomePage", () => {
  it("creates a session from the centered quick chat prompt", async () => {
    const runtime = fakeRuntime({ model: "qwen-coder" });
    const onNavigateToConversation = vi.fn();
    const onOpenModelSettings = vi.fn();

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    });
    enterPrompt("实现一个新功能");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "实现一个新功能",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-1",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith("ses-1", "qwen-coder", "实现一个新功能");
    expect(onOpenModelSettings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("工作目录")).toBeNull();
    expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByLabelText("自定义模型配置")).toBeNull();
    expect(screen.queryByRole("group", { name: "权限模式" })).toBeNull();
    expect(screen.queryByText("按需审批")).toBeNull();
    expect(screen.queryByText("本地模式")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开模型设置" })).toBeNull();
  });

  it("keeps model selection available with a real workspace selector", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      models: [{ id: "qwen-coder" }, { id: "deepseek-coder" }, { id: "kimi-k2" }],
    });

    const onNavigateToConversation = vi.fn();
    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    });
    expect(screen.queryByRole("combobox", { name: "选择模型" })).toBeNull();

    fireEvent.click(screen.getByLabelText("选择模型"));
    const listbox = screen.getByRole("listbox", { name: "模型" });
    expect(listbox).not.toBeNull();
    expect(listbox.closest("[data-placement]")?.getAttribute("data-placement")).toBe("bottom");
    expect(screen.getByRole("option", { name: "qwen-coder" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(screen.getByLabelText("筛选模型"), { target: { value: "deep" } });
    expect(screen.queryByRole("option", { name: "qwen-coder" })).toBeNull();
    expect(screen.queryByRole("option", { name: "kimi-k2" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "deepseek-coder" }));
    enterPrompt("读取仓库结构");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "读取仓库结构",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-1",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith("ses-1", "deepseek-coder", "读取仓库结构");
    expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByRole("button", { name: "完全访问" })).toBeNull();
  });

  it("searches files through the selected workspace on the new chat page", async () => {
    const workspaceSearch = vi.fn().mockResolvedValue([
      { path: "README.md", name: "README.md", type: "file" },
    ]);
    const runtime = fakeRuntime({ model: "qwen-coder", workspaceSearch });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    });
    enterPrompt("@READ");

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    await waitFor(() => {
      expect(workspaceSearch).toHaveBeenCalledWith(
        { workspaceId: "ws-1" },
        "READ",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });
    expect(await screen.findByRole("option", { name: /README\.md/ })).not.toBeNull();
  });

  it("starts a new chat with selected files as follow injections", async () => {
    const workspaceSearch = vi.fn().mockResolvedValue([
      { path: "README.md", name: "README.md", type: "file" },
    ]);
    const runtime = fakeRuntime({ model: "qwen-coder", workspaceSearch });
    const onNavigateToConversation = vi.fn();

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    });
    enterPrompt("@READ");
    fireEvent.mouseDown(await screen.findByRole("option", { name: "选择文件 README.md" }));
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "README.md",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-1",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      "qwen-coder",
      "",
      expect.objectContaining({
        contextItems: [expect.objectContaining({ type: "file", path: "README.md", source: "follow" })],
        runtimeParams: expect.objectContaining({
          message_injection: [
            expect.objectContaining({
              type: "follow",
              role: "HumanMessage",
              metadata: expect.objectContaining({ kind: "file", path: "README.md" }),
            }),
          ],
        }),
      }),
    );
  });

  it("defaults new chat to the most recently opened workspace from runtime", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      workspaces: [
        workspace("ws-recent", "recent-project", "D:\\Projects\\recent-project", "2026-06-21T10:00:00Z"),
        workspace("ws-old", "old-project", "D:\\Projects\\old-project", "2026-06-20T10:00:00Z"),
      ],
    });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("recent-project");
    });
    expect(screen.getByRole("heading", { name: "我们应该在 recent-project 中构建什么？" })).not.toBeNull();

    enterPrompt("继续开发");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "继续开发",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-recent",
      });
    });
  });

  it("selects the workspace requested by the route before creating a session", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      workspaces: [
        workspace("ws-recent", "recent-project", "D:\\Projects\\recent-project", "2026-06-21T10:00:00Z"),
        workspace("ws-target", "target-project", "D:\\Projects\\target-project", "2026-06-20T10:00:00Z"),
      ],
    });

    render(
      <HomePage
        runtime={runtime}
        initialWorkspaceId="ws-target"
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("target-project");
    });
    expect(screen.getByRole("heading", { name: "我们应该在 target-project 中构建什么？" })).not.toBeNull();

    enterPrompt("继续开发");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "继续开发",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-target",
      });
    });
  });

  it("shows project-free chat as the default empty state when no workspace exists", async () => {
    const runtime = fakeRuntime({ model: "qwen-coder", workspaces: [] });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("无项目聊天");
    });
    expect(screen.getByRole("heading", { name: "我们应该聊些什么？" })).not.toBeNull();

    enterPrompt("先聊一下方案");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "先聊一下方案",
        session_tag: "chat",
        sessionType: "chat",
      });
    });
  });

  it("adds a workspace from the desktop folder picker", async () => {
    const pickDirectory = vi.fn().mockResolvedValue("D:\\Projects\\picked-project");
    const runtime = fakeRuntime({
      model: "qwen-coder",
      workspaces: [],
      canPickDirectory: true,
      pickDirectory,
    });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("无项目聊天");
    });
    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: "添加新项目" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "使用现有文件夹" }));

    await waitFor(() => {
      expect(runtime.workspaces.create).toHaveBeenCalledWith({ rootPath: "D:\\Projects\\picked-project" });
    });
    expect(screen.getByLabelText("选择工作区").textContent).toContain("picked-project");
  });

  it("keeps the folder picker button visible and falls back to manual path input when unsupported", async () => {
    const runtime = fakeRuntime({ model: "qwen-coder", workspaces: [] });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("无项目聊天");
    });
    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: "添加新项目" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "使用现有文件夹" }));

    expect((await screen.findByRole("alert")).textContent).toContain("当前环境无法打开文件夹选择器");
    fireEvent.click(screen.getByRole("menuitem", { name: "输入本机路径" }));
    expect(screen.getByLabelText("项目路径")).not.toBeNull();
  });

  it("does not create a session for empty input", async () => {
    const runtime = fakeRuntime({ model: "qwen-coder" });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    });
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
  });

  it("opens model settings and shows an error when no model is configured", async () => {
    const runtime = fakeRuntime({ model: "" });
    const onOpenModelSettings = vi.fn();

    render(
      <NotificationProvider>
        <HomePage
          runtime={runtime}
          onNavigateToConversation={vi.fn()}
          onOpenModelSettings={onOpenModelSettings}
        />
      </NotificationProvider>,
    );

    await screen.findByRole("button", { name: "打开模型设置" });
    enterPrompt("开始对话");
    fireEvent.click(screen.getByLabelText("发送"));

    expect((await screen.findByRole("alert")).textContent).toBe("请先在设置中选择模型");
    expect(screen.getByTestId("notification-item")).not.toBeNull();
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "打开模型设置" })).not.toBeNull();
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
  });

  it("creates a project-free chat session when no project chat is selected", async () => {
    const workspaceSearch = vi.fn().mockResolvedValue([]);
    const runtime = fakeRuntime({ model: "qwen-coder", workspaceSearch });
    const onNavigateToConversation = vi.fn();

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    });
    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: /无项目聊天/ }));
    enterPrompt("@README");
    expect(screen.queryByTestId("at-file-menu")).toBeNull();
    expect(workspaceSearch).not.toHaveBeenCalled();
    enterPrompt("只聊思路");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "只聊思路",
        session_tag: "chat",
        sessionType: "chat",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith("ses-1", "qwen-coder", "只聊思路");
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
  });
});

function enterPrompt(value: string) {
  const input = screen.getByLabelText("输入需求");
  input.textContent = value;
  fireEvent.input(input);
}

function fakeRuntime({
  model,
  models = model ? [{ id: model }] : [],
  workspaces = [workspace("ws-1", "keydex")],
  workspaceSearch = vi.fn().mockResolvedValue([]),
  workspaceEntriesByPath = { "": [] },
  canPickDirectory = false,
  pickDirectory = vi.fn().mockResolvedValue(null),
}: {
  model: string;
  models?: ModelInfo[];
  workspaces?: Workspace[];
  workspaceSearch?: ReturnType<typeof vi.fn>;
  workspaceEntriesByPath?: Record<string, WorkspaceEntry[]>;
  canPickDirectory?: boolean;
  pickDirectory?: ReturnType<typeof vi.fn>;
}): RuntimeBridge {
  const session: AgentSession = {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "实现一个新功能",
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
    },
    models: {
      listModels: vi.fn().mockResolvedValue({ models, cached: true }),
    },
    workspaces: {
      list: vi.fn().mockResolvedValue({ list: workspaces, total: workspaces.length }),
      create: vi.fn().mockImplementation((payload: { rootPath: string }) =>
        Promise.resolve(workspace("ws-new", payload.rootPath.split(/[\\/]/).pop() || "project", payload.rootPath)),
      ),
    },
    workspace: {
      listDirectory: vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
        const entries = workspaceEntriesByPath[path];
        if (!entries) {
          return Promise.reject(new Error(`目录不存在：${path}`));
        }
        return Promise.resolve({ root: "D:/repo", entries });
      }),
      search: workspaceSearch,
    },
    desktopPicker: {
      isDirectoryPickerAvailable: vi.fn(() => canPickDirectory),
      pickDirectory,
    },
    conversation: {
      createSession: vi.fn().mockResolvedValue(session),
    },
  } as unknown as RuntimeBridge;
}

function workspace(
  id: string,
  name: string,
  rootPath = `D:\\Pycharm Projects\\${name}`,
  lastOpenedAt: string | null = null,
): Workspace {
  return {
    id,
    name,
    root_path: rootPath,
    normalized_root_path: rootPath.replace(/\\/g, "/").toLowerCase(),
    type: "project",
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    last_opened_at: lastOpenedAt,
    is_deleted: false,
  };
}
