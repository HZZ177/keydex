import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitBlameView } from "@/renderer/features/git/components/GitBlameView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitBlamePage } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git blame", () => {
  it("normalizes a line window and encodes revision/ignore-revs safely", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(rawPage()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    const page = await runtime.blame({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId: "git-blame" as never,
    }, {
      path: "src/file name.ts",
      revision: "main",
      startLine: 101,
      lineCount: 250,
      ignoreRevsFile: ".git-blame-ignore-revs",
    });

    expect(page).toMatchObject({
      path: "src/file name.ts",
      revision: "main",
      startLine: 101,
      nextStartLine: 351,
      ignoreRevsFile: ".git-blame-ignore-revs",
    });
    expect(page.lines[0]).toMatchObject({ finalLine: 101, boundary: true, uncommitted: false });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      path: "src/file name.ts",
      revision: "main",
      start_line: "101",
      line_count: "250",
      ignore_revs_file: ".git-blame-ignore-revs",
    });
  });

  it("loads options, exposes working/boundary lines, pages, and opens committed history", () => {
    const onLoad = vi.fn();
    const onLoadMore = vi.fn();
    const onOpenCommit = vi.fn();
    render(
      <GitBlameView
        page={page()}
        loading={false}
        defaultPath="src/file.ts"
        onLoad={onLoad}
        onLoadMore={onLoadMore}
        onOpenCommit={onOpenCommit}
      />,
    );

    fireEvent.change(screen.getByLabelText("修订"), { target: { value: "main" } });
    fireEvent.click(screen.getByLabelText("使用忽略修订配置文件"));
    fireEvent.click(screen.getByRole("button", { name: "查看逐行历史" }));
    expect(onLoad).toHaveBeenCalledWith({
      path: "src/file.ts",
      revision: "main",
      ignoreRevsFile: ".git-blame-ignore-revs",
    });

    expect(screen.getByText("边界提交")).toBeTruthy();
    const committed = screen.getByTitle(new RegExp(`^${"a".repeat(40)}`));
    fireEvent.click(committed);
    expect(onOpenCommit).toHaveBeenCalledWith("a".repeat(40));
    const working = screen.getByTitle("工作树中尚未提交的行") as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "从第 3 行继续加载" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

function page(): GitBlamePage {
  return {
    repositoryId: "git-blame" as never,
    repositoryVersion: "version-1" as never,
    path: "src/file.ts",
    revision: null,
    startLine: 1,
    nextStartLine: 3,
    ignoreRevsFile: null,
    lines: [
      {
        objectId: "a".repeat(40) as never,
        originalLine: 1,
        finalLine: 1,
        authorName: "Alice",
        authorEmail: "alice@example.invalid",
        authoredAt: 1_768_435_200,
        summary: "initial",
        filename: "old-file.ts",
        content: "const value = 1;",
        boundary: true,
        uncommitted: false,
      },
      {
        objectId: "0".repeat(40) as never,
        originalLine: 2,
        finalLine: 2,
        authorName: "Not Committed Yet",
        authorEmail: "",
        authoredAt: null,
        summary: "Version of src/file.ts from working tree",
        filename: "src/file.ts",
        content: "const working = true;",
        boundary: false,
        uncommitted: true,
      },
    ],
  };
}

function rawPage() {
  return {
    repository_id: "git-blame",
    repository_version: "version-1",
    path: "src/file name.ts",
    revision: "main",
    start_line: 101,
    next_start_line: 351,
    ignore_revs_file: ".git-blame-ignore-revs",
    lines: [{
      object_id: "a".repeat(40),
      original_line: 101,
      final_line: 101,
      author_name: "Alice",
      author_email: "alice@example.invalid",
      authored_at: 1_768_435_200,
      summary: "initial",
      filename: "src/file name.ts",
      content: "line",
      boundary: true,
      uncommitted: false,
    }],
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
