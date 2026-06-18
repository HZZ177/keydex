import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { ConversationPage } from "@/renderer/pages/conversation";
import { clearQuickChatSendQueue, queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import type {
  AgentActionEnvelope,
  AgentChatMessagePayload,
  AgentHistoryResponse,
  AgentSession,
} from "@/types/protocol";

describe("ConversationPage", () => {
  beforeEach(() => {
    clearQuickChatSendQueue();
  });

  it("restores an empty session history with a clear empty state", async () => {
    const { runtime } = fakeRuntime({ history: [] });

    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("conversation-empty")).textContent).toBe("还没有消息，输入需求开始对话。");
    expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("ses-1", { order: "asc" });
    expect(runtime.conversation.openChatChannel).toHaveBeenCalled();
  });

  it("restores persisted user and assistant messages from session history", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "历史问题"),
        historyMessage("assistant", "历史回答"),
      ],
    });

    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("历史问题")).not.toBeNull();
    expect(await screen.findByText("历史回答")).not.toBeNull();
    expect(screen.queryByTestId("conversation-empty")).toBeNull();
  });

  it("shows runtime typing speed above the bottom composer and scrolls to bottom from the dock button", async () => {
    const { runtime } = fakeRuntime({
      history: [historyMessage("assistant", "历史回答")],
    });
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

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

    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("tool-call-block")).getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具参数").textContent).toContain('"path": "README.md"');
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

    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("完成")).not.toBeNull();
    expect(screen.queryByText("trace-history")).toBeNull();
    expect(screen.queryByText(/^token /)).toBeNull();
    expect(screen.getByText("模型请求失败")).not.toBeNull();
    expect(screen.getByText("已中断")).not.toBeNull();
  });

  it("streams assistant text from websocket events", async () => {
    const { runtime, emit } = fakeRuntime();
    const eventTime = new Date("2026-06-18T12:34:00+08:00").getTime();
    const expectedTime = new Date(eventTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

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
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

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

  it("sends the composer text through the bound chat channel", async () => {
    const { runtime, channel } = fakeRuntime();
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.getByRole("form", { name: "继续对话输入" }).getAttribute("data-variant")).toBe("codex");
    expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    fireEvent.click(screen.getByLabelText("选择模型"));
    expect(screen.getByRole("listbox", { name: "模型" }).closest("[data-placement]")?.getAttribute("data-placement")).toBe("top");
    fireEvent.click(screen.getByLabelText("选择模型"));
    fireEvent.change(screen.getByLabelText("继续输入"), { target: { value: "继续修改" } });
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(channel.chat).toHaveBeenCalledWith({ session_id: "ses-1", message: "继续修改", model: "qwen-coder" });
    expect(screen.getByLabelText("停止")).not.toBeNull();
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
    expect(screen.queryByTestId("message-agent-status")).toBeNull();
  });

  it("uses the initial runtime model passed from quick chat", async () => {
    const { runtime, channel } = fakeRuntime();
    render(<ConversationPage threadId="ses-1" runtime={runtime} initialModel="deepseek-coder" />);

    await readyComposer();
    expect(screen.getByLabelText("选择模型").textContent).toContain("deepseek-coder");
    fireEvent.change(screen.getByLabelText("继续输入"), { target: { value: "使用首页模型" } });
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
    render(
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

    render(
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

    render(
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
    expect((screen.getByLabelText("继续输入") as HTMLTextAreaElement).value).toBe("");
  });

  it("allows sending another message after a channel error", async () => {
    const chat = vi.fn().mockImplementationOnce(() => {
      throw new Error("模型 400");
    });
    const { runtime } = fakeRuntime({ chat });
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    fireEvent.change(screen.getByLabelText("继续输入"), { target: { value: "第一次" } });
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));
    expect((await screen.findAllByText("模型 400")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("继续输入"), { target: { value: "修正后继续" } });
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
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    fireEvent.change(screen.getByLabelText("继续输入"), { target: { value: "触发错误" } });
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect((await screen.findAllByText("运行失败，详细信息已折叠")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/app\.py/)).toBeNull();
  });

  it("cancels the active websocket turn and returns to send mode after a cancelled event", async () => {
    const { runtime, channel, emit } = fakeRuntime();
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

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
    expect(screen.getByText("已中断")).not.toBeNull();
  });

  it("quotes selected assistant text into the composer", async () => {
    const { runtime, emit } = fakeRuntime();
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", { id: "evt-stream-quote", session_id: "ses-1", content: "可以引用的回答" }));
    });
    await screen.findByText("可以引用的回答");

    const message = screen.getByTestId("message-text");
    const markdown = message.querySelector(".codex-markdown");
    if (!markdown) {
      throw new Error("markdown container not found");
    }
    const selection = mockSelection(markdown, "可以引用的回答");
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "添加选中文本到对话" }));

    expect((screen.getByLabelText("继续输入") as HTMLTextAreaElement).value).toBe("> 可以引用的回答");
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("does not expose unimplemented file selection inside the composer", async () => {
    const { runtime } = fakeRuntime();
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.change(screen.getByLabelText("继续输入"), { target: { value: "@README" } });

    expect(screen.queryByTestId("at-file-menu")).toBeNull();
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });

  it("does not expose a fake workspace or empty preview entry when no panel content exists", async () => {
    const { runtime } = fakeRuntime();
    render(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    expect(screen.queryByLabelText("打开工作区")).toBeNull();
    expect(screen.queryByLabelText("打开预览")).toBeNull();
    expect(screen.queryByText("工作区尚未加载")).toBeNull();
    expect(screen.queryByText("文件预览和 diff 会按需显示在这里。")).toBeNull();
    expect(runtime.workspace.listDirectory).not.toHaveBeenCalled();
  });

  it("opens rich message code blocks in the preview drawer", async () => {
    const { runtime, emit } = fakeRuntime();
    render(
      <PreviewProvider>
        <ConversationPage threadId="ses-1" runtime={runtime} />
      </PreviewProvider>,
    );

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-html",
        session_id: "ses-1",
        content: "```html\n<main><h1>面板预览</h1></main>\n```",
      }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "在预览面板打开 HTML 预览" }));

    expect(await screen.findByRole("complementary", { name: "预览" })).not.toBeNull();
    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("面板预览");
  });
});

async function readyComposer() {
  return screen.findByLabelText("继续输入");
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
  wsStatus = "open",
  model = "qwen-coder",
}: {
  history?: AgentChatMessagePayload[];
  session?: AgentSession;
  chat?: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
  wsStatus?: WsConnectionStatus;
  model?: string;
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
    cancel,
    ping: vi.fn(),
  };
  const runtime = {
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(historyResponse(session, history)),
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
      }),
    },
    models: {
      listModels: vi.fn().mockResolvedValue({ models: model ? [{ id: model }] : [], cached: true }),
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

function agentEvent(action: AgentActionEnvelope["action"], data: Record<string, unknown>): AgentActionEnvelope {
  return { action, data } as AgentActionEnvelope;
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
