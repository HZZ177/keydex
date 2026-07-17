import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitConfirmActionDialog,
  GitDialogField,
  GitDialogSummary,
  GitFormDialog,
} from "@/renderer/features/git/dialogs";

afterEach(cleanup);

describe("Git dialog frames", () => {
  it("submits a valid form once and keeps Enter inside the form contract", () => {
    const onSubmit = vi.fn();
    render(
      <GitFormDialog title="新建分支" confirmLabel="创建" onCancel={vi.fn()} onSubmit={onSubmit}>
        <GitDialogField label="分支名称"><input autoFocus aria-label="分支名称" defaultValue="feature/dialog" /></GitDialogField>
      </GitFormDialog>,
    );
    fireEvent.submit(screen.getByRole("button", { name: "创建" }).closest("section")!.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables invalid or busy forms and reports an actionable error", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <GitFormDialog title="重命名" confirmLabel="重命名" valid={false} error="名称无效" onCancel={onCancel} onSubmit={onSubmit}>
        <GitDialogSummary tone="danger">旧名称：main</GitDialogSummary>
      </GitFormDialog>,
    );
    expect((screen.getByRole("button", { name: "重命名" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("名称无效");
    rerender(
      <GitFormDialog title="重命名" confirmLabel="正在重命名" busy onCancel={onCancel} onSubmit={onSubmit}>
        <span>处理中</span>
      </GitFormDialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels with Escape and restores focus to the opener", async () => {
    const onCancel = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <GitFormDialog title="签出" confirmLabel="签出" onCancel={onCancel} onSubmit={vi.fn()}>
        <GitDialogField label="引用"><input autoFocus aria-label="引用" /></GitDialogField>
      </GitFormDialog>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("引用")));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("renders one complete destructive confirmation and blocks it while busy", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <GitConfirmActionDialog
        title="删除分支？"
        description="此操作无法从分支列表撤销。"
        target="feature/old"
        details={["包含 2 个未合并提交"]}
        confirmLabel="删除"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText("feature/old")).not.toBeNull();
    expect(screen.getByText("包含 2 个未合并提交")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <GitConfirmActionDialog title="删除分支？" confirmLabel="正在删除" busy onCancel={onCancel} onConfirm={onConfirm} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "正在删除" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
