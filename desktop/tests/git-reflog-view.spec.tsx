import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitReflogView } from "@/renderer/features/git/components/GitReflogView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitReflogPage } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git reflog", () => {
  it("normalizes action entries and encodes ref-bound pagination", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(rawPage()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    const page = await runtime.reflog({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId: "git-reflog" as never,
    }, { ref: "feature/topic", cursor: "next page", limit: 50 });

    expect(page).toMatchObject({ ref: "feature/topic", nextCursor: "cursor-2" });
    expect(page.entries[0]).toMatchObject({
      selector: "feature/topic@{0}",
      action: "commit",
      message: "topic change",
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ref: "feature/topic",
      cursor: "next page",
      limit: "50",
    });
  });

  it("loads a ref, selects recovery points, copies hashes, creates branches, and routes reset", () => {
    const onLoad = vi.fn();
    const onLoadMore = vi.fn();
    const onCopy = vi.fn();
    const onCreateBranch = vi.fn();
    const onReset = vi.fn();
    render(
      <GitReflogView
        page={page()}
        loading={false}
        refOptions={["main", "topic"]}
        onLoad={onLoad}
        onLoadMore={onLoadMore}
        onCopy={onCopy}
        onCreateBranch={onCreateBranch}
        onReset={onReset}
      />,
    );

    fireEvent.change(screen.getByLabelText("引用"), { target: { value: "topic" } });
    fireEvent.click(screen.getByRole("button", { name: "读取" }));
    expect(onLoad).toHaveBeenCalledWith("topic");

    fireEvent.click(screen.getAllByRole("option")[1]);
    fireEvent.click(screen.getByRole("button", { name: "复制哈希" }));
    expect(onCopy).toHaveBeenCalledWith("b".repeat(40));
    fireEvent.change(screen.getByLabelText("新分支"), { target: { value: "recovery/topic" } });
    fireEvent.click(screen.getByRole("button", { name: "创建分支" }));
    expect(onCreateBranch).toHaveBeenCalledWith("recovery/topic", "b".repeat(40));

    fireEvent.click(screen.getByRole("button", { name: "重置到此处" }));
    expect(onReset).toHaveBeenCalledWith("b".repeat(40));
    fireEvent.click(screen.getByRole("button", { name: "读取更早记录" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

function page(): GitReflogPage {
  return {
    repositoryId: "git-reflog" as never,
    repositoryVersion: "version-1" as never,
    ref: "HEAD",
    nextCursor: "cursor-2",
    entries: [
      entry("a", "HEAD@{0}", "checkout", "moving from topic to main"),
      entry("b", "HEAD@{1}", "commit", "topic change"),
    ],
  };
}

function entry(prefix: string, selector: string, action: string, message: string) {
  return {
    selector,
    objectId: prefix.repeat(40) as never,
    oldObjectId: null,
    actorName: "Alice",
    actorEmail: "alice@example.invalid",
    occurredAt: "2026-07-16T00:00:00Z",
    action,
    message,
  };
}

function rawPage() {
  return {
    repository_id: "git-reflog",
    repository_version: "version-1",
    ref: "feature/topic",
    next_cursor: "cursor-2",
    entries: [{
      selector: "feature/topic@{0}",
      object_id: "a".repeat(40),
      old_object_id: null,
      actor_name: "Alice",
      actor_email: "alice@example.invalid",
      occurred_at: "2026-07-16T00:00:00Z",
      action: "commit",
      message: "topic change",
    }],
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
