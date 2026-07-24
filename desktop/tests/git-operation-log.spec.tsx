import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGitOperationDiagnostic,
  GitOperationLog,
} from "@/renderer/features/git/components/GitOperationLog";
import type { GitCommandResult } from "@/runtime/gitTypes";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("GitOperationLog", () => {
  it("renders mixed lifecycle states, metadata and a safe retry affordance", () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(
      <GitOperationLog
        operations={[
          operation("queued", "queue-op"),
          operation("cancelled", "cancel-op"),
          operation("failed", "failed-op", true),
          operation("succeeded", "success-op"),
        ]}
        repositoryLabels={{ "repo-1": "packages/app" }}
        canRetry={(operationId) => operationId === "failed-op"}
        onRetry={onRetry}
        canCancel={(operationId) => operationId === "queue-op"}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("排队中")).not.toBeNull();
    expect(screen.getByText("已取消")).not.toBeNull();
    expect(screen.getByText("失败")).not.toBeNull();
    expect(screen.getByText("成功")).not.toBeNull();
    expect(screen.getAllByText("packages/app")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledWith("failed-op");
    fireEvent.click(screen.getByRole("button", { name: "取消操作" }));
    expect(onCancel).toHaveBeenCalledWith("queue-op");
  });

  it("redacts secrets from expanded results and copied diagnostics", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const failed = operation("failed", "failed-op", true);
    render(
      <GitOperationLog
        operations={[failed]}
        repositoryLabels={{ "repo-1": "repo" }}
        canRetry={() => false}
        onRetry={vi.fn()}
        canCancel={() => false}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("查看清洗后的结果"));
    const visibleResult = screen.getByText((_, element) => element?.tagName === "PRE").textContent ?? "";
    expect(visibleResult).not.toContain("super-secret");
    expect(visibleResult).toContain("[REDACTED]");

    fireEvent.click(screen.getByRole("button", { name: "复制诊断" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).not.toContain("super-secret");
    expect(copied).not.toContain("ghp_1234567890abcdefghijkl");
    expect(copied).toContain("[REDACTED]");
  });

  it("builds a stable structured diagnostic without raw credentials", () => {
    const diagnostic = buildGitOperationDiagnostic(operation("failed", "failed-op", true), "repo");
    expect(JSON.parse(diagnostic)).toMatchObject({
      operation_id: "failed-op",
      repository: "repo",
      command: "fetch",
      risk: "write",
      state: "failed",
      retryable: true,
    });
    expect(diagnostic).not.toContain("super-secret");
  });

  it("offers an explicit credential login only for authentication failures", () => {
    const onLogin = vi.fn();
    const failed = operation("failed", "credential-op", true);
    failed.error = {
      code: "git_credentials_missing",
      message: "credentials unavailable",
      retryable: true,
      details: { remote: "origin" },
    };
    render(
      <GitOperationLog
        operations={[failed]}
        repositoryLabels={{ "repo-1": "repo" }}
        canRetry={() => true}
        onRetry={vi.fn()}
        canLogin={(operationId) => operationId === "credential-op"}
        onLogin={onLogin}
        canCancel={() => false}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "登录远程仓库" }));
    expect(onLogin).toHaveBeenCalledWith("credential-op");
  });
});

function operation(
  state: GitCommandResult["state"],
  operationId: string,
  retryable = false,
): GitCommandResult {
  return {
    operationId,
    repositoryId: "repo-1" as never,
    repositoryVersion: "v1" as never,
    state,
    summary: `${state} fetch`,
    result: {
      authorization: "Bearer super-secret",
      diagnostic: "https://user:super-secret@example.test/repo.git?access_token=super-secret",
      token: "ghp_1234567890abcdefghijkl",
    },
    command: "fetch",
    risk: "write",
    createdAt: "2026-07-16T00:00:00Z",
    startedAt: state === "queued" ? null : "2026-07-16T00:00:00.100Z",
    finishedAt: state === "queued" || state === "running" ? null : "2026-07-16T00:00:00.350Z",
    durationMs: state === "queued" || state === "running" ? null : 250,
    retryable,
    error: state === "failed" ? {
      code: "git_network_unavailable",
      message: "Bearer super-secret failed",
      retryable,
      details: { credential: "super-secret" },
    } : null,
  };
}
