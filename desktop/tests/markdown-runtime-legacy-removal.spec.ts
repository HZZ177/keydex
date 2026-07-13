import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const desktopRoot = process.cwd();
const productionRoots = [
  resolve(desktopRoot, "src/renderer/components/workspace"),
  resolve(desktopRoot, "src/renderer/markdownRuntime"),
];
const conversationRuntimeFiles = [
  resolve(desktopRoot, "src/renderer/pages/conversation/messages/ConversationMarkdownRendererProfile.tsx"),
  resolve(desktopRoot, "src/renderer/pages/conversation/messages/ConversationMarkdownRuntimeHost.tsx"),
  resolve(desktopRoot, "src/renderer/pages/conversation/messages/MarkdownCodeBlock.tsx"),
  resolve(desktopRoot, "src/renderer/pages/conversation/messages/MessageText.tsx"),
];
const forbiddenProductionTokens = [
  "markdownPreviewEngine",
  "VirtualMarkdownPreview",
  "markdownRuntimeMode",
  "SemanticShadow",
  "useVirtuosoAutoScroll",
  "react-virtuoso",
];

describe("Markdown Runtime structural cutover", () => {
  it("keeps the old renderer outside production source and dependency graphs", () => {
    const files = [
      ...productionRoots.flatMap((root) => sourceFiles(root)),
      ...conversationRuntimeFiles,
      resolve(desktopRoot, "package.json"),
      resolve(desktopRoot, "pnpm-lock.yaml"),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const token of forbiddenProductionTokens) {
        if (source.includes(token)) {
          violations.push(`${relative(desktopRoot, file)} contains ${token}`);
        }
      }
      if (/['"](?:legacy|shadow)['"]/.test(source)) {
        violations.push(`${relative(desktopRoot, file)} contains an old runtime mode literal`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("stores the reversible source backup outside the desktop build and test roots", () => {
    const backupRoot = resolve(
      desktopRoot,
      "../.dev/backups/zed-class-markdown-runtime/legacy-markdown-engine",
    );
    expect(existsSync(join(backupRoot, "VirtualMarkdownPreview.tsx"))).toBe(true);
    expect(existsSync(join(backupRoot, "conversation/useVirtuosoAutoScroll.ts"))).toBe(true);
    expect(existsSync(resolve(desktopRoot, "src/renderer/components/workspace/markdownPreviewEngine"))).toBe(false);
    expect(existsSync(resolve(desktopRoot, "src/renderer/pages/conversation/messages/useVirtuosoAutoScroll.ts"))).toBe(false);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx|json|ya?ml)$/.test(entry.name) ? [path] : [];
  });
}
