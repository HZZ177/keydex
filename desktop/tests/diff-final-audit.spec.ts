import { describe, expect, it } from "vitest";

// @ts-ignore The repository's broad *.mjs declaration only describes the MCP harness exports.
import { auditDiffFinalEntries } from "../tools/diff-final-audit.mjs";

const packageText = JSON.stringify({ dependencies: { "@pierre/diffs": "1.2.12" } });
const lockText = "  '@pierre/diffs@1.2.12':\n";

describe("final unified Diff source audit", () => {
  it("accepts Pierre imports only inside the unified boundary", () => {
    const report = auditDiffFinalEntries([
      {
        path: "src/renderer/components/diff/engine/PierrePatchDiff.tsx",
        source: 'import { PatchDiff } from "@pierre/diffs/react";',
      },
      {
        path: "src/renderer/pages/conversation/FileChange.tsx",
        source: 'import { CompactDiffView } from "@/renderer/components/diff/wrappers/CompactDiffView";',
      },
    ], packageText, lockText);
    expect(report.violations).toEqual([]);
  });

  it("fails closed for old renderers, temporary gates, competing packages and boundary leaks", () => {
    const report = auditDiffFinalEntries([
      {
        path: "src/renderer/pages/conversation/OldDiff.tsx",
        source: 'import { PatchDiff } from "@pierre/diffs/react"; const view = GitDiffViewer; const gate = "keydex-native";',
      },
      {
        path: "src/renderer/components/review/OldRows.tsx",
        source: "const rows = fileReviewDisplayLines; const marker = 'data-diff-migration';",
      },
    ], JSON.stringify({ dependencies: { "@pierre/diffs": "^1.2.12", "git-diff-view": "1.0.0" } }), "");
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "old_git_viewer" }),
      expect.objectContaining({ code: "old_review_projection" }),
      expect.objectContaining({ code: "old_engine_flag" }),
      expect.objectContaining({ code: "temporary_marker" }),
      expect.objectContaining({ code: "pierre_boundary" }),
      expect.objectContaining({ code: "pierre_version" }),
      expect.objectContaining({ code: "competing_dependency" }),
      expect.objectContaining({ code: "lock_versions" }),
    ]));
  });
});
