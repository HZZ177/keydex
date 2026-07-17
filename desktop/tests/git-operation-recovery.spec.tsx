import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitOperationRecoveryBanner, recoveryActions, transitionRecoveryUi } from "@/renderer/features/git/components/GitOperationRecoveryBanner";
import type { GitInProgressOperation } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git operation recovery state machine", () => {
  it("applies the declared lifecycle transitions and rejects impossible transitions", () => {
    expect(transitionRecoveryUi("idle", "detect")).toBe("running");
    expect(transitionRecoveryUi("running", "conflict")).toBe("conflicted");
    expect(transitionRecoveryUi("conflicted", "resolve")).toBe("continuable");
    expect(transitionRecoveryUi("continuable", "continue")).toBe("running");
    expect(transitionRecoveryUi("running", "abort")).toBe("aborting");
    expect(transitionRecoveryUi("aborting", "complete")).toBe("idle");
    expect(() => transitionRecoveryUi("idle", "continue")).toThrow("非法的 Git 恢复状态转换");
  });

  it("derives legal recovered CTAs for every persisted operation kind", () => {
    expect(recoveryActions(operation("merge", "conflicted")).map((item) => item.id)).toEqual(["resolve", "abort"]);
    for (const kind of ["rebase", "cherry_pick", "revert"] as const) {
      expect(recoveryActions(operation(kind, "continuable")).map((item) => item.id)).toEqual(["continue", "skip", "abort"]);
      expect(recoveryActions(operation(kind, "conflicted")).map((item) => item.id)).toEqual(["resolve", "skip", "abort"]);
    }
    expect(recoveryActions(operation("stash_apply", "conflicted")).map((item) => item.id)).toEqual(["resolve"]);
    expect(recoveryActions(operation("bisect", "running"))).toEqual([]);
  });

  it("restores the same progress and actions after a full component remount", () => {
    const onAction = vi.fn();
    const recovered = { ...operation("cherry_pick", "continuable"), currentStep: 2, totalSteps: 4 };
    const first = render(<GitOperationRecoveryBanner operation={recovered} busy={false} onAction={onAction} />);
    expect(screen.getByText(/第 2\/4 步/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onAction).toHaveBeenCalledWith("continue");
    first.unmount();

    render(<GitOperationRecoveryBanner operation={recovered} busy={false} onAction={onAction} />);
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "跳过" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "中止" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    expect(screen.getByRole("dialog", { name: "确认中止摘取提交" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onAction).not.toHaveBeenCalledWith("abort");
  });
});

function operation(kind: GitInProgressOperation["kind"], state: GitInProgressOperation["state"]): GitInProgressOperation {
  return { kind, state, currentStep: null, totalSteps: null, currentObjectId: null };
}
