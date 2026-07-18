import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCompareView } from "@/renderer/features/git/components/GitCompareView";
import { GitComparisonView } from "@/renderer/features/git/components/GitComparisonView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitCommitSummary, GitCompareResult } from "@/runtime/gitTypes";

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

    await runtime.compare({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId: "git-compare" as never,
    }, {
      mode: "working_tree",
      left: "main",
      path: "src/selected file.ts",
    });
    const selectedUrl = new URL(String(fetcher.mock.calls[1][0]));
    expect(Object.fromEntries(selectedUrl.searchParams)).toMatchObject({
      mode: "working_tree",
      left: "main",
      path: "src/selected file.ts",
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

    expect(screen.getByText("（合并基准）")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("比较方式"), { target: { value: "three_dot" } });
    fireEvent.change(screen.getByLabelText("基准分支（A）"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("目标分支（B）"), { target: { value: "topic" } });
    fireEvent.click(screen.getByRole("button", { name: "比较" }));
    expect(onCompare).toHaveBeenCalledWith("three_dot", "main", "topic");

    fireEvent.click(screen.getByRole("button", { name: /topic\.txt/ }));
    expect(onSelectFile).toHaveBeenCalledWith(0);

    fireEvent.change(screen.getByLabelText("比较方式"), { target: { value: "working_tree" } });
    expect(screen.getByText("右侧：工作树")).toBeTruthy();
  });

  it("resizes the two directional commit lists by pointer and keyboard", () => {
    const currentCommit = comparisonCommit("current", "a");
    const targetCommit = comparisonCommit("target", "b");
    render(
      <GitComparisonView
        intent={{ kind: "compare_refs", currentRef: "release-0.7.1", targetRef: "release-0.7.0" }}
        result={normalizedCompare()}
        currentOnlyCommits={[currentCommit]}
        targetOnlyCommits={[targetCommit]}
        selectedCommitId={currentCommit.objectId}
        selectedFileIndex={0}
        loading={false}
        error={null}
        onSelectCommit={vi.fn()}
        onSelectFile={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const comparison = screen.getByLabelText("release-0.7.1 与 release-0.7.0 的提交比较");
    Object.defineProperty(comparison, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const separator = screen.getByRole("separator", { name: "调整两组提交列表高度" });
    expect(separator.getAttribute("aria-valuenow")).toBe("50");

    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator.getAttribute("aria-valuenow")).toBe("52");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("18");
    fireEvent.doubleClick(separator);
    expect(separator.getAttribute("aria-valuenow")).toBe("50");

    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 250 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientY: 350 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientY: 350 }));
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(70);
  });
});

function comparisonCommit(subject: string, seed: string): GitCommitSummary {
  return {
    objectId: seed.repeat(40) as never,
    parentIds: [],
    authorName: "Alice",
    authorEmail: "alice@example.invalid",
    authoredAt: "2026-07-19T00:00:00Z",
    committerName: "Alice",
    committerEmail: "alice@example.invalid",
    committedAt: "2026-07-19T00:00:00Z",
    subject,
    body: "",
    decorations: [],
    signature: "unsigned",
  };
}

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
