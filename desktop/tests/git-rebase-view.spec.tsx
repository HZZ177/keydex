import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRebaseView, validateRebaseTodo } from "@/renderer/features/git/components/GitRebaseView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitRebasePreview, GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git rebase workflow", () => {
  it("normalizes previews and maps only validated todo/control fields", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => jsonResponse(rawPreview()))
      .mockImplementation(async () => jsonResponse(operation()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-rebase" as never };
    const preview = await runtime.rebasePreview(scope, "main", "release");
    await runtime.rebase({
      ...scope,
      idempotencyKey: "rebase-command-key",
      upstream: "main",
      onto: "release",
      interactive: true,
      todo: preview.commits.map((item, index) => ({ ...item, action: index ? "squash" : "pick" })),
    });
    await runtime.controlRebase({ ...scope, idempotencyKey: "rebase-control-key", action: "abort" });

    expect(preview).toMatchObject({ upstream: "main", onto: "release", dirty: false });
    const payload = JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body));
    expect(payload).toMatchObject({ upstream: "main", onto: "release", interactive: true });
    expect(payload.todo).toEqual([
      { action: "pick", object_id: "a".repeat(40), subject: "one", message: null },
      { action: "squash", object_id: "b".repeat(40), subject: "two", message: null },
    ]);
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body))).toMatchObject({ action: "abort" });
  });

  it("edits and reorders an interactive plan and exposes recovery controls", () => {
    const onPreview = vi.fn();
    const onRebase = vi.fn();
    const onControl = vi.fn();
    const { rerender } = render(
      <GitRebaseView refs={refs()} status={status()} preview={preview()} busy={false} onPreview={onPreview} onRebase={onRebase} onControl={onControl} />,
    );
    fireEvent.change(screen.getByLabelText("Upstream"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Onto (optional)"), { target: { value: "release" } });
    fireEvent.click(screen.getByLabelText("Edit interactive todo"));
    fireEvent.change(screen.getByLabelText("Action for one"), { target: { value: "reword" } });
    expect(screen.getByRole("alert").textContent).toContain("new commit message");
    fireEvent.change(screen.getByLabelText("New message for one"), { target: { value: "one rewritten" } });
    fireEvent.change(screen.getByLabelText("Action for two"), { target: { value: "squash" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebase" }));
    expect(screen.getByRole("alertdialog", { name: "Confirm rebase" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rebase" }));
    expect(onRebase).toHaveBeenCalledWith(
      "main",
      "release",
      true,
      expect.arrayContaining([
        expect.objectContaining({ subject: "one", action: "reword", message: "one rewritten" }),
        expect.objectContaining({ subject: "two", action: "squash" }),
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Move two up" }));
    expect(screen.getByRole("alert").textContent).toContain("previous non-dropped");
    expect(validateRebaseTodo([
      { action: "squash", objectId: "b".repeat(40) as never, subject: "two" },
      { action: "pick", objectId: "a".repeat(40) as never, subject: "one" },
    ])).toContain("previous");

    rerender(<GitRebaseView refs={refs()} status={status("continuable")} preview={preview()} busy={false} onPreview={onPreview} onRebase={onRebase} onControl={onControl} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm abort" }));
    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["continue", "skip", "abort"]);
  });
});

function refs(): GitRef[] {
  return ["main", "release"].map((name, index) => ({ fullName: `refs/heads/${name}`, shortName: name, kind: "local", objectId: String(index + 1).repeat(40) as never, peeledObjectId: null, upstream: null, ahead: 0, behind: 0, current: false }));
}

function status(state?: "continuable" | "conflicted"): GitStatusSnapshot {
  return { repositoryId: "git-rebase" as never, repositoryVersion: "version-1" as never, branch: { head: "topic", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false }, files: [], operation: state ? { kind: "rebase", state, currentStep: 1, totalSteps: 2, currentObjectId: "a".repeat(40) as never } : null };
}

function preview(): GitRebasePreview {
  return { repositoryId: "git-rebase" as never, repositoryVersion: "version-1" as never, upstream: "main", onto: "release", headObjectId: "c".repeat(40) as never, upstreamObjectId: "d".repeat(40) as never, ontoObjectId: "e".repeat(40) as never, dirty: false, commits: [{ objectId: "a".repeat(40) as never, subject: "one" }, { objectId: "b".repeat(40) as never, subject: "two" }] };
}

function rawPreview() {
  return { repository_id: "git-rebase", repository_version: "version-1", upstream: "main", onto: "release", head_object_id: "c".repeat(40), upstream_object_id: "d".repeat(40), onto_object_id: "e".repeat(40), dirty: false, commits: [{ object_id: "a".repeat(40), subject: "one" }, { object_id: "b".repeat(40), subject: "two" }] };
}

function operation() { return { operation_id: "rebase-op", repository_id: "git-rebase", repository_version: "version-2", state: "succeeded", summary: "Rebased", result: {} }; }
function jsonResponse(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
