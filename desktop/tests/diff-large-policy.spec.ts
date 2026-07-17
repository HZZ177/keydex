import { describe, expect, it } from "vitest";

import {
  DIFF_MAIN_THREAD_MAX_BYTES,
  DIFF_MAIN_THREAD_MAX_LINES,
  DIFF_RESPONSIVE_TARGET_BYTES,
  DIFF_RESPONSIVE_TARGET_LINES,
  resolveLargeDiffPolicy,
} from "@/renderer/components/diff/largeDiffPolicy";
import { createKeydexDiffFile, type KeydexDiffTruncation } from "@/renderer/components/diff/model";

const complete: KeydexDiffTruncation = {
  state: "complete",
  reason: null,
  canLoadMore: false,
  continuationToken: null,
  loadedBytes: null,
  totalBytes: null,
  loadedLines: null,
  totalLines: null,
};

describe("large diff policy", () => {
  it("keeps values immediately below both thresholds on the main thread", () => {
    expect(resolveLargeDiffPolicy({
      bytes: DIFF_MAIN_THREAD_MAX_BYTES - 1,
      lines: DIFF_MAIN_THREAD_MAX_LINES - 1,
      workerAvailable: false,
      truncation: complete,
    }).strategy).toBe("main_thread");
  });

  it.each([
    [DIFF_MAIN_THREAD_MAX_BYTES, 1],
    [1, DIFF_MAIN_THREAD_MAX_LINES],
    [DIFF_RESPONSIVE_TARGET_BYTES, DIFF_RESPONSIVE_TARGET_LINES],
  ])("uses a worker at the byte/line and acceptance boundaries", (bytes, lines) => {
    expect(resolveLargeDiffPolicy({ bytes, lines, workerAvailable: true })).toMatchObject({
      strategy: "worker",
      requiresWorker: true,
      renderText: true,
      allowPatchSelection: true,
    });
  });

  it("does not fall back to blocking main-thread rendering when the worker is unavailable", () => {
    expect(resolveLargeDiffPolicy({
      bytes: DIFF_RESPONSIVE_TARGET_BYTES,
      lines: DIFF_RESPONSIVE_TARGET_LINES,
      workerAvailable: false,
    })).toMatchObject({
      strategy: "worker_unavailable",
      renderText: false,
      allowPatchSelection: false,
      message: "差异内容较大，需要后台解析服务；当前服务不可用。",
    });
  });

  it.each([
    ["recoverable", true, "truncated_recoverable"],
    ["unrecoverable", false, "truncated_unrecoverable"],
  ] as const)("models %s producer truncation explicitly", (state, canLoadMore, strategy) => {
    expect(resolveLargeDiffPolicy({
      bytes: 10,
      lines: 1,
      workerAvailable: true,
      truncation: {
        ...complete,
        state,
        reason: "producer_limit",
        canLoadMore,
        continuationToken: canLoadMore ? "next-page" : null,
      },
    })).toMatchObject({ strategy, renderText: false, allowPatchSelection: false, canLoadMore });
  });

  it("derives the compatibility truncated flag and blocks selection from the detailed contract", () => {
    const file = createKeydexDiffFile({
      id: "large-file",
      oldPath: "large.ts",
      newPath: "large.ts",
      status: "modified",
      patch: "@@ -1 +1 @@\n-a\n+b\n",
      cacheKey: "large-cache",
      truncation: {
        ...complete,
        state: "recoverable",
        reason: "producer_limit",
        canLoadMore: true,
        continuationToken: "cursor",
      },
    });
    expect(file).toMatchObject({ truncated: true, selectableForPatch: false });
    expect(file.truncation).toMatchObject({ state: "recoverable", continuationToken: "cursor" });
  });

  it("rejects contradictory and negative contracts", () => {
    expect(() => resolveLargeDiffPolicy({ bytes: -1, lines: 0, workerAvailable: true })).toThrow();
    expect(() => createKeydexDiffFile({
      id: "invalid",
      oldPath: "a.ts",
      newPath: "a.ts",
      status: "modified",
      patch: "",
      cacheKey: "invalid-cache",
      truncation: { ...complete, state: "recoverable", reason: "producer_limit" },
    })).toThrow(/must allow loading more/u);
  });
});
