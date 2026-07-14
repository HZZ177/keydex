import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SendBox, selectedQuoteFromText, type SelectedFile, type SelectedQuote } from "@/renderer/components/chat/SendBox";
import "@/renderer/components/chat/AtFileMenu/AtFileMenu";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";

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

  it("opens attachment actions from a frameless add button", () => {
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(screen.getByRole("listbox", { name: "添加内容" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "附件" })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "添加内容" })).toBeNull();
  });

  it("adds picked non-image files as regular file context chips in full access mode", async () => {
    const runtime = imagePickerRuntime(["D:/tmp/notes.txt"]);
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        fileAccessMode="full_access"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    expect(await screen.findByRole("button", { name: "移除文件引用 D:/tmp/notes.txt" })).not.toBeNull();
    expect(runtime.attachments.registerImagePath).not.toHaveBeenCalled();
  });

  it("rejects picked non-image files outside workspace when file access is workspace-scoped", async () => {
    const runtime = imagePickerRuntime(["D:/outside/notes.txt"]);
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        fileAccessMode="workspace_trusted"
        workspaceRoots={["D:/workspace"]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    expect(await screen.findByText(/工作区内信任/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "移除文件引用 D:/outside/notes.txt" })).toBeNull();
  });

  it("keeps the regular file picker available when file access is disabled and still accepts images", async () => {
    const runtime = imagePickerRuntime(["D:/tmp/a.png"]);
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        fileAccessMode="no_file_access"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    expect(await screen.findByRole("button", { name: "预览图片 a.png" })).not.toBeNull();
    expect(runtime.desktopPicker.pickFiles).toHaveBeenCalled();
    expect(runtime.desktopPicker.pickImageFiles).not.toHaveBeenCalled();
  });

  it("rejects picked non-image files after selection when file access is disabled", async () => {
    const runtime = imagePickerRuntime(["D:/tmp/notes.txt"]);
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        fileAccessMode="no_file_access"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    expect(await screen.findByText(/无文件访问权限/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "移除文件引用 D:/tmp/notes.txt" })).toBeNull();
    expect(runtime.desktopPicker.pickFiles).toHaveBeenCalled();
  });

  it("shows attachment policy rejections as top notifications when notifications are available", async () => {
    const runtime = imagePickerRuntime(["D:/tmp/notes.txt"]);
    const { container } = render(
      <NotificationProvider>
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          runtime={runtime}
          fileAccessMode="no_file_access"
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    const notification = await screen.findByTestId("notification-item");
    expect(notification.getAttribute("data-type")).toBe("warning");
    expect(notification.textContent).toContain("无文件访问权限");
    expect(container.querySelector("[data-sendbox-file-error]")).toBeNull();
    expect(screen.queryByRole("button", { name: "移除文件引用 D:/tmp/notes.txt" })).toBeNull();
  });

  it("keeps the policy warning when a mixed picker selection adds images but rejects files", async () => {
    const runtime = imagePickerRuntime(["D:/tmp/a.png", "D:/tmp/notes.txt"]);
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        fileAccessMode="no_file_access"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    expect(await screen.findByRole("button", { name: "预览图片 a.png" })).not.toBeNull();
    expect(screen.getByText(/无文件访问权限/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "移除文件引用 D:/tmp/notes.txt" })).toBeNull();
  });

  it("does not restrict the hidden file input accept list when file access is disabled", () => {
    const { container } = render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        fileAccessMode="no_file_access"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.hasAttribute("accept")).toBe(false);
  });

  it("opens the at-file menu with a permission hint when file access is disabled", async () => {
    const searchWorkspace = vi.fn().mockResolvedValue([]);
    render(
      <SendBox
        value="@"
        runtimeState="idle"
        canSend={false}
        canStop={false}
        fileAccessMode="no_file_access"
        onSearchWorkspace={searchWorkspace}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    expect(screen.getByText(/无文件访问权限/)).not.toBeNull();
    expect(searchWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the at-file menu available while the runtime accepts pending input", async () => {
    const searchWorkspace = vi.fn().mockResolvedValue([]);
    render(
      <SendBox
        value="@"
        runtimeState="running"
        canSend
        canStop
        fileAccessMode="workspace_trusted"
        onSearchWorkspace={searchWorkspace}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    await waitFor(() => expect(searchWorkspace).toHaveBeenCalled());
  });

  it("copies file input files before clearing and rejects picker files without source paths", async () => {
    const runtime = fileInputRuntime();
    const { container } = render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    let cleared = false;
    const liveFiles = {
      get length() {
        return cleared ? 0 : 1;
      },
      item: (index: number) => (!cleared && index === 0 ? file : null),
      *[Symbol.iterator]() {
        if (!cleared) {
          yield file;
        }
      },
    } as unknown as FileList;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      get: () => liveFiles,
    });
    Object.defineProperty(fileInput, "value", {
      configurable: true,
      get: () => (cleared ? "" : "C:\\fakepath\\notes.txt"),
      set: (value) => {
        if (value === "") {
          cleared = true;
        }
      },
    });

    fireEvent.change(fileInput);

    expect(await screen.findByText(/无法获取源文件路径/)).not.toBeNull();
    expect(runtime.attachments.uploadLocalFile).not.toHaveBeenCalled();
  });

  it("closes image attachment preview with Escape without invoking composer Escape", async () => {
    const onEscape = vi.fn();
    const runtime = imagePickerRuntime();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onEscape={onEscape}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "附件" }));

    const previewButton = await screen.findByRole("button", { name: "预览图片 a.png" });
    fireEvent.click(previewButton);

    const dialog = screen.getByRole("dialog", { name: "a.png" });
    expect(dialog).not.toBeNull();
    expect(dialog.closest("form")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    expect(screen.getByLabelText("当前缩放 125%")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "顺时针旋转图片" }));
    expect(screen.getByLabelText("图片预览画布").style.getPropertyValue("--image-rotation")).toBe("90deg");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "a.png" })).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("does not flash unsupported-file errors when pasting an image file", async () => {
    const restoreObjectUrl = stubObjectUrl();
    const runtime = imagePickerRuntime();
    const { unmount } = render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        runtime={runtime}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    try {
      const input = screen.getByLabelText("继续输入");
      const file = new File(["image"], "paste.png", { type: "image/png" });

      fireEvent.paste(input, {
        clipboardData: {
          files: fileList(file),
          getData: vi.fn(() => ""),
        },
      });

      expect(screen.queryByText("不支持的文件，无法获取路径")).toBeNull();
      expect(await screen.findByRole("button", { name: "预览图片 paste.png" })).not.toBeNull();
      expect(screen.queryByText("不支持的文件，无法获取路径")).toBeNull();
    } finally {
      unmount();
      restoreObjectUrl();
    }
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
    const quote = selectedQuoteFromText("这是一段选中的历史内容", {
      comment: "请重点检查这里",
    });
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
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("评论");
      expect(screen.queryByText("引用片段")).toBeNull();
      expect(document.querySelector('[data-context-type="comment"]')).not.toBeNull();
      expect(document.querySelector('[data-context-chip-icon="comment"]')).not.toBeNull();
      fireEvent.mouseOver(screen.getByText("评论"));
      act(() => {
        vi.advanceTimersByTime(199);
      });
      expect(document.querySelector('[data-sendbox-context-hover-card="true"]')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const hoverCard = document.querySelector('[data-sendbox-context-hover-card="true"]');
      expect(hoverCard).not.toBeNull();
      const hoverText = hoverCard?.textContent ?? "";
      expect(hoverText).toContain("引用片段：这是一段选中的历史内容");
      expect(hoverText).toContain("评论：请重点检查这里");
      expect(hoverText.indexOf("引用片段：这是一段选中的历史内容")).toBeLessThan(
        hoverText.indexOf("评论：请重点检查这里"),
      );
      expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    fireEvent.click(screen.getByRole("button", { name: /删除评论/ }));

    expect(screen.queryByText("评论")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders batched external quote requests as separate context chips", () => {
    const firstQuote = selectedQuoteFromText("first selected text", {
      source: "selection",
      file: {
        path: "README.md",
        name: "README.md",
        lineStart: 1,
        lineEnd: 1,
      },
    });
    const secondQuote = selectedQuoteFromText("second selected text", {
      source: "selection",
      file: {
        path: "README.md",
        name: "README.md",
        lineStart: 2,
        lineEnd: 2,
      },
    });
    if (!firstQuote || !secondQuote) {
      throw new Error("quotes not created");
    }

    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        externalQuoteRequest={{ requestId: 1, quotes: [firstQuote, secondQuote] }}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText("README.md · L1")).not.toBeNull();
    expect(screen.getByText("README.md · L2")).not.toBeNull();
  });

  it("keeps quote hover cards inside a narrowed composer", () => {
    const quote = selectedQuoteFromText(
      "README.md 引用片段在窄输入框里需要自动换行并保持可见",
      {
        source: "selection",
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
      expect(screen.getByLabelText("已添加上下文").closest("[data-sendbox-root='true']")?.contains(card)).toBe(true);
      expect(card?.style.left).toBe("12px");
      expect(card?.style.top).toBe("10px");
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

    expect(onSend).toHaveBeenCalledWith([], [quote], [], {});
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

      expect(screen.getByText("引用片段：这是一段选中的历史内容")).not.toBeNull();

      const chipWrapper = screen.getByLabelText("已添加上下文").firstElementChild;
      expect(chipWrapper).not.toBeNull();
      fireEvent.mouseLeave(chipWrapper as HTMLElement, { relatedTarget: input });

      act(() => {
        vi.advanceTimersByTime(120);
      });

      expect(screen.queryByText("引用片段：这是一段选中的历史内容")).toBeNull();
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

  it("keeps same-path annotation file requests as separate chips", () => {
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        externalFileRequest={{
          requestId: 1,
          files: [
            {
              id: "annotation:ann-file-1",
              path: "README.md",
              name: "README.md",
              type: "file",
              source: "workspace",
              annotationReference: { annotationId: "ann-file-1", workspaceId: "ws-1", path: "README.md" },
            },
            {
              id: "annotation:ann-file-2",
              path: "README.md",
              name: "README.md",
              type: "file",
              source: "workspace",
              annotationReference: { annotationId: "ann-file-2", workspaceId: "ws-1", path: "README.md" },
            },
          ],
        }}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "文件引用 README.md" })).toHaveLength(2);
  });

  it("removes only the clicked same-path annotation file chip after a controlled batched request", async () => {
    const files: SelectedFile[] = [
      {
        id: "annotation:ann-file-1",
        path: "README.md",
        name: "README.md",
        type: "file",
        source: "workspace",
        annotationReference: { annotationId: "ann-file-1", workspaceId: "ws-1", path: "README.md" },
      },
      {
        id: "annotation:ann-file-2",
        path: "README.md",
        name: "README.md",
        type: "file",
        source: "workspace",
        annotationReference: { annotationId: "ann-file-2", workspaceId: "ws-1", path: "README.md" },
      },
    ];

    function ControlledBatchedFiles() {
      const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
      return (
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          selectedFiles={selectedFiles}
          externalFileRequest={{ requestId: 1, files }}
          onSelectedFilesChange={setSelectedFiles}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      );
    }

    render(<ControlledBatchedFiles />);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "文件引用 README.md" })).toHaveLength(2);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "移除文件引用 README.md" })[1]);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "文件引用 README.md" })).toHaveLength(1);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "移除文件引用 README.md" })[0]);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "文件引用 README.md" })).toBeNull();
    });
  });

  it("removes only the clicked same-path annotation file chip in controlled mode", () => {
    function ControlledSamePathFiles() {
      const [files, setFiles] = useState<SelectedFile[]>([
        {
          id: "annotation:ann-file-1",
          path: "README.md",
          name: "README.md",
          type: "file" as const,
          source: "workspace" as const,
          annotationReference: { annotationId: "ann-file-1", workspaceId: "ws-1", path: "README.md" },
        },
        {
          id: "annotation:ann-file-2",
          path: "README.md",
          name: "README.md",
          type: "file" as const,
          source: "workspace" as const,
          annotationReference: { annotationId: "ann-file-2", workspaceId: "ws-1", path: "README.md" },
        },
      ]);
      return (
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          selectedFiles={files}
          onSelectedFilesChange={setFiles}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      );
    }

    render(<ControlledSamePathFiles />);

    expect(screen.getAllByRole("button", { name: "文件引用 README.md" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "移除文件引用 README.md" })[1]);
    expect(screen.getAllByRole("button", { name: "文件引用 README.md" })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "移除文件引用 README.md" })[0]);
    expect(screen.queryByRole("button", { name: "文件引用 README.md" })).toBeNull();
  });

  it("removes a remaining same-path annotation file chip after deleting the first one", () => {
    function ControlledSamePathFiles() {
      const [files, setFiles] = useState<SelectedFile[]>([
        {
          id: "annotation:ann-file-1",
          path: "README.md",
          name: "README.md",
          type: "file" as const,
          source: "workspace" as const,
          annotationReference: { annotationId: "ann-file-1", workspaceId: "ws-1", path: "README.md" },
        },
        {
          id: "annotation:ann-file-2",
          path: "README.md",
          name: "README.md",
          type: "file" as const,
          source: "workspace" as const,
          annotationReference: { annotationId: "ann-file-2", workspaceId: "ws-1", path: "README.md" },
        },
      ]);
      return (
        <SendBox
          value=""
          runtimeState="idle"
          canSend={false}
          canStop={false}
          selectedFiles={files}
          onSelectedFilesChange={setFiles}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      );
    }

    render(<ControlledSamePathFiles />);

    fireEvent.click(screen.getAllByRole("button", { name: "移除文件引用 README.md" })[0]);
    expect(screen.getAllByRole("button", { name: "文件引用 README.md" })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "移除文件引用 README.md" })[0]);
    expect(screen.queryByRole("button", { name: "文件引用 README.md" })).toBeNull();
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

  it("shows annotation type and summary instead of a fixed annotation label and file path", () => {
    vi.useFakeTimers();
    const path = "docs/README.md";

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
              name: "README.md",
              type: "file",
              source: "workspace",
              annotationReference: {
                annotationId: "ann-alpha",
                body: "  Explain   the alpha section\nwith more context.  ",
                kind: "text",
                path,
                workspaceId: "ws-1",
              },
            },
          }}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      );

      fireEvent.mouseEnter(screen.getByText("README.md"));
      act(() => {
        vi.advanceTimersByTime(220);
      });

      const hoverCard = document.querySelector('[data-sendbox-context-hover-card="true"]');
      expect(hoverCard?.textContent).toContain("README.md");
      expect(hoverCard?.textContent).toContain("选区批注");
      expect(hoverCard?.textContent).toContain("Explain the alpha section with more context.");
      expect(hoverCard?.textContent).not.toContain(path);
      expect(hoverCard?.textContent).not.toContain("批注引用");
      expect(hoverCard?.textContent).not.toContain("文档批注");
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

