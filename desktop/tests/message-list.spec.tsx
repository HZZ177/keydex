import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { MessageList } from "@/renderer/pages/conversation/messages";
import { MessageGroupBlock } from "@/renderer/pages/conversation/messages/MessageGroupBlock";
import { useVirtuosoAutoScroll } from "@/renderer/pages/conversation/messages/useVirtuosoAutoScroll";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("MessageList", () => {
  it("renders empty and loading states", () => {
    const { rerender } = render(<MessageList messages={[]} emptyText="还没有消息" />);

    expect(screen.getByTestId("message-empty").textContent).toBe("还没有消息");

    rerender(<MessageList messages={[]} loading />);
    expect(screen.getAllByTestId("message-skeleton").length).toBe(3);
  });

  it("renders messages with the default lightweight renderer", () => {
    render(<MessageList messages={[message("m1", "user", "你好"), message("m2", "assistant", "收到")]} />);

    expect(screen.getByText("你好")).not.toBeNull();
    expect(screen.getByText("收到")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" }).length).toBe(2);
  });

  it("keeps compact lists on the static renderer while processing", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalUserAgent = navigator.userAgent;
    class FakeResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Chrome",
    });

    try {
      render(<MessageList messages={[message("m1", "assistant", "流式内容")]} isProcessing />);

      expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("static");
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: originalUserAgent,
      });
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          value: originalResizeObserver,
        });
      } else {
        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      }
    }
  });

  it("requests older history when the static list is scrolled into the top buffer", async () => {
    const onLoadOlder = vi.fn();
    render(
      <MessageList
        messages={[message("m1", "user", "hello"), message("m2", "assistant", "world")]}
        hasMoreOlder
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 180 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(onLoadOlder).not.toHaveBeenCalled();

    mockScrollMetrics(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 24 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not request older history on initial top layout before the list is armed", async () => {
    const onLoadOlder = vi.fn();
    render(
      <MessageList
        messages={[message("m1", "user", "hello"), message("m2", "assistant", "world")]}
        hasMoreOlder
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 0 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("loads relative markdown images through the session workspace scope", async () => {
    const readMedia = vi.fn().mockResolvedValue({
      path: "assets/pixel.png",
      media_type: "image/png",
      size: 68,
      data_url: "data:image/png;base64,abc",
    });
    const runtime = fakeRuntime(readMedia);

    render(
      <MessageList
        messages={[message("m1", "assistant", "![项目图](assets/pixel.png)")]}
        workspaceRuntime={runtime}
        workspaceScope={{ sessionId: "ses-1" }}
      />,
    );

    const image = (await screen.findByAltText("项目图")) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(readMedia).toHaveBeenCalledWith({ sessionId: "ses-1" }, "assets/pixel.png");
  });

  it("shows a readable failure state for relative markdown images without workspace scope", async () => {
    const readMedia = vi.fn();

    render(<MessageList messages={[message("m1", "assistant", "![项目图](assets/pixel.png)")]} />);

    await waitFor(() => {
      expect(screen.queryByAltText("项目图")).toBeNull();
    });
    expect(screen.getByRole("img", { name: "项目图" }).textContent).toContain("项目图");
    expect(readMedia).not.toHaveBeenCalled();
  });

  it("shows assistant copy row only on the last assistant text in a turn", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "第一段"),
          message("m3", "assistant", "第二段"),
        ]}
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    expect(within(textMessages[2]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const finalAssistantItem = textMessages[2].closest('[role="listitem"]');
    expect(finalAssistantItem).not.toBeNull();
    expect(within(finalAssistantItem as HTMLElement).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(2);
  });

  it("shows the assistant copy row at the bottom of a trailing tool activity group", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "最后一条文字"),
          toolMessage("t1", "read_file", { path: "docs/a.md" }),
          commandMessage("c1"),
        ]}
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const groupItem = screen.getByTestId("message-group-block").closest('[role="listitem"]');
    expect(groupItem).not.toBeNull();
    expect(within(groupItem as HTMLElement).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(2);
  });

  it("shows the assistant copy row at the bottom of a trailing file change block", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "最后一条文字"),
          fileChangeMessage("f1", "docs/a.md"),
        ]}
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const fileChangeItem = screen.getByTestId("file-change-block").closest('[role="listitem"]');
    expect(fileChangeItem).not.toBeNull();
    expect(within(fileChangeItem as HTMLElement).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(2);
  });

  it("hides the final assistant copy row while the turn is still processing", () => {
    render(
      <MessageList
        messages={[message("m1", "user", "开始"), message("m2", "assistant", "处理中但已落一段")]}
        isProcessing
      />,
    );

    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(1);
  });

  it("hides all assistant copy rows in the active turn until completion", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "上一轮"),
          message("m2", "assistant", "上一轮回答"),
          message("m3", "user", "当前轮"),
          message("m4", "assistant", "第一段"),
          toolMessage("t1"),
          message("m5", "assistant", "第二段"),
        ]}
        isProcessing
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const previousAssistantItem = textMessages[1].closest('[role="listitem"]');
    expect(previousAssistantItem).not.toBeNull();
    expect(within(previousAssistantItem as HTMLElement).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(within(textMessages[3]).queryByRole("button", { name: "复制消息" })).toBeNull();
    expect(within(textMessages[4]).queryByRole("button", { name: "复制消息" })).toBeNull();
  });

  it("shows a pending assistant cursor while processing before the next stream chunk", () => {
    const { rerender } = render(<MessageList messages={[message("m1", "user", "开始")]} isProcessing />);

    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          { ...message("m2", "assistant", "正在输出"), status: "running" },
        ]}
        isProcessing
      />,
    );
    expect(screen.getAllByTestId("streaming-cursor")).toHaveLength(1);

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "已落一段"),
          toolMessage("t1"),
        ]}
        isProcessing
      />,
    );
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
  });

  it("does not append a second pending cursor while a file change is streaming", () => {
    const { rerender } = render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          { ...message("m2", "assistant", "没问题，直接重新创建："), status: "running" },
          { ...fileChangeMessage("file-change-running", "docs/project-structure.md", "add"), status: "running" },
        ]}
        isProcessing
      />,
    );

    expect(screen.getAllByTestId("streaming-cursor")).toHaveLength(1);
    const assistantMessage = screen.getAllByTestId("message-text")[1];
    expect(within(assistantMessage).queryByTestId("streaming-cursor")).toBeNull();
    const runningFileChangeItem = screen.getByTestId("file-change-block").closest('[role="listitem"]');
    expect(runningFileChangeItem).not.toBeNull();
    expect(within(runningFileChangeItem as HTMLElement).getByTestId("streaming-cursor")).not.toBeNull();

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          { ...message("m2", "assistant", "没问题，直接重新创建："), status: "running" },
          fileChangeMessage("file-change-completed", "docs/project-structure.md", "add"),
        ]}
        isProcessing
      />,
    );

    expect(screen.getAllByTestId("streaming-cursor")).toHaveLength(1);
    const completedFileChangeItem = screen.getByTestId("file-change-block").closest('[role="listitem"]');
    expect(completedFileChangeItem).not.toBeNull();
    expect(within(completedFileChangeItem as HTMLElement).getByTestId("streaming-cursor")).not.toBeNull();
  });

  it("summarizes consecutive tool messages and expands original blocks on demand", () => {
    render(<MessageList messages={[toolMessage("t1"), commandMessage("c1")]} />);

    expect(screen.getByTestId("message-group-block")).not.toBeNull();
    expect(screen.getByText("读取了 1 个文件，已运行 1 条命令")).not.toBeNull();
    expect(screen.queryByText("已执行 2 个工具步骤")).toBeNull();
    expect(screen.queryByText("2 步")).toBeNull();
    expect(screen.queryByLabelText("步骤摘要")).toBeNull();
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.queryByText("pytest backend/tests")).toBeNull();
    expect(screen.queryByText(/"path": "README\.md"/)).toBeNull();
    expect(screen.queryByText("文件内容")).toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" }));

    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();
    expect(screen.getByText("已执行 pytest backend/tests")).not.toBeNull();
    expect(screen.queryByText(/"path": "README\.md"/)).toBeNull();
    expect(screen.queryByText("文件内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具入参").textContent).toContain('"path": "README.md"');
    expect(screen.getByText("文件内容")).not.toBeNull();
  });

  it("summarizes mixed tool activity by natural-language tool categories", () => {
    render(
      <MessageList
        messages={[
          toolMessage("read-1", "read_file", { path: "README.md" }),
          toolMessage("read-2", "read_file", { path: "src/main.ts" }),
          toolMessage("dir-1", "list_directory", { path: "src" }),
          toolMessage("search-1", "search_files", { query: "agent" }),
          commandMessage("cmd-1"),
        ]}
      />,
    );

    expect(screen.getByText("读取了 2 个文件，查看了 1 个目录，搜索了 1 次，已运行 1 条命令")).not.toBeNull();
    expect(screen.queryByText(/工具步骤/)).toBeNull();
    expect(screen.queryByText("5 步")).toBeNull();
    expect(screen.queryByText("read_file")).toBeNull();
  });

  it("keeps grouped tool details expanded when new tools are appended", () => {
    const firstTool = toolMessage("read-1", "read_file", { path: "README.md" });
    const command = commandMessage("cmd-1");
    const { rerender } = render(<MessageList messages={[firstTool, command]} />);

    const initialButton = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    fireEvent.click(initialButton);

    expect(initialButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();

    rerender(
      <MessageList
        messages={[
          firstTool,
          command,
          toolMessage("read-2", "read_file", { path: "src/main.ts" }),
        ]}
      />,
    );

    const updatedButton = screen.getByRole("button", { name: "读取了 2 个文件，已运行 1 条命令详情" });
    expect(updatedButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("tool-call-block")).toHaveLength(2);
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
  });

  it("keeps grouped tool details expanded when a terminal marker is appended to the same turn", () => {
    const firstTool = toolMessage("read-1", "read_file", { path: "README.md" });
    const command = commandMessage("cmd-1");
    const { rerender } = render(<MessageList messages={[firstTool, command]} />);

    const initialButton = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    fireEvent.click(initialButton);

    expect(initialButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();

    rerender(
      <MessageList
        messages={[
          firstTool,
          command,
          {
            ...message("cancel-1", "assistant", ""),
            status: "cancelled",
            payload: { cancelled: true },
          },
        ]}
      />,
    );

    const updatedButton = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    expect(updatedButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByText("已取消")).not.toBeNull();
  });

  it("keeps the grouped tool header anchored while details expand near the top", () => {
    render(
      <div data-testid="message-list-scroll">
        <MessageGroupBlock
          count={2}
          groupKind="tool_activity"
          messages={[toolMessage("t1"), commandMessage("c1")]}
          sourceMessageIds={["t1", "c1"]}
        >
          <div>工具明细</div>
        </MessageGroupBlock>
      </div>,
    );

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    const toggle = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 360, scrollTop: 160 });
    mockElementTop(scroller, 0);
    mockElementTopSequence(toggle, [90, 42]);

    fireEvent.click(toggle);

    expect(scroller.scrollTop).toBe(112);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses failure wording for grouped tools with error results", () => {
    render(
      <MessageList
        messages={[
          {
            ...toolMessage("read-failed", "read_file", { path: "missing.txt" }),
            payload: {
              call: {
                id: "call-read-failed",
                name: "read_file",
                arguments: { path: "missing.txt" },
              },
              result: {
                status: "error",
                error: "文件不存在",
              },
            },
          },
          {
            ...commandMessage("cmd-failed"),
            payload: {
              command: "pytest backend/tests",
              cwd: "D:/repo",
              stderr: "failed",
              exit_code: 1,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("读取失败 1 个文件，运行失败 1 条命令")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "读取失败 1 个文件，运行失败 1 条命令详情" }));
    expect(screen.getByText("读取文件失败 missing.txt")).not.toBeNull();
  });

  it("separates failed and successful counts inside grouped tool categories", () => {
    render(
      <MessageList
        messages={[
          failedToolMessage("read-failed", "read_file", { path: "missing.txt" }),
          toolMessage("read-ok", "read_file", { path: "README.md" }),
          failedToolMessage("dir-failed", "list_directory", { path: "/" }),
          toolMessage("dir-ok-1", "list_directory", { path: "src" }),
          toolMessage("dir-ok-2", "list_directory", { path: "docs" }),
          failedToolMessage("search-failed", "search_files", { query: "missing" }),
          toolMessage("search-ok", "search_files", { query: "agent" }),
          {
            ...commandMessage("cmd-failed"),
            payload: {
              command: "pytest backend/tests",
              cwd: "D:/repo",
              stderr: "failed",
              exit_code: 1,
            },
          },
          commandMessage("cmd-ok"),
          failedToolMessage("edit-failed", "write_file", { path: "bad.ts" }),
          toolMessage("edit-ok", "write_file", { path: "good.ts" }),
          failedToolMessage("other-failed", "unknown_tool", { path: "bad" }),
          toolMessage("other-ok", "unknown_tool", { path: "ok" }),
        ]}
      />,
    );

    expect(
      screen.getByText(
        "读取失败 1 个文件，读取了 1 个文件，查看失败 1 个目录，查看了 2 个目录，搜索失败 1 次，搜索了 1 次，运行失败 1 条命令，已运行 1 条命令，创建失败 1 个文件，创建了 1 个文件，调用失败 1 个工具，调用了 1 个工具",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/查看失败 3 个目录/)).toBeNull();
  });

  it("uses the concrete tool icon for grouped activity with one tool category", () => {
    render(
      <MessageList
        messages={[
          toolMessage("read-1", "read_file", { path: "README.md" }),
          toolMessage("read-2", "read_file", { path: "src/main.ts" }),
        ]}
      />,
    );

    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("read");
  });

  it("keeps the check icon for grouped activity with mixed tool categories", () => {
    render(
      <MessageList
        messages={[
          toolMessage("read-1", "read_file", { path: "README.md" }),
          toolMessage("search-1", "search_files", { query: "agent" }),
          commandMessage("cmd-1"),
        ]}
      />,
    );

    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("done");
  });

  it("renders compact file-change summaries before expanding details", () => {
    render(<MessageList messages={[fileChangeMessage("file-change-1", "src/main.py"), fileChangeMessage("file-change-2", "src/app.py")]} />);

    expect(screen.getByText("编辑了 2 个文件")).not.toBeNull();
    expect(screen.queryByLabelText("步骤摘要")).toBeNull();
    expect(screen.queryByText("src/main.py")).toBeNull();
    expect(screen.queryByText("+1 -0")).toBeNull();
    expect(screen.queryByTestId("file-change-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "编辑了 2 个文件详情" }));

    expect(screen.getAllByTestId("file-change-block")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "src/main.py" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "src/app.py" })).not.toBeNull();
    expect(screen.getAllByTestId("line-change-ticker")).toHaveLength(2);
  });

  it("labels grouped created file changes separately from edits", () => {
    render(
      <MessageList
        messages={[
          fileChangeMessage("file-create-1", "src/new.ts", "add"),
          fileChangeMessage("file-create-2", "src/other.ts", "add"),
        ]}
      />,
    );

    expect(screen.getByText("创建了 2 个文件")).not.toBeNull();
    expect(screen.queryByText("编辑了 2 个文件")).toBeNull();
    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("create");
  });

  it("uses the tool name over payload operation when grouping file changes", () => {
    render(
      <MessageList
        messages={[
          fileChangeMessage("file-patch-add-1", "src/new.ts", "add", "apply_patch"),
          fileChangeMessage("file-patch-add-2", "src/other.ts", "add", "apply_patch"),
        ]}
      />,
    );

    expect(screen.getByText("编辑了 2 个文件")).not.toBeNull();
    expect(screen.queryByText("创建了 2 个文件")).toBeNull();
    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("edit");
  });

  it("separates failed and successful file-change counts", () => {
    render(
      <MessageList
        messages={[
          { ...fileChangeMessage("file-change-failed", "bad.ts"), status: "failed" },
          fileChangeMessage("file-change-ok", "good.ts"),
        ]}
      />,
    );

    expect(screen.getByText("编辑失败 1 个文件，编辑了 1 个文件")).not.toBeNull();
    expect(screen.queryByText("编辑失败 2 个文件")).toBeNull();
  });

  it("does not render update_plan in the main message list", () => {
    render(<MessageList messages={[planMessage()]} />);

    expect(screen.queryByTestId("message-plan")).toBeNull();
    expect(screen.queryByText("补充 AionUi 计划展示")).toBeNull();
    expect(screen.getByTestId("message-empty").textContent).toBe("暂无消息");
  });

  it("passes file preview callbacks into file change blocks", () => {
    const onFilePreview = vi.fn();
    render(<MessageList messages={[fileChangeMessage()]} onFilePreview={onFilePreview} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    expect(screen.getByLabelText("文件变更预览")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "src/main.py" }));

    expect(onFilePreview).toHaveBeenCalledWith({
      path: "src/main.py",
      diff: "@@\n+hello",
    });
  });

  it("follows the bottom when new messages arrive", () => {
    const first = message("m1", "assistant", "第一段");
    const second = message("m2", "assistant", "第二段");
    const { rerender } = render(<MessageList messages={[first]} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });

    rerender(<MessageList messages={[first, second]} />);

    expect(scroller.scrollTop).toBe(800);
  });

  it("does not force scroll when the user has scrolled up", async () => {
    const first = message("m1", "assistant", "第一段");
    const second = message("m2", "assistant", "第二段");
    const { rerender } = render(<MessageList messages={[first]} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });

    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "滚动到底" })).not.toBeNull();
    });

    rerender(<MessageList messages={[first, second]} />);
    expect(scroller.scrollTop).toBe(120);

    fireEvent.click(screen.getByRole("button", { name: "滚动到底" }));
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("uses the outer scroll container when the message list itself is not scrollable", async () => {
    const first = message("m1", "assistant", "第一段");
    render(
      <div data-testid="outer-scroll" style={{ height: 200, overflowY: "auto" }}>
        <MessageList messages={[first]} />
      </div>,
    );
    const outer = screen.getByTestId("outer-scroll") as HTMLDivElement;
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(outer, { scrollHeight: 1200, clientHeight: 200, scrollTop: 120 });
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 1200, scrollTop: 0 });

    fireEvent.wheel(outer, { deltaY: -120 });
    fireEvent.scroll(outer);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "滚动到底" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "滚动到底" }));
    await waitFor(() => {
      expect(outer.scrollTop).toBe(1000);
    });
    expect(scroller.scrollTop).toBe(0);
  });

  it("scrolls the virtualized scroller to its real bottom so bottom padding remains visible", () => {
    const scrollToIndex = vi.fn();
    const scrollTo = vi.fn();
    const { result } = renderHook(() => useVirtuosoAutoScroll(3));
    const scroller = document.createElement("div");
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });
    Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo });

    act(() => {
      result.current.setScrollerRef(scroller);
      (result.current.virtuosoRef as unknown as { current: { scrollToIndex: typeof scrollToIndex } | null }).current = {
        scrollToIndex,
      };
    });

    expect(typeof result.current.followOutput).toBe("function");
    expect((result.current.followOutput as (isAtBottom: boolean) => false)(true)).toBe(false);

    act(() => {
      result.current.scrollToBottom("smooth");
    });

    expect(scroller.scrollTop).toBe(120);
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => {
      result.current.handleTotalListHeightChanged();
    });
    expect(scroller.scrollTop).toBe(120);
    expect(scrollToIndex).not.toHaveBeenCalled();

    act(() => {
      result.current.scrollToBottom("auto");
    });

    expect(scroller.scrollTop).toBe(800);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("starts following automatically when streamed content grows past the viewport", async () => {
    const first = message("m1", "assistant", "短回复");
    const { rerender } = render(<MessageList messages={[first]} isProcessing />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;

    mockScrollMetrics(scroller, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 });

    rerender(
      <MessageList
        messages={[{ ...first, status: "running", content: "这是一段持续增长的流式回复。".repeat(80) }]}
        isProcessing
      />,
    );
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });
});

