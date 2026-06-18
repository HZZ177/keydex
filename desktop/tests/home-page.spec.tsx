import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { HomePage } from "@/renderer/pages/home";
import type { AgentSession, ModelInfo } from "@/types/protocol";

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
      expect((screen.getByLabelText("选择模型") as HTMLSelectElement).value).toBe("qwen-coder");
    });
    fireEvent.change(screen.getByLabelText("输入需求"), { target: { value: "实现一个新功能" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "实现一个新功能",
        session_tag: "chat",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith("ses-1", "qwen-coder", "实现一个新功能");
    expect(onOpenModelSettings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("工作目录")).toBeNull();
    expect(screen.queryByLabelText("当前工作区")).toBeNull();
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByLabelText("自定义模型配置")).toBeNull();
    expect(screen.queryByRole("group", { name: "权限模式" })).toBeNull();
    expect(screen.queryByText("按需审批")).toBeNull();
    expect(screen.queryByText("本地模式")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开模型设置" })).toBeNull();
  });

  it("keeps model selection available without exposing inactive workspace controls", async () => {
    const runtime = fakeRuntime({
      model: "qwen-coder",
      models: [{ id: "qwen-coder" }, { id: "deepseek-coder" }],
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
      expect((screen.getByLabelText("选择模型") as HTMLSelectElement).value).toBe("qwen-coder");
    });

    fireEvent.change(screen.getByLabelText("选择模型"), { target: { value: "deepseek-coder" } });
    fireEvent.change(screen.getByLabelText("输入需求"), { target: { value: "读取仓库结构" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "读取仓库结构",
        session_tag: "chat",
      });
    });
    expect(onNavigateToConversation).toHaveBeenCalledWith("ses-1", "deepseek-coder", "读取仓库结构");
    expect(screen.queryByLabelText("当前工作区")).toBeNull();
    expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
    expect(screen.queryByRole("button", { name: "完全访问" })).toBeNull();
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
      expect((screen.getByLabelText("选择模型") as HTMLSelectElement).value).toBe("qwen-coder");
    });
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
  });

  it("opens model settings and shows an error when no model is configured", async () => {
    const runtime = fakeRuntime({ model: "" });
    const onOpenModelSettings = vi.fn();

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    await screen.findByRole("button", { name: "打开模型设置" });
    fireEvent.change(screen.getByLabelText("输入需求"), { target: { value: "开始对话" } });
    fireEvent.click(screen.getByLabelText("发送"));

    expect((await screen.findByRole("alert")).textContent).toBe("请先在设置中选择模型");
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "打开模型设置" })).not.toBeNull();
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
  });

  it("does not expose workspace or file interaction affordances on the quick chat page", async () => {
    const runtime = fakeRuntime({ model: "qwen-coder" });

    render(
      <HomePage
        runtime={runtime}
        onNavigateToConversation={vi.fn()}
        onOpenModelSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByLabelText("工作目录")).toBeNull();
      expect(screen.queryByLabelText("当前工作区")).toBeNull();
      expect(screen.queryByLabelText("快速对话上下文")).toBeNull();
      expect(screen.queryByLabelText("自定义模型配置")).toBeNull();
      expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
      expect(screen.queryByRole("group", { name: "权限模式" })).toBeNull();
    });
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
  });
});

function fakeRuntime({
  model,
  models = model ? [{ id: model }] : [],
}: {
  model: string;
  models?: ModelInfo[];
}): RuntimeBridge {
  const session: AgentSession = {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "实现一个新功能",
    session_tag: "chat",
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
    conversation: {
      createSession: vi.fn().mockResolvedValue(session),
    },
  } as unknown as RuntimeBridge;
}
