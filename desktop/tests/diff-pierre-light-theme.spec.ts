import { describe, expect, it } from "vitest";

import {
  KEYDEX_DIFF_LIGHT_THEME,
  KEYDEX_DIFF_LIGHT_THEME_NAME,
  KEYDEX_DIFF_THEME_REGISTRATIONS,
} from "@/renderer/components/diff/engine/pierreThemes";

describe("Keydex Light Shiki Diff theme", () => {
  it("defines a complete low-noise light editor palette", () => {
    expect(KEYDEX_DIFF_LIGHT_THEME).toMatchObject({
      name: KEYDEX_DIFF_LIGHT_THEME_NAME,
      type: "light",
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#171717",
        "editor.selectionBackground": "#d6eaff",
        "editor.lineHighlightBackground": "#f7f7f7",
      },
    });
    expect(KEYDEX_DIFF_THEME_REGISTRATIONS).toContain(KEYDEX_DIFF_LIGHT_THEME);
  });

  it.each([
    ["TypeScript/TSX keywords", "keyword", "#7c3aed"],
    ["Python functions", "entity.name.function", "#0f68a8"],
    ["JSON/YAML properties", "variable.other.property", "#1d4ed8"],
    ["Shell strings", "string", "#15803d"],
    ["numbers", "constant.numeric", "#0f766e"],
    ["comments", "comment", "#7a7a7a"],
  ])("covers %s", (_label, scope, color) => {
    const setting = KEYDEX_DIFF_LIGHT_THEME.settings?.find((candidate) => {
      const scopes = Array.isArray(candidate.scope) ? candidate.scope : [candidate.scope];
      return scopes.includes(scope);
    });
    expect(setting?.settings.foreground).toBe(color);
  });

  it("keeps comments secondary and invalid tokens explicit", () => {
    const comments = KEYDEX_DIFF_LIGHT_THEME.settings?.find((candidate) =>
      Array.isArray(candidate.scope) && candidate.scope.includes("comment"),
    );
    const invalid = KEYDEX_DIFF_LIGHT_THEME.settings?.find((candidate) =>
      Array.isArray(candidate.scope) && candidate.scope.includes("invalid"),
    );
    expect(comments?.settings).toMatchObject({ foreground: "#7a7a7a", fontStyle: "italic" });
    expect(invalid?.settings).toMatchObject({ foreground: "#d92d20", fontStyle: "underline" });
  });
});
