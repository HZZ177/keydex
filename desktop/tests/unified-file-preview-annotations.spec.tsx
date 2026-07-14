import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type { AnnotationRecord } from "@/runtime/annotations";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const record: AnnotationRecord = {
  id: "ann-alpha",
  workspace_id: "ws-1",
  document_path: "README.md",
  body: "Explain alpha",
  created_at: "2026-07-11T10:00:00Z",
  updated_at: "2026-07-11T10:00:00Z",
  target: {
    type: "text",
    selector: {
      position: { start: 7, end: 12 },
      quote: { exact: "Alpha", prefix: "Title\n\n", suffix: " paragraph." },
      context: { containerType: "paragraph", headingPath: ["Title"] },
      textRevision: "old",
      documentRevision: "old",
    },
  },
};

const documentRecord: AnnotationRecord = {
  id: "ann-document",
  workspace_id: "ws-1",
  document_path: "README.md",
  body: "Review the whole document",
  created_at: "2026-07-11T11:00:00Z",
  updated_at: "2026-07-11T11:00:00Z",
  target: { type: "document" },
};

const paragraphRecord: AnnotationRecord = {
  ...record,
  id: "ann-paragraph",
  body: "Explain paragraph",
  created_at: "2026-07-11T10:05:00Z",
  updated_at: "2026-07-11T10:05:00Z",
  target: {
    type: "text",
    selector: {
      position: { start: 15, end: 24 },
      quote: { exact: "paragraph", prefix: "# Title\n\nAlpha ", suffix: "." },
      context: { containerType: "paragraph", headingPath: ["Title"] },
      textRevision: "old",
      documentRevision: "old",
    },
  },
};

function runtime(records: AnnotationRecord[] = [record]): RuntimeBridge {
  return {
    workspace: {
      readFile: vi.fn().mockResolvedValue({
        path: "README.md",
        content: "# Title\n\nAlpha paragraph.",
        encoding: "utf-8",
        revision: "sha256:current",
      }),
    },
    annotations: {
      list: vi.fn().mockResolvedValue(records),
      create: vi.fn(),
      updateBody: vi.fn(),
      replaceTarget: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as RuntimeBridge;
}

const markdownRuntimeSnapshotLoader = async ({ source, revision }: { source: string; revision: string }) => (
  parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:ws-1:README.md",
    revision,
    source,
    rendererProfile: "file-preview",
  })
);

let originalRangeRect: PropertyDescriptor | undefined;
let originalRangeRects: PropertyDescriptor | undefined;

