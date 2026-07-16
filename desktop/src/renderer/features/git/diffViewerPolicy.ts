export type GitDiffViewerEngine = "keydex-native" | "git-diff-view";

export interface GitDiffViewerPolicy {
  engine: GitDiffViewerEngine;
  packageName?: string;
  packageVersion?: string;
  loadStrategy: "bundled" | "lazy-adapter";
  reason: string;
  fallback: GitDiffViewerEngine | null;
}

/**
 * Keep the third-party renderer behind one decision point. The initial Git
 * workbench uses a Keydex-owned view model and renderer because the evaluated
 * LiveAgent dependency is pre-1.0, introduces a second styling system, and has
 * no existing accessibility/theme integration in this repository.
 */
export const GIT_DIFF_VIEWER_POLICY: GitDiffViewerPolicy = {
  engine: "keydex-native",
  loadStrategy: "bundled",
  reason:
    "@git-diff-view/react 0.1.3 is pre-1.0 and requires foreign global CSS; use the Keydex domain model and renderer until an isolated adapter passes theme, accessibility, bundle, and maintenance gates.",
  fallback: null,
};

export function resolveGitDiffViewerEngine(
  requested: GitDiffViewerEngine | undefined,
  thirdPartyAdapterAvailable: boolean,
): GitDiffViewerEngine {
  if (requested === "git-diff-view" && thirdPartyAdapterAvailable) return requested;
  return GIT_DIFF_VIEWER_POLICY.engine;
}
