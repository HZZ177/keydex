import { describe, expect, it, vi } from "vitest";

import { createKeydexDiffDocument, createKeydexDiffFile } from "@/renderer/components/diff/model";
import {
  KEYDEX_DIFF_PROFILES,
  KeydexDiffProfileError,
  resolveKeydexDiffProfile,
  type KeydexDiffProfileName,
} from "@/renderer/components/diff/profiles";

const document = createKeydexDiffDocument({
  id: "document:shared",
  source: "preview",
  sourceVersion: "v1",
  files: [
    createKeydexDiffFile({
      id: "file:shared",
      cacheKey: "cache:shared",
      oldPath: "src/shared.ts",
      newPath: "src/shared.ts",
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    }),
  ],
});

describe("Keydex Diff profile contracts", () => {
  it("defines exhaustive product defaults rather than third-party props", () => {
    expect(Object.keys(KEYDEX_DIFF_PROFILES)).toEqual(["compact", "review", "git", "preview"]);
    expect(KEYDEX_DIFF_PROFILES.compact).toEqual(
      expect.objectContaining({ defaultLayout: "stacked", defaultWrap: true, density: "compact" }),
    );
    expect(KEYDEX_DIFF_PROFILES.review.allowedLayouts).toEqual(["stacked", "split"]);
    expect(KEYDEX_DIFF_PROFILES.git).toEqual(
      expect.objectContaining({ selection: "git_patch", defaultLayout: "split", defaultWrap: false }),
    );
    expect(KEYDEX_DIFF_PROFILES.preview.allowedLayouts).toEqual(["stacked", "split"]);
    expect(KEYDEX_DIFF_PROFILES.compact).toEqual(expect.objectContaining({
      alignedSplit: false,
      connector: false,
      syncScroll: false,
      hunkNavigation: false,
      scrollChaining: "parent_at_edge",
      hunkActions: [],
    }));
    for (const profile of ["review", "git", "preview"] as const) {
      expect(KEYDEX_DIFF_PROFILES[profile]).toEqual(expect.objectContaining({
        alignedSplit: true,
        connector: true,
        syncScroll: true,
        hunkNavigation: true,
        hunkActions: ["navigate", "copy"],
      }));
    }
  });

  it("changes only shell capabilities when every profile receives the same document", () => {
    const profiles: KeydexDiffProfileName[] = ["compact", "review", "git", "preview"];
    const resolved = profiles.map((name) => resolveKeydexDiffProfile(name));

    expect(resolved.map(({ profile }) => profile.name)).toEqual(profiles);
    expect(resolved.every(({ readOnly }) => readOnly)).toBe(true);
    expect(document.files[0]?.displayPath).toBe("src/shared.ts");
    expect(document.files[0]?.patch).toContain("+new");
  });

  it("enables only explicitly injected product actions", () => {
    const applyPatches = vi.fn();
    const readOnlyGit = resolveKeydexDiffProfile("git", { openFile: vi.fn() });
    const writableGit = resolveKeydexDiffProfile("git", {
      copyPatch: vi.fn(),
      git: { mode: "stage", applyPatches },
    });

    expect(readOnlyGit.enabledActions).not.toContain("apply_git_patch");
    expect(readOnlyGit.readOnly).toBe(true);
    expect(writableGit.enabledActions).toContain("apply_git_patch");
    expect(writableGit.enabledActions).toEqual(expect.arrayContaining([
      "toggle_sync_scroll",
      "navigate_changes",
    ]));
    expect(writableGit.readOnly).toBe(false);
    expect(writableGit.actions.git?.applyPatches).toBe(applyPatches);
  });

  it("rejects Git write actions outside the Git profile", () => {
    for (const profile of ["compact", "review", "preview"] as const) {
      expect(() =>
        resolveKeydexDiffProfile(profile, {
          git: { mode: "stage", applyPatches: vi.fn() },
        }),
      ).toThrow(KeydexDiffProfileError);
    }
  });
});