describe("unified FilePreview annotations", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => domRect(0, 0, 48, 18),
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [domRect(0, 0, 48, 18)],
    });
  });

  afterEach(() => {
    if (originalRangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeRect);
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    if (originalRangeRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
    vi.unstubAllGlobals();
  });

  it("counts text and document annotations together in the rail header", async () => {
    render(
      <FilePreview
        markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
        request={{ type: "file", path: "README.md" }}
        runtime={runtime([record, documentRecord])}
        workspaceId="ws-1"
      />,
    );

    fireEvent.click(await screen.findByLabelText("文件批注 2"));
    expect(await screen.findByLabelText("全文批注：Review the whole document")).not.toBeNull();
    expect(document.querySelector("[data-annotation-total-count='true']")?.textContent).toBe("2");
    const placement = document.querySelector<HTMLElement>("[data-annotation-placement-id='ann-alpha']");
    const expandedTop = Number.parseFloat(placement?.style.top ?? "0");

    fireEvent.click(screen.getByLabelText("收起全文批注"));
    expect(screen.getByLabelText("全文批注：Review the whole document").closest("[aria-hidden='true']")).not.toBeNull();
    await waitFor(() => {
      expect(Number.parseFloat(placement?.style.top ?? "0")).toBeLessThan(expandedTop);
    });
  });

  it("keeps annotation controls out of the document scrollbar", async () => {
    render(
      <FilePreview
        markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
        request={{ type: "file", path: "README.md" }}
        runtime={runtime([record, documentRecord])}
        workspaceId="ws-1"
      />,
    );

    const toggle = await screen.findByLabelText("文件批注 2");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-annotation-scroll-marker='true']")).toBeNull();
    expect(screen.queryByRole("button", { name: /定位批注/ })).toBeNull();
  });

  it("navigates and flashes the matching body marker from both adjacent controls after a distant manual scroll", async () => {
    render(
      <FilePreview
        markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
        request={{ type: "file", path: "README.md" }}
        runtime={runtime([record, paragraphRecord])}
        workspaceId="ws-1"
      />,
    );

    fireEvent.click(await screen.findByLabelText("文件批注 2"));
    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']")!;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 12_000 },
      scrollTo: { configurable: true, value: vi.fn() },
      scrollTop: { configurable: true, value: 10_000, writable: true },
    });
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByLabelText("下一条选区批注"));
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("1 / 2");
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
    fireEvent.animationEnd(document.querySelector("[data-annotation-id='ann-alpha']") as Element);
    fireEvent.click(screen.getByLabelText("下一条选区批注"));
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("2 / 2");
      expect(document.querySelector("[data-annotation-id='ann-paragraph']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBeNull();
    });
    fireEvent.animationEnd(document.querySelector("[data-annotation-id='ann-paragraph']") as Element);
    fireEvent.click(screen.getByLabelText("上一条选区批注"));
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("1 / 2");
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-paragraph']")?.getAttribute("data-annotation-navigation-flash")).toBeNull();
    });
    expect(vi.mocked(viewport.scrollTo)).toHaveBeenCalled();
  });

  it("uses a workspace-relative annotation path for a local file preview", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const localRuntime = {
      localPreview: {
        readDocument: vi.fn().mockResolvedValue({
          document_id: "tauri:D:/repo/notes.txt",
          source: "tauri",
          path: "D:/repo/notes.txt",
          content: "Title\n\nAlpha paragraph.",
          encoding: "utf-8",
          revision: "sha256:current",
          total_bytes: 23,
        }),
        readFile: vi.fn(),
        readMedia: vi.fn(),
      },
      annotations: {
        list,
        create: vi.fn(),
        updateBody: vi.fn(),
        replaceTarget: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as RuntimeBridge;

    render(
      <FilePreview
        request={{ type: "local-file", path: "D:/repo/notes.txt" }}
        runtime={localRuntime}
        workspaceAnnotationPath="notes.txt"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith("ws-1", "notes.txt", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it("does not send an absolute local file path to the workspace annotation runtime", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const localRuntime = {
      localPreview: {
        readDocument: vi.fn().mockResolvedValue({
          document_id: "tauri:D:/outside/notes.txt",
          source: "tauri",
          path: "D:/outside/notes.txt",
          content: "Title",
          encoding: "utf-8",
          revision: "sha256:outside",
          total_bytes: 5,
        }),
        readFile: vi.fn(),
        readMedia: vi.fn(),
      },
      annotations: {
        list,
        create: vi.fn(),
        updateBody: vi.fn(),
        replaceTarget: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as RuntimeBridge;

    render(
      <FilePreview
        request={{ type: "local-file", path: "D:/outside/notes.txt" }}
        runtime={localRuntime}
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector("[data-file-preview-root='true']")?.getAttribute("data-document-revision"))
        .toBe("sha256:outside");
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("routes annotation runtime failures through the global notification viewport", async () => {
    const message = "Annotation path must be workspace-relative";
    const failedRuntime = runtime([]);
    vi.mocked(failedRuntime.annotations.list).mockRejectedValue(new Error(message));

    render(
      <NotificationProvider>
        <FilePreview
          markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
          request={{ type: "file", path: "README.md" }}
          runtime={failedRuntime}
          workspaceId="ws-1"
        />
      </NotificationProvider>,
    );

    const notificationViewport = screen.getByTestId("notification-viewport");
    await waitFor(() => expect(within(notificationViewport).getByText(message)).not.toBeNull());
    expect(within(notificationViewport).getByTestId("notification-item").getAttribute("data-type")).toBe("error");
    expect(within(screen.getByLabelText("文件预览")).queryByText(message)).toBeNull();
  });

  it("keeps one rail and one active state across preview, source, and split", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);

    expect(await screen.findByRole("heading", { name: "Title" })).not.toBeNull();
    const toggle = await screen.findByLabelText("文件批注 1");
    fireEvent.click(toggle);
    expect(await screen.findByLabelText("批注：Explain alpha")).not.toBeNull();
    expect(document.querySelectorAll("[data-annotation-rail='true']")).toHaveLength(1);
    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']");
    const canvas = viewport?.firstElementChild as HTMLElement | undefined;
    const rail = document.querySelector<HTMLElement>("[data-annotation-rail='true']");
    expect(viewport).not.toBeNull();
    expect(canvas?.contains(rail)).toBe(true);
    const previewScrollRail = screen.getByTestId("preview-scroll-rail");
    expect(viewport?.parentElement?.contains(previewScrollRail)).toBe(true);
    expect(viewport?.contains(previewScrollRail)).toBe(false);
    const bottomActions = await screen.findByLabelText("批注操作");
    expect(viewport?.contains(bottomActions)).toBe(false);
    expect(viewport?.parentElement?.contains(bottomActions)).toBe(true);
    expect(bottomActions.textContent).toContain("全部引入对话");
    expect(bottomActions.textContent).toContain("新增文档批注");
    const railHeader = document.querySelector("[data-annotation-rail-content='true'] header");
    expect(railHeader?.contains(screen.getByLabelText("全部引入对话"))).toBe(false);
    expect(railHeader?.contains(screen.getByLabelText("新增文档批注"))).toBe(false);
    expect(document.querySelector("[data-annotation-id='ann-alpha']")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    await waitFor(() => expect(document.querySelector(".cm-annotation-mark[data-annotation-id='ann-alpha']")).not.toBeNull());
    expect(screen.getByLabelText("批注：Explain alpha")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    await waitFor(() => {
      expect(document.querySelector(".cm-annotation-mark[data-annotation-id='ann-alpha']")).not.toBeNull();
      expect(document.querySelector("[data-annotation-id='ann-alpha']")).not.toBeNull();
    });
    expect(screen.getByLabelText("批注：Explain alpha")).not.toBeNull();
    expect(document.querySelectorAll("[data-annotation-rail='true']")).toHaveLength(1);
  });

  it("renders source connectors and keeps split connector ownership on the right preview only", async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const elementRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rectForElement(this: HTMLElement) {
      if (this.matches(".cm-annotation-mark[data-annotation-id='ann-alpha']")) {
        return domRect(120, 140, 80, 20);
      }
      return domRect(0, 0, 900, 600);
    });
    const elementRects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function rectsForElement(this: HTMLElement) {
      return this.matches(".cm-annotation-mark[data-annotation-id='ann-alpha']")
        ? [domRect(120, 140, 80, 20)] as unknown as DOMRectList
        : [] as unknown as DOMRectList;
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 1200 });
    vi.stubGlobal("ResizeObserver", TriggerResizeObserver);

    try {
      render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
      expect(await screen.findByRole("heading", { name: "Title" })).not.toBeNull();
      const modeButtons = document.querySelectorAll<HTMLButtonElement>("[class*='segmented'] button");
      fireEvent.click(modeButtons[1]!);
      await waitFor(() => expect(document.querySelector(".cm-annotation-mark[data-annotation-id='ann-alpha']")).not.toBeNull());
      const toggle = document.querySelector<HTMLButtonElement>(
        "button[aria-pressed][data-file-preview-selection-excluded='true']",
      )!;
      fireEvent.click(toggle);
      await screen.findByText("Explain alpha");
      await act(async () => {
        TriggerResizeObserver.flush();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      await waitFor(() => expect(document.querySelector("[data-annotation-connector-id='ann-alpha']")).not.toBeNull());
      expect(document.querySelectorAll("[data-annotation-connector-layer='true']")).toHaveLength(1);
      expect(document.querySelectorAll("[data-annotation-connector-id='ann-alpha']")).toHaveLength(1);

      fireEvent.click(modeButtons[2]!);
      await waitFor(() => expect(document.querySelector("[data-markdown-annotation-overlay-marker='true'][data-annotation-id='ann-alpha']")).not.toBeNull());
      await act(async () => {
        TriggerResizeObserver.flush();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      await waitFor(() => expect(document.querySelector("[data-annotation-connector-id='ann-alpha']")).not.toBeNull());
      expect(document.querySelectorAll("[data-annotation-connector-layer='true']")).toHaveLength(1);
      expect(document.querySelectorAll("[data-annotation-connector-id='ann-alpha']")).toHaveLength(1);
    } finally {
      elementRect.mockRestore();
      elementRects.mockRestore();
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    }
  });

  it("keeps unified annotations active on the retained Runtime across preview, source, and split", async () => {
    const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => domRect(0, 0, 48, 18),
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [domRect(0, 0, 48, 18)],
    });
    try {
      render(
        <FilePreview
          request={{ type: "file", path: "README.md" }}
          runtime={runtime()}
          workspaceId="ws-1"
          markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
        />,
      );

      expect(await screen.findByRole("heading", { name: "Title" })).not.toBeNull();
      const runtimeMarker = await waitFor(() => {
        const element = document.querySelector<HTMLElement>("[data-markdown-annotation-overlay-marker='true'][data-annotation-id='ann-alpha']");
        expect(element).not.toBeNull();
        return element!;
      });
      fireEvent.click(runtimeMarker);
      await waitFor(() => expect(document.querySelector("[data-annotation-rail='true']:not([hidden])")).not.toBeNull());

      const modeGroup = document.querySelector<HTMLElement>("[aria-label][class*='segmented']")!;
      const modeButtons = modeGroup.querySelectorAll("button");
      fireEvent.click(modeButtons[1]!);
      await waitFor(() => expect(document.querySelector(".cm-annotation-mark[data-annotation-id='ann-alpha']")).not.toBeNull());
      fireEvent.click(modeButtons[2]!);
      await waitFor(() => {
        expect(document.querySelector(".cm-annotation-mark[data-annotation-id='ann-alpha']")).not.toBeNull();
        expect(document.querySelector("[data-markdown-annotation-overlay-marker='true'][data-annotation-id='ann-alpha']")).not.toBeNull();
      });
      expect(document.querySelectorAll("[data-annotation-rail='true']")).toHaveLength(1);
    } finally {
      if (rangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRect);
      else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
      else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
    }
  });

  it("closes and reopens the invasive rail without losing records", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
    const toggle = await screen.findByLabelText("文件批注 1");
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByLabelText("收起批注栏"));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(await screen.findByLabelText("批注：Explain alpha")).not.toBeNull();
  });

  it("opens the embedded rail when a document annotation highlight is clicked", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);

    const toggle = await waitFor(() => {
      const element = document.querySelector<HTMLButtonElement>(
        "button[aria-pressed][data-file-preview-selection-excluded='true']",
      );
      expect(element).not.toBeNull();
      return element as HTMLButtonElement;
    });
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-id='ann-alpha']")).not.toBeNull();
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']") as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1600 },
      scrollTo: { configurable: true, value: scrollTo },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 1000, 400));
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const cardRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      return this.dataset.annotationCardId === "ann-alpha"
        ? domRect(720, 720, 280, 80)
        : originalGetBoundingClientRect.call(this);
    });

    try {
      fireEvent.click(document.querySelector("[data-annotation-id='ann-alpha']") as Element);

      await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
      expect(await screen.findByText("Explain alpha")).not.toBeNull();
      await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 560 }));
      expect(document.querySelector("[data-annotation-card-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    } finally {
      cardRect.mockRestore();
    }
  });

  it("waits for the measured end-of-document card placement before scrolling on first open", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);

    const marker = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-annotation-id='ann-alpha']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const markdownRoot = marker.closest<HTMLElement>("[data-markdown-runtime-features='ready']")!;
    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']")!;
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 12_000 },
      scrollTo: { configurable: true, value: scrollTo },
      scrollTop: { configurable: true, value: 10_000, writable: true },
    });
    Object.defineProperty(markdownRoot, "scrollHeight", { configurable: true, value: 12_000 });
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const elementRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this === viewport) return domRect(0, 0, 1000, 400);
      if (this === markdownRoot) return domRect(-10_000, 0, 700, 12_000);
      if (this.dataset.annotationId === "ann-alpha") return domRect(320, 120, 48, 18);
      if (this.dataset.annotationCardId === "ann-alpha") {
        const placement = this.closest<HTMLElement>("[data-annotation-placement-id='ann-alpha']");
        const documentTop = Number.parseFloat(placement?.style.top ?? "0");
        return domRect(documentTop - viewport.scrollTop, 720, 280, 80);
      }
      return originalGetBoundingClientRect.call(this);
    });

    try {
      fireEvent.click(marker);

      await waitFor(() => {
        expect(document.querySelector("[data-annotation-card-id='ann-alpha']")
          ?.getAttribute("data-annotation-navigation-flash")).toBe("true");
      });
      const requestedTops = scrollTo.mock.calls.map(([options]) => (options as ScrollToOptions).top ?? 0);
      expect(requestedTops.length).toBeGreaterThan(0);
      expect(Math.min(...requestedTops)).toBeGreaterThan(9_000);
    } finally {
      elementRect.mockRestore();
    }
  });

  it("replays counterpart flashes on repeated clicks and clears the highlight outside", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
    fireEvent.click(await screen.findByLabelText("文件批注 1"));
    const card = await screen.findByLabelText("批注：Explain alpha");
    const marker = () => document.querySelector<HTMLElement>("[data-annotation-id='ann-alpha']");
    const viewport = screen.getByLabelText("预览内容");
    await waitFor(() => expect(marker()).not.toBeNull());

    fireEvent.click(marker() as HTMLElement);
    await waitFor(() => {
      expect(marker()?.getAttribute("data-active")).toBe("true");
      expect(card.getAttribute("data-active")).toBe("true");
      expect(card.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
    fireEvent.animationEnd(card);
    expect(card.getAttribute("data-annotation-navigation-flash")).toBeNull();

    fireEvent.click(marker() as HTMLElement);
    await waitFor(() => {
      expect(marker()?.getAttribute("data-active")).toBe("true");
      expect(card.getAttribute("data-active")).toBe("true");
      expect(card.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });

    fireEvent.click(viewport);
    await waitFor(() => {
      expect(marker()?.getAttribute("data-active")).toBe("false");
      expect(card.getAttribute("data-active")).toBe("false");
      expect(card.getAttribute("data-annotation-navigation-flash")).toBeNull();
    });

    fireEvent.click(card);
    await waitFor(() => {
      expect(marker()?.getAttribute("data-active")).toBe("true");
      expect(card.getAttribute("data-active")).toBe("true");
      expect(marker()?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
    fireEvent.animationEnd(marker() as HTMLElement);
    expect(marker()?.getAttribute("data-annotation-navigation-flash")).toBeNull();

    fireEvent.click(card);
    await waitFor(() => {
      expect(marker()?.getAttribute("data-active")).toBe("true");
      expect(card.getAttribute("data-active")).toBe("true");
      expect(marker()?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });

    fireEvent.click(viewport);
    await waitFor(() => {
      expect(marker()?.getAttribute("data-active")).toBe("false");
      expect(card.getAttribute("data-active")).toBe("false");
      expect(marker()?.getAttribute("data-annotation-navigation-flash")).toBeNull();
    });
  });

  it("lets a rapid second card press interrupt the first card navigation", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime([record, paragraphRecord])} workspaceId="ws-1" />);
    fireEvent.click(await screen.findByLabelText("文件批注 2"));
    const firstCard = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-annotation-card-id='ann-alpha']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const secondCard = document.querySelector<HTMLElement>("[data-annotation-card-id='ann-paragraph']")!;

    fireEvent.pointerDown(firstCard, { button: 0, pointerType: "mouse" });
    fireEvent.pointerDown(secondCard, { button: 0, pointerType: "mouse" });

    await waitFor(() => {
      expect(firstCard.getAttribute("data-active")).toBe("false");
      expect(secondCard.getAttribute("data-active")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-active")).toBe("false");
      expect(document.querySelector("[data-annotation-id='ann-paragraph']")?.getAttribute("data-active")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-paragraph']")
        ?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
  });

  it("keeps the active item while the rail header switches to adjacent annotations", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime([record, paragraphRecord])} workspaceId="ws-1" />);
    fireEvent.click(await screen.findByLabelText("文件批注 2"));
    const firstCard = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-annotation-card-id='ann-alpha']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const railNavigation = document.querySelector<HTMLElement>("[data-annotation-rail='true'] [role='group']")!;
    const [previous, next] = Array.from(railNavigation.querySelectorAll<HTMLButtonElement>("button"));

    fireEvent.pointerDown(firstCard, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(firstCard.getAttribute("data-active")).toBe("true"));

    fireEvent.click(next!);
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("2 / 2");
      expect(document.querySelector("[data-annotation-card-id='ann-paragraph']")?.getAttribute("data-active")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-paragraph']")?.getAttribute("data-active")).toBe("true");
    });

    fireEvent.click(previous!);
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("1 / 2");
      expect(document.querySelector("[data-annotation-card-id='ann-alpha']")?.getAttribute("data-active")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-active")).toBe("true");
    });
  });

  it("deepens the complete annotation chain from either marker or card hover", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
    fireEvent.click(await screen.findByLabelText("文件批注 1"));
    const card = await screen.findByLabelText("批注：Explain alpha");
    const marker = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-annotation-id='ann-alpha']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    fireEvent.mouseOver(marker);
    await waitFor(() => {
      const hoveredMarker = document.querySelector("[data-annotation-id='ann-alpha']");
      expect(hoveredMarker).not.toBeNull();
      expect(hoveredMarker?.getAttribute("data-hovered")).toBe("true");
      expect(card.getAttribute("data-hovered")).toBe("true");
    });

    fireEvent.mouseOut(document.querySelector("[data-annotation-id='ann-alpha']") as Element);
    await waitFor(() => expect(card.getAttribute("data-hovered")).toBe("false"));

    fireEvent.pointerEnter(card);
    await waitFor(() => {
      expect(card.getAttribute("data-hovered")).toBe("true");
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-hovered")).toBe("true");
    });
    fireEvent.pointerLeave(card);
    await waitFor(() => expect(card.getAttribute("data-hovered")).toBe("false"));
  });

  it("scrolls to and flashes the body marker once after card navigation reaches the document", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
    fireEvent.click(await screen.findByLabelText("文件批注 1"));
    const card = await screen.findByLabelText("批注：Explain alpha");
    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']")!;
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 12_000 },
      scrollTo: { configurable: true, value: scrollTo },
      scrollTop: { configurable: true, value: 10_000, writable: true },
    });

    fireEvent.click(card);

    await waitFor(() => {
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
    expect(scrollTo).toHaveBeenCalled();
  });

  it("reveals and highlights an annotation from a same-file capsule without reloading the document", async () => {
    const localRuntime = runtime();
    const request = { type: "file" as const, path: "README.md" };
    const view = render(
      <FilePreview
        markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
        request={request}
        runtime={localRuntime}
        workspaceId="ws-1"
      />,
    );

    const marker = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-annotation-id='ann-alpha']");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const previewRoot = document.querySelector<HTMLElement>("[data-file-preview-root='true']");
    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']")!;
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1600 },
      scrollTo: { configurable: true, value: scrollTo },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 1000, 400));
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(domRect(720, 720, 48, 18));

    view.rerender(
      <FilePreview
        markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader}
        request={request}
        runtime={localRuntime}
        sourceRevealRequest={{ annotationId: "ann-alpha", requestId: 1 }}
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("文件批注 1").getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" })));
    expect(document.querySelector("[data-file-preview-root='true']")).toBe(previewRoot);
    expect(localRuntime.workspace.readFile).toHaveBeenCalledTimes(1);
  });

  it("shows a focused draft editor immediately after annotating a markdown selection", async () => {
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime([])} workspaceId="ws-1" />);

    await waitFor(() => {
      expect(document.querySelector("[data-markdown-runtime-features='ready']")).not.toBeNull();
      expect(document.querySelector("[data-file-annotation-model-ready='true']")).not.toBeNull();
    });
    const body = await screen.findByLabelText("预览内容");
    const viewport = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']")!;
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1600 },
      scrollTo: { configurable: true, value: scrollTo },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const elementRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this === viewport) return domRect(0, 0, 1000, 400);
      if (this.dataset.annotationDraftEditor === "true") return domRect(720, 720, 280, 86);
      return originalGetBoundingClientRect.call(this);
    });
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    const selection = mockTextSelection(body, "Alpha");
    try {
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
        document.dispatchEvent(new MouseEvent("mouseup"));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(document.querySelector("[data-file-markdown-runtime-selection='true']")).not.toBeNull();
      });
      fireEvent.click(await screen.findByRole("button", { name: "为选中文本添加批注" }));

      const editor = await screen.findByLabelText("批注内容");
      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 563 }));
      expect(screen.getByLabelText("文件批注 0").getAttribute("aria-pressed")).toBe("true");
      await waitFor(() => {
        expect(document.querySelector(`[data-annotation-id="__annotation_draft__"]`)).not.toBeNull();
      });
    } finally {
      selection.restore();
      elementRect.mockRestore();
      focus.mockRestore();
    }
  });

  it("starts a whole-file annotation from the rendered HTML frame action", async () => {
    const html = "<main><h1>页面预览</h1></main>";
    const localRuntime = runtime([]);
    vi.mocked(localRuntime.workspace.readFile).mockResolvedValue({
      path: "index.html",
      content: html,
      encoding: "utf-8",
      revision: "sha256:html",
    });

    render(
      <FilePreview
        request={{ type: "file", path: "index.html" }}
        runtime={localRuntime}
        workspaceId="ws-1"
      />,
    );

    expect(await screen.findByTitle("HTML 文件预览")).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "批注整个 HTML 预览" }));

    const editor = await screen.findByLabelText("批注内容");
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(document.querySelector("[data-resource-annotation-highlight='true']")).not.toBeNull();
  });

  it("emits reference-only payloads for single and bulk chat actions", async () => {
    const onStartChatFromAnnotation = vi.fn();
    render(<FilePreview markdownRuntimeSnapshotLoader={markdownRuntimeSnapshotLoader} request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" onStartChatFromAnnotation={onStartChatFromAnnotation} />);
    fireEvent.click(await screen.findByLabelText("文件批注 1"));
    const card = await screen.findByLabelText("批注：Explain alpha");
    fireEvent.click(card.querySelector("[aria-label='将批注加入对话']") as Element);
    expect(onStartChatFromAnnotation).toHaveBeenLastCalledWith({
      annotationId: "ann-alpha",
      body: "Explain alpha",
      kind: "text",
      workspaceId: "ws-1",
      path: "README.md",
    });
    fireEvent.click(screen.getByLabelText("全部引入对话"));
    expect(onStartChatFromAnnotation).toHaveBeenLastCalledWith([{
      annotationId: "ann-alpha",
      body: "Explain alpha",
      kind: "text",
      workspaceId: "ws-1",
      path: "README.md",
    }]);
  });
});

