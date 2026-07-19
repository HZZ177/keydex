import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid, { type ParseResult, type RenderResult } from "mermaid";

import { RuntimeHttpError, type DocumentReadResult, type RuntimeBridge } from "@/runtime";
import { FilePreview, type MarkdownOutlineItem, type MarkdownOutlineRevealRequest } from "@/renderer/components/workspace";
import { APP_FIND_SHORTCUT_EVENT } from "@/renderer/events/findShortcut";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";

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

vi.mock("@/renderer/components/diff/wrappers/PreviewDiffView", () => ({
  PreviewDiffView: ({ document, scrollScopeKey }: {
    document: {
      files: Array<{ displayPath: string; patch: string }>;
      diagnostics: Array<{ message: string }>;
    };
    scrollScopeKey: string;
  }) => (
    <section
      aria-label="差异文件预览"
      data-keydex-diff-wrapper="preview"
      data-scroll-scope={scrollScopeKey}
    >
      {document.files.map((file) => <pre key={file.displayPath}>{file.displayPath}{file.patch}</pre>)}
      {document.diagnostics.map((item) => <p key={item.message}>{item.message}</p>)}
    </section>
  ),
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

  it("renders a system skill resource as an explicit read-only document without workspace side effects", async () => {
    const readDocument = vi.fn();
    const writeDocument = vi.fn();
    const runtime = fakeRuntime({ readDocument, writeDocument });

    render(
      <FilePreview
        request={{
          type: "skill-resource",
          title: "dev-plan",
          content: "# System skill\n\n```mermaid\ngraph TD\n  A --> B\n```",
          contentType: "markdown",
          skillName: "dev-plan",
          skillSource: "system",
          resourcePath: "SKILL.md",
          locator: "system:skills/dev-plan/SKILL.md",
          revision: "sha256:system-skill",
        }}
        workspaceId="ws-1"
        sessionId="ses-1"
        runtime={runtime}
        onQuoteSelection={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "System skill" })).not.toBeNull();
    const root = document.querySelector("[data-file-preview-root='true']");
    expect(root?.getAttribute("data-preview-source")).toBe("skill-resource");
    expect(root?.getAttribute("data-skill-source")).toBe("system");
    expect(root?.textContent).not.toContain("系统级");
    expect(root?.getAttribute("data-file-preview-auto-save-state")).toBeNull();
    expect(root?.getAttribute("data-file-preview-new-annotations-enabled")).toBe("false");
    expect(root?.getAttribute("data-file-preview-file-allows-annotations")).toBe("false");
    expect(screen.queryByLabelText(/文件批注/u)).toBeNull();
    expect(readDocument).not.toHaveBeenCalled();
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it("opens relative markdown links from the current workspace document directory", async () => {
    const readDocument = vi.fn().mockImplementation(async (_scope, path: string) => ({
      document_id: `workspace:session:ses-1:${path}`,
      source: "workspace",
      path,
      content: path === "docs/guide/SKILL.md"
        ? "[打开子文档](references/details.md)"
        : "# 子文档",
      encoding: "utf-8",
      revision: `sha256:${path}`,
      total_bytes: 32,
    }));
    const runtime = fakeRuntime({ readDocument });

    render(
      <PreviewProvider>
        <LinkedPreviewHarness
          initialRequest={{ type: "file", path: "docs/guide/SKILL.md" }}
          runtime={runtime}
        />
      </PreviewProvider>,
    );

    fireEvent.click(await screen.findByRole("link", { name: "打开子文档" }));

    await waitFor(() => {
      expect(screen.getByTestId("linked-preview-request").textContent)
        .toBe("file:docs/guide/references/details.md");
    });
    expect(readDocument).toHaveBeenLastCalledWith(
      { sessionId: "ses-1" },
      "docs/guide/references/details.md",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("opens relative links inside skill previews as resources of the same skill", async () => {
    const readSessionResource = vi.fn().mockResolvedValue({
      skill_name: "keydex-guide",
      source: "system",
      resource_path: "references/details.md",
      content: "# Skill 子文档",
      locator: "system:keydex-guide/references/details.md",
      revision: "sha256:skill-details",
    });
    const runtime = {
      workspace: { readFile: vi.fn(), readMedia: vi.fn() },
      skills: { readSessionResource },
    } as unknown as RuntimeBridge;

    render(
      <PreviewProvider>
        <LinkedPreviewHarness
          initialRequest={{
            type: "skill-resource",
            title: "keydex-guide",
            content: "[打开 Skill 子文档](references/details.md)",
            contentType: "markdown",
            skillName: "keydex-guide",
            skillSource: "system",
            resourcePath: "SKILL.md",
            locator: "system:keydex-guide/SKILL.md",
            revision: "sha256:skill-root",
          }}
          runtime={runtime}
        />
      </PreviewProvider>,
    );

    fireEvent.click(await screen.findByRole("link", { name: "打开 Skill 子文档" }));

    await waitFor(() => expect(readSessionResource).toHaveBeenCalledWith("ses-1", {
      skill_name: "keydex-guide",
      source: "system",
      resource_path: "references/details.md",
    }));
    await waitFor(() => {
      expect(screen.getByTestId("linked-preview-request").textContent)
        .toBe("skill-resource:references/details.md");
    });
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

  it("reports when the panel preview viewport approaches the document bottom", async () => {
    mockSourceScrollMetrics({ clientWidth: 640, clientHeight: 200, scrollHeight: 1000 });
    const onViewportNearBottomChange = vi.fn();
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
        onViewportNearBottomChange={onViewportNearBottomChange}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Safe Area" })).not.toBeNull();
    const viewport = screen.getByLabelText("预览内容");
    await waitFor(() => expect(onViewportNearBottomChange).toHaveBeenLastCalledWith(false));

    viewport.scrollTop = 760;
    fireEvent.scroll(viewport);

    await waitFor(() => expect(onViewportNearBottomChange).toHaveBeenLastCalledWith(true));
    expect(document.querySelector("[data-file-preview-bottom-safe-area='true']")).toBeNull();
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
    expect(viewport.querySelectorAll("[data-file-preview-bottom-scroll-space='true']")).toHaveLength(1);
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
      expect(search.closest("[data-document-scroll-viewport='true']")).toBeNull();
      expect(search.parentElement).toBe(body.parentElement);
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
    expect(viewport.querySelectorAll("[data-file-preview-bottom-scroll-space='true']")).toHaveLength(1);
    expect(viewport.querySelector("[data-annotation-rail='true']")).not.toBeNull();
    expect(screen.queryByTestId("source-scroll-rail")).toBeNull();
    expect(screen.getByTestId("preview-scroll-rail")).not.toBeNull();
  });

  it("edits real source files and automatically saves them with the loaded revision", async () => {
    const writeDocument = vi.fn().mockResolvedValue({
      protocol_version: "document-write/v1",
      path: "src/App.ts",
      revision: "sha256:after",
      encoding: "utf-8",
      total_bytes: 18,
    });
    const readDocument = vi.fn().mockResolvedValue({
      document_id: "workspace:session:ses-1:src/App.ts",
      source: "workspace",
      path: "src/App.ts",
      content: "const value = 1;\r\n",
      encoding: "utf-8",
      revision: "sha256:before",
      total_bytes: 18,
    });
    const runtime = fakeRuntime({
      readDocument,
      writeDocument,
    });

    render(<FilePreview request={{ type: "file", path: "src/App.ts" }} sessionId="ses-1" runtime={runtime} />);

    const sourceViewer = await screen.findByTestId("file-source-viewer");
    expect(sourceViewer.getAttribute("data-editable")).toBe("true");
    const view = EditorView.findFromDOM(sourceViewer);
    expect(view).not.toBeNull();
    act(() => {
      view?.dispatch({
        changes: { from: 14, to: 15, insert: "2" },
        userEvent: "input",
      });
    });

    await waitFor(() => {
      expect(writeDocument).toHaveBeenCalledWith(
        { sessionId: "ses-1" },
        "src/App.ts",
        "const value = 2;\r\n",
        expect.objectContaining({
          expectedRevision: "sha256:before",
          writeId: expect.stringMatching(/^document-write:/u),
        }),
      );
    });
    await waitFor(() => {
      const root = document.querySelector("[data-file-preview-root='true']");
      expect(root?.getAttribute("data-file-preview-auto-save-state")).toBe("saved");
      expect(root?.getAttribute("data-document-revision")).toBe("sha256:after");
    });
    expect(screen.queryByText("等待自动保存")).toBeNull();
    expect(screen.queryByText("正在自动保存")).toBeNull();
    expect(screen.queryByText("已自动保存")).toBeNull();
  });

  it("reports auto-save failures through the top notification without inline status", async () => {
    const writeDocument = vi.fn().mockRejectedValue(new Error("disk full"));
    const runtime = fakeRuntime({
      readDocument: vi.fn().mockResolvedValue({
        document_id: "workspace:session:ses-1:src/App.ts",
        source: "workspace",
        path: "src/App.ts",
        content: "const value = 1;",
        encoding: "utf-8",
        revision: "sha256:before",
        total_bytes: 16,
      }),
      writeDocument,
    });

    render(
      <NotificationProvider>
        <FilePreview request={{ type: "file", path: "src/App.ts" }} sessionId="ses-1" runtime={runtime} />
      </NotificationProvider>,
    );
    const sourceViewer = await screen.findByTestId("file-source-viewer");
    const view = EditorView.findFromDOM(sourceViewer);
    act(() => {
      view?.dispatch({ changes: { from: 14, to: 15, insert: "2" }, userEvent: "input" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("notification-viewport").textContent)
        .toContain("自动保存失败：disk full");
    });
    expect(screen.queryByText("自动保存失败，点击重试")).toBeNull();
    expect(document.querySelector("[data-file-preview-root='true']")?.getAttribute("data-file-preview-auto-save-state"))
      .toBe("error");
  });

  it("flushes a dirty draft when the preview closes before the auto-save delay", async () => {
    const writeDocument = vi.fn().mockResolvedValue({
      protocol_version: "document-write/v1",
      path: "src/App.ts",
      revision: "sha256:after",
      encoding: "utf-8",
      total_bytes: 16,
    });
    const runtime = fakeRuntime({
      readDocument: vi.fn().mockResolvedValue({
        document_id: "workspace:session:ses-1:src/App.ts",
        source: "workspace",
        path: "src/App.ts",
        content: "const value = 1;",
        encoding: "utf-8",
        revision: "sha256:before",
        total_bytes: 16,
      }),
      writeDocument,
    });

    const { unmount } = render(
      <FilePreview request={{ type: "file", path: "src/App.ts" }} sessionId="ses-1" runtime={runtime} />,
    );
    const sourceViewer = await screen.findByTestId("file-source-viewer");
    const view = EditorView.findFromDOM(sourceViewer);
    act(() => {
      view?.dispatch({ changes: { from: 14, to: 15, insert: "2" }, userEvent: "input" });
    });
    unmount();

    await waitFor(() => {
      expect(writeDocument).toHaveBeenCalledWith(
        { sessionId: "ses-1" },
        "src/App.ts",
        "const value = 2;",
        expect.objectContaining({
          expectedRevision: "sha256:before",
          writeId: expect.stringMatching(/^document-write:/u),
        }),
      );
    });
  });

  it("keeps an edited draft visible and pauses auto-save on a revision conflict", async () => {
    const writeDocument = vi.fn().mockRejectedValue(new RuntimeHttpError({
      code: "revision_conflict",
      message: "Document revision no longer matches the edited revision",
      details: { actual_revision: "sha256:external" },
      status: 409,
      method: "POST",
      path: "/write/document",
      body: {},
      rawText: "",
    }));
    const readDocument = vi.fn()
      .mockResolvedValueOnce({
        document_id: "workspace:session:ses-1:src/App.ts",
        source: "workspace",
        path: "src/App.ts",
        content: "const value = 1;",
        encoding: "utf-8",
        revision: "sha256:before",
        total_bytes: 16,
      })
      .mockResolvedValue({
        document_id: "workspace:session:ses-1:src/App.ts",
        source: "workspace",
        path: "src/App.ts",
        content: "const value = 3;",
        encoding: "utf-8",
        revision: "sha256:external",
        total_bytes: 16,
      });
    const runtime = fakeRuntime({
      readDocument,
      writeDocument,
    });

    render(
      <NotificationProvider>
        <FilePreview request={{ type: "file", path: "src/App.ts" }} sessionId="ses-1" runtime={runtime} />
      </NotificationProvider>,
    );
    const sourceViewer = await screen.findByTestId("file-source-viewer");
    const view = EditorView.findFromDOM(sourceViewer);
    act(() => {
      view?.dispatch({
        changes: { from: 14, to: 15, insert: "2" },
        userEvent: "input",
      });
    });

    expect(await screen.findByRole("dialog", { name: "文件保存冲突" })).not.toBeNull();
    expect(within(screen.getByTestId("notification-viewport")).getByText(
      "文件已被外部修改，自动保存已暂停。你的编辑仍保留在当前视图中。",
    )).not.toBeNull();
    expect(EditorView.findFromDOM(sourceViewer)?.state.doc.toString()).toBe("const value = 2;");
    expect(document.querySelector("[data-file-preview-root='true']")?.getAttribute("data-file-preview-auto-save-state"))
      .toBe("conflict");
  });

  it("serializes continuous edits and advances the expected revision after each auto-save", async () => {
    let resolveFirstSave!: (value: {
      protocol_version: "document-write/v1";
      path: string;
      revision: string;
      encoding: "utf-8";
      total_bytes: number;
    }) => void;
    const firstSave = new Promise<Parameters<typeof resolveFirstSave>[0]>((resolve) => {
      resolveFirstSave = resolve;
    });
    const writeDocument = vi.fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue({
        protocol_version: "document-write/v1",
        path: "src/App.ts",
        revision: "sha256:third",
        encoding: "utf-8",
        total_bytes: 16,
      });
    const runtime = fakeRuntime({
      readDocument: vi.fn().mockResolvedValue({
        document_id: "workspace:session:ses-1:src/App.ts",
        source: "workspace",
        path: "src/App.ts",
        content: "const value = 1;",
        encoding: "utf-8",
        revision: "sha256:first",
        total_bytes: 16,
      }),
      writeDocument,
    });

    render(<FilePreview request={{ type: "file", path: "src/App.ts" }} sessionId="ses-1" runtime={runtime} />);
    const sourceViewer = await screen.findByTestId("file-source-viewer");
    const view = EditorView.findFromDOM(sourceViewer);
    act(() => {
      view?.dispatch({ changes: { from: 14, to: 15, insert: "2" }, userEvent: "input" });
    });
    await waitFor(() => expect(writeDocument).toHaveBeenCalledTimes(1));

    act(() => {
      view?.dispatch({ changes: { from: 14, to: 15, insert: "3" }, userEvent: "input" });
    });
    await act(async () => {
      resolveFirstSave({
        protocol_version: "document-write/v1",
        path: "src/App.ts",
        revision: "sha256:second",
        encoding: "utf-8",
        total_bytes: 16,
      });
      await firstSave;
    });

    await waitFor(() => expect(writeDocument).toHaveBeenCalledTimes(2));
    expect(writeDocument).toHaveBeenNthCalledWith(
      2,
      { sessionId: "ses-1" },
      "src/App.ts",
      "const value = 3;",
      expect.objectContaining({
        expectedRevision: "sha256:second",
        writeId: expect.stringMatching(/^document-write:/u),
      }),
    );
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
    const outerViewport = screen.getByLabelText("预览内容");
    const sourceViewport = outerViewport.querySelector<HTMLElement>("[data-split-scroll-pane='source']");
    const previewViewport = outerViewport.querySelector<HTMLElement>("[data-split-scroll-pane='preview']");
    expect(outerViewport.getAttribute("data-split-mode")).toBe("true");
    expect(sourceViewport).not.toBeNull();
    expect(previewViewport).not.toBeNull();
    expect(sourceViewport).not.toBe(previewViewport);
    expect(sourceViewport?.querySelectorAll("[data-file-preview-bottom-scroll-space='true']")).toHaveLength(1);
    expect(previewViewport?.querySelectorAll("[data-file-preview-bottom-scroll-space='true']")).toHaveLength(1);
    expect(screen.queryByTestId("preview-scroll-rail")).toBeNull();
  });

  it("keeps the source viewport stable when preview reflow scrolls after auto-save", async () => {
    const source = Array.from({ length: 80 }, (_, index) => `## Heading ${index}\n\nBody ${index}`).join("\n\n");
    let writeSequence = 0;
    const writeDocument = vi.fn().mockImplementation(async () => {
      writeSequence += 1;
      return {
        protocol_version: "document-write/v1",
        path: "guide.md",
        revision: `sha256:after-${writeSequence}`,
        encoding: "utf-8",
        total_bytes: source.length + 1,
      };
    });
    const runtime = fakeRuntime({
      readDocument: vi.fn().mockResolvedValue({
        document_id: "workspace:session:ses-1:guide.md",
        source: "workspace",
        path: "guide.md",
        content: source,
        encoding: "utf-8",
        revision: "sha256:before",
        total_bytes: source.length,
      }),
      writeDocument,
    });

    render(<FilePreview request={{ type: "file", path: "guide.md" }} sessionId="ses-1" runtime={runtime} />);
    expect(await screen.findByRole("heading", { name: "Heading 0" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    const sourcePanel = screen.getByLabelText("源码内容");
    const sourceViewer = await within(sourcePanel).findByTestId("file-source-viewer");
    const sourceViewport = sourcePanel.querySelector<HTMLElement>("[data-split-scroll-pane='source']")!;
    const previewViewport = screen
      .getByLabelText("渲染预览")
      .querySelector<HTMLElement>("[data-split-scroll-pane='preview']")!;
    const view = EditorView.findFromDOM(sourceViewer)!;
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    sourceViewport.scrollTop = 320;
    const editPosition = source.indexOf("Body 40") + "Body 40".length;

    act(() => {
      view.dispatch({ changes: { from: editPosition, to: editPosition, insert: "X" }, userEvent: "input" });
    });
    await waitFor(() => expect(writeDocument).toHaveBeenCalledTimes(1));
    act(() => {
      previewViewport.scrollTop = 900;
      fireEvent.scroll(previewViewport);
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(sourceViewport.scrollTop).toBe(320);

    act(() => {
      view.dispatch({ changes: { from: editPosition, to: editPosition + 1, insert: "" }, userEvent: "input" });
    });
    await waitFor(() => expect(writeDocument).toHaveBeenCalledTimes(2));
    act(() => {
      previewViewport.scrollTop = 120;
      fireEvent.scroll(previewViewport);
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(sourceViewport.scrollTop).toBe(320);

    fireEvent.pointerDown(previewViewport);
    act(() => {
      previewViewport.scrollTop = 700;
      fireEvent.scroll(previewViewport);
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(sourceViewport.scrollTop).toBe(0);
  });

  it("batches split-preview rendering while keeping source edits immediate", async () => {
    const writeDocument = vi.fn().mockResolvedValue({
      protocol_version: "document-write/v1",
      path: "guide.md",
      revision: "sha256:after",
      encoding: "utf-8",
      total_bytes: 10,
    });
    const runtime = fakeRuntime({
      readDocument: vi.fn().mockResolvedValue({
        document_id: "workspace:session:ses-1:guide.md",
        source: "workspace",
        path: "guide.md",
        content: "# Guide",
        encoding: "utf-8",
        revision: "sha256:before",
        total_bytes: 7,
      }),
      writeDocument,
    });
    const snapshotLoader = vi.fn(globalThis.__KEYDEX_TEST_FILE_MARKDOWN_SNAPSHOT_LOADER__!);

    render(
      <FilePreview
        markdownRuntimeSnapshotLoader={snapshotLoader}
        request={{ type: "file", path: "guide.md" }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Guide" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    const sourceViewer = await within(screen.getByLabelText("源码内容")).findByTestId("file-source-viewer");
    const previewPanel = screen.getByLabelText("渲染预览");
    const previewViewport = previewPanel.querySelector<HTMLElement>("[data-split-scroll-pane='preview']")!;
    const runtimeCanvas = previewPanel.querySelector<HTMLElement>("[data-file-markdown-runtime-canvas='true']")!;
    const documentCanvas = runtimeCanvas.querySelector<HTMLElement>("[data-markdown-document-canvas='true']")!;
    const view = EditorView.findFromDOM(sourceViewer);
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    const previewScrollTo = vi.spyOn(previewViewport, "scrollTo");
    snapshotLoader.mockClear();

    act(() => {
      view?.dispatch({ changes: { from: 7, to: 7, insert: " A" }, userEvent: "input" });
    });
    expect(view?.state.doc.toString()).toBe("# Guide A");
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 80)));
    expect(within(previewPanel).getByRole("heading", { name: "Guide" })).not.toBeNull();
    expect(snapshotLoader).not.toHaveBeenCalled();

    act(() => {
      view?.dispatch({ changes: { from: 9, to: 9, insert: "B" }, userEvent: "input" });
    });
    expect(view?.state.doc.toString()).toBe("# Guide AB");
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 100)));
    expect(within(previewPanel).getByRole("heading", { name: "Guide" })).not.toBeNull();
    expect(snapshotLoader).not.toHaveBeenCalled();

    expect(await within(previewPanel).findByRole("heading", { name: "Guide AB" })).not.toBeNull();
    await waitFor(() => expect(writeDocument).toHaveBeenCalledTimes(1));
    expect(snapshotLoader).toHaveBeenCalledTimes(1);
    expect(previewPanel.querySelector("[data-file-markdown-runtime-canvas='true']")).toBe(runtimeCanvas);
    expect(runtimeCanvas.querySelector("[data-markdown-document-canvas='true']")).toBe(documentCanvas);
    expect(previewScrollTo).not.toHaveBeenCalled();
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

  it("smoothly reveals unicode markdown heading anchors inside the current preview", async () => {
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "guide.md",
        content: "[开发者指南](#开发者指南)\n\n正文\n\n## 开发者指南\n\n构建说明。",
        encoding: "utf-8",
      }),
    });

    try {
      render(<FilePreview request={{ type: "file", path: "guide.md" }} sessionId="ses-1" runtime={runtime} />);

      fireEvent.click(await screen.findByRole("link", { name: "开发者指南" }));

      await waitFor(() => {
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      });
    } finally {
      if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
      } else {
        delete (HTMLElement.prototype as { scrollTo?: HTMLElement["scrollTo"] }).scrollTo;
      }
    }
  });

  it("allows html file scripts in an origin-isolated sandboxed preview frame", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: "index.html",
        content: "<main><h1>页面预览</h1><script>window.parent.postMessage('x','*')</script></main>",
        encoding: "utf-8",
      }),
    });

    render(<FilePreview request={{ type: "file", path: "index.html" }} sessionId="ses-1" runtime={runtime} />);

    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("页面预览");
  });

  it("uses the html frame as the only panel scroll owner and accepts its bottom proximity report", async () => {
    const onViewportNearBottomChange = vi.fn();
    render(
      <FilePreview
        chrome="panel"
        onViewportNearBottomChange={onViewportNearBottomChange}
        request={{
          type: "content",
          title: "HTML 预览",
          content: "<main>很长的 HTML 页面</main>",
          contentType: "html",
        }}
      />,
    );

    const viewport = screen.getByLabelText("预览内容");
    const frame = screen.getByTitle<HTMLIFrameElement>("HTML 文件预览");
    const pane = frame.closest<HTMLElement>("[data-html-frame-scroll-owner='true']");
    expect(viewport.getAttribute("data-scroll-owner")).toBe("html-frame");
    expect(pane).not.toBeNull();
    expect(frame.srcdoc).toContain("data-keydex-preview-viewport-bridge");
    expect(pane?.querySelector("[data-file-preview-bottom-safe-area='true']")).toBeNull();
    expect(pane?.querySelector("[data-file-preview-bottom-scroll-space='true']")).toBeNull();
    expect(frame.srcdoc).not.toContain("data-keydex-preview-bottom-scroll-space");
    expect(screen.queryByTestId("preview-scroll-rail")).toBeNull();

    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "keydex:html-preview-viewport-state/v1",
        nearBottom: true,
      },
      source: frame.contentWindow,
    }));
    await waitFor(() => expect(onViewportNearBottomChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "源码" }));

    expect(viewport.getAttribute("data-scroll-owner")).toBeNull();
    expect(viewport.querySelectorAll("[data-file-preview-bottom-scroll-space='true']")).toHaveLength(1);
    expect(screen.getByTestId("preview-scroll-rail")).not.toBeNull();
  });

  it("keeps the capsule visible when a cross-origin html frame cannot report its viewport", async () => {
    vi.useFakeTimers();
    const onViewportNearBottomChange = vi.fn();
    render(
      <FilePreview
        chrome="panel"
        onViewportNearBottomChange={onViewportNearBottomChange}
        request={{
          type: "content",
          title: "Vite HTML 预览",
          content: [
            '<script type="module" src="http://localhost:4173/@vite/client"></script>',
            '<script type="module" src="http://localhost:4173/src/main.tsx"></script>',
          ].join(""),
          contentType: "html",
        }}
      />,
    );

    const frame = screen.getByTitle<HTMLIFrameElement>("HTML 文件预览");
    expect(frame.src).toBe("http://localhost:4173/");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    expect(onViewportNearBottomChange).not.toHaveBeenCalledWith(true);
  });

  it("opens workspace html files directly from their native directory without a sandbox", async () => {
    const prepareHtmlFile = vi.fn().mockResolvedValue({
      path: "D:\\repo\\.ktaicoding\\prototype\\A2UI\\index.html",
      url: "http://asset.localhost/D%3A/repo/.ktaicoding/prototype/A2UI/index.html",
    });
    const runtime = {
      ...fakeRuntime({
        readFile: vi.fn().mockResolvedValue({
          path: ".ktaicoding/prototype/A2UI/index.html",
          content: '<iframe src="prototype-subpage.html"></iframe>',
          encoding: "utf-8",
        }),
      }),
      localPreview: { prepareHtmlFile },
    } as unknown as RuntimeBridge;

    render(
      <FilePreview
        request={{ type: "file", path: ".ktaicoding/prototype/A2UI/index.html" }}
        runtime={runtime}
        sessionId="ses-1"
        workspaceRootPath="D:/repo"
      />,
    );

    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(prepareHtmlFile).toHaveBeenCalledWith(
      "D:/repo/.ktaicoding/prototype/A2UI/index.html",
      "D:/repo",
    );
    expect(frame.getAttribute("src")).toBe(
      "http://asset.localhost/D%3A/repo/.ktaicoding/prototype/A2UI/index.html",
    );
    expect(frame.getAttribute("sandbox")).toBeNull();
    expect(frame.getAttribute("srcdoc")).toBeNull();
  });

  it("does not silently fall back to srcdoc when the workspace html runtime is stale", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({
        path: ".ktaicoding/prototype/A2UI/index.html",
        content: '<iframe src="prototype-subpage.html"></iframe>',
        encoding: "utf-8",
      }),
    });

    render(
      <FilePreview
        request={{ type: "file", path: ".ktaicoding/prototype/A2UI/index.html" }}
        runtime={runtime}
        sessionId="ses-1"
        workspaceRootPath="D:/repo"
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "HTML 直接预览运行时尚未更新，请刷新 Keydex 页面后重新打开文件。",
    );
    expect(screen.queryByTitle("HTML 文件预览")).toBeNull();
  });

  it("opens Vite-backed html files through their loopback server origin", async () => {
    const prepareHtmlFile = vi.fn();
    const runtime = {
      ...fakeRuntime({
        readFile: vi.fn().mockResolvedValue({
          path: "prototype-20260623-001-a2ui-config.html",
          content: [
            '<script type="module" src="http://localhost:4173/@vite/client"></script>',
            '<script type="module" src="http://localhost:4173/src/main.tsx?t=123"></script>',
          ].join("\n"),
          encoding: "utf-8",
        }),
      }),
      localPreview: { prepareHtmlFile },
    } as unknown as RuntimeBridge;

    render(
      <FilePreview
        request={{ type: "file", path: "prototype-20260623-001-a2ui-config.html" }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    const frame = (await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("src")).toBe(
      "http://localhost:4173/prototype-20260623-001-a2ui-config.html",
    );
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(prepareHtmlFile).not.toHaveBeenCalled();
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
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
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
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
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
    expect(sourceViewer.getAttribute("data-editable")).toBe("false");
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
    fireEvent.click(await screen.findByRole("button", { name: "引用选中文本" }));

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

  it("uses a whole-resource action instead of selected-text annotation inside rendered Mermaid", async () => {
    const message = "当前选区无法投影到文档文字模型。";
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      ...mermaidRenderResult,
      svg: '<svg role="img" aria-label="测试图表" viewBox="0 0 2400 1200"><text>Rendered node</text></svg>',
    });
    const runtime = {
      workspace: {
        readFile: vi.fn().mockResolvedValue({
          path: "diagram.md",
          content: "# Diagram\n\n```mermaid\ngraph TD\nA[Start] --> B[Finish]\n```",
          encoding: "utf-8",
          revision: "sha256:diagram",
        }),
        readMedia: vi.fn(),
      },
      annotations: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        updateBody: vi.fn(),
        replaceTarget: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as RuntimeBridge;

    render(
      <NotificationProvider>
        <FilePreview request={{ type: "file", path: "diagram.md" }} runtime={runtime} workspaceId="ws-1" />
      </NotificationProvider>,
    );

    const renderedNode = await screen.findByText("Rendered node");
    const selection = await showSelectionToolbar(renderedNode, "Rendered node");
    expect(renderedNode.closest("[data-file-preview-selection-excluded='true']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "为选中文本添加批注" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "批注整个 Mermaid 图表" }));
    expect(await screen.findByLabelText("批注内容")).not.toBeNull();
    expect(within(screen.getByTestId("notification-viewport")).queryByText(message)).toBeNull();
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
    await waitFor(() => expect(
      previewRoot.querySelector<HTMLElement>("[data-markdown-source-reveal-active='true'][data-markdown-block-id]")
        ?.dataset.markdownSourceRevealLineStart,
    ).toBe("3"));
    const firstOpenedAt = Number(screen.getByTestId("reused-preview-opened-at").textContent);
    expect(readFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open line 5" }));

    await waitFor(() => {
      expect(Number(screen.getByTestId("reused-preview-opened-at").textContent)).toBeGreaterThan(firstOpenedAt);
    });
    await waitFor(() => expect(
      previewRoot.querySelector<HTMLElement>("[data-markdown-source-reveal-active='true'][data-markdown-block-id]")
        ?.dataset.markdownSourceRevealLineStart,
    ).toBe("5"));
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
        request={{
          type: "diff",
          path: "src/main.py",
          diff: "diff --git a/src/main.py b/src/main.py\n--- a/src/main.py\n+++ b/src/main.py\n@@ -1 +1 @@\n-print('old')\n+print('new')",
        }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    expect(screen.getByTitle("src / main.py")).not.toBeNull();
    expect(screen.queryByText(/Diff 预览/)).toBeNull();
    expect(screen.getByLabelText("预览内容").textContent).toContain("+print('new')");
    expect(screen.getByLabelText("差异文件预览")).not.toBeNull();
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("shows an explicit diagnostic for malformed diff requests without falling back to old rows", () => {
    const runtime = fakeRuntime();
    render(
      <FilePreview
        request={{ type: "diff", path: "broken.patch", diff: "@@ broken" }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );
    expect(screen.getByLabelText("差异文件预览").textContent).toContain("内容不是可识别的 unified diff");
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("routes content diff previews through the canonical multi-file document", () => {
    const runtime = fakeRuntime();
    const multiFilePatch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-oldA",
      "+newA",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-oldB",
      "+newB",
    ].join("\n");

    render(
      <FilePreview
        request={{
          type: "content",
          title: "消息补丁",
          content: multiFilePatch,
          contentType: "diff",
          sourcePath: "conversation/message.patch",
        }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    const preview = screen.getByLabelText("差异文件预览");
    expect(preview.textContent).toContain("src/a.ts");
    expect(preview.textContent).toContain("src/b.ts");
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("routes Skill diff resources through the canonical document without workspace reads", () => {
    const runtime = fakeRuntime();
    render(
      <FilePreview
        request={{
          type: "skill-resource",
          title: "修复示例",
          content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
          contentType: "diff",
          skillName: "demo-skill",
          skillSource: "workspace",
          resourcePath: "examples/fix.patch",
          locator: "workspace:demo-skill/examples/fix.patch",
          revision: "sha256:fix",
        }}
        sessionId="ses-1"
        runtime={runtime}
      />,
    );

    expect(screen.getByLabelText("差异文件预览").textContent).toContain("a.ts");
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
    expect(runtime.workspace.readFile).not.toHaveBeenCalled();
  });

  it("keeps malformed content diff inside the canonical diagnostic surface", () => {
    render(
      <FilePreview
        request={{ type: "content", title: "损坏补丁", content: "@@ malformed", contentType: "diff" }}
        sessionId="ses-1"
        runtime={fakeRuntime()}
      />,
    );

    expect(screen.getByLabelText("差异文件预览").textContent).toContain("内容不是可识别的 unified diff");
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
  });

  it("loads multi-file .patch files into the canonical preview and preserves read-only source mode", async () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-oldA",
      "+newA",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-oldB",
      "+newB",
    ].join("\n");
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({ path: "changes.patch", content: patch, encoding: "utf-8" }),
      writeDocument: vi.fn(),
    });

    render(<FilePreview request={{ type: "file", path: "changes.patch" }} sessionId="ses-1" runtime={runtime} />);

    const preview = await screen.findByLabelText("差异文件预览");
    expect(preview.textContent).toContain("src/a.ts");
    expect(preview.textContent).toContain("src/b.ts");
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
    expect(screen.getByRole("button", { name: "预览" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "源码" }));

    const source = await screen.findByTestId("file-source-viewer");
    expect(source.textContent).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(source.getAttribute("data-editable")).toBe("false");
    expect(screen.queryByLabelText("差异文件预览")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.getByLabelText("差异文件预览")).not.toBeNull();
  });

  it("rebuilds a .diff document from refreshed file content", async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce({
        path: "changes.diff",
        content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+first",
        encoding: "utf-8",
      })
      .mockResolvedValueOnce({
        path: "changes.diff",
        content: "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+second",
        encoding: "utf-8",
      });
    const runtime = fakeRuntime({ readFile });
    const { rerender } = render(
      <FilePreview
        request={{ type: "file", path: "changes.diff" }}
        sessionId="ses-1"
        runtime={runtime}
        refreshRequestId={0}
      />,
    );

    expect((await screen.findByLabelText("差异文件预览")).textContent).toContain("a.ts");

    rerender(
      <FilePreview
        request={{ type: "file", path: "changes.diff" }}
        sessionId="ses-1"
        runtime={runtime}
        refreshRequestId={1}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("差异文件预览").textContent).toContain("b.ts"));
    expect(screen.getByLabelText("差异文件预览").textContent).not.toContain("a.ts");
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["empty.patch", "", "内容为空"],
    ["binary.diff", "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ", "logo.png"],
  ])("keeps %s inside the canonical diagnostic-capable preview", async (path, content, expected) => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockResolvedValue({ path, content, encoding: "utf-8" }),
    });

    render(<FilePreview request={{ type: "file", path }} sessionId="ses-1" runtime={runtime} />);

    expect((await screen.findByLabelText("差异文件预览")).textContent).toContain(expected);
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
  });

  it("reports oversized .patch reads without instantiating either diff renderer", async () => {
    const runtime = fakeRuntime({
      readFile: vi.fn().mockRejectedValue(new Error("文件过大，暂不预览")),
    });

    render(<FilePreview request={{ type: "file", path: "large.patch" }} sessionId="ses-1" runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toBe("文件过大，暂不预览");
    expect(screen.queryByLabelText("差异文件预览")).toBeNull();
    expect(screen.queryByLabelText("Diff 渲染内容")).toBeNull();
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

function LinkedPreviewHarness({
  initialRequest,
  runtime,
}: {
  initialRequest: PreviewRequest;
  runtime: RuntimeBridge;
}) {
  const preview = usePreview();
  const openPreview = preview.openPreview;
  const entry = preview.activeEntry;

  useEffect(() => {
    openPreview(initialRequest, { runtime, sessionId: "ses-1" });
  }, [initialRequest, openPreview, runtime]);

  const requestLabel = entry?.request.type === "skill-resource"
    ? `${entry.request.type}:${entry.request.resourcePath}`
    : entry?.request.type === "file" || entry?.request.type === "local-file"
      ? `${entry.request.type}:${entry.request.path}`
      : entry?.request.type ?? "";

  return (
    <>
      <output data-testid="linked-preview-request">{requestLabel}</output>
      {entry ? (
        <FilePreview
          request={entry.request}
          runtime={runtime}
          sessionId="ses-1"
          sourceRevealRequest={entry.revealTarget ? { requestId: entry.openedAt, ...entry.revealTarget } : null}
        />
      ) : null}
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
