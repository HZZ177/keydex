import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceTreeResponse } from "@/runtime";
import { Layout } from "@/renderer/components/layout/Layout";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { HomePage } from "@/renderer/pages/home";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type { AgentSession, Workspace } from "@/types/protocol";

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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
      "实现一个新功能",
    );
    expect(onOpenModelSettings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("工作目录")).toBeNull();
    expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByTestId("context-window-indicator")).toBeNull();
    expect(screen.queryByLabelText("自定义模型配置")).toBeNull();
    expect(screen.queryByRole("group", { name: "权限模式" })).toBeNull();
    expect(screen.queryByText("按需审批")).toBeNull();
    expect(screen.queryByText("本地模式")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开模型设置" })).toBeNull();
  });

  it("focuses the prompt when opened from a quick new conversation action", async () => {
    const runtime = fakeRuntime({ model: "qwen-coder" });

    render(
      <HomePage
        runtime={runtime}
        autoFocusInputKey="route-focus"
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("输入需求");
    expect(document.activeElement).toBe(input);
    await waitFor(() => {
      expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    });
    (input as HTMLElement).blur();
    window.getSelection()?.removeAllRanges();
  });

  it("keeps model selection available with a real workspace selector", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      models: ["qwen-coder", "deepseek-coder", "kimi-k2"],
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
        currentModelProviderId: "provider-1",
        currentModel: "deepseek-coder",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "deepseek-coder" },
      "读取仓库结构",
    );
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

    expect(await screen.findByTestId("at-file-menu", undefined, { timeout: 5000 })).not.toBeNull();
    await waitFor(() => {
      expect(workspaceSearch).toHaveBeenCalledWith(
        { workspaceId: "ws-1" },
        "READ",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });
    expect(await screen.findByRole("option", { name: /README\.md/ })).not.toBeNull();
  });

  it("uses the selected project as the right sidebar file workspace on the new chat page", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      workspaces: [
        workspace("ws-1", "keydex", "D:\\Projects\\keydex"),
        workspace("ws-2", "desktop-app", "D:\\Projects\\desktop-app"),
      ],
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 12)],
      },
    });

    renderHomeInLayout(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    });

    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    expect(await screen.findByRole("tree", { name: "工作区目录" }, { timeout: 5000 })).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ workspaceId: "ws-1" }, "");
    });

    fireEvent.click(screen.getByLabelText("选择工作区"));
    fireEvent.click(await screen.findByRole("option", { name: /desktop-app/ }));

    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ workspaceId: "ws-2" }, "");
    });

    fireEvent.click(screen.getByLabelText("选择工作区"));
    fireEvent.click(screen.getByRole("button", { name: /无项目聊天/ }));

    expect(await screen.findByTestId("right-sidebar-initial-page")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "文件" })).toBeNull();
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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
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

  it("adds selected preview text as a source quote when starting a new chat", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# README\n\nAlpha selected text",
      },
    });
    const onNavigateToConversation = vi.fn();

    renderHomeInLayout(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");
    });

    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));

    const body = await screen.findByLabelText("预览内容");
    expect(await screen.findByText("Alpha selected text")).not.toBeNull();
    const selection = await showSelectionToolbar(body, "Alpha selected text");
    expect(await screen.findByRole("button", { name: "添加选中文本到对话" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "为选中文本添加批注" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "添加选中文本到对话" }));

    expect(await screen.findByText("README.md · L3")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "README.md · L3",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "ws-1",
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });

    const options = onNavigateToConversation.mock.calls.at(-1)?.[3];
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
      "",
      expect.objectContaining({
        contextItems: [
          expect.objectContaining({
            type: "source_quote",
            path: "README.md",
            content: "Alpha selected text",
            metadata: expect.objectContaining({
              kind: "source_quote",
              path: "README.md",
              line_start: 3,
              line_end: 3,
            }),
          }),
        ],
      }),
    );
    expect(options?.runtimeParams?.message_injection?.[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: expect.objectContaining({
        kind: "source_quote",
        path: "README.md",
        line_start: 3,
        line_end: 3,
      }),
    });
    expect(options?.runtimeParams?.message_injection?.[0]?.content).toContain("用户引用了工作区文件中的一个自洽片段");
    expect(options?.runtimeParams?.message_injection?.[0]?.content).toContain("文件：README.md");
    expect(options?.runtimeParams?.message_injection?.[0]?.content).toContain("引用内容：\nAlpha selected text");
    selection.restore();
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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
  });

  it("selects project-free chat when the route requests chat sessions", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      workspaces: [
        workspace("ws-recent", "recent-project", "D:\\Projects\\recent-project", "2026-06-21T10:00:00Z"),
      ],
    });

    render(
      <HomePage
        runtime={runtime}
        initialSessionType="chat"
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("选择工作区").textContent).toContain("无项目聊天");
    });
    expect(screen.getByRole("heading", { name: "我们应该聊些什么？" })).not.toBeNull();

    enterPrompt("只聊方案");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "只聊方案",
        session_tag: "chat",
        sessionType: "chat",
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
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
    fireEvent.click(screen.getByRole("menuitem", { name: "选择文件夹" }));

    await waitFor(() => {
      expect(runtime.workspaces.create).toHaveBeenCalledWith({ rootPath: "D:\\Projects\\picked-project" });
    });
    expect(screen.getByLabelText("选择工作区").textContent).toContain("picked-project");
  });

  it("renders the new chat surface while backend-dependent controls wait for runtime readiness", async () => {
    const deferred = createDeferred<{
      host: string;
      port: number;
      base_url: string;
      data_dir: string;
    }>();
    const runtime = fakeRuntime({ model: "qwen-coder" });

    render(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={() => deferred.promise}
        isDesktopRuntime={() => true}
      >
        <HomePage
          runtime={runtime}
          onNavigateToConversation={vi.fn()}
          onOpenModelSettings={vi.fn()}
        />
      </RuntimeConnectionProvider>,
    );

    expect(screen.getByTestId("home-page")).not.toBeNull();
    expect(screen.queryByText("正在启动本地服务")).toBeNull();
    expect(screen.getByLabelText("输入需求").getAttribute("aria-disabled")).toBe("false");
    expect((screen.getByRole("button", { name: "选择工作区" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("选择模型") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "正在准备发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(runtime.workspaces.list).not.toHaveBeenCalled();
    expect(runtime.settings.getSettings).toHaveBeenCalledTimes(1);
    expect(runtime.models.listProviders).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve({
        host: "127.0.0.1",
        port: 9234,
        base_url: "http://127.0.0.1:9234",
        data_dir: "D:/Keydex",
      });
      await deferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    });
    expect(screen.queryByText("正在启动本地服务")).toBeNull();
    expect((screen.getByRole("button", { name: "选择工作区" }) as HTMLButtonElement).disabled).toBe(false);
    expect(runtime.workspaces.list).toHaveBeenCalledTimes(1);
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
    fireEvent.click(screen.getByRole("menuitem", { name: "选择文件夹" }));

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

  it("creates a goal task from the new chat page and forwards the seed turn", async () => {
    const createThreadTask = vi.fn().mockResolvedValue({
      id: "task-1",
      session_id: "ses-1",
      type: "goal",
      type_label: "目标",
      title: null,
      objective: "完成新会话目标",
      status: "active",
      is_open: true,
      is_terminal: false,
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
      deleted_at: null,
      completed_at: null,
      metadata: {},
      evidence: [],
      blocked_audit: {},
      token_usage: {},
      turn_count: 0,
      elapsed_seconds: 0,
      last_run_id: null,
      last_run_status: null,
      last_run_at: null,
    });
    const runtime = fakeRuntime({ model: "qwen-coder", createThreadTask });
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
    enterPrompt("/目标");
    fireEvent.keyDown(screen.getByLabelText("输入需求"), { key: "Enter" });
    expect((await screen.findByTestId("goal-mode-accessory")).textContent).toContain("目标");

    enterPrompt("完成新会话目标");
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(createThreadTask).toHaveBeenCalledWith("ses-1", {
        type: "goal",
        objective: "完成新会话目标",
        metadata: {
          seed_turn_context: {
            schema_version: 1,
            source: "goal_composer",
            message: "完成新会话目标",
            context_items: [],
            runtime_params: {},
            attachments: [],
          },
        },
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
      "完成新会话目标",
      expect.objectContaining({
        contextItems: [
          expect.objectContaining({
            type: "goal",
            label: "目标",
            content: "完成新会话目标",
            source: "goal",
          }),
        ],
        runtimeParams: expect.objectContaining({
          initial_thread_task: {
            task_id: "task-1",
            type: "goal",
            trigger: "task_start",
          },
          message_context_items: [
            expect.objectContaining({
              type: "goal",
              label: "目标",
              content: "完成新会话目标",
              source: "goal",
              metadata: expect.objectContaining({
                kind: "goal",
                objective: "完成新会话目标",
              }),
            }),
          ],
        }),
      }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("goal-mode-accessory")).toBeNull();
    });
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

    expect((await screen.findByRole("alert")).textContent).toBe("请先选择模型");
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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith(
      "ses-1",
      { providerId: "provider-1", model: "qwen-coder" },
      "只聊思路",
    );
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
  });
});

function enterPrompt(value: string) {
  const input = screen.getByLabelText("输入需求");
  input.textContent = value;
  fireEvent.input(input);
}

async function showSelectionToolbar(container: Element, text: string) {
  const selection = mockSelection(container, text);
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    document.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    document.dispatchEvent(new KeyboardEvent("keyup"));
  });
  return selection;
}