function mockTextSelection(container: Element, text: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let target: Text | null = null;
  let offset = -1;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const index = node.data.indexOf(text);
    if (index >= 0) {
      target = node;
      offset = index;
      break;
    }
  }
  if (!target || offset < 0) throw new Error(`Selection text is unavailable: ${text}`);
  const range = document.createRange();
  range.setStart(target, offset);
  range.setEnd(target, offset + text.length);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ bottom: 160, height: 20, left: 120, right: 220, top: 140, width: 100, x: 120, y: 140, toJSON: () => ({}) }),
  });
  const selection = window.getSelection();
  if (!selection) throw new Error("Selection API is unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  return { restore: () => selection.removeAllRanges() };
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

class TriggerResizeObserver implements ResizeObserver {
  static readonly instances = new Set<TriggerResizeObserver>();
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TriggerResizeObserver.instances.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    TriggerResizeObserver.instances.delete(this);
  }

  static flush(): void {
    for (const observer of TriggerResizeObserver.instances) {
      const entries = [...observer.targets].map((target) => ({
        borderBoxSize: [{ blockSize: 112, inlineSize: 900 }],
        contentBoxSize: [{ blockSize: 112, inlineSize: 900 }],
        contentRect: domRect(0, 0, 900, 112),
        devicePixelContentBoxSize: [],
        target,
      } as unknown as ResizeObserverEntry));
      if (entries.length > 0) observer.callback(entries, observer);
    }
  }
}
