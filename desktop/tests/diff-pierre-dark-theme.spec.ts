import { describe, expect, it } from "vitest";

import {
  KEYDEX_DIFF_DARK_THEME,
  KEYDEX_DIFF_DARK_THEME_NAME,
  KEYDEX_DIFF_THEME_NAMES,
  KEYDEX_DIFF_THEME_REGISTRATIONS,
} from "@/renderer/components/diff/engine/pierreThemes";

describe("Keydex Dark Shiki Diff theme", () => {
  it("uses a stable Keydex dark registration instead of inverted light colors", () => {
    expect(KEYDEX_DIFF_DARK_THEME).toMatchObject({
      name: KEYDEX_DIFF_DARK_THEME_NAME,
      type: "dark",
      colors: {
        "editor.background": "#282a36",
        "editor.foreground": "#f8f8f2",
        "editor.selectionBackground": "#44475a",
        "editor.lineHighlightBackground": "#30323f",
      },
    });
    expect(KEYDEX_DIFF_THEME_NAMES.dark).toBe(KEYDEX_DIFF_DARK_THEME_NAME);
    expect(KEYDEX_DIFF_THEME_REGISTRATIONS).toContain(KEYDEX_DIFF_DARK_THEME);
  });

  it.each([
    ["keyword", "#e58abe"],
    ["string", "#d7dc8b"],
    ["entity.name.function", "#7ed99a"],
    ["entity.name.type", "#83c9d8"],
    ["variable.other.property", "#8bbbdc"],
    ["comment", "#8790b4"],
  ])("defines a restrained %s role", (scope, color) => {
    const setting = KEYDEX_DIFF_DARK_THEME.settings?.find((candidate) => {
      const scopes = Array.isArray(candidate.scope) ? candidate.scope : [candidate.scope];
      return scopes.includes(scope);
    });
    expect(setting?.settings.foreground).toBe(color);
    expect(color).not.toBe("#1677ff");
  });

  it("keeps normal text at AA contrast and secondary comments readable", () => {
    expect(contrast("#f8f8f2", "#282a36")).toBeGreaterThan(7);
    expect(contrast("#8790b4", "#282a36")).toBeGreaterThan(4.5);
    expect(contrast("#d7dc8b", "#282a36")).toBeGreaterThan(4.5);
  });
});

function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function luminance(hex: string) {
  const channels = hex.slice(1).match(/.{2}/gu)!.map((channel) => Number.parseInt(channel, 16) / 255);
  return channels.reduce((sum, channel, index) => {
    const linear = channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
}
