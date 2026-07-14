import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AnnotationDraftCard } from "@/renderer/features/annotations/ui/AnnotationDraftCard";
import { AnnotationRail } from "@/renderer/features/annotations/ui/AnnotationRail";
import { AnnotationSelectionToolbar } from "@/renderer/features/annotations/ui/AnnotationSelectionToolbar";

function ControlledDraft({ onCancel = vi.fn(), onSubmit = vi.fn(), revision = "rev-a" }) {
  const [body, setBody] = useState("");
  return <AnnotationDraftCard body={body} onBodyChange={setBody} onCancel={onCancel} onSubmit={onSubmit} pending={false} revision={revision} />;
}

describe("AnnotationDraftCard", () => {
  it("submits with Enter and keeps Shift+Enter as a newline", () => {
    const onSubmit = vi.fn();
    render(<ControlledDraft onSubmit={onSubmit} />);
    const editor = screen.getByLabelText("批注内容");
    expect(editor.hasAttribute("autofocus")).toBe(false);
    fireEvent.change(editor, { target: { value: "first" } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit while IME composition is active", () => {
    const onSubmit = vi.fn();
    render(<ControlledDraft onSubmit={onSubmit} />);
    const editor = screen.getByLabelText("批注内容");
    fireEvent.change(editor, { target: { value: "内容" } });
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape but preserves the draft across same-document revision changes", () => {
    const onCancel = vi.fn();
    const view = render(<ControlledDraft onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByLabelText("批注内容"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.rerender(<ControlledDraft onCancel={onCancel} revision="rev-b" />);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-annotation-draft='true']")?.getAttribute("data-document-revision")).toBe("rev-b");
  });

  it("participates in the same collision layout as saved cards", () => {
    render(<AnnotationRail
      activeAnnotationId={null}
      documentHeight={600}
      draft={{ anchorY: 90, body: "draft", onBodyChange: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(), pending: false, revision: "rev-a" }}
      items={[]}
      hoveredAnnotationId={null}
      onClose={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(true)}
      onNavigate={vi.fn()}
      onHoverChange={vi.fn()}
      onSave={vi.fn().mockResolvedValue(true)}
    />);
    expect(document.querySelector("[data-annotation-placement-id='__annotation_draft__']")).not.toBeNull();
    expect(document.querySelector("[data-annotation-draft='true']")).not.toBeNull();
  });
});

describe("AnnotationSelectionToolbar", () => {
  it("emits only a logical selection and keeps no draft state", () => {
    const onCreate = vi.fn();
    const selection = { coordinateSpace: "source" as const, range: { start: 2, end: 8 } };
    render(<AnnotationSelectionToolbar onCreate={onCreate} selection={selection} />);
    fireEvent.click(screen.getByLabelText("为选区添加批注"));
    expect(onCreate).toHaveBeenCalledWith(selection);
  });
});
