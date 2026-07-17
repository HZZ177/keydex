import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitSubmoduleView } from "@/renderer/features/git/components/GitSubmoduleView";
import type { GitSubmodulesSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git submodule management", () => {
  it("keeps parent and child identity explicit and renders only redacted URLs", () => {
    render(<GitSubmoduleView snapshot={snapshot()} loading={false} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText(/父仓库 parent-repo/)).toBeTruthy();
    expect(screen.getByText("D:/repo/modules/core")).toBeTruthy();
    expect(screen.getByText("https://***:***@example.invalid/core.git")).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
  });

  it("previews recursive impact and routes selected paths to every explicit action", () => {
    const onAction = vi.fn();
    render(<GitSubmoduleView snapshot={snapshot()} loading={false} busy={false} onAction={onAction} />);
    fireEvent.click(screen.getByText("递归包含嵌套子模块"));
    expect(screen.getByText("递归影响预览")).toBeTruthy();
    expect(screen.getByText(/嵌套仓库也可能/)).toBeTruthy();
    for (const label of ["初始化", "更新", "同步地址", "取消初始化"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: label === "取消初始化" ? "确认取消初始化" : "确认递归执行" }));
    }
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(["init", "update", "sync", "deinit"]);
    expect(onAction.mock.calls[0][1]).toEqual(["modules/core"]);
    expect(onAction.mock.calls[0][2]).toBe(true);
    expect(onAction.mock.calls[3][3]).toBe(true);
  });

  it("shows a stable empty state when no .gitmodules entries exist", () => {
    render(<GitSubmoduleView snapshot={{ ...snapshot(), submodules: [] }} loading={false} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText("此仓库尚未配置子模块。")).toBeTruthy();
  });
});

function snapshot(): GitSubmodulesSnapshot {
  return {
    repositoryId: "parent-repo" as never,
    repositoryVersion: "v1" as never,
    submodules: [{
      path: "modules/core",
      objectId: "a".repeat(40) as never,
      state: "clean",
      description: "heads/main",
      name: "core",
      url: "https://***:***@example.invalid/core.git",
      parentRepositoryId: "parent-repo" as never,
      childRootPath: "D:/repo/modules/core",
      initialized: true,
    }],
  };
}
