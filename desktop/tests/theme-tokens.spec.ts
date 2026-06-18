import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const themeDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles/themes");

describe("theme tokens", () => {
  it("defines Codex-like light and dark semantic tokens", () => {
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
      "--composer-bg",
      "--inline-block-bg",
    ].forEach((token) => expect(css).toContain(token));

    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("#1677ff");
    expect(css).toContain("#d97706");
  });
});
