import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import type { RuntimeBridge } from "@/runtime";
import type { AnnotationRecord } from "@/runtime/annotations";

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

describe("unified FilePreview annotations", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  it("counts text and document annotations together in the rail header", async () => {
    render(
      <FilePreview
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

  it("keeps one rail and one active state across preview, source, and split", async () => {
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);

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

  it("closes and reopens the invasive rail without losing records", async () => {
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
    const toggle = await screen.findByLabelText("文件批注 1");
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByLabelText("收起批注栏"));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(await screen.findByLabelText("批注：Explain alpha")).not.toBeNull();
  });

  it("opens the embedded rail when a document annotation highlight is clicked", async () => {
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);

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

  it("deepens the complete annotation chain from either marker or card hover", async () => {
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
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
      expect(hoveredMarker).toBe(marker);
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

  it("flashes the body marker once after card navigation reaches the document", async () => {
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" />);
    fireEvent.click(await screen.findByLabelText("文件批注 1"));
    const card = await screen.findByLabelText("批注：Explain alpha");

    fireEvent.click(card);

    await waitFor(() => {
      expect(document.querySelector("[data-annotation-id='ann-alpha']")?.getAttribute("data-annotation-navigation-flash")).toBe("true");
    });
  });

  it("shows a focused draft editor immediately after annotating a markdown selection", async () => {
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime([])} workspaceId="ws-1" />);

    const body = await screen.findByLabelText("预览内容");
    const selection = mockTextSelection(body, "Alpha");
    try {
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup"));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
      fireEvent.click(await screen.findByRole("button", { name: "为选中文本添加批注" }));

      const editor = await screen.findByLabelText("批注内容");
      expect(document.activeElement).toBe(editor);
      expect(screen.getByLabelText("文件批注 0").getAttribute("aria-pressed")).toBe("true");
      await waitFor(() => {
        expect(document.querySelector(`[data-annotation-id="__annotation_draft__"]`)).not.toBeNull();
      });
    } finally {
      selection.restore();
    }
  });

  it("emits reference-only payloads for single and bulk chat actions", async () => {
    const onStartChatFromAnnotation = vi.fn();
    render(<FilePreview request={{ type: "file", path: "README.md" }} runtime={runtime()} workspaceId="ws-1" onStartChatFromAnnotation={onStartChatFromAnnotation} />);
    fireEvent.click(await screen.findByLabelText("文件批注 1"));
    const card = await screen.findByLabelText("批注：Explain alpha");
    fireEvent.click(card.querySelector("[aria-label='将批注加入对话']") as Element);
    expect(onStartChatFromAnnotation).toHaveBeenLastCalledWith({ annotationId: "ann-alpha", workspaceId: "ws-1", path: "README.md" });
    fireEvent.click(screen.getByLabelText("全部引入对话"));
    expect(onStartChatFromAnnotation).toHaveBeenLastCalledWith([{ annotationId: "ann-alpha", workspaceId: "ws-1", path: "README.md" }]);
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
  const spy = vi.spyOn(window, "getSelection").mockReturnValue({
    getRangeAt: () => range,
    rangeCount: 1,
    removeAllRanges: vi.fn(),
    toString: () => text,
  } as unknown as Selection);
  return { restore: () => spy.mockRestore() };
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
