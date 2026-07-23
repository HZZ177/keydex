import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  KEYDEX_DIFF_DESIGN_TOKENS,
  KEYDEX_LEGACY_DIFF_TOKENS,
} from "@/renderer/components/diff/diffTokens";

const themeDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles/themes");
const rendererDir = resolve(themeDir, "../..");

describe("theme tokens", () => {
  it("defines light and Dracula dark semantic tokens", () => {
    const css = readFileSync(resolve(themeDir, "default-color-scheme.css"), "utf8");

    [
      "--color-bg-1",
      "--color-bg-2",
      "--color-border-2",
      "--fill-0",
      "--color-fill-1",
      "--color-text-1",
      "--color-text-2",
      "--color-primary-6",
      "--color-skill",
      "--composer-bg",
      "--composer-frame",
      "--control-pill-bg",
      "--control-pill-active-bg",
      "--control-pill-border",
      "--inline-block-bg",
    ].forEach((token) => expect(css).toContain(token));

    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--color-bg-1: #282a36");
    expect(css).toContain("--color-text-1: #f8f8f2");
    expect(css).toContain("--color-primary-6: #ff79c6");
    expect(css).toContain("--diff-added-text: #62c77a");
    expect(css).toContain("--diff-removed-text: #ef6a70");
    expect(css).toContain("--color-skill: #ff79c6");
    expect(css).toContain("--syntax-comment: #6272a4");
    expect(css).toContain("--syntax-string: #f1fa8c");
    expect(css).toContain("--composer-bg: #343746");
    expect(css).toContain("--composer-border: transparent");
    expect(css).toContain("--composer-frame: var(--composer-bg)");
    expect(css).toContain("--control-pill-bg: #30323f");
    expect(css).toContain("--control-pill-active-bg: #3a3d4e");
    expect(css).toContain("--control-pill-border: transparent");
    expect(css).toContain("#1677ff");
    expect(css).toContain("#d97706");
  });

  it("uses a restrained warm canvas for large light surfaces while preserving white elevation", () => {
    const css = readFileSync(resolve(themeDir, "default-color-scheme.css"), "utf8");
    const light = css.match(/:root,\s*:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    const terminalCss = readFileSync(
      resolve(rendererDir, "features/terminal/TerminalSurface.module.css"),
      "utf8",
    );
    const terminalRegistry = readFileSync(
      resolve(rendererDir, "features/terminal/terminalXtermRegistry.ts"),
      "utf8",
    );
    const browserVisualContract = readFileSync(
      resolve(rendererDir, "features/browser/visualContract.ts"),
      "utf8",
    );

    expect(light).toContain("--shell-bg: #fffefc");
    expect(light).toContain("--surface-bg: #fffefc");
    expect(light).toContain("--sidebar-bg: #f7f6f3");
    expect(light).toContain("--color-bg-elevated: var(--color-bg-1)");
    expect(light).toContain("--composer-bg: #ffffff");
    expect(terminalCss).toContain("--terminal-surface-background: #fffefc");
    expect(terminalRegistry).toContain('background: "#fffefc"');
    expect(browserVisualContract).toContain('theme === "dark" ? "#282a36" : "#fffefc"');
  });

  it("defines the complete Diff design-token graph in both themes", () => {
    const css = readFileSync(resolve(themeDir, "default-color-scheme.css"), "utf8");
    const light = css.match(/:root,\s*:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    const dark = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";

    [...KEYDEX_DIFF_DESIGN_TOKENS, ...KEYDEX_LEGACY_DIFF_TOKENS].forEach((token) => {
      expect(light, `${token} missing from light theme`).toContain(`${token}:`);
      expect(dark, `${token} missing from dark theme`).toContain(`${token}:`);
    });
  });

  it("keeps semantic Diff colors independent from link blue and fluorescent Dracula colors", () => {
    const css = readFileSync(resolve(themeDir, "default-color-scheme.css"), "utf8");
    expect(css).not.toContain("--diff-added-text: #50fa7b");
    expect(css).not.toContain("--diff-removed-text: #ff5555");
    expect(css).not.toContain("--diff-added-text: #1677ff");
    expect(css).not.toContain("--diff-removed-text: #1677ff");
  });

  it("derives layered Diff surfaces from restrained light and dark semantic colors", () => {
    const css = readFileSync(resolve(themeDir, "default-color-scheme.css"), "utf8");
    const light = css.match(/:root,\s*:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    const dark = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(light).toContain("--diff-aligned-connector-bg: #f7f8fa");
    expect(dark).toContain("--diff-aligned-connector-bg: #252733");
    expect(light).toContain("--diff-added-text: #1a9f50");
    expect(light).toContain("--diff-removed-text: #d64c59");
    expect(light).toContain("--diff-modified-text: #4f86c6");
    expect(dark).toContain("--diff-added-text: #62c77a");
    expect(dark).toContain("--diff-removed-text: #ef6a70");
    expect(dark).toContain("--diff-modified-text: #6da5e3");
    expect(light).toContain("--diff-aligned-change-fill: var(--diff-modified-bg)");
    expect(light).toContain("--diff-aligned-added-edge: var(--diff-added-border)");
    expect(dark).toContain("--diff-aligned-removed-fill: var(--diff-removed-bg)");
    expect(dark).toContain("--diff-aligned-change-edge: var(--diff-modified-border)");
    expect(light).not.toContain("--diff-aligned-change-edge: #1677ff");
    expect(dark).not.toContain("--diff-aligned-added-edge: #50fa7b");
  });

  it("uses Dracula highlighting for dark conversation code and semantic syntax tokens in file preview", () => {
    const codeBlock = readFileSync(
      resolve(rendererDir, "pages/conversation/messages/MarkdownCodeBlock.tsx"),
      "utf8",
    );
    const filePreview = readFileSync(resolve(rendererDir, "components/workspace/FilePreview.tsx"), "utf8");

    expect(codeBlock).toContain('theme === "dark" ? styleModule.dracula : styleModule.vs');
    expect(filePreview).toContain('color: "var(--syntax-keyword)"');
    expect(filePreview).toContain('color: "var(--syntax-function)"');
  });

  it("renders the Keydex composer as an elevated surface instead of a dark outline", () => {
    const sendBox = readFileSync(resolve(rendererDir, "components/chat/SendBox/SendBox.module.css"), "utf8");
    const approvalCard = readFileSync(
      resolve(rendererDir, "pages/conversation/ComposerApprovalCard.module.css"),
      "utf8",
    );

    expect(sendBox).toMatch(
      /\.root\[data-variant="keydex"\]\s*{[^}]*border-color:\s*var\(--composer-border\)[^}]*background:\s*var\(--composer-frame, var\(--composer-bg\)\)/s,
    );
    expect(sendBox).toContain("box-shadow: var(--sendbox-keydex-shadow, var(--composer-shadow))");
    expect(approvalCard).toContain("background: var(--composer-frame, var(--composer-bg))");
  });

  it("keeps composer capsules flat while giving the titlebar mode slider restrained glass depth", () => {
    const titlebar = readFileSync(resolve(rendererDir, "components/layout/Titlebar/Titlebar.module.css"), "utf8");
    const workspaceSelector = readFileSync(
      resolve(rendererDir, "components/workspace/WorkspaceSelector.module.css"),
      "utf8",
    );
    const composerAccessory = readFileSync(
      resolve(rendererDir, "pages/conversation/ComposerAccessory.module.css"),
      "utf8",
    );

    expect(titlebar).toMatch(/\.modeSwitch\s*{[^}]*background:\s*color-mix\([^}]*var\(--control-pill-bg\)[^}]*box-shadow:[^}]*inset 0 1px 0[^}]*backdrop-filter:\s*blur\(12px\)/s);
    expect(titlebar).toMatch(/\.modeSwitch::before\s*{[^}]*background:\s*color-mix\([^}]*var\(--control-pill-active-bg\)[^}]*box-shadow:[^}]*0 3px 10px[^}]*inset 0 1px 0/s);
    expect(titlebar).not.toContain("linear-gradient");
    expect(workspaceSelector).toMatch(/\.root\[data-variant="titlebar"\] \.trigger\s*{[^}]*background:\s*var\(--control-pill-bg\)[^}]*box-shadow:\s*var\(--control-pill-shadow\)/s);
    expect(composerAccessory).toMatch(/\.accessoryShell\s*{[^}]*background:\s*var\(--control-pill-bg\)[^}]*box-shadow:\s*var\(--control-pill-shadow\)/s);
  });
});
