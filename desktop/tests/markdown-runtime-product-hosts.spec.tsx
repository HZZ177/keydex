import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import { WorkspaceFileBrowser, type WorkspaceFileBrowserState } from "@/renderer/components/workspace/WorkspaceFileBrowser";
import {
  fileMarkdownViewStateStore,
  resetFileMarkdownRuntimeStoreForTests,
} from "@/renderer/components/workspace/fileMarkdownRuntime";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import { workbenchMarkdownViewDescriptor } from "@/renderer/pages/workbench/WorkbenchModePage";
import type { PreviewMarkdownViewDescriptor } from "@/renderer/providers/previewTypes";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SIDEBAR_STATE: WorkspaceFileBrowserState = {
  selectedPath: "README.md",
  mountedPreviewPath: "README.md",
  previewOpen: true,
  treeCollapsed: false,
  treeWidth: 260,
  navigationMode: "files",
  workspacePanelState: null,
};

let restoreMetrics: (() => void) | null = null;
let restoreScrollTo: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  restoreMetrics = mockElementMetrics({ clientHeight: 400, clientWidth: 900 });
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions | number) {
      this.scrollTop = typeof options === "number" ? options : options.top ?? this.scrollTop;
    }),
  });
  restoreScrollTo = () => {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  };
});

afterEach(() => {
  cleanup();
  resetFileMarkdownRuntimeStoreForTests();
  restoreMetrics?.();
  restoreMetrics = null;
  restoreScrollTo?.();
  restoreScrollTo = null;
  vi.unstubAllGlobals();
});

describe("Markdown Runtime product hosts", () => {
  it("restores the Sidebar file view after its product host unmounts and remounts", async () => {
    const runtime = fakeRuntime(largeMarkdown(300));
    const first = render(
      <WorkspaceFileBrowser
        runtime={runtime}
        sessionId="session-1"
        initialState={SIDEBAR_STATE}
        markdownRuntimeSnapshotLoader={snapshotLoader}
      />,
    );
    const firstCanvas = await readyCanvas();
    const firstScroll = runtimeScroll();
    expect(firstCanvas.dataset.markdownRuntimeViewId).toBe("sidebar-file-preview");
    expect(firstCanvas.dataset.markdownRuntimeEntryId).toMatch(/^sidebar:/u);
    await act(async () => {
      firstScroll.scrollTop = 5_000;
      fireEvent.scroll(firstScroll);
      await nextFrame();
    });

    first.unmount();
    expect(fileMarkdownViewStateStore().diagnostics()).toMatchObject({ attachedViews: 0, retainedViews: 1 });
    render(
      <WorkspaceFileBrowser
        runtime={runtime}
        sessionId="session-1"
        initialState={SIDEBAR_STATE}
        markdownRuntimeSnapshotLoader={snapshotLoader}
      />,
    );
    await readyCanvas();
    await waitFor(() => expect(runtimeScroll().scrollTop).toBe(5_000));
    expect(fileMarkdownViewStateStore().diagnostics()).toMatchObject({ attachedViews: 1, retainedViews: 1 });
    fireEvent.click(screen.getByRole("button", { name: "关闭文件预览" }));
    await waitFor(() => expect(fileMarkdownViewStateStore().diagnostics()).toMatchObject({ attachedViews: 0, retainedViews: 0 }));
  });

  it("keeps Sidebar and Workbench view state independent for the same document", async () => {
    const source = largeMarkdown(250);
    const sidebar: PreviewMarkdownViewDescriptor = {
      scopeId: "workspace:ws-1",
      entryId: "file:README.md",
      viewId: "sidebar",
      kind: "sidebar",
    };
    const workbench = workbenchMarkdownViewDescriptor(
      { type: "content", title: "README.md", sourcePath: "README.md", content: source, contentType: "markdown" },
      { panelScopeKey: "workspace:ws-1" },
      "file:README.md",
      sidebar,
    );
    render(
      <div>
        <FilePreview
          request={{ type: "content", title: "README.md", sourcePath: "README.md", content: source, contentType: "markdown" }}
          markdownRuntimeSnapshotLoader={snapshotLoader}
          markdownViewDescriptor={sidebar}
        />
        <FilePreview
          request={{ type: "content", title: "README.md", sourcePath: "README.md", content: source, contentType: "markdown" }}
          markdownRuntimeSnapshotLoader={snapshotLoader}
          markdownViewDescriptor={workbench}
        />
      </div>,
    );

    await waitFor(() => expect(document.querySelectorAll("[data-markdown-runtime-status='ready']")).toHaveLength(2));
    const canvases = [...document.querySelectorAll<HTMLElement>("[data-file-markdown-runtime-canvas='true']")];
    const scrolls = [...document.querySelectorAll<HTMLElement>("[data-document-scroll-viewport='true']")];
    expect(canvases.map((canvas) => canvas.dataset.markdownRuntimeViewId)).toEqual([
      "sidebar",
      "workbench-main-preview",
    ]);
    expect(workbench).toMatchObject({
      scopeId: sidebar.scopeId,
      entryId: sidebar.entryId,
      kind: "workbench",
      viewId: "workbench-main-preview",
    });
    await act(async () => {
      scrolls[0]!.scrollTop = 3_000;
      fireEvent.scroll(scrolls[0]!);
      await nextFrame();
    });
    expect(scrolls[1]!.scrollTop).toBe(0);
    expect(fileMarkdownViewStateStore().diagnostics()).toMatchObject({ attachedViews: 2, entries: 1 });
  });
});

async function snapshotLoader({ source, revision, signal }: {
  source: string;
  revision: string;
  signal: AbortSignal;
}): Promise<MarkdownSnapshot> {
  if (signal.aborted) throw signal.reason;
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:product-hosts:README.md",
    revision,
    source,
    rendererProfile: "file-preview",
  });
}

function fakeRuntime(content: string): RuntimeBridge {
  return {
    workspace: {
      listDirectory: vi.fn().mockResolvedValue({ root: "D:/repo", path: "", entries: [] }),
      listDirectorySubtree: vi.fn().mockResolvedValue({
        root: "D:/repo",
        path: "",
        entries_by_path: { "": [] },
        expanded_paths: [""],
        truncated: false,
        truncated_reason: null,
        visited_dirs: 1,
        entry_count: 0,
      }),
      search: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue({ path: "README.md", content, encoding: "utf-8" }),
    },
  } as unknown as RuntimeBridge;
}

function largeMarkdown(blocks: number): string {
  return Array.from({ length: blocks }, (_, index) => `## Host ${index}\n\nBody ${index}`).join("\n\n");
}

function readyCanvas(): Promise<HTMLElement> {
  return waitFor(() => {
    const canvas = document.querySelector<HTMLElement>("[data-file-markdown-runtime-canvas='true']");
    expect(canvas?.dataset.markdownRuntimeStatus).toBe("ready");
    return canvas!;
  });
}

function runtimeScroll(): HTMLElement {
  const scroll = document.querySelector<HTMLElement>("[data-document-scroll-viewport='true']");
  if (!scroll) throw new Error("Runtime scroll viewport is unavailable");
  return scroll;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function mockElementMetrics(metrics: { clientHeight: number; clientWidth: number }): () => void {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => metrics.clientWidth });
  return () => {
    if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  };
}
