import { describe, expect, it } from "vitest";

import { normalizeDiffLanguage, resolveDiffLanguage } from "@/renderer/components/diff/language";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

describe("shared diff language resolver", () => {
  it.each([
    ["src/App.tsx", "tsx"],
    ["src/main.PY", "python"],
    ["styles/theme.scss", "scss"],
    ["config/.eslintrc.json", "json"],
    ["pnpm-lock.yaml", "yaml"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "makefile"],
  ])("maps %s to %s", (path, language) => {
    expect(resolveDiffLanguage({ path })).toBe(language);
  });

  it.each([
    ["#!/usr/bin/env python3\nprint('ok')", "python"],
    ["#!/usr/bin/env node\nconsole.log('ok')", "javascript"],
    ["\uFEFF#!/bin/bash\necho ok", "bash"],
    ["#!/usr/bin/env pwsh\nWrite-Host ok", "powershell"],
  ])("detects extensionless shebangs", (content, language) => {
    expect(resolveDiffLanguage({ path: "scripts/run", content })).toBe(language);
  });

  it("normalizes explicit aliases and safely falls back for unknown files", () => {
    expect(resolveDiffLanguage({ path: "a.ts", explicitLanguage: "  JS " })).toBe("javascript");
    expect(normalizeDiffLanguage("plain text!")).toBe("plaintext");
    expect(resolveDiffLanguage({ path: "LICENSE" })).toBe("text");
  });

  it("feeds the same language into normalized diff files", () => {
    const document = normalizeUnifiedPatch(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      { source: "preview", sourceVersion: "v1" },
    );
    expect(document.files[0]?.language).toBe("typescript");
  });
});
