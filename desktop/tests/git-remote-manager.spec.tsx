import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRemoteManager } from "@/renderer/features/git/components/GitRemoteManager";

afterEach(cleanup);

describe("GitRemoteManager", () => {
  it("adds remotes with separate fetch/push URLs and rejects duplicate names", async () => {
    const onAdd = vi.fn();
    renderManager({ onAdd });
    expect(screen.queryByRole("textbox", { name: "远程仓库名称" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加远程仓库…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "远程仓库名称" }), { target: { value: "origin" } });
    fireEvent.change(screen.getByRole("textbox", { name: "获取地址" }), { target: { value: "D:/fetch.git" } });
    expect(screen.getByText("该远程仓库名称已存在")).not.toBeNull();
    expect(screen.getByRole("button", { name: "添加" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "远程仓库名称" }), { target: { value: "upstream" } });
    fireEvent.change(screen.getByRole("textbox", { name: "推送地址" }), { target: { value: "D:/push.git" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("upstream", "D:/fetch.git", "D:/push.git"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加远程仓库" })).toBeNull());
  });

  it("keeps details read-only and edits rename/fetch/push fields in dialogs", async () => {
    const onRename = vi.fn();
    const onSetUrl = vi.fn();
    const onRemove = vi.fn();
    renderManager({ onRename, onSetUrl, onRemove });
    expect(screen.getByText(/会影响以下分支的上游设置：main, release/)).not.toBeNull();
    expect(screen.queryByLabelText("重命名远程仓库")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重命名…" }));
    fireEvent.change(screen.getByLabelText("重命名远程仓库"), { target: { value: "upstream" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("origin", "upstream"));

    fireEvent.click(screen.getByRole("button", { name: "编辑获取地址…" }));
    fireEvent.change(screen.getByLabelText("编辑获取地址"), { target: { value: "D:/new-fetch.git" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSetUrl).toHaveBeenCalledWith("origin", "D:/new-fetch.git", false));

    fireEvent.click(screen.getByRole("button", { name: "编辑推送地址…" }));
    fireEvent.change(screen.getByLabelText("编辑推送地址"), { target: { value: "D:/new-push.git" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSetUrl).toHaveBeenCalledWith("origin", "D:/new-push.git", true));

    fireEvent.click(screen.getByRole("button", { name: "删除远程仓库…" }));
    expect(screen.getByRole("dialog", { name: "删除远程仓库" }).textContent).toContain("main、release");
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "删除远程仓库…" }));
    fireEvent.click(screen.getByRole("button", { name: "删除远程仓库" }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ name: "origin" }));
  });

  it("keeps a failed dialog open for retry and closes it on repository switch", async () => {
    const onAdd = vi.fn().mockResolvedValue(false);
    const props = managerProps({ onAdd });
    const { rerender } = render(<GitRemoteManager {...props} repositoryId="repo-1" error="连接失败" />);
    fireEvent.click(screen.getByRole("button", { name: "添加远程仓库…" }));
    fireEvent.change(screen.getByLabelText("远程仓库名称"), { target: { value: "backup" } });
    fireEvent.change(screen.getByLabelText("获取地址"), { target: { value: "D:/backup.git" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "添加远程仓库" })).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("连接失败");

    rerender(<GitRemoteManager {...props} repositoryId="repo-2" error={null} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加远程仓库" })).toBeNull());
  });
});

function renderManager(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return render(<GitRemoteManager {...managerProps(overrides)} repositoryId="repo-1" />);
}

function managerProps(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    remotes: [{
      name: "origin",
      fetchUrl: "D:/fetch.git",
      pushUrl: "D:/push.git",
      trackingBranches: ["main", "release"],
    }],
    onAdd: overrides.onAdd ?? vi.fn(),
    onRename: overrides.onRename ?? vi.fn(),
    onSetUrl: overrides.onSetUrl ?? vi.fn(),
    onRemove: overrides.onRemove ?? vi.fn(),
  };
}
