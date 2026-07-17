import { describe, expect, it } from "vitest";

import {
  keydexDiffLineNumberDigits,
  KEYDEX_DIFF_TYPOGRAPHY,
} from "@/renderer/components/diff/diffTypography";
import {
  keydexCodeViewItemMetrics,
  keydexCodeViewLayout,
} from "@/renderer/components/diff/engine/pierreOptions";
import { keydexPierreStyle } from "@/renderer/components/diff/engine/pierreStyleBridge";

describe("Keydex Diff typography and virtual metrics", () => {
  it("keeps compact dense and the full-surface profiles comfortably aligned", () => {
    expect(KEYDEX_DIFF_TYPOGRAPHY.compact).toMatchObject({
      fontSize: 12,
      lineHeight: 18,
      headerHeight: 34,
      itemGap: 8,
    });
    for (const profile of ["review", "git", "preview"] as const) {
      expect(KEYDEX_DIFF_TYPOGRAPHY[profile]).toMatchObject({
        fontSize: 13,
        lineHeight: 20,
        headerHeight: 36,
        itemGap: 12,
        tabSize: 2,
        signColumnWidth: 4,
      });
    }
  });

  it.each(["compact", "review", "git", "preview"] as const)(
    "synchronizes %s CSS line metrics with CodeView estimates",
    (profile) => {
      const typography = KEYDEX_DIFF_TYPOGRAPHY[profile];
      const metrics = keydexCodeViewItemMetrics(profile);
      const layout = keydexCodeViewLayout(profile);
      const style = keydexPierreStyle(profile);

      expect(metrics).toMatchObject({
        lineHeight: typography.lineHeight,
        diffHeaderHeight: typography.headerHeight,
        hunkLineCount: typography.hunkLineCount,
        paddingBottom: typography.paddingBlock,
      });
      expect(layout.gap).toBe(typography.itemGap);
      expect(style["--diffs-font-size"]).toBe(`${typography.fontSize}px`);
      expect(style["--diffs-line-height"]).toBe(`${typography.lineHeight}px`);
      expect(style["--diffs-tab-size"]).toBe("2");
      expect(style["--diffs-min-number-column-width"]).toBe("3ch");
    },
  );

  it("holds 1/4/5-digit gutters stable without clipping growth", () => {
    expect(keydexDiffLineNumberDigits(8, "preview")).toBe(3);
    expect(keydexDiffLineNumberDigits(9999, "preview")).toBe(4);
    expect(keydexDiffLineNumberDigits(99_999, "preview")).toBe(5);
    expect(() => keydexDiffLineNumberDigits(-1, "preview")).toThrow(TypeError);
  });

  it("uses tabular numbers and disables code ligatures to prevent gutter jitter", () => {
    expect(keydexPierreStyle("git")["--diffs-font-features"]).toBe(
      '"tnum" 1, "liga" 0',
    );
  });
});
