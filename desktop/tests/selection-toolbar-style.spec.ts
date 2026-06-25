import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("selection toolbar style", () => {
  it("does not animate transform or scale during selection toolbar entry", () => {
    const css = readSource("renderer/pages/conversation/messages/SelectionToolbar.module.css");
    const keyframes = /@keyframes\s+toolbarEnter\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? "";

    expect(css).toMatch(/\.toolbar\s*{[^}]*transform:\s*translate\(-50%,\s*-100%\)/s);
    expect(keyframes).not.toMatch(/transform\s*:/);
    expect(keyframes).not.toMatch(/scale\(/);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}
