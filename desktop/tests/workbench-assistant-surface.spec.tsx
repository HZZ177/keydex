import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, WorkspaceSkillSummary } from "@/runtime";
import { selectedQuoteFromText } from "@/renderer/components/chat/SendBox";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { WorkbenchAssistantSurface } from "@/renderer/pages/workbench/WorkbenchAssistantSurface";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type { AgentChatMessage, AgentSession, CommandApprovalRequest, Workspace } from "@/types/protocol";

import { mockReducedMotionPreference } from "./helpers/motionPreference";

describe("WorkbenchAssistantSurface", () => {
  it("keeps a stable assistant shell while switching surface modes", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const shell = screen.getByTestId("workbench-assistant-shell");
    const chrome = screen.getByTestId("workbench-assistant-chrome");
    expect(shell.getAttribute("data-shell-mode")).toBe("capsule");
    expect(chrome.getAttribute("data-shell-mode")).toBe("capsule");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
      expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
      expect(shell.getAttribute("data-shell-mode")).toBe("composer");
      expect(chrome.getAttribute("data-shell-mode")).toBe("composer");
    });

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
    expect(shell.getAttribute("data-shell-mode")).toBe("dock-morph");
    expect(chrome.getAttribute("data-shell-mode")).toBe("dock-morph");
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();

    await waitForSurfaceMode("drawer");
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
    expect(shell.getAttribute("data-shell-mode")).toBe("drawer");
    expect(chrome.getAttribute("data-shell-mode")).toBe("drawer");
  });

  it("keeps the same chrome while undocking from the drawer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ draft: "继续修改 README" })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const shell = screen.getByTestId("workbench-assistant-shell");
    const chrome = screen.getByTestId("workbench-assistant-chrome");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-morph");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-in");
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-header")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle")).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-morph-loading")).toBeNull();
    expect(screen.getByTestId("conversation-panel")).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("继续修改 README");
    await waitForSurfaceMode("drawer");
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));

    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("composer");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-out");
    expect(shell.getAttribute("data-transition-phase")).toBe("dock-out");
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-morph-loading")).toBeNull();
    expect(screen.getByTestId("conversation-panel")).not.toBeNull();
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("继续修改 README");

    await waitForDockTransitionIdle();
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
  });

  it("keeps composer content mounted while shrinking to a collapsed capsule target", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收回工作台助手为胶囊" }));

    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("capsule");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-out");
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-compose-open")).toBe("true");
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-compose-collapsing")).toBe("true");
    expect(screen.getByLabelText("工作台助手输入")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "展开工作台输入框" })).toBeNull();

    await waitForDockTransitionIdle();
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-compose-open")).toBe("false");
  });

  it("uses a lightweight drawer header instead of the full Agent chat layout header", async () => {
    const stop = vi.fn();
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ runtimeState: "running" as ConversationRuntimeState, canStop: true, stop })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    const header = await screen.findByTestId("workbench-assistant-drawer-header");
    expect(header.textContent).toContain("助手");
    expect(header.textContent).toContain("运行中");
    expect(screen.getByRole("button", { name: "关闭工作台助手侧栏" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chat-layout")).toBeNull();
    expect(screen.queryByRole("button", { name: "更多对话操作" })).toBeNull();
  });

  it("opens a visible approval surface and submits the explicit approval decision", async () => {
    const submitApproval = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "waiting_approval" as ConversationRuntimeState,
            pendingApproval: approvalRequest(),
            submitApproval,
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    await waitForSurfaceMode("drawer");
    expect(await screen.findByTestId("workbench-approval-prompt")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-drawer-header").textContent).toContain("等待审批");

    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() => {
      expect(submitApproval).toHaveBeenCalledWith({ decision: "approved", trust_scope: "once" });
    });
  });

  it("renders drawer messages with the shared compact ConversationPanel", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({ id: "user-1", role: "user", content: "解释 README" }),
              agentMessage({ id: "assistant-1", role: "assistant", content: "我会先读取 README。" }),
              agentMessage({
                id: "tool-1",
                role: "tool",
                toolName: "workspace_search",
                toolResult: "README.md",
                status: "completed",
              }),
              agentMessage({
                id: "file-1",
                role: "tool",
                toolName: "apply_patch",
                fileChanges: [{ path: "README.md", operation: "modify" }],
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    expect(await screen.findByText("解释 README")).not.toBeNull();
    expect(screen.getByText("我会先读取 README。")).not.toBeNull();
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("compact");
    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("compact");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("file-change-block")).not.toBeNull();
  });

  it("renders the expanded overlay as an overlay conversation panel without docking", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({ id: "assistant-1", role: "assistant", content: "覆盖层消息" }),
              agentMessage({
                id: "tool-1",
                role: "tool",
                toolName: "workspace_search",
                toolResult: "docs/guide.md",
                status: "completed",
              }),
              agentMessage({
                id: "file-1",
                role: "tool",
                toolName: "apply_patch",
                fileChanges: [{ path: "docs/guide.md", operation: "modify" }],
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await screen.findByLabelText("工作台助手输入");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));

    expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    const chrome = screen.getByTestId("workbench-assistant-chrome");
    const expandedLayer = screen.getByTestId("workbench-expanded-layer");
    expect(chrome.getAttribute("data-shell-mode")).toBe("composer");
    expect(chrome.contains(expandedLayer)).toBe(false);
    expect(screen.getByTestId("workbench-expanded-panel-frame")).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起工作台消息层" }).closest("form")).toBeNull();
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("overlay");
    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("overlay");
    expect(screen.getByText("覆盖层消息")).not.toBeNull();
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("file-change-block")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-capsule")).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起工作台消息层" })).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
  });

  it("closes the expanded overlay from backdrop and Escape without collapsing a draft composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="保留展开层草稿" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const input = await screen.findByRole("textbox", { name: "工作台助手输入" });
    expect(input.textContent).toContain("保留展开层草稿");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.getByRole("button", { name: "收起工作台消息层" })).not.toBeNull();

    fireEvent.click(screen.getByTestId("workbench-expanded-panel-frame"));
    expect(surface.getAttribute("data-surface-mode")).toBe("expanded");

    fireEvent.click(screen.getByTestId("workbench-expanded-layer"));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).textContent).toContain("保留展开层草稿");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).textContent).toContain("保留展开层草稿");
  });

  it("closes the expanded overlay and empty composer from backdrop and Escape", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await screen.findByRole("textbox", { name: "工作台助手输入" });

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });

    fireEvent.click(screen.getByTestId("workbench-expanded-layer"));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    await waitFor(
      () => {
        expect(screen.queryByRole("textbox", { name: "工作台助手输入" })).toBeNull();
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await screen.findByRole("textbox", { name: "工作台助手输入" });
    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    await waitFor(
      () => {
        expect(screen.queryByRole("textbox", { name: "工作台助手输入" })).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it("opens the composer when an external quote chip is injected", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchQuoteInjectionHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "注入引用片段" }));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(await screen.findByLabelText("工作台助手输入")).not.toBeNull();
    expect(await screen.findByText("guide.md · L3")).not.toBeNull();
  });

  it("resets temporary shell state on session switch without replaying old context requests", async () => {
    const quote = selectedQuoteFromText("旧会话引用", {
      source: "annotation",
      file: {
        path: "docs/old.md",
        name: "old.md",
        lineStart: 2,
        lineEnd: 2,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const quoteChipRequest = { requestId: 5, quote };
    const view = render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ session: session("ses-1"), quoteChipRequest })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    view.rerender(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ session: session("ses-2"), quoteChipRequest })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-surface-mode")).toBe("capsule");
    });
    expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-dock-transition")).toBe("idle");
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();
    expect(screen.queryByText("old.md · L2")).toBeNull();
  });

  it("renders the collapsed capsule as chrome content instead of a separate shell", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const chrome = screen.getByTestId("workbench-assistant-chrome");
    const capsule = screen.getByTestId("workbench-assistant-capsule");
    expect(chrome.contains(capsule)).toBe(true);
    expect(chrome.getAttribute("data-shell-mode")).toBe("capsule");
    expect(capsule.getAttribute("data-compose-open")).toBe("false");
    expect(screen.getByText("要求后续变更")).not.toBeNull();
    expect(screen.getByRole("button", { name: "将工作台助手展开到右侧" })).not.toBeNull();
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();
  });

  it("collapses an empty composer on outside click but keeps a draft open", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    const emptyInput = await screen.findByLabelText("工作台助手输入");
    fireEvent.pointerDown(screen.getByTestId("outside-workspace"));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    expect(emptyInput.isConnected).toBe(true);
    await waitFor(
      () => {
        expect(emptyInput.isConnected).toBe(false);
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    const draftInput = await screen.findByLabelText("工作台助手输入");
    draftInput.textContent = "保留这个工作台草稿";
    fireEvent.input(draftInput);
    fireEvent.pointerDown(screen.getByTestId("outside-workspace"));

    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("保留这个工作台草稿");
  });

  it("keeps accessible controls and does not close a draft composer on Escape", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="不要被 Esc 关闭" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const input = await screen.findByRole("textbox", { name: "工作台助手输入" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(screen.getByRole("button", { name: "展开工作台消息层" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "展开工作台消息层" }).closest("form")).toBeNull();
    expect(screen.getByRole("button", { name: "将工作台助手展开到右侧" })).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).textContent).toContain("不要被 Esc 关闭");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(await screen.findByRole("button", { name: "关闭工作台助手侧栏" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
  });

  it("keeps draft text and input focus across composer, drawer and undock modes", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="跨形态保留的草稿" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const composerInput = await screen.findByLabelText("工作台助手输入");
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
      expect(document.activeElement).toBe(composerInput);
    });
    expect(composerInput.textContent).toContain("跨形态保留的草稿");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    const drawerInput = screen.getByLabelText("工作台助手输入");
    expect(drawerInput.textContent).toContain("跨形态保留的草稿");
    await waitFor(() => {
      expect(document.activeElement).toBe(drawerInput);
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("composer");
    await waitForSurfaceMode("composer");
    const undockedInput = screen.getByLabelText("工作台助手输入");
    expect(undockedInput.textContent).toContain("跨形态保留的草稿");
    await waitFor(() => {
      expect(document.activeElement).toBe(undockedInput);
    });
  });

  it("keeps file, quote, skill and model context across composer, drawer and undock modes", async () => {
    const quote = selectedQuoteFromText("引用文件里的片段", {
      source: "annotation",
      file: {
        path: "docs/guide.md",
        name: "guide.md",
        lineStart: 7,
        lineEnd: 7,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const skill = workspaceSkill();
    const runtime = fakeRuntime({ skills: [skill] });

    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={runtime}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            selectedSkill: skill,
            fileChipRequest: {
              requestId: 1,
              file: {
                path: "src/main.ts",
                name: "main.ts",
                type: "file",
                source: "workspace",
              },
            },
            quoteChipRequest: { requestId: 1, quote },
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await waitFor(() => {
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L7");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
      expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");
    });

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L7");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
    expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("capsule");
    await waitForSurfaceMode("capsule");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await waitFor(() => {
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L7");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
      expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");
    });
  });

  it("skips dock transition waits when reduced motion is preferred", async () => {
    const restoreMotionPreference = mockReducedMotionPreference(true);
    const onDockTransitionChange = vi.fn();
    try {
      render(
        <WorkbenchSurfaceTestProviders>
          <WorkbenchAssistantSurface
            runtime={fakeRuntime()}
            workspaceId="ws-1"
            workspace={workspace()}
            controller={fakeController()}
            onDockTransitionChange={onDockTransitionChange}
          />
        </WorkbenchSurfaceTestProviders>,
      );

      const surface = screen.getByTestId("workbench-assistant-surface");
      fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));

      await waitFor(() => {
        expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
      });
      expect(surface.getAttribute("data-dock-layout")).toBe("inline");
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
      expect(screen.getByTestId("workbench-assistant-shell").getAttribute("data-transition-phase")).toBe("idle");
      expect(onDockTransitionChange).not.toHaveBeenCalledWith(true);

      fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));

      await waitFor(() => {
        expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
      });
      expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
      expect(screen.getByTestId("workbench-assistant-shell").getAttribute("data-transition-phase")).toBe("idle");
      expect(onDockTransitionChange).not.toHaveBeenCalledWith(true);
    } finally {
      restoreMotionPreference();
    }
  });

  it("renders shared plan accessory data from Agent messages", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({
                id: "plan-1",
                role: "tool",
                toolName: "update_plan",
                uiPayload: {
                  entries: [{ content: "复用主对话面板", status: "completed" }],
                },
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    expect(await screen.findByTestId("plan-summary-pill")).not.toBeNull();
    expect(screen.getByText(/第 1 \/ 1 步 · 复用主对话面板/)).not.toBeNull();
  });

  it("renders shared file-change accessory data from Agent messages", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({
                id: "file-1",
                role: "tool",
                toolName: "apply_patch",
                fileChanges: [{ path: "README.md", operation: "modify" }],
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    expect(await screen.findByTestId("file-change-summary-pill")).not.toBeNull();
    expect(screen.getByText(/编辑了 1 个文件/)).not.toBeNull();
  });
});

async function waitForSurfaceMode(mode: string) {
  await waitFor(
    () => {
      expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-surface-mode")).toBe(mode);
    },
    { timeout: 2000 },
  );
}

async function waitForDockTransitionIdle() {
  await waitFor(
    () => {
      expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-dock-transition")).toBe("idle");
    },
    { timeout: 2000 },
  );
}

function WorkbenchSurfaceTestProviders({ children }: PropsWithChildren) {
  return (
    <NotificationProvider>
      <PreviewProvider>
        <LayoutStateProvider>{children}</LayoutStateProvider>
      </PreviewProvider>
    </NotificationProvider>
  );
}

function WorkbenchQuoteInjectionHarness() {
  const [quoteChipRequest, setQuoteChipRequest] = useState<AgentSessionController["quoteChipRequest"]>(null);
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ quoteChipRequest });
  const quote = selectedQuoteFromText("Target text", {
    source: "annotation",
    annotationComment: "Explain this paragraph",
    file: {
      path: "docs/guide.md",
      name: "guide.md",
      lineStart: 3,
      lineEnd: 3,
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!quote) {
            return;
          }
          setQuoteChipRequest((current) => ({
            requestId: (current?.requestId ?? 0) + 1,
            quote,
          }));
        }}
      >
        注入引用片段
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
      />
    </>
  );
}

