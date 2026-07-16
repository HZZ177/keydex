import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitBisectView } from "@/renderer/features/git/components/GitBisectView";
import type { GitBisectSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git bisect assistant", () => {
  it("starts only from explicit good/bad revisions and states manual-only policy", () => {
    const onStart = vi.fn();
    render(<GitBisectView snapshot={inactive()} loading={false} busy={false} revisions={["main", "v1"]} onStart={onStart} onControl={vi.fn()} onOpenHistory={vi.fn()} />);
    expect(screen.getByText(/never runs a user test command automatically/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Known good revision"), { target: { value: "v1" } });
    fireEvent.change(screen.getByLabelText("Known bad revision"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Start bisect" }));
    expect(screen.getByRole("alertdialog", { name: "Confirm bisect start" }).textContent).toContain("v1 (good)");
    fireEvent.click(screen.getByRole("button", { name: "Confirm start" }));
    expect(onStart).toHaveBeenCalledWith("v1", "main");
  });

  it("exposes good/bad/skip/reset and highlights current candidate", () => {
    const onControl = vi.fn();
    render(<GitBisectView snapshot={active()} loading={false} busy={false} revisions={[]} onStart={vi.fn()} onControl={onControl} onOpenHistory={vi.fn()} />);
    expect(screen.getByText("Remaining").parentElement?.textContent).toContain("4");
    expect(screen.getByText("1111111111111111111111111111111111111111").parentElement?.dataset.current).toBe("true");
    for (const label of ["Mark good", "Mark bad", "Skip revision", "Reset bisect"]) fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["good", "bad", "skip", "reset"]);
  });

  it("opens a discovered culprit in history while retaining reset", () => {
    const onOpenHistory = vi.fn();
    render(<GitBisectView snapshot={{ ...active(), culpritRevision: "f".repeat(40) as never }} loading={false} busy={false} revisions={[]} onStart={vi.fn()} onControl={vi.fn()} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in history" }));
    expect(onOpenHistory).toHaveBeenCalledWith("f".repeat(40));
    expect(screen.getByRole("button", { name: "Reset bisect" })).toBeTruthy();
  });
});

function inactive(): GitBisectSnapshot {
  return { repositoryId: "repo" as never, repositoryVersion: "v1" as never, active: false, originalHead: null, currentRevision: null, goodRevisions: [], badRevision: null, skippedRevisions: [], candidateRevisions: [], remainingCount: 0, culpritRevision: null };
}

function active(): GitBisectSnapshot {
  return { ...inactive(), active: true, originalHead: "refs/heads/main", currentRevision: "1".repeat(40) as never, goodRevisions: ["0".repeat(40) as never], badRevision: "9".repeat(40) as never, candidateRevisions: ["1".repeat(40) as never, "2".repeat(40) as never], remainingCount: 4 };
}
