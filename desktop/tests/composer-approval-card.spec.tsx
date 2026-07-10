import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ComposerApprovalCard } from "@/renderer/pages/conversation/ComposerApprovalCard";
import type { CommandApprovalRequest } from "@/types/protocol";

describe("ComposerApprovalCard", () => {
  it("focuses the default approval choice so Enter submits without clicking the card", () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={approval()} allowPersistentTrust onSubmit={onSubmit} />);

    const approveOnce = screen.getAllByRole("radio")[0];
    expect(document.activeElement).toBe(approveOnce);

    fireEvent.keyDown(approveOnce, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith({ decision: "approved", trust_scope: "once" });
  });

  it("selects once, exact trust, prefix trust and reject decisions before submitting", async () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={approval()} allowPersistentTrust onSubmit={onSubmit} />);

    expect(screen.getByTestId("composer-approval-card")).not.toBeNull();
    expect(screen.getByText("是否允许执行命令？")).not.toBeNull();
    expect(screen.getByText("D:/repo")).not.toBeNull();
    expect(screen.getByTestId("composer-approval-command").textContent).toContain("pnpm test");
    expect(screen.getByRole("radio", { name: "是" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByPlaceholderText("告诉智能体如何调整")).toBeNull();

    const group = screen.getByRole("radiogroup", { name: "命令确认选项" });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "是，且以后相同命令不再询问" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "是" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "否，请告知智能体如何调整" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => {
      expect(screen.getByPlaceholderText("告诉智能体如何调整")).toBe(document.activeElement);
    });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "是" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "是" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("radio", { name: "是" }), { key: "Enter" });
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "once" });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "once" });

    fireEvent.click(screen.getByRole("radio", { name: "是，且以后相同命令不再询问" }));
    expect(screen.getByRole("radio", { name: "是，且以后相同命令不再询问" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "approved",
      trust_scope: "persistent",
      rule_match_type: "exact",
    });

    fireEvent.click(screen.getByRole("radio", { name: "是，且以后以该前缀开头的命令不再询问" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "approved",
      trust_scope: "persistent",
      rule_match_type: "prefix",
    });

    fireEvent.click(screen.getByRole("radio", { name: "否，请告知智能体如何调整" }));
    expect(screen.getByRole("radio", { name: "否，请告知智能体如何调整" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("composer-approval-reject-panel")).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("告诉智能体如何调整"), { target: { value: "请改成只读命令" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "rejected",
      trust_scope: "once",
      reject_message: "请改成只读命令",
    });

    fireEvent.click(screen.getByRole("radio", { name: "是" }));
    expect((screen.getByPlaceholderText("告诉智能体如何调整") as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "rejected", trust_scope: "once" });
  });

  it("hides persistent trust actions when persistent trust is disabled", () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={approval()} allowPersistentTrust={false} error="审批提交失败" onSubmit={onSubmit} />);

    expect(screen.getByText("审批提交失败")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "是" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "否，请告知智能体如何调整" })).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "是，且以后相同命令不再询问" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "是，且以后以该前缀开头的命令不再询问" })).toBeNull();
    expect(screen.getByRole("button", { name: "提交" })).not.toBeNull();
  });

  it("uses MCP-specific trust scopes for MCP tool approvals", () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={mcpApproval()} allowPersistentTrust={false} onSubmit={onSubmit} />);

    expect(screen.getByTestId("composer-approval-card").getAttribute("aria-label")).toBe("MCP 工具确认");
    expect(screen.getByText("允许 Ticket MCP MCP 执行 write_fixture？")).not.toBeNull();
    expect(screen.getByText("Ticket MCP / write_fixture")).not.toBeNull();
    expect(screen.getByTestId("composer-approval-command").textContent).toContain('"title": "Fix"');
    expect(screen.getByRole("radio", { name: "允许本次" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: "始终允许同样请求" })).toBeNull();
    expect(screen.getByRole("radio", { name: "允许并信任本会话" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "始终信任该工具" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "信任此 MCP 服务器" })).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "是，且以后相同命令不再询问" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "允许本次" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "once" });

    fireEvent.click(screen.getByRole("radio", { name: "允许并信任本会话" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "session" });

    fireEvent.click(screen.getByRole("radio", { name: "始终信任该工具" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "persistent_tool" });

    fireEvent.click(screen.getByRole("radio", { name: "信任此 MCP 服务器" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "persistent_server" });

    fireEvent.click(screen.getByRole("radio", { name: "拒绝，请告知智能体如何调整" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "rejected",
      trust_scope: "once",
      reject_message: "",
    });
  });

  it("uses once-only choices for MCP sampling approvals", () => {
    const onSubmit = vi.fn();

    render(<ComposerApprovalCard approval={mcpSamplingApproval()} allowPersistentTrust onSubmit={onSubmit} />);

    expect(screen.getByTestId("composer-approval-card").getAttribute("aria-label")).toBe("MCP 模型请求确认");
    expect(screen.getByText("是否允许 Ticket MCP MCP 模型请求？")).not.toBeNull();
    expect(screen.getByText("Ticket MCP / qwen-coder")).not.toBeNull();
    expect(screen.getByTestId("composer-approval-command").textContent).toContain("message_count");
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getByTestId("composer-approval-command").textContent).toContain("Summarize ticket");
    expect(screen.getByRole("radio", { name: "允许本次模型请求" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "拒绝，请告知智能体如何调整" })).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "允许并信任本会话" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "始终信任该工具" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ decision: "approved", trust_scope: "once" });

    fireEvent.click(screen.getByRole("radio", { name: "拒绝，请告知智能体如何调整" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "rejected",
      trust_scope: "once",
      reject_message: "",
    });
  });

  it("omits generic workspace copy and dot cwd from the approval card", () => {
    const onSubmit = vi.fn();

    render(
      <ComposerApprovalCard
        approval={{
          ...approval(),
          description: "这个命令将在当前工作区执行。",
          details: {
            ...approval().details,
            cwd: ".",
          },
        }}
        allowPersistentTrust
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByText("这个命令将在当前工作区执行。")).toBeNull();
    expect(screen.queryByTestId("composer-approval-cwd")).toBeNull();
    expect(screen.getByTestId("composer-approval-command").textContent).toContain("pnpm test");
  });

  it("scrolls long expanded commands and submits reject reason with Enter", async () => {
    const onSubmit = vi.fn();
    const longCommand = Array.from({ length: 12 }, (_, index) => `echo line-${index + 1}`).join("\n");

    render(
      <ComposerApprovalCard
        approval={{
          ...approval(),
          details: {
            ...approval().details,
            command: longCommand,
          },
        }}
        allowPersistentTrust
        onSubmit={onSubmit}
      />,
    );

    const command = screen.getByTestId("composer-approval-command");
    expect(command.getAttribute("data-expanded")).toBe("false");
    expect(command.textContent).not.toContain("line-12");

    fireEvent.click(screen.getByRole("button", { name: "展开" }));

    await waitFor(() => {
      expect(command.getAttribute("data-expanded")).toBe("true");
      expect(command.getAttribute("tabindex")).toBe("0");
      expect(command.textContent).toContain("line-12");
    });

    fireEvent.click(screen.getByRole("radio", { name: "否，请告知智能体如何调整" }));
    const textarea = await screen.findByPlaceholderText("告诉智能体如何调整");
    fireEvent.change(textarea, { target: { value: "请改为只读检查" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenLastCalledWith({
      decision: "rejected",
      trust_scope: "once",
      reject_message: "请改为只读检查",
    });
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
    tool_name: "run_cmd",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "命令会在当前工作区执行。",
    details: {
      command: "pnpm test",
      cwd: "D:/repo",
      tool_name: "run_cmd",
      shell: "cmd",
      shell_label: "CMD",
      shell_path: "C:/Windows/System32/cmd.exe",
      suggested_exact_rule: "pnpm test",
      suggested_prefix_rule: "pnpm --dir desktop",
    },
    status: "pending",
    created_at: "2026-06-24T10:00:00Z",
    resolved_at: null,
  };
}

function mcpApproval(): CommandApprovalRequest {
  return {
    id: "approval-mcp",
    session_id: "session-1",
    thread_id: "session-1",
    turn_id: "turn-1",
    item_id: "item-mcp",
    call_id: "call-mcp",
    run_id: "run-mcp",
    tool_name: "mcp__srv_1__write_fixture",
    kind: "mcp_tool_call",
    title: "允许 Ticket MCP MCP 执行 write_fixture？",
    description: "MCP 工具请求执行，需要你确认后继续。",
    details: {
      approval_kind: "mcp_tool_call",
      server_id: "srv-1",
      server_name: "Ticket MCP",
      raw_tool_name: "write_fixture",
      model_tool_name: "mcp__srv_1__write_fixture",
      arguments_preview: { title: "Fix", priority: "high" },
      trust_options: ["once", "session", "persistent_tool", "persistent_server"],
    },
    status: "pending",
    created_at: "2026-07-07T10:00:00Z",
    resolved_at: null,
  };
}

function mcpSamplingApproval(): CommandApprovalRequest {
  return {
    id: "approval-sampling",
    session_id: "session-1",
    thread_id: "session-1",
    turn_id: "turn-1",
    item_id: "item-sampling",
    call_id: "call-sampling",
    run_id: "run-sampling",
    tool_name: "qwen-coder",
    kind: "mcp_sampling",
    title: "是否允许 Ticket MCP MCP Sampling？",
    description: "MCP 服务请求 Keydex 使用当前默认模型生成内容，需要你确认后继续。",
    details: {
      approval_kind: "mcp_sampling",
      server_id: "srv-1",
      server_name: "Ticket MCP",
      raw_tool_name: "sampling/createMessage",
      model: "qwen-coder",
      model_policy: "current_default",
      max_tokens: 128,
      approval_mode: "prompt",
      audit_detail: "summary",
      message_count: 1,
      arguments_preview: {
        message_count: 1,
        roles: ["user"],
        preview: ["Summarize ticket"],
      },
    },
    status: "pending",
    created_at: "2026-07-07T10:00:00Z",
    resolved_at: null,
  };
}
