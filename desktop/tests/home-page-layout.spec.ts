import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("home page layout", () => {
  it("keeps the new chat surface bounded during side panel resizing", () => {
    const home = readSource("renderer/pages/home/HomePage.module.css");

    expect(home).toMatch(/\.home\s*{[^}]*height:\s*100%/s);
    expect(home).toMatch(/\.home\s*{[^}]*min-height:\s*0/s);
    expect(home).toMatch(/\.home\s*{[^}]*overflow:\s*hidden/s);
    expect(home).toMatch(/\.home\s*{[^}]*contain:\s*layout paint style/s);
    expect(home).not.toMatch(/min-height:\s*calc\(100vh/);

    expect(home).toMatch(/\.canvas\s*{[^}]*width:\s*100%/s);
    expect(home).toMatch(/\.canvas\s*{[^}]*min-width:\s*0/s);
    expect(home).toMatch(/\.canvas\s*{[^}]*max-width:\s*728px/s);
    expect(home).toMatch(/\.canvas\s*{[^}]*contain:\s*layout style/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}
