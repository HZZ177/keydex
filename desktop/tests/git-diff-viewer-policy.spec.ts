import { describe, expect, it } from "vitest";

import {
  GIT_DIFF_VIEWER_POLICY,
  resolveGitDiffViewerEngine,
} from "@/renderer/features/git/diffViewerPolicy";

describe("Git diff viewer dependency policy", () => {
  it("keeps the initial renderer Keydex-owned", () => {
    expect(GIT_DIFF_VIEWER_POLICY.engine).toBe("keydex-native");
    expect(GIT_DIFF_VIEWER_POLICY.reason).toContain("@git-diff-view/react 0.1.3");
    expect(GIT_DIFF_VIEWER_POLICY.reason).toContain("accessibility");
  });

  it("does not silently select an unavailable experimental adapter", () => {
    expect(resolveGitDiffViewerEngine("git-diff-view", false)).toBe("keydex-native");
    expect(resolveGitDiffViewerEngine("git-diff-view", true)).toBe("git-diff-view");
  });
});
