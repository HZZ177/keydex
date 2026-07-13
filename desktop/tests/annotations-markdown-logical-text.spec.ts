import { describe, expect, it } from "vitest";

import { serializeMarkdownLogicalText } from "./fixtures/annotationMarkdown";

describe("markdown logical text", () => {
  it("serializes visible Markdown semantics with fixed block, row, and cell separators", () => {
    const source = [
      "# Guide",
      "",
      "Hello **bold** and [link](https://example.com) with `code`.",
      "",
      "- first",
      "- [x] second",
      "",
      "| Name | Role |",
      "| --- | --- |",
      "| Ada | Admin |",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");
    const result = serializeMarkdownLogicalText(source);

    expect(result.logicalText).toBe([
      "Guide",
      "Hello bold and link with code.",
      "first",
      "[x] second",
      "Name",
      "Role",
      "Ada",
      "Admin",
      "const value = 1;",
    ].join("\n"));
    expect(result.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "table",
      "fence",
    ]);
  });

  it("tracks nested heading context deterministically", () => {
    const source = "# Top\n\nIntro\n\n## Child\n\nBody\n\n### Deep\n\nTail";
    const first = serializeMarkdownLogicalText(source);
    const second = serializeMarkdownLogicalText(source);

    expect(second).toEqual(first);
    expect(first.blocks.map((block) => block.context.headingPath)).toEqual([
      ["Top"],
      ["Top"],
      ["Top", "Child"],
      ["Top", "Child"],
      ["Top", "Child", "Deep"],
      ["Top", "Child", "Deep"],
    ]);
  });

  it("removes presentation markers while retaining visible image alt, quote, escapes, and Unicode", () => {
    const source = [
      "> 引用 *内容* 😀",
      "",
      "![架构图](./diagram.png) and escaped \\* marker",
      "",
      "Title",
      "-----",
    ].join("\n");
    const result = serializeMarkdownLogicalText(source);

    expect(result.logicalText).toBe("引用 内容 😀\n架构图 and escaped * marker\nTitle");
    expect(result.logicalText).not.toContain("diagram.png");
  });

  it("uses the same logical text and revision when only Markdown presentation syntax changes", () => {
    const strong = serializeMarkdownLogicalText("# Title\n\nThis is **important**.");
    const emphasis = serializeMarkdownLogicalText("Title\n=====\n\nThis is __important__.");

    expect(emphasis.logicalText).toBe(strong.logicalText);
    expect(emphasis.textRevision).toBe(strong.textRevision);
  });

  it("returns a stable empty contract", () => {
    const result = serializeMarkdownLogicalText("");

    expect(result.logicalText).toBe("");
    expect(result.blocks).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.textRevision).toMatch(/^md-logical:/);
  });
});
