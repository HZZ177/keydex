import { describe, expect, it } from "vitest";

import {
  DEFAULT_GIT_SHORTCUTS,
  isEditableGitShortcutTarget,
  matchesGitShortcut,
  resolveGitShortcuts,
} from "@/renderer/features/git/gitShortcuts";

describe("Git shortcuts", () => {
  it("matches exact modifiers and ignores editable targets", () => {
    expect(matchesGitShortcut(new KeyboardEvent("keydown", { key: "K", ctrlKey: true }), DEFAULT_GIT_SHORTCUTS.commit)).toBe(true);
    expect(matchesGitShortcut(new KeyboardEvent("keydown", { key: "K", ctrlKey: true, shiftKey: true }), DEFAULT_GIT_SHORTCUTS.commit)).toBe(false);
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isEditableGitShortcutTarget(input)).toBe(true);
    expect(isEditableGitShortcutTarget(editable)).toBe(true);
  });

  it("reports configurable shortcut collisions without silently choosing a command", () => {
    const resolved = resolveGitShortcuts({ push: { key: "k", ctrl: true, shift: false, label: "Ctrl+K" } });
    expect(resolved.conflicts).toEqual([{ signature: "ctrl+k", commands: ["commit", "push"] }]);
  });
});
