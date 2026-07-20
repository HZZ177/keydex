import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import {
  RightSidebarConversationContext,
  type RightSidebarConversationContextValue,
} from "@/renderer/components/layout/RightSidebarConversationContext";
import { SubagentInvocationCapsule } from "@/renderer/pages/conversation/subagents/SubagentInvocationCapsule";
import { SubagentRunCapsule } from "@/renderer/pages/conversation/subagents/SubagentRunCapsule";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { normalizeSubagentRunSnapshot } from "@/types/subagents";

describe("SubagentRunCapsule", () => {
  it.each([
    ["queued", "正在启动"],
    ["running", "正在工作"],
    ["completed", "已完成"],
    ["failed", "运行失败"],
    ["cancelled", "已取消"],
    ["interrupted", "已中断"],
  ] as const)("keeps the %s state accessible while rendering only the short name", (state, label) => {
    renderCapsule(snapshotForState(state));
    const capsule = screen.getByRole("button", { name: new RegExp(label) });
    expect(capsule.textContent).toBe("sub-worker");
    expect(capsule.getAttribute("data-state")).toBe(state);
    expect((capsule as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps blocked meaning outside visible content and opens the exact Run in the Sidecar", async () => {
    const openSubagentPanel = vi.fn();
    const run = snapshotForState("running", { blocked_on: "approval" });
    renderCapsule(run, openSubagentPanel);

    const capsule = screen.getByRole("button", { name: /sub-worker，等待审批/ });
    expect(capsule.textContent).toBe("sub-worker");
    expect(capsule.parentElement?.getAttribute("data-blocked")).toBe("approval");
    await userEvent.click(capsule);
    expect(openSubagentPanel).toHaveBeenCalledWith(run);
  });

  it("keeps task, reports, and errors out of the compact capsule button", () => {
    const { unmount } = renderCapsule(snapshotForState("completed", {
      role: "explorer",
      final_report: "source-backed explorer report",
    }));
    expect(screen.getByRole("button").textContent).toBe("sub-explore");
    expect(screen.getByRole("button").textContent).not.toContain("source-backed explorer report");
    expect(screen.getByRole("button").textContent).not.toContain(snapshotFixture.task);
    unmount();

    renderCapsule(snapshotForState("failed", {
      role: "worker",
      error_message: "diagnostic worker failure",
    }));
    expect(screen.getByRole("button").textContent).toBe("sub-worker");
    expect(screen.getByRole("button").textContent).not.toContain("diagnostic worker failure");
  });

  it("shows the live and frozen Run duration beside the capsule", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-18T13:00:06.000Z"));
      const running = renderCapsule(snapshotForState("running", {
        started_at: "2026-07-18T13:00:00.000Z",
      }));
      expect(screen.getByRole("status").textContent).toBe("正在工作 · 运行 6秒");

      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByRole("status").textContent).toBe("正在工作 · 运行 8秒");
      running.unmount();

      renderCapsule(snapshotForState("completed", {
        started_at: "2026-07-18T13:00:00.000Z",
        finished_at: "2026-07-18T13:00:12.000Z",
      }));
      expect(screen.getByRole("status").textContent).toBe("已完成 · 运行 12秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps all block reasons available to assistive technology", () => {
    const accessibleLabels = ["approval", "user_input", "external_tool"].map((blocked_on) => {
      const rendered = renderCapsule(snapshotForState("running", { blocked_on }));
      const label = screen.getByRole("button").getAttribute("aria-label") ?? "";
      rendered.unmount();
      return label;
    });
    expect(accessibleLabels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(accessibleLabels).size).toBe(3);
  });

  it("opens from the keyboard using the exact Run address", async () => {
    const openSubagentPanel = vi.fn();
    const run = snapshotForState("interrupted");
    renderCapsule(run, openSubagentPanel);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button"));
    await userEvent.keyboard("{Enter}");
    expect(openSubagentPanel).toHaveBeenCalledWith(run);
  });

  it("opens a failed invocation detail without showing the error in the capsule", async () => {
    const openSubagentInvocationPanel = vi.fn();
    const message = failedInvocationMessage();
    render(
      <RightSidebarConversationContext.Provider
        value={sidebarContext({ openSubagentInvocationPanel })}
      >
        <SubagentInvocationCapsule message={message} />
      </RightSidebarConversationContext.Provider>,
    );

    const capsule = screen.getByRole("button", { name: /sub-explore，启动失败/ });
    expect(capsule.textContent).toBe("sub-explore");
    expect(capsule.textContent).not.toContain("parent tool call missing");
    await userEvent.click(capsule);
    expect(openSubagentInvocationPanel).toHaveBeenCalledWith({
      invocationId: "delegate-call-1",
      parentSessionId: "parent-session-1",
      role: "explorer",
      task: "inspect the repository",
      state: "failed",
      errorCode: "SUBAGENT_PARENT_INVALID",
      errorMessage: "parent tool call missing",
    });
  });

  it("shows a running delegate invocation as working instead of starting", () => {
    render(
      <RightSidebarConversationContext.Provider value={sidebarContext()}>
        <SubagentInvocationCapsule message={runningInvocationMessage()} />
      </RightSidebarConversationContext.Provider>,
    );

    const capsule = screen.getByRole("button", { name: /sub-worker，正在工作/ });
    expect(capsule.getAttribute("data-state")).toBe("running");
    expect(screen.getByRole("status").textContent).toBe("正在工作");
    expect(screen.queryByText("正在启动")).toBeNull();
  });

  it("spins the role SVG around the center of its own viewBox", () => {
    const css = readFileSync(resolve(
      process.cwd(),
      "src/renderer/pages/conversation/subagents/SubagentRunCapsule.module.css",
    ), "utf8");

    expect(css).toMatch(/\.roleIcon > svg\s*{[^}]*transform-box:\s*view-box;[^}]*transform-origin:\s*50% 50%;/s);
    expect(css).toMatch(/\.capsule\[data-state="running"\] \.roleIcon > svg\s*{[^}]*animation:/s);
    expect(css).not.toMatch(/\.capsule\[data-state="running"\] \.roleIcon\s*{/s);
  });
});

function renderCapsule(run: ReturnType<typeof normalizeSubagentRunSnapshot>, openSubagentPanel = vi.fn()) {
  return render(
    <RightSidebarConversationContext.Provider
      value={sidebarContext({ openSubagentPanel })}
    >
      <SubagentRunCapsule run={run} />
    </RightSidebarConversationContext.Provider>,
  );
}

function sidebarContext(overrides: Partial<RightSidebarConversationContextValue> = {}): RightSidebarConversationContextValue {
  return {
    openConversationPanel: vi.fn(),
    openSubagentList: vi.fn(),
    openSubagentPanel: vi.fn(),
    openSubagentInvocationPanel: vi.fn(),
    openBtwConversationFromSession: vi.fn(),
    ...overrides,
  };
}

function failedInvocationMessage(): ConversationMessage {
  return {
    id: "invocation-message-1",
    threadId: "parent-session-1",
    turnId: "turn-1",
    itemId: "delegate-call-1",
    kind: "subagent_invocation",
    status: "failed",
    content: "",
    payload: {
      call: {
        id: "delegate-call-1",
        name: "delegate_subagent",
        arguments: { type: "explorer", task: "inspect the repository" },
      },
      result: {
        status: "error",
        model_content: JSON.stringify({
          error: {
            code: "SUBAGENT_PARENT_INVALID",
            message: "parent tool call missing",
          },
        }),
      },
    },
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
  };
}

function runningInvocationMessage(): ConversationMessage {
  return {
    ...failedInvocationMessage(),
    id: "invocation-message-running",
    itemId: "delegate-call-running",
    status: "running",
    payload: {
      call: {
        id: "delegate-call-running",
        name: "delegate_subagent",
        arguments: { type: "worker", task: "implement the requested change" },
      },
    },
  };
}

function snapshotForState(
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted",
  overrides: Record<string, unknown> = {},
) {
  const active = state === "queued" || state === "running";
  return normalizeSubagentRunSnapshot({
    ...snapshotFixture,
    state,
    final_report: state === "completed" ? snapshotFixture.final_report : null,
    error_code: state === "failed" ? "SUBAGENT_RUN_FAILED" : null,
    error_message: state === "failed" ? "failed" : null,
    queued_at: snapshotFixture.queued_at,
    started_at: state === "queued" ? null : snapshotFixture.started_at,
    finished_at: active ? null : snapshotFixture.finished_at,
    updated_at: active ? snapshotFixture.started_at : snapshotFixture.finished_at,
    blocked_on: null,
    ...overrides,
  });
}
