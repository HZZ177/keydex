import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useMemo, type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import {
  fileMarkdownViewStateStore,
  resetFileMarkdownRuntimeStoreForTests,
} from "@/renderer/components/workspace/fileMarkdownRuntime";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  PreviewProvider,
  usePreview,
  type PreviewContextValue,
} from "@/renderer/providers/PreviewProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

describe("PreviewProvider Markdown Runtime continuity", () => {
  it("reuses one entry/view attachment and applies the latest same-file reveal", async () => {
    const source = largeMarkdown(240);
    const previewRef = { current: null } as MutableRefObject<PreviewContextValue | null>;
    render(
      <PreviewProvider>
        <RuntimePreviewProbe previewRef={previewRef} source={source} sidebarDescriptor />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open first target" }));
    const canvas = await readyCanvas();
    const runtimeHost = document.querySelector<HTMLElement>("[data-file-markdown-runtime-host='true']");
    const firstEntry = previewRef.current!.activeEntry!;
    const firstOpenedAt = firstEntry.openedAt;
    expect(fileMarkdownViewStateStore().diagnostics()).toMatchObject({ attachedViews: 1, entries: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Open tail target" }));
    await waitFor(() => expect(previewRef.current!.activeEntry!.openedAt).toBeGreaterThan(firstOpenedAt));
    await waitFor(() => expect(runtimeScroll().scrollTop).toBeGreaterThan(0));
    const secondOpenedAt = previewRef.current!.activeEntry!.openedAt;
    const scroll = runtimeScroll();
    act(() => {
      scroll.scrollTop = 0;
      fireEvent.scroll(scroll);
    });
    await nextFrame();
    expect(scroll.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Open tail target" }));
    await waitFor(() => expect(previewRef.current!.activeEntry!.openedAt).toBeGreaterThan(secondOpenedAt));
    await waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));

    expect(previewRef.current!.entries).toHaveLength(1);
    expect(previewRef.current!.activeEntry!.markdownView).toBe(firstEntry.markdownView);
    expect(document.querySelector("[data-file-markdown-runtime-host='true']")).toBe(runtimeHost);
    expect(canvas.dataset.markdownRuntimeEntryId).toBe(firstEntry.markdownView.entryId);
  });

  it("restores view-local scroll after switching entries and disposes it on close", async () => {
    const previewRef = { current: null } as MutableRefObject<PreviewContextValue | null>;
    render(
      <PreviewProvider>
        <RuntimePreviewProbe previewRef={previewRef} source={largeMarkdown(300)} />
      </PreviewProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open first target" }));
    await readyCanvas();
    const guideId = previewRef.current!.activeEntry!.id;
    const scroll = runtimeScroll();
    await act(async () => {
      scroll.scrollTop = 4_000;
      fireEvent.scroll(scroll);
      await nextFrame();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open other file" }));
    await waitFor(() => expect(previewRef.current!.activeEntry!.id).not.toBe(guideId));
    await readyCanvas();
    expect(scroll.scrollTop).toBe(0);

    act(() => previewRef.current!.switchPreview(guideId));
    await waitFor(() => expect(previewRef.current!.activeEntry!.id).toBe(guideId));
    await readyCanvas();
    await waitFor(() => expect(scroll.scrollTop).toBe(4_000));

    act(() => previewRef.current!.closePreviewEntry(guideId));
    await waitFor(() => expect(fileMarkdownViewStateStore().diagnostics().entries).toBe(1));
    expect(previewRef.current!.entries).toHaveLength(1);
  });

  it("evicts Runtime view state with the per-scope eight-entry preview budget", async () => {
    const previewRef = { current: null } as MutableRefObject<PreviewContextValue | null>;
    render(
      <PreviewProvider>
        <PreviewProbe previewRef={previewRef} />
      </PreviewProvider>,
    );

    for (let index = 0; index < 9; index += 1) {
      act(() => previewRef.current!.openPreview({ type: "file", path: `docs/${index}.md` }, { workspaceId: "ws-a" }));
      await waitFor(() => expect(previewRef.current!.activeEntry?.request).toMatchObject({ path: `docs/${index}.md` }));
      const descriptor = previewRef.current!.activeEntry!.markdownView;
      fileMarkdownViewStateStore().attach(descriptor).detach();
    }

    await waitFor(() => expect(previewRef.current!.entries).toHaveLength(8));
    await waitFor(() => expect(fileMarkdownViewStateStore().diagnostics()).toMatchObject({ retainedViews: 8, entries: 8 }));
    expect(previewRef.current!.entries.some((entry) => entry.request.type === "file" && entry.request.path === "docs/0.md"))
      .toBe(false);
  });

  it("isolates the same path across workspaces and restores each scope independently", async () => {
    const previewRef = { current: null } as MutableRefObject<PreviewContextValue | null>;
    render(
      <PreviewProvider>
        <PreviewProbe previewRef={previewRef} />
      </PreviewProvider>,
    );

    act(() => previewRef.current!.setPreviewHostContext({ workspaceId: "ws-a" }));
    await waitFor(() => expect(previewRef.current!.activeScopeKey).toBe("workspace:ws-a"));
    act(() => previewRef.current!.openPreview({ type: "file", path: "README.md" }));
    await waitFor(() => expect(previewRef.current!.activeEntry).not.toBeNull());
    const workspaceA = previewRef.current!.activeEntry!;

    act(() => previewRef.current!.setPreviewHostContext({ workspaceId: "ws-b" }));
    await waitFor(() => expect(previewRef.current!.activeScopeKey).toBe("workspace:ws-b"));
    act(() => previewRef.current!.openPreview({ type: "file", path: "README.md" }));
    await waitFor(() => expect(previewRef.current!.activeEntry).not.toBeNull());
    const workspaceB = previewRef.current!.activeEntry!;

    expect(workspaceB.id).not.toBe(workspaceA.id);
    expect(workspaceB.markdownView.scopeId).toBe("workspace:ws-b");
    act(() => previewRef.current!.setPreviewHostContext({ workspaceId: "ws-a" }));
    await waitFor(() => expect(previewRef.current!.activeEntry?.id).toBe(workspaceA.id));
  });
});

function RuntimePreviewProbe({
  previewRef,
  sidebarDescriptor = false,
  source,
}: {
  previewRef: MutableRefObject<PreviewContextValue | null>;
  sidebarDescriptor?: boolean;
  source: string;
}) {
  const preview = usePreview();
  previewRef.current = preview;
  const sidebarMarkdownViewDescriptor = useMemo(
    () => preview.activeEntry ? Object.freeze({
      ...preview.activeEntry.markdownView,
      viewId: "right-sidebar-preview",
      kind: "sidebar" as const,
    }) : undefined,
    [preview.activeEntry],
  );
  const open = (request: PreviewRequest, line: number) => preview.openPreview(request, undefined, {
    lineStart: line,
    lineEnd: line,
  });
  const guide = contentRequest("guide.md", source);
  return (
    <>
      <button type="button" onClick={() => open(guide, 1)}>Open first target</button>
      <button type="button" onClick={() => open(guide, source.split("\n").length - 2)}>Open tail target</button>
      <button type="button" onClick={() => open(contentRequest("other.md", "# Other\n\nOther body"), 1)}>Open other file</button>
      {preview.activeEntry ? (
        <div data-testid="runtime-scroll">
          <FilePreview
            request={preview.activeEntry.request}
            markdownRuntimeSnapshotLoader={snapshotLoader}
            sourceRevealRequest={preview.activeEntry.revealTarget
              ? { requestId: preview.activeEntry.openedAt, ...preview.activeEntry.revealTarget }
              : null}
            markdownViewDescriptor={sidebarDescriptor ? sidebarMarkdownViewDescriptor : undefined}
          />
        </div>
      ) : null}
    </>
  );
}

function PreviewProbe({ previewRef }: { previewRef: MutableRefObject<PreviewContextValue | null> }) {
  const preview = usePreview();
  previewRef.current = preview;
  useEffect(() => undefined, [preview]);
  return null;
}

async function snapshotLoader({ source, revision, signal }: {
  source: string;
  revision: string;
  signal: AbortSignal;
}): Promise<MarkdownSnapshot> {
  if (signal.aborted) throw signal.reason;
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:preview-provider:fixture.md",
    revision,
    source,
    rendererProfile: "file-preview",
  });
}

function contentRequest(path: string, content: string): PreviewRequest {
  return { type: "content", title: path, sourcePath: path, content, contentType: "markdown" };
}

function largeMarkdown(blocks: number): string {
  return Array.from({ length: blocks }, (_, index) => `## Heading ${index}\n\nBody ${index}`).join("\n\n");
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
