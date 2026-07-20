import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TERMINAL_FEATURE_MANIFEST } from "@/renderer/features/terminal/terminalFeatureManifest";

describe("terminal feature manifest", () => {
  it("freezes the first-release platform, profiles and resource limits", () => {
    expect(TERMINAL_FEATURE_MANIFEST).toMatchObject({
      contractVersion: 1,
      supportedPlatforms: ["windows"],
      profiles: ["git-bash", "powershell", "cmd"],
      limits: {
        terminalsPerSession: 8,
        terminalsGlobal: 24,
        replayBytesPerTerminal: 1024 * 1024,
        scrollbackLines: 5000,
        maxOutputChunkBytes: 32 * 1024,
        maxInputBytes: 64 * 1024,
      },
    });
    expect(TERMINAL_FEATURE_MANIFEST.unsupported).toEqual(
      expect.arrayContaining(["agent-command-runtime", "command-approval", "wsl", "ssh"]),
    );
  });

  it("keeps terminal implementation independent from backend command policy surfaces", () => {
    const desktopRoot = path.resolve(process.cwd());
    const roots = [
      path.join(desktopRoot, "src", "renderer", "features", "terminal"),
      path.join(desktopRoot, "src", "runtime"),
    ];
    const forbidden = [
      /command_approval/i,
      /command[_-]?whitelist/i,
      /command[_-]?trust/i,
      /commandSettings/i,
      /backend\/app\/.*command/i,
    ];

    const sourceFiles = roots
      .flatMap((root) => collectTerminalSources(root))
      .filter((file) => !file.endsWith("terminalFeatureManifest.ts"));
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${path.relative(desktopRoot, file)} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

function collectTerminalSources(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTerminalSources(fullPath));
      continue;
    }
    if (/terminal.*\.(ts|tsx)$/i.test(entry.name) || root.endsWith(`${path.sep}terminal`)) {
      results.push(fullPath);
    }
  }
  return results;
}
