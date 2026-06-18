import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandExecutionBlock, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("CommandExecutionBlock", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders command metadata with output collapsed by default", () => {
    render(<CommandExecutionBlock message={commandMessage("running", { stdout: "line 1\n" })} />);

    expect(screen.getByText("正在执行命令 pytest backend/tests")).not.toBeNull();
    expect(screen.getByText("D:/repo")).not.toBeNull();
    expect(screen.getByText("2.3s")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block").textContent).toMatch(/正在执行命令 pytest backend\/tests.*2\.3s/);
    expect(screen.queryByText("line 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    expect(screen.getByText("line 1")).not.toBeNull();
  });

  it("copies combined stdout and stderr", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<CommandExecutionBlock message={commandMessage("completed", { stdout: "ok\n", stderr: "warn\n" })} />);

    expect(screen.queryByRole("button", { name: "复制命令输出" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    fireEvent.click(screen.getByRole("button", { name: "复制命令输出" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("ok\n\nwarn\n");
    });
    expect(screen.getByText("已复制")).not.toBeNull();
  });

  it("marks non-zero exit code as failed and is used by MessageList", () => {
    render(<MessageList messages={[commandMessage("completed", { stderr: "failed", exit_code: 1 })]} />);

    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
    expect(screen.getByText("退出码 1")).not.toBeNull();
    expect(screen.getByText("执行命令失败 pytest backend/tests")).not.toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("formats sub-second command durations as milliseconds", () => {
    render(<CommandExecutionBlock message={commandMessage("completed", { stdout: "ok\n", duration_ms: 86 })} />);

    expect(screen.getByText("86ms")).not.toBeNull();
    expect(screen.queryByText("0.1 秒")).toBeNull();
  });
});

function commandMessage(
  status: ConversationMessage["status"],
  payload: Record<string, unknown>,
): ConversationMessage {
  return {
    id: "command-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "command",
    itemType: "command_execution",
    status,
    content: [payload.stdout, payload.stderr].filter((value) => typeof value === "string").join(""),
    payload: {
      command: "pytest backend/tests",
      cwd: "D:/repo",
      duration_ms: 2300,
      ...payload,
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
