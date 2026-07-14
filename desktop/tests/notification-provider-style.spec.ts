import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("NotificationProvider styles", () => {
  it("keeps top notifications borderless while retaining elevation", () => {
    const css = readFileSync(
      resolve(srcDir, "renderer/providers/NotificationProvider.module.css"),
      "utf8",
    );

    const toastRule = css.match(/\.toast\s*{([^}]*)}/s)?.[1] ?? "";

    expect(toastRule).not.toMatch(/(?:^|\s)border\s*:/);
    expect(toastRule).not.toContain("0 0 0 1px");
    expect(toastRule).toContain("0 12px 34px");
  });
});
