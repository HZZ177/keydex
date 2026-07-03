import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("ThreadTaskStatusBlock", () => {
  it("keeps the status badge visually aligned with the title row", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/conversation/messages/ThreadTaskStatusBlock.module.css"),
      "utf8",
    );

    expect(css).toMatch(/\.header\s*{[^}]*height:\s*18px[^}]*align-items:\s*stretch/s);
    expect(css).toMatch(/\.title\s*{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s);
    expect(css).toMatch(/\.badge\s*{[^}]*align-self:\s*stretch[^}]*box-sizing:\s*border-box/s);
    expect(css).not.toMatch(/\.badge\s*{[^}]*transform:/s);
  });

  it("renders goal completion as a dedicated status block instead of a tool panel", () => {
    render(<MessageList messages={[threadTaskStatusMessage()]} />);

    const block = screen.getByTestId("thread-task-status-block");
    expect(block).not.toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();
    expect(block.querySelector("svg.lucide-target")).not.toBeNull();
    expect(block.textContent).toContain("目标已完成");
    expect(block.textContent).toContain("完成");
    expect(block.textContent).toContain("三轮测试结果汇总");
    expect(block.textContent).not.toContain("update_thread_task");
    expect(block.textContent).not.toContain("23ms");
    expect(screen.queryByRole("button", { name: "展开工具详情" })).toBeNull();

    fireEvent.click(within(block).getByRole("button", { name: "展开目标状态详情" }));

    expect(screen.getByTestId("thread-task-status-details-shell").getAttribute("data-motion")).toBeTruthy();
    expect(screen.getByTestId("thread-task-status-details-shell").getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByLabelText("目标状态概览").tagName).toBe("DL");
    expect(screen.getByLabelText("目标状态详情").textContent).toContain("检查项");
    expect(within(screen.getByLabelText("检查项")).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByLabelText("目标状态详情").textContent).toContain("第二轮已启动");
    expect(screen.getByLabelText("目标状态详情").textContent).toContain("证据");
    expect(within(screen.getByLabelText("证据")).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByLabelText("目标状态详情").textContent).toContain("功能正常");
    expect(within(block).getByRole("button", { name: "收起目标状态详情" })).not.toBeNull();
  });

  it("renders blocked goal updates with a warning state", () => {
    render(
      <MessageList
        messages={[
          threadTaskStatusMessage({
            args: {
              status: "blocked",
              summary: "等待用户提供账号",
              reason: "缺少测试账号",
              attempts: ["尝试读取本地配置"],
              blocked_audit_key: "missing-account",
            },
            result: {
              status: "success",
              duration_ms: 118,
              ui_payload: {
                task: {
                  type: "goal",
                  type_label: "目标",
                  status: "blocked",
                },
              },
            },
          }),
        ]}
      />,
    );

    const block = screen.getByTestId("thread-task-status-block");
    expect(block.getAttribute("data-state")).toBe("blocked");
    expect(block.textContent).toContain("目标已阻塞");
    expect(block.textContent).toContain("等待用户提供账号");
  });

  it("parses nested runtime args and JSON result payloads", () => {
    render(
      <MessageList
        messages={[
          threadTaskStatusMessage({
            args: {
              args: {
                status: "complete",
                summary: "运行时嵌套摘要",
                checklist: [{ content: "完成第三轮验证" }],
                evidence: [{ detail: "目标自动续跑正常" }],
              },
            },
            result: {
              status: "success",
              model_content: JSON.stringify({
                status: "complete",
                task: {
                  type: "goal",
                  type_label: "目标",
                  status: "complete",
                  objective: "验证 goal 功能",
                },
              }),
              duration_ms: 32,
            },
          }),
        ]}
      />,
    );

    const block = screen.getByTestId("thread-task-status-block");
    expect(block.textContent).toContain("目标已完成");
    expect(block.textContent).toContain("运行时嵌套摘要");
    expect(block.textContent).not.toContain("32ms");

    fireEvent.click(within(block).getByRole("button", { name: "展开目标状态详情" }));

    expect(screen.getByLabelText("目标状态详情").textContent).toContain("验证 goal 功能");
    expect(screen.getByLabelText("目标状态详情").textContent).toContain("完成第三轮验证");
    expect(screen.getByLabelText("目标状态详情").textContent).toContain("目标自动续跑正常");
  });
});

function threadTaskStatusMessage({
  args = {
    status: "complete",
    summary: "三轮测试结果汇总",
    checklist: [{ item: "第二轮已启动" }],
    evidence: [{ summary: "功能正常" }],
  },
  result = {
    status: "success",
    duration_ms: 23,
    ui_payload: {
      task: {
        type: "goal",
        type_label: "目标",
        status: "complete",
      },
    },
  },
}: {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
} = {}): ConversationMessage {
  return {
    id: "thread-task-tool-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "thread_task_status",
    itemType: "tool_call",
    status: "completed",
    content: "update_thread_task",
    payload: {
      call: {
        id: "call-1",
        name: "update_thread_task",
        arguments: args,
      },
      result,
    },
    createdAt: "2026-07-03T10:00:00Z",
    updatedAt: "2026-07-03T10:00:02Z",
  };
}
