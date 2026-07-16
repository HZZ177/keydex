import { describe, expect, it } from "vitest";

import {
  normalizeGitCommandResult,
  normalizeGitRepository,
  normalizeGitRuntimeError,
  normalizeGitStatus,
} from "@/runtime/gitTypes";

describe("Git runtime domain normalization", () => {
  it("normalizes structured operation lifecycle metadata", () => {
    expect(normalizeGitCommandResult({
      operation_id: "op-1",
      repository_id: "repo-a",
      repository_version: "v2",
      state: "failed",
      summary: "Fetch failed",
      result: { retryable: true },
      command: "fetch",
      risk: "write",
      created_at: "2026-07-16T00:00:00Z",
      started_at: "2026-07-16T00:00:00.100Z",
      finished_at: "2026-07-16T00:00:00.350Z",
      duration_ms: 250,
      retryable: true,
      error: { code: "git_network_unavailable", message: "Offline", retryable: true, details: {} },
    })).toMatchObject({
      operationId: "op-1",
      repositoryId: "repo-a",
      command: "fetch",
      risk: "write",
      state: "failed",
      durationMs: 250,
      retryable: true,
      error: { code: "git_network_unavailable", message: "Offline" },
    });
  });

  it("normalizes repository and status DTOs without leaking snake_case into UI", () => {
    expect(
      normalizeGitRepository({
        id: "repo-a",
        workspace_id: "workspace-a",
        root_path: "D:/work/repo",
        display_path: ".",
        git_dir_path: "D:/work/repo/.git",
        kind: "workspace",
        parent_repo_id: null,
        bare: false,
        ancestor_authorization: "not_required",
      }),
    ).toMatchObject({ id: "repo-a", workspaceId: "workspace-a", kind: "workspace" });

    const status = normalizeGitStatus({
      repository_id: "repo-a",
      repository_version: "v1",
      branch: { head: "main", detached_at: null, upstream: "origin/main", ahead: 1, behind: 2, unborn: false },
      files: [
        {
          path: "src/a.ts",
          original_path: null,
          index_status: "added",
          worktree_status: "modified",
          conflicted: false,
          binary: null,
          submodule: false,
        },
        {
          path: ".dev/",
          original_path: null,
          index_status: null,
          worktree_status: "ignored",
          conflicted: false,
          binary: false,
          submodule: false,
        },
      ],
    });
    expect(status.branch).toMatchObject({ head: "main", ahead: 1, behind: 2 });
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({ path: "src/a.ts", indexStatus: "added" });
  });

  it("rejects missing fields and unknown enums instead of silently downgrading", () => {
    expect(() => normalizeGitRepository({ id: "repo" })).toThrow("workspace_id");
    expect(() =>
      normalizeGitStatus({
        repository_id: "repo",
        repository_version: "v1",
        branch: { head: "main", ahead: 0, behind: 0 },
        files: [{ path: "a", index_status: "mystery" }],
      }),
    ).toThrow("unknown Git file status");
  });

  it("keeps structured safe error details and drops nested raw payloads", () => {
    expect(
      normalizeGitRuntimeError({
        code: "git_locked",
        message: "Repository is locked",
        retryable: true,
        operation_id: "operation-a",
        repository_id: "repo-a",
        details: { retry_after_ms: 100, nested: { stderr: "raw" } },
      }),
    ).toEqual({
      code: "git_locked",
      message: "Repository is locked",
      retryable: true,
      operationId: "operation-a",
      repositoryId: "repo-a",
      details: { retry_after_ms: 100 },
    });
  });
});
