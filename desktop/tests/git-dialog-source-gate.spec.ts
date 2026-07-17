import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Git dialog source gate", () => {
  it("does not use browser confirm/prompt or hand-written alert dialogs", () => {
    const files = [
      ...sourceFiles(resolve(process.cwd(), "src/renderer/features/git")),
      resolve(process.cwd(), "src/renderer/components/layout/Titlebar/ProjectGitMenu.tsx"),
      resolve(process.cwd(), "src/renderer/components/layout/Titlebar/GitHelpDialog.tsx"),
    ];
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [
        ...matches(source, /window\.(?:confirm|prompt)\s*\(/g, "browser confirmation"),
        ...matches(source, /role\s*=\s*(?:["']alertdialog["']|\{\s*["']alertdialog["']\s*\})/g, "hand-written alertdialog"),
        ...matches(
          source,
          /<button\b(?:(?!<\/button>)[\s\S])*?onClick=\{(?:\(\)\s*=>\s*(?:void\s+)?on[A-Z]\w*\([^)]*\)|on[A-Z]\w*)\}(?:(?!<\/button>)[\s\S])*?>\s*[^<{]*…\s*<\/button>/g,
          "ellipsis action executes a command directly",
        ),
      ].map((violation) => `${file}: ${violation}`);
    });

    expect(violations).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

function matches(source: string, pattern: RegExp, label: string): string[] {
  return Array.from(source.matchAll(pattern), (match) => `${label} at offset ${match.index ?? 0}`);
}