function WorkbenchDraftHarness({ initialDraft = "" }: { initialDraft?: string }) {
  const [draft, setDraft] = useState(initialDraft);
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ draft, setDraft });

  return (
    <>
      <button type="button" data-testid="outside-workspace">
        workspace
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
      />
    </>
  );
}

function fakeController(overrides: Partial<AgentSessionController> = {}): AgentSessionController {
  return {
    state: {},
    dispatch: vi.fn(),
    session: session(),
    sessionViewState: null,
    agentMessages: [],
    runtimeState: "idle" as ConversationRuntimeState,
    pendingApproval: null,
    draft: "",
    setDraft: vi.fn(),
    selectedSkill: null,
    setSelectedSkill: vi.fn(),
    fileChipRequest: null,
    quoteChipRequest: null,
    loading: false,
    loadingOlderHistory: false,
    wsStatus: "open",
    runtimeDetail: null,
    setRuntimeDetail: vi.fn(),
    connectionReady: true,
    canSend: true,
    canStop: false,
    usingSharedRuntime: false,
    quoteSelection: vi.fn(),
    startChatFromAnnotation: vi.fn(),
    loadOlderHistory: vi.fn(),
    sendText: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    submitApproval: vi.fn(),
    approvalSubmitting: false,
    approvalError: null,
    ...overrides,
  } as unknown as AgentSessionController;
}

