import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AppDialog, ConfirmDialog } from "@/renderer/components/dialog";

describe("AppDialog", () => {
  it("closes with Escape when an onClose handler is provided", () => {
    const onClose = vi.fn();

    render(
      <AppDialog title="统一弹窗" onClose={onClose}>
        弹窗内容
      </AppDialog>,
    );

    expect(screen.getByRole("dialog", { name: "统一弹窗" })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("marks footer with dialog size for consistent button spacing", () => {
    render(
      <AppDialog
        title="带底部按钮的弹窗"
        footer={<button type="button">确认</button>}
      >
        弹窗内容
      </AppDialog>,
    );

    const footer = screen.getByRole("button", { name: "确认" }).closest("footer");

    expect(footer?.getAttribute("data-size")).toBe("form");
  });

  it("routes ConfirmDialog Escape through cancel without confirming", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        title="确认操作"
        description="操作前需要确认"
        confirmLabel="确认"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("can disable ConfirmDialog actions while work is running", () => {
    render(
      <ConfirmDialog
        title="确认操作"
        description="操作前需要确认"
        confirmLabel="正在处理"
        cancelDisabled
        confirmDisabled
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "正在处理" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("traps keyboard focus and restores it to the opener after close", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>打开管理弹窗</button>
          {open ? (
            <AppDialog title="焦点管理" onClose={() => setOpen(false)} footer={<button type="button">最后操作</button>}>
              <input autoFocus aria-label="首选输入" />
            </AppDialog>
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开管理弹窗" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("首选输入")));

    const last = screen.getByRole("button", { name: "最后操作" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
