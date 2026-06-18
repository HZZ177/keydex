import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageAgentStatus, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";

describe("MessageAgentStatus", () => {
  it("renders nothing for idle state", () => {
    const { container } = render(<MessageAgentStatus state="idle" />);

    expect(container.textContent).toBe("");
  });

  it.each([
    ["starting", "正在连接智能体"],
    ["running", "智能体正在处理"],
    ["waiting_approval", "等待权限确认"],
    ["cancelling", "正在停止"],
    ["failed", "运行失败"],
  ] satisfies Array<[ConversationRuntimeState, string]>)("renders %s", (state, label) => {
    render(<MessageAgentStatus state={state} detail="真实状态详情" />);

    expect(screen.getByRole("status").textContent).toContain(label);
    expect(screen.getByRole("status").textContent).toContain("真实状态详情");
  });

  it("is not rendered at the bottom of MessageList", () => {
    render(<MessageList messages={[]} runtimeState="waiting_approval" runtimeDetail="等待执行命令确认" />);

    expect(screen.queryByTestId("message-agent-status")).toBeNull();
    expect(screen.queryByText("等待执行命令确认")).toBeNull();
  });
});
