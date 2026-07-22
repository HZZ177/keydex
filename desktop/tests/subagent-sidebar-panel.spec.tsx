import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import {
  RightSidebarConversationContext,
  type RightSidebarConversationContextValue,
  type SubagentInvocationPanelDetails,
} from "@/renderer/components/layout/RightSidebarConversationContext";
import { RightSidebarInitialPage } from "@/renderer/components/layout/RightSidebarInitialPage";
import {
  SubagentInvocationDetail,
  SubagentRunList,
  groupSubagentRunsForList,
} from "@/renderer/pages/conversation/subagents/SubagentSidebarPanel";
import {
  AgentSessionRuntimeContext,
  type AgentSessionRuntimeContextValue,
} from "@/renderer/providers/AgentSessionProvider";
import {
  createInitialSubagentRunsState,
  replaceParentSubagentRuns,
} from "@/renderer/stores/subagentRunStore";
import { normalizeSubagentRunSnapshot, type SubagentRunSnapshot } from "@/types/subagents";

describe("Subagent sidebar", () => {
  it("separates active, failed, cancelled, and completed instances", () => {
    const completed = run({
      run_id: "run-completed",
      subagent_id: "subagent-completed",
      state: "completed",
      created_at: "2026-07-18T10:00:00.000Z",
      parent_timeline_sequence: 1,
    });
    const activeOlder = run({
      run_id: "run-active-older",
      subagent_id: "subagent-active-older",
      state: "running",
      created_at: "2026-07-18T09:00:00.000Z",
      parent_timeline_sequence: 2,
    });
    const activeNewer = run({
      run_id: "run-active-newer",
      subagent_id: "subagent-active-newer",
      state: "queued",
      created_at: "2026-07-18T11:00:00.000Z",
      parent_timeline_sequence: 3,
    });
    const failed = run({
      run_id: "run-failed",
      subagent_id: "subagent-failed",
      state: "failed",
      created_at: "2026-07-18T12:00:00.000Z",
      parent_timeline_sequence: 4,
    });
    const cancelled = run({
      run_id: "run-cancelled",
      subagent_id: "subagent-cancelled",
      state: "cancelled",
      created_at: "2026-07-18T13:00:00.000Z",
      parent_timeline_sequence: 5,
    });
    const interrupted = run({
      run_id: "run-interrupted",
      subagent_id: "subagent-interrupted",
      state: "interrupted",
      created_at: "2026-07-18T14:00:00.000Z",
      parent_timeline_sequence: 6,
    });

    const groups = groupSubagentRunsForList([
      completed,
      activeOlder,
      failed,
      activeNewer,
      cancelled,
      interrupted,
    ]);

    expect(groups.active.map((item) => item.latestRun.run_id)).toEqual([
      "run-active-newer",
      "run-active-older",
    ]);
    expect(groups.completed.map((item) => item.latestRun.run_id)).toEqual(["run-completed"]);
    expect(groups.failed.map((item) => item.latestRun.run_id)).toEqual([
      "run-interrupted",
      "run-failed",
    ]);
    expect(groups.cancelled.map((item) => item.latestRun.run_id)).toEqual(["run-cancelled"]);
  });

  it("shows separate terminal sections and previews the task instead of the result", () => {
    const active = run({
      run_id: "run-active-preview",
      subagent_id: "subagent-active-preview",
      state: "running",
      task: "monitor the active implementation",
    });
    const completed = run({
      run_id: "run-completed-preview",
      subagent_id: "subagent-completed-preview",
      state: "completed",
      task: "inspect the checkout flow",
    });
    const failed = run({
      run_id: "run-failed-preview",
      subagent_id: "subagent-failed-preview",
      state: "failed",
      task: "repair the search index",
    });
    const cancelled = run({
      run_id: "run-cancelled-preview",
      subagent_id: "subagent-cancelled-preview",
      state: "cancelled",
      task: "draft the migration plan",
    });
    const parentSessionId = completed.parent_session_id;
    const subagentState = replaceParentSubagentRuns(
      createInitialSubagentRunsState(),
      parentSessionId,
      [completed, failed, cancelled, active],
    );

    render(
      <AgentSessionRuntimeContext.Provider
        value={{ subagentState, requestSubagentRuns: vi.fn() } as unknown as AgentSessionRuntimeContextValue}
      >
        <RightSidebarConversationContext.Provider value={sidebarContext()}>
          <SubagentRunList parentSessionId={parentSessionId} />
        </RightSidebarConversationContext.Provider>
      </AgentSessionRuntimeContext.Provider>,
    );

    expect(
      [...screen.getByTestId("subagent-sidebar-list").querySelectorAll("h3")]
        .map((heading) => heading.textContent),
    ).toEqual(["进行中 · 1", "已完成 · 1", "已取消 · 1", "失败 · 1"]);
    expect(screen.getByText("monitor the active implementation")).not.toBeNull();
    expect(screen.getByText("inspect the checkout flow")).not.toBeNull();
    expect(screen.getByText("repair the search index")).not.toBeNull();
    expect(screen.getByText("draft the migration plan")).not.toBeNull();
    expect(screen.queryByText("completed report")).toBeNull();
    expect(screen.queryByText("run failed")).toBeNull();
  });

  it("lists one row per Sub-Agent instance and opens its latest Run", async () => {
    const firstRun = run({
      run_id: "run-instance-first",
      subagent_id: "subagent-resumed",
      state: "completed",
      created_at: "2026-07-18T08:00:00.000Z",
      parent_timeline_sequence: 1,
    });
    const resumedRun = run({
      run_id: "run-instance-resumed",
      subagent_id: "subagent-resumed",
      state: "running",
      created_at: "2026-07-18T12:00:00.000Z",
      parent_timeline_sequence: 5,
      task: "continue the investigation",
    });
    const latestInstance = run({
      run_id: "run-latest-instance",
      subagent_id: "subagent-latest",
      state: "running",
      created_at: "2026-07-18T10:00:00.000Z",
      parent_timeline_sequence: 3,
      role: "worker",
      task: "implement the patch",
    });
    const requestSubagentRuns = vi.fn();
    const openSubagentPanel = vi.fn();
    const parentSessionId = firstRun.parent_session_id;
    const subagentState = replaceParentSubagentRuns(
      createInitialSubagentRunsState(),
      parentSessionId,
      [firstRun, resumedRun, latestInstance],
    );

    render(
      <AgentSessionRuntimeContext.Provider
        value={{ subagentState, requestSubagentRuns } as unknown as AgentSessionRuntimeContextValue}
      >
        <RightSidebarConversationContext.Provider value={sidebarContext({ openSubagentPanel })}>
          <SubagentRunList parentSessionId={parentSessionId} />
        </RightSidebarConversationContext.Provider>
      </AgentSessionRuntimeContext.Provider>,
    );

    await waitFor(() => expect(requestSubagentRuns).toHaveBeenCalledWith(parentSessionId));
    expect(screen.getByText("进行中 · 2")).not.toBeNull();
    expect(screen.getAllByTestId(/^subagent-sidebar-item:/)).toHaveLength(2);
    const list = screen.getByTestId("subagent-sidebar-list");
    expect(
      [...list.querySelectorAll<HTMLElement>('[data-testid^="subagent-sidebar-item:"]')]
        .map((item) => item.dataset.testid),
    ).toEqual([
      "subagent-sidebar-item:subagent-latest",
      "subagent-sidebar-item:subagent-resumed",
    ]);

    const resumedItem = screen.getByTestId("subagent-sidebar-item:subagent-resumed");
    expect(within(resumedItem).getByText("continue the investigation")).not.toBeNull();
    await userEvent.click(resumedItem);
    expect(openSubagentPanel).toHaveBeenCalledWith(resumedRun);
  });

  it("keeps invocation failure details in the panel and returns to the list", async () => {
    const onBack = vi.fn();
    const details: SubagentInvocationPanelDetails = {
      invocationId: "delegate-call-1",
      parentSessionId: "parent-session-1",
      role: "explorer",
      task: "inspect the repository",
      state: "failed",
      errorCode: "SUBAGENT_PARENT_INVALID",
      errorMessage: "parent tool call missing",
    };
    render(<SubagentInvocationDetail details={details} onBack={onBack} />);

    expect(screen.getByRole("status").textContent).toContain("启动失败");
    expect(screen.getByText(details.task)).not.toBeNull();
    expect(screen.getByText(details.errorMessage ?? "")).not.toBeNull();
    expect(screen.getByText(details.errorCode ?? "")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "返回 Sub-Agent 列表" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("offers the Sub-Agent workspace as a dedicated initial-page menu", async () => {
    const onOpenSubagents = vi.fn();
    render(
      <RightSidebarInitialPage
        actions={[{
          id: "subagents",
          label: "子智能体",
          icon: <span aria-hidden="true">S</span>,
          onSelect: onOpenSubagents,
        }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "子智能体" }));
    expect(onOpenSubagents).toHaveBeenCalledTimes(1);
  });
});

function run(overrides: Record<string, unknown>): SubagentRunSnapshot {
  const state = typeof overrides.state === "string" ? overrides.state : snapshotFixture.state;
  const active = state === "queued" || state === "running";
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    final_report: state === "completed" ? "completed report" : null,
    error_code: state === "failed" ? "SUBAGENT_RUN_FAILED" : null,
    error_message: state === "failed" ? "run failed" : null,
    started_at: state === "queued" ? null : snapshotFixture.started_at,
    finished_at: active ? null : snapshotFixture.finished_at,
    ...overrides,
  });
}

function sidebarContext(
  overrides: Partial<RightSidebarConversationContextValue> = {},
): RightSidebarConversationContextValue {
  return {
    openConversationPanel: vi.fn(),
    openSubagentList: vi.fn(),
    openSubagentPanel: vi.fn(),
    openSubagentInvocationPanel: vi.fn(),
    openBtwConversationFromSession: vi.fn(),
    ...overrides,
  };
}