function agentMessage(overrides: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return {
    id: "message-1",
    sessionId: "ses-1",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  } as AgentChatMessage;
}

function approvalRequest(): CommandApprovalRequest {
  return {
    id: "approval-1",
    session_id: "ses-1",
    thread_id: "ses-1",
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-command",
    run_id: "run-command",
    tool_name: "run_command",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "请求执行命令。",
    details: { command: "pnpm test", cwd: "D:/repo" },
    status: "pending",
    created_at: "2026-06-25T12:00:01Z",
    resolved_at: null,
  };
}

function fakeRuntime({ skills = [] }: { skills?: WorkspaceSkillSummary[] } = {}): RuntimeBridge {
  return {
    settings: {
      getSettings: () =>
        Promise.resolve({
          model: {
            base_url: "https://api.example/v1",
            model: "qwen-coder",
            timeout_seconds: 60,
            api_key_set: true,
            api_key_preview: "sk-***",
          },
        }),
    },
    models: {
      listModels: () => Promise.resolve({ models: [{ id: "qwen-coder" }], cached: true }),
    },
    workspace: {
      listSkills: () =>
        Promise.resolve({
          workspace_root: "D:/repo/keydex",
          skills,
          diagnostics: [],
          fingerprint: "empty",
          loaded_at: "2026-06-26T00:00:00Z",
        }),
      search: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue({ root: "", entries: [] }),
    },
  } as unknown as RuntimeBridge;
}

function workspaceSkill(): WorkspaceSkillSummary {
  return {
    name: "dev-plan",
    label: "/dev-plan",
    description: "Plan work from a design doc",
    source: "workspace",
    locator: ".keydex/skills/dev-plan/SKILL.md",
  };
}

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "keydex",
    root_path: "D:/repo/keydex",
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
  } as Workspace;
}

function session(id = "ses-1"): AgentSession {
  return {
    id,
    title: "Workbench",
    session_type: "workspace",
    workspace_id: "ws-1",
    workspace: workspace(),
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
  } as AgentSession;
}
