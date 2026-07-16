import { describe, expect, it, vi } from "vitest";

import { createRuntimeBridge } from "@/runtime/bridge";
import { HttpClient } from "@/runtime/httpClient";
import { createGitRuntime } from "@/runtime/git";
import type { GitRepositoryId } from "@/runtime/gitTypes";

const repositoryId = "git-test" as GitRepositoryId;
const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId };

describe("Git runtime", () => {
  it("maps query URLs, response fields, and AbortSignal", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      repository_id: repositoryId,
      repository_version: "v1",
      branch: { head: "main", detached_at: null, upstream: "origin/main", ahead: 1, behind: 2, unborn: false },
      files: [],
      operation: null,
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const controller = new AbortController();

    await expect(runtime.status(scope, { signal: controller.signal })).resolves.toMatchObject({
      repositoryId,
      branch: { head: "main", ahead: 1, behind: 2 },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/git/repositories/git-test/status?workspace_id=workspace-a&project_root=C%3A%2Fproject",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("maps typed mutation bodies without accepting raw argv", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({
      operation_id: "op-1",
      repository_id: repositoryId,
      repository_version: "pending",
      state: "queued",
      summary: "stage",
      result: {},
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    await runtime.stage({ ...scope, idempotencyKey: "stage-key", paths: ["src/a.ts"] });
    await runtime.update({ ...scope, idempotencyKey: "update-key", remote: "origin", refspec: "main" });
    await runtime.applyPatch({
      ...scope,
      idempotencyKey: "patch-key",
      patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
    });
    await runtime.checkout({
      ...scope,
      idempotencyKey: "checkout-key",
      ref: "v1.0.0",
      detach: true,
    });
    await runtime.renameBranch({
      ...scope,
      idempotencyKey: "rename-branch-key",
      oldName: "feature/old",
      newName: "feature/new",
    });
    await runtime.deleteBranch({
      ...scope,
      idempotencyKey: "delete-branch-key",
      branchName: "feature/new",
      force: true,
      confirmationToken: "confirmed",
    });
    await runtime.createTag({
      ...scope,
      idempotencyKey: "create-tag-key",
      tagName: "v1.0.0",
      target: "HEAD",
      annotated: true,
      message: "Version one",
    });
    await runtime.deleteTag({
      ...scope,
      idempotencyKey: "delete-tag-key",
      tagName: "v1.0.0",
      remote: "origin",
      confirmationToken: "confirmed",
    });
    await runtime.push({
      ...scope,
      idempotencyKey: "push-key",
      remote: "origin",
      source: "feature/demo",
      target: "feature/demo",
      setUpstream: true,
      tags: true,
    });
    await runtime.push({
      ...scope,
      idempotencyKey: "push-tag-key",
      remote: "origin",
      source: "HEAD",
      target: "main",
      tagName: "v1.0.0",
    });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/stage");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      workspace_id: "workspace-a",
      repository_id: repositoryId,
      idempotency_key: "stage-key",
      paths: ["src/a.ts"],
    });
    const [updateUrl, updateInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(updateUrl).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/update");
    expect(JSON.parse(String(updateInit.body))).toMatchObject({
      idempotency_key: "update-key",
      remote: "origin",
      refspec: "main",
    });
    const [patchUrl, patchInit] = fetcher.mock.calls[2] as [string, RequestInit];
    expect(patchUrl).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/patch");
    expect(JSON.parse(String(patchInit.body))).toMatchObject({
      idempotency_key: "patch-key",
      cached: true,
      reverse: false,
    });
    const [checkoutUrl, checkoutInit] = fetcher.mock.calls[3] as [string, RequestInit];
    expect(checkoutUrl).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/checkout");
    expect(JSON.parse(String(checkoutInit.body))).toMatchObject({ ref: "v1.0.0", detach: true });
    expect(JSON.parse(String((fetcher.mock.calls[4][1] as RequestInit).body))).toMatchObject({
      old_name: "feature/old",
      new_name: "feature/new",
    });
    expect(JSON.parse(String((fetcher.mock.calls[5][1] as RequestInit).body))).toMatchObject({
      branch_name: "feature/new",
      force: true,
      remote: null,
    });
    const createTagBody = JSON.parse(String((fetcher.mock.calls[6][1] as RequestInit).body));
    expect(createTagBody).toMatchObject({
      tag_name: "v1.0.0",
      annotated: true,
      message: "Version one",
    });
    expect(createTagBody).not.toHaveProperty("amend");
    expect(JSON.parse(String((fetcher.mock.calls[7][1] as RequestInit).body))).toMatchObject({
      tag_name: "v1.0.0",
      remote: "origin",
    });
    expect(JSON.parse(String((fetcher.mock.calls[8][1] as RequestInit).body))).toMatchObject({
      remote: "origin",
      source: "feature/demo",
      target: "feature/demo",
      set_upstream: true,
      tags: true,
      force_with_lease: false,
    });
    const pushTagBody = JSON.parse(String((fetcher.mock.calls[9][1] as RequestInit).body));
    expect(pushTagBody).toMatchObject({
      remote: "origin",
      source: "HEAD",
      target: "main",
      tag_name: "v1.0.0",
    });
    expect(pushTagBody).not.toHaveProperty("annotated");
    expect(pushTagBody).not.toHaveProperty("message");
    expect(pushTagBody).not.toHaveProperty("sign");
  });

  it("sends the selected commit scope and untracked subset", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      operation_id: "op-commit",
      repository_id: repositoryId,
      repository_version: "pending",
      state: "queued",
      summary: "commit",
      result: {},
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    await runtime.createCommit({
      ...scope,
      idempotencyKey: "selected-commit-key",
      message: "feat: selected files",
      paths: ["src/renamed.ts", "src/old.ts", "new.txt"],
      untrackedPaths: ["new.txt"],
    });

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: "feat: selected files",
      paths: ["src/renamed.ts", "src/old.ts", "new.txt"],
      untracked_paths: ["new.txt"],
      amend: false,
      sign: false,
    });
  });

  it("saves a conflict result with optimistic result and index-stage revisions", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      repository_id: repositoryId,
      repository_version: "v2",
      path: "src/conflict.ts",
      result_revision: "result-v2",
      bytes_written: 17,
      encoding: "utf-8-bom",
      eol: "crlf",
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    await expect(runtime.saveConflictResult({
      ...scope,
      path: "src/conflict.ts",
      content: "manual\nresult\n",
      encoding: "utf-8-bom",
      eol: "crlf",
      expectedResultRevision: "result-v1",
      expectedStages: [{ stage: 2, objectId: "b".repeat(40) as never }, { stage: 3, objectId: "c".repeat(40) as never }],
    })).resolves.toMatchObject({ resultRevision: "result-v2", bytesWritten: 17 });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/conflicts/result");
    expect(JSON.parse(String(init.body))).toMatchObject({
      expected_result_revision: "result-v1",
      expected_stages: [{ stage: 2, object_id: "b".repeat(40) }, { stage: 3, object_id: "c".repeat(40) }],
      encoding: "utf-8-bom",
      eol: "crlf",
    });
  });

  it("routes typed conflict resolution and reopen actions through the operation queue", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      operation_id: "conflict-op",
      repository_id: repositoryId,
      repository_version: "v2",
      state: "succeeded",
      summary: "Marked resolved",
      result: { resolved_index: `100644 ${"d".repeat(40)} 0\tsrc/conflict.ts` },
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await runtime.conflictAction({
      ...scope,
      idempotencyKey: "conflict-action-key",
      action: "reopen",
      path: "src/conflict.ts",
      expectedStages: [{ stage: 1, objectId: "a".repeat(40) as never, mode: "100644" }],
      resolvedIndexEntry: `100644 ${"d".repeat(40)} 0\tsrc/conflict.ts`,
    });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/conflicts/action");
    expect(JSON.parse(String(init.body))).toMatchObject({
      action: "reopen",
      path: "src/conflict.ts",
      expected_stages: [{ stage: 1, object_id: "a".repeat(40), mode: "100644" }],
      resolved_index_entry: `100644 ${"d".repeat(40)} 0\tsrc/conflict.ts`,
    });
  });

  it("normalizes bisect state and maps explicit start/control commands", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        repository_version: "v-bisect",
        active: true,
        original_head: "refs/heads/main",
        current_revision: "c".repeat(40),
        good_revisions: ["a".repeat(40)],
        bad_revision: "f".repeat(40),
        skipped_revisions: [],
        candidate_revisions: ["c".repeat(40), "d".repeat(40)],
        remaining_count: 2,
        culprit_revision: null,
      }))
      .mockImplementation(async () => jsonResponse({
        operation_id: "bisect-op",
        repository_id: repositoryId,
        repository_version: "v-next",
        state: "succeeded",
        summary: "bisect",
        result: {},
      }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await expect(runtime.bisect(scope)).resolves.toMatchObject({ active: true, remainingCount: 2 });
    await runtime.startBisect({ ...scope, idempotencyKey: "bisect-start-key", goodRevision: "v1", badRevision: "HEAD" });
    await runtime.controlBisect({ ...scope, idempotencyKey: "bisect-good-key", action: "good" });
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({ good_revision: "v1", bad_revision: "HEAD" });
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body))).toMatchObject({ action: "good" });
  });

  it("normalizes submodule identities and maps recursive typed actions", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        repository_version: "v-submodule",
        submodules: [{
          path: "modules/core",
          object_id: "a".repeat(40),
          state: "clean",
          description: "heads/main",
          name: "core",
          url: "https://***:***@example.invalid/core.git",
          parent_repository_id: repositoryId,
          child_root_path: "C:/project/modules/core",
          initialized: true,
        }],
      }))
      .mockImplementation(async () => jsonResponse({
        operation_id: "submodule-op",
        repository_id: repositoryId,
        repository_version: "v-next",
        state: "succeeded",
        summary: "submodule update",
        result: {},
      }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await expect(runtime.submodules(scope)).resolves.toMatchObject({ submodules: [{ path: "modules/core", parentRepositoryId: repositoryId }] });
    await runtime.submoduleAction({
      ...scope,
      idempotencyKey: "submodule-update-key",
      action: "update",
      paths: ["modules/core"],
      recursive: true,
      force: false,
    });
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      action: "update",
      paths: ["modules/core"],
      recursive: true,
      force: false,
    });
  });

  it("normalizes worktree scope and maps exact grants plus typed lifecycle actions", async () => {
    const externalPath = "D:/worktrees/topic";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        repository_version: "v-worktree",
        worktrees: [{
          path: externalPath,
          head: "a".repeat(40),
          branch: "refs/heads/topic",
          bare: false,
          detached: false,
          locked_reason: null,
          prunable_reason: null,
          primary: false,
          authorized: true,
          authorization_required: true,
          dirty: false,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        workspace_id: scope.workspaceId,
        project_root: scope.projectRoot,
        parent_repository_id: repositoryId,
        worktree_path: externalPath,
        scope: "git_worktree",
      }))
      .mockResolvedValueOnce(jsonResponse({ revoked: true }))
      .mockResolvedValueOnce(jsonResponse({
        operation_id: "worktree-op",
        repository_id: repositoryId,
        repository_version: "v-next",
        state: "succeeded",
        summary: "worktree add",
        result: {},
      }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    await expect(runtime.worktrees(scope)).resolves.toMatchObject({
      worktrees: [{ path: externalPath, authorizationRequired: true, authorized: true }],
    });
    await expect(runtime.authorizeWorktree({ ...scope, worktreePath: externalPath })).resolves.toMatchObject({
      parentRepositoryId: repositoryId,
      worktreePath: externalPath,
    });
    await expect(runtime.revokeWorktree({ ...scope, worktreePath: externalPath })).resolves.toBe(true);
    await runtime.worktreeAction({
      ...scope,
      idempotencyKey: "worktree-add-key",
      action: "add",
      worktreePath: externalPath,
      revision: "HEAD",
      newBranch: "topic",
      detach: false,
      force: false,
      dirtyConfirmed: false,
    });

    expect(fetcher.mock.calls[0][0]).toContain("/worktrees?workspace_id=workspace-a");
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      repository_id: repositoryId,
      worktree_path: externalPath,
    });
    expect(JSON.parse(String((fetcher.mock.calls[3][1] as RequestInit).body))).toMatchObject({
      action: "add",
      worktree_path: externalPath,
      revision: "HEAD",
      new_branch: "topic",
      dirty_confirmed: false,
    });
  });

  it("normalizes Git LFS status and maps fetch, pull, and push without install commands", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        repository_version: "v-lfs",
        available: true,
        reason: null,
        tracked_patterns: ["*.bin"],
        files: [{ path: "asset.bin", object_id: "sha256:abc", size: 4096, status: "tracked" }],
        locks: [{ id: "lock-1", path: "asset.bin", owner: "Ada", locked_at: "2026-07-16T00:00:00Z" }],
        locks_available: true,
      }))
      .mockImplementation(async () => jsonResponse({
        operation_id: "lfs-op",
        repository_id: repositoryId,
        repository_version: "v-lfs-next",
        state: "succeeded",
        summary: "lfs action",
        result: {},
      }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await expect(runtime.lfs(scope)).resolves.toMatchObject({
      available: true,
      trackedPatterns: ["*.bin"],
      files: [{ path: "asset.bin", size: 4096 }],
      locks: [{ owner: "Ada" }],
    });
    await runtime.lfsAction({ ...scope, idempotencyKey: "lfs-fetch", action: "fetch", remote: "origin", refspec: "main" });
    await runtime.lfsAction({ ...scope, idempotencyKey: "lfs-pull", action: "pull", remote: "origin", refspec: null });
    await runtime.lfsAction({ ...scope, idempotencyKey: "lfs-push", action: "push", remote: "origin", refspec: "main" });
    expect(fetcher.mock.calls.slice(1).map((call) => JSON.parse(String((call[1] as RequestInit).body)))).toEqual([
      expect.objectContaining({ action: "fetch", remote: "origin", refspec: "main" }),
      expect.objectContaining({ action: "pull", remote: "origin", refspec: null }),
      expect.objectContaining({ action: "push", remote: "origin", refspec: "main" }),
    ]);
    expect(fetcher.mock.calls.every((call) => !String(call[0]).includes("install"))).toBe(true);
  });

  it("fans out versioned metadata events and exposes git on RuntimeBridge", () => {
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher: vi.fn() }));
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    expect(runtime.acceptEvent("other", {})).toBe(false);
    expect(runtime.acceptEvent("gitMetadataChanged", {
      repository_id: repositoryId,
      repository_version: "v2",
      sequence: 2,
      domains: ["status"],
      paths: ["index"],
      resync_required: false,
    })).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ repositoryId, sequence: 2 }));
    unsubscribe();
    expect(createRuntimeBridge({ httpClient: new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher: vi.fn() }) }).git).toBeDefined();
  });

  it("maps repository initialization and Git-only ancestor authorization", async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/ancestor-grants")) return jsonResponse({ scope: "git_only" });
      return jsonResponse({
        capability: {
          available: true,
          executable: "git",
          version: "2.50.0",
          supports_switch: true,
          supports_restore: true,
          supports_pathspec_from_file: true,
          lfs_available: false,
        },
        repositories: [],
        ancestor_candidate: null,
      });
    });
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await runtime.initialize({ workspaceId: "workspace-a", projectRoot: "C:/project" });
    await runtime.authorizeAncestor({
      workspaceId: "workspace-a",
      projectRoot: "C:/project/child",
      repositoryId,
      repositoryRoot: "C:/project",
    });

    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:8765/api/git/repositories/init");
    expect(fetcher.mock.calls[1][0]).toBe("http://127.0.0.1:8765/api/git/repositories/ancestor-grants");
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      repository_id: repositoryId,
      repository_root: "C:/project",
    });
  });

  it("reads and updates repository-local Git identity", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        name: "Keydex User",
        email: "keydex@example.com",
        sign_by_default: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        name: "Keydex Maintainer",
        email: "maintainer@example.com",
        sign_by_default: true,
      }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));

    await expect(runtime.identity(scope)).resolves.toMatchObject({
      repositoryId,
      name: "Keydex User",
      signByDefault: false,
    });
    await expect(runtime.updateIdentity({
      ...scope,
      name: "Keydex Maintainer",
      email: "maintainer@example.com",
      signByDefault: true,
    })).resolves.toMatchObject({ signByDefault: true });

    expect(fetcher.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8765/api/git/repositories/git-test/identity?workspace_id=workspace-a&project_root=C%3A%2Fproject",
    );
    const [updateUrl, updateInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(updateUrl).toBe("http://127.0.0.1:8765/api/git/repositories/git-test/identity");
    expect(updateInit.method).toBe("PUT");
    expect(JSON.parse(String(updateInit.body))).toEqual({
      workspace_id: "workspace-a",
      project_root: "C:/project",
      repository_id: repositoryId,
      name: "Keydex Maintainer",
      email: "maintainer@example.com",
      sign_by_default: true,
    });
  });

  it("reads redacted remote metadata and maps typed remote CRUD", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        repository_id: repositoryId,
        repository_version: "v1",
        remotes: [{ name: "origin", fetch_url: "D:/fetch.git", push_url: "D:/push.git", tracking_branches: ["main"] }],
      }))
      .mockImplementation(async () => jsonResponse({
        operation_id: "op-remote",
        repository_id: repositoryId,
        repository_version: "v2",
        state: "succeeded",
        summary: "remote",
        result: {},
      }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await expect(runtime.remotes(scope)).resolves.toEqual([{
      name: "origin",
      fetchUrl: "D:/fetch.git",
      pushUrl: "D:/push.git",
      trackingBranches: ["main"],
    }]);
    await runtime.addRemote({ ...scope, idempotencyKey: "remote-add-key", remoteName: "upstream", url: "D:/upstream.git" });
    await runtime.renameRemote({ ...scope, idempotencyKey: "remote-rename-key", oldName: "upstream", newName: "source" });
    await runtime.setRemoteUrl({ ...scope, idempotencyKey: "remote-url-key", remoteName: "source", url: "D:/push.git", push: true });
    await runtime.removeRemote({ ...scope, idempotencyKey: "remote-remove-key", remoteName: "source", confirmationToken: "confirmed" });
    await runtime.setUpstream({ ...scope, idempotencyKey: "upstream-key", branchName: "main", upstream: "origin/main" });
    await runtime.fetch({ ...scope, idempotencyKey: "fetch-key", remote: null, allRemotes: true, prune: true, tags: true });
    await runtime.update({ ...scope, idempotencyKey: "update-key", remote: "origin", refspec: "main", strategy: "rebase" });
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({ remote_name: "upstream", url: "D:/upstream.git" });
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body))).toMatchObject({ old_name: "upstream", new_name: "source" });
    expect(JSON.parse(String((fetcher.mock.calls[3][1] as RequestInit).body))).toMatchObject({ remote_name: "source", push: true });
    expect(JSON.parse(String((fetcher.mock.calls[5][1] as RequestInit).body))).toMatchObject({
      branch_name: "main",
      upstream: "origin/main",
    });
    expect(JSON.parse(String((fetcher.mock.calls[6][1] as RequestInit).body))).toMatchObject({
      remote: null,
      all_remotes: true,
      prune: true,
      tags: true,
    });
    expect(JSON.parse(String((fetcher.mock.calls[7][1] as RequestInit).body))).toMatchObject({
      remote: "origin",
      refspec: "main",
      strategy: "rebase",
    });
  });

  it("maps paged stash identity and detail diffs", async () => {
    const stash = {
      selector: "stash@{0}",
      object_id: "a".repeat(40),
      base_object_id: "b".repeat(40),
      author_name: "Keydex",
      created_at: "2026-07-16T02:00:00+08:00",
      message: "On main: work",
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ repository_id: repositoryId, repository_version: "v1", entries: [stash], next_cursor: "cursor-2" }))
      .mockResolvedValueOnce(jsonResponse({ repository_id: repositoryId, repository_version: "v1", entry: stash, files: [{ old_path: "a.ts", new_path: "a.ts", status: "modified", binary: false, old_mode: null, new_mode: null, additions: 1, deletions: 0, hunks: [], raw_patch: "diff --git", truncated: false }] }))
      .mockImplementation(async () => jsonResponse({ operation_id: "stash-operation", repository_id: repositoryId, repository_version: "v2", state: "succeeded", summary: "stash", result: {} }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const page = await runtime.stashList(scope, { cursor: "cursor-1", limit: 1 });
    expect(page.entries[0]).toMatchObject({ selector: "stash@{0}", objectId: "a".repeat(40), baseObjectId: "b".repeat(40) });
    expect(page.nextCursor).toBe("cursor-2");
    const detail = await runtime.stashDetail(scope, page.entries[0].selector, page.entries[0].objectId);
    expect(detail.files[0]).toMatchObject({ newPath: "a.ts", additions: 1 });
    expect(fetcher.mock.calls[0][0]).toContain("cursor=cursor-1");
    expect(fetcher.mock.calls[1][0]).toContain("selector=stash%40%7B0%7D");
    expect(fetcher.mock.calls[1][0]).toContain(`object_id=${"a".repeat(40)}`);
    await runtime.createStash({ ...scope, idempotencyKey: "stash-create-key", message: "save", staged: false, includeUntracked: true });
    await runtime.applyStash({ ...scope, idempotencyKey: "stash-apply-key", selector: stash.selector, objectId: page.entries[0].objectId, reinstateIndex: true });
    await runtime.popStash({ ...scope, idempotencyKey: "stash-pop-key", selector: stash.selector, objectId: page.entries[0].objectId });
    await runtime.branchFromStash({ ...scope, idempotencyKey: "stash-branch-key", selector: stash.selector, objectId: page.entries[0].objectId, branchName: "stash/recovery" });
    await runtime.dropStash({ ...scope, idempotencyKey: "stash-drop-key", selector: stash.selector, objectId: page.entries[0].objectId, confirmationToken: "confirmed" });
    await runtime.clearStashes({ ...scope, idempotencyKey: "stash-clear-key", confirmationToken: "confirmed" });
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body))).toMatchObject({ message: "save", staged: false, include_untracked: true });
    expect(JSON.parse(String((fetcher.mock.calls[3][1] as RequestInit).body))).toMatchObject({ selector: "stash@{0}", object_id: "a".repeat(40), reinstate_index: true });
    expect(JSON.parse(String((fetcher.mock.calls[5][1] as RequestInit).body))).toMatchObject({ branch_name: "stash/recovery" });
    expect(fetcher.mock.calls[7][0]).toContain("/stash/clear");
  });

  it("serializes restore destinations without leaking stash-only fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      operation_id: "restore-operation",
      repository_id: repositoryId,
      repository_version: "v2",
      state: "succeeded",
      summary: "restore",
      result: {},
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    await runtime.restore({
      ...scope,
      idempotencyKey: "restore-key",
      confirmationToken: "confirmed",
      paths: ["a.txt"],
      source: "HEAD",
      staged: false,
      worktree: true,
    });
    const payload = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(payload).toMatchObject({
      paths: ["a.txt"],
      source: "HEAD",
      staged: false,
      worktree: true,
    });
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("include_untracked");
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
