import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import type { WorkspaceEntry, WorkspaceTreeResponse } from "@/runtime";
import { Layout } from "@/renderer/components/layout/Layout";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ConversationPage } from "@/renderer/pages/conversation";
import { clearQuickChatSendQueue, queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type {
  AgentActionEnvelope,
  AgentChatMessagePayload,
  AgentHistoryResponse,
  AgentSession,
  CommandApprovalRequest,
  Workspace,
} from "@/types/protocol";

describe("ConversationPage", () => {
  beforeEach(() => {
    clearQuickChatSendQueue();
  });

  it("restores an empty session history with a clear empty state", async () => {
    const { runtime } = fakeRuntime({ history: [] });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("conversation-empty")).textContent).toBe("还没有消息，输入需求开始对话。");
    expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("ses-1", {
      direction: "older",
      pageSize: 5,
    });
    expect(runtime.conversation.openChatChannel).toHaveBeenCalled();
  });

  it("shows history load failures as a top notification instead of an error message card", async () => {
    const { runtime } = fakeRuntime({ historyError: new Error("会话不存在：ses-1") });

    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toContain("会话不存在：ses-1");
    expect(screen.queryByTestId("error-item")).toBeNull();
    expect((await screen.findByTestId("conversation-empty")).textContent).toBe("还没有消息，输入需求开始对话。");
  });

  it("does not show workspace picker in the bottom composer for a project session", async () => {
    const { runtime } = fakeRuntime({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
  });

  it("does not show project-free workspace picker in the bottom composer for a pure chat session", async () => {
    const { runtime } = fakeRuntime();

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
  });

  it("does not expose workspace search when a bound workspace is unavailable", async () => {
    const { runtime } = fakeRuntime({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-missing",
        cwd: "D:/missing",
        workspace_roots: ["D:/missing"],
        workspace: null,
      }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    typeComposer("@README");
    expect(screen.queryByTestId("at-file-menu")).toBeNull();
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });

  it("restores persisted user and assistant messages from session history", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "历史问题"),
        historyMessage("assistant", "历史回答"),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("历史问题")).not.toBeNull();
    expect(await screen.findByText("历史回答")).not.toBeNull();
    expect(screen.queryByTestId("conversation-empty")).toBeNull();
  });

  it("renders command approval as the composer instead of a conversation message", async () => {
    const { runtime, emit } = fakeRuntime();

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    act(() => {
      emit(agentEvent("approval_requested", {
        session_id: "ses-1",
        approval: commandApproval("approval-1"),
      }));
    });

    const dock = screen.getByTestId("conversation-composer");
    expect(within(dock).getByTestId("composer-approval-card")).not.toBeNull();
    expect(within(dock).getByText("是否允许执行命令？")).not.toBeNull();
    expect(screen.getByTestId("message-surface").textContent).not.toContain("是否允许执行命令？");
    expect(screen.getByTestId("message-surface").textContent).not.toContain("pnpm test");
    expect(screen.queryByLabelText("继续输入")).toBeNull();

    fireEvent.click(within(dock).getByRole("button", { name: "是，仅允许本次" }));

    await waitFor(() => {
      expect(screen.queryByTestId("composer-approval-card")).toBeNull();
    });
    expect(await screen.findByLabelText("继续输入")).not.toBeNull();
    expect(runtime.settings.resolveApproval).toHaveBeenCalledWith("approval-1", {
      decision: "approved",
      trust_scope: "once",
    });
  });

  it("restores injected follow context items with user history messages", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "please review", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: "README.md",
              content: "workspace file: README.md",
              role: "HumanMessage",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const message = await screen.findByTestId("message-text");
    expect(message.textContent).toContain("@README.md");
    expect(message.textContent).toContain("please review");
    expect(message.textContent).not.toContain("[[");
  });

  it("opens restored history file context chips in the right sidebar", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      history: [
        historyMessage("user", "please review", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: "README.md",
              content: "workspace file: README.md",
              role: "HumanMessage",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        }),
      ],
      workspaceFilesByPath: {
        "README.md": "# README\n\n历史文件引用内容",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const chip = await screen.findByRole("button", { name: "打开文件引用 README.md" });
    expect(screen.queryByText("workspace file: README.md")).toBeNull();

    fireEvent.click(chip);

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    });
    expect(await screen.findByText("历史文件引用内容", {}, { timeout: 5000 })).not.toBeNull();
    expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "README.md");
  });

  it("shows runtime typing speed above the bottom composer and scrolls to bottom from the dock button", async () => {
    const { runtime } = fakeRuntime({
      history: [historyMessage("assistant", "历史回答")],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("typing-speed-pill")).textContent).toBe("打字机 0 字符/s - 待输出 0 字");
    const scrollButton = screen.getByLabelText("滚动到底") as HTMLButtonElement;
    expect(scrollButton.disabled).toBe(true);

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(scrollButton.disabled).toBe(false);
    });

    fireEvent.click(scrollButton);
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("scrolls back to the bottom when sending after reading older messages", async () => {
    const { runtime } = fakeRuntime({
      history: [historyMessage("assistant", "历史回答")],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });
    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect((screen.getByLabelText("滚动到底") as HTMLButtonElement).disabled).toBe(false);
    });

    typeComposer("继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(scroller.scrollTop).toBe(120);

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("shows active turn file-change totals in the composer accessory", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("生成文件");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await act(async () => {
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        files: [
          {
            path: "docs/project-structure.md",
            operation: "add",
            additions: 149,
            deletions: 0,
          },
        ],
      }));
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress-edit",
        session_id: "ses-1",
        run_id: "run-edit",
        tool_name: "apply_patch",
        files: [
          {
            path: "desktop/src/App.tsx",
            operation: "update",
            additions: 2,
            deletions: 1,
          },
        ],
      }));
    });

    const pill = await screen.findByTestId("file-change-summary-pill");
    expect(pill.textContent).toContain("本轮共创建了 1 个文件，编辑了 1 个文件");
    expect(pill.textContent).toContain("+151");
    expect(pill.textContent).toContain("-1");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();
    expect(screen.getByTestId("file-change-summary-card").textContent).toContain("docs/project-structure.md");
    expect(screen.getByTestId("file-change-summary-card").textContent).toContain("desktop/src/App.tsx");
  });

  it("allows manually switching composer accessory items", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("生成文件");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await act(async () => {
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        files: [
          {
            path: "docs/project-structure.md",
            operation: "add",
            additions: 149,
            deletions: 0,
          },
        ],
      }));
    });

    expect((await screen.findByTestId("file-change-summary-pill")).textContent).toContain("+149");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    expect(screen.getByTestId("composer-accessory-menu")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /打字机/ }));

    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
    expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /文件变更/ }));

    expect(screen.getByTestId("file-change-summary-pill").textContent).toContain("+149");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();
  });

  it("drops active file-change totals when the progressing tool fails", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("生成文件");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await act(async () => {
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        files: [
          {
            path: "docs/broken.md",
            operation: "add",
            additions: 149,
            deletions: 0,
          },
        ],
      }));
    });

    expect((await screen.findByTestId("file-change-summary-pill")).textContent).toContain("+149");

    await act(async () => {
      emit(agentEvent("tool_end", {
        id: "evt-file-end",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        status: "error",
        error: "write failed",
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();
    });
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
  });

  it("keeps completed turn file-change totals until the next user message starts", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "生成文件"),
        historyMessage("tool", "", {
          toolName: "write_file",
          toolParams: { path: "docs/project-structure.md" },
          fileChanges: [
            {
              path: "docs/project-structure.md",
              operation: "add",
              additions: 149,
              deletions: 0,
            },
          ],
          status: "completed",
        }),
        historyMessage("assistant", "完成"),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("file-change-summary-pill");
    expect(pill.textContent).toContain("本轮共创建了 1 个文件");
    expect(pill.textContent).toContain("+149");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();

    typeComposer("继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();
    });
    expect(screen.getByTestId("typing-speed-pill").textContent).toBe("打字机 0 字符/s - 待输出 0 字");
  });

  it("restores persisted update_plan into the composer accessory plan panel", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "梳理计划"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            explanation: "把计划同步到胶囊",
            entries: [
              { content: "分析现有胶囊入口", status: "completed" },
              { content: "实现计划胶囊面板", status: "in_progress" },
              { content: "补充回归测试", status: "pending" },
            ],
          },
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toContain("第 2 / 3 步");
    expect(pill.textContent).toContain("实现计划胶囊面板");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();
    expect(screen.getByTestId("plan-summary-card").textContent).not.toContain("把计划同步到胶囊");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("补充回归测试");

    typeComposer("继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(screen.queryByTestId("plan-summary-pill")).toBeNull();
    });
    expect(screen.getByTestId("typing-speed-pill").textContent).toBe("打字机 0 字符/s - 待输出 0 字");
  });

  it("shows streaming update_plan arguments in the composer accessory plan panel", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await act(async () => {
      emit(agentEvent("tool_start", {
        id: "evt-plan-start",
        session_id: "ses-1",
        run_id: "run-plan",
        tool_name: "update_plan",
        params: {
          plan: [
            { step: "确认计划入口", status: "completed" },
            { step: "渲染胶囊计划", status: "in_progress" },
          ],
        },
      }));
    });

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toContain("第 2 / 2 步");
    expect(pill.textContent).toContain("渲染胶囊计划");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("确认计划入口");
  });

  it("shows failed update_plan steps in the composer accessory plan panel", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "执行计划"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [
              { content: "完成前置分析", status: "completed" },
              { content: "执行集成测试", status: "failed" },
              { content: "整理验收结论", status: "pending" },
            ],
          },
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toContain("第 2 / 3 步");
    expect(pill.textContent).toContain("执行集成测试");
    expect(pill.textContent).toContain("失败");

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    expect(screen.getByRole("menuitemradio", { name: /1\/3 已完成，1 失败/ })).not.toBeNull();
  });

  it("shows a later completed update_plan step over an earlier failed step", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "执行计划"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [
              { content: "完成前置分析", status: "completed" },
              { content: "编写单元测试", status: "failed" },
              { content: "执行集成测试", status: "completed" },
            ],
          },
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toContain("第 3 / 3 步");
    expect(pill.textContent).toContain("执行集成测试");
    expect(pill.textContent).not.toContain("失败");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("编写单元测试");
  });

  it("excludes failed file changes from composer accessory totals", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "生成文件"),
        historyMessage("tool", "", {
          toolName: "write_file",
          toolParams: { path: "docs/broken.md" },
          fileChanges: [
            {
              path: "docs/broken.md",
              operation: "add",
              additions: 149,
              deletions: 0,
            },
          ],
          status: "failed",
          toolError: "write failed",
        }),
        historyMessage("tool", "", {
          toolName: "apply_patch",
          toolParams: { path: "desktop/src/App.tsx" },
          fileChanges: [
            {
              path: "desktop/src/App.tsx",
              operation: "update",
              additions: 2,
              deletions: 1,
            },
          ],
          status: "completed",
        }),
        historyMessage("assistant", "完成"),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("file-change-summary-pill");
    expect(pill.textContent).toContain("+2");
    expect(pill.textContent).toContain("-1");
    expect(pill.textContent).not.toContain("+151");
    expect(screen.getByTestId("file-change-summary-card").textContent).toContain("desktop/src/App.tsx");
    expect(screen.getByTestId("file-change-summary-card").textContent).not.toContain("docs/broken.md");
  });

  it("restores tool history as collapsed tool panels with result details", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("tool", "", {
          toolName: "read_file",
          toolParams: { path: "README.md" },
          toolResult: "文件内容",
          toolDurationMs: 1280,
          status: "completed",
        }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("tool-call-block")).getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具入参").textContent).toContain('"path": "README.md"');
    expect(screen.getByText("文件内容")).not.toBeNull();
  });

  it("restores hidden metadata, error and cancelled states from history", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("assistant", "完成", {
          ghostStats: {
            traceId: "trace-history",
            inputTokens: 10,
            cacheReadTokens: 2,
            outputTokens: 5,
          },
        }),
        historyMessage("error", "模型请求失败"),
        historyMessage("assistant", "已经输出的部分", { cancelled: true }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("完成")).not.toBeNull();
    expect(screen.queryByText("trace-history")).toBeNull();
    expect(screen.queryByText(/^token /)).toBeNull();
    expect(screen.getByText("模型请求失败")).not.toBeNull();
    expect(screen.getByText("已取消")).not.toBeNull();
  });

  it("streams assistant text from websocket events", async () => {
    const { runtime, emit } = fakeRuntime();
    const eventTime = new Date("2026-06-18T12:34:00+08:00").getTime();
    const expectedTime = new Date(eventTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-stream-1",
        session_id: "ses-1",
        content: "来自事件的回答",
        timestamp_ms: eventTime,
      }));
      emit(agentEvent("completed", {
        id: "evt-stream-completed-1",
        session_id: "ses-1",
        status: "completed",
        events: [],
      }));
    });

    expect(await screen.findByText("来自事件的回答")).not.toBeNull();
    expect(screen.getByText(expectedTime)).not.toBeNull();
    expect(screen.queryByText("08:00")).toBeNull();
  });

  it("keeps the pending cursor visible after a tool result until completion", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    await act(async () => {
      emit(agentEvent("stream", { id: "evt-stream-before-tool", session_id: "ses-1", content: "我先读取文件" }));
      emit(agentEvent("tool_start", {
        id: "evt-tool-start",
        session_id: "ses-1",
        run_id: "run-1",
        tool_name: "read_file",
        params: { path: "README.md" },
      }));
      emit(agentEvent("tool_end", {
        id: "evt-tool-end",
        session_id: "ses-1",
        run_id: "run-1",
        result: "文件内容",
        status: "success",
      }));
    });

    expect(await screen.findByText("已读取文件 README.md")).not.toBeNull();
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
    expect(screen.getByLabelText("停止")).not.toBeNull();

    await act(async () => {
      emit(agentEvent("completed", {
        id: "evt-completed-after-tool",
        session_id: "ses-1",
        status: "completed",
        events: [],
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("streaming-cursor")).toBeNull();
    });
    expect(screen.getByLabelText("发送")).not.toBeNull();
  });

  it("prefills composer from an annotation chat request and sends source quote context", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime, channel } = fakeRuntime({ session: projectSession });

    renderConversation(
      <>
        <ConversationPage threadId="ses-1" runtime={runtime} />
        <AnnotationPrefillHarness />
      </>,
    );

    const input = await readyComposer();
    fireEvent.click(await screen.findByRole("button", { name: "触发批注预填" }));

    expect(await screen.findByText("main.ts · L3-L4")).not.toBeNull();
    expect(document.querySelector("[data-quote-index='0']")).not.toBeNull();
    expect(input.textContent?.trim()).toBe("Check this branch");
    expect(input.textContent).not.toContain("文件：");
    expect(input.textContent).not.toContain("引用位置：");
    expect(channel.chat).not.toHaveBeenCalled();

    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    const chatMock = channel.chat as unknown as ReturnType<typeof vi.fn>;
    const payload = chatMock.mock.calls.at(-1)?.[0] as {
      message?: string;
      runtime_params?: { message_injection?: Array<{ role?: string; content?: string; metadata?: Record<string, unknown> }> };
    };
    expect(payload.message).toBe("Check this branch");
    expect(payload.runtime_params?.message_injection).toHaveLength(1);
    expect(payload.runtime_params?.message_injection?.[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "source_quote",
        path: "src/main.ts",
        line_start: 3,
        line_end: 4,
        source_start: 42,
        source_end: 66,
      },
    });
    expect(payload.runtime_params?.message_injection?.[0]?.content).toContain("src/main.ts");
    expect(payload.runtime_params?.message_injection?.[0]?.content).toContain("L3-L4");
    expect(payload.runtime_params?.message_injection?.[0]?.content).toContain("42-66");
    expect(payload.runtime_params?.message_injection?.[0]?.content).toContain("if (enabled)");
    expect(payload.runtime_params?.message_injection?.[0]?.content).not.toContain("Check this branch");
  });

  it("sends the composer text through the bound chat channel", async () => {
    const { runtime, channel } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.getByRole("form", { name: "继续对话输入" }).getAttribute("data-variant")).toBe("keydex");
    expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    fireEvent.click(screen.getByLabelText("选择模型"));
    expect(screen.getByRole("listbox", { name: "模型" }).closest("[data-placement]")?.getAttribute("data-placement")).toBe("top");
    fireEvent.click(screen.getByLabelText("选择模型"));
    typeComposer("继续修改");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(channel.chat).toHaveBeenCalledWith({ session_id: "ses-1", message: "继续修改", model: "qwen-coder" });
    expect(screen.getByLabelText("停止")).not.toBeNull();
    expect(screen.queryByText("智能体正在处理")).toBeNull();
    expect(screen.getByLabelText("继续输入").getAttribute("contenteditable")).toBe("true");
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
    expect(screen.queryByTestId("message-agent-status")).toBeNull();
  });

  it("uses the initial runtime model passed from quick chat", async () => {
    const { runtime, channel } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} initialModel="deepseek-coder" />);

    await readyComposer();
    expect(screen.getByLabelText("选择模型").textContent).toContain("deepseek-coder");
    typeComposer("使用首页模型");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(channel.chat).toHaveBeenCalledWith({
      session_id: "ses-1",
      message: "使用首页模型",
      model: "deepseek-coder",
    });
  });

  it("sends the queued quick chat message after the conversation route is ready", async () => {
    const { runtime, channel } = fakeRuntime();
    const queued = queueQuickChatSend({
      sessionId: "ses-1",
      model: "deepseek-coder",
      message: "从快速对话发送",
    });
    const onQuickSendConsumed = vi.fn();
    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel="deepseek-coder"
        quickSendId={queued.id}
        onQuickSendConsumed={onQuickSendConsumed}
      />,
    );

    await waitFor(() => {
      expect(channel.chat).toHaveBeenCalledWith({
        session_id: "ses-1",
        message: "从快速对话发送",
        model: "deepseek-coder",
      });
    });
    expect(onQuickSendConsumed).toHaveBeenCalledTimes(1);
    expect(screen.getByText("从快速对话发送")).not.toBeNull();
  });

  it("does not resend the queued quick chat message when history already has messages", async () => {
    const { runtime, channel } = fakeRuntime({
      history: [historyMessage("user", "从快速对话发送")],
    });
    const queued = queueQuickChatSend({
      sessionId: "ses-1",
      model: "deepseek-coder",
      message: "从快速对话发送",
    });
    const onQuickSendConsumed = vi.fn();

    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel="deepseek-coder"
        quickSendId={queued.id}
        onQuickSendConsumed={onQuickSendConsumed}
      />,
    );

    expect(await screen.findByText("从快速对话发送")).not.toBeNull();
    await waitFor(() => {
      expect(onQuickSendConsumed).toHaveBeenCalledTimes(1);
    });
    expect(channel.chat).not.toHaveBeenCalled();
  });

  it("does not send when a quick chat route id has no queued user action", async () => {
    const { runtime, channel } = fakeRuntime();
    const onQuickSendConsumed = vi.fn();

    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel="deepseek-coder"
        quickSendId="quick:missing"
        onQuickSendConsumed={onQuickSendConsumed}
      />,
    );

    await waitFor(() => {
      expect(onQuickSendConsumed).toHaveBeenCalledTimes(1);
    });
    expect(channel.chat).not.toHaveBeenCalled();
    expect(screen.getByLabelText("继续输入").textContent).toBe("");
  });

  it("allows sending another message after a channel error", async () => {
    const chat = vi.fn().mockImplementationOnce(() => {
      throw new Error("模型 400");
    });
    const { runtime } = fakeRuntime({ chat });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("第一次");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));
    expect((await screen.findAllByText("模型 400")).length).toBeGreaterThan(0);

    typeComposer("修正后继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenLastCalledWith({ session_id: "ses-1", message: "修正后继续", model: "qwen-coder" });
  });

  it("folds stack trace details out of the ordinary request error UI", async () => {
    const stack = [
      "Traceback (most recent call last):",
      '  File "D:/work/app.py", line 12, in run',
      "ValueError: boom",
    ].join("\n");
    const { runtime } = fakeRuntime({
      chat: vi.fn().mockImplementationOnce(() => {
        throw new Error(stack);
      }),
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("触发错误");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect((await screen.findAllByText("运行失败，详细信息已折叠")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/app\.py/)).toBeNull();
  });

  it("cancels the active websocket turn and returns to send mode after a cancelled event", async () => {
    const { runtime, channel, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", { id: "evt-running-1", session_id: "ses-1", content: "输出中" }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("停止")).not.toBeNull();
    });
    fireEvent.click(screen.getByLabelText("停止"));

    expect(channel.cancel).toHaveBeenCalledWith("ses-1");

    await act(async () => {
      emit(agentEvent("cancelled", { id: "evt-cancel-1", session_id: "ses-1" }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("发送")).not.toBeNull();
    });
    expect(screen.getByText("已取消")).not.toBeNull();
  });

  it("quotes selected assistant text into the composer", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", { id: "evt-stream-quote", session_id: "ses-1", content: "可以引用的回答" }));
    });
    await screen.findByText("可以引用的回答");

    const message = screen.getByTestId("message-text");
    const markdown = message.querySelector(".keydex-markdown");
    if (!markdown) {
      throw new Error("markdown container not found");
    }
    const selection = mockSelection(markdown, "可以引用的回答");
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "添加选中文本到对话" }));

    const input = screen.getByLabelText("继续输入");
    expect(input.textContent).toBe("");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("引用片段");
    vi.useFakeTimers();
    try {
      fireEvent.mouseOver(screen.getByText("引用片段"));
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByRole("button", { name: "复制" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "删除" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("searches project files from the composer through the bound session workspace", async () => {
    const workspaceSearch = vi.fn().mockResolvedValue([
      { path: "README.md", name: "README.md", type: "file" },
    ]);
    const { runtime } = fakeRuntime({
      workspaceSearch,
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@READ");

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    await waitFor(() => {
      expect(workspaceSearch).toHaveBeenCalledWith(
        { sessionId: "ses-1" },
        "READ",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });
    expect(await screen.findByRole("option", { name: /README\.md/ })).not.toBeNull();
  });

  it("loads default project file candidates from the composer at trigger", async () => {
    const { runtime, channel } = fakeRuntime({
      workspaceEntriesByPath: {
        "": [
          workspaceEntry("README.md", "README.md", "file", 128),
          workspaceEntry("src", "src", "directory"),
        ],
      },
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@");

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "");
    });
    fireEvent.mouseDown(await screen.findByRole("option", { name: "选择文件 README.md" }));

    await waitFor(() => {
      expect(screen.getByLabelText("继续输入").textContent).toBe("");
    });
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("README.md");

    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    const chatMock = channel.chat as unknown as ReturnType<typeof vi.fn>;
    const payload = chatMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      session_id: "ses-1",
      message: "",
      model: "qwen-coder",
    });
    const runtimeParams = payload.runtime_params as { message_injection?: Array<Record<string, unknown>> } | undefined;
    expect(runtimeParams?.message_injection).toHaveLength(1);
    expect(runtimeParams?.message_injection?.[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "file",
        path: "README.md",
        fileType: "file",
      },
    });
    expect(runtimeParams?.message_injection?.[0]?.content).toContain("README.md");
    expect(screen.getAllByTestId("message-text")[0].textContent).toContain("@README.md");
  });

  it("opens a selected file reference chip in the right sidebar file preview", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 128)],
      },
      workspaceFilesByPath: {
        "README.md": "# README\n\n来自文件引用胶囊",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@");

    fireEvent.mouseDown(await screen.findByRole("option", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("button", { name: "打开文件引用 README.md" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开文件引用 README.md" }));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    });
    expect(await screen.findByRole("tab", { name: "文件" })).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "README.md");
    });
    expect(await screen.findByText("来自文件引用胶囊")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "折叠右侧栏" }));
    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed");
    });
  });

  it("hides workspace file search inside the pure chat composer", async () => {
    const { runtime } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@README");

    expect(screen.queryByTestId("at-file-menu")).toBeNull();
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });

  it("does not expose a fake workspace or empty preview entry when no panel content exists", async () => {
    const { runtime } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(runtime.workspace.listDirectory).not.toHaveBeenCalled();
  });

  it("opens rich message code blocks in the preview drawer", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-html",
        session_id: "ses-1",
        content: "```html\n<style>h1 { color: rgb(220, 38, 38); }</style><main><h1>面板预览</h1></main>\n```",
      }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "在预览面板打开 HTML 预览" }));

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.rightSidebar).toBe("open");
    expect(shell.dataset.rightSidebarMotion).toBe("true");
    expect(await screen.findByRole("complementary", { name: "右侧栏" })).not.toBeNull();
    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<style>h1 { color: rgb(220, 38, 38); }</style>");
    expect(frame.getAttribute("srcdoc")).toContain("面板预览");
  });

  it("does not carry preview drawer content into another session", async () => {
    const { runtime, emit } = fakeRuntime();
    const view = renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-html-session-a",
        session_id: "ses-1",
        content: "```html\n<main><h1>会话 A 面板</h1></main>\n```",
      }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "在预览面板打开 HTML 预览" }));
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    expect(((await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement).getAttribute("srcdoc")).toContain(
      "会话 A 面板",
    );

    const { runtime: nextRuntime } = fakeRuntime({ session: agentSession({ id: "ses-2", title: "会话 B" }) });
    view.rerender(conversationInLayout(<ConversationPage threadId="ses-2" runtime={nextRuntime} />));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
      expect(screen.queryByTitle("HTML 文件预览")).toBeNull();
      expect(screen.getByText("暂无侧边内容")).not.toBeNull();
    });
  });

  it("opens the current project file tree from the right sidebar initial page", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [
          workspaceEntry("desktop", "desktop", "directory"),
          workspaceEntry("package.json", "package.json", "file", 128),
        ],
        desktop: [workspaceEntry("README.md", "desktop/README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "desktop/README.md": "# 文件预览\n\n侧边栏 Markdown 内容",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));

    expect(await screen.findByTestId("right-sidebar-initial-page")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件" }));

    expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(await screen.findByText("desktop")).not.toBeNull();
    expect(screen.getByText("package.json")).not.toBeNull();
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整文件树宽度" })).toBeNull();
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "");

    fireEvent.click(screen.getByRole("button", { name: "展开 desktop" }));
    expect(await screen.findByText("README.md")).not.toBeNull();
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "desktop");

    fireEvent.click(await screen.findByRole("button", { name: "选择文件 desktop/README.md" }));
    expect(await screen.findByRole("heading", { name: "文件预览" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-tree")).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整文件树宽度" })).not.toBeNull();
    expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "desktop/README.md");

    fireEvent.click(screen.getByRole("button", { name: "新建侧边栏页面" }));
    expect(screen.getByRole("tab", { name: "新tab" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    const fileTabs = screen.getAllByRole("tab", { name: "文件" });
    expect(fileTabs).toHaveLength(2);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["文件", "文件"]);
    expect(fileTabs[0].getAttribute("aria-selected")).toBe("false");
    expect(fileTabs[1].getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "文件预览" })).toBeNull();
    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "关闭侧边栏窗口 文件" })[1]);
    expect(screen.getAllByRole("tab", { name: "文件" })).toHaveLength(1);
    expect(await screen.findByRole("heading", { name: "文件预览" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 文件" }));
    expect(screen.queryByRole("tab", { name: "文件" })).toBeNull();
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed");
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
  });

  it("restores the conversation area after quoting text from a maximized file preview", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 文件预览\n\n侧边栏 Markdown 内容",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));

    expect(await screen.findByText("侧边栏 Markdown 内容")).not.toBeNull();
    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByLabelText("展开右侧栏到对话区域"));
    expect(shell.dataset.rightSidebarMode).toBe("maximized");

    const selection = await showSelectionToolbar(await screen.findByLabelText("预览内容"), "侧边栏 Markdown 内容");
    fireEvent.click(await screen.findByRole("button", { name: "添加选中文本到对话" }));

    expect(shell.dataset.rightSidebarMode).toBe("split");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("README.md");
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("keeps the current tab order when a new tab opens the file page", async () => {
    const projectSession = agentSession({
      id: "ses-1",
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    const addTabButton = await screen.findByRole("button", { name: "新建侧边栏页面" });

    fireEvent.click(addTabButton);
    fireEvent.click(addTabButton);
    fireEvent.click(addTabButton);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["新tab", "新tab", "新tab"]);
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");

    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["新tab", "新tab", "文件"]);
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");
  });

  it("restores the file panel preview when switching back to a session", async () => {
    const sessionA = agentSession({
      id: "ses-a",
      title: "会话 A",
      session_type: "workspace",
      workspace_id: "ws-a",
      workspace: workspace("ws-a", "repo-a", "D:/repo/a"),
      cwd: "D:/repo/a",
    });
    const sessionB = agentSession({
      id: "ses-b",
      title: "会话 B",
      session_type: "workspace",
      workspace_id: "ws-b",
      workspace: workspace("ws-b", "repo-b", "D:/repo/b"),
      cwd: "D:/repo/b",
    });
    const { runtime: runtimeA } = fakeRuntime({
      session: sessionA,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 A 文件\n\nA 内容",
      },
    });
    const { runtime: runtimeB } = fakeRuntime({
      session: sessionB,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 B 文件\n\nB 内容",
      },
    });

    const view = renderConversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-b" runtime={runtimeB} />));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
      expect(screen.queryByRole("heading", { name: "会话 A 文件" })).toBeNull();
      expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
    });

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />));

    expect(await screen.findByRole("tab", { name: "文件" })).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();
  });

  it("keeps file tab preview state isolated between sessions", async () => {
    const sessionA = agentSession({
      id: "ses-a",
      title: "会话 A",
      session_type: "workspace",
      workspace_id: "ws-a",
      workspace: workspace("ws-a", "repo-a", "D:/repo/a"),
      cwd: "D:/repo/a",
    });
    const sessionB = agentSession({
      id: "ses-b",
      title: "会话 B",
      session_type: "workspace",
      workspace_id: "ws-b",
      workspace: workspace("ws-b", "repo-b", "D:/repo/b"),
      cwd: "D:/repo/b",
    });
    const { runtime: runtimeA } = fakeRuntime({
      session: sessionA,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 A 文件\n\nA 内容",
      },
    });
    const { runtime: runtimeB } = fakeRuntime({
      session: sessionB,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 B 文件\n\nB 内容",
      },
    });

    const view = renderConversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-b" runtime={runtimeB} />));

    await waitFor(() => {
      expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
      expect(screen.queryByRole("heading", { name: "会话 A 文件" })).toBeNull();
    });
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(runtimeB.workspace.readFile).not.toHaveBeenCalled();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />));

    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-b" runtime={runtimeB} />));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByRole("heading", { name: "会话 A 文件" })).toBeNull();
      expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    });
    expect(runtimeB.workspace.readFile).not.toHaveBeenCalled();
  });
});

