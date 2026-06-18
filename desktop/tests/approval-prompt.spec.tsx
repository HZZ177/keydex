import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPrompt, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ApprovalRequest } from "@/types/protocol";

describe("ApprovalPrompt", () => {
  it("renders approval operation, risk, target and collapsible details", () => {
    render(<ApprovalPrompt message={approvalMessage()} />);

    expect(screen.getByText("允许执行命令")).not.toBeNull();
    expect(screen.getByText("执行命令")).not.toBeNull();
    expect(screen.getByText("等待确认")).not.toBeNull();
    expect(screen.getByText("echo ok")).not.toBeNull();
    expect(screen.getByText("中")).not.toBeNull();
    expect(screen.queryByText(/workspace_write/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "审批详情" }));
    expect(screen.getByText(/workspace_write/)).not.toBeNull();
  });

  it("calls the real approval handler with allow and reject decisions", async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ApprovalPrompt message={approvalMessage("pending", "approval-allow")} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole("button", { name: "允许" }));

    await waitFor(() => {
      expect(onDecision).toHaveBeenCalledWith("approval-allow", "approved");
    });

    rerender(<ApprovalPrompt message={approvalMessage("pending", "approval-reject")} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    await waitFor(() => {
      expect(onDecision).toHaveBeenCalledWith("approval-reject", "rejected");
    });
  });

  it("shows resolved approval state without action buttons", () => {
    const { rerender } = render(<ApprovalPrompt message={approvalMessage("approved")} />);

    expect(screen.getByText("已允许")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();

    rerender(<ApprovalPrompt message={approvalMessage("rejected")} />);
    expect(screen.getByText("已拒绝")).not.toBeNull();
  });

  it("is used by MessageList for approval messages", () => {
    const onDecision = vi.fn();
    render(<MessageList messages={[approvalMessage()]} onApprovalDecision={onDecision} runtimeState="waiting_approval" />);

    expect(screen.getByTestId("approval-prompt")).not.toBeNull();
    expect(screen.queryByTestId("message-agent-status")).toBeNull();
    expect(screen.getByText("等待确认")).not.toBeNull();
  });
});

function approvalMessage(status: ApprovalRequest["status"] = "pending", id = "approval-1"): ConversationMessage {
  const approval: ApprovalRequest = {
    id,
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-1",
    kind: "exec",
    title: "允许执行命令",
    description: "Agent 请求执行命令以完成当前任务。",
    details: {
      command: "echo ok",
      cwd: "D:/repo",
      permission_mode: "workspace_write",
    },
    status,
    created_at: "2026-06-17T10:00:00Z",
  };

  return {
    id: `approval:${id}`,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-command",
    kind: "approval",
    status,
    content: approval.title,
    payload: { approval },
    createdAt: approval.created_at,
    updatedAt: approval.created_at,
  };
}
