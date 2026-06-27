import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox, selectedQuoteFromText } from "@/renderer/components/chat/SendBox";

describe("SendBox", () => {
  it("renders a Keydex-like floating input shell without unavailable actions", () => {
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        statusText="回车发送"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("继续输入")).not.toBeNull();
    expect(screen.getByLabelText("继续输入").getAttribute("data-placeholder")).toBe("要求后续变更");
    expect(screen.getByLabelText("继续输入").getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
    expect(screen.queryByText("按需审批")).toBeNull();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tracks focus state and submits when sending is allowed", () => {
    const onSend = vi.fn();
    render(
      <SendBox
        value="继续修改"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    const form = input.closest("form");
    expect(form?.getAttribute("data-focused")).toBe("false");

    fireEvent.focus(input);
    expect(form?.getAttribute("data-focused")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("focuses the contenteditable input when autoFocusKey changes", () => {
    const props = {
      value: "",
      runtimeState: "idle" as const,
      canSend: false,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<SendBox {...props} />);

    const input = screen.getByLabelText("继续输入");
    expect(document.activeElement).not.toBe(input);

    rerender(<SendBox {...props} autoFocusKey="route-1" />);

    expect(document.activeElement).toBe(input);
    (input as HTMLElement).blur();
    window.getSelection()?.removeAllRanges();
  });

  it("keeps runtime controls immediately before the send button", () => {
    render(
      <SendBox
        value="继续修改"
        runtimeState="idle"
        canSend
        canStop={false}
        statusText="回车发送"
        rightControls={<button type="button" aria-label="选择模型">qwen-coder</button>}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const status = screen.getByText("回车发送");
    const model = screen.getByRole("button", { name: "选择模型" });
    const send = screen.getByRole("button", { name: "发送" });

    expect(Boolean(status.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(model.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("keeps the editor writable while running and prevents repeated send", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onChange = vi.fn();
    render(
      <SendBox
        value="继续修改"
        runtimeState="running"
        canSend={false}
        canStop
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(input.getAttribute("aria-disabled")).toBe("false");
    expect(input.getAttribute("contenteditable")).toBe("true");

    input.textContent = "下一条先写好";
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.submit(screen.getByRole("form", { name: "继续对话输入" }));
    expect(onChange).toHaveBeenCalledWith("下一条先写好");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables stop while cancelling and restores send after failure", () => {
    const { rerender } = render(
      <SendBox
        value="继续修改"
        runtimeState="cancelling"
        canSend={false}
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <SendBox
        value="继续修改"
        runtimeState="failed"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "发送" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the composer height adaptive for long multiline input", () => {
    const props = {
      runtimeState: "idle" as const,
      canSend: true,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<SendBox value="短文本" {...props} />);
    const input = screen.getByLabelText("继续输入") as HTMLDivElement;

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 220 });
    rerender(<SendBox value={"第一行\n第二行\n第三行\n第四行"} {...props} />);
    expect(input.style.height).toBe("188px");

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 82 });
    rerender(<SendBox value={"第一行\n第二行"} {...props} />);
    expect(input.style.height).toBe("82px");
  });

  it("respects the computed input max height when resizing multiline content", () => {
    const props = {
      runtimeState: "idle" as const,
      canSend: true,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      variant: "keydex" as const,
    };
    const { rerender } = render(<SendBox value="短文本" {...props} />);
    const input = screen.getByLabelText("继续输入") as HTMLDivElement;
    input.style.maxHeight = "96px";

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 220 });
    rerender(<SendBox value={"第一行\n第二行\n第三行\n第四行\n第五行"} {...props} />);

    expect(input.style.height).toBe("96px");
  });

  it("resizes immediately while editing and shrinks after clearing content", () => {
    const onChange = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入") as HTMLDivElement;
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 188 });
    input.textContent = "第一行\n第二行\n第三行";
    fireEvent.input(input);
    expect(input.style.height).toBe("188px");

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 44 });
    input.textContent = "";
    fireEvent.input(input);
    expect(input.style.height).toBe("44px");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("reports plain contenteditable text changes", () => {
    const onChange = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    input.textContent = "普通输入";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("普通输入");
  });

  it("restores the placeholder state after contenteditable content is cleared", () => {
    const onChange = vi.fn();
    render(
      <SendBox
        value="已输入"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    input.replaceChildren(document.createElement("br"));
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("");
    expect(input.getAttribute("data-empty")).toBe("true");
  });

  it("keeps whitespace-only content as non-empty input", () => {
    const onChange = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    input.textContent = "   ";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("   ");
    expect(input.getAttribute("data-empty")).toBe("false");
  });

  it("keeps bracket syntax as ordinary composer text", () => {
    render(
      <SendBox
        value="[[123]]"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("继续输入").textContent).toBe("[[123]]");
    expect(screen.queryByLabelText("已添加上下文")).toBeNull();
  });

  it("renders external quote requests as removable top context chips", async () => {
    const onChange = vi.fn();
    const quote = selectedQuoteFromText("这是一段选中的历史内容");
    if (!quote) {
      throw new Error("quote not created");
    }
    vi.useFakeTimers();
    try {
      render(
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          externalQuoteRequest={{ requestId: 1, quote }}
          onChange={onChange}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      );

      const input = screen.getByLabelText("继续输入");
      expect(input.textContent).toBe("");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("引用片段");
      fireEvent.mouseOver(screen.getByText("引用片段"));
      act(() => {
        vi.advanceTimersByTime(199);
      });
      expect(screen.queryByText("这是一段选中的历史内容")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText("这是一段选中的历史内容")).not.toBeNull();
      expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    fireEvent.click(screen.getByRole("button", { name: /删除引用片段/ }));

    expect(screen.queryByText("引用片段")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps quote hover cards inside a narrowed composer", () => {
    const quote = selectedQuoteFromText(
      "README.md 引用片段在窄输入框里需要自动换行并保持可见",
      {
        source: "annotation",
        file: {
          path: "README.md",
          name: "README.md",
          lineStart: 69,
          lineEnd: 73,
          sourceStart: 120,
          sourceEnd: 180,
        },
      },
    );
    if (!quote) {
      throw new Error("quote not created");
    }
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(
      this: HTMLElement,
    ) {
      const element = this as HTMLElement;
      if (element.dataset.sendboxRoot === "true") {
        return rect({ x: 32, y: 300, width: 220, height: 124 });
      }
      if (element.dataset.sendboxHoverAnchor === "quote") {
        return rect({ x: 48, y: 318, width: 152, height: 30 });
      }
      if (element.dataset.sendboxContextHoverCard === "true") {
        return rect({ x: -60, y: 120, width: 280, height: 180 });
      }
      return rect({ x: 0, y: 0, width: 0, height: 0 });
    });
    vi.useFakeTimers();
    try {
      render(
        <SendBox
          value="测试"
          runtimeState="idle"
          canSend
          canStop={false}
          externalQuoteRequest={{ requestId: 1, quote }}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      );

      fireEvent.mouseOver(screen.getByText("README.md · L69-L73"));
      act(() => {
        vi.advanceTimersByTime(200);
      });

      const card = document.querySelector<HTMLElement>("[data-sendbox-context-hover-card='true']");
      expect(card).not.toBeNull();
      expect(card?.style.left).toBe("-4px");
      expect(card?.style.maxWidth).toBe("196px");
      expect(card?.style.getPropertyValue("--sendbox-hover-card-translate-x")).toBe("0px");
      expect(card?.style.getPropertyValue("--sendbox-hover-card-arrow-left")).toBe("80px");
    } finally {
      vi.useRealTimers();
      rectSpy.mockRestore();
    }
  });

  it("opens source quote chips with line reveal metadata", async () => {
    const quote = selectedQuoteFromText("引用文件里的片段", {
      source: "selection",
      file: {
        path: "docs/guide.md",
        name: "guide.md",
        lineStart: 12,
        lineEnd: 14,
        sourceStart: 120,
        sourceEnd: 168,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const onOpenFileReference = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        externalQuoteRequest={{ requestId: 1, quote }}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onOpenFileReference={onOpenFileReference}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "打开引用来源 docs/guide.md" }));

    expect(onOpenFileReference).toHaveBeenCalledWith({
      path: "docs/guide.md",
      name: "guide.md",
      type: "file",
      source: "workspace",
      selectedText: "引用文件里的片段",
      lineStart: 12,
      lineEnd: 14,
      sourceStart: 120,
      sourceEnd: 168,
    });
  });

  it("shows annotation comments inside source quote chip details", async () => {
    const quote = selectedQuoteFromText("引用文件里的片段", {
      source: "annotation",
      annotationComment: "Explain this paragraph",
      file: {
        path: "docs/guide.md",
        name: "guide.md",
        lineStart: 12,
        lineEnd: 12,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        externalQuoteRequest={{ requestId: 1, quote }}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const chip = await screen.findByText("guide.md · L12");

    vi.useFakeTimers();
    try {
      fireEvent.mouseOver(chip);
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.getByText(/批注：Explain this paragraph/)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits explicit quote context without hidden composer text", async () => {
    const quote = selectedQuoteFromText("这是一段选中的历史内容");
    if (!quote) {
      throw new Error("quote not created");
    }
    const onSend = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        externalQuoteRequest={{ requestId: 1, quote }}
        onChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    expect(await screen.findByText("引用片段")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith([], [quote]);
  });

  it("hides the quote card when the pointer leaves a top context chip", () => {
    const quote = selectedQuoteFromText("这是一段选中的历史内容");
    if (!quote) {
      throw new Error("quote not created");
    }
    vi.useFakeTimers();
    try {
      render(
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          externalQuoteRequest={{ requestId: 1, quote }}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      );

      const input = screen.getByLabelText("继续输入");
      fireEvent.mouseOver(screen.getByText("引用片段"));
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.getByText("这是一段选中的历史内容")).not.toBeNull();

      const chipWrapper = screen.getByLabelText("已添加上下文").firstElementChild;
      expect(chipWrapper).not.toBeNull();
      fireEvent.mouseLeave(chipWrapper as HTMLElement, { relatedTarget: input });

      act(() => {
        vi.advanceTimersByTime(120);
      });

      expect(screen.queryByText("这是一段选中的历史内容")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps top quote context when editing the visible composer text", () => {
    const quote = selectedQuoteFromText("这是一段选中的历史内容");
    if (!quote) {
      throw new Error("quote not created");
    }
    const onChange = vi.fn();
    render(
      <SendBox
        value="原文"
        runtimeState="idle"
        canSend
        canStop={false}
        externalQuoteRequest={{ requestId: 1, quote }}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    expect(input.textContent).toBe("原文");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("引用片段");

    input.textContent = "更新后正文";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("更新后正文");
  });

  it("adds an external file chip once for a request id", () => {
    const props = {
      value: "",
      runtimeState: "idle" as const,
      canSend: false,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const request = {
      requestId: 1,
      file: {
        path: "src/main.ts",
        name: "main.ts",
        type: "file" as const,
        source: "workspace" as const,
      },
    };
    const { rerender } = render(<SendBox {...props} externalFileRequest={request} />);

    expect(screen.getAllByText("main.ts")).toHaveLength(1);
    expect(screen.queryByText("src/main.ts")).toBeNull();

    rerender(<SendBox {...props} externalFileRequest={request} />);

    expect(screen.getAllByText("main.ts")).toHaveLength(1);
    expect(screen.queryByText("src/main.ts")).toBeNull();
  });

  it("shows the full file path in a hover card for top file chips", () => {
    vi.useFakeTimers();
    const path = "src/features/conversation/components/deeply-nested/FileWithLongName.tsx";

    try {
      render(
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          externalFileRequest={{
            requestId: 1,
            file: {
              path,
              name: "FileWithLongName.tsx",
              type: "file",
              source: "workspace",
            },
          }}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      );

      expect(screen.getByText("FileWithLongName.tsx")).not.toBeNull();
      expect(screen.queryByText(path)).toBeNull();

      fireEvent.mouseEnter(screen.getByText("FileWithLongName.tsx"));
      act(() => {
        vi.advanceTimersByTime(220);
      });

      const hoverCard = document.querySelector('[data-sendbox-context-hover-card="true"]');
      expect(screen.getAllByText("FileWithLongName.tsx").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(path)).toHaveLength(1);
      expect(hoverCard?.textContent).toContain("FileWithLongName.tsx");
      expect(hoverCard?.textContent).toContain(path);
      expect(fireEvent.mouseDown(hoverCard as Element)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an externally added file chip", () => {
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        externalFileRequest={{
          requestId: 1,
          file: {
            path: "src/main.ts",
            name: "main.ts",
            type: "file",
            source: "workspace",
          },
        }}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const fileButtons = screen.getAllByRole("button", { name: /src\/main\.ts/ });
    fireEvent.click(fileButtons[fileButtons.length - 1]);

    expect(screen.queryByText("main.ts")).toBeNull();
  });
});

function rect({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}
