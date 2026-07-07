import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { McpElicitationPrompt, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("McpElicitationPrompt", () => {
  it("renders MCP elicitation form fields from schema", () => {
    render(<MessageList messages={[elicitationMessage()]} onResolveMcpElicitation={vi.fn()} />);

    expect(screen.getByTestId("mcp-elicitation-prompt")).not.toBeNull();
    expect(screen.getByText("补充工单信息")).not.toBeNull();
    expect(screen.getByText("Ticket MCP")).not.toBeNull();
    expect(screen.getByText("create_issue")).not.toBeNull();
    expect(screen.getByLabelText(/标题/)).not.toBeNull();
    expect(screen.getByLabelText(/优先级/)).not.toBeNull();
    expect(screen.getByLabelText(/详情/)).not.toBeNull();
    expect(screen.getByLabelText(/确认写入/)).not.toBeNull();

    const secret = screen.getByLabelText(/API Token/) as HTMLInputElement;
    expect(secret.type).toBe("password");
  });

  it("submits typed elicitation values", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<McpElicitationPrompt message={elicitationMessage()} onResolve={onResolve} />);

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: "Fix login" } });
    fireEvent.change(screen.getByLabelText(/优先级/), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText(/详情/), { target: { value: "用户无法登录" } });
    fireEvent.change(screen.getByLabelText(/API Token/), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByLabelText(/确认写入/));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith({
        elicitation_id: "elicit-1",
        values: {
          title: "Fix login",
          priority: "high",
          details: "用户无法登录",
          confirm_write: true,
          api_token: "secret-token",
        },
      });
    });
  });

  it("validates required fields before submit", () => {
    const onResolve = vi.fn();
    render(<McpElicitationPrompt message={elicitationMessage()} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(screen.getAllByText("请填写该字段")).toHaveLength(2);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("sends cancel payload and renders resolved cancelled state", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<McpElicitationPrompt message={elicitationMessage()} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith({
        elicitation_id: "elicit-1",
        cancelled: true,
      });
    });

    rerender(<McpElicitationPrompt message={elicitationMessage("cancelled")} onResolve={onResolve} />);
    expect(screen.getByText("已取消补充信息请求，工具调用将停止。")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
  });
});

function elicitationMessage(status: "pending" | "submitted" | "cancelled" | "timeout" = "pending"): ConversationMessage {
  return {
    id: "agent:mcp-elicitation:elicit-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "elicit-1",
    kind: "mcp_elicitation",
    status: status === "pending" ? "pending" : status === "cancelled" ? "cancelled" : status === "timeout" ? "failed" : "completed",
    content: "补充工单信息",
    payload: {
      elicitation: {
        elicitation_id: "elicit-1",
        session_id: "ses-1",
        server_id: "srv-1",
        server_name: "Ticket MCP",
        raw_tool_name: "create_issue",
        title: "补充工单信息",
        status,
        schema: {
          type: "object",
          description: "工单系统需要补充字段。",
          required: ["title", "priority"],
          properties: {
            title: {
              type: "string",
              title: "标题",
            },
            priority: {
              type: "string",
              title: "优先级",
              enum: ["low", "high"],
            },
            details: {
              type: "string",
              title: "详情",
              format: "textarea",
            },
            confirm_write: {
              type: "boolean",
              title: "确认写入",
            },
            api_token: {
              type: "string",
              title: "API Token",
              format: "password",
            },
          },
        },
        created_at: "2026-06-18T08:00:01Z",
      },
    },
    createdAt: "2026-06-18T08:00:01Z",
    updatedAt: "2026-06-18T08:00:01Z",
  };
}
