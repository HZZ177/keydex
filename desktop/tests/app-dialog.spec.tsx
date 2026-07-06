import { fireEvent, render, screen } from "@testing-library/react";
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
});
