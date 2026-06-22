import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import mermaid, { type ParseResult, type RenderResult } from "mermaid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { calculateDynamicStreamStep } from "@/renderer/hooks/useDynamicStreamBuffer";
import { useRuntimeTypingMetrics } from "@/renderer/hooks/useRuntimeTypingSpeed";
import { MessageText } from "@/renderer/pages/conversation/messages";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

const mermaidParseResult: ParseResult = { diagramType: "flowchart-v2", config: {} };
const mermaidRenderResult: RenderResult = {
  diagramType: "flowchart-v2",
  svg: '<svg role="img" aria-label="测试图表"></svg>',
};

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue({ diagramType: "flowchart-v2", config: {} }),
    render: vi.fn().mockResolvedValue({
      diagramType: "flowchart-v2",
      svg: '<svg role="img" aria-label="测试图表"></svg>',
    }),
  },
}));

describe("MessageText", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.mocked(mermaid.parse).mockResolvedValue(mermaidParseResult);
    vi.mocked(mermaid.render).mockResolvedValue(mermaidRenderResult);
  });

  it("renders markdown without raw html execution", () => {
    render(
      <MessageText
        message={message("assistant", "# 标题\n\n- 事项\n\n<script>alert(1)</script>", "completed")}
      />,
    );

    expect(screen.getByRole("heading", { name: "标题" })).not.toBeNull();
    expect(screen.getByText("事项")).not.toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders Chinese headings, ordered lists and code blocks without widening the message", () => {
    const longChinese = "这是一个很长的中文段落，用来确认消息正文可以自然换行，不会在正文区域制造额外的纵向滚动容器。".repeat(8);
    render(
      <MessageText
        message={message(
          "assistant",
          `# 中文方案\n\n${longChinese}\n\n1. 读取需求\n2. 生成实现\n\n\`\`\`ts\nconst veryLongIdentifier = "${"x".repeat(120)}";\nconsole.log(veryLongIdentifier);\n\`\`\``,
          "completed",
        )}
      />,
    );

    expect(screen.getByRole("heading", { name: "中文方案" })).not.toBeNull();
    expect(screen.getByRole("list")).not.toBeNull();
    expect(screen.getByText("读取需求")).not.toBeNull();
    expect(screen.getByTestId("markdown-code-viewport").getAttribute("data-scroll-axis")).toBe("x");
    expect(screen.getByTestId("message-text").textContent).toContain("不会在正文区域制造额外的纵向滚动容器");
  });

  it("renders inline and block math with KaTeX", () => {
    const { container } = render(
      <MessageText
        message={message("assistant", "行内公式 $a^2+b^2=c^2$\n\n$$\nE=mc^2\n$$", "completed")}
      />,
    );

    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("E");
  });

  it("converts latex delimiters outside code spans", () => {
    const { container } = render(
      <MessageText
        message={message("assistant", "公式：\\(x+1\\)\n\n代码：`\\(not math\\)`", "completed")}
      />,
    );

    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByText("\\(not math\\)")).not.toBeNull();
  });

  it("renders fenced latex code as a KaTeX block", () => {
    const { container } = render(<MessageText message={message("assistant", "```latex\nx^2+y^2=z^2\n```", "completed")} />);

    expect(screen.getByTestId("math-preview")).not.toBeNull();
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("repairs unfinished fenced code while assistant content is streaming", () => {
    render(<MessageText message={message("assistant", "```ts\nconst streaming = true;", "running")} />);

    expect(screen.getByText("ts")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).not.toBeNull();
    expect(screen.getByTestId("message-text").textContent).toContain("const streaming = true");
  });

  it("repairs unfinished display math while assistant content is streaming", () => {
    const { container } = render(<MessageText message={message("assistant", "$$\nE=mc^2", "running")} />);

    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.textContent).toContain("E");
  });

  it("wraps markdown tables in a horizontal scroll container", () => {
    const { container } = render(
      <MessageText message={message("assistant", "| 很长的列 A | 很长的列 B |\n| --- | --- |\n| 内容 | 内容 |", "completed")} />,
    );

    expect(container.querySelector(".codex-markdown-table-scroll")).not.toBeNull();
    expect(screen.getByRole("table")).not.toBeNull();
  });

  it("renders remote markdown images with lazy loading metadata", () => {
    render(<MessageText message={message("assistant", "![远程图](https://example.test/a.png)", "completed")} />);

    const image = screen.getByAltText("远程图") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("https://example.test/a.png");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("copies the whole message after completion", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<MessageText message={message("assistant", "可以复制", "completed")} />);

    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("可以复制");
    });
    expect(screen.getByText("已复制")).not.toBeNull();
  });

  it("renders a lightweight ghost footer with duration data", () => {
    render(
      <MessageText
        message={message("assistant", "完成", "completed", {
          ghostStats: {
            traceId: "trace-1",
            inputTokens: 10,
            cacheReadTokens: 3,
            outputTokens: 5,
          },
          duration_ms: 2340,
        })}
      />,
    );

    expect(screen.getByTestId("message-ghost-footer")).not.toBeNull();
    expect(screen.queryByText("trace-1")).toBeNull();
    expect(screen.queryByText(/^token /)).toBeNull();
    expect(screen.getByText("耗时 2.3 秒")).not.toBeNull();
  });

  it("keeps ghost footer absent without token or duration data", () => {
    const { rerender } = render(<MessageText message={message("assistant", "普通回答", "completed")} />);

    expect(screen.queryByTestId("message-ghost-footer")).toBeNull();

    rerender(
      <MessageText
        message={message("assistant", "历史回答", "completed", {
          traceQueryContext: { trace_id: "trace-history" },
          ghostStats: { traceId: "trace-history", inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
        })}
      />,
    );
    expect(screen.queryByTestId("message-ghost-footer")).toBeNull();
    expect(screen.queryByText("trace-history")).toBeNull();
    expect(screen.queryByText(/^token /)).toBeNull();
  });

  it("shows a lightweight cancelled badge for interrupted assistant messages", () => {
    render(<MessageText message={message("assistant", "已经输出的部分内容", "cancelled")} />);

    expect(screen.getByText("已经输出的部分内容")).not.toBeNull();
    expect(screen.getByText("已中断")).not.toBeNull();
  });

  it("copies code blocks and keeps running messages quiet", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<MessageText message={message("assistant", "```ts\nconst a = 1;\n```", "running")} />);

    expect(screen.queryByRole("button", { name: "复制消息" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("const a = 1;"));
    });
  });

  it("filters assistant think tags before markdown rendering", () => {
    render(<MessageText message={message("assistant", "<think>内部推理</think>\n最终答案", "completed")} />);

    expect(screen.queryByText("内部推理")).toBeNull();
    expect(screen.getByText("最终答案")).not.toBeNull();
  });

  it("redacts textual tool protocol leaked by incompatible models", () => {
    render(
      <MessageText
        message={message(
          "assistant",
          '我来读取文件。\n\n<tool_call>{"name":"read_file"}</tool_call>\n<tool_result>secret file</tool_result>\n\n读取完毕。',
          "completed",
        )}
      />,
    );

    expect(screen.getByRole("note").textContent).toContain("不是后端真实工具执行结果");
    expect(screen.getByText("我来读取文件。")).not.toBeNull();
    expect(screen.getByText("读取完毕。")).not.toBeNull();
    expect(screen.queryByText(/read_file/)).toBeNull();
    expect(screen.queryByText(/secret file/)).toBeNull();
  });

  it("collapses long code blocks and expands them on demand", () => {
    render(
      <MessageText
        message={message(
          "assistant",
          "```diff\n@@\n line 1\n line 2\n line 3\n line 4\n line 5\n line 6\n line 7\n line 8\n line 9\n line 10\n line 11\n```",
          "completed",
        )}
      />,
    );

    expect(screen.getByRole("button", { name: "展开代码" })).not.toBeNull();
    expect(screen.getByText("展开其余 2 行")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开代码" }));

    expect(screen.getByRole("button", { name: "折叠代码" })).not.toBeNull();
    expect(screen.getByText("收起代码")).not.toBeNull();
  });

  it("previews fenced html code by default and shows a loading placeholder when switching to source", async () => {
    render(
      <MessageText
        message={message(
          "assistant",
          "```html\n<section><h1>预览标题</h1><script>window.parent.postMessage('x','*')</script></section>\n```",
          "completed",
        )}
      />,
    );

    expect(document.querySelector("script")).toBeNull();

    const frame = screen.getByTitle("HTML 预览") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("预览标题");
    expect(screen.getByRole("button", { name: "全屏显示 HTML" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "预览 HTML" })).not.toBeNull();
    });
    expect(screen.queryByTitle("HTML 预览")).toBeNull();
  });

  it("opens rendered html code in a fullscreen preview dialog", () => {
    render(
      <MessageText
        message={message("assistant", "```html\n<main><h1>全屏页面</h1></main>\n```", "completed")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全屏显示 HTML" }));

    const dialog = screen.getByRole("dialog", { name: "HTML 预览" });
    const frames = within(dialog).getAllByTitle("HTML 预览") as HTMLIFrameElement[];
    expect(frames[0]?.getAttribute("sandbox")).toBe("");
    expect(frames[0]?.getAttribute("srcdoc")).toContain("全屏页面");

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭全屏预览" }));
    expect(screen.queryByRole("dialog", { name: "HTML 预览" })).toBeNull();
  });

  it("previews fenced Mermaid code by default", async () => {
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    expect(screen.getByTestId("mermaid-preview")).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText("Mermaid 图表")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "全屏显示 Mermaid" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();
  });

  it("opens Mermaid code fullscreen with zoom and reset controls", async () => {
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Mermaid 图表")).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Mermaid" }));

    const dialog = screen.getByRole("dialog", { name: "Mermaid 预览" });
    expect(within(dialog).getByLabelText("Mermaid 视图控制")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "放大 Mermaid" })).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "缩小 Mermaid" })).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "重置 Mermaid 视图" })).not.toBeNull();
  });

  it("keeps Mermaid render errors inside the preview panel and removes global error artifacts", async () => {
    vi.mocked(mermaid.parse).mockRejectedValueOnce(new Error("Mermaid 语法错误"));
    const legacyError = document.createElement("div");
    legacyError.id = "dmermaid-legacy";
    legacyError.innerHTML = '<svg id="mermaid-legacy"><path class="error-icon"></path></svg>';
    document.body.appendChild(legacyError);

    render(
      <MessageText
        message={message("assistant", "```mermaid\n不是合法图表\n```", "completed")}
      />,
    );

    const preview = screen.getByTestId("mermaid-preview");
    const alert = await within(preview).findByRole("alert");
    expect(alert.textContent).toContain("Mermaid 语法错误");
    expect(document.body.querySelector("#dmermaid-legacy")).toBeNull();
  });

  it("registers fullscreen Mermaid wheel handling as a non-passive listener", async () => {
    const addEventListener = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Mermaid 图表")).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Mermaid" }));

    await waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), { passive: false });
    });
    addEventListener.mockRestore();
  });

  it("opens rich fenced code into the shared preview provider", () => {
    render(
      <PreviewProvider>
        <MessageText
          message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
        />
        <PreviewProbe />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "在预览面板打开 Mermaid 图表" }));

    expect(screen.getByTestId("preview-request").textContent).toContain("mermaid:Mermaid 图表");
  });

  it("offers fullscreen preview for code blocks that can also open the side preview", () => {
    render(
      <MessageText
        message={message("assistant", "```markdown\n# 片段标题\n\n正文\n```", "completed")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Markdown 预览" }));

    const dialog = screen.getByRole("dialog", { name: "Markdown 预览" });
    expect(within(dialog).getByRole("heading", { name: "片段标题" })).not.toBeNull();
  });

  it("quotes selected message text through the floating selection toolbar", async () => {
    const onQuoteSelection = vi.fn();
    const { container } = render(
      <MessageText
        message={message("assistant", "这一段可以被引用", "completed")}
        onQuoteSelection={onQuoteSelection}
      />,
    );
    const markdown = container.querySelector(".codex-markdown");
    if (!markdown) {
      throw new Error("markdown container not found");
    }
    const selection = mockSelection(markdown, "这一段可以被引用");

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("button", { name: "添加选中文本到对话" })).toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "添加选中文本到对话" }));

    expect(onQuoteSelection).toHaveBeenCalledWith("这一段可以被引用");
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("smooths streaming assistant text with animation frames", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { rerender } = render(<MessageText message={message("assistant", "第一段", "running")} />);

    expect(screen.getByText("第一段")).not.toBeNull();

    rerender(<MessageText message={message("assistant", "第一段，第二段", "running")} />);

    expect(screen.queryByText("第一段，第二段")).toBeNull();
    act(() => {
      frames.shift()?.(performance.now() + 1000);
    });
    expect(screen.getByText("第一段，第二段")).not.toBeNull();

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("calculates a minimum stream rate and accelerates when backlog grows", () => {
    const small = calculateDynamicStreamStep(1000, 8, 0, { minCharsPerSecond: 10 });
    const large = calculateDynamicStreamStep(1000, 180, 0, { minCharsPerSecond: 10 });

    expect(small.chars).toBe(8);
    expect(small.effectiveCharsPerSecond).toBe(10);
    expect(large.chars).toBeGreaterThan(10);
    expect(large.effectiveCharsPerSecond).toBeGreaterThan(small.effectiveCharsPerSecond);
    expect(large.effectiveCharsPerSecond).toBeLessThanOrEqual(640);
  });

  it("targets clearing medium and heavy stream backlogs within one to two seconds", () => {
    const medium = calculateDynamicStreamStep(1000, 400, 0);
    const heavy = calculateDynamicStreamStep(1000, 800, 0);

    expect(medium.effectiveCharsPerSecond).toBeGreaterThanOrEqual(280);
    expect(medium.chars).toBeGreaterThanOrEqual(280);
    expect(heavy.effectiveCharsPerSecond).toBeGreaterThanOrEqual(560);
    expect(heavy.effectiveCharsPerSecond).toBeLessThanOrEqual(640);
    expect(heavy.chars).toBeGreaterThanOrEqual(560);
  });

  it("accelerates streaming assistant text when backlog grows", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const base = "起始";
    const smallAppend = `${base}${"a".repeat(8)}`;
    const largeAppend = `${base}${"b".repeat(640)}`;
    let now = performance.now();
    const { rerender } = render(<MessageText message={message("assistant", base, "running")} />);

    rerender(<MessageText message={message("assistant", smallAppend, "running")} />);
    act(() => {
      now += 100;
      frames.shift()?.(now);
    });
    const smallFrameText = screen.getByTestId("message-text").textContent ?? "";

    rerender(<MessageText message={message("assistant", base, "running")} />);
    rerender(<MessageText message={message("assistant", largeAppend, "running")} />);
    act(() => {
      now += 100;
      frames.shift()?.(now);
    });
    const largeFrameText = screen.getByTestId("message-text").textContent ?? "";

    expect(smallFrameText.length - base.length).toBe(8);
    expect(largeFrameText.length - base.length).toBeGreaterThan(40);
    expect(largeFrameText.length).toBeLessThan(largeAppend.length);

    rerender(<MessageText message={message("assistant", largeAppend, "completed")} />);
    expect(screen.getByTestId("message-text").textContent).not.toContain(largeAppend);
    for (let index = 0; index < 4; index += 1) {
      act(() => {
        now += 1000;
        frames.shift()?.(now);
      });
    }
    expect(screen.getByTestId("message-text").textContent).toContain(largeAppend);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("shows the stream cursor only while waiting for the next chunk before completion", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const base = "起始";
    const content = `${base}${"等".repeat(420)}`;
    let now = performance.now();
    const { rerender } = render(<MessageText message={message("assistant", base, "running")} />);

    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();

    rerender(<MessageText message={message("assistant", content, "running")} />);
    expect(screen.queryByTestId("streaming-cursor")).toBeNull();

    act(() => {
      now += 100;
      frames.shift()?.(now);
    });
    expect(screen.queryByTestId("streaming-cursor")).toBeNull();

    for (let index = 0; index < 8 && frames.length; index += 1) {
      act(() => {
        now += 1000;
        frames.shift()?.(now);
      });
    }
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();

    rerender(<MessageText message={message("assistant", content, "completed")} />);
    expect(screen.queryByTestId("streaming-cursor")).toBeNull();

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("reports runtime typing speed while assistant text is being displayed", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const base = "起始";
    const content = `${base}${"速".repeat(420)}`;
    let now = performance.now();
    const { rerender } = render(
      <>
        <MessageText message={message("assistant", base, "running")} />
        <RuntimeTypingMetricsProbe />
      </>,
    );

    expect(screen.getByTestId("runtime-typing-metrics").textContent).toBe("0/0");

    rerender(
      <>
        <MessageText message={message("assistant", content, "running")} />
        <RuntimeTypingMetricsProbe />
      </>,
    );
    act(() => {
      now += 100;
      frames.shift()?.(now);
    });

    const [reportedSpeed, reportedBacklog] = (screen.getByTestId("runtime-typing-metrics").textContent ?? "")
      .split("/")
      .map(Number);
    expect(reportedSpeed).toBe(300);
    expect(reportedBacklog).toBeGreaterThan(0);
    expect(reportedBacklog).toBeLessThan(420);

    for (let index = 0; index < 6 && frames.length; index += 1) {
      act(() => {
        now += 1000;
        frames.shift()?.(now);
      });
    }
    expect(screen.getByTestId("runtime-typing-metrics").textContent).toBe("0/0");

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("cancels pending stream animation when a message stops streaming", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const content = `起始${"c".repeat(120)}`;
    const { rerender } = render(<MessageText message={message("assistant", "起始", "running")} />);

    rerender(<MessageText message={message("assistant", content, "running")} />);
    expect(frames.length).toBeGreaterThan(0);

    rerender(<MessageText message={message("assistant", content, "cancelled")} />);

    expect(cancelFrame).toHaveBeenCalled();
    expect(screen.getByTestId("message-text").textContent).toContain(content);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("keeps fractional carry while calculating dynamic stream steps", () => {
    expect(calculateDynamicStreamStep(50, 10, 0, { minCharsPerSecond: 10 })).toEqual({
      chars: 0,
      carry: 0.5,
      effectiveCharsPerSecond: 10,
    });
    expect(calculateDynamicStreamStep(50, 10, 0.5, { minCharsPerSecond: 10 })).toEqual({
      chars: 1,
      carry: 0,
      effectiveCharsPerSecond: 10,
    });
    expect(calculateDynamicStreamStep(1000, 10, 0, { minCharsPerSecond: 10 })).toEqual({
      chars: 10,
      carry: 0,
      effectiveCharsPerSecond: 10,
    });
  });
});

function message(
  kind: ConversationMessage["kind"],
  content: string,
  status: ConversationMessage["status"],
  payload: Record<string, unknown> = {},
): ConversationMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind,
    status,
    content,
    payload,
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:01:00Z",
  };
}

function RuntimeTypingMetricsProbe() {
  const metrics = useRuntimeTypingMetrics();
  return <div data-testid="runtime-typing-metrics">{metrics.speed}/{metrics.backlog}</div>;
}

function PreviewProbe() {
  const preview = usePreview();
  const request = preview.request;
  return (
    <output data-testid="preview-request">
      {request?.type === "content" ? `${request.contentType}:${request.title}` : ""}
    </output>
  );
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
