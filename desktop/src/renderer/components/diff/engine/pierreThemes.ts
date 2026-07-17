import type { ThemeRegistration } from "@pierre/diffs";

export const KEYDEX_DIFF_LIGHT_THEME_NAME = "keydex-diff-light";
export const KEYDEX_DIFF_DARK_THEME_NAME = "keydex-diff-dark";

export const KEYDEX_DIFF_LIGHT_THEME: ThemeRegistration = Object.freeze({
  name: KEYDEX_DIFF_LIGHT_THEME_NAME,
  type: "light",
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#171717",
    "editorLineNumber.foreground": "#a3a3a3",
    "editorLineNumber.activeForeground": "#555555",
    "editor.selectionBackground": "#d6eaff",
    "editor.inactiveSelectionBackground": "#edf5ff",
    "editor.lineHighlightBackground": "#f7f7f7",
    "editorIndentGuide.background1": "#eeeeee",
    "editorWhitespace.foreground": "#c9c9c9",
    "focusBorder": "#72b5ff",
  },
  settings: [
    { settings: { foreground: "#171717", background: "#ffffff" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7a7a7a", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.control"], settings: { foreground: "#7c3aed" } },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#15803d" } },
    { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: "#0f766e" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#0f68a8" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"], settings: { foreground: "#b45309" } },
    { scope: ["variable.other.property", "support.variable.property", "meta.object-literal.key"], settings: { foreground: "#1d4ed8" } },
    { scope: ["string.regexp", "constant.other.character-class.regexp"], settings: { foreground: "#be123c" } },
    { scope: ["keyword.operator", "punctuation.accessor"], settings: { foreground: "#9333ea" } },
    { scope: ["punctuation", "meta.brace", "meta.delimiter"], settings: { foreground: "#7a7a7a" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "#d92d20", fontStyle: "underline" } },
  ],
});

export const KEYDEX_DIFF_DARK_THEME: ThemeRegistration = Object.freeze({
  name: KEYDEX_DIFF_DARK_THEME_NAME,
  type: "dark",
  colors: {
    "editor.background": "#282a36",
    "editor.foreground": "#f8f8f2",
    "editorLineNumber.foreground": "#6272a4",
    "editorLineNumber.activeForeground": "#a9acc2",
    "editor.selectionBackground": "#44475a",
    "editor.inactiveSelectionBackground": "#3a3d4e",
    "editor.lineHighlightBackground": "#30323f",
    "editorIndentGuide.background1": "#343746",
    "editorWhitespace.foreground": "#596483",
    "focusBorder": "#8b9ac8",
  },
  settings: [
    { settings: { foreground: "#f8f8f2", background: "#282a36" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8790b4", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.control"], settings: { foreground: "#e58abe" } },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#d7dc8b" } },
    { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: "#b7a0df" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#7ed99a" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"], settings: { foreground: "#83c9d8" } },
    { scope: ["variable.other.property", "support.variable.property", "meta.object-literal.key"], settings: { foreground: "#8bbbdc" } },
    { scope: ["string.regexp", "constant.other.character-class.regexp"], settings: { foreground: "#e8797f" } },
    { scope: ["keyword.operator", "punctuation.accessor"], settings: { foreground: "#d996c4" } },
    { scope: ["punctuation", "meta.brace", "meta.delimiter"], settings: { foreground: "#a9acc2" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "#ff6b6b", fontStyle: "underline" } },
  ],
});

export const KEYDEX_DIFF_THEME_NAMES = Object.freeze({
  light: KEYDEX_DIFF_LIGHT_THEME_NAME,
  dark: KEYDEX_DIFF_DARK_THEME_NAME,
});

export const KEYDEX_DIFF_THEME_REGISTRATIONS = Object.freeze([
  KEYDEX_DIFF_LIGHT_THEME,
  KEYDEX_DIFF_DARK_THEME,
]);

export const KEYDEX_DIFF_CSS_VARIABLE_DEFAULTS = Object.freeze({
  foreground: "#171717",
  background: "#ffffff",
  "token-string": "#15803d",
  "token-comment": "#7a7a7a",
  "token-constant": "#0f766e",
  "token-keyword": "#7c3aed",
  "token-parameter": "#171717",
  "token-function": "#0f68a8",
  "token-string-expression": "#15803d",
  "token-punctuation": "#7a7a7a",
  "token-link": "#1d4ed8",
  "token-inserted": "#087f3e",
  "token-deleted": "#d1242f",
  "token-changed": "#b45309",
});
