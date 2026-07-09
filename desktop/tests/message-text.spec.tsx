import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import mermaid, { type ParseResult, type RenderResult } from "mermaid";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateDynamicStreamStep } from "@/renderer/hooks/useDynamicStreamBuffer";
import { useRuntimeTypingMetrics } from "@/renderer/hooks/useRuntimeTypingSpeed";
import { LineChangeTicker } from "@/renderer/pages/conversation/messages/LineChangeTicker";
import { MessageText } from "@/renderer/pages/conversation/messages";
import { PreviewProvider, usePreview, type PreviewRenderContext } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { RuntimeBridge } from "@/runtime";

const mermaidParseResult: ParseResult = { diagramType: "flowchart-v2", config: {} };
const mermaidRenderResult: RenderResult = {
  diagramType: "flowchart-v2",
  svg: '<svg role="img" aria-label="测试图表"></svg>',
};
const virtuosoMock = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
}));

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

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Virtuoso: React.forwardRef(function VirtuosoMock(props: {
      customScrollParent?: HTMLElement;
      data: unknown[];
      itemContent: (index: number, item: unknown) => unknown;
      rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
      style?: React.CSSProperties;
    }, ref) {
      const endIndex = Math.min(7, props.data.length - 1);
      const rangeChanged = props.rangeChanged;
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: virtuosoMock.scrollToIndex,
      }));
      React.useEffect(() => {
        if (endIndex >= 0) {
          rangeChanged?.({ startIndex: 0, endIndex });
        }
      }, [endIndex, rangeChanged]);
      return React.createElement(
        "div",
        {
          "data-custom-scroll-parent": props.customScrollParent ? "true" : "false",
          "data-testid": "virtuoso-mock",
          style: props.style,
        },
        props.data.slice(0, endIndex + 1).map((item, index) =>
          React.createElement(
            "div",
            { "data-testid": "virtuoso-item", key: index },
            props.itemContent(index, item) as import("react").ReactNode,
          ),
        ),
      );
    }),
  };
});