function renderConversation(ui: ReactElement) {
  return render(<PreviewProvider>{ui}</PreviewProvider>);
}

function renderConversationWithNotifications(ui: ReactElement) {
  return render(
    <NotificationProvider>
      <PreviewProvider>{ui}</PreviewProvider>
    </NotificationProvider>,
  );
}

function renderConversationInLayout(ui: ReactElement) {
  return render(conversationInLayout(ui));
}

function conversationInLayout(ui: ReactElement) {
  return (
    <ThemeProvider>
      <LayoutStateProvider>
        <PreviewProvider>
          <Layout contentMode="full">{ui}</Layout>
        </PreviewProvider>
      </LayoutStateProvider>
    </ThemeProvider>
  );
}

function AnnotationPrefillHarness() {
  const preview = usePreview();
  return (
    <button
      type="button"
      onClick={() =>
        preview.hostContext?.onStartChatFromAnnotation?.({
          path: "src/main.ts",
          selectedText: "if (enabled) {\n  run();\n}",
          lineStart: 3,
          lineEnd: 4,
          sourceStart: 42,
          sourceEnd: 66,
          comment: "Check this branch",
        })
      }
    >
      触发批注预填
    </button>
  );
}

async function readyComposer() {
  return screen.findByLabelText("继续输入");
}