function mockSelection(container: Element, text: string) {
  const removeAllRanges = vi.fn();
  const range = textRange(container, text);
  range.getBoundingClientRect = () => ({
    left: 120,
    top: 140,
    right: 220,
    bottom: 160,
    width: 100,
    height: 20,
    x: 120,
    y: 140,
    toJSON: () => ({}),
  });
  const spy = vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges,
  } as unknown as Selection);

  return {
    removeAllRanges,
    restore: () => spy.mockRestore(),
  };
}

function textRange(container: Element, text: string): Range {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] ?? text;
  const lastToken = tokens[tokens.length - 1] ?? text;
  const start = findTextPosition(container, firstToken, null);
  const end = findTextPosition(container, lastToken, start);
  const range = document.createRange();
  if (!start || !end) {
    range.selectNodeContents(container);
    return range;
  }
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + lastToken.length);
  return range;
}

function findTextPosition(
  container: Element,
  token: string,
  after: { node: Text; offset: number } | null,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let afterReached = after === null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const value = node.data;
    let searchFrom = 0;
    if (!afterReached) {
      if (node !== after?.node) {
        continue;
      }
      afterReached = true;
      searchFrom = after.offset;
    }
    const offset = value.indexOf(token, searchFrom);
    if (offset >= 0) {
      return { node, offset };
    }
  }
  return null;
}

