import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WebAnnotationShelf } from "@/renderer/features/browser/annotations";

describe("WebAnnotationShelf", () => {
  it("keeps the page summary compact and expands the annotation surface on demand", () => {
    const onOpenChange = vi.fn();
    const onAddAllToComposer = vi.fn();
    const view = render(
      <WebAnnotationShelf
        count={12}
        open={false}
        pageTitle="A very long page title that must yield space to the fixed action"
        pageUrl="https://example.test/article"
        onAddAllToComposer={onAddAllToComposer}
        onOpenChange={onOpenChange}
      >
        <div>annotation list</div>
      </WebAnnotationShelf>,
    );

    const toggle = screen.getByRole("button", { name: "展开当前页面网页批注，12 条批注" });
    expect(screen.getByRole("region", { name: "当前页面网页批注" }).dataset.annotationMode).toBe("active");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("当前页面批注消息列表")).not.toBeNull();
    expect(screen.getByText("A very long page title that must yield space to the fixed action")).not.toBeNull();
    expect(screen.getByText("12 条批注")).not.toBeNull();
    expect(screen.getByText("annotation list").closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "全部加入对话框" }));
    expect(onAddAllToComposer).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(onOpenChange).toHaveBeenCalledWith(true);

    view.rerender(
      <WebAnnotationShelf
        count={12}
        open
        pageTitle="A very long page title that must yield space to the fixed action"
        pageUrl="https://example.test/article"
        onAddAllToComposer={onAddAllToComposer}
        onOpenChange={onOpenChange}
      >
        <div>annotation list</div>
      </WebAnnotationShelf>,
    );
    expect(screen.getByRole("button", { name: "收起当前页面网页批注，12 条批注" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("annotation list").closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("false");
  });

  it("collapses when the user interacts outside the shelf", () => {
    const onOpenChange = vi.fn();
    render(
      <WebAnnotationShelf
        count={1}
        open
        pageTitle="Example"
        pageUrl="https://example.test"
        onOpenChange={onOpenChange}
      >
        <div>annotation list</div>
      </WebAnnotationShelf>,
    );

    fireEvent.pointerDown(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
