import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KeydexDiffFileHeader } from "@/renderer/components/diff/KeydexDiffFileHeader";
import { createKeydexDiffFile, type KeydexDiffFileInput } from "@/renderer/components/diff/model";

describe("Keydex Diff product file header", () => {
  it("uses the mature Material icon asset and a separate status icon", () => {
    const { container } = render(<KeydexDiffFileHeader file={file()} />);
    const image = container.querySelector("img[data-material-icon]");
    expect(image?.getAttribute("src")).toBeTruthy();
    expect(image?.getAttribute("alt")).toBe("");
    expect(container.querySelector("[class*='statusIcon'][data-status='modified'] svg")).toBeTruthy();
  });

  it.each([
    ["added", "新增"],
    ["modified", "修改"],
    ["deleted", "删除"],
    ["renamed", "重命名"],
    ["copied", "复制"],
    ["type_changed", "类型变化"],
    ["unknown", "变更"],
  ] as const)("renders a %s status with Chinese semantics", (status, label) => {
    render(<KeydexDiffFileHeader file={file({ status })} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("shows rename, executable mode, binary and truncation metadata", () => {
    render(<KeydexDiffFileHeader file={file({
      status: "renamed",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      displayPath: "src/new.ts",
      oldMode: "100644",
      newMode: "100755",
      binary: true,
      contentKind: "binary",
      truncated: true,
      patch: "",
    })} />);
    expect(screen.getByText("src/old.ts → src/new.ts")).toBeTruthy();
    expect(screen.getByText("模式 100644 → 100755")).toBeTruthy();
    expect(screen.getByText("二进制")).toBeTruthy();
    expect(screen.getByText("内容已截断")).toBeTruthy();
  });

  it("keeps the file name first and makes the ghost path the dominant shrink target", () => {
    const css = readFileSync(resolve(
      process.cwd(),
      "src/renderer/components/diff/DiffChrome.module.css",
    ), "utf8");
    expect(css).toContain(".fileName");
    expect(css).toMatch(/\.directoryPath\s*\{[^}]*flex:\s*1 10000 auto/su);
    expect(css).toMatch(/\.directoryPath\s*\{[^}]*text-overflow:\s*ellipsis/su);
    render(<KeydexDiffFileHeader file={file({
      displayPath: "a/very/long/ghost/path/FileNameMustComeFirst.tsx",
      oldPath: "a/very/long/ghost/path/FileNameMustComeFirst.tsx",
      newPath: "a/very/long/ghost/path/FileNameMustComeFirst.tsx",
    })} />);
    const header = screen.getByTitle("a/very/long/ghost/path/FileNameMustComeFirst.tsx");
    expect(header.textContent?.indexOf("FileNameMustComeFirst.tsx")).toBeLessThan(
      header.textContent?.indexOf("a/very/long/ghost/path") ?? Number.MAX_SAFE_INTEGER,
    );
  });
});

function file(overrides: Partial<KeydexDiffFileInput> = {}) {
  return createKeydexDiffFile({
    id: `file-${overrides.status ?? "modified"}`,
    oldPath: "src/View.tsx",
    newPath: "src/View.tsx",
    displayPath: "src/View.tsx",
    status: "modified",
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    cacheKey: `file-${overrides.status ?? "modified"}:v1`,
    additions: 1,
    deletions: 1,
    ...overrides,
  });
}
