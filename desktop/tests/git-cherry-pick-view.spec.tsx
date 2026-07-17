import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCherryPickView, cherryPickItemState, parseCherryPickCommits } from "@/renderer/features/git/components/GitCherryPickView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitCommandResult, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git cherry-pick workflow", () => {
  it("maps ordered commits, -x, and recovery controls to the runtime contract", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(operation("succeeded")));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-cherry" as never };
    await runtime.cherryPick({ ...scope, idempotencyKey: "pick-key", commits: ["one", "two"], recordOrigin: true });
    await runtime.controlCherryPick({ ...scope, idempotencyKey: "skip-key", action: "skip" });

    expect(fetcher.mock.calls[0][0]).toContain("/cherry-pick");
    expect(JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body))).toMatchObject({ commits: ["one", "two"], record_origin: true });
    expect(fetcher.mock.calls[1][0]).toContain("/cherry-pick/control");
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({ action: "skip" });
  });

  it("preserves entered order, rejects duplicates, and exposes per-item conflict state", () => {
    const onCherryPick = vi.fn();
    const onControl = vi.fn();
    const commits = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const { rerender } = render(
      <GitCherryPickView refs={[]} status={null} busy={false} requestedCommits={[]} outcome={null} onCherryPick={onCherryPick} onControl={onControl} />,
    );
    fireEvent.change(screen.getByLabelText("要摘取的提交"), { target: { value: "one\ntwo, three" } });
    fireEvent.click(screen.getByLabelText("附加来源信息（-x）"));
    fireEvent.click(screen.getByRole("button", { name: "摘取提交" }));
    expect(onCherryPick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认摘取提交" }).textContent).toContain("one → two → three");
    fireEvent.click(screen.getByRole("button", { name: "确认摘取" }));
    expect(onCherryPick).toHaveBeenCalledWith(["one", "two", "three"], true);

    fireEvent.change(screen.getByLabelText("要摘取的提交"), { target: { value: "one one" } });
    expect(screen.getByRole("alert").textContent).toContain("重复出现");
    expect((screen.getByRole("button", { name: "摘取提交" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<GitCherryPickView refs={[]} status={conflictedStatus(commits[1])} busy={false} requestedCommits={commits} outcome={operation("failed")} onCherryPick={onCherryPick} onControl={onControl} />);
    expect(screen.getByText(commits[0].slice(0, 12)).closest("li")?.getAttribute("data-state")).toBe("applied");
    expect(screen.getByText(commits[1].slice(0, 12)).closest("li")?.getAttribute("data-state")).toBe("conflicted");
    expect(screen.getByText(commits[2].slice(0, 12)).closest("li")?.getAttribute("data-state")).toBe("pending");
    expect((screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    fireEvent.click(screen.getByRole("button", { name: "确认跳过" }));
    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    fireEvent.click(screen.getByRole("button", { name: "确认中止" }));
    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["skip", "abort"]);
  });

  it("classifies completed, empty, failed, and aborted queue items", () => {
    expect(parseCherryPickCommits("a\n b,c")).toEqual(["a", "b", "c"]);
    const commits = ["a".repeat(40), "b".repeat(40)];
    expect(cherryPickItemState(commits[0], 0, commits, emptyStatus(commits[0]), operation("failed"))).toBe("empty");
    expect(cherryPickItemState(commits[1], 1, commits, null, operation("succeeded"), [commits[1]])).toBe("empty");
    expect(cherryPickItemState(commits[0], 0, commits, null, operation("failed"))).toBe("failed");
    expect(cherryPickItemState(commits[0], 0, commits, null, { ...operation("succeeded"), summary: "Cherry-pick abort" })).toBe("aborted");
  });
});

function conflictedStatus(currentObjectId: string): GitStatusSnapshot {
  return statusWithOperation("conflicted", currentObjectId);
}

function emptyStatus(currentObjectId: string): GitStatusSnapshot {
  return statusWithOperation("continuable", currentObjectId);
}

function statusWithOperation(state: "conflicted" | "continuable", currentObjectId: string): GitStatusSnapshot {
  return {
    repositoryId: "git-cherry" as never,
    repositoryVersion: "version-2" as never,
    branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    files: [],
    operation: { kind: "cherry_pick", state, currentStep: 2, totalSteps: 3, currentObjectId: currentObjectId as never },
  };
}

function operation(state: "succeeded" | "failed"): GitCommandResult {
  return { operationId: "pick-op", repositoryId: "git-cherry" as never, repositoryVersion: "version-2" as never, state, summary: "Cherry-picked", result: {}, command: "cherry_pick", risk: "write", createdAt: null, startedAt: null, finishedAt: null, durationMs: null, retryable: false, error: null };
}

function jsonResponse(body: unknown) { return new Response(JSON.stringify({ operation_id: (body as GitCommandResult).operationId, repository_id: "git-cherry", repository_version: "version-2", state: (body as GitCommandResult).state, summary: (body as GitCommandResult).summary, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } }); }