function message(
  id: string,
  kind: ConversationMessage["kind"],
  content: string,
): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    kind,
    status: "completed",
    content,
    payload: {},
    createdAt: `2026-06-17T10:00:0${id.slice(-1)}Z`,
    updatedAt: `2026-06-17T10:00:0${id.slice(-1)}Z`,
  };
}

function toolMessage(
  id: string,
  name = "read_file",
  args: Record<string, unknown> = { path: "README.md" },
): ConversationMessage {
  return {
    ...message(id, "tool", name),
    payload: {
      call: {
        id: `call-${id}`,
        name,
        arguments: args,
      },
      result: {
        status: "success",
        model_content: "文件内容",
      },
    },
  };
}

function failedToolMessage(
  id: string,
  name = "read_file",
  args: Record<string, unknown> = { path: "missing.txt" },
): ConversationMessage {
  return {
    ...toolMessage(id, name, args),
    status: "failed",
    payload: {
      call: {
        id: `call-${id}`,
        name,
        arguments: args,
      },
      result: {
        status: "error",
        error: "失败",
      },
    },
  };
}

function commandMessage(id: string): ConversationMessage {
  return {
    ...message(id, "command", "pytest backend/tests"),
    payload: {
      command: "pytest backend/tests",
      cwd: "D:/repo",
      stdout: "24 passed",
      exit_code: 0,
    },
  };
}

