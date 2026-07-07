import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPrompt, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ApprovalRequest } from "@/types/protocol";

describe("ApprovalPrompt", () => {
  it("renders approval operation, target and collapsible details", () => {
    render(<ApprovalPrompt message={approvalMessage()} />);

    expect(screen.getByText("允许执行命令")).not.toBeNull();
    expect(screen.getByText("执行命令")).not.toBeNull();
    expect(screen.getByText("等待确认")).not.toBeNull();
    expect(screen.getAllByText("echo ok")).toHaveLength(2);
    expect(screen.getByText("run_cmd")).not.toBeNull();
    expect(screen.getByText("CMD")).not.toBeNull();
    expect(screen.getByText("C:/Windows/System32/cmd.exe")).not.toBeNull();
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

  it("renders MCP approval context, trust options and uses the same decision handler", async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt message={mcpApprovalMessage()} onDecision={onDecision} />);

    expect(screen.getByText("是否允许调用 MCP 工具？")).not.toBeNull();
    expect(screen.getByText("MCP 工具调用")).not.toBeNull();
    expect(screen.getByText("Ticket MCP / write")).not.toBeNull();
    expect(screen.getByText("write")).not.toBeNull();
    expect(screen.getByText("mcp__srv_1__write")).not.toBeNull();
    expect(screen.getByText(/"title":"Fix"/)).not.toBeNull();
    expect(screen.getByText("本会话信任；持久信任该工具")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "允许" }));

    await waitFor(() => {
      expect(onDecision).toHaveBeenCalledWith("approval-mcp", "approved");
    });
  });

  it("renders MCP sampling approval separately from tool approval", async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt message={samplingApprovalMessage()} onDecision={onDecision} />);

    expect(screen.getByText("是否允许 MCP Sampling？")).not.toBeNull();
    expect(screen.getByText("MCP Sampling")).not.toBeNull();
    expect(screen.queryByText("MCP 工具调用")).toBeNull();
    expect(screen.getByText("Ticket MCP / qwen-coder")).not.toBeNull();
    expect(screen.getByText("qwen-coder")).not.toBeNull();
    expect(screen.getByText("2048")).not.toBeNull();
    expect(screen.getByText("prompt")).not.toBeNull();
    expect(screen.getByText("summary")).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
    expect(screen.getByText("Summarize ticket status")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "允许" }));

    await waitFor(() => {
      expect(onDecision).toHaveBeenCalledWith("approval-sampling", "approved");
    });
  });

  it("shows resolved MCP sampling approval state without action buttons", () => {
    const { rerender } = render(<ApprovalPrompt message={samplingApprovalMessage("approved")} />);

    expect(screen.getByText("MCP Sampling")).not.toBeNull();
    expect(screen.getByText("已允许")).not.toBeNull();
    expect(screen.getByText("Ticket MCP / qwen-coder")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();

    rerender(<ApprovalPrompt message={samplingApprovalMessage("rejected")} />);

    expect(screen.getByText("已拒绝")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
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
    description: "智能体请求执行命令以完成当前任务。",
    details: {
      command: "echo ok",
      cwd: "D:/repo",
      tool_name: "run_cmd",
      shell_label: "CMD",
      shell_path: "C:/Windows/System32/cmd.exe",
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

function samplingApprovalMessage(status: ApprovalRequest["status"] = "pending"): ConversationMessage {
  const approval = {
    id: "approval-sampling",
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-sampling",
    call_id: "call-sampling",
    kind: "mcp_sampling",
    title: "是否允许 MCP Sampling？",
    description: "该 MCP server 请求 Keydex 使用当前模型生成内容。",
    details: {
      server_name: "Ticket MCP",
      model: "qwen-coder",
      max_tokens: 2048,
      sampling_approval_mode: "prompt",
      sampling_audit_detail: "summary",
      message_count: 2,
      prompt_preview: "Summarize ticket status",
    },
    status,
    created_at: "2026-06-17T10:00:00Z",
    metadata: {
      mcp: {
        kind: "mcp_sampling",
        model_policy: "current_default",
      },
    },
  };

  return {
    id: "approval:approval-sampling",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-sampling",
    kind: "approval",
    status,
    content: approval.title,
    payload: { approval },
    createdAt: approval.created_at,
    updatedAt: approval.created_at,
  };
}

function mcpApprovalMessage(): ConversationMessage {
  const approval = {
    id: "approval-mcp",
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-mcp",
    call_id: "call-mcp",
    kind: "mcp_tool_call",
    title: "是否允许调用 MCP 工具？",
    description: "该工具会向外部工单系统写入数据。",
    details: {
      arguments_preview: { title: "Fix", priority: "high" },
      trust_options: ["session", "persistent_tool"],
    },
    server_id: "srv-1",
    server_name: "Ticket MCP",
    raw_tool_name: "write",
    model_tool_name: "mcp__srv_1__write",
    snapshot_id: "snap-1",
    status: "pending",
    created_at: "2026-06-17T10:00:00Z",
    metadata: {
      mcp: {
        kind: "mcp_tool",
        approval_mode: "prompt",
      },
    },
  };

  return {
    id: "approval:approval-mcp",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-mcp",
    kind: "approval",
    status: "pending",
    content: approval.title,
    payload: { approval },
    createdAt: approval.created_at,
    updatedAt: approval.created_at,
  };
}
