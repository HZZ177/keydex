import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    expect(css).toContain("--diff-added-text: #50fa7b");
    expect(css).toContain("--diff-removed-text: #ff5555");
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

  it("keeps titlebar and composer capsules flat without reflective edge shadows", () => {
    const titlebar = readFileSync(resolve(rendererDir, "components/layout/Titlebar/Titlebar.module.css"), "utf8");
    const workspaceSelector = readFileSync(
      resolve(rendererDir, "components/workspace/WorkspaceSelector.module.css"),
      "utf8",
    );
    const composerAccessory = readFileSync(
      resolve(rendererDir, "pages/conversation/ComposerAccessory.module.css"),
      "utf8",
    );

    expect(titlebar).toMatch(/\.modeSwitch\s*{[^}]*background:\s*var\(--control-pill-bg\)[^}]*box-shadow:\s*var\(--control-pill-shadow\)/s);
    expect(titlebar).toMatch(/\.modeSwitch::before\s*{[^}]*background:\s*var\(--control-pill-active-bg\)[^}]*box-shadow:\s*none/s);
    expect(workspaceSelector).toMatch(/\.root\[data-variant="titlebar"\] \.trigger\s*{[^}]*background:\s*var\(--control-pill-bg\)[^}]*box-shadow:\s*var\(--control-pill-shadow\)/s);
    expect(composerAccessory).toMatch(/\.accessoryShell\s*{[^}]*background:\s*var\(--control-pill-bg\)[^}]*box-shadow:\s*var\(--control-pill-shadow\)/s);
  });
});
