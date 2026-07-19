import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import { createKeydexDiffFile } from "@/renderer/components/diff/model";
import {
  KEYDEX_PIERRE_ALIGNED_VERSION,
  PierreAlignedAdapterError,
  pierreAlignedRenderOptions,
  preparePierreAlignedFile,
  type PierreAlignedPublicApi,
} from "@/renderer/components/diff/engine/pierreAlignedAdapter";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,4 @@ fn",
  " const a = 1;",
  "-old();",
  "+newOne();",
  "+newTwo();",
  " tail();",
  "",
].join("\n");

const file = createKeydexDiffFile({
  id: "file:a",
  cacheKey: "cache:a",
  oldPath: "a.ts",
  newPath: "a.ts",
  status: "modified",
  patch,
  language: "typescript",
});

function api(overrides: Partial<PierreAlignedPublicApi> = {}): PierreAlignedPublicApi {
  return {
    parsePatchFiles: pierre.parsePatchFiles,
    getFiletypeFromFileName: pierre.getFiletypeFromFileName,
    getSharedHighlighter: vi.fn(async () => ({}) as never),
    renderDiffWithHighlighter: vi.fn((metadata) => ({
      code: {
        deletionLines: metadata.deletionLines.map((line: string) => ({ type: "element", tagName: "span", properties: { className: ["line"] }, children: [{ type: "text", value: line }] })),
        additionLines: metadata.additionLines.map((line: string) => ({ type: "element", tagName: "span", properties: { className: ["line"] }, children: [{ type: "text", value: line }] })),
      },
      themeStyles: ":root{}",
      baseThemeType: "light",
    })) as never,
    ...overrides,
  };
}

describe("Pierre aligned anti-corruption adapter", () => {
  it("pins and exercises the 1.2.12 public API contract", () => {
    const packagePath = resolve(process.cwd(), "node_modules/@pierre/diffs/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
    expect(packageJson.version).toBe(KEYDEX_PIERRE_ALIGNED_VERSION);
    expect(typeof pierre.parsePatchFiles).toBe("function");
    expect(typeof pierre.renderDiffWithHighlighter).toBe("function");
    expect(typeof pierre.getSharedHighlighter).toBe("function");
    expect(typeof pierre.getFiletypeFromFileName).toBe("function");
  });

  it("normalizes parser, hunk content and highlighted HAST behind Keydex types", async () => {
    const prepared = await preparePierreAlignedFile(file, {
      theme: "light",
      sourceVersion: "v1",
      api: api(),
    });

    expect(prepared).toMatchObject({
      pierreVersion: "1.2.12",
      fileId: "file:a",
      name: "a.ts",
      language: "typescript",
      partial: true,
      baseThemeType: "light",
    });
    expect(prepared.hunks[0]?.content.map((content) => content.type)).toEqual([
      "context",
      "change",
      "context",
    ]);
    expect(prepared.hunks[0]?.content[1]).toMatchObject({ additions: 2, deletions: 1 });
    expect(prepared.highlightedAdditionLines).toHaveLength(4);
    expect(Object.isFrozen(prepared.highlightedAdditionLines[0])).toBe(true);
    expect(JSON.stringify(prepared)).not.toMatch(/onClick|style=/u);
  });

  it("keeps word-alt and Keydex theme in the public render call", async () => {
    const currentApi = api();
    await preparePierreAlignedFile(file, {
      theme: "dark",
      sourceVersion: "v1",
      api: currentApi,
    });
    expect(currentApi.renderDiffWithHighlighter).toHaveBeenCalledWith(
      expect.objectContaining({ name: "a.ts" }),
      expect.anything(),
      expect.objectContaining({ lineDiffType: "word-alt", theme: "keydex-diff-dark" }),
    );
    expect(pierreAlignedRenderOptions("keydex-diff-light")).toEqual(expect.objectContaining({
      lineDiffType: "word-alt",
      useTokenTransformer: false,
    }));
  });

  it("classifies parse, contract and highlight failures", async () => {
    await expect(preparePierreAlignedFile(file, {
      theme: "light",
      sourceVersion: "v1",
      api: api({ parsePatchFiles: vi.fn(() => { throw new Error("bad patch"); }) }),
    })).rejects.toMatchObject({ phase: "parse", retryable: false });

    await expect(preparePierreAlignedFile(file, {
      theme: "light",
      sourceVersion: "v1",
      api: api({ parsePatchFiles: vi.fn(() => []) }),
    })).rejects.toBeInstanceOf(PierreAlignedAdapterError);

    await expect(preparePierreAlignedFile(file, {
      theme: "light",
      sourceVersion: "v1",
      api: api({ renderDiffWithHighlighter: vi.fn(() => { throw new Error("highlighter"); }) }),
    })).rejects.toMatchObject({ phase: "highlight", retryable: true });
  });
});
