import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid, { type ParseResult, type RenderResult } from "mermaid";

import type { DocumentReadResult, RuntimeBridge } from "@/runtime";
import { FilePreview, type MarkdownOutlineItem, type MarkdownOutlineRevealRequest } from "@/renderer/components/workspace";
import { APP_FIND_SHORTCUT_EVENT } from "@/renderer/events/findShortcut";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";

const mermaidParseResult: ParseResult = { diagramType: "flowchart-v2", config: {} };
const mermaidRenderResult: RenderResult = {
  diagramType: "flowchart-v2",
  svg: '<svg role="img" aria-label="测试图表" width="100%" style="max-width: 320px;" viewBox="0 0 2400 1200"></svg>',
};

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue({ diagramType: "flowchart-v2", config: {} }),
    render: vi.fn().mockResolvedValue({
      diagramType: "flowchart-v2",
      svg: '<svg role="img" aria-label="测试图表" width="100%" style="max-width: 320px;" viewBox="0 0 2400 1200"></svg>',
    }),
  },
}));

let restoreElementMetrics: (() => void) | null = null;
let restorePreviewRangeMetrics: (() => void) | null = null;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class AutoLoadingImage {
  decoding = "async";
  referrerPolicy = "";
  naturalWidth = 320;
  naturalHeight = 180;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private value = "";
  get src() { return this.value; }
  set src(value: string) {
    this.value = value;
    if (value) queueMicrotask(() => this.onload?.());
  }
  decode() { return Promise.resolve(); }
}

