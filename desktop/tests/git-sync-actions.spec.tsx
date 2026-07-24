import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitSyncActions } from "@/renderer/features/git/components/GitSyncActions";

afterEach(cleanup);

describe("GitSyncActions", () => {
  it("defaults to one remote without prune and exposes explicit options", () => {
    const onFetch = vi.fn();
    render(<GitSyncActions {...baseProps()} remotes={[remote("origin")]} onFetch={onFetch} />);

    expect((screen.getByRole("checkbox", { name: "清理远程已删除引用" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "获取全部标签" }));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));
    expect(onFetch).toHaveBeenCalledWith({ remote: "origin", allRemotes: false, prune: false, tags: true });
  });

  it("fetches all remotes only after an explicit selection without a persistent result", () => {
    const onFetch = vi.fn();
    render(<GitSyncActions {...baseProps()} remotes={[remote("origin"), remote("backup")]} onFetch={onFetch} />);
    fireEvent.change(screen.getByLabelText("获取远程仓库"), { target: { value: "__all__" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "清理远程已删除引用" }));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));
    expect(onFetch).toHaveBeenCalledWith({ remote: null, allRemotes: true, prune: true, tags: false });
    expect(screen.queryByText(/进度更新/)).toBeNull();
  });

  it("previews dirty/divergent state and only updates after explicit strategy confirmation", async () => {
    const onUpdate = vi.fn();
    const onUpdateStrategyChange = vi.fn();
    render(<GitSyncActions
      {...baseProps()}
      status={{
        repositoryId: "repo-1" as never,
        repositoryVersion: "v1" as never,
        branch: { head: "main", detachedAt: null, upstream: "origin/main", ahead: 2, behind: 3, unborn: false },
        files: [{ path: "dirty.ts", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: false, submodule: false }],
        operation: null,
      }}
      updateStrategy="rebase"
      onUpdate={onUpdate}
      onUpdateStrategyChange={onUpdateStrategyChange}
    />);
    expect(screen.getByText(/1 个本地改动 · 领先 2 · 落后 3/)).not.toBeNull();
    expect(screen.queryByText("更新因冲突而停止")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更新…" }));
    const dialog = screen.getByRole("dialog", { name: "更新项目" });
    expect(dialog.textContent).toContain("1 个本地改动");
    expect(dialog.textContent).toContain("Keydex 不会自动储藏");
    expect((screen.getByRole("radio", { name: /在传入更改上变基当前分支/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /将传入更改合并到当前分支/ }));
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("merge"));
    expect(onUpdateStrategyChange).toHaveBeenCalledWith("merge");
    expect(screen.queryByRole("dialog", { name: "更新项目" })).toBeNull();
  });

  it("uses two PyCharm-style update choices and maps the legacy fast-forward preference to merge", async () => {
    const onUpdate = vi.fn();
    render(<GitSyncActions
      {...baseProps()}
      status={statusWithUpstream("main", "origin/main", 1, 2)}
      onUpdate={onUpdate}
    />);

    fireEvent.click(screen.getByRole("button", { name: "更新…" }));
    const dialog = screen.getByRole("dialog", { name: "更新项目" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
    expect((within(dialog).getByRole("radio", { name: /将传入更改合并到当前分支/ }) as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain("“传入更改”指上方显示的上游分支中的新提交");
    expect(dialog.textContent).toContain("历史更线性，但会改写本地提交");
    expect(dialog.textContent).not.toContain("仅快进");

    fireEvent.click(within(dialog).getByRole("button", { name: "更新" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("merge"));
  });

  it("opens the update dialog without an upstream but disables confirmation", () => {
    render(<GitSyncActions {...baseProps()} status={statusWithUpstream("feature/demo", "", 0, 0)} />);
    fireEvent.click(screen.getByRole("button", { name: "更新…" }));
    expect(screen.getByRole("dialog", { name: "更新项目" }).textContent).toContain("没有可用的上游");
    expect(screen.getByRole("button", { name: "更新" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers system credential login inside a failed update dialog", async () => {
    const onCredentialLogin = vi.fn().mockResolvedValue(undefined);
    render(<GitSyncActions
      {...baseProps()}
      status={statusWithUpstream("main", "origin/main", 0, 1)}
      updateError="Git 凭据不可用"
      credentialLoginRemote="origin"
      onCredentialLogin={onCredentialLogin}
    />);

    fireEvent.click(screen.getByRole("button", { name: "更新…" }));
    const dialog = screen.getByRole("dialog", { name: "更新项目" });
    expect(dialog.textContent).toContain("origin 需要登录");
    expect(dialog.textContent).toContain("Keydex 不会读取或保存密码");
    fireEvent.click(within(dialog).getByRole("button", { name: "登录远程仓库" }));
    await waitFor(() => expect(onCredentialLogin).toHaveBeenCalledTimes(1));
  });

  it("previews source and target and requires an explicit upstream for first push", async () => {
    const onPush = vi.fn();
    render(<GitSyncActions
      {...baseProps()}
      status={{
        repositoryId: "repo-1" as never,
        repositoryVersion: "v1" as never,
        branch: { head: "feature/demo", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
        files: [],
        operation: null,
      }}
      onPush={onPush}
    />);
    expect(screen.getByText("feature/demo → origin/feature/demo")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "推送…" }));
    expect((screen.getByRole("checkbox", { name: "设置上游" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "推送标签" }));
    fireEvent.click(screen.getByRole("button", { name: "推送" }));
    await waitFor(() => expect(onPush).toHaveBeenCalledWith({
      remote: "origin",
      source: "feature/demo",
      target: "feature/demo",
      setUpstream: true,
      tags: true,
      forceWithLease: false,
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "推送" })).toBeNull());
  });

  it("blocks protected targets and exposes only force-with-lease for other branches", async () => {
    const onPush = vi.fn();
    const { rerender } = render(<GitSyncActions
      {...baseProps()}
      status={statusWithUpstream("main", "origin/main", 1, 2)}
      onPush={onPush}
    />);
    fireEvent.click(screen.getByRole("button", { name: "推送…" }));
    expect(screen.getByRole("checkbox", { name: "带租约强制推送" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/受保护分支 main/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    rerender(<GitSyncActions
      {...baseProps()}
      status={statusWithUpstream("feature/demo", "origin/feature/demo", 1, 2)}
      outgoingCommits={[commit("local commit", "a")]}
      replacedCommits={[commit("remote one", "b"), commit("remote two", "c")]}
      onPush={onPush}
    />);
    fireEvent.click(screen.getByRole("button", { name: "推送…" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "带租约强制推送" }));
    expect(screen.getByRole("region", { name: "将要发布的提交" }).textContent).toContain("local commit");
    expect(screen.getByRole("region", { name: "可能被替换的远程提交" }).textContent).toContain("remote two");
    fireEvent.click(screen.getByRole("button", { name: "继续确认" }));
    expect(onPush).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认带租约强制推送" }).textContent).toContain("可能替换 2 个远程提交");
    fireEvent.click(screen.getByRole("button", { name: "带租约强制推送" }));
    await waitFor(() => expect(onPush).toHaveBeenCalledWith(expect.objectContaining({ forceWithLease: true })));
  });

  it("blocks push for a detached head without any remote", () => {
    const onPush = vi.fn();
    render(<GitSyncActions
      {...baseProps()}
      remotes={[]}
      status={{
        repositoryId: "repo-1" as never,
        repositoryVersion: "v1" as never,
        branch: { head: null, detachedAt: "a".repeat(40) as never, upstream: null, ahead: 0, behind: 0, unborn: false },
        files: [],
        operation: null,
      }}
      onPush={onPush}
    />);
    fireEvent.click(screen.getByRole("button", { name: "推送…" }));
    const dialog = screen.getByRole("dialog", { name: "推送" });
    expect(dialog.textContent).toContain("分离指针状态");
    expect(dialog.textContent).toContain("没有可用的远程仓库");
    expect(screen.getByRole("button", { name: "推送" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onPush).not.toHaveBeenCalled();
  });
});

function remote(name: string) {
  return { name, fetchUrl: `D:/${name}.git`, pushUrl: `D:/${name}.git`, trackingBranches: [] };
}

function baseProps() {
  return {
    remotes: [remote("origin")],
    busy: false,
    status: null,
    updateStrategy: "ff_only" as const,
    updateBusy: false,
    pushBusy: false,
    onFetch: vi.fn(),
    onUpdateStrategyChange: vi.fn(),
    onUpdate: vi.fn(),
    onPush: vi.fn(),
  };
}

function statusWithUpstream(head: string, upstream: string, ahead: number, behind: number) {
  return {
    repositoryId: "repo-1" as never,
    repositoryVersion: "v1" as never,
    branch: { head, detachedAt: null, upstream, ahead, behind, unborn: false },
    files: [],
    operation: null,
  };
}

function commit(subject: string, seed: string) {
  return {
    objectId: seed.repeat(40) as never,
    parentIds: [],
    authorName: "Alice",
    authorEmail: "alice@example.invalid",
    authoredAt: "2026-07-16T00:00:00Z",
    committerName: "Alice",
    committerEmail: "alice@example.invalid",
    committedAt: "2026-07-16T00:00:00Z",
    subject,
    body: "",
    decorations: [],
    signature: "unsigned" as const,
  };
}
