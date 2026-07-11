import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnnotationRetargetCard } from "@/renderer/features/annotations/ui/AnnotationRetargetCard";
import type { AnnotationRecord, TextSelector } from "@/runtime/annotations";

const annotation: AnnotationRecord = {
  id: "ann-1", workspace_id: "ws", document_path: "doc.md", body: "Keep this body",
  created_at: "2026-01-01", updated_at: "2026-01-01", target: { type: "document" },
};
const selector: TextSelector = {
  position: { start: 4, end: 12 }, quote: { exact: "new text", prefix: "", suffix: "" },
  context: { containerType: "paragraph", headingPath: [] }, textRevision: "new-revision", documentRevision: "new-document",
};

describe("AnnotationRetargetCard", () => {
  it("waits for an explicit selection and allows cancellation without mutation", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<AnnotationRetargetCard annotation={annotation} range={null} selector={null} onCancel={onCancel} onConfirm={onConfirm} />);
    expect((screen.getByLabelText("确认重新关联") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Keep this body")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("取消重新关联"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms only the annotation id and complete new selector", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(<AnnotationRetargetCard annotation={annotation} range={{ start: 4, end: 12 }} selector={selector} onCancel={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText("new text")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("确认重新关联"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("ann-1", selector));
  });

  it("keeps the card open with a visible failure", async () => {
    const onConfirm = vi.fn().mockResolvedValue(false);
    render(<AnnotationRetargetCard annotation={annotation} range={{ start: 4, end: 12 }} selector={selector} onCancel={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText("确认重新关联"));
    expect((await screen.findByRole("alert")).textContent).toContain("重新关联失败");
    expect(screen.getByLabelText("重新关联批注：Keep this body")).not.toBeNull();
  });
});