afterEach(() => {
  restoreElementMetrics?.();
  restoreElementMetrics = null;
  restorePreviewRangeMetrics?.();
  restorePreviewRangeMetrics = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FilePreview", () => {
  beforeEach(() => {
    if (typeof ResizeObserver === "undefined") {
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    }
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.mocked(mermaid.parse).mockResolvedValue(mermaidParseResult);
    vi.mocked(mermaid.render).mockResolvedValue(mermaidRenderResult);
    const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect({ left: 0, top: 0, width: 80, height: 20 }),
    });
    vi.stubGlobal("Image", AutoLoadingImage);
    Object.defineProperty(window, "Image", { configurable: true, value: AutoLoadingImage });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [testRect({ left: 0, top: 0, width: 80, height: 20 })],
    });
    restorePreviewRangeMetrics = () => {
      if (rangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRect);
      else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
      else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
    };
  });

  it("reads text file content through workspace runtime", async () => {
    const runtime = fakeRuntime({
      readDocument: vi.fn().mockResolvedValue({
        document_id: "workspace:session:ses-1:README.md",
        source: "workspace",
        path: "README.md",
        content: "# Hello\n",
        encoding: "utf-8",
        revision: "sha256:readme",
        total_bytes: 8,
      }),
    });

    render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

    expect(await screen.findByLabelText("预览内容")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Hello" })).not.toBeNull();
    expect(document.querySelector("[data-file-preview-root='true']")?.getAttribute("data-document-revision"))
      .toBe("sha256:readme");
    expect(runtime.workspace.readDocument).toHaveBeenCalledWith(
      { sessionId: "ses-1" },
      "README.md",
      expect.objectContaining({
        consumerId: expect.stringMatching(/^file-preview-/u),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("loads a local file through the shared document snapshot pipeline", async () => {
    const readDocument = vi.fn().mockResolvedValue({
      document_id: "tauri:D:/notes/local.md",
      source: "tauri",
      path: "D:/notes/local.md",
      revision: "sha256:local-snapshot",
      encoding: "utf-8",
      total_bytes: 15,
      content: "# Local snapshot",
    });
    const runtime = {
      localPreview: {
        readFile: vi.fn(),
        readDocument,
        readMedia: vi.fn(),
      },
    } as unknown as RuntimeBridge;

    render(<FilePreview request={{ type: "local-file", path: "D:/notes/local.md" }} runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "Local snapshot" })).not.toBeNull();
    expect(readDocument).toHaveBeenCalledWith(
      "D:/notes/local.md",
      expect.objectContaining({
        consumerId: expect.stringMatching(/^file-preview-/u),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(document.querySelector("[data-file-preview-root='true']")?.getAttribute("data-document-revision"))
      .toBe("sha256:local-snapshot");
  });

  it("keeps A/B late results out of the preview after a rapid switch to C", async () => {
    const resolvers = new Map<string, (value: DocumentReadResult) => void>();
    const signals = new Map<string, AbortSignal>();
    const readDocument = vi.fn((_scope: unknown, path: string, options: { signal: AbortSignal }) => {
      signals.set(path, options.signal);
      return new Promise<DocumentReadResult>((resolve) => resolvers.set(path, resolve));
    });
    const runtime = fakeRuntime({ readDocument });
    const rendered = render(
      <FilePreview request={{ type: "file", path: "A.md" }} sessionId="ses-1" runtime={runtime} />,
    );
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(1));
    rendered.rerender(
      <FilePreview request={{ type: "file", path: "B.md" }} sessionId="ses-1" runtime={runtime} />,
    );
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(2));
    rendered.rerender(
      <FilePreview request={{ type: "file", path: "C.md" }} sessionId="ses-1" runtime={runtime} />,
    );
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(3));

    const snapshot = (path: string) => ({
      document_id: `workspace:${path}`,
      source: "workspace" as const,
      path,
      revision: `sha256:${path}`,
      encoding: "utf-8" as const,
      total_bytes: path.length + 2,
      content: `# ${path}`,
    });
    resolvers.get("C.md")?.(snapshot("C.md"));
    resolvers.get("B.md")?.(snapshot("B.md"));
    resolvers.get("A.md")?.(snapshot("A.md"));

    expect(await screen.findByRole("heading", { name: "C.md" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "A.md" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "B.md" })).toBeNull();
    expect(signals.get("A.md")?.aborted).toBe(true);
    expect(signals.get("B.md")?.aborted).toBe(true);
    expect(signals.get("C.md")?.aborted).toBe(false);
  });

  it("renders large panel markdown without the old preparation skeleton", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: `# Project\n\n${"Large section text.\n".repeat(3000)}`,
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} chrome="panel" />);

    expect(screen.queryByRole("status", { name: "正在准备预览" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Project" })).not.toBeNull();
    expect(screen.queryByRole("status", { name: "正在准备预览" })).toBeNull();
  });

  it("applies a panel bottom safe area to scrollable preview content", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Safe Area\n\nLast line should clear the assistant capsule.",
        encoding: "utf-8",
      }),
    });

    render(
      <FilePreview
        request={{ type: "file", path: "README.md" }}
        sessionId="ses-1"
        runtime={runtime}
        chrome="panel"
        bottomSafeArea="140px"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Safe Area" })).not.toBeNull();
    const root = document.querySelector<HTMLElement>("[data-file-preview-root='true']");
    expect(root?.getAttribute("data-bottom-safe-area")).toBe("true");
    expect(root?.style.getPropertyValue("--file-preview-content-bottom-safe-area")).toBe("140px");
    expect(
      document.querySelector("[data-workspace-document-path='README.md']")?.getAttribute("data-bottom-safe-area"),
    ).toBe("true");
    expect(document.querySelector("[data-file-preview-bottom-safe-area='true']")).not.toBeNull();
  });

  it("keeps panel file previews loading through the open animation", async () => {
    let resolveRead:
      | ((value: { content: string; encoding: string; path: string; revision: string }) => void)
      | null = null;
    const runtime = fakeRuntime({
      readFile: vi.fn(
        () =>
          new Promise<{ content: string; encoding: string; path: string; revision: string }>((resolve) => {
            resolveRead = resolve;
          }),
      ),
    });

    render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} chrome="panel" />);

    await act(async () => {
      resolveRead?.({
        path: "README.md",
        content: "# Small Project\n\nShort but potentially complex.",
        encoding: "utf-8",
        revision: "sha256:small",
      });
    });

    expect(screen.queryByRole("heading", { name: "Small Project" })).toBeNull();
    expect(screen.getByRole("status")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Small Project" })).not.toBeNull();
  });

  it("keeps large markdown parsing out of the file-read completion frame", async () => {
    const largeMarkdown = `# Deferred Project\n\n${"Large section text.\n".repeat(3000)}`;
    let resolveRead:
      | ((value: { content: string; encoding: string; path: string; revision: string }) => void)
      | null = null;
    const runtime = fakeRuntime({
      readFile: vi.fn(
        () =>
          new Promise<{ content: string; encoding: string; path: string; revision: string }>((resolve) => {
            resolveRead = resolve;
          }),
      ),
    });

    render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} chrome="panel" />);

    await act(async () => {
      resolveRead?.({
        path: "README.md",
        content: largeMarkdown,
        encoding: "utf-8",
        revision: "sha256:large",
      });
    });

    expect(screen.queryByRole("heading", { name: "Deferred Project" })).toBeNull();
    expect(screen.getByRole("status")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Deferred Project" })).not.toBeNull();
  });

  it("selects only rendered preview content with Ctrl+A", async () => {
    window.getSelection()?.removeAllRanges();
    render(
      <FilePreview
        request={{
          type: "content",
          title: "Markdown snippet",
          content: "# Preview Select\n\nAlpha content",
          contentType: "markdown",
        }}
      />,
    );

    const body = await screen.findByLabelText("预览内容");
    fireEvent.mouseEnter(body);

    expect(fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true })).toBe(false);
    const selectedText = window.getSelection()?.toString() ?? "";
    expect(selectedText).toContain("Preview Select");
    expect(selectedText).toContain("Alpha content");
    expect(selectedText).not.toContain("复制预览内容");
  });

  it("uses the original preview scroll rail to drive the shared markdown document viewport", async () => {
    mockSourceScrollMetrics({ clientWidth: 640, clientHeight: 200, scrollHeight: 1000 });
    render(
      <FilePreview
        request={{
          type: "content",
          title: "Markdown preview",
          content: `# Preview\n\n${"Long preview paragraph.\n\n".repeat(120)}`,
          contentType: "markdown",
        }}
      />,
    );

    const viewport = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const canvas = viewport.firstElementChild as HTMLElement;
    const annotationRail = viewport.querySelector<HTMLElement>("[data-annotation-rail='true']");
    const scrollRail = await screen.findByTestId("preview-scroll-rail");
    await waitFor(() => expect(scrollRail.getAttribute("data-visible")).toBe("true"));

    expect(canvas.contains(screen.getByText("Preview"))).toBe(true);
    expect(annotationRail).not.toBeNull();
    expect(canvas.contains(annotationRail)).toBe(true);
    expect(viewport.getAttribute("data-custom-scrollbar")).toBe("true");

    viewport.scrollTop = 0;
    dispatchPointer(scrollRail, "pointerdown", { clientX: 636, clientY: 20, pointerId: 8 });
    dispatchPointer(scrollRail, "pointermove", { clientX: 420, clientY: 80, pointerId: 8 });
    dispatchPointer(scrollRail, "pointerup", { clientX: 420, clientY: 80, pointerId: 8 });

    expect(viewport.scrollTop).toBeGreaterThan(0);
  });

  it("opens an in-preview search bar for Ctrl+F and navigates matches", async () => {
    const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect({ top: 0, bottom: 100, height: 100 }),
    });
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        return this.startOffset > 0
          ? testRect({ top: 24, bottom: 44, height: 20 })
          : testRect({ top: -80, bottom: -60, height: 20 });
      },
    });
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Guide\n\nAlpha beta alpha",
        encoding: "utf-8",
      }),
    });
    let selection: ReturnType<typeof mockSelection> | null = null;

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      const body = await screen.findByLabelText("预览内容");
      fireEvent.mouseEnter(body);
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: document.body,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容");
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
      expect((input as HTMLInputElement).value).toBe("");
      fireEvent.change(input, { target: { value: "alpha" } });

      await waitFor(() => {
        expect(within(search).getByText("2/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(2);
        expect(body.querySelectorAll("[data-file-preview-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(
          Array.from(body.querySelectorAll("[data-file-preview-find-match='true']")).every((mark) =>
            mark.className.includes("findMark"),
          ),
        ).toBe(true);
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")[0].getAttribute("data-active")).toBe(
          "false",
        );
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")[1].getAttribute("data-active")).toBe(
          "true",
        );
      });
      const firstFindMark = body.querySelector("[data-file-preview-find-match='true']");
      expect(firstFindMark).not.toBeNull();
      act(() => {
        document.dispatchEvent(new Event("selectionchange"));
        window.dispatchEvent(new Event("pointerup"));
        window.dispatchEvent(new Event("focusin"));
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      });
      expect(body.querySelector("[data-file-preview-find-match='true']")).toBe(firstFindMark);
      fireEvent.pointerUp(body);
      await waitFor(() => {
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(2);
      });
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      });
      scrollIntoView.mockClear();
      fireEvent.click(within(search).getByRole("button", { name: "下一个搜索结果" }));
      await waitFor(() => {
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true'][data-active='true']")).toHaveLength(1);
      });
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      });

      (input as HTMLInputElement).blur();
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: document.body,
            },
          }),
        );
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
      expect((input as HTMLInputElement).value).toBe("alpha");

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await waitFor(() => {
        expect(screen.queryByRole("search", { name: "文件内容搜索" })).toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(0);
      });

      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: document.body,
            },
          }),
        );
      });
      const reopenedSearch = await screen.findByRole("search", { name: "文件内容搜索" });
      const reopenedInput = within(reopenedSearch).getByLabelText("搜索文件内容");
      await waitFor(() => {
        expect(document.activeElement).toBe(reopenedInput);
      });
      expect((reopenedInput as HTMLInputElement).value).toBe("");

      selection = mockSelection(body, "beta");
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: document.body,
            },
          }),
        );
      });
      await waitFor(() => {
        expect((reopenedInput as HTMLInputElement).value).toBe("beta");
        expect(within(reopenedSearch).getByText("1/1")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(1);
      });
    } finally {
      selection?.restore();
      if (scrollDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element["scrollIntoView"] }).scrollIntoView;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", elementRectDescriptor);
      } else {
        delete (HTMLElement.prototype as { getBoundingClientRect?: HTMLElement["getBoundingClientRect"] }).getBoundingClientRect;
      }
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getBoundingClientRect?: Range["getBoundingClientRect"] }).getBoundingClientRect;
      }
    }
  });

  it("prefills search from selected rendered markdown inline code", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "这里有 `重点`，还有一个重点。",
        encoding: "utf-8",
      }),
    });
    let selection: ReturnType<typeof mockSelection> | null = null;

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      const body = await screen.findByLabelText("预览内容");
      const inlineCode = body.querySelector("code");
      expect(inlineCode).not.toBeNull();
      selection = mockSelection(inlineCode as Element, "重点");
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: inlineCode,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容") as HTMLInputElement;
      await waitFor(() => {
        expect(input.value).toBe("重点");
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(2);
      });
    } finally {
      selection?.restore();
    }
  });

  it("finds selected rendered markdown ranges that cross inline syntax nodes", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "前缀 `重点内容` 后缀\n\n前缀 重点内容 后缀",
        encoding: "utf-8",
      }),
    });
    let selection: ReturnType<typeof mockSelection> | null = null;

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      const body = await screen.findByLabelText("预览内容");
      selection = mockSelection(body, "前缀 重点内容 后缀");
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: body,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容") as HTMLInputElement;
      await waitFor(() => {
        expect(input.value).toBe("前缀 重点内容 后缀");
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(2);
      });
    } finally {
      selection?.restore();
    }
  });

  it("finds selected rendered markdown ranges across preview line breaks", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "第一行 `重点`\n第二行 结束\n\n第一行 重点 第二行 结束",
        encoding: "utf-8",
      }),
    });
    let selection: ReturnType<typeof mockSelection> | null = null;

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      const body = await screen.findByLabelText("预览内容");
      selection = mockSelection(body, "第一行 重点\n第二行 结束");
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: body,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容") as HTMLInputElement;
      await waitFor(() => {
        expect(input.value).toContain("第一行");
        expect(input.value).toContain("第二行 结束");
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(2);
      });
    } finally {
      selection?.restore();
    }
  });

  it("highlights source search matches and the active source hit", async () => {
    const rangeClientRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn();
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [testRect({ left: 0, right: 120, top: 0, bottom: 20, width: 120, height: 20 })],
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Guide\n\nAlpha beta\n\nalpha",
        encoding: "utf-8",
      }),
    });

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      await screen.findByRole("heading", { name: "Guide" });
      fireEvent.click(screen.getByRole("button", { name: "源码" }));
      const body = screen.getByLabelText("预览内容");
      fireEvent.mouseEnter(body);
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: body,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容");
      fireEvent.change(input, { target: { value: "alpha" } });

      await waitFor(() => {
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true']")).toHaveLength(2);
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      });

      scrollTo.mockClear();
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(within(search).getByText("2/2")).not.toBeNull();
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      });
    } finally {
      if (rangeClientRectsDescriptor) {
        Object.defineProperty(Range.prototype, "getClientRects", rangeClientRectsDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: Range["getClientRects"] }).getClientRects;
      }
      if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
      } else {
        delete (HTMLElement.prototype as { scrollTo?: HTMLElement["scrollTo"] }).scrollTo;
      }
    }
  });

  it("does not vertically recenter source search when stepping between hits on the same line", async () => {
    const rangeClientRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn();
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [testRect({ left: 0, right: 120, top: 0, bottom: 20, width: 120, height: 20 })],
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Guide\n\nAlpha beta alpha",
        encoding: "utf-8",
      }),
    });

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      await screen.findByRole("heading", { name: "Guide" });
      fireEvent.click(screen.getByRole("button", { name: "源码" }));
      const body = screen.getByLabelText("预览内容");
      fireEvent.mouseEnter(body);
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: body,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容");
      fireEvent.change(input, { target: { value: "alpha" } });

      await waitFor(() => {
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      });
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      });
      scrollTo.mockClear();

      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(within(search).getByText("2/2")).not.toBeNull();
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveLength(1);
      });
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      });
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      if (rangeClientRectsDescriptor) {
        Object.defineProperty(Range.prototype, "getClientRects", rangeClientRectsDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: Range["getClientRects"] }).getClientRects;
      }
      if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
      } else {
        delete (HTMLElement.prototype as { scrollTo?: HTMLElement["scrollTo"] }).scrollTo;
      }
    }
  });

  it("deduplicates source and preview find matches while split and keeps both panes active", async () => {
    const rangeClientRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
    const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [testRect({ left: 0, right: 120, top: 0, bottom: 20, width: 120, height: 20 })],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect({ left: 0, right: 120, top: 0, bottom: 20, width: 120, height: 20 }),
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect({ left: 0, right: 320, top: 0, bottom: 240, width: 320, height: 240 }),
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Guide\n\nAlpha beta alpha",
        encoding: "utf-8",
      }),
    });

    try {
      render(<FilePreview request={{ type: "file", path: "README.md" }} sessionId="ses-1" runtime={runtime} />);

      await screen.findByRole("heading", { name: "Guide" });
      fireEvent.click(screen.getByRole("button", { name: "分屏" }));
      const body = screen.getByLabelText("预览内容");
      expect(screen.getByTestId("preview-split-pane")).not.toBeNull();
      fireEvent.mouseEnter(body);
      act(() => {
        document.dispatchEvent(
          new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
            detail: {
              sourceTarget: body,
            },
          }),
        );
      });

      const search = await screen.findByRole("search", { name: "文件内容搜索" });
      const input = within(search).getByLabelText("搜索文件内容");
      fireEvent.change(input, { target: { value: "alpha" } });

      await waitFor(() => {
        expect(within(search).getByText("1/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true']")).toHaveLength(2);
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true']")).toHaveLength(2);
        expect(body.querySelectorAll("[data-file-preview-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveLength(1);
      });
      const activePreviewBefore = body.querySelector("[data-file-preview-find-match='true'][data-active='true']");
      const activeSourceBefore = document.querySelector("[data-file-preview-source-find-match='true'][data-active='true']");
      expect(activePreviewBefore).not.toBeNull();
      expect(activeSourceBefore).not.toBeNull();
      const activePreviewIdBefore = activePreviewBefore?.getAttribute("data-find-match-id");
      const activeSourceStartBefore = activeSourceBefore?.getAttribute("data-source-start");

      fireEvent.click(within(search).getByRole("button", { name: "下一个搜索结果" }));

      await waitFor(() => {
        expect(within(search).getByText("2/2")).not.toBeNull();
        expect(body.querySelectorAll("[data-file-preview-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(document.querySelectorAll("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveLength(1);
        expect(
          body.querySelector("[data-file-preview-find-match='true'][data-active='true']")?.getAttribute("data-find-match-id"),
        ).not.toBe(activePreviewIdBefore);
        expect(
          document
            .querySelector("[data-file-preview-source-find-match='true'][data-active='true']")
            ?.getAttribute("data-source-start"),
        ).not.toBe(
          activeSourceStartBefore,
        );
      });
    } finally {
      if (rangeClientRectsDescriptor) {
        Object.defineProperty(Range.prototype, "getClientRects", rangeClientRectsDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: Range["getClientRects"] }).getClientRects;
      }
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getBoundingClientRect?: Range["getBoundingClientRect"] }).getBoundingClientRect;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", elementRectDescriptor);
      } else {
        delete (HTMLElement.prototype as { getBoundingClientRect?: HTMLElement["getBoundingClientRect"] }).getBoundingClientRect;
      }
      if (scrollDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element["scrollIntoView"] }).scrollIntoView;
      }
    }
  });

  it("renders code files with CodeMirror source viewer and line numbers", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "src/App.tsx",
        content: "const value = 1;\nexport default value;\n",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "src/App.tsx" }} sessionId="ses-1" runtime={runtime} />);

    const sourceViewer = await screen.findByTestId("file-source-viewer");
    expect(sourceViewer.getAttribute("data-renderer")).toBe("codemirror");
    await waitFor(() => {
      expect(sourceViewer.textContent).toContain("const");
      expect(sourceViewer.textContent).toContain("1");
      expect(sourceViewer.textContent).toContain("2");
    });
  });

  it("renders toml files in the source viewer", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "pyproject.toml",
        content: '[tool.pytest.ini_options]\nasyncio_mode = "auto"\n',
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "pyproject.toml" }} sessionId="ses-1" runtime={runtime} />);

    const sourceViewer = await screen.findByTestId("file-source-viewer");
    expect(sourceViewer.getAttribute("data-renderer")).toBe("codemirror");
    await waitFor(() => {
      expect(sourceViewer.textContent).toContain("tool.pytest.ini_options");
      expect(sourceViewer.textContent).toContain("asyncio_mode");
    });
  });

  it("mounts CodeMirror inside the shared document viewport controlled by the preview scroll rail", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "src/App.tsx",
        content: Array.from({ length: 120 }, (_, index) => `const value${index} = ${index};`).join("\n"),
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "src/App.tsx" }} sessionId="ses-1" runtime={runtime} />);

    const sourceViewer = await screen.findByTestId("file-source-viewer");
    const viewport = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const scroller = await waitFor(() => {
      const element = sourceViewer.querySelector<HTMLElement>(".cm-scroller");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    expect(viewport.contains(scroller)).toBe(true);
    expect(viewport.querySelector("[data-annotation-rail='true']")).not.toBeNull();
    expect(screen.queryByTestId("source-scroll-rail")).toBeNull();
    expect(screen.getByTestId("preview-scroll-rail")).not.toBeNull();
  });

  it("renders enlarged centered fold controls in CodeMirror source viewer", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "src/App.tsx",
        content: "function run() {\n  const value = 1;\n  return value;\n}\n",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "src/App.tsx" }} sessionId="ses-1" runtime={runtime} />);

    const sourceViewer = await screen.findByTestId("file-source-viewer");
    await waitFor(() => {
      const foldButton = sourceViewer.querySelector(".cm-fileFoldMarker[data-open='true']");
      expect(foldButton).not.toBeNull();
      expect(foldButton?.getAttribute("title")).toBe("折叠代码块");
    });
  });

  it("switches markdown preview back to source", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "# Guide\n\n- item",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "guide.md" }} sessionId="ses-1" runtime={runtime} />);

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

    render(<FilePreview request={{ type: "file", path: "guide.md" }} sessionId="ses-1" runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "Guide" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分屏" }));

    expect(screen.getByTestId("preview-split-pane")).not.toBeNull();
    expect(screen.getByLabelText("源码内容").textContent).toContain("# Guide");
    await waitFor(() => expect(screen.getByLabelText("渲染预览").textContent).toContain("正文"));
    expect(screen.getByRole("button", { name: "分屏" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps one virtualized line gutter in the right preview pane while split", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "# Guide\n\nfirst line\nsecond line\n\nTail",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "guide.md" }} sessionId="ses-1" runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "Guide" })).not.toBeNull();
    const gutter = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-markdown-preview-source-gutter='true']");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(gutter.textContent).toContain("1");
    expect(gutter.textContent).toContain("3\n4");
    expect(gutter.querySelector("pre")).toBeNull();
    expect(gutter.querySelector("[data-markdown-preview-fold-button='true']")).not.toBeNull();
    expect(gutter.querySelector("[data-markdown-preview-fold-placeholder='true']")).not.toBeNull();

    const modeButtons = document.querySelectorAll<HTMLButtonElement>("[class*='segmented'] button");
    fireEvent.click(modeButtons[2]!);
    const split = screen.getByTestId("preview-split-pane");
    const panels = split.querySelectorAll("section");
    const splitGutters = document.querySelectorAll<HTMLElement>("[data-markdown-preview-source-gutter='true']");
    expect(splitGutters).toHaveLength(1);
    expect(panels[1]?.contains(splitGutters[0]!)).toBe(true);
    expect(panels[0]?.contains(splitGutters[0]!)).toBe(false);
    await waitFor(() => {
      expect(panels[1]?.querySelectorAll("[data-markdown-preview-fold-button='true']").length).toBeGreaterThan(0);
    });
  });

  it("reveals markdown outline targets in both source and preview panes while split", async () => {
    const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "# Guide\n\nIntro\n\n## Setup\n\nRun it.",
        encoding: "utf-8",
      }),
    });

    try {
      render(<MarkdownOutlineRevealHarness runtime={runtime} />);

      expect(await screen.findByRole("heading", { name: "Guide" })).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "分屏" }));
      expect(screen.getByTestId("preview-split-pane")).not.toBeNull();

      const revealButton = await screen.findByRole("button", { name: "定位 Setup 大纲" });
      await waitFor(() => {
        expect((revealButton as HTMLButtonElement).disabled).toBe(false);
      });
      fireEvent.click(revealButton);

      await waitFor(() => {
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      });
    } finally {
      if (scrollDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element["scrollIntoView"] }).scrollIntoView;
      }
      if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
      } else {
        delete (HTMLElement.prototype as { scrollTo?: HTMLElement["scrollTo"] }).scrollTo;
      }
    }
  });

  it("renders html files in a sandboxed preview frame", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "index.html",
        content: "<main><h1>页面预览</h1><script>window.parent.postMessage('x','*')</script></main>",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "index.html" }} sessionId="ses-1" runtime={runtime} />);

    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("页面预览");
  });

  it("renders direct html content into the sandboxed frame without an empty first document", () => {
    const html = "<style>h1 { color: rgb(220, 38, 38); }</style><main><h1>面板样式</h1></main>";

    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "HTML 预览",
          content: html,
          contentType: "html",
        }}
      />,
    );

    const frame = screen.getByTitle("HTML 文件预览") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<style>h1 { color: rgb(220, 38, 38); }</style>");
    expect(frame.getAttribute("srcdoc")).toContain("面板样式");
    expect(frame.getAttribute("srcdoc")).not.toContain("文件为空");
  });

  it("shows html source and sandboxed preview in split mode", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "index.html",
        content: "<main><h1>页面预览</h1></main>",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "index.html" }} sessionId="ses-1" runtime={runtime} />);

    expect(await screen.findByTitle("HTML 文件预览")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分屏" }));

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

    render(<FilePreview request={{ type: "file", path: "assets/pixel.png" }} sessionId="ses-1" runtime={runtime} />);

    const image = (await screen.findByAltText("pixel.png")) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(screen.getByText("image/png")).not.toBeNull();
    expect(screen.getByText("68 B")).not.toBeNull();
    expect(runtime.workspace.readMedia).toHaveBeenCalledWith({ sessionId: "ses-1" }, "assets/pixel.png");
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("supports zooming and panning image previews", async () => {
    const runtime = fakeRuntime({
      readMedia: vi.fn().mockResolvedValue({
        path: "assets/pixel.png",
        media_type: "image/png",
        size: 68,
        data_url: "data:image/png;base64,abc",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "assets/pixel.png" }} sessionId="ses-1" runtime={runtime} />);

    const image = (await screen.findByAltText("pixel.png")) as HTMLImageElement;
    const canvas = screen.getByLabelText("图片预览画布") as HTMLDivElement;

    expect(screen.getByLabelText("当前缩放 100%")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));

    expect(screen.getByLabelText("当前缩放 125%")).not.toBeNull();
    expect(canvas.style.getPropertyValue("--image-scale")).toBe("1.25");

    fireEvent.click(screen.getByRole("button", { name: "顺时针旋转图片" }));
    expect(canvas.style.getPropertyValue("--image-rotation")).toBe("90deg");

    fireEvent.click(screen.getByRole("button", { name: "逆时针旋转图片" }));
    expect(canvas.style.getPropertyValue("--image-rotation")).toBe("0deg");

    dispatchPointer(canvas, "pointerdown", { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
    dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 44, clientY: 42 });
    dispatchPointer(canvas, "pointerup", { pointerId: 1, clientX: 44, clientY: 42 });

    expect(canvas.style.getPropertyValue("--image-offset-x")).toBe("24px");
    expect(canvas.style.getPropertyValue("--image-offset-y")).toBe("12px");

    fireEvent.click(screen.getByRole("button", { name: "重置图片视图" }));
    expect(screen.getByLabelText("当前缩放 100%")).not.toBeNull();
    expect(canvas.style.getPropertyValue("--image-offset-x")).toBe("0px");
    expect(canvas.style.getPropertyValue("--image-offset-y")).toBe("0px");
  });

  it("renders direct markdown content requests without workspace runtime", async () => {
    render(
      <FilePreview
        request={{ type: "content", title: "消息片段", content: "# 片段标题\n\n正文", contentType: "markdown" }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "片段标题" })).not.toBeNull();
    expect(screen.getByTitle("消息内容")).not.toBeNull();
    expect(screen.queryByText(/Markdown 预览/)).toBeNull();
  });

  it("renders long breadcrumb paths as separate visible segments", () => {
    render(
      <FilePreview
        breadcrumbRootLabel="D:/repo/keydex"
        request={{
          type: "content",
          title: "长路径源码",
          content: "export const value = 1;",
          contentType: "code",
          sourcePath:
            "backend/services/really-long-directory-name-that-can-ellipsis/tests/test_entrypoints_with_long_name.ts",
        }}
      />,
    );

    expect(
      screen.getByTitle(
        "keydex / backend / services / really-long-directory-name-that-can-ellipsis / tests / test_entrypoints_with_long_name.ts",
      ),
    ).not.toBeNull();
    expect(screen.getByText("keydex")).not.toBeNull();
    expect(screen.getByText("backend")).not.toBeNull();
    expect(screen.getByText("services")).not.toBeNull();
    expect(screen.getByText("really-long-directory-name-that-can-ellipsis")).not.toBeNull();
    expect(screen.getByText("tests")).not.toBeNull();
    expect(screen.getByText("test_entrypoints_with_long_name.ts")).not.toBeNull();
  });

  it("renders Windows extended paths without internal prefix or duplicate file root", () => {
    render(
      <FilePreview
        breadcrumbRootLabel="README.md"
        request={{
          type: "content",
          title: "README.md",
          content: "# Hello\n",
          contentType: "markdown",
          sourcePath: "\\\\?\\C:\\Users\\86364\\Desktop\\README.md",
        }}
      />,
    );

    const breadcrumbs = screen.getByTitle("C: / Users / 86364 / Desktop / README.md");
    expect(breadcrumbs).not.toBeNull();
    expect(within(breadcrumbs).queryByText("?")).toBeNull();
    expect(within(breadcrumbs).getAllByText("README.md")).toHaveLength(1);
  });

  it("renders JSON source without reformatting its offsets", async () => {
    const json = '{"users":[{"name":"Ada","role":"admin"}],"enabled":true}';
    render(
      <FilePreview
        chrome="panel"
        request={{ type: "content", title: "JSON 预览", content: json, contentType: "json" }}
      />,
    );

    expect(screen.getByTitle("消息内容")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "JSON 预览" })).toBeNull();
    expect(screen.queryByText("JSON 查看")).toBeNull();
    expect(screen.queryByTestId("json-tree-viewer")).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "查找 JSON" })).toBeNull();
    expect(screen.queryByRole("button", { name: "预览" })).toBeNull();

    const sourceViewer = screen.getByTestId("file-source-viewer");
    expect(sourceViewer.getAttribute("data-renderer")).toBe("codemirror");
    expect(sourceViewer.textContent).toContain("users");
    expect(sourceViewer.textContent).toContain("Ada");
    expect(sourceViewer.textContent).toContain("enabled");
    expect(sourceViewer.querySelector(".cm-content")?.textContent).toBe(json);

    fireEvent.click(screen.getByRole("button", { name: "复制预览内容" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(json);
    });
  });

  it("renders mermaid content as native panel chrome", async () => {
    mockElementMetrics({ clientWidth: 1200, clientHeight: 600 });

    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "Mermaid 图表预览",
          content: "graph TD\nA[开始] --> B[结束]",
          contentType: "mermaid",
        }}
      />,
    );

    expect(screen.queryByText("正在渲染 Mermaid...")).toBeNull();
    expect(screen.getByTitle("消息内容")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Mermaid 图表预览" })).toBeNull();
    expect(screen.queryByText(/Mermaid 预览/)).toBeNull();
    expect(screen.queryByRole("button", { name: "分屏" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全屏显示 Mermaid" })).toBeNull();
    expect(screen.queryByRole("button", { name: /在预览面板打开/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭右侧栏" })).toBeNull();

    const pane = await screen.findByTestId("preview-mermaid-pane");
    await waitFor(() => {
      expect(pane.innerHTML).toContain("测试图表");
    });
    const chart = screen.getByLabelText("Mermaid 图表") as HTMLDivElement;
    const svg = chart.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("2400");
    expect(svg?.getAttribute("height")).toBe("1200");
    expect(svg?.getAttribute("style")).toBeNull();
    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.47");
    });
    expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("1128px");
    expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("564px");
    expect(chart.style.getPropertyValue("--mermaid-canvas-padding-x")).toBe("600px");
    expect(chart.style.getPropertyValue("--mermaid-canvas-padding-y")).toBe("300px");
    expect(vi.mocked(mermaid.initialize)).toHaveBeenCalledWith(expect.objectContaining({
      flowchart: {
        useMaxWidth: false,
      },
    }));
    const controls = screen.getByLabelText("Mermaid 视图控制");
    const [zoomOutButton, zoomInButton, resetButton] = within(controls).getAllByRole("button");
    expect(controls).not.toBeNull();
    expect(within(controls).getByText("47%")).not.toBeNull();

    fireEvent.click(zoomInButton);
    expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.57");
    expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("1368px");
    expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("684px");
    expect(within(controls).getByText("57%")).not.toBeNull();

    fireEvent.click(zoomOutButton);
    expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.47");
    expect(within(controls).getByText("47%")).not.toBeNull();

    fireEvent.click(resetButton);
    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.47");
      expect(within(controls).getByText("47%")).not.toBeNull();
    });

    for (let index = 0; index < 80; index += 1) {
      fireEvent.click(zoomInButton);
    }
    expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("3");
    expect(within(controls).getByText("300%")).not.toBeNull();

    for (let index = 0; index < 80; index += 1) {
      fireEvent.click(zoomOutButton);
    }
    expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.05");
    expect(within(controls).getByText("5%")).not.toBeNull();
  });

  it("fits mermaid previews after the side panel reports its real size", async () => {
    const metrics = { clientWidth: 0, clientHeight: 0 };
    mockElementMetrics(metrics);

    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "Mermaid 图表预览",
          content: "graph TD\nA[开始] --> B[结束]",
          contentType: "mermaid",
        }}
      />,
    );

    const pane = await screen.findByTestId("preview-mermaid-pane");
    await waitFor(() => {
      expect(pane.innerHTML).toContain("测试图表");
    });
    const chart = screen.getByLabelText("Mermaid 图表") as HTMLDivElement;
    expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("1");

    metrics.clientWidth = 1200;
    metrics.clientHeight = 600;

    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.47");
    });
    expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("1128px");
    expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("564px");
    expect(within(screen.getByLabelText("Mermaid 视图控制")).getByText("47%")).not.toBeNull();
  });

  it("keeps mermaid auto-fit when complex svg content is not valid XML", async () => {
    mockElementMetrics({ clientWidth: 1200, clientHeight: 600 });
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      diagramType: "flowchart-v2",
      svg: '<svg role="img" aria-label="复杂图表" width="100%" style="max-width: 2400px;" viewBox="0 0 2400 1200"><text>&notAnXmlEntity;</text></svg>',
    });

    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "Mermaid 图表预览",
          content: "graph TD\nA[开始] --> B[结束]",
          contentType: "mermaid",
        }}
      />,
    );

    const pane = await screen.findByTestId("preview-mermaid-pane");
    await waitFor(() => {
      expect(pane.innerHTML).toContain("复杂图表");
    });
    const chart = screen.getByLabelText("Mermaid 图表") as HTMLDivElement;
    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("0.47");
    });
    expect(chart.style.getPropertyValue("--mermaid-render-width")).toBe("1128px");
    expect(chart.style.getPropertyValue("--mermaid-render-height")).toBe("564px");
    expect(within(screen.getByLabelText("Mermaid 视图控制")).getByText("47%")).not.toBeNull();
  });

  it("supports wheel zoom and drag panning for mermaid panel previews", async () => {
    const addEventListener = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "Mermaid 图表预览",
          content: "graph TD\nA[开始] --> B[结束]",
          contentType: "mermaid",
        }}
      />,
    );

    const chart = (await screen.findByLabelText("Mermaid 图表")) as HTMLDivElement;
    await waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), { passive: false });
    });

    fireEvent.wheel(chart, { clientX: 120, clientY: 140, deltaY: -120 });
    await waitFor(() => {
      expect(chart.style.getPropertyValue("--mermaid-scale")).toBe("1.1");
    });
    expect(within(screen.getByLabelText("Mermaid 视图控制")).getByText("110%")).not.toBeNull();

    chart.scrollLeft = 40;
    chart.scrollTop = 50;
    fireEvent(chart, pointerEvent("pointerdown", { button: 0, clientX: 120, clientY: 140, pointerId: 7 }));
    fireEvent(chart, pointerEvent("pointermove", { clientX: 90, clientY: 100, pointerId: 7 }));

    expect(chart.scrollLeft).toBe(70);
    expect(chart.scrollTop).toBe(90);
    expect(chart.dataset.dragging).toBe("true");

    fireEvent(chart, pointerEvent("pointerup", { pointerId: 7 }));
    expect(chart.dataset.dragging).toBeUndefined();

    addEventListener.mockRestore();
  });

  it("renders markdown code fences in panel chrome with enhanced code-block controls", async () => {
    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "Markdown 片段",
          content: "```ts\nconsole.log('panel')\n```",
          contentType: "markdown",
        }}
      />,
    );

    expect(screen.getByTitle("消息内容")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Markdown 片段" })).toBeNull();
    const codeViewport = await screen.findByTestId("markdown-code-viewport");
    expect(codeViewport.textContent).toContain("console.log('panel')");
    expect(screen.getByRole("button", { name: "复制预览内容" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).not.toBeNull();
    expect(codeViewport.getAttribute("data-scroll-axis")).toBe("x");
    expect(screen.queryByRole("button", { name: /在预览面板打开/ })).toBeNull();
  });

  it("keeps mermaid diagrams bounded when rendered inside markdown previews", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    mockElementMetrics({ clientWidth: 640, clientHeight: 320 });

    render(
      <FilePreview
        chrome="panel"
        request={{
          type: "content",
          title: "Markdown diagram",
          content: "# Diagram\n\n```mermaid\ngraph TD\nA[Start] --> B[Finish]\n```\n\nAfter",
          contentType: "markdown",
        }}
      />,
    );

    const pane = await screen.findByTestId("preview-mermaid-pane");
    expect(pane.getAttribute("data-layout")).toBe("document");
    expect(pane.getAttribute("data-markdown-code-frame")).toBe("true");
    expect(within(pane).getByText("mermaid")).not.toBeNull();
    await waitFor(() => {
      expect(pane.querySelector("svg")).not.toBeNull();
    });

    const chart = within(pane).getByLabelText("Mermaid 图表") as HTMLDivElement;
    await waitFor(() => {
      expect(chart.dataset.markdownMermaidWidth).toBe("2400");
      expect(chart.dataset.markdownMermaidHeight).toBe("1200");
    });
    expect(chart.querySelector("svg")).not.toBeNull();
    const copyButton = within(pane).getByRole("button", { name: "复制 Mermaid 源码" });
    expect(copyButton.querySelector("svg[data-markdown-action-icon='copy']")).not.toBeNull();
    const openButton = within(pane).getByRole("button", { name: "打开 Mermaid 预览" });
    expect(openButton.querySelector("svg[data-markdown-action-icon='maximize']")).not.toBeNull();
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("graph TD\nA[Start] --> B[Finish]");
      expect(copyButton.querySelector("svg[data-markdown-action-icon='check']")).not.toBeNull();
    });

    fireEvent.click(openButton);
    const dialog = await screen.findByRole("dialog", { name: "Mermaid 预览" });
    expect(dialog.getAttribute("data-size")).toBe("fullscreen");
    expect(dialog.parentElement?.getAttribute("data-backdrop")).toBe("preview");
    const dialogChart = await within(dialog).findByLabelText("Mermaid 图表") as HTMLDivElement;
    await waitFor(() => {
      expect(dialogChart.style.getPropertyValue("--mermaid-scale")).toBe("0.24");
    });
    expect(within(dialog).getByText("24%")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "放大 Mermaid" })).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "放大 Mermaid" }));
    expect(within(dialog).getByText("34%")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭 Mermaid 预览" }));
    expect(screen.queryByRole("dialog", { name: "Mermaid 预览" })).toBeNull();
  });

  it("quotes selected preview text through the floating selection toolbar", async () => {
    const onQuoteSelection = vi.fn();
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "# 片段标题\n\n正文内容",
        encoding: "utf-8",
      }),
    });
    render(
      <FilePreview
        request={{ type: "file", path: "guide.md" }}
        sessionId="ses-1"
        runtime={runtime}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const body = await screen.findByLabelText("预览内容");
    const selection = await showSelectionToolbar(body, "正文内容");
    fireEvent.click(await screen.findByRole("button", { name: "添加选中文本到对话" }));

    expect(onQuoteSelection).toHaveBeenCalledWith({
      path: "guide.md",
      selectedText: "正文内容",
      lineStart: 3,
      lineEnd: 3,
      sourceStart: 8,
      sourceEnd: 12,
    });
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("keeps markdown tables scrollable in preview content", async () => {
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

    expect(await screen.findByRole("table")).not.toBeNull();
    expect(container.querySelector("[data-markdown-table-scroll='true']")).not.toBeNull();
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
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    const image = (await screen.findByAltText("示例图片")) as HTMLImageElement;
    await waitFor(() => expect(image.getAttribute("src")).toBe("data:image/png;base64,abc"));
    expect(runtime.workspace.readMedia).toHaveBeenCalledWith({ sessionId: "ses-1" }, "docs/assets/pixel.png");
  });

  it("switches and closes preview history tabs from the shared preview provider", async () => {
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
    expect(await screen.findByRole("heading", { level: 1, name: "Markdown 片段" })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "HTML 片段" }));

    expect(screen.getByRole("tab", { name: "HTML 片段" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByTitle("HTML 文件预览") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("HTML 片段");

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 HTML 片段" }));

    expect(screen.queryByRole("tab", { name: "HTML 片段" })).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "Markdown 片段" })).not.toBeNull();
  });

  it("reuses an open file preview and only updates its line reveal", async () => {
    const content = "# Guide\n\nFirst target\n\nSecond target";
    const readFile = vi.fn().mockResolvedValue({
      path: "guide.md",
      content,
      encoding: "utf-8",
    });
    const runtime = fakeRuntime({ readFile });

    render(
      <PreviewProvider>
        <ReusedFilePreviewHarness runtime={runtime} />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open line 3" }));

    const previewRoot = await screen.findByTestId("reused-file-preview");
    expect(previewRoot.textContent).toContain("First target");
    const firstOpenedAt = Number(screen.getByTestId("reused-preview-opened-at").textContent);
    expect(readFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open line 5" }));

    await waitFor(() => {
      expect(Number(screen.getByTestId("reused-preview-opened-at").textContent)).toBeGreaterThan(firstOpenedAt);
    });
    expect(screen.getByTestId("reused-file-preview")).toBe(previewRoot);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("keeps preview requests scoped to the active host session", () => {
    render(
      <PreviewProvider>
        <PreviewScopeHarness />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开当前会话预览" }));
    expect(screen.getByTestId("preview-request").textContent).toBe("ses-a:ses-a 预览");
    expect(screen.getByTestId("preview-entry-count").textContent).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "切到 ses-b" }));

    expect(screen.getByTestId("preview-request").textContent).toBe("empty");
    expect(screen.getByTestId("preview-entry-count").textContent).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "打开当前会话预览" }));
    expect(screen.getByTestId("preview-request").textContent).toBe("ses-b:ses-b 预览");

    fireEvent.click(screen.getByRole("button", { name: "切到 ses-a" }));

    expect(screen.getByTestId("preview-request").textContent).toBe("ses-a:ses-a 预览");
    expect(screen.getByTestId("preview-entry-count").textContent).toBe("1");
  });

  it("shows backend errors for oversized or binary files", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockRejectedValue(new Error("文件过大，暂不预览")),
    });

    render(<FilePreview request={{ type: "file", path: "large.log" }} sessionId="ses-1" runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toBe("文件过大，暂不预览");
  });

  it("renders diff request without reading workspace file", () => {
    const runtime = fakeRuntime();

    render(
      <FilePreview
        request={{ type: "diff", path: "src/main.py", diff: "@@\n-print('old')\n+print('new')" }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    expect(screen.getByTitle("src / main.py")).not.toBeNull();
    expect(screen.queryByText(/Diff 预览/)).toBeNull();
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

    render(<FilePreview request={{ type: "file", path: "notes.txt" }} sessionId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("预览内容");
    fireEvent.click(screen.getByRole("button", { name: "复制预览内容" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("可复制内容");
    });
    expect(await screen.findByText("已复制")).not.toBeNull();
  });

  it("resets preview copy feedback after the shared delay", async () => {
    vi.useFakeTimers();
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

    render(
      <FilePreview
        request={{ type: "content", title: "notes.txt", content: "copy me", contentType: "text" }}
      />,
    );

    const copyButton = screen.getByRole("button", { name: "复制预览内容" });
    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(clipboard).toHaveBeenCalledWith("copy me");
    expect(copyButton.querySelector(".lucide-check")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1399);
    });
    expect(copyButton.querySelector(".lucide-check")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(copyButton.querySelector(".lucide-copy")).not.toBeNull();
    expect(copyButton.querySelector(".lucide-check")).toBeNull();
  });

});

function MarkdownOutlineRevealHarness({ runtime }: { runtime: RuntimeBridge }) {
  const [outline, setOutline] = useState<MarkdownOutlineItem[]>([]);
  const [revealRequest, setRevealRequest] = useState<MarkdownOutlineRevealRequest | null>(null);
  const request = useMemo(() => ({ type: "file", path: "guide.md" }) as const, []);
  const setupHeading = outline.find((item) => item.title === "Setup");

  return (
    <>
      <button
        type="button"
        disabled={!setupHeading}
        onClick={() => {
          if (!setupHeading) {
            return;
          }
          setRevealRequest((current) => ({
            requestId: (current?.requestId ?? 0) + 1,
            id: setupHeading.id,
            line: setupHeading.line,
          }));
        }}
      >
        定位 Setup 大纲
      </button>
      <FilePreview
        request={request}
        sessionId="ses-1"
        runtime={runtime}
        outlineRevealRequest={revealRequest}
        onMarkdownOutlineChange={setOutline}
      />
    </>
  );
}

function fakeRuntime(overrides: Partial<RuntimeBridge["workspace"]> = {}): RuntimeBridge {
  return {
    workspace: {
      readFile: vi.fn(),
      readMedia: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
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

function ReusedFilePreviewHarness({ runtime }: { runtime: RuntimeBridge }) {
  const preview = usePreview();
  const entry = preview.activeEntry;
  const openLine = (line: number) => {
    preview.openPreview(
      { type: "file", path: "guide.md" },
      { runtime, sessionId: "ses-1" },
      { lineEnd: line, lineStart: line },
    );
  };

  return (
    <>
      <button onClick={() => openLine(3)} type="button">Open line 3</button>
      <button onClick={() => openLine(5)} type="button">Open line 5</button>
      <output data-testid="reused-preview-opened-at">{entry?.openedAt ?? ""}</output>
      {entry ? (
        <div data-testid="reused-file-preview">
          <FilePreview
            request={entry.request}
            runtime={runtime}
            sessionId="ses-1"
            sourceRevealRequest={entry.revealTarget ? { requestId: entry.openedAt, ...entry.revealTarget } : null}
          />
        </div>
      ) : null}
    </>
  );
}

function PreviewScopeHarness() {
  const [sessionId, setSessionId] = useState("ses-a");
  const preview = usePreview();

  useEffect(() => {
    preview.setPreviewHostContext({ sessionId });
    return () => preview.setPreviewHostContext(null);
  }, [preview.setPreviewHostContext, sessionId]);

  return (
    <>
      <button type="button" onClick={() => setSessionId((current) => (current === "ses-a" ? "ses-b" : "ses-a"))}>
        切到 {sessionId === "ses-a" ? "ses-b" : "ses-a"}
      </button>
      <button
        type="button"
        onClick={() =>
          preview.openPreview({
            type: "content",
            title: `${sessionId} 预览`,
            content: `# ${sessionId}`,
            contentType: "markdown",
          })
        }
      >
        打开当前会话预览
      </button>
      <div data-testid="preview-request">
        {preview.request?.type === "content" ? `${sessionId}:${preview.request.title}` : "empty"}
      </div>
      <div data-testid="preview-entry-count">{preview.entries.length}</div>
    </>
  );
}

function mockSelection(container: Element, text: string) {
  const removeAllRanges = vi.fn();
  const range = textRange(container, text);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => testRect({
      left: 120,
      top: 140,
      right: 220,
      bottom: 160,
      width: 100,
      height: 20,
    }),
  });
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

function testRect(overrides: Partial<DOMRect> = {}): DOMRect {
  const left = overrides.left ?? 0;
  const top = overrides.top ?? 0;
  const width = overrides.width ?? 0;
  const height = overrides.height ?? 0;
  const right = overrides.right ?? left + width;
  const bottom = overrides.bottom ?? top + height;
  return {
    bottom,
    height,
    left,
    right,
    top,
    width,
    x: overrides.x ?? left,
    y: overrides.y ?? top,
    toJSON: () => ({}),
  } as DOMRect;
}

function textRange(container: Element, text: string): Range {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] ?? text;
  const lastToken = tokens[tokens.length - 1] ?? text;
  const start = findTextPosition(container, firstToken, null);
  const end = findTextPosition(container, lastToken, start);
  const range = document.createRange();
  if (!start || !end) {
    range.selectNodeContents(container);
    return range;
  }
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + lastToken.length);
  return range;
}

function findTextPosition(
  container: Element,
  token: string,
  after: { node: Text; offset: number } | null,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let afterReached = after === null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const value = node.data;
    let searchFrom = 0;
    if (!afterReached) {
      if (node !== after?.node) {
        continue;
      }
      afterReached = true;
      searchFrom = after.offset;
    }
    const offset = value.indexOf(token, searchFrom);
    if (offset >= 0) {
      return { node, offset };
    }
  }
  return null;
}

function mockElementMetrics(metrics: { clientWidth: number; clientHeight: number }) {
  restoreElementMetrics?.();

  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => metrics.clientWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });

  restoreElementMetrics = () => {
    if (clientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }

    if (clientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    } else {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  };
}

function mockSourceScrollMetrics(metrics: { clientWidth: number; clientHeight: number; scrollHeight: number }) {
  restoreElementMetrics?.();

  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => metrics.clientWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });

  restoreElementMetrics = () => {
    if (clientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }

    if (clientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    } else {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }

    if (scrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    } else {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  };
}

function dispatchPointer(
  target: Element,
  type: string,
  properties: { button?: number; clientX?: number; clientY?: number; pointerId?: number },
) {
  fireEvent(target, pointerEvent(type, properties));
}

function pointerEvent(
  type: string,
  properties: { button?: number; clientX?: number; clientY?: number; pointerId?: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: properties.button ?? 0 },
    clientX: { value: properties.clientX ?? 0 },
    clientY: { value: properties.clientY ?? 0 },
    pointerId: { value: properties.pointerId ?? 1 },
  });
  return event;
}