function typeComposer(value: string) {
  const input = screen.getByLabelText("继续输入");
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

async function waitSendEnabled() {
  await waitFor(() => {
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(false);
  });
}

function fakeRuntime({
  history = [],
  session = agentSession(),
  chat = vi.fn(),
  cancel = vi.fn(),
  workspaceSearch = vi.fn().mockResolvedValue([]),
  workspaceEntriesByPath = { "": [] },
  workspaceFilesByPath = {},
  wsStatus = "open",
  model = "qwen-coder",
  historyError,
}: {
  history?: AgentChatMessagePayload[];
  session?: AgentSession;
  chat?: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
  workspaceSearch?: ReturnType<typeof vi.fn>;
  workspaceEntriesByPath?: Record<string, WorkspaceEntry[]>;
  workspaceFilesByPath?: Record<string, string>;
  wsStatus?: WsConnectionStatus;
  model?: string;
  historyError?: Error;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => wsStatus),
    getSessionId: vi.fn(() => session.id),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat,
    approvalDecision: vi.fn(),
    cancel,
    requestStatus: vi.fn(),
    ping: vi.fn(),
  };
  const runtime = {
    conversation: {
      loadHistory: historyError
        ? vi.fn().mockRejectedValue(historyError)
        : vi.fn().mockResolvedValue(historyResponse(session, history)),
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
          model,
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
        appearance: { font_family: "system" },
        command: {
          command_enabled: true,
          require_approval_for_untrusted: true,
          allow_persistent_trust: true,
          default_timeout_seconds: 120,
          max_timeout_seconds: 600,
          max_output_chars: 65536,
        },
      }),
      resolveApproval: vi.fn((approvalId: string) =>
        Promise.resolve({
          ...commandApproval(approvalId),
          status: "approved",
          decision: "approved",
          trust_scope: "once",
          resolved_at: "2026-06-17T10:00:03Z",
        }),
      ),
    },
    models: {
      listModels: vi.fn().mockResolvedValue({ models: model ? [{ id: model }] : [], cached: true }),
    },
    workspace: {
      listDirectory: vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
        const entries = workspaceEntriesByPath[path];
        if (!entries) {
          return Promise.reject(new Error(`目录不存在：${path}`));
        }
        return Promise.resolve({ root: "D:/repo", entries });
      }),
      readFile: vi.fn((_scope: unknown, path: string) =>
        Promise.resolve({ path, content: workspaceFilesByPath[path] ?? "", encoding: "utf-8" }),
      ),
      readMedia: vi.fn(),
      search: workspaceSearch,
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

