import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitResetRestoreView, resetRisk } from "@/renderer/features/git/components/GitResetRestoreView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitResetPreview, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git reset and restore", () => {
  it("normalizes reset preview and maps reset/restore payloads without conflating them", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(String(input).includes("reset-preview") ? rawPreview() : rawOperation()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-reset" as never };
    const preview = await runtime.resetPreview(scope, "HEAD@{1}", "hard");
    await runtime.reset({ ...scope, idempotencyKey: "reset-key", target: "HEAD@{1}", mode: "hard" });
    await runtime.restore({ ...scope, idempotencyKey: "restore-key", paths: ["src/a.ts"], source: "HEAD", staged: true, worktree: true });

    expect(preview).toMatchObject({ target: "HEAD@{1}", mode: "hard", untrackedOverwrites: ["collision.txt"] });
    const previewUrl = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(previewUrl.searchParams)).toMatchObject({ target: "HEAD@{1}", mode: "hard" });
    const resetPayload = JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body));
    expect(resetPayload).toMatchObject({ target: "HEAD@{1}", mode: "hard" });
    expect(resetPayload.paths).toBeUndefined();
    const restorePayload = JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body));
    expect(restorePayload).toMatchObject({ paths: ["src/a.ts"], source: "HEAD", staged: true, worktree: true });
    expect(restorePayload.target).toBeUndefined();
  });

  it("requires a matching preview, shows overwritten untracked paths, and executes the reviewed reset", () => {
    const onPreview = vi.fn();
    const onReset = vi.fn();
    const props = { status: status(), busy: false, resetOutcome: null, restoreOutcome: null, onPreview, onReset, onRestore: vi.fn() };
    const { rerender } = render(<GitResetRestoreView {...props} preview={null} initialResetTarget="HEAD@{1}" />);
    expect((screen.getByRole("button", { name: "Reset to target" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reset mode"), { target: { value: "hard" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    expect(onPreview).toHaveBeenCalledWith("HEAD@{1}", "hard");

    rerender(<GitResetRestoreView {...props} preview={preview()} initialResetTarget="HEAD@{1}" />);
    expect(screen.getByRole("alert").textContent).toContain("collision.txt");
    expect(screen.getAllByText("src/a.ts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("untracked-loss")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset to target" }));
    expect(onReset).toHaveBeenCalledWith("HEAD@{1}", "hard");
    expect(resetRisk("soft", ["x"])).toBe("history-rewrite");
    expect(resetRisk("hard", [])).toBe("destructive");
  });

  it("keeps path restore separate and maps index/worktree destinations", () => {
    const onRestore = vi.fn();
    render(<GitResetRestoreView status={status()} preview={null} initialResetTarget="" busy={false} resetOutcome={null} restoreOutcome={null} onPreview={vi.fn()} onReset={vi.fn()} onRestore={onRestore} />);
    fireEvent.change(screen.getByLabelText("Restore paths"), { target: { value: "src/a.ts\nsrc/b.ts" } });
    fireEvent.change(screen.getByLabelText("Restore source"), { target: { value: "HEAD~1" } });
    fireEvent.change(screen.getByLabelText("Restore destination"), { target: { value: "both" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore selected paths" }));
    expect(screen.getByRole("alertdialog", { name: "Confirm path restore" }).textContent).toContain("src/a.ts, src/b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(onRestore).toHaveBeenCalledWith(["src/a.ts", "src/b.ts"], "HEAD~1", true, true);
  });
});

function preview(): GitResetPreview {
  return { repositoryId: "git-reset" as never, repositoryVersion: "version-1" as never, target: "HEAD@{1}", targetObjectId: "b".repeat(40) as never, headObjectId: "a".repeat(40) as never, mode: "hard", files: [{ path: "src/a.ts", changeType: "changed" }], untrackedOverwrites: ["collision.txt"], reflogRecovery: "Use HEAD@{1}." };
}

function status(): GitStatusSnapshot {
  return { repositoryId: "git-reset" as never, repositoryVersion: "version-1" as never, branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false }, files: [{ path: "src/a.ts", originalPath: null, indexStatus: "modified", worktreeStatus: "modified", conflicted: false, binary: null, submodule: false }], operation: null };
}

function rawPreview() {
  return { repository_id: "git-reset", repository_version: "version-1", target: "HEAD@{1}", target_object_id: "b".repeat(40), head_object_id: "a".repeat(40), mode: "hard", files: [{ path: "src/a.ts", change_type: "changed" }], untracked_overwrites: ["collision.txt"], reflog_recovery: "Use HEAD@{1}." };
}

function rawOperation() { return { operation_id: "git-op", repository_id: "git-reset", repository_version: "version-2", state: "succeeded", summary: "Git operation", result: {} }; }

function jsonResponse(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
