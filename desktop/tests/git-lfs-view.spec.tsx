import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLfsView } from "@/renderer/features/git/components/GitLfsView";
import type { GitLfsSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git LFS status and actions", () => {
  it("shows a friendly disabled state and never offers installation", () => {
    render(<GitLfsView snapshot={{ ...snapshot(), available: false, reason: "Git LFS is not installed" }} loading={false} busy={false} onAction={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Git 大文件存储不可用");
    expect(screen.getByText(/不会自动安装此扩展/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "获取对象" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /安装/ })).toBeNull();
  });

  it("renders tracked patterns, object status, size, and lock owner", () => {
    render(<GitLfsView snapshot={snapshot()} loading={false} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText("*.bin")).toBeTruthy();
    expect(screen.getAllByText("asset.bin")).toHaveLength(2);
    expect(screen.getByText(/已跟踪 · 4.0 KB/)).toBeTruthy();
    expect(screen.getByText(/Ada/)).toBeTruthy();
  });

  it("maps fetch, pull, and push to explicit remote/refspec inputs", () => {
    const onAction = vi.fn();
    render(<GitLfsView snapshot={snapshot()} loading={false} busy={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "获取对象" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取并签出" }));
    fireEvent.click(screen.getByRole("button", { name: "推送对象…" }));
    fireEvent.change(screen.getByLabelText("Git 大文件存储远程仓库"), { target: { value: "backup" } });
    fireEvent.change(screen.getByLabelText("Git 大文件存储引用规范"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "推送" }));
    expect(onAction.mock.calls).toEqual([
      ["fetch", null, null],
      ["pull", null, null],
      ["push", "backup", "main"],
    ]);
  });
});

function snapshot(): GitLfsSnapshot {
  return {
    repositoryId: "repo" as never,
    repositoryVersion: "v1" as never,
    available: true,
    reason: null,
    trackedPatterns: ["*.bin"],
    files: [{ path: "asset.bin", objectId: "sha256:abc", size: 4096, status: "tracked" }],
    locks: [{ id: "lock-1", path: "asset.bin", owner: "Ada", lockedAt: "2026-07-16T00:00:00Z" }],
    locksAvailable: true,
  };
}
