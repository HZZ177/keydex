import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalizeBrowserFileAddress } from "@/renderer/features/browser/domain";

const FIXTURE_ROOT = resolve(
  process.cwd(),
  "..",
  ".dev",
  "test",
  "2026-07-23_21-12-15-workbench-browser-file-preview-annotations",
);

describe("file browser resource fixture", () => {
  it("declares existing CSS, script, image, nested-page and frame resources", () => {
    const manifest = JSON.parse(readFileSync(resolve(FIXTURE_ROOT, "fixture-manifest.json"), "utf8")) as {
      resources: string[];
    };
    const declared = [
      ...manifest.resources,
      "nested/page.html",
      "frames/child.html",
    ];

    expect(declared).toEqual([
      "assets/site.css",
      "assets/marker.js",
      "assets/pixel.svg",
      "nested/page.html",
      "frames/child.html",
    ]);
    declared.forEach((relativePath) => {
      expect(existsSync(resolve(FIXTURE_ROOT, relativePath)), relativePath).toBe(true);
    });
  });

  it("keeps resource links relative so a native file document resolves them locally", () => {
    const html = readFileSync(resolve(FIXTURE_ROOT, "index.html"), "utf8");

    expect(html).toContain('href="./assets/site.css"');
    expect(html).toContain('src="./assets/marker.js"');
    expect(html).toContain('src="./assets/pixel.svg"');
    expect(html).toContain('href="./nested/page.html"');
    expect(html).toContain('src="./frames/child.html"');
  });

  it("round-trips spaces, Chinese, literal percent and hash in one file URL", () => {
    const specialPath = resolve(FIXTURE_ROOT, "中文 空格", "100%#完成.html");
    const canonical = canonicalizeBrowserFileAddress(specialPath);

    expect(existsSync(specialPath)).toBe(true);
    expect(canonical.url).toContain(
      "/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/100%25%23%E5%AE%8C%E6%88%90.html",
    );
    expect(canonical.windowsPath).toBe(specialPath);
  });

  it("keeps a missing resource local to the broken-page fixture", () => {
    const html = readFileSync(resolve(FIXTURE_ROOT, "broken.html"), "utf8");

    expect(html).toContain("BROKEN_ROOT_STILL_VISIBLE");
    expect(existsSync(resolve(FIXTURE_ROOT, "assets", "missing.css"))).toBe(false);
    expect(existsSync(resolve(FIXTURE_ROOT, "assets", "missing.png"))).toBe(false);
  });

  it("does not use HTTP or loopback URLs in the file resource fixture", () => {
    const files = [
      "index.html",
      "nested/page.html",
      "frames/child.html",
      "中文 空格/100%#完成.html",
    ];

    files.forEach((relativePath) => {
      const content = readFileSync(resolve(FIXTURE_ROOT, relativePath), "utf8");
      expect(content).not.toMatch(/\bhttps?:\/\//iu);
    });
  });
});
