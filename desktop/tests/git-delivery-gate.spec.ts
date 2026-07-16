import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "..");

describe("Git workbench delivery gate", () => {
  it("keeps exactly the titlebar menu and singleton sidebar panel as product entrances", () => {
    const titlebar = source("desktop/src/renderer/components/layout/Titlebar/Titlebar.tsx");
    const initialSidebar = source("desktop/src/renderer/components/layout/RightSidebarInitialPage.tsx");
    const registry = source("desktop/src/renderer/components/layout/rightSidebarRegistry.ts");

    expect(titlebar.match(/<ProjectGitMenu\b/g)).toHaveLength(1);
    expect(initialSidebar.match(/onClick=\{onOpenGit\}/g)).toHaveLength(1);
    expect(registry.match(/type: "git"/g)).toHaveLength(1);
    expect(registry).toContain('multiplicity: "singleton"');

    const rendererRoot = resolve(repositoryRoot, "desktop/src/renderer");
    const unexpected = walk(rendererRoot)
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .filter((path) => !path.includes("features\\git") && !path.includes("features/git"))
      .filter((path) => !path.endsWith("ProjectGitMenu.tsx"))
      .filter((path) => !path.endsWith("Titlebar.tsx"))
      .filter((path) => !path.endsWith("Layout.tsx"))
      .filter((path) => !path.endsWith("RightSidebarInitialPage.tsx"))
      .filter((path) => !path.endsWith("rightSidebarRegistry.ts"))
      .filter((path) => /onOpenGit|<ProjectGitMenu\b/.test(readFileSync(path, "utf8")));
    expect(unexpected).toEqual([]);
  });

  it("keeps Git execution behind the typed runtime and argv-based backend runner", () => {
    const frontendFiles = [
      ...walk(resolve(repositoryRoot, "desktop/src/renderer/features/git")),
      resolve(repositoryRoot, "desktop/src/runtime/git.ts"),
      resolve(repositoryRoot, "desktop/src/runtime/gitTypes.ts"),
    ].filter((path) => /\.(ts|tsx)$/.test(path));
    const frontend = frontendFiles.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(frontend).not.toMatch(/node:child_process|@tauri-apps\/plugin-shell|shell\s*:\s*true/);

    const backend = walk(resolve(repositoryRoot, "backend/app/git"))
      .filter((path) => path.endsWith(".py"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(backend).not.toMatch(/shell\s*=\s*True|os\.system\s*\(|subprocess\.Popen\s*\(/);
    expect(source("backend/app/git/runner.py")).toContain("asyncio.create_subprocess_exec");
  });

  it("keeps license, 103 issue contracts and 81 E2E cases traceable", () => {
    const attribution = source("docs/git-open-source-attribution.md");
    expect(attribution).toContain("Stack-Cairn/LiveAgent");
    expect(attribution).toContain("1616eb5e574274693dc29e18248650dc30911123");
    expect(attribution).toContain("MIT");

    const issues = source(".dev/issues/2026-07-15_22-24-53-keydex-git-workbench.csv");
    const issueIds = [...issues.matchAll(/^"(GIT-\d{3})",/gm)].map((match) => match[1]);
    expect(issueIds).toEqual(sequence("GIT-", 103));

    const e2e = source(".dev/e2e/contracts/2026-07-15_22-24-53-keydex-git-workbench.csv");
    const e2eIds = [...e2e.matchAll(/^"(e2e-\d{3})",/gm)].map((match) => match[1]);
    expect(e2eIds).toEqual(sequence("e2e-", 81));
    const sourceIssues = [...e2e.matchAll(/^"e2e-\d{3}","P\d","(GIT-\d{3})",/gm)]
      .map((match) => match[1]);
    expect(sourceIssues).toHaveLength(81);
    expect(sourceIssues.every((id) => issueIds.includes(id))).toBe(true);
  });
});

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function sequence(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(3, "0")}`);
}

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
