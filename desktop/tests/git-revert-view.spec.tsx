import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRevertView, revertItemState } from "@/renderer/features/git/components/GitRevertView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitCommandResult, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git revert workflow", () => {
  it("maps ordered commits, explicit merge mainline, and controls", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(result("succeeded")));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-revert" as never };
    await runtime.revert({ ...scope, idempotencyKey: "revert-key", commits: ["merge", "plain"], mainline: 2 });
    await runtime.controlRevert({ ...scope, idempotencyKey: "abort-key", action: "abort" });

    expect(fetcher.mock.calls[0][0]).toContain("/revert");
    expect(JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body))).toMatchObject({ commits: ["merge", "plain"], mainline: 2 });
    expect(fetcher.mock.calls[1][0]).toContain("/revert/control");
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({ action: "abort" });
  });

  it("submits a non-destructive revert plan and validates mainline", () => {
    const onRevert = vi.fn();
    const onControl = vi.fn();
    render(<GitRevertView refs={[]} status={null} busy={false} requestedCommits={[]} outcome={null} onRevert={onRevert} onControl={onControl} />);
    expect(screen.getByText(/Existing history is not moved or deleted/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Commits to revert"), { target: { value: "one\ntwo" } });
    fireEvent.change(screen.getByLabelText("Mainline parent"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create revert commits" }));
    expect(onRevert).toHaveBeenCalledWith(["one", "two"], 2);
    fireEvent.change(screen.getByLabelText("Mainline parent"), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toContain("integer from 1 to 64");
    expect((screen.getByRole("button", { name: "Create revert commits" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows conflict progress and continue/skip/abort recovery", () => {
    const onControl = vi.fn();
    const commits = ["a".repeat(40), "b".repeat(40)];
    render(<GitRevertView refs={[]} status={status(commits[1])} busy={false} requestedCommits={commits} outcome={result("failed")} onRevert={vi.fn()} onControl={onControl} />);
    expect(screen.getByText(commits[0].slice(0, 12)).closest("li")?.getAttribute("data-state")).toBe("reverted");
    expect(screen.getByText(commits[1].slice(0, 12)).closest("li")?.getAttribute("data-state")).toBe("conflicted");
    expect((screen.getByRole("button", { name: "Continue revert" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Skip revert" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort revert" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm abort" }));
    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["skip", "abort"]);
    expect(revertItemState(commits[0], 0, commits, null, { ...result("succeeded"), summary: "Revert abort" })).toBe("aborted");
  });
});

function status(currentObjectId: string): GitStatusSnapshot {
  return {
    repositoryId: "git-revert" as never,
    repositoryVersion: "version-2" as never,
    branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    files: [],
    operation: { kind: "revert", state: "conflicted", currentStep: 2, totalSteps: 2, currentObjectId: currentObjectId as never },
  };
}

function result(state: "succeeded" | "failed"): GitCommandResult {
  return { operationId: "revert-op", repositoryId: "git-revert" as never, repositoryVersion: "version-2" as never, state, summary: "Reverted", result: {}, command: "revert", risk: "write", createdAt: null, startedAt: null, finishedAt: null, durationMs: null, retryable: false, error: null };
}

function jsonResponse(body: GitCommandResult) { return new Response(JSON.stringify({ operation_id: body.operationId, repository_id: "git-revert", repository_version: "version-2", state: body.state, summary: body.summary, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } }); }
