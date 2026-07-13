import { afterEach, describe, expect, it } from "vitest";

import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping/MarkdownPositionMapper";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
} from "@/renderer/markdownRuntime/renderers";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const roots: HTMLElement[] = [];

afterEach(() => roots.splice(0).forEach((root) => root.remove()));

describe("retained Markdown rich and remaining block renderers", () => {
  it("renders inline and display math through bounded, untrusted KaTeX", () => {
    const source = "Inline $a^2 + b^2 = c^2$ after.\n\n$$\\int_0^1 x^2 dx$$";
    const harness = render(parse(source));
    const inline = harness.root.querySelector<HTMLElement>("[data-markdown-math='inline']")!;
    const display = harness.root.querySelector<HTMLElement>("[data-markdown-math='display']")!;
    expect(inline.dataset.markdownMathState).toBe("ready");
    expect(inline.querySelector(".katex")).not.toBeNull();
    expect(display.dataset.markdownMathState).toBe("ready");
    expect(display.querySelector(".katex-display")).not.toBeNull();
    expect(harness.snapshot.blocks[0]!.inline_spans.some((span) => span.kind === "math")).toBe(true);
    expect(harness.renderer.sourceMap(harness.snapshot.blocks[0]!.id)?.inline
      .some((entry) => entry.span.kind === "math" && entry.element === inline)).toBe(true);
    harness.destroy();
  });

  it("keeps invalid and untrusted math failures local with readable source", () => {
    const source = "Before $\\href{javascript:alert(1)}{bad}$ after.\n\n$$\\def\\x{\\x}\\x$$\n\nHealthy";
    const harness = render(parse(source));
    const math = [...harness.root.querySelectorAll<HTMLElement>("[data-markdown-math]")];
    expect(math.some((element) => element.dataset.markdownMathState === "failed")).toBe(true);
    expect(harness.root.querySelector("a[href^='javascript:']")).toBeNull();
    expect(harness.root.textContent).toContain("Healthy");
    expect(harness.root.querySelector("[data-markdown-block-error='true']")).toBeNull();
    expect(math.find((element) => element.dataset.markdownMathState === "failed")?.querySelector("code")?.textContent)
      .not.toBe("");
    harness.destroy();
  });

  it("enforces escaped raw HTML policy for harmless and malicious markup", () => {
    const source = [
      "<mark>harmless</mark>",
      "",
      '<div onclick="alert(1)"><script>alert(2)</script><a href="javascript:bad">unsafe</a></div>',
    ].join("\n");
    const harness = render(parse(source));
    const escaped = harness.root.querySelectorAll<HTMLElement>("[data-markdown-html-policy='escaped']");
    expect(escaped).toHaveLength(2);
    expect([...escaped].every((element) => element.tagName === "PRE")).toBe(true);
    expect(harness.root.querySelector("script,mark,div[onclick],a[href^='javascript:']")).toBeNull();
    expect(harness.root.textContent).toContain("<mark>harmless</mark>");
    expect(harness.root.textContent).toContain("onclick");
    harness.destroy();
  });

  it("renders task state and nested ordered/unordered list structure without flattening", () => {
    const source = [
      "- Parent **bold**",
      "  1. Child one",
      "  2. Child two",
      "- [x] Done",
      "- [ ] Todo",
    ].join("\n");
    const harness = render(parse(source));
    const rootList = harness.root.querySelector<HTMLUListElement>("[data-markdown-block-kind='list']")!;
    const topItems = rootList.querySelectorAll(":scope > li");
    const nested = rootList.querySelector<HTMLOListElement>(":scope > li > ol[data-markdown-nested-list]")!;
    const checkboxes = rootList.querySelectorAll<HTMLInputElement>("[data-markdown-task-checkbox]");
    expect(topItems).toHaveLength(3);
    expect(nested).not.toBeNull();
    expect(nested.start).toBe(1);
    expect(nested.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(nested.querySelectorAll("[data-markdown-list-marker]")[0]?.textContent).toBe("1. ");
    expect(rootList.querySelector("strong")?.textContent).toBe("bold");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.checked).toBe(true);
    expect(checkboxes[1]?.checked).toBe(false);
    expect([...checkboxes].every((checkbox) => checkbox.disabled && checkbox.tabIndex === -1)).toBe(true);
    const metadata = harness.snapshot.blocks[0]!.metadata.list!;
    expect(metadata.items?.map((item) => [item.depth, item.ordinal, item.checked])).toEqual([
      [0, null, null], [1, 1, null], [1, 2, null], [0, null, true], [0, null, false],
    ]);
    harness.destroy();
  });

  it("preserves ordered starts, quote line breaks, thematic breaks, and native selection", () => {
    const source = "7. Seven\n8. Eight\n\n> First line\n> Second line\n\n---";
    const harness = render(parse(source));
    expect(harness.root.querySelector<HTMLOListElement>("ol")?.start).toBe(7);
    expect(harness.root.querySelectorAll("ol > li")).toHaveLength(2);
    expect(harness.root.querySelector("blockquote")?.textContent).toContain("First line");
    expect(harness.root.querySelector("blockquote")?.textContent).toContain("Second line");
    expect(harness.root.querySelector("hr")).not.toBeNull();
    const quote = harness.snapshot.blocks.find((block) => block.kind === "blockquote")!;
    const mapper = new MarkdownPositionMapper(source, harness.snapshot, { mounted: harness.renderer });
    const local = harness.snapshot.logical_text.slice(quote.logical_start, quote.logical_end).indexOf("Second");
    expect(mapper.blockLocal(quote.id, local)).toMatchObject({ status: "exact" });
    harness.destroy();
  });

  it("renders frontmatter as inert YAML source and excludes it from executable HTML", () => {
    const source = "---\ntitle: Demo\nunsafe: <script>alert(1)</script>\n---\n\n# Heading";
    const harness = render(parse(source));
    const frontmatter = harness.root.querySelector<HTMLElement>("[data-markdown-frontmatter='yaml']")!;
    expect(frontmatter.tagName).toBe("PRE");
    expect(frontmatter.querySelector("code.language-yaml")?.textContent).toContain("title: Demo");
    expect(frontmatter.querySelector("script")).toBeNull();
    expect(harness.root.querySelector("h1")?.textContent).toBe("Heading");
    harness.destroy();
  });

  it("blocks unsafe link and image schemes while keeping safe host navigation", () => {
    const source = [
      "[unsafe](javascript:alert(1)) and [safe](https://example.test/docs)",
      "",
      "![file](file:///C:/secret.png)",
      "",
      "![data](data:text/html,bad)",
    ].join("\n");
    const harness = render(parse(source));
    expect(harness.root.querySelector("a[href^='javascript:']")).toBeNull();
    expect(harness.root.querySelector("a[href='https://example.test/docs']")).not.toBeNull();
    expect([...harness.root.querySelectorAll("img")].every((image) => !image.hasAttribute("src"))).toBe(true);
    harness.destroy();
  });

  it("uses the same rich semantic kernel for file and conversation profiles", () => {
    const source = "- [x] Shared\n  - Nested\n\nInline $x^2$\n\n<mark>escaped</mark>";
    const file = render(parse(source, "file-r1", "file"), "file-preview");
    const message = render(parse(source, "message-r1", "message"), "conversation");
    expect(file.root.textContent).toBe(message.root.textContent);
    expect(file.root.querySelectorAll("input,ul,li,.katex,pre").length)
      .toBe(message.root.querySelectorAll("input,ul,li,.katex,pre").length);
    expect(file.root.querySelector("script")).toBeNull();
    expect(message.root.querySelector("script")).toBeNull();
    file.destroy();
    message.destroy();
  });

  it("retains unchanged rich blocks and replaces only changed content", () => {
    const first = parse("- [x] Stable\n\nInline $x$\n\n> Quote", "r1");
    const second = parse("Intro\n\n- [x] Stable\n\nInline $x$\n\n> Quote", "r2", "file", first);
    const harness = render(first);
    const retained = new Map(first.blocks.map((block) => [block.id, harness.renderer.getBlockElement(block.id)]));
    const stats = harness.renderer.render(second);
    expect(stats).toMatchObject({ created: 1, reused: 3, destroyed: 0, failed: 0 });
    second.blocks.filter((block) => retained.has(block.id)).forEach((block) => {
      expect(harness.renderer.getBlockElement(block.id)).toBe(retained.get(block.id));
    });
    harness.destroy();
  });

  it("keeps huge frontmatter and malformed HTML DOM bounded as escaped text", () => {
    const payload = "x".repeat(1_000_000);
    const source = `---\npayload: ${payload}\n---\n\n<div><script>${payload}</script></div>`;
    const harness = render(parse(source));
    expect(harness.root.querySelectorAll("pre code")).toHaveLength(2);
    expect(harness.root.querySelectorAll("script")).toHaveLength(0);
    expect(harness.root.querySelectorAll("pre code")[0]?.childNodes.length).toBe(1);
    expect(harness.root.querySelectorAll("pre code")[1]?.childNodes.length).toBe(1);
    expect(harness.root.textContent?.length).toBeGreaterThan(2_000_000);
    harness.destroy();
  }, 10_000);
});

function render(
  snapshot: MarkdownSnapshot,
  profile: "file-preview" | "conversation" = "file-preview",
) {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const renderer = new RetainedMarkdownDocumentRenderer(root, {
    profile: profile === "file-preview" ? FILE_MARKDOWN_RENDERER_PROFILE : CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  });
  renderer.render(snapshot);
  return {
    root,
    snapshot,
    renderer,
    destroy() {
      renderer.destroy();
      root.remove();
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
    },
  };
}

function parse(
  source: string,
  revision = "rich-r1",
  surface: "file" | "message" = "file",
  previousSnapshot?: MarkdownSnapshot,
) {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:rich-runtime.md`,
    revision,
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  }, { previousSnapshot });
}
