import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import type { ResolvedTextAnnotation } from "@/renderer/features/annotations/domain/resolutions";
import { AnnotationRail } from "@/renderer/features/annotations/ui/AnnotationRail";
import type { AnnotationRecord } from "@/runtime/annotations";

const resizeObservers: FakeResizeObserver[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  resizeObservers.length = 0;
});

describe("AnnotationRail", () => {
  it("uses the explicit total count instead of only positioned text items", () => {
    renderRail(resolvedItems(), { totalCount: 4 });

    expect(document.querySelector("[data-annotation-total-count='true']")?.textContent).toBe("4");
  });

  it("shows the active text annotation position and routes previous and next navigation", () => {
    const onNavigateNext = vi.fn();
    const onNavigatePrevious = vi.fn();
    renderRail(resolvedItems(), {
      activeAnnotationId: "b",
      onNavigateNext,
      onNavigatePrevious,
    });

    expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("2 / 2");
    fireEvent.click(screen.getByLabelText("上一条选区批注"));
    fireEvent.click(screen.getByLabelText("下一条选区批注"));

    expect(onNavigatePrevious).toHaveBeenCalledTimes(1);
    expect(onNavigateNext).toHaveBeenCalledTimes(1);
  });

  it("uses the same logical order for the position counter and adjacent navigation", () => {
    const onNavigate = vi.fn();
    renderRail(resolvedItems(), { activeAnnotationId: "a", onNavigate });

    expect(document.querySelector("[data-annotation-navigation-position='true']")?.textContent).toBe("1 / 2");
    fireEvent.click(screen.getByLabelText("下一条选区批注"));

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({ id: "b" }),
    }));
  });

  it("positions resolved cards from the deterministic lane layout and marks active", () => {
    const items = resolvedItems();
    renderRail(items, { activeAnnotationId: "b" });

    const first = document.querySelector<HTMLElement>("[data-annotation-placement-id='a']");
    const second = document.querySelector<HTMLElement>("[data-annotation-placement-id='b']");
    expect(first?.style.top).toBe("76px");
    expect(Number.parseFloat(second?.style.top ?? "0")).toBeGreaterThan(76);
    expect(document.querySelector("[data-annotation-card-id='b']")?.getAttribute("data-active")).toBe("true");
  });

  it("reserves the measured top-section height before positioning text annotations", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    renderRail(resolvedItems(), {
      reservedTop: 100,
      top: <div data-testid="document-annotations">Document annotations</div>,
    });
    const topSection = document.querySelector<HTMLElement>("[data-annotation-top-section='true']")!;
    const observer = resizeObservers.find((candidate) => candidate.observes(topSection));
    expect(observer).toBeDefined();

    act(() => observer!.emit(240));

    await waitFor(() => {
      expect(document.querySelector("[data-annotation-lane-reserved-top='304']")).not.toBeNull();
      expect(document.querySelector<HTMLElement>("[data-annotation-placement-id='a']")?.style.top).toBe("304px");
    });
  });

  it("reports card hover and reflects the shared hovered annotation", () => {
    const onHoverChange = vi.fn();
    renderRail(resolvedItems(), { hoveredAnnotationId: "b", onHoverChange });
    const first = document.querySelector<HTMLElement>("[data-annotation-card-id='a']") as HTMLElement;
    const second = document.querySelector<HTMLElement>("[data-annotation-card-id='b']");

    expect(second?.getAttribute("data-hovered")).toBe("true");
    fireEvent.pointerEnter(first);
    fireEvent.pointerLeave(first);

    expect(onHoverChange).toHaveBeenNthCalledWith(1, "a");
    expect(onHoverChange).toHaveBeenNthCalledWith(2, null);
  });

  it("batches ResizeObserver height changes and recomputes without scrollIntoView", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const scrollIntoView = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      renderRail(resolvedItems());
      const before = Number.parseFloat(
        document.querySelector<HTMLElement>("[data-annotation-placement-id='b']")?.style.top ?? "0",
      );
      resizeObservers[0].emit(180);

      await waitFor(() => {
        const after = Number.parseFloat(
          document.querySelector<HTMLElement>("[data-annotation-placement-id='b']")?.style.top ?? "0",
        );
        expect(after).toBeGreaterThan(before);
      });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (descriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", descriptor);
      }
    }
  });

  it("navigates from click and keyboard focus without card-owned scrolling", () => {
    const onNavigate = vi.fn();
    renderRail(resolvedItems(), { onNavigate });
    const card = screen.getByLabelText("批注：Body a");

    fireEvent.click(card);
    fireEvent.keyDown(card, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ id: "a" }) }));
  });

  it("starts each primary-pointer navigation immediately so rapid card switches can interrupt", () => {
    const onNavigate = vi.fn();
    renderRail(resolvedItems(), { onNavigate });
    const first = document.querySelector<HTMLElement>("[data-annotation-card-id='a']")!;
    const second = document.querySelector<HTMLElement>("[data-annotation-card-id='b']")!;

    fireEvent.pointerDown(first, { button: 0, pointerType: "mouse" });
    fireEvent.pointerDown(second, { button: 0, pointerType: "mouse" });

    expect(onNavigate.mock.calls.map(([item]) => item.record.id)).toEqual(["a", "b"]);
  });

  it("re-navigates an active card so the body flash can replay", () => {
    const onNavigate = vi.fn();
    renderRail(resolvedItems(), { activeAnnotationId: "a", onNavigate });

    fireEvent.click(screen.getByLabelText("批注：Body a"));

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({ id: "a" }),
    }));
  });

  it("supports inline edit success and visible failure", async () => {
    const onSave = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    renderRail(resolvedItems(), { onSave });
    const card = screen.getByLabelText("批注：Body a");
    fireEvent.click(card.querySelector("[aria-label='编辑批注']") as Element);
    const editor = card.querySelector("textarea[aria-label='编辑批注']") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Updated body" } });
    fireEvent.click(screen.getByLabelText("保存批注"));
    await waitFor(() => expect(card.querySelector("textarea[aria-label='编辑批注']")).toBeNull());
    expect(onSave).toHaveBeenCalledWith("a", "Updated body");

    fireEvent.click(card.querySelector("[aria-label='编辑批注']") as Element);
    fireEvent.change(card.querySelector("textarea[aria-label='编辑批注']") as HTMLTextAreaElement, {
      target: { value: "Fails" },
    });
    fireEvent.click(screen.getByLabelText("保存批注"));
    expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
  });

  it("routes delete and chat actions through callbacks", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    const onNavigate = vi.fn();
    const onStartChat = vi.fn();
    renderRail(resolvedItems(), { onDelete, onNavigate, onStartChat });
    const card = screen.getByLabelText("批注：Body a");
    const chat = card.querySelector("[aria-label='将批注加入对话']") as Element;
    const remove = card.querySelector("[aria-label='删除批注']") as Element;

    fireEvent.pointerDown(chat, { button: 0, pointerType: "mouse" });
    fireEvent.click(chat);
    fireEvent.pointerDown(remove, { button: 0, pointerType: "mouse" });
    fireEvent.click(remove);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ id: "a" }) }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("a"));
  });
});

