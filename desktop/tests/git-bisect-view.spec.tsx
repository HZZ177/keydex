import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitBisectView } from "@/renderer/features/git/components/GitBisectView";
import type { GitBisectSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git bisect assistant", () => {
  it("starts only from explicit good/bad revisions and states manual-only policy", () => {
    const onStart = vi.fn();
    render(<GitBisectView snapshot={inactive()} loading={false} busy={false} revisions={["main", "v1"]} onStart={onStart} onControl={vi.fn()} onOpenHistory={vi.fn()} />);
    expect(screen.getByText(/不会自动运行用户测试命令/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("已知正常修订"), { target: { value: "v1" } });
    fireEvent.change(screen.getByLabelText("已知异常修订"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "开始二分定位" }));
    expect(screen.getByRole("dialog", { name: "确认开始二分定位" }).textContent).toContain("v1（正常）");
    fireEvent.click(screen.getByRole("button", { name: "确认开始" }));
    expect(onStart).toHaveBeenCalledWith("v1", "main");
  });

  it("exposes good/bad/skip/reset and highlights current candidate", () => {
    const onControl = vi.fn();
    render(<GitBisectView snapshot={active()} loading={false} busy={false} revisions={[]} onStart={vi.fn()} onControl={onControl} onOpenHistory={vi.fn()} />);
    expect(screen.getByText("剩余").parentElement?.textContent).toContain("4");
    expect(screen.getByText("1111111111111111111111111111111111111111").parentElement?.dataset.current).toBe("true");
    for (const label of ["标记为正常", "标记为异常", "跳过此修订"]) fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "结束二分定位" }));
    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["good", "bad", "skip"]);
    fireEvent.click(screen.getByRole("button", { name: "确认结束" }));
    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["good", "bad", "skip", "reset"]);
  });

  it("opens a discovered culprit in history while retaining reset", () => {
    const onOpenHistory = vi.fn();
    render(<GitBisectView snapshot={{ ...active(), culpritRevision: "f".repeat(40) as never }} loading={false} busy={false} revisions={[]} onStart={vi.fn()} onControl={vi.fn()} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByRole("button", { name: "在日志中打开" }));
    expect(onOpenHistory).toHaveBeenCalledWith("f".repeat(40));
    expect(screen.getByRole("button", { name: "结束二分定位" })).toBeTruthy();
  });
});

function inactive(): GitBisectSnapshot {
  return { repositoryId: "repo" as never, repositoryVersion: "v1" as never, active: false, originalHead: null, currentRevision: null, goodRevisions: [], badRevision: null, skippedRevisions: [], candidateRevisions: [], remainingCount: 0, culpritRevision: null };
}

function active(): GitBisectSnapshot {
  return { ...inactive(), active: true, originalHead: "refs/heads/main", currentRevision: "1".repeat(40) as never, goodRevisions: ["0".repeat(40) as never], badRevision: "9".repeat(40) as never, candidateRevisions: ["1".repeat(40) as never, "2".repeat(40) as never], remainingCount: 4 };
}
