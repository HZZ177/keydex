import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  dispatchKeydexDiffHunkAction,
  isKeydexDiffHunkWriteCapability,
  resolveKeydexDiffHunkAction,
} from "@/renderer/components/diff/aligned/hunkActionCapabilities";
import {
  KEYDEX_DIFF_HUNK_WRITE_CAPABILITIES,
  KEYDEX_DIFF_PROFILES,
  type KeydexDiffHunkCapability,
} from "@/renderer/components/diff/profiles";

const target = Object.freeze({
  fileId: "file:1",
  fileCacheKey: "cache:1",
  sourceVersion: "source:1",
  modelVersion: "aligned-v1",
  hunkId: "hunk:1",
  changeId: "change:1",
});

describe("Diff Hunk capability anti-corruption contract", () => {
  it("keeps every production profile limited to navigation and copy", () => {
    for (const profile of Object.values(KEYDEX_DIFF_PROFILES)) {
      expect(profile.hunkActions.every((capability) => ["navigate", "copy"].includes(capability))).toBe(true);
      expect(profile.hunkActions.some(isKeydexDiffHunkWriteCapability)).toBe(false);
    }
    expect(KEYDEX_DIFF_HUNK_WRITE_CAPABILITIES).toEqual([
      "accept_left",
      "accept_right",
      "stage",
      "unstage",
      "discard",
    ]);
  });

  it("rejects unavailable write capabilities and stale source identities", () => {
    expect(resolveKeydexDiffHunkAction({
      profile: KEYDEX_DIFF_PROFILES.git,
      action: "stage",
      target,
      currentSourceVersion: "source:1",
    })).toEqual({ allowed: false, reason: "capability_not_allowed" });
    expect(resolveKeydexDiffHunkAction({
      profile: KEYDEX_DIFF_PROFILES.git,
      action: "copy",
      target,
      currentSourceVersion: "source:2",
    })).toEqual({ allowed: false, reason: "stale_source" });
  });

  it("honours busy and disabled gates before dispatch", () => {
    for (const gate of ["busy", "disabled"] as const) {
      const decision = resolveKeydexDiffHunkAction({
        profile: KEYDEX_DIFF_PROFILES.git,
        action: "copy",
        target,
        currentSourceVersion: "source:1",
        [gate]: true,
      });
      expect(decision).toEqual({ allowed: false, reason: gate });
      expect(dispatchKeydexDiffHunkAction(decision, vi.fn())).toBe(false);
    }
  });

  it("allows a test-only capability profile to dispatch a frozen typed event", () => {
    const testProfile = { hunkActions: ["navigate", "copy", "accept_left"] as readonly KeydexDiffHunkCapability[] };
    const decision = resolveKeydexDiffHunkAction({
      profile: testProfile,
      action: "accept_left",
      target,
      currentSourceVersion: "source:1",
    });
    const dispatch = vi.fn();
    expect(dispatchKeydexDiffHunkAction(decision, dispatch)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ action: "accept_left", ...target });
    expect(decision.allowed && Object.isFrozen(decision.event)).toBe(true);
  });

  it("contains no production Hunk write control or handler", () => {
    const roots = [
      "src/renderer/components/diff/wrappers/GitDiffView.tsx",
      "src/renderer/features/git/components/GitSelectedChangeDiff.tsx",
      "src/renderer/components/diff/aligned/DiffHunkActionLayer.tsx",
    ];
    const source = roots.map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
    expect(source).not.toMatch(/暂存变更块|取消暂存变更块|应用左侧|应用右侧|丢弃变更块/u);
    expect(source).not.toMatch(/data-hunk-action=(?:"|\{)[^\n]*(?:stage|unstage|discard)/u);
  });
});
