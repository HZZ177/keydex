import { describe, expect, it } from "vitest";

import {
  isAbsoluteFilePath,
  parseFileLinkTarget,
  parseMarkdownFileLinkExpression,
  resolveRelativeFileLinkPath,
  workspaceRelativeFilePath,
} from "@/renderer/utils/fileLinks";

describe("file link target parsing", () => {
  it("parses angle-wrapped absolute paths with spaces and trailing line numbers", () => {
    expect(parseFileLinkTarget("<D:/Docs/local notes.md:12>")).toEqual({
      absolute: true,
      line: 12,
      path: "D:/Docs/local notes.md",
    });
  });

  it("parses workspace-relative source paths with line numbers", () => {
    expect(parseFileLinkTarget("desktop/src/renderer/App.tsx:8")).toEqual({
      absolute: false,
      line: 8,
      path: "desktop/src/renderer/App.tsx",
    });
  });

  it("resolves encoded relative links from the current document directory", () => {
    expect(
      resolveRelativeFileLinkPath(
        "references/start%20here.md",
        "backend/app/keydex-guide/SKILL.md",
      ),
    ).toBe("backend/app/keydex-guide/references/start here.md");
    expect(resolveRelativeFileLinkPath("../shared/guide.md", "docs/topic/readme.md"))
      .toBe("docs/shared/guide.md");
  });

  it("keeps local absolute source roots and rejects links that escape them", () => {
    expect(resolveRelativeFileLinkPath("../shared/guide.md", "D:/notes/topic/readme.md"))
      .toBe("D:/notes/shared/guide.md");
    expect(resolveRelativeFileLinkPath("../escape.md", "README.md")).toBeNull();
  });

  it("rejects external urls and fragments", () => {
    expect(parseFileLinkTarget("https://example.test/README.md")).toBeNull();
    expect(parseFileLinkTarget("#heading")).toBeNull();
  });

  it("recognizes platform absolute paths", () => {
    expect(isAbsoluteFilePath("D:\\Docs\\note.md")).toBe(true);
    expect(isAbsoluteFilePath("/Users/me/note.md")).toBe(true);
    expect(isAbsoluteFilePath("README.md")).toBe(false);
  });

  it("derives workspace-relative paths from external Windows file paths", () => {
    expect(
      workspaceRelativeFilePath(
        "D:\\Pycharm Projects\\keydex\\docs\\README.md",
        "d:/pycharm projects/keydex",
      ),
    ).toBe("docs/README.md");
    expect(workspaceRelativeFilePath("D:/docs/README.md", "D:/Pycharm Projects/keydex")).toBeNull();
    expect(workspaceRelativeFilePath("D:/repo-copy/README.md", "D:/repo")).toBeNull();
  });

  it("parses only complete standard markdown file link expressions", () => {
    expect(parseMarkdownFileLinkExpression("[README.md](<README.md:162>)")).toEqual({
      absolute: false,
      label: "README.md",
      line: 162,
      path: "README.md",
    });
    expect(parseMarkdownFileLinkExpression("README.md 第 162 行")).toBeNull();
    expect(parseMarkdownFileLinkExpression("README.md:162")).toBeNull();
  });
});