function renderHomeInLayout(ui: ReactElement) {
  return render(
    <ThemeProvider>
      <LayoutStateProvider>
        <PreviewProvider>
          <Layout contentMode="full">{ui}</Layout>
        </PreviewProvider>
      </LayoutStateProvider>
    </ThemeProvider>,
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function fakeRuntime({
  model,
  models = model ? [model] : [],
  workspaces = [workspace("ws-1", "keydex")],
  workspaceSearch = vi.fn().mockResolvedValue([]),
  workspaceEntriesByPath = { "": [] },
  workspaceFilesByPath = {},
  canPickDirectory = false,
  pickDirectory = vi.fn().mockResolvedValue(null),
  createThreadTask = vi.fn(),
}: {
  model: string;
  models?: string[];
  workspaces?: Workspace[];
  workspaceSearch?: ReturnType<typeof vi.fn>;
  workspaceEntriesByPath?: Record<string, WorkspaceEntry[]>;
  workspaceFilesByPath?: Record<string, string>;
  canPickDirectory?: boolean;
  pickDirectory?: ReturnType<typeof vi.fn>;
  createThreadTask?: ReturnType<typeof vi.fn>;
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
                models,
                model_enabled: {},
                health: {},
              },
            ]
          : [],
      ),
    },
    workspaces: {
      list: vi.fn().mockResolvedValue({ list: workspaces, total: workspaces.length }),
      create: vi.fn().mockImplementation((payload: { rootPath: string }) =>
        Promise.resolve(workspace("ws-new", payload.rootPath.split(/[\\/]/).pop() || "project", payload.rootPath)),
      ),
    },
    workspace: {
      listSkills: vi.fn().mockResolvedValue({
        workspace_root: "D:/repo",
        fingerprint: "test-fingerprint",
        loaded_at: "2026-06-25T12:00:00Z",
        skills: [],
        diagnostics: [],
      }),
      listDirectory: vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
        const entries = workspaceEntriesByPath[path];
        if (!entries) {
          return Promise.reject(new Error(`目录不存在：${path}`));
        }
        return Promise.resolve({ root: "D:/repo", entries });
      }),
      readFile: vi.fn((_scope: unknown, path: string) => {
        const content = workspaceFilesByPath[path];
        if (content === undefined) {
          return Promise.reject(new Error(`文件不存在：${path}`));
        }
        return Promise.resolve({ path, content, encoding: "utf-8" });
      }),
      readMedia: vi.fn(),
      listAnnotations: vi.fn().mockResolvedValue([]),
      createAnnotation: vi.fn(),
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      search: workspaceSearch,
    },
    desktopPicker: {
      isDirectoryPickerAvailable: vi.fn(() => canPickDirectory),
      pickDirectory,
    },
    conversation: {
      createSession: vi.fn().mockResolvedValue(session),
      createThreadTask,
    },
  } as unknown as RuntimeBridge;
}

function workspaceEntry(
  name: string,
  path: string,
  type: WorkspaceEntry["type"],
  size: number | null = null,
): WorkspaceEntry {
  return {
    name,
    path,
    type,
    size,
    modified_at: null,
  };
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
