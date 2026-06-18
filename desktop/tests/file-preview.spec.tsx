import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { FilePreview } from "@/renderer/components/workspace";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";

describe("FilePreview", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("reads text file content through workspace runtime", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Hello\n",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "README.md" }} root="D:/repo" runtime={runtime} />);

    expect(await screen.findByLabelText("预览内容")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Hello" })).not.toBeNull();
    expect(runtime.workspace.readFile).toHaveBeenCalledWith("D:/repo", "README.md");
  });

  it("switches markdown preview back to source", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "# Guide\n\n- item",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "guide.md" }} root="D:/repo" runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "Guide" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /源码/ }));

    expect(screen.getByLabelText("预览内容").textContent).toContain("# Guide");
  });

  it("shows markdown source and rendered preview side by side", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "# Guide\n\n正文",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "guide.md" }} root="D:/repo" runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "Guide" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开分屏预览" }));

    expect(screen.getByTestId("preview-split-pane")).not.toBeNull();
    expect(screen.getByLabelText("源码内容").textContent).toContain("# Guide");
    expect(screen.getByLabelText("渲染预览").textContent).toContain("正文");
    expect(screen.getByRole("button", { name: "关闭分屏预览" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders html files in a sandboxed preview frame", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "index.html",
        content: "<main><h1>页面预览</h1><script>window.parent.postMessage('x','*')</script></main>",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "index.html" }} root="D:/repo" runtime={runtime} />);

    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("页面预览");
  });

  it("shows html source and sandboxed preview in split mode", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "index.html",
        content: "<main><h1>页面预览</h1></main>",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "index.html" }} root="D:/repo" runtime={runtime} />);

    expect(await screen.findByTitle("HTML 文件预览")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开分屏预览" }));

    const frame = screen.getByTitle("HTML 文件预览") as HTMLIFrameElement;
    expect(screen.getByLabelText("源码内容").textContent).toContain("<main>");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("页面预览");
  });

  it("renders image files through workspace media runtime", async () => {
    const runtime = fakeRuntime({
      readMedia: vi.fn().mockResolvedValue({
        path: "assets/pixel.png",
        media_type: "image/png",
        size: 68,
        data_url: "data:image/png;base64,abc",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "assets/pixel.png" }} root="D:/repo" runtime={runtime} />);

    const image = (await screen.findByAltText("pixel.png")) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(screen.getByText("image/png")).not.toBeNull();
    expect(screen.getByText("68 B")).not.toBeNull();
    expect(runtime.workspace.readMedia).toHaveBeenCalledWith("D:/repo", "assets/pixel.png");
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("renders direct markdown content requests without workspace runtime", async () => {
    render(
      <FilePreview
        request={{ type: "content", title: "消息片段", content: "# 片段标题\n\n正文", contentType: "markdown" }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "片段标题" })).not.toBeNull();
    expect(screen.getByText(/Markdown 预览/)).not.toBeNull();
  });

  it("quotes selected preview text through the floating selection toolbar", async () => {
    const onQuoteSelection = vi.fn();
    render(
      <FilePreview
        request={{ type: "content", title: "消息片段", content: "# 片段标题\n\n正文内容", contentType: "markdown" }}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const body = await screen.findByLabelText("预览内容");
    const selection = mockSelection(body, "正文内容");
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "添加选中文本到对话" }));

    expect(onQuoteSelection).toHaveBeenCalledWith("正文内容");
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("keeps markdown tables scrollable in preview content", () => {
    const { container } = render(
      <FilePreview
        request={{
          type: "content",
          title: "表格片段",
          content: "| 很长的列 A | 很长的列 B |\n| --- | --- |\n| 内容 | 内容 |",
          contentType: "markdown",
        }}
      />,
    );

    expect(container.querySelector(".codex-markdown-table-scroll")).not.toBeNull();
    expect(screen.getByRole("table")).not.toBeNull();
  });

  it("resolves relative markdown images through workspace media runtime", async () => {
    const runtime = fakeRuntime({
      readMedia: vi.fn().mockResolvedValue({
        path: "docs/assets/pixel.png",
        media_type: "image/png",
        size: 68,
        data_url: "data:image/png;base64,abc",
      }),
    });

    render(
      <FilePreview
        request={{
          type: "content",
          title: "图片片段",
          content: "![示例图片](assets/pixel.png)",
          contentType: "markdown",
          sourcePath: "docs/guide.md",
        }}
        root="D:/repo"
        runtime={runtime}
      />,
    );

    const image = (await screen.findByAltText("示例图片")) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(runtime.workspace.readMedia).toHaveBeenCalledWith("D:/repo", "docs/assets/pixel.png");
  });

  it("switches and closes preview history tabs from the shared preview provider", () => {
    render(
      <PreviewProvider>
        <PreviewTabsHarness />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开 HTML" }));
    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown" }));

    expect(screen.getByRole("tablist", { name: "预览历史" })).not.toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Markdown 片段" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, name: "Markdown 片段" })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "HTML 片段" }));

    expect(screen.getByRole("tab", { name: "HTML 片段" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByTitle("HTML 文件预览") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("HTML 片段");

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 HTML 片段" }));

    expect(screen.queryByRole("tab", { name: "HTML 片段" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Markdown 片段" })).not.toBeNull();
  });

  it("shows backend errors for oversized or binary files", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockRejectedValue(new Error("文件过大，暂不预览")),
    });

    render(<FilePreview request={{ type: "file", path: "large.log" }} root="D:/repo" runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toBe("文件过大，暂不预览");
  });

  it("renders diff request without reading workspace file", () => {
    const runtime = fakeRuntime();

    render(
      <FilePreview
        request={{ type: "diff", path: "src/main.py", diff: "@@\n-print('old')\n+print('new')" }}
        root="D:/repo"
        runtime={runtime}
      />,
    );

    expect(screen.getByText(/Diff 预览/)).not.toBeNull();
    expect(screen.getByLabelText("预览内容").textContent).toContain("+print('new')");
    expect(screen.getByLabelText("Diff 渲染内容")).not.toBeNull();
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("copies preview source content", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "notes.txt",
        content: "可复制内容",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "notes.txt" }} root="D:/repo" runtime={runtime} />);

    await screen.findByLabelText("预览内容");
    fireEvent.click(screen.getByRole("button", { name: "复制预览内容" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("可复制内容");
    });
    expect(screen.getByText("已复制")).not.toBeNull();
  });
});

function fakeRuntime(overrides: Partial<RuntimeBridge["workspace"]> = {}): RuntimeBridge {
  return {
    workspace: {
      readFile: vi.fn(),
      readMedia: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}

function PreviewTabsHarness() {
  const preview = usePreview();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          preview.openPreview({
            type: "content",
            title: "HTML 片段",
            content: "<main><h1>HTML 片段</h1></main>",
            contentType: "html",
          })
        }
      >
        打开 HTML
      </button>
      <button
        type="button"
        onClick={() =>
          preview.openPreview({
            type: "content",
            title: "Markdown 片段",
            content: "# Markdown 片段",
            contentType: "markdown",
          })
        }
      >
        打开 Markdown
      </button>
      {preview.request ? <FilePreview request={preview.request} /> : null}
    </>
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
