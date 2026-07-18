import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import type { RuntimeBridge } from "@/runtime";
import { SubagentSidecarComposer } from "@/renderer/pages/conversation/subagents/SubagentSidecarComposer";
import { normalizeSubagentRunSnapshot } from "@/types/subagents";

describe("SubagentSidecarComposer", () => {
  it("steers and stops only the selected active Run with optimistic version binding", async () => {
    const run = runningSnapshot();
    const steerSubagent = vi.fn().mockResolvedValue({ ...run, version: run.version + 1 });
    const cancelSubagent = vi.fn().mockResolvedValue(cancelledSnapshot());
    renderComposer(run, { steerSubagent, cancelSubagent });

    await userEvent.type(screen.getByLabelText("中途引导 Sub-Agent"), "inspect the parser first");
    await userEvent.click(screen.getByRole("button", { name: "发送引导" }));
    await waitFor(() => expect(steerSubagent).toHaveBeenCalledWith(
      run.parent_session_id,
      run.run_id,
      expect.objectContaining({
        subagent_id: run.subagent_id,
        child_session_id: run.child_session_id,
        expected_version: run.version,
        message: "inspect the parser first",
      }),
    ));

    expect(screen.getByTestId("subagent-sidecar-input-surface")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "停止该 Sub-Agent" }));
    await waitFor(() => expect(cancelSubagent).toHaveBeenCalledWith(
      run.parent_session_id,
      run.run_id,
      expect.objectContaining({ expected_version: run.version, reason: "user" }),
    ));
  });

  it("keeps the current terminal Run read-only because only the main Agent can delegate", () => {
    const run = normalizeSubagentRunSnapshot(snapshotFixture);
    renderComposer(run, {});

    expect(screen.getByTestId("subagent-terminal-run-notice").textContent).toContain("只有主 Agent");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a historical Run read-only", () => {
    renderComposer(normalizeSubagentRunSnapshot(snapshotFixture), {}, false);
    expect(screen.getByTestId("subagent-historical-run-notice")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows Runtime control errors to the user and retains the active Run controls", async () => {
    const run = runningSnapshot();
    const steerSubagent = vi.fn().mockRejectedValue(new Error("stale Run version"));
    renderComposer(run, { steerSubagent });

    await userEvent.type(screen.getByRole("textbox"), "new direction");
    await userEvent.click(screen.getAllByRole("button")[1]);

    expect((await screen.findByRole("alert")).textContent).toContain("stale Run version");
    expect((screen.getByRole("button", { name: "停止该 Sub-Agent" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "does not expose user controls for a current %s Run",
    (state) => {
      renderComposer(terminalSnapshot(state), {});
      expect(screen.getByTestId("subagent-terminal-run-notice")).not.toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});

function renderComposer(
  run: ReturnType<typeof normalizeSubagentRunSnapshot>,
  conversation: Record<string, unknown>,
  isCurrentRun = true,
) {
  const runtime = { conversation } as unknown as RuntimeBridge;
  return render(<SubagentSidecarComposer runtime={runtime} run={run} isCurrentRun={isCurrentRun} />);
}

function runningSnapshot(overrides: Record<string, unknown> = {}) {
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    state: "running",
    version: 2,
    final_report: null,
    error_code: null,
    error_message: null,
    finished_at: null,
    updated_at: snapshotFixture.started_at,
    ...overrides,
  });
}

function cancelledSnapshot() {
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    state: "cancelled",
    final_report: null,
    error_code: null,
    error_message: null,
  });
}

function terminalSnapshot(state: "completed" | "failed" | "cancelled" | "interrupted") {
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    state,
    final_report: state === "completed" ? "done" : null,
    error_code: state === "failed" ? "FAILED" : null,
    error_message: state === "failed" ? "failed" : null,
  });
}