describe("MessageText", () => {
  beforeEach(() => {
    virtuosoMock.scrollToIndex.mockClear();
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

  it("renders a failed assistant turn error notice without replacing the answer", () => {
    render(
      <MessageText
        message={message("assistant", "已经生成的回答", "failed", {
          error: {
            code: "llm_read_timeout",
            message: "模型响应超时，未收到后续响应数据",
            details: { exception_type: "httpx.ReadTimeout" },
          },
        })}
      />,
    );

    const root = screen.getByTestId("message-text");
    expect(root.textContent).toContain("已经生成的回答");
    expect(root.textContent).toContain("模型响应超时，未收到后续响应数据");
    expect(root.textContent).toContain("llm_read_timeout");
    expect(screen.queryByText(/httpx.ReadTimeout/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开错误详情" }));
    expect(screen.getByText(/httpx.ReadTimeout/)).not.toBeNull();
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

  it("renders restored user context chips above the user bubble", () => {
    render(
      <MessageText
        message={message("user", "please review", "completed", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: "README.md",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        })}
      />,
    );

    const bubble = screen.getByTestId("message-bubble");
    expect(bubble.textContent).toContain("please review");
    expect(bubble.textContent).not.toContain("@README.md");
    expect(screen.getByTestId("message-text").textContent).toContain("@README.md");
  });

  it("renders restored goal context as a compact hover capsule below the user bubble", async () => {
    render(
      <MessageText
        message={message("user", "开始执行", "completed", {
          contextItems: [
            {
              id: "goal:123",
              type: "goal",
              label: "目标",
              source: "goal",
              content: "完成这个目标",
              metadata: {
                kind: "goal",
                title: "目标",
                objective: "完成这个目标",
              },
            },
          ],
        })}
      />,
    );

    const bubble = screen.getByTestId("message-bubble");
    const goalContext = screen.getByLabelText("目标上下文");
    expect(bubble.textContent).toContain("开始执行");
    expect(within(goalContext).getByText("目标")).not.toBeNull();
    expect(within(goalContext).queryByText("完成这个目标")).toBeNull();
    expect(screen.queryByLabelText("附加上下文")).toBeNull();

    const wrapper = within(goalContext).getByText("目标").closest("[data-preview-open]");
    if (!wrapper) {
      throw new Error("goal context wrapper not found");
    }
    fireEvent.mouseEnter(wrapper);

    const preview = await screen.findByText("完成这个目标");
    const card = preview.closest("[data-floating-placement]");
    expect(preview.closest('[data-testid="message-text"]')).toBeNull();
    expect(card?.getAttribute("data-floating-placement")).toBe("bottom");
  });

  it("does not render an empty user bubble for context-only restored messages", () => {
    render(
      <MessageText
        message={message("user", "", "completed", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: "README.md",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        })}
      />,
    );

    expect(screen.queryByTestId("message-bubble")).toBeNull();
    expect(screen.getByTestId("message-text").textContent).toContain("@README.md");
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

  it("opens absolute markdown file links as single local previews with line reveal", () => {
    render(
      <PreviewProvider>
        <MessageText
          message={message("assistant", "查看 [notes.md](<D:/Docs/local notes.md:7>)", "completed")}
          workspaceRuntime={{} as RuntimeBridge}
        />
        <PreviewEntryProbe />
      </PreviewProvider>,
    );

    const link = screen.getByRole("link", { name: "notes.md" });
    expect(link.getAttribute("data-keydex-file-link")).toBe("true");
    const icon = link.querySelector("[data-keydex-file-link-icon='true']");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("data-icon-id")).toBe("markdown");
    const lineBadge = link.querySelector("[data-keydex-file-link-line-badge='true']");
    expect(lineBadge?.textContent).toBe("L7");
    expect(lineBadge?.getAttribute("aria-hidden")).toBe("true");
    expect(lineBadge?.getAttribute("title")).toBe("第 7 行");
    fireEvent.click(link);

    const payload = previewEntryPayload();
    expect(payload).toMatchObject({
      request: {
        type: "local-file",
        path: "D:/Docs/local notes.md",
      },
      revealTarget: {
        lineStart: 7,
        lineEnd: 7,
      },
      scopeKey: "global",
    });
  });

  it("does not render a line badge for file links without line targets", () => {
    render(
      <PreviewProvider>
        <MessageText
          message={message("assistant", "查看 [notes.md](<D:/Docs/local notes.md>)", "completed")}
          workspaceRuntime={{} as RuntimeBridge}
        />
      </PreviewProvider>,
    );

    const link = screen.getByRole("link", { name: "notes.md" });
    expect(link.querySelector("[data-keydex-file-link-line-badge='true']")).toBeNull();
  });

  it("opens relative markdown file links as workspace-scoped file previews", () => {
    render(
      <PreviewProvider>
        <PreviewHostContextSetter context={{ sessionId: "ses-1", workspaceAvailable: true, runtime: {} as RuntimeBridge }} />
        <MessageText
          message={message(
            "assistant",
            "查看 [MessageText.tsx](<desktop/src/renderer/pages/conversation/messages/MessageText.tsx:120>)",
            "completed",
          )}
          workspaceRuntime={{} as RuntimeBridge}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <PreviewEntryProbe />
      </PreviewProvider>,
    );

    const link = screen.getByRole("link", { name: "MessageText.tsx" });
    expect(link.getAttribute("data-keydex-file-link")).toBe("true");
    expect(link.querySelector("[data-keydex-file-link-icon='true']")?.getAttribute("data-icon-id")).toBe("react_ts");
    expect(link.querySelector("[data-keydex-file-link-line-badge='true']")?.textContent).toBe("L120");
    fireEvent.click(link);

    const payload = previewEntryPayload();
    expect(payload).toMatchObject({
      request: {
        type: "file",
        path: "desktop/src/renderer/pages/conversation/messages/MessageText.tsx",
      },
      revealTarget: {
        lineStart: 120,
        lineEnd: 120,
      },
      scopeKey: "session:ses-1",
    });
  });

  it("recovers standard markdown file links wrapped as inline code", () => {
    render(
      <PreviewProvider>
        <PreviewHostContextSetter context={{ sessionId: "ses-1", workspaceAvailable: true, runtime: {} as RuntimeBridge }} />
        <MessageText
          message={message("assistant", "查看 `[README.md](<README.md:162>)`", "completed")}
          workspaceRuntime={{} as RuntimeBridge}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <PreviewEntryProbe />
      </PreviewProvider>,
    );

    const link = screen.getByRole("link", { name: "README.md" });
    expect(link.closest("code")).toBeNull();
    fireEvent.click(link);

    expect(previewEntryPayload()).toMatchObject({
      request: {
        type: "file",
        path: "README.md",
      },
      revealTarget: {
        lineStart: 162,
        lineEnd: 162,
      },
      scopeKey: "session:ses-1",
    });
  });

  it("keeps standard markdown file links clickable inside emphasis without auto-linking natural language", () => {
    render(
      <PreviewProvider>
        <PreviewHostContextSetter context={{ sessionId: "ses-1", workspaceAvailable: true, runtime: {} as RuntimeBridge }} />
        <MessageText
          message={message(
            "assistant",
            "重点看 **[README.md](<README.md:162>)**，但 README.md 第 162 行 只是自然语言。",
            "completed",
          )}
          workspaceRuntime={{} as RuntimeBridge}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <PreviewEntryProbe />
      </PreviewProvider>,
    );

    const links = screen.getAllByRole("link", { name: "README.md" });
    expect(links).toHaveLength(1);
    expect(screen.getByTestId("message-text").textContent).toContain("README.md 第 162 行");
    fireEvent.click(links[0]);

    expect(previewEntryPayload()).toMatchObject({
      request: {
        type: "file",
        path: "README.md",
      },
      revealTarget: {
        lineStart: 162,
        lineEnd: 162,
      },
      scopeKey: "session:ses-1",
    });
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
    const hoverCard = preview.closest("[data-floating-ready]");
    expect(hoverCard).not.toBeNull();
    expect(fireEvent.mouseDown(hoverCard as Element)).toBe(true);
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

  it("shows fenced latex preview by default and switches back to source", async () => {
    const { container } = render(<MessageText message={message("assistant", "```latex\nx^2+y^2=z^2\n```", "completed")} />);

    expect(screen.getByTestId("math-preview")).not.toBeNull();
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(screen.queryByTestId("markdown-code-viewport")).toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(
      () => {
        expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("x^2+y^2=z^2");
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId("math-preview")).toBeNull();
  });

  it("repairs unfinished fenced code while assistant content is streaming", () => {
    render(<MessageText message={message("assistant", "```ts\nconst streaming = true;", "running")} />);

    expect(screen.getByText("ts")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).not.toBeNull();
    expect(screen.getByTestId("message-text").textContent).toContain("const streaming = true");
  });

  it("keeps renderable streaming code fences in source view", () => {
    render(<MessageText message={message("assistant", "```html\n<main><h1>生成中</h1>", "running")} />);

    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("生成中");
    expect(screen.queryByTitle("HTML 预览")).toBeNull();
    expect(screen.getByRole("button", { name: "预览 HTML" })).not.toBeNull();
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

  it("opens restored image attachments in a body portal and closes with Escape", () => {
    render(
      <MessageText
        message={message("user", "请看图片", "completed", {
          attachments: [
            {
              id: "att-1",
              attachment_id: "att-1",
              type: "image",
              name: "chart.png",
              mime_type: "image/png",
              data_url: "data:image/png;base64,AA==",
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "预览图片 chart.png" }));

    const dialog = screen.getByRole("dialog", { name: "chart.png" });
    expect(dialog.closest('[data-testid="message-text"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    expect(screen.getByLabelText("当前缩放 125%")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "顺时针旋转图片" }));
    expect(screen.getByLabelText("图片预览画布").style.getPropertyValue("--image-rotation")).toBe("90deg");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "chart.png" })).toBeNull();
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

  it("resets message action copy feedback after the footer is left", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    const { container } = render(<MessageText message={message("assistant", "可以复制", "completed")} />);

    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("可以复制");
      expect(container.querySelector('footer[data-copy-state="copied"]')).not.toBeNull();
    });

    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();

    fireEvent.pointerLeave(footer as HTMLElement);

    expect(footer?.getAttribute("data-copy-state")).toBe("idle");
    expect(within(footer as HTMLElement).getByText("复制")).not.toBeNull();
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
    vi.useFakeTimers();
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<MessageText message={message("assistant", "```ts\nconst a = 1;\n```", "running")} />);

    expect(screen.queryByRole("button", { name: "复制消息" })).toBeNull();
    const copyButton = screen.getByRole("button", { name: "复制代码" });
    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("const a = 1;"));
    expect(copyButton.querySelector(".lucide-check")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(copyButton.querySelector(".lucide-copy")).not.toBeNull();
    expect(copyButton.querySelector(".lucide-check")).toBeNull();
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

  it("shows fenced html preview by default and switches back to source", async () => {
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
    expect(screen.queryByTestId("markdown-code-viewport")).toBeNull();
    expect(screen.getByRole("button", { name: "全屏显示 HTML" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("预览标题");
    });
    expect(screen.queryByTitle("HTML 预览")).toBeNull();
  });

  it("shows fenced json preview by default and switches back to source", async () => {
    render(
      <MessageText
        message={message(
          "assistant",
          '```json\n{"users":[{"name":"Ada","role":"admin"}],"enabled":true}\n```',
          "completed",
        )}
      />,
    );

    const viewer = await screen.findByTestId("json-tree-viewer", undefined, { timeout: 15000 });
    expect(viewer).not.toBeNull();
    expect(screen.getByRole("searchbox", { name: "查找 JSON" })).not.toBeNull();
    expect(screen.queryByTestId("markdown-code-viewport")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "查找 JSON" }), { target: { value: "Ada" } });

    expect(screen.getByText("1 / 1")).not.toBeNull();
    expect(screen.getByRole("button", { name: /\$\.users\[0\]\.name/ })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId("markdown-code-viewport").textContent).toContain('"users"');
    });
    expect(screen.queryByTestId("json-tree-viewer")).toBeNull();
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

  it("shows fenced Mermaid preview by default and switches back to source", async () => {
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    expect(screen.getByTestId("mermaid-preview")).not.toBeNull();
    expect(screen.queryByTestId("markdown-code-viewport")).toBeNull();
    expect(screen.getByRole("button", { name: "全屏显示 Mermaid" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();

    expect(screen.queryByText("正在渲染 Mermaid...")).toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText("Mermaid 图表")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("正在切换代码视图")).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("graph TD");
    });
    expect(screen.queryByTestId("mermaid-preview")).toBeNull();
  });

  it("renders inline Mermaid previews inside a bounded preview region", async () => {
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      diagramType: "flowchart-v2",
      svg: '<svg role="img" aria-label="oversized inline chart" viewBox="0 0 2400 1800"></svg>',
    });

    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    const preview = await screen.findByTestId("mermaid-preview");
    const chart = within(preview).getByLabelText("Mermaid 图表");

    expect(preview.getAttribute("data-size")).toBe("inline");
    expect(preview.getAttribute("data-interactive")).toBe("false");
    expect(chart.getAttribute("data-interactive")).toBe("false");
    expect(within(preview).getByLabelText("oversized inline chart")).not.toBeNull();
  });

  it("opens Mermaid code fullscreen with zoom and reset controls", async () => {
    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```", "completed")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Mermaid" }));

    const dialog = screen.getByRole("dialog", { name: "Mermaid 预览" });
    const controls = await within(dialog).findByLabelText("Mermaid 视图控制");
    expect(controls).not.toBeNull();
    expect(within(controls).getByText("100%")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "放大 Mermaid" }));
    await waitFor(() => expect(within(controls).getByText("110%")).not.toBeNull());
    expect(within(dialog).getByRole("button", { name: "缩小 Mermaid" })).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置 Mermaid 视图" }));
    await waitFor(() => expect(within(controls).getByText("100%")).not.toBeNull());

    for (let index = 0; index < 90; index += 1) {
      fireEvent.click(within(dialog).getByRole("button", { name: "放大 Mermaid" }));
    }
    expect(within(controls).getByText("1000%")).not.toBeNull();
  });

  it("normalizes fullscreen Mermaid SVG dimensions before zooming", async () => {
    let renderHostParent: Element | null = null;
    let renderHostWasInsidePreview = false;
    vi.mocked(mermaid.render).mockImplementation(async (_id, _definition, renderHost) => {
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

    await screen.findByLabelText("Mermaid 图表");
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
    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("2640px");
      expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("1320px");
    });
    expect(chart.style.transform).not.toContain("scale");
  });

  it("auto-fits fullscreen Mermaid previews and centers oversized minimum zoom", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      diagramType: "flowchart-v2",
      svg: '<svg role="img" aria-label="oversized chart" width="100%" style="max-width: 320px;" viewBox="0 0 20000 10000"></svg>',
    });

    render(
      <MessageText
        message={message("assistant", "```mermaid\ngraph TD\nA --> B\n```", "completed")}
      />,
    );

    await screen.findByLabelText("Mermaid 图表");
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

    expect(screen.getByRole("button", { name: "查看源码" })).not.toBeNull();
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

    await screen.findByLabelText("Mermaid 图表");
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Mermaid" }));

    await waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), { passive: false });
    });

    const dialog = screen.getByRole("dialog", { name: "Mermaid 预览" });
    const chart = await within(dialog).findByLabelText("Mermaid 图表") as HTMLDivElement;
    fireEvent.wheel(chart, { clientX: 120, clientY: 140, deltaY: -30 });
    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("1.1");
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
    const virtualPreview = dialog.querySelector("[data-markdown-virtual-preview='true']") as HTMLElement;
    expect(virtualPreview).not.toBeNull();
    expect(virtualPreview.getAttribute("data-markdown-scroll-parent")).toBe("self");
  });

  it("virtualizes large completed assistant markdown with the message list scroll parent", async () => {
    render(
      <div data-message-list-scroll="true">
        <MessageText
          message={message("assistant", largeMarkdownSections(120), "completed")}
        />
      </div>,
    );

    await screen.findByTestId("virtuoso-mock");

    const virtualPreview = document.querySelector("[data-markdown-virtual-preview='true']") as HTMLElement;
    const blockCount = Number(virtualPreview.dataset.markdownBlockCount);
    expect(virtualPreview.getAttribute("data-markdown-scroll-parent")).toBe("external");
    expect(screen.getByTestId("virtuoso-mock").getAttribute("data-custom-scroll-parent")).toBe("true");
    expect(blockCount).toBeGreaterThan(96);
    expect(document.querySelectorAll("[data-markdown-block-id]").length).toBeLessThan(blockCount);
    expect(screen.queryByText("Section 119")).toBeNull();
  });

  it("keeps long user markdown on the static message renderer", () => {
    render(
      <div data-message-list-scroll="true">
        <MessageText
          message={message("user", largeMarkdownSections(60), "completed")}
        />
      </div>,
    );

    expect(screen.queryByTestId("virtuoso-mock")).toBeNull();
    expect(document.querySelector("[data-markdown-virtual-preview='true']")).toBeNull();
    expect(document.querySelector("[data-message-markdown-mode='static']")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Section 59" })).not.toBeNull();
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

  it("asks selected message text in the bypass conversation from the floating selection toolbar", async () => {
    const onAskSelectionInBtwConversation = vi.fn();
    const { container } = render(
      <MessageText
        message={message("assistant", "这一段可以旁路追问", "completed")}
        onQuoteSelection={vi.fn()}
        onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
      />,
    );
    const markdown = container.querySelector(".keydex-markdown");
    if (!markdown) {
      throw new Error("markdown container not found");
    }
    const selection = mockSelection(markdown, "这一段可以旁路追问");

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "在旁路对话中询问选中文本" }));

    expect(onAskSelectionInBtwConversation).toHaveBeenCalledWith("这一段可以旁路追问");
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

function largeMarkdownSections(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `## Section ${index}\n\nBody ${index}`,
  ).join("\n\n");
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

function PreviewEntryProbe() {
  const preview = usePreview();
  const entry = preview.entries.at(-1) ?? null;
  return (
    <output data-testid="preview-entry">
      {entry
        ? JSON.stringify({
            request: entry.request,
            revealTarget: entry.revealTarget,
            scopeKey: entry.scopeKey,
          })
        : ""}
    </output>
  );
}

function PreviewHostContextSetter({ context }: { context: PreviewRenderContext }) {
  const { setPreviewHostContext } = usePreview();
  useEffect(() => {
    setPreviewHostContext(context);
    return () => setPreviewHostContext(null);
  }, [context, setPreviewHostContext]);
  return null;
}

function previewEntryPayload() {
  const content = screen.getByTestId("preview-entry").textContent ?? "";
  return JSON.parse(content) as {
    request: Record<string, unknown>;
    revealTarget: Record<string, unknown> | null;
    scopeKey: string;
  };
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
