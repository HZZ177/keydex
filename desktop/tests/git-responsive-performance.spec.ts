import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GIT_HISTORY_PAGE_SIZE,
  gitPerformancePolicy,
  gitToolWindowResponsiveLayout,
} from "@/renderer/features/git/performancePolicy";

describe("Git responsive and performance budgets", () => {
  it("defines usable 1280, 1920 and ultrawide layout bands", () => {
    expect(gitToolWindowResponsiveLayout(520)).toBe("compact");
    expect(gitToolWindowResponsiveLayout(1280)).toBe("standard");
    expect(gitToolWindowResponsiveLayout(1920)).toBe("wide");
    expect(gitToolWindowResponsiveLayout(3440)).toBe("ultrawide");

    const css = readFileSync(resolve(process.cwd(), "src/renderer/features/git/components/GitToolWindow.module.css"), "utf8");
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("@container (max-width: 560px)");
    expect(css).toContain("@container (min-width: 1600px)");
  });

  it("centralizes pagination, virtualization and worker candidate thresholds", () => {
    expect(GIT_HISTORY_PAGE_SIZE).toBe(200);
    expect(gitPerformancePolicy({ changeCount: 5_000, commitCount: 10_000, diffBytes: 2 * 1024 * 1024, graphNodes: 20_000 })).toEqual({
      paginateHistory: true,
      virtualizeChanges: true,
      virtualizeHistory: true,
      offloadDiffParsing: true,
      offloadGraphLayout: true,
    });
    expect(gitPerformancePolicy({ changeCount: 2, commitCount: 20, diffBytes: 64, graphNodes: 10 })).toEqual({
      paginateHistory: false,
      virtualizeChanges: false,
      virtualizeHistory: false,
      offloadDiffParsing: false,
      offloadGraphLayout: false,
    });
  });
});
