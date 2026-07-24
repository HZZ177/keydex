import { describe, expect, it, vi } from "vitest";

import {
  checkoutIntentForRef,
  requiresSmartCheckout,
  runCheckoutIntent,
  runSmartCheckout,
} from "@/renderer/features/git/smartCheckout";
import type { GitRuntime, GitStashEntry } from "@/runtime/git";
import type {
  GitCommandResult,
  GitObjectId,
  GitRef,
  GitRepositoryId,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";

const repositoryId = "repo-1" as GitRepositoryId;
const repositoryVersion = "version-1" as GitRepositoryVersion;
const scope = {
  workspaceId: "workspace-1",
  projectRoot: "D:/repo",
  repositoryId,
};

describe("Smart Checkout policy", () => {
  it("creates a tracking branch for a remote ref and reuses an existing local branch", async () => {
    const remote = ref("remote", "origin/release/next");
    const trackingIntent = checkoutIntentForRef(remote, [remote]);
    expect(trackingIntent).toEqual({
      kind: "track_remote",
      label: "origin/release/next",
      remoteRef: "origin/release/next",
      localBranch: "release/next",
    });

    const createBranch = vi.fn().mockResolvedValue(operation("create_branch"));
    const runtime = { createBranch } as unknown as GitRuntime;
    await runCheckoutIntent({
      runtime,
      runCommand: (submit) => submit(),
      scope,
      intent: trackingIntent,
      expectedRepositoryVersion: repositoryVersion,
      idempotencyKey: "checkout-tracking-key",
    });
    expect(createBranch).toHaveBeenCalledWith(expect.objectContaining({
      branchName: "release/next",
      startPoint: "origin/release/next",
      track: true,
    }));

    const local = { ...ref("local", "release/next"), upstream: "origin/release/next" };
    expect(checkoutIntentForRef(remote, [local, remote])).toEqual({
      kind: "switch",
      label: "release/next",
      ref: "release/next",
      detach: false,
    });
  });

  it("keeps tags detached and only offers Smart Checkout for overwrite conflicts", () => {
    expect(checkoutIntentForRef(ref("tag", "v1.0.0"), [])).toEqual({
      kind: "switch",
      label: "v1.0.0",
      ref: "v1.0.0",
      detach: true,
    });
    expect(requiresSmartCheckout(operation("checkout", "failed", "git_checkout_conflict"))).toBe(true);
    expect(requiresSmartCheckout(operation("checkout", "failed", "git_failed"))).toBe(false);
  });

  it("restores and removes exactly the temporary stash after switching", async () => {
    const stash = stashEntry("stash@{2}", "a");
    const runtime = smartRuntime({
      stash,
      checkout: operation("create_branch"),
      restore: operation("stash_pop"),
    });

    const result = await runSmartCheckout({
      runtime,
      runCommand: (submit) => submit(),
      scope,
      intent: {
        kind: "track_remote",
        label: "origin/release/next",
        remoteRef: "origin/release/next",
        localBranch: "release/next",
      },
      expectedRepositoryVersion: repositoryVersion,
      createIdempotencyKey: sequenceKey(),
    });

    expect(result.state).toBe("succeeded");
    expect(runtime.createStash).toHaveBeenCalledWith(expect.objectContaining({
      includeUntracked: true,
      message: expect.stringContaining("key-smart-checkout-1"),
    }));
    expect(runtime.createBranch).toHaveBeenCalledWith(expect.objectContaining({
      branchName: "release/next",
      track: true,
      expectedRepositoryVersion: null,
    }));
    expect(runtime.popStash).toHaveBeenCalledWith(expect.objectContaining({
      selector: "stash@{2}",
      objectId: stash.objectId,
      reinstateIndex: true,
    }));
  });

  it("retains the exact stash when switching or restoring fails", async () => {
    const stash = stashEntry("stash@{0}", "b");
    const checkoutFailure = operation("checkout", "failed", "git_failed");
    const checkoutRuntime = smartRuntime({
      stash,
      checkout: checkoutFailure,
      restore: operation("stash_pop"),
    });
    const checkoutResult = await runSmartCheckout({
      runtime: checkoutRuntime,
      runCommand: (submit) => submit(),
      scope,
      intent: { kind: "switch", label: "feature/next", ref: "feature/next", detach: false },
      expectedRepositoryVersion: repositoryVersion,
      createIdempotencyKey: sequenceKey(),
    });
    expect(checkoutResult).toMatchObject({
      state: "failed",
      stage: "checkout",
      stash: { selector: "stash@{0}", objectId: stash.objectId },
    });
    expect(checkoutRuntime.popStash).not.toHaveBeenCalled();

    const restoreRuntime = smartRuntime({
      stash,
      checkout: operation("checkout"),
      restore: operation("stash_pop", "failed", "git_failed"),
    });
    const restoreResult = await runSmartCheckout({
      runtime: restoreRuntime,
      runCommand: (submit) => submit(),
      scope,
      intent: { kind: "switch", label: "feature/next", ref: "feature/next", detach: false },
      expectedRepositoryVersion: repositoryVersion,
      createIdempotencyKey: sequenceKey(),
    });
    expect(restoreResult).toMatchObject({
      state: "failed",
      stage: "restore",
      stash: { selector: "stash@{0}", objectId: stash.objectId },
    });
  });
});

function smartRuntime({
  stash,
  checkout,
  restore,
}: {
  stash: GitStashEntry;
  checkout: GitCommandResult;
  restore: GitCommandResult;
}) {
  return {
    createStash: vi.fn().mockResolvedValue(operation("stash_push")),
    stashList: vi.fn().mockImplementation(async () => ({
      repositoryId,
      repositoryVersion,
      entries: [{ ...stash, message: "On main: key-smart-checkout-1：临时储藏" }],
      nextCursor: null,
    })),
    createBranch: vi.fn().mockResolvedValue(checkout),
    checkout: vi.fn().mockResolvedValue(checkout),
    popStash: vi.fn().mockResolvedValue(restore),
  } as unknown as GitRuntime;
}

function sequenceKey() {
  let index = 0;
  return (action: string) => {
    index += 1;
    return `key-${action}-${index}`;
  };
}

function stashEntry(selector: string, seed: string): GitStashEntry {
  return {
    selector,
    objectId: seed.repeat(40) as GitObjectId,
    baseObjectId: null,
    authorName: "Alice",
    createdAt: "2026-07-24T00:00:00Z",
    message: "",
  };
}

function ref(kind: GitRef["kind"], shortName: string): GitRef {
  const prefix = kind === "local"
    ? "refs/heads/"
    : kind === "remote"
      ? "refs/remotes/"
      : "refs/tags/";
  return {
    fullName: `${prefix}${shortName}`,
    shortName,
    kind,
    objectId: "c".repeat(40) as GitObjectId,
    peeledObjectId: null,
    upstream: null,
    ahead: null,
    behind: null,
    current: false,
  };
}

function operation(
  command: string,
  state: GitCommandResult["state"] = "succeeded",
  errorCode?: string,
): GitCommandResult {
  return {
    operationId: `${command}-operation`,
    repositoryId,
    repositoryVersion,
    state,
    summary: command,
    result: {},
    command,
    risk: "write",
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    retryable: false,
    error: errorCode ? {
      code: errorCode,
      message: errorCode,
      retryable: false,
      details: {},
    } : null,
  };
}
