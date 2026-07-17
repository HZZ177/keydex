import { describe, expect, it, vi } from "vitest";

import {
  pierrePatchDiffProps,
} from "@/renderer/components/diff/engine/PierrePatchDiff";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import {
  fromPierreSelectedLineRange,
  toPierreSelectedLineRange,
} from "@/renderer/components/diff/selectionBridge";

const file = normalizeUnifiedPatch(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  { source: "git", sourceVersion: "v1" },
).files[0]!;

describe("Pierre PatchDiff adapter", () => {
  it.each([
    ["light", "stacked", false, "unified", "scroll"],
    ["dark", "split", true, "split", "wrap"],
  ] as const)("maps %s %s display options", (theme, layout, wrap, expectedLayout, expectedOverflow) => {
    const props = pierrePatchDiffProps(file, { profile: "preview", theme, layout, wrap });
    expect(props.patch).toBe(file.patch);
    expect(props.options).toMatchObject({
      themeType: theme,
      diffStyle: expectedLayout,
      overflow: expectedOverflow,
      disableFileHeader: true,
    });
    expect(props.options).not.toHaveProperty("unsafeCSS");
  });

  it("maps controlled old/new selection coordinates in both directions", () => {
    const range = fromPierreSelectedLineRange(file, {
      start: 1,
      end: 1,
      side: "deletions",
      endSide: "additions",
    });
    expect(range).toMatchObject({
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 1 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 1 },
    });
    expect(toPierreSelectedLineRange(file, range)).toEqual({
      start: 1,
      end: 1,
      side: "deletions",
      endSide: "additions",
    });
  });

  it("forwards Pierre selection events only for exact selectable files", () => {
    const onChange = vi.fn();
    const props = pierrePatchDiffProps(file, {
      profile: "git",
      theme: "light",
      layout: "stacked",
      wrap: false,
      onSelectedRangeChange: onChange,
    });
    expect(props.options).toMatchObject({ enableLineSelection: true, controlledSelection: true });
    props.options?.onLineSelected?.({ start: 2, end: 4, side: "additions", endSide: "additions" });
    expect(onChange).toHaveBeenCalledWith(null);

    const blocked = pierrePatchDiffProps({ ...file, truncated: true, selectableForPatch: false }, {
      profile: "git",
      theme: "light",
      layout: "stacked",
      wrap: false,
      onSelectedRangeChange: onChange,
    });
    expect(blocked.options).toMatchObject({ enableLineSelection: false, controlledSelection: false });
    expect(blocked.options?.onLineSelected).toBeUndefined();
  });

  it("never enables Git patch selection in a read-only profile", () => {
    const props = pierrePatchDiffProps(file, {
      profile: "review",
      theme: "light",
      onSelectedRangeChange: vi.fn(),
    });
    expect(props.options).toMatchObject({ enableLineSelection: false, controlledSelection: false });
    expect(props.options?.onLineSelected).toBeUndefined();
  });
});
