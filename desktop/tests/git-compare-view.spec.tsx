import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCompareView } from "@/renderer/features/git/components/GitCompareView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitCompareResult } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git compare", () => {
  it("encodes explicit comparison semantics and normalizes the actual diff base", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(rawCompare()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    const result = await runtime.compare({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId: "git-compare" as never,
    }, { mode: "three_dot", left: "main", right: "topic" });

    expect(result).toMatchObject({
      mode: "three_dot",
      leftLabel: "main",
      rightLabel: "topic",
      mergeBaseObjectId: "c".repeat(40),
      comparisonBaseObjectId: "c".repeat(40),
    });
    expect(result.files[0]).toMatchObject({ newPath: "topic.txt", additions: 1 });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      mode: "three_dot",
      left: "main",
      right: "topic",
    });
  });

  it("switches modes, submits A/B labels, and selects compared files", () => {
    const onCompare = vi.fn();
    const onSelectFile = vi.fn();
    const result = normalizedCompare();
    render(
      <GitCompareView
        result={result}
        loading={false}
        revisions={["refs/heads/main", "refs/heads/topic"]}
        defaultLeft={"c".repeat(40)}
        defaultRight={"a".repeat(40)}
        selectedFileIndex={0}
        onCompare={onCompare}
        onSelectFile={onSelectFile}
      />,
    );

    expect(screen.getByText("(merge base)")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "three_dot" } });
    fireEvent.change(screen.getByLabelText("Base branch (A)"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Target branch (B)"), { target: { value: "topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(onCompare).toHaveBeenCalledWith("three_dot", "main", "topic");

    fireEvent.click(screen.getByRole("button", { name: /topic\.txt/ }));
    expect(onSelectFile).toHaveBeenCalledWith(0);

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "working_tree" } });
    expect(screen.getByText("Right: Working tree")).toBeTruthy();
  });
});

function normalizedCompare(): GitCompareResult {
  return {
    repositoryId: "git-compare" as never,
    repositoryVersion: "version-1" as never,
    mode: "three_dot",
    leftLabel: "main",
    rightLabel: "topic",
    leftObjectId: "a".repeat(40) as never,
    rightObjectId: "b".repeat(40) as never,
    comparisonBaseObjectId: "c".repeat(40) as never,
    mergeBaseObjectId: "c".repeat(40) as never,
    files: [{
      oldPath: null,
      newPath: "topic.txt",
      status: "added",
      binary: false,
      oldMode: null,
      newMode: "100644",
      additions: 1,
      deletions: 0,
      hunks: [],
      rawPatch: "diff --git",
      truncated: false,
    }],
  };
}

function rawCompare() {
  return {
    repository_id: "git-compare",
    repository_version: "version-1",
    mode: "three_dot",
    left_label: "main",
    right_label: "topic",
    left_object_id: "a".repeat(40),
    right_object_id: "b".repeat(40),
    comparison_base_object_id: "c".repeat(40),
    merge_base_object_id: "c".repeat(40),
    files: [{
      old_path: null,
      new_path: "topic.txt",
      status: "added",
      binary: false,
      old_mode: null,
      new_mode: "100644",
      additions: 1,
      deletions: 0,
      hunks: [],
      raw_patch: "diff --git",
      truncated: false,
    }],
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
