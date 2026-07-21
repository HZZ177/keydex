import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Windows release notes contract", () => {
  it("passes the prepared Markdown file into the updater manifest", () => {
    const repositoryRoot = resolve(process.cwd(), "..");
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/windows-release.yml"),
      "utf8",
    );
    const packagingScript = readFileSync(
      resolve(repositoryRoot, "scripts/package-windows.ps1"),
      "utf8",
    );

    expect(workflow).toMatch(
      /"KEYDEX_RELEASE_NOTES_PATH=\$notesPath"\s*\|\s*Out-File\s+-FilePath\s+\$env:GITHUB_ENV/,
    );
    expect(packagingScript).toContain("$env:KEYDEX_RELEASE_NOTES_PATH");
    expect(packagingScript).toMatch(/notes\s*=\s*\$ReleaseNotes/);
  });
});
