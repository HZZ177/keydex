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

    expect(screen.getByText("正在执行 pytest backend/tests")).not.toBeNull();
    expect(screen.getByText("D:/repo")).not.toBeNull();
    expect(screen.getByText("2.3s")).not.toBeNull();
    expect(screen.getByText("超时 5 分钟（默认）")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block").textContent).toMatch(
      /正在执行 pytest backend\/tests.*2\.3s.*超时 5 分钟（默认）/,
    );
    expect(screen.queryByText("line 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    expect(screen.getByText("run_cmd")).not.toBeNull();
    expect(screen.getByText("line 1")).not.toBeNull();
  });

  it("shows waiting approval instead of executing before command approval is resolved", () => {
    render(
      <CommandExecutionBlock
        message={commandMessage("running", {
          status: "approval_pending",
          approval: { required: true, approval_id: "approval-1", status: "pending" },
        })}
      />,
    );

    const blockText = screen.getByTestId("command-execution-block").textContent ?? "";
    expect(screen.getByText("等待审批 pytest backend/tests")).not.toBeNull();
    expect(screen.getByText("等待审批")).not.toBeNull();
    expect(blockText).not.toContain("正在执行 pytest backend/tests");
    expect(blockText).not.toContain("运行中");
  });

  it("copies combined stdout and stderr", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<CommandExecutionBlock message={commandMessage("completed", { stdout: "ok\n", stderr: "warn\n" })} />);

    expect(screen.queryByRole("button", { name: "复制输出" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));

    fireEvent.click(screen.getByRole("button", { name: "复制入参" }));
    await waitFor(() => {
      expect(clipboard).toHaveBeenLastCalledWith("pytest backend/tests");
    });
    expect(screen.getByRole("button", { name: "已复制入参" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenLastCalledWith("ok\n\nwarn\n");
    });
    expect(screen.getByRole("button", { name: "已复制输出" })).not.toBeNull();
  });

  it("keeps non-zero exit code as completed structured output and is used by MessageList", () => {
    render(<MessageList messages={[commandMessage("completed", { stderr: "failed", exit_code: 1 })]} />);

    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
    expect(screen.getByText("退出码 1")).not.toBeNull();
    expect(screen.getByText("已执行 pytest backend/tests")).not.toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("shows tool error details when failed command output is empty", () => {
    render(
      <CommandExecutionBlock
        message={commandMessage("failed", {
          stdout: "",
          stderr: "",
          result: {
            status: "error",
            model_content: "",
            error: {
              code: "tool_execution_failed",
              message: "NotImplementedError",
              details: { tool: "run_cmd", type: "NotImplementedError" },
            },
          },
        })}
      />,
    );

    expect(screen.getByText("启动失败 pytest backend/tests")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    const text = screen.getByTestId("command-execution-block").textContent ?? "";
    expect(text).toContain("NotImplementedError");
    expect(text).toContain("错误码：tool_execution_failed");
    expect(text).toContain('"tool": "run_cmd"');
    expect(text).toContain('"type": "NotImplementedError"');
    expect(screen.queryByText("无输出")).toBeNull();
  });

  it("shows command error payload returned as ui payload", () => {
    render(
      <CommandExecutionBlock
        message={commandMessage("failed", {
          stdout: "",
          stderr: "",
          result: {
            status: "error",
            ui_payload: {
              code: "invalid_tool_args",
              message: "command 必须是非空字符串",
            },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    const text = screen.getByTestId("command-execution-block").textContent ?? "";
    expect(text).toContain("command 必须是非空字符串");
    expect(text).toContain("错误码：invalid_tool_args");
  });

  it("uses error details when command error message is empty", () => {
    render(
      <CommandExecutionBlock
        message={commandMessage("failed", {
          stdout: "",
          stderr: "",
          result: {
            status: "error",
            ui_payload: {
              code: "tool_execution_failed",
              message: "",
              details: {
                tool: "run_cmd",
                type: "NotImplementedError",
              },
            },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    const text = screen.getByTestId("command-execution-block").textContent ?? "";
    expect(text).toContain("错误码：tool_execution_failed");
    expect(text).toContain('"tool": "run_cmd"');
    expect(text).toContain('"type": "NotImplementedError"');
  });

  it("renders rejected, timed out and disabled command result states", () => {
    const { rerender } = render(
      <CommandExecutionBlock message={commandMessage("completed", { status: "rejected", approval: { reject_message: "不执行" } })} />,
    );

    expect(screen.getByText("审批拒绝 pytest backend/tests")).not.toBeNull();
    expect(screen.getByText("审批拒绝")).not.toBeNull();
    expect(screen.getByText("拒绝说明：不执行")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block").dataset.status).toBe("failed");

    rerender(<CommandExecutionBlock message={commandMessage("completed", { status: "timed_out" })} />);
    expect(screen.getByText("命令超时 pytest backend/tests")).not.toBeNull();
    expect(screen.getByText("已超时")).not.toBeNull();

    rerender(<CommandExecutionBlock message={commandMessage("completed", { status: "shell_not_available" })} />);
    expect(screen.getByText("环境不可用 pytest backend/tests")).not.toBeNull();
    expect(screen.getByText("环境不可用")).not.toBeNull();
  });

  it("shows truncated output and trusted command rule metadata", () => {
    render(
      <CommandExecutionBlock
        message={commandMessage("completed", {
          stdout: "ok\n",
          output_truncated: true,
          approval: { trusted_rule_id: "rule-1" },
        })}
      />,
    );

    expect(screen.getByText("输出已截断")).not.toBeNull();
    expect(screen.getByText("已信任")).not.toBeNull();
  });

  it("loads deferred command output on expansion", async () => {
    const onLoadDetails = vi.fn().mockResolvedValue({
      payload: {
        call: {
          name: "run_cmd",
          arguments: { command: "pytest backend/tests", cwd: "D:/repo" },
        },
        result: {
          status: "success",
          ui_payload: {
            stdout: "lazy stdout\n",
            stderr: "lazy stderr\n",
            exit_code: 0,
            duration_ms: 91,
          },
        },
        duration_ms: 91,
      },
      status: "completed",
    });
    render(
      <CommandExecutionBlock
        message={{
          ...commandMessage("completed", {
            toolDetailsDeferred: true,
            toolSummary: { command: "pytest backend/tests", cwd: "D:/repo" },
          }),
          payload: {
            call: { name: "run_cmd", arguments: { command: "pytest backend/tests", cwd: "D:/repo" } },
            toolDetailsDeferred: true,
            toolSummary: { command: "pytest backend/tests", cwd: "D:/repo" },
          },
        }}
        onLoadDetails={onLoadDetails}
      />,
    );

    expect(screen.queryByText("lazy stdout")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));

    await waitFor(() => {
      expect(onLoadDetails).toHaveBeenCalledTimes(1);
      expect(screen.getByText("lazy stdout")).not.toBeNull();
      expect(screen.getByText("lazy stderr")).not.toBeNull();
    });
  });

  it("shows deferred command error preview before expansion", () => {
    const onLoadDetails = vi.fn();
    render(
      <CommandExecutionBlock
        message={{
          ...commandMessage("completed", {}),
          payload: {
            call: {
              name: "run_cmd",
              arguments: { command: "pytest backend/tests", cwd: "D:/repo" },
            },
            result: {
              status: "success",
              ui_payload: {
                command: "pytest backend/tests",
                cwd: "D:/repo",
                status: "completed",
                exit_code: 1,
                stderr: "ModuleNotFoundError: No module named app",
                output_truncated: true,
              },
            },
            toolDetailsDeferred: true,
          },
        }}
        onLoadDetails={onLoadDetails}
      />,
    );

    expect(screen.getByText("退出码 1")).not.toBeNull();
    expect(screen.getByText("输出已截断")).not.toBeNull();
    expect(screen.getByText("错误信息：ModuleNotFoundError: No module named app")).not.toBeNull();
    expect(onLoadDetails).not.toHaveBeenCalled();
  });

  it("formats sub-second command durations as milliseconds", () => {
    render(<CommandExecutionBlock message={commandMessage("completed", { stdout: "ok\n", duration_ms: 86 })} />);

    expect(screen.getByText("86ms")).not.toBeNull();
    expect(screen.queryByText("0.1 秒")).toBeNull();
  });

  it("requests command termination by command id", async () => {
    let releaseTerminate: () => void = () => undefined;
    const onTerminateCommand = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTerminate = resolve;
        }),
    );
    render(
      <CommandExecutionBlock
        message={commandMessage("running", {
          can_terminate: true,
          stdout: "still running\n",
        })}
        onTerminateCommand={onTerminateCommand}
      />,
    );

    expect(screen.queryByRole("button", { name: "终止命令" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    const terminateButton = screen.getByRole("button", { name: "终止命令" });
    expect(terminateButton.textContent).toBe("");
    expect(terminateButton.closest('[data-kind="input"]')).not.toBeNull();
    fireEvent.click(terminateButton);

    await waitFor(() => {
      expect(onTerminateCommand).toHaveBeenCalledWith("cmd-1");
    });
    const terminatingButton = screen.getByRole("button", { name: "正在终止命令" });
    expect((terminatingButton as HTMLButtonElement).disabled).toBe(true);
    expect(terminatingButton.getAttribute("data-terminating")).toBe("true");
    fireEvent.click(terminatingButton);
    expect(onTerminateCommand).toHaveBeenCalledTimes(1);

    releaseTerminate();
  });

  it("shows command termination in progress without exposing another terminate action", () => {
    render(
      <CommandExecutionBlock
        message={commandMessage("running", {
          status: "terminating",
          can_terminate: false,
          cancel_reason: "user",
          description: "停止长命令",
          stdout: "",
        })}
        onTerminateCommand={vi.fn()}
      />,
    );

    expect(screen.getByText("正在终止 停止长命令")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    expect(screen.getAllByText("正在终止").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "终止命令" })).toBeNull();
    expect(screen.queryByRole("button", { name: "正在终止命令" })).toBeNull();
  });

  it("shows simplified command input even when there is no output", () => {
    const longCommand = `python -c "${"print(1);".repeat(24)}"`;
    render(
      <CommandExecutionBlock
        message={commandMessage("running", {
          description: "运行长命令",
          command: longCommand,
          stdout: "",
          stderr: "",
          timeout_seconds: 45,
          timeout_source: "model",
        })}
      />,
    );

    expect(screen.getByText("正在执行 运行长命令")).not.toBeNull();
    expect(screen.getByText("超时 45 秒（模型设置）")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开命令详情" }));
    const inputText = screen.getByLabelText("命令入参").textContent ?? "";
    expect(inputText).toContain("运行长命令");
    expect(inputText).toContain("print(1);");
    expect(inputText).not.toContain("{");
    expect(inputText).not.toContain("timeout_seconds");
    expect(screen.queryByText("环境")).toBeNull();
    expect(screen.queryByText("目录")).toBeNull();
    expect(screen.getByText("入参")).not.toBeNull();
    expect(screen.getByText("实时输出")).not.toBeNull();
    expect(screen.getByText("等待命令输出")).not.toBeNull();
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
      command_id: "cmd-1",
      tool: "run_cmd",
      shell: "cmd",
      shell_label: "CMD",
      shell_path: "C:/Windows/System32/cmd.exe",
      command: "pytest backend/tests",
      cwd: "D:/repo",
      duration_ms: 2300,
      timeout_seconds: 300,
      timeout_source: "default",
      ...payload,
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