class FakeResizeObserver {
  private target: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  disconnect() {}
  unobserve() {}

  observes(target: Element): boolean {
    return this.target === target;
  }

  emit(height: number) {
    this.callback([{
      target: this.target as Element,
      contentRect: { height } as DOMRectReadOnly,
      borderBoxSize: [{ blockSize: height, inlineSize: 300 }],
    } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function renderRail(
  items: ReturnType<typeof resolvedItems>,
  overrides: Partial<Parameters<typeof AnnotationRail>[0]> = {},
) {
  return render(<AnnotationRail
    activeAnnotationId={null}
    documentHeight={1000}
    hoveredAnnotationId={null}
    items={items}
    onClose={vi.fn()}
    onDelete={vi.fn().mockResolvedValue(true)}
    onNavigate={vi.fn()}
    onHoverChange={vi.fn()}
    onSave={vi.fn().mockResolvedValue(true)}
    onStartChat={vi.fn()}
    {...overrides}
  />);
}

function resolvedItems() {
  const model = createPlainTextModel("alpha beta", "sha256:rail");
  const records = [record("a", "alpha", 0), record("b", "beta", 6)];
  const resolved = resolveDocumentAnnotations(model, records).resolved;
  return [
    { anchorY: 100, resolution: resolved[0] as ResolvedTextAnnotation },
    { anchorY: 110, resolution: resolved[1] as ResolvedTextAnnotation },
  ];
}

function record(id: string, exact: string, start: number): AnnotationRecord {
  return {
    id,
    workspace_id: "ws",
    document_path: "README.md",
    target: {
      type: "text",
      selector: {
        position: { start, end: start + exact.length },
        quote: { exact, prefix: "", suffix: "" },
        context: { containerType: "source", headingPath: [] },
        textRevision: "old",
        documentRevision: "old",
      },
    },
    body: `Body ${id}`,
    created_at: `2026-01-0${id === "a" ? 1 : 2}`,
    updated_at: "2026-01-01",
  };
}
