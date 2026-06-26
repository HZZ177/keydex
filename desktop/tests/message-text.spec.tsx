import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import mermaid, { type ParseResult, type RenderResult } from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateDynamicStreamStep } from "@/renderer/hooks/useDynamicStreamBuffer";
import { useRuntimeTypingMetrics } from "@/renderer/hooks/useRuntimeTypingSpeed";
import { LineChangeTicker } from "@/renderer/pages/conversation/messages/LineChangeTicker";
import { MessageText } from "@/renderer/pages/conversation/messages";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { RuntimeBridge } from "@/runtime";

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

  afterEach(() => {
    vi.useRealTimers();
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

  it("renders bracket syntax in user messages as ordinary text", () => {
    render(
      <MessageText
        message={message("user", "请基于 [[这是一段选中的历史内容]] 继续分析", "completed")}
      />,
    );

    expect(screen.getByTestId("message-text").textContent).toContain("[[这是一段选中的历史内容]]");
    expect(screen.queryByText("引用片段")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("renders restored quote context preview cards in a body portal", async () => {
    render(
      <MessageText
        message={message("user", "请看这个引用", "completed", {
          contextItems: [
            {
              id: "ctx-quote",
              type: "quote",
              label: "引用片段",
              content: "payload 中恢复的引用内容",
              source: "follow",
            },
          ],
        })}
      />,
    );

    const chip = screen.getByText("引用片段");
    expect(screen.queryByText("payload 中恢复的引用内容")).toBeNull();
    fireEvent.mouseEnter(chip);

    const preview = await screen.findByText("payload 中恢复的引用内容");
    expect(preview.closest('[data-testid="message-text"]')).toBeNull();
  });

  it("opens restored file context chips without a quote hover card", () => {
    render(
      <PreviewProvider>
        <MessageText
          message={message("user", "请看这个文件", "completed", {
            contextItems: [
              {
                id: "ctx-file",
                type: "file",
                label: "README.md",
                content: "workspace file: README.md",
                source: "follow",
                path: "README.md",
                fileType: "file",
              },
            ],
          })}
          workspaceRuntime={{} as RuntimeBridge}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <FilePanelProbe />
      </PreviewProvider>,
    );

    expect(screen.queryByText("workspace file: README.md")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开文件引用 README.md" }));

    expect(screen.getByTestId("file-panel-request").textContent).toBe("session:ses-1:README.md");
  });

  it("shows restored file context paths in a body portal", async () => {
    const path = "src/features/conversation/components/deeply-nested/FileWithLongName.tsx";
    render(
      <MessageText
        message={message("user", "please check this file", "completed", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: path,
              content: "workspace file",
              source: "follow",
              path,
              fileType: "file",
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText(path)).toBeNull();
    expect(screen.getByTestId("message-text").textContent).toContain("@FileWithLongName.tsx");
    expect(screen.getByTestId("message-text").textContent).not.toContain(`@${path}`);
    fireEvent.mouseEnter(screen.getByRole("button", { name: new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));

    const preview = await screen.findByText(path);
    expect(document.querySelector('[data-floating-preview-title="true"]')?.textContent).toBe("FileWithLongName.tsx");
    expect(preview.closest('[data-testid="message-text"]')).toBeNull();
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

  it("shows fenced latex source by default and switches to a KaTeX block", async () => {
    const { container } = render(<MessageText message={message("assistant", "```latex\nx^2+y^2=z^2\n```", "completed")} />);

    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("x^2+y^2=z^2");
    expect(screen.queryByTestId("math-preview")).toBeNull();
    expect(screen.getByRole("button", { name: "预览 公式" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览 公式" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(
      () => {
        expect(screen.getByTestId("math-preview")).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();
  });

  it("repairs unfinished fenced code while assistant content is streaming", () => {
    render(<MessageText message={message("assistant", "```ts\nconst streaming = true;", "running")} />);

    expect(screen.getByText("ts")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).not.toBeNull();
    expect(screen.getByTestId("message-text").textContent).toContain("const streaming = true");
  });

  it("shows a generating line ticker instead of expand controls for streaming long code blocks", () => {
    render(
      <MessageText
        message={message(
          "assistant",
          `\`\`\`ts\n${Array.from({ length: 12 }, (_, index) => `const line${index} = ${index};`).join("\n")}`,
          "running",
        )}
      />,
    );

    expect(screen.queryByText(/const line11/)).toBeNull();
    expect(screen.queryByRole("button", { name: "展开代码" })).toBeNull();
    expect(screen.queryByText(/展开其余/)).toBeNull();

    const ticker = screen.getByTestId("line-change-ticker");
    expect(ticker.getAttribute("aria-label")).toContain("正在生成内容");
    expect(ticker.getAttribute("aria-label")).toContain("新增 2 行");
    expect(screen.getAllByTestId("line-change-digit")).toHaveLength(1);
  });

  it("shows normal expand controls once a streaming code fence is closed", () => {
    render(
      <MessageText
        message={message(
          "assistant",
          [
            "```ts",
            ...Array.from({ length: 12 }, (_, index) => `const line${index} = ${index};`),
            "```",
            "",
            "后续正文还在输出",
          ].join("\n"),
          "running",
        )}
      />,
    );

    expect(screen.queryByTestId("line-change-ticker")).toBeNull();
    expect(screen.queryByRole("button", { name: "展开代码" })).not.toBeNull();
    expect(screen.getByText("展开其余 2 行")).not.toBeNull();
    expect(screen.queryByText(/const line11/)).toBeNull();
  });

  it("hides the generating line ticker until a streaming code block exceeds the preview rows", () => {
    render(<MessageText message={message("assistant", "```ts\nconst first = true;", "running")} />);

    expect(screen.queryByTestId("line-change-ticker")).toBeNull();
    expect(screen.queryByRole("button", { name: "展开代码" })).toBeNull();
    expect(screen.queryByText(/展开其余/)).toBeNull();
  });

  it("rolls every digit in the line change ticker when the count changes", () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValueOnce(0.8).mockReturnValueOnce(0.2);
    const { rerender } = render(<LineChangeTicker label="正在生成内容" added={9} />);

    expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 9 行");
    rerender(<LineChangeTicker label="正在生成内容" added={10} />);

    expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 9 行");
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 10 行");
    const digits = screen.getAllByTestId("line-change-digit");
    expect(digits).toHaveLength(2);
    expect(digits.every((digit) => digit.getAttribute("data-changed") === "true")).toBe(true);
    expect(digits.map((digit) => digit.getAttribute("data-direction"))).toEqual(["down", "up"]);
    expect(digits.every((digit) => digit.getAttribute("data-phase") === "rolling")).toBe(true);
    randomSpy.mockRestore();
  });

  it("rolls changed line ticker digits in independently random directions", () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValueOnce(0.2).mockReturnValueOnce(0.8).mockReturnValueOnce(0.4);
    const { rerender } = render(<LineChangeTicker label="正在生成内容" added={99} />);

    rerender(<LineChangeTicker label="正在生成内容" added={100} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(screen.getAllByTestId("line-change-digit").map((digit) => digit.getAttribute("data-direction"))).toEqual([
      "up",
      "down",
      "up",
    ]);
    randomSpy.mockRestore();
  });

  it("renders real digit sequences for rolling line ticker changes", () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValueOnce(0.2).mockReturnValueOnce(0.8);
    const first = render(<LineChangeTicker label="正在生成内容" added={2} />);

    first.rerender(<LineChangeTicker label="正在生成内容" added={6} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(screen.getByTestId("line-change-digit").getAttribute("data-direction")).toBe("up");
    expect(screen.getByTestId("line-change-digit-track").textContent).toBe("23456");

    first.unmount();
    const second = render(<LineChangeTicker label="正在生成内容" added={2} />);
    second.rerender(<LineChangeTicker label="正在生成内容" added={6} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(screen.getByTestId("line-change-digit").getAttribute("data-direction")).toBe("down");
    expect(screen.getByTestId("line-change-digit-track").textContent).toBe("6789012");
    randomSpy.mockRestore();
  });

  it("coalesces rapid line ticker changes to at most one update per 0.8 seconds", () => {
    vi.useFakeTimers();
    const { rerender } = render(<LineChangeTicker label="正在生成内容" added={1} />);

    rerender(<LineChangeTicker label="正在生成内容" added={2} />);
    rerender(<LineChangeTicker label="正在生成内容" added={3} />);
    rerender(<LineChangeTicker label="正在生成内容" added={4} />);

    expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 1 行");
    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 1 行");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 4 行");
  });

  it("keeps the streaming code ticker mounted across markdown content updates", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    let now = performance.now();
    try {
      const { rerender } = render(
        <MessageText
          message={message(
            "assistant",
            `\`\`\`ts\n${Array.from({ length: 11 }, (_, index) => `const line${index} = ${index};`).join("\n")}`,
            "running",
          )}
        />,
      );
      const initialTicker = screen.getByTestId("line-change-ticker");

      rerender(
        <MessageText
          message={message(
            "assistant",
            `\`\`\`ts\n${Array.from({ length: 12 }, (_, index) => `const line${index} = ${index};`).join("\n")}`,
            "running",
          )}
        />,
      );

      expect(screen.getByTestId("line-change-ticker")).toBe(initialTicker);
      expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 1 行");

      act(() => {
        now += 1000;
        frames.shift()?.(now);
      });

      expect(screen.getByTestId("line-change-ticker")).toBe(initialTicker);
      expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 1 行");

      act(() => {
        vi.advanceTimersByTime(799);
      });
      expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 1 行");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByTestId("line-change-ticker").getAttribute("aria-label")).toContain("新增 2 行");
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("does not cancel digit rolling when the ticker parent rerenders with the same value", () => {
    vi.useFakeTimers();
    const { rerender } = render(<LineChangeTicker label="正在生成内容" added={1} />);

    rerender(<LineChangeTicker label="正在生成内容" added={12} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(screen.getAllByTestId("line-change-digit").some((digit) => digit.getAttribute("data-phase") === "rolling")).toBe(true);
    rerender(<LineChangeTicker label="正在生成内容" added={12} />);
    expect(screen.getAllByTestId("line-change-digit").some((digit) => digit.getAttribute("data-phase") === "rolling")).toBe(true);
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

    expect(container.querySelector(".keydex-markdown-table-scroll")).not.toBeNull();
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
    expect(screen.getByText("已取消")).not.toBeNull();
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

    expect(screen.queryByText(/line 11/)).toBeNull();
    expect(screen.getByRole("button", { name: "展开代码" })).not.toBeNull();
    expect(screen.getByText("展开其余 2 行")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开代码" }));

    expect(screen.getByRole("button", { name: "折叠代码" })).not.toBeNull();
    expect(screen.getByText("收起代码")).not.toBeNull();
    expect(screen.getByText(/line 11/)).not.toBeNull();
  });

  it("animates long code block expansion after rendering the full source", async () => {
    const animation = {
      cancel: vi.fn(),
      oncancel: null,
      onfinish: null,
    } as unknown as Animation;
    const originalAnimate = HTMLElement.prototype.animate;
    const animate = vi.fn(() => animation);
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });

    render(
      <MessageText
        message={message(
          "assistant",
          `\`\`\`ts\n${Array.from({ length: 100 }, (_, index) => `const line${index} = ${index};`).join("\n")}\n\`\`\``,
          "completed",
        )}
      />,
    );

    const viewport = screen.getByTestId("markdown-code-viewport") as HTMLDivElement;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1600 });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      bottom: 198,
      height: 198,
      left: 0,
      right: 640,
      top: 0,
      width: 640,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.click(screen.getByRole("button", { name: "展开代码" }));

    await waitFor(() => {
      expect(animate).toHaveBeenCalled();
    });
    expect(animate).toHaveBeenCalledWith(
      [
        { height: "198px", opacity: 0.96 },
        { height: "1600px", opacity: 1 },
      ],
      expect.objectContaining({
        duration: 220,
      }),
    );
    expect(screen.getByRole("button", { name: "折叠代码" })).not.toBeNull();

    if (originalAnimate) {
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: originalAnimate,
      });
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("shows fenced html source by default and switches to a sandboxed preview", async () => {
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
    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("预览标题");
    expect(screen.queryByTitle("HTML 预览")).toBeNull();
    expect(screen.getByRole("button", { name: "全屏显示 HTML" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "预览 HTML" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览 HTML" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    const frame = await screen.findByTitle("HTML 预览") as HTMLIFrameElement;

    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("预览标题");

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("预览标题");
    });
    expect(screen.queryByTitle("HTML 预览")).toBeNull();
  });

  it("shows fenced json source by default and switches to a searchable tree preview", async () => {
    render(
      <MessageText
        message={message(
          "assistant",
          '```json\n{"users":[{"name":"Ada","role":"admin"}],"enabled":true}\n```',
          "completed",
        )}
      />,
    );

    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain('"users"');
    expect(screen.queryByTestId("json-tree-viewer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览 JSON" }));

    const viewer = await screen.findByTestId("json-tree-viewer", undefined, { timeout: 15000 });
    expect(viewer).not.toBeNull();
    expect(screen.getByRole("searchbox", { name: "查找 JSON" })).not.toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "查找 JSON" }), { target: { value: "Ada" } });

    expect(screen.getByText("1 / 1")).not.toBeNull();
    expect(screen.getByRole("button", { name: /\$\.users\[0\]\.name/ })).not.toBeNull();
  }, 20000);

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

  it("shows fenced Mermaid source by default and switches to preview", async () => {
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("graph TD");
    expect(screen.queryByTestId("mermaid-preview")).toBeNull();
    expect(screen.getByRole("button", { name: "全屏显示 Mermaid" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "预览 Mermaid" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览 Mermaid" }));
    expect(screen.queryByText("正在渲染 Mermaid...")).toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText("Mermaid 图表")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();
  });

  it("opens Mermaid code fullscreen with zoom and reset controls", async () => {
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Mermaid" }));

    const dialog = screen.getByRole("dialog", { name: "Mermaid 预览" });
    const controls = within(dialog).getByLabelText("Mermaid 视图控制");
    expect(controls).not.toBeNull();
    expect(within(controls).getByText("100%")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "放大 Mermaid" }));
    expect(within(controls).getByText("110%")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "缩小 Mermaid" })).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置 Mermaid 视图" }));
    expect(within(controls).getByText("100%")).not.toBeNull();

    for (let index = 0; index < 90; index += 1) {
      fireEvent.click(within(dialog).getByRole("button", { name: "放大 Mermaid" }));
    }
    expect(within(controls).getByText("1000%")).not.toBeNull();
  });

  it("normalizes fullscreen Mermaid SVG dimensions before zooming", async () => {
    let renderHostParent: Element | null = null;
    let renderHostWasInsidePreview = false;
    vi.mocked(mermaid.render).mockImplementationOnce(async (_id, _definition, renderHost) => {
      expect(renderHost).toBeInstanceOf(Element);
      const host = renderHost as Element;
      renderHostParent = host.parentElement;
      renderHostWasInsidePreview = Boolean(host.closest('[data-testid="mermaid-preview"]'));
      return {
        diagramType: "flowchart-v2",
        svg: '<svg role="img" aria-label="complex chart" width="100%" style="max-width: 320px;" viewBox="0 0 2400 1200"></svg>',
      };
    });

    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[寮€濮媇 --> B[缁撴潫]\n```", "completed")}
      />,
    );

    const fullscreenButton = screen
      .getAllByRole("button")
      .find((button) => button.querySelector(".lucide-maximize2"));
    expect(fullscreenButton).toBeDefined();
    fireEvent.click(fullscreenButton as HTMLButtonElement);

    const dialog = screen.getByRole("dialog", { name: /Mermaid/ });
    const svg = await within(dialog).findByLabelText("complex chart");
    const chart = svg.parentElement as HTMLDivElement;

    expect(renderHostParent).toBe(document.body);
    expect(renderHostWasInsidePreview).toBe(false);
    expect(document.body.querySelector('[data-mermaid-render-host="true"]')).toBeNull();
    expect(chart.getAttribute("data-sized")).toBe("true");
    expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("2400px");
    expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("1200px");
    expect(chart.style.transform).not.toContain("scale");
    expect(svg?.getAttribute("width")).toBe("2400");
    expect(svg?.getAttribute("height")).toBe("1200");
    expect(svg?.getAttribute("style") ?? "").not.toContain("max-width");

    const zoomInButton = within(dialog)
      .getAllByRole("button")
      .find((button) => button.querySelector(".lucide-zoom-in"));
    expect(zoomInButton).toBeDefined();
    fireEvent.click(zoomInButton as HTMLButtonElement);
    expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("2640px");
    expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("1320px");
    expect(chart.style.transform).not.toContain("scale");
  });

  it("auto-fits fullscreen Mermaid previews and centers oversized minimum zoom", async () => {
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      diagramType: "flowchart-v2",
      svg: '<svg role="img" aria-label="oversized chart" width="100%" style="max-width: 320px;" viewBox="0 0 20000 10000"></svg>',
    });

    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA --> B\n```", "completed")}
      />,
    );

    const fullscreenButton = screen
      .getAllByRole("button")
      .find((button) => button.querySelector(".lucide-maximize2"));
    expect(fullscreenButton).toBeDefined();
    fireEvent.click(fullscreenButton as HTMLButtonElement);

    const dialog = screen.getByRole("dialog", { name: /Mermaid/ });
    const preview = within(dialog).getByTestId("mermaid-preview") as HTMLDivElement;
    Object.defineProperty(preview, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(preview, "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(preview, "scrollWidth", { configurable: true, value: 2000 });
    Object.defineProperty(preview, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(preview, "scrollLeft", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(preview, "scrollTop", { configurable: true, writable: true, value: 0 });

    await within(dialog).findByLabelText("oversized chart");

    await waitFor(() => {
      const chart = within(dialog).getByLabelText("Mermaid 图表") as HTMLDivElement;
      expect(within(dialog).getByText("10%")).not.toBeNull();
      expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("2000px");
      expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("1000px");
      expect(preview.style.getPropertyValue("--mermaid-canvas-padding-x")).toBe("600px");
      expect(preview.style.getPropertyValue("--mermaid-canvas-padding-y")).toBe("400px");
      expect(preview.scrollLeft).toBe(1000);
      expect(preview.scrollTop).toBe(500);
    });
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

    fireEvent.click(screen.getByRole("button", { name: "预览 Mermaid" }));
    const preview = await screen.findByTestId("mermaid-preview");
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
    const markdown = container.querySelector(".keydex-markdown");
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
    const toolbar = await screen.findByRole("toolbar", { name: "选中文本操作" });
    expect(toolbar.parentElement).toBe(document.body);
    expect(toolbar.style.left).toBe("170px");
    expect(toolbar.style.top).toBe("132px");

    fireEvent.click(screen.getByRole("button", { name: "添加选中文本到对话" }));

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
    expect(large.effectiveCharsPerSecond).toBeLessThanOrEqual(1200);
  });

  it("targets clearing medium and heavy stream backlogs within one to two seconds", () => {
    const medium = calculateDynamicStreamStep(1000, 400, 0);
    const heavy = calculateDynamicStreamStep(1000, 800, 0);

    expect(medium.effectiveCharsPerSecond).toBeGreaterThanOrEqual(440);
    expect(medium.chars).toBe(400);
    expect(heavy.effectiveCharsPerSecond).toBeGreaterThanOrEqual(880);
    expect(heavy.effectiveCharsPerSecond).toBeLessThanOrEqual(1200);
    expect(heavy.chars).toBe(800);
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
    act(() => {
      now += 1000;
      frames.shift()?.(now);
    });
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
    expect(reportedSpeed).toBe(467);
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

  it("reports runtime typing speed while an unclosed streaming code fence grows", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const baseContent = "```ts\nconst first = 1;";
    const nextContent = [
      "```ts",
      "const first = 1;",
      ...Array.from({ length: 12 }, (_, index) => `const generated${index} = ${index};`),
    ].join("\n");
    let now = performance.now();
    const { rerender } = render(
      <>
        <MessageText
          message={{ ...message("assistant", baseContent, "running"), id: "streaming-code-fence" }}
        />
        <RuntimeTypingMetricsProbe />
      </>,
    );

    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("const first = 1;");

    rerender(
      <>
        <MessageText
          message={{ ...message("assistant", nextContent, "running"), id: "streaming-code-fence" }}
        />
        <RuntimeTypingMetricsProbe />
      </>,
    );

    expect(screen.getByTestId("message-text").textContent).not.toContain("generated11");

    let reportedSpeed = 0;
    let reportedBacklog = 0;
    for (let index = 0; index < 5 && frames.length; index += 1) {
      act(() => {
        now += 100;
        frames.shift()?.(now);
      });
      [reportedSpeed, reportedBacklog] = (screen.getByTestId("runtime-typing-metrics").textContent ?? "")
        .split("/")
        .map(Number);
      if (reportedSpeed > 0 && reportedBacklog > 0) {
        break;
      }
    }
    expect(reportedSpeed).toBeGreaterThan(0);
    expect(reportedBacklog).toBeGreaterThan(0);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("reports runtime typing speed when a streaming message mounts with buffered code content", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const content = [
      "下面是代码：",
      "",
      "```ts",
      ...Array.from({ length: 80 }, (_, index) => `const value${index} = ${index};`),
      "```",
    ].join("\n");
    let now = performance.now();

    render(
      <>
        <MessageText message={message("assistant", content, "running")} />
        <RuntimeTypingMetricsProbe />
      </>,
    );

    expect(screen.getByTestId("message-text").textContent).not.toContain("const value79 = 79;");

    act(() => {
      now += 100;
      frames.shift()?.(now);
    });

    const [reportedSpeed, reportedBacklog] = (screen.getByTestId("runtime-typing-metrics").textContent ?? "")
      .split("/")
      .map(Number);
    expect(reportedSpeed).toBeGreaterThan(0);
    expect(reportedBacklog).toBeGreaterThan(0);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("resets typing state when a recycled message component receives a new streaming message id", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const content = [
      "继续输出代码：",
      "",
      "```tsx",
      ...Array.from({ length: 90 }, (_, index) => `export const Row${index} = () => <div>${index}</div>;`),
      "```",
    ].join("\n");
    let now = performance.now();
    const { rerender } = render(
      <>
        <MessageText message={{ ...message("assistant", "历史回答", "completed"), id: "history-message" }} />
        <RuntimeTypingMetricsProbe />
      </>,
    );

    rerender(
      <>
        <MessageText message={{ ...message("assistant", content, "running"), id: "live-message" }} />
        <RuntimeTypingMetricsProbe />
      </>,
    );

    expect(screen.getByTestId("message-text").textContent).not.toContain("Row89");

    act(() => {
      now += 100;
      frames.shift()?.(now);
    });

    const [reportedSpeed, reportedBacklog] = (screen.getByTestId("runtime-typing-metrics").textContent ?? "")
      .split("/")
      .map(Number);
    expect(reportedSpeed).toBeGreaterThan(0);
    expect(reportedBacklog).toBeGreaterThan(0);

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

function FilePanelProbe() {
  const preview = usePreview();
  const request = preview.filePanelRequest;
  return <output data-testid="file-panel-request">{request ? `${request.scopeKey}:${request.path}` : ""}</output>;
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
