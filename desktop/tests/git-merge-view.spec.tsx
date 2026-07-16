import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitMergeView } from "@/renderer/features/git/components/GitMergeView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitMergePreview, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git merge workflow", () => {
  it("normalizes preview and sends typed merge/abort payloads without remote fields", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => jsonResponse(rawPreview()))
      .mockImplementation(async () => jsonResponse(operation()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-merge" as never };

    const preview = await runtime.mergePreview(scope, "feature/topic");
    await runtime.merge({
      ...scope,
      idempotencyKey: "merge-command-key",
      expectedRepositoryVersion: preview.repositoryVersion,
      source: "feature/topic",
      strategy: "no_ff",
      message: "Merge topic",
    });
    await runtime.abortMerge({ ...scope, idempotencyKey: "merge-abort-key" });

    expect(preview).toMatchObject({ source: "feature/topic", incomingCommits: 2, fastForward: false });
    const previewUrl = new URL(String(fetcher.mock.calls[0][0]));
    expect(previewUrl.searchParams.get("source")).toBe("feature/topic");
    const mergePayload = JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body));
    expect(mergePayload).toMatchObject({ source: "feature/topic", strategy: "no_ff", message: "Merge topic" });
    expect(mergePayload).not.toHaveProperty("remote");
    expect(mergePayload).not.toHaveProperty("amend");
    expect(fetcher.mock.calls[2][0]).toContain("/merge/abort");
  });

  it("requires a matching preview, exposes strategies, and aborts conflicted merges", () => {
    const onPreview = vi.fn();
    const onMerge = vi.fn();
    const onAbort = vi.fn();
    const { rerender } = render(
      <GitMergeView refs={refs()} status={status()} preview={null} busy={false} onPreview={onPreview} onMerge={onMerge} onAbort={onAbort} />,
    );

    fireEvent.change(screen.getByLabelText("Source branch or revision"), { target: { value: "refs/heads/topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledWith("refs/heads/topic");
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<GitMergeView refs={refs()} status={status()} preview={preview()} busy={false} onPreview={onPreview} onMerge={onMerge} onAbort={onAbort} />);
    fireEvent.change(screen.getByLabelText("Source branch or revision"), { target: { value: "refs/heads/topic" } });
    fireEvent.change(screen.getByLabelText("Strategy"), { target: { value: "no_ff" } });
    fireEvent.change(screen.getByLabelText("Merge message (optional)"), { target: { value: "Merge topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onMerge).toHaveBeenCalledWith("refs/heads/topic", "no_ff", "Merge topic");
    expect(screen.getByText("Merge base")).toBeTruthy();
    expect(screen.getByText("Merge commit required")).toBeTruthy();

    rerender(<GitMergeView refs={refs()} status={status(true)} preview={preview()} busy={false} onPreview={onPreview} onMerge={onMerge} onAbort={onAbort} />);
    fireEvent.click(screen.getByRole("button", { name: "Abort merge" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

function refs(): GitRef[] {
  return [
    { fullName: "refs/heads/main", shortName: "main", kind: "local", objectId: "a".repeat(40) as never, peeledObjectId: null, upstream: null, ahead: 0, behind: 0, current: true },
    { fullName: "refs/heads/topic", shortName: "topic", kind: "local", objectId: "b".repeat(40) as never, peeledObjectId: null, upstream: null, ahead: 0, behind: 0, current: false },
  ];
}

function status(conflicted = false): GitStatusSnapshot {
  return {
    repositoryId: "git-merge" as never,
    repositoryVersion: "version-1" as never,
    branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    files: [],
    operation: conflicted ? { kind: "merge", state: "conflicted", currentStep: null, totalSteps: null, currentObjectId: "b".repeat(40) as never } : null,
  };
}

function preview(): GitMergePreview {
  return {
    repositoryId: "git-merge" as never,
    repositoryVersion: "version-1" as never,
    source: "refs/heads/topic",
    headObjectId: "a".repeat(40) as never,
    sourceObjectId: "b".repeat(40) as never,
    mergeBaseObjectId: "c".repeat(40) as never,
    incomingCommits: 2,
    fastForward: false,
    alreadyMerged: false,
    dirty: false,
  };
}

function rawPreview() {
  return {
    repository_id: "git-merge",
    repository_version: "version-1",
    source: "feature/topic",
    head_object_id: "a".repeat(40),
    source_object_id: "b".repeat(40),
    merge_base_object_id: "c".repeat(40),
    incoming_commits: 2,
    fast_forward: false,
    already_merged: false,
    dirty: false,
  };
}

function operation() {
  return { operation_id: "merge-op", repository_id: "git-merge", repository_version: "version-2", state: "succeeded", summary: "Merged", result: {} };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
