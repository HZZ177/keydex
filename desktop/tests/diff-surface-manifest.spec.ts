import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DIFF_INVENTORY_BASELINE,
  DIFF_SURFACE_INVENTORY,
} from "@/renderer/components/diff/diffSurfaceManifest";

const desktopRoot = process.cwd();

describe("Diff surface inventory", () => {
  it("freezes the complete Review inventory with stable unique ids", () => {
    expect(DIFF_INVENTORY_BASELINE.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(DIFF_INVENTORY_BASELINE.scanCommands).toHaveLength(3);

    const ids = DIFF_SURFACE_INVENTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "git-worktree-unstaged",
      "git-index-staged",
      "git-stash-detail",
      "git-patch-export",
      "conversation-file-change",
      "tool-call-file-change",
      "agent-review-panel",
      "workbench-review-drawer",
      "workbench-review-overlay",
      "reverse-preview",
      "explicit-diff-preview",
      "content-diff-preview",
      "patch-file-preview",
      "commit-compare-audit",
      "git-three-way-conflict-editor",
      "markdown-inline-diff-code",
      "non-diff-graph-and-text",
    ]);
  });

  it("keeps every owner, decision and referenced path machine-verifiable", () => {
    for (const entry of DIFF_SURFACE_INVENTORY) {
      expect(["viewer", "adjacent"]).toContain(entry.kind);
      expect(["migrate", "retain"]).toContain(entry.decision);
      expect(["git", "conversation", "workspace", "history", "platform"]).toContain(
        entry.owner,
      );
      expect(entry.rendererPaths.length).toBeGreaterThan(0);
      expect(entry.producerPaths.length).toBeGreaterThan(0);
      expect(entry.testPaths.length).toBeGreaterThan(0);
      expect(entry.notes.trim()).not.toBe("");
      expect(["default", "responsive", "disabled", "retain"]).toContain(
        entry.alignedDecision,
      );
      expect(["full", "embedded", "overlay", "adjacent"]).toContain(entry.container);
      expect(["contain", "parent_at_edge", "host", "retain"]).toContain(
        entry.scrollChaining,
      );
      expect(entry.testOwner).toMatch(/^ASD-\d{3}$/);

      if (entry.kind === "viewer") {
        expect(["compact", "review", "git", "preview"]).toContain(entry.profile);
        expect(["stacked", "split"]).toContain(entry.defaultLayout);
      } else {
        expect(entry.profile).toBeNull();
        expect(entry.defaultLayout).toBeNull();
        expect(entry.alignedDecision).toBe("retain");
      }

      for (const path of [
        ...entry.rendererPaths,
        ...entry.producerPaths,
        ...entry.stylePaths,
        ...entry.testPaths,
      ]) {
        expect(existsSync(resolve(desktopRoot, path)), `${entry.id}: ${path}`).toBe(true);
      }
    }
  });

  it("closes every temporary audit decision", () => {
    expect(DIFF_SURFACE_INVENTORY.every((entry) => entry.decision === "migrate" || entry.decision === "retain")).toBe(true);
  });

  it("freezes aligned split enablement without expanding retained surfaces", () => {
    const byId = new Map(DIFF_SURFACE_INVENTORY.map((entry) => [entry.id, entry]));

    expect(byId.get("git-worktree-unstaged")?.alignedDecision).toBe("default");
    expect(byId.get("git-index-staged")?.alignedDecision).toBe("default");
    expect(byId.get("conversation-file-change")?.alignedDecision).toBe("disabled");
    expect(byId.get("agent-review-panel")?.alignedDecision).toBe("disabled");
    expect(byId.get("workbench-review-drawer")?.alignedDecision).toBe("responsive");
    expect(byId.get("explicit-diff-preview")?.alignedDecision).toBe("responsive");

    expect(
      DIFF_SURFACE_INVENTORY.filter((entry) => entry.decision === "retain").every(
        (entry) => entry.alignedDecision === "retain",
      ),
    ).toBe(true);
  });
});
