import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ComposerApprovalCard } from "@/renderer/pages/conversation/ComposerApprovalCard";
import type { CommandApprovalRequest } from "@/types/protocol";

describe("ComposerApprovalCard", () => {
  it("submits once, exact trust, prefix trust and reject decisions", () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={approval()} allowPersistentTrust onSubmit={onSubmit} />);

    expect(screen.getByTestId("composer-approval-card")).not.toBeNull();
    expect(screen.getByText("是否允许执行命令？")).not.toBeNull();
    expect(screen.getByText("工作目录")).not.toBeNull();
    expect(screen.getByText("D:/repo")).not.toBeNull();
    expect(screen.getByText("pnpm test")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "是，仅允许本次" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "once" });

    fireEvent.click(screen.getByRole("button", { name: "是，且以后相同命令不再询问" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "approved",
      trust_scope: "persistent",
      rule_match_type: "exact",
    });

    fireEvent.click(screen.getByRole("button", { name: "是，且以后以该前缀开头的命令不再询问" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "approved",
      trust_scope: "persistent",
      rule_match_type: "prefix",
    });

    fireEvent.change(screen.getByPlaceholderText("告诉 agent 如何调整"), { target: { value: "请改成只读命令" } });
    fireEvent.click(screen.getByRole("button", { name: "否，请告知 agent 如何调整" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "rejected",
      trust_scope: "once",
      reject_message: "请改成只读命令",
    });
  });

  it("hides persistent trust actions when persistent trust is disabled", () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={approval()} allowPersistentTrust={false} error="审批提交失败" onSubmit={onSubmit} />);

    expect(screen.getByText("审批提交失败")).not.toBeNull();
    expect(screen.getByRole("button", { name: "是，仅允许本次" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "是，且以后相同命令不再询问" })).toBeNull();
    expect(screen.queryByRole("button", { name: "是，且以后以该前缀开头的命令不再询问" })).toBeNull();
  });
});

function approval(): CommandApprovalRequest {
  return {
    id: "approval-1",
    session_id: "session-1",
    thread_id: "session-1",
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-command",
    run_id: "run-command",
    tool_name: "run_command",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "命令会在当前工作区执行。",
    details: {
      command: "pnpm test",
      cwd: "D:/repo",
      suggested_exact_rule: "pnpm test",
      suggested_prefix_rule: "pnpm --dir desktop",
    },
    status: "pending",
    created_at: "2026-06-24T10:00:00Z",
    resolved_at: null,
  };
}
