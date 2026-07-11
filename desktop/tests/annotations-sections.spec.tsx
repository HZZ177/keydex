import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnnotationStatusSection } from "@/renderer/features/annotations/ui/AnnotationStatusSection";
import { DocumentAnnotationSection } from "@/renderer/features/annotations/ui/DocumentAnnotationSection";
import type { AnnotationRecord } from "@/runtime/annotations";

function record(id: string, body: string, createdAt: string, type: "document" | "text"): AnnotationRecord {
  return {
    id, body, created_at: createdAt, updated_at: createdAt, document_path: "doc.md", workspace_id: "w",
    target: type === "document" ? { type } : { type, selector: { position: { start: 1, end: 2 }, quote: { exact: "a", prefix: "", suffix: "" }, context: { containerType: "paragraph", headingPath: [] }, textRevision: "r", documentRevision: "r" } },
  };
}

describe("annotation rail sections", () => {
  it("shows document annotations in stable order with CRUD and chat but no connector metadata", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    const onSave = vi.fn().mockResolvedValue(true);
    const onStartChat = vi.fn();
    const later = { status: "document" as const, record: record("b", "later", "2026-01-02", "document") };
    const earlier = { status: "document" as const, record: record("a", "earlier", "2026-01-01", "document") };
    render(<DocumentAnnotationSection collapsed={false} items={[later, earlier]} onCollapsedChange={vi.fn()} onDelete={onDelete} onSave={onSave} onStartChat={onStartChat} />);
    const cards = document.querySelectorAll("[data-annotation-card-id]");
    expect(cards[0].getAttribute("data-annotation-card-id")).toBe("a");
    expect(document.querySelector("[data-annotation-placement-id]")).toBeNull();
    fireEvent.click(screen.getAllByLabelText("将全文批注加入对话")[0]);
    expect(onStartChat).toHaveBeenCalledWith(earlier);
    fireEvent.click(screen.getAllByLabelText("删除全文批注")[0]);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("a"));
  });

  it("collapses the complete document annotation group from its title", () => {
    const item = { status: "document" as const, record: record("a", "whole document", "2026-01-01", "document") };
    const onCollapsedChange = vi.fn();
    const { rerender } = render(
      <DocumentAnnotationSection collapsed={false} items={[item]} onCollapsedChange={onCollapsedChange} onDelete={vi.fn()} onSave={vi.fn()} />,
    );

    const toggle = screen.getByLabelText("收起全文批注");
    expect(toggle.contains(screen.getByText("1"))).toBe(true);
    fireEvent.click(toggle);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(<DocumentAnnotationSection collapsed items={[item]} onCollapsedChange={onCollapsedChange} onDelete={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByLabelText("全文批注").getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByLabelText("全文批注：whole document").closest("[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByLabelText("展开全文批注").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows ambiguous and changed records only with retarget and delete actions", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    const onRetarget = vi.fn();
    render(<AnnotationStatusSection items={[
      { status: "changed", record: record("c", "changed", "2026-01-02", "text") },
      { status: "ambiguous", candidates: [], record: record("a", "ambiguous", "2026-01-01", "text") },
    ]} onDelete={onDelete} onRetarget={onRetarget} />);
    expect(screen.queryByLabelText("将批注加入对话")).toBeNull();
    expect(screen.queryByLabelText(/定位/)).toBeNull();
    const cards = document.querySelectorAll("[data-annotation-card-id]");
    expect(cards[0].getAttribute("data-annotation-card-id")).toBe("a");
    fireEvent.click(screen.getAllByLabelText("重新关联批注")[0]);
    expect(onRetarget).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByLabelText("删除失效批注")[1]);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("c"));
  });

  it("renders no empty section chrome", () => {
    const { container } = render(<><DocumentAnnotationSection collapsed={false} items={[]} onCollapsedChange={vi.fn()} onDelete={vi.fn()} onSave={vi.fn()} /><AnnotationStatusSection items={[]} onDelete={vi.fn()} onRetarget={vi.fn()} /></>);
    expect(container.childElementCount).toBe(0);
  });
});
