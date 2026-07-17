import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitConflictOverview, conflictLimitReason } from "@/renderer/features/git/components/GitConflictOverview";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitConflictFile, GitConflictsSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git conflict domain model", () => {
  it("normalizes base/ours/theirs content, encoding, limits, and actions", async () => {
    const fetcher = vi.fn(async () => jsonResponse(rawSnapshot()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const snapshot = await runtime.conflicts({ workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-conflict" as never });

    expect(snapshot.maxEditableBytes).toBe(1048576);
    expect(snapshot.files[0]).toMatchObject({ path: "conflict.txt", kind: "both_modified", editable: true, resultEol: "lf" });
    expect(snapshot.files[0].stages.map((stage) => [stage.stage, stage.label, stage.content])).toEqual([
      [1, "base", "base\n"],
      [2, "ours", "ours\n"],
      [3, "theirs", "theirs\n"],
    ]);
    expect(snapshot.files[1]).toMatchObject({ kind: "binary", editable: false, resultBinary: true });
  });

  it("renders every file's stage availability, action matrix, rename links, and limit reason", () => {
    const onSelect = vi.fn();
    const snapshot = normalizedSnapshot();
    render(<GitConflictOverview snapshot={snapshot} loading={false} selectedPath="conflict.txt" onSelect={onSelect} />);
    expect(screen.getAllByText("共同基础 · 当前分支 · 传入版本").length).toBe(3);
    expect(screen.getAllByText(/采用当前分支版本 · 采用传入版本/).length).toBe(2);
    expect(screen.getByText("二进制文件：无法直接编辑")).toBeTruthy();
    expect(screen.getByText(/重命名冲突可能涉及多个关联路径/)).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /binary.dat/ }));
    expect(onSelect).toHaveBeenCalledWith(snapshot.files[1]);
  });

  it("prioritizes submodule, binary, size, and encoding edit restrictions", () => {
    expect(conflictLimitReason(file("submodule"))).toContain("子模块");
    expect(conflictLimitReason(file("binary"))).toContain("二进制");
    expect(conflictLimitReason({ ...file("both_modified"), resultTooLarge: true })).toContain("文件过大");
    expect(conflictLimitReason({ ...file("both_modified"), stages: [{ ...file("both_modified").stages[0], encoding: "unsupported" }] })).toContain("编码");
  });
});

function normalizedSnapshot(): GitConflictsSnapshot {
  const text = file("both_modified");
  const binary = { ...file("binary"), path: "binary.dat", resultBinary: true, editable: false };
  const rename = { ...file("rename"), path: "old.txt", relatedPaths: ["old.txt", "new.txt"] };
  return { repositoryId: "git-conflict" as never, repositoryVersion: "version-1" as never, maxEditableBytes: 1048576, files: [text, binary, rename] };
}

function file(kind: GitConflictFile["kind"]): GitConflictFile {
  return { path: "conflict.txt", relatedPaths: [], kind, stages: [{ stage: 1, label: "base", objectId: "a".repeat(40) as never, mode: kind === "submodule" ? "160000" : "100644", size: 5, content: "base\n", binary: kind === "binary", encoding: kind === "binary" ? "binary" : "utf-8", eol: "lf", tooLarge: false }, { stage: 2, label: "ours", objectId: "b".repeat(40) as never, mode: "100644", size: 5, content: "ours\n", binary: false, encoding: "utf-8", eol: "lf", tooLarge: false }, { stage: 3, label: "theirs", objectId: "c".repeat(40) as never, mode: "100644", size: 7, content: "theirs\n", binary: false, encoding: "utf-8", eol: "lf", tooLarge: false }], resultContent: "<<<<<<<\n", resultBinary: false, resultEncoding: "utf-8", resultEol: "lf", resultTooLarge: false, resultRevision: "revision-1", allowedActions: ["accept_ours", "accept_theirs", "edit", "take_both", "delete"], editable: kind !== "binary" && kind !== "submodule" };
}

function rawSnapshot() {
  return { repository_id: "git-conflict", repository_version: "version-1", max_editable_bytes: 1048576, files: [{ path: "conflict.txt", related_paths: [], kind: "both_modified", stages: [{ stage: 1, label: "base", object_id: "a".repeat(40), mode: "100644", size: 5, content: "base\n", binary: false, encoding: "utf-8", eol: "lf", too_large: false }, { stage: 2, label: "ours", object_id: "b".repeat(40), mode: "100644", size: 5, content: "ours\n", binary: false, encoding: "utf-8", eol: "lf", too_large: false }, { stage: 3, label: "theirs", object_id: "c".repeat(40), mode: "100644", size: 7, content: "theirs\n", binary: false, encoding: "utf-8", eol: "lf", too_large: false }], result_content: "result\n", result_binary: false, result_encoding: "utf-8", result_eol: "lf", result_too_large: false, result_revision: "revision-1", allowed_actions: ["accept_ours", "accept_theirs", "edit", "take_both", "delete"], editable: true }, { path: "binary.dat", related_paths: [], kind: "binary", stages: [{ stage: 2, label: "ours", object_id: "d".repeat(40), mode: "100644", size: 5, content: null, binary: true, encoding: "binary", eol: "none", too_large: false }], result_content: null, result_binary: true, result_encoding: "binary", result_eol: "none", result_too_large: false, result_revision: "revision-2", allowed_actions: ["accept_ours", "accept_theirs", "delete"], editable: false }] };
}

function jsonResponse(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