function historyResponse(session: AgentSession, list: AgentChatMessagePayload[]): AgentHistoryResponse {
  return {
    list,
    total: list.length,
    page: 1,
    page_size: 50,
    session,
    event_total: list.length,
    turn_indexes: list.length ? [1] : [],
  };
}

function historyMessage(
  role: AgentChatMessagePayload["role"],
  content: string,
  patch: Partial<AgentChatMessagePayload> = {},
): AgentChatMessagePayload {
  return {
    role,
    content,
    ...patch,
  } as AgentChatMessagePayload;
}

function agentSession(patch: Partial<AgentSession> = {}): AgentSession {
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
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
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

function agentEvent(action: AgentActionEnvelope["action"], data: Record<string, unknown>): AgentActionEnvelope {
  return { action, data } as AgentActionEnvelope;
}

function commandApproval(id: string): CommandApprovalRequest {
  return {
    id,
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
    details: {
      command: "pnpm test",
      cwd: "D:/repo",
      suggested_exact_rule: "pnpm test",
      suggested_prefix_rule: "pnpm",
    },
    status: "pending",
    created_at: "2026-06-17T10:00:02Z",
    resolved_at: null,
  };
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
  const range = {
    commonAncestorContainer: container,
    getBoundingClientRect: () => ({
      left: 120,
      top: 140,
      right: 220,
      bottom: 160,
      width: 100,
      height: 20,
      x: 120,
      y: 140,
      toJSON: () => ({}),
    }),
  };
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

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: metrics.scrollTop });
}
