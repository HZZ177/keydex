import { describe, expect, it } from "vitest";

import {
  createPierreRenderOptions,
  PierreOptionsError,
} from "@/renderer/components/diff/engine/pierreOptions";
import { KEYDEX_DIFF_PROFILES } from "@/renderer/components/diff/profiles";
import {
  KEYDEX_DIFF_DARK_THEME_NAME,
  KEYDEX_DIFF_LIGHT_THEME_NAME,
} from "@/renderer/components/diff/engine/pierreThemes";

describe("central Pierre render options", () => {
  it.each(Object.keys(KEYDEX_DIFF_PROFILES) as (keyof typeof KEYDEX_DIFF_PROFILES)[])(
    "maps the %s profile without exposing third-party controls",
    (profile) => {
      const contract = KEYDEX_DIFF_PROFILES[profile];
      const options = createPierreRenderOptions({
        kind: "single",
        profile,
        theme: "light",
      });
      expect(options).toMatchObject({
        theme: { light: KEYDEX_DIFF_LIGHT_THEME_NAME, dark: KEYDEX_DIFF_DARK_THEME_NAME },
        themeType: "light",
        diffStyle: contract.defaultLayout === "stacked" ? "unified" : "split",
        overflow: contract.defaultWrap ? "wrap" : "scroll",
        disableFileHeader: true,
        diffIndicators: "bars",
        lineDiffType: "word-alt",
        useTokenTransformer: false,
      });
      expect(options).not.toHaveProperty("unsafeCSS");
      expect(options).not.toHaveProperty("renderCustomHeader");
    },
  );

  it("adds virtualization metrics only for CodeView", () => {
    const single = createPierreRenderOptions({
      kind: "single",
      profile: "preview",
      theme: "dark",
    });
    const multi = createPierreRenderOptions({
      kind: "multi",
      profile: "preview",
      theme: "dark",
    });
    expect(single).not.toHaveProperty("layout");
    expect(single).not.toHaveProperty("itemMetrics");
    expect(multi).toMatchObject({
      stickyHeaders: true,
      pointerEventsOnScroll: true,
      layout: { gap: 12 },
      itemMetrics: { lineHeight: 20, diffHeaderHeight: 36 },
    });
  });

  it("rejects profile capability violations and raw Pierre options", () => {
    expect(() => createPierreRenderOptions({
      kind: "single",
      profile: "compact",
      theme: "light",
      layout: "split",
    })).toThrow(PierreOptionsError);
    expect(() => createPierreRenderOptions({
      kind: "single",
      profile: "review",
      theme: "light",
      selectionEnabled: true,
    })).toThrow(PierreOptionsError);
    expect(() => createPierreRenderOptions({
      kind: "single",
      profile: "git",
      theme: "light",
      unsafeCSS: "*{}",
    } as never)).toThrow("不允许直接传入 Pierre 参数");
  });

  it("allows controlled line selection only in the Git profile", () => {
    expect(createPierreRenderOptions({
      kind: "single",
      profile: "git",
      theme: "dark",
      selectionEnabled: true,
    })).toMatchObject({ enableLineSelection: true, controlledSelection: true });
  });
});
