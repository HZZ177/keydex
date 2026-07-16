export const GIT_HISTORY_PAGE_SIZE = 200;
// Keep the DOM bounded for the 300-file repositories used by the real-repository
// acceptance suite, while avoiding virtualization overhead for ordinary changesets.
export const GIT_CHANGES_VIRTUALIZATION_THRESHOLD = 100;
export const GIT_HISTORY_VIRTUALIZATION_THRESHOLD = 500;
export const GIT_DIFF_WORKER_THRESHOLD_BYTES = 2 * 1024 * 1024;
export const GIT_GRAPH_WORKER_THRESHOLD_NODES = 20_000;

export type GitToolWindowResponsiveLayout = "compact" | "standard" | "wide" | "ultrawide";

export function gitToolWindowResponsiveLayout(width: number): GitToolWindowResponsiveLayout {
  if (width < 720) return "compact";
  if (width < 1600) return "standard";
  if (width < 2560) return "wide";
  return "ultrawide";
}

export interface GitPerformanceInput {
  changeCount: number;
  commitCount: number;
  diffBytes: number;
  graphNodes: number;
}

export function gitPerformancePolicy(input: GitPerformanceInput) {
  return {
    paginateHistory: input.commitCount > GIT_HISTORY_PAGE_SIZE,
    virtualizeChanges: input.changeCount > GIT_CHANGES_VIRTUALIZATION_THRESHOLD,
    virtualizeHistory: input.commitCount > GIT_HISTORY_VIRTUALIZATION_THRESHOLD,
    offloadDiffParsing: input.diffBytes >= GIT_DIFF_WORKER_THRESHOLD_BYTES,
    offloadGraphLayout: input.graphNodes >= GIT_GRAPH_WORKER_THRESHOLD_NODES,
  } as const;
}