function imagePickerRuntime(pickedFiles: string[] = ["D:/tmp/a.png"]): RuntimeBridge {
  return {
    attachments: {
      registerImagePath: vi.fn().mockResolvedValue({
        id: "att-1",
        attachment_id: "att-1",
        name: "a.png",
        path: "D:/tmp/a.png",
        mime_type: "image/png",
        size: 12,
        source: "picker",
      }),
      readMedia: vi.fn().mockResolvedValue({
        data_url: "data:image/png;base64,AA==",
      }),
      uploadImage: vi.fn().mockImplementation((file: File) =>
        Promise.resolve({
          id: "att-paste",
          attachment_id: "att-paste",
          name: file.name,
          path: "",
          mime_type: file.type,
          size: file.size,
          source: "pasted",
        }),
      ),
      uploadLocalFile: vi.fn().mockImplementation((file: File) =>
        Promise.resolve({
          id: "local-file-1",
          name: file.name || "file",
          path: `D:/tmp/${file.name || "file"}`,
          mime_type: file.type || "application/octet-stream",
          size: file.size,
          source: "pasted",
        }),
      ),
    },
    desktopPicker: {
      isFilePickerAvailable: vi.fn().mockReturnValue(true),
      pickFiles: vi.fn().mockResolvedValue(pickedFiles),
      pickImageFiles: vi.fn().mockResolvedValue(["D:/tmp/a.png"]),
    },
  } as unknown as RuntimeBridge;
}

function fileInputRuntime(): RuntimeBridge {
  return {
    attachments: {
      uploadLocalFile: vi.fn().mockResolvedValue({
        id: "local-file-1",
        name: "notes.txt",
        path: "D:/tmp/notes.txt",
        mime_type: "text/plain",
        size: 5,
        source: "picker",
      }),
    },
    desktopPicker: {
      isFilePickerAvailable: vi.fn().mockReturnValue(false),
    },
  } as unknown as RuntimeBridge;
}

function fileList(...files: File[]): FileList {
  return Object.assign(files, {
    item: (index: number) => files[index] ?? null,
  }) as unknown as FileList;
}

function stubObjectUrl(): () => void {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:keydex-test-image"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  return () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreate,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevoke,
    });
  };
}

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