function fileChangeMessage(
  id = "file-change-1",
  path = "src/main.py",
  operation = "update",
  toolName = "",
): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    kind: "file_change",
    status: "completed",
    content: path,
    payload: {
      ...(toolName ? { call: { name: toolName, arguments: {} }, tool: toolName } : {}),
      path,
      operation,
      diff: "@@\n+hello",
      additions: 1,
      deletions: 0,
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:00Z",
  };
}

function planMessage(): ConversationMessage {
  return {
    id: "plan-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "plan-1",
    kind: "plan",
    status: "completed",
    content: "update_plan",
    payload: {
      ui_payload: {
        explanation: "补充 AionUi 计划展示",
        entries: [
          { content: "分析 AionUi 计划卡片", status: "completed" },
          { content: "实现计划卡片", status: "in_progress" },
          { content: "回填测试报告", status: "pending" },
        ],
      },
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:00Z",
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

function mockElementTop(element: HTMLElement, top: number) {
  mockElementTopSequence(element, [top]);
}

function mockElementTopSequence(element: HTMLElement, tops: number[]) {
  let index = 0;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const top = tops[Math.min(index, tops.length - 1)] ?? 0;
      index += 1;
      return {
        top,
        bottom: top + 28,
        left: 0,
        right: 320,
        width: 320,
        height: 28,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
}

function fakeRuntime(readMedia: ReturnType<typeof vi.fn>): RuntimeBridge {
  return {
    workspace: {
      readMedia,
      readFile: vi.fn(),
    },
  } as unknown as RuntimeBridge;
}
