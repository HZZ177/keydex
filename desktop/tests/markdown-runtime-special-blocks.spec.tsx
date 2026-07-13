import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
  SemanticMarkdownRendererRegistry,
  defaultSemanticMarkdownRenderers,
} from "@/renderer/markdownRuntime/renderers";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const roots: HTMLElement[] = [];

afterEach(() => roots.splice(0).forEach((root) => root.remove()));

describe("special Markdown block cross-module gate", () => {
  it("keeps the complete semantic and interaction matrix on file and conversation surfaces", () => {
    const source = [
      "# Heading",
      "",
      "> Quote",
      "",
      "- [x] Done",
      "  1. Nested",
      "- [ ] Todo",
      "",
      "| A | B |",
      "|---|---|",
      "| [docs](https://example.test) | Cell |",
      "",
      "![diagram](diagram.png)",
      "",
      "```mermaid",
      "flowchart TD",
      "A-->B",
      "```",
      "",
      "Inline $x^2$ math.",
      "",
      "$$\\int_0^1 x^2 dx$$",
      "",
      "<script>unsafe()</script>",
      "",
      "```ts",
      "const complete = true;",
      "```",
      "",
      "---",
    ].join("\n");
    const onCodeCopy = vi.fn();
    const onLinkActivate = vi.fn();
    const file = render(source, "file", { onCodeCopy, onLinkActivate });
    const message = render(source, "message");

    for (const root of [file.root, message.root]) {
      expect(root.querySelector("h1")?.textContent).toBe("Heading");
      expect(root.querySelector("blockquote")?.textContent).toContain("Quote");
      expect(root.querySelectorAll("[data-markdown-task-checkbox]")).toHaveLength(2);
      expect(root.querySelector("ol[data-markdown-nested-list]")).not.toBeNull();
      expect(root.querySelectorAll("table th")).toHaveLength(2);
      expect(root.querySelectorAll("table td")).toHaveLength(2);
      expect(root.querySelector("img")?.getAttribute("alt")).toBe("diagram");
      expect(root.querySelector("[data-markdown-block-kind='mermaid']")).not.toBeNull();
      expect(root.querySelectorAll("[data-markdown-math]").length).toBeGreaterThanOrEqual(2);
      expect(root.querySelector("[data-markdown-html-policy='escaped']")?.textContent).toContain("script");
      expect(root.querySelector("pre code.language-ts")?.textContent).toContain("complete");
      expect(root.querySelector("hr")).not.toBeNull();
      expect(root.querySelector("script,iframe")).toBeNull();
      expect(root.querySelector("a[href^='javascript:']")).toBeNull();
    }
    expect(semanticText(file.root)).toBe(semanticText(message.root));
    expect(file.snapshot.blocks.map((block) => block.kind)).toEqual(message.snapshot.blocks.map((block) => block.kind));
    file.root.querySelector("pre code.language-ts")!
      .closest<HTMLElement>("[data-markdown-block-id]")!
      .querySelector<HTMLButtonElement>("[data-markdown-code-copy]")!
      .click();
    file.root.querySelector<HTMLAnchorElement>("a[href='https://example.test']")!.click();
    expect(onCodeCopy).toHaveBeenCalledWith(expect.objectContaining({ code: "const complete = true;" }));
    expect(onLinkActivate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({
      href: "https://example.test",
    }));

    file.destroy();
    message.destroy();
  });

  it("isolates a special-block renderer failure without hiding healthy expensive blocks", () => {
    const source = "# Before\n\n```mermaid\nbroken\n```\n\n$$x^2$$\n\n| A |\n|---|\n| B |\n\n# After";
    const snapshot = parse(source, "file");
    const root = createRoot();
    const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, {
      mermaid: { create: () => { throw new Error("synthetic Mermaid failure"); } },
    });
    const renderer = new RetainedMarkdownDocumentRenderer(root, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      registry,
    });
    const stats = renderer.render(snapshot);

    expect(stats.failed).toBe(1);
    expect(root.querySelector("[data-markdown-block-error='true']")?.textContent).toContain("broken");
    expect(root.querySelectorAll("h1")).toHaveLength(2);
    expect(root.querySelector("[data-markdown-math]")).not.toBeNull();
    expect(root.querySelector("table td")?.textContent).toBe("B");
    renderer.destroy();
  });

  it("keeps a two-million-character code block and ten-thousand-row table DOM bounded", () => {
    const code = "x".repeat(2_000_000);
    const rows = Array.from({ length: 10_000 }, (_, index) => `| ${index} | value ${index} |`).join("\n");
    const source = `\`\`\`text\n${code}\n\`\`\`\n\n| Row | Value |\n|---|---|\n${rows}`;
    const run = render(source, "file");
    const codeElement = run.root.querySelector("pre code")!;
    const table = run.root.querySelector<HTMLElement>("[data-markdown-table-virtual='true']")
      ?? run.root.querySelector<HTMLElement>("[data-markdown-block-kind='table']")!;

    expect(codeElement.textContent).toBe(code);
    expect(codeElement.childNodes.length).toBeLessThan(40);
    expect(table.querySelectorAll("tbody tr").length).toBeLessThan(200);
    expect(table.querySelectorAll("canvas")).toHaveLength(0);
    expect(run.snapshot.blocks.map((block) => block.kind)).toEqual(["code", "table"]);
    run.destroy();
  }, 30_000);
});

function render(
  source: string,
  surface: "file" | "message",
  interactions: ConstructorParameters<typeof RetainedMarkdownDocumentRenderer>[1]["interactions"] = {},
) {
  const snapshot = parse(source, surface);
  const root = createRoot();
  const renderer = new RetainedMarkdownDocumentRenderer(root, {
    profile: surface === "file" ? FILE_MARKDOWN_RENDERER_PROFILE : CONVERSATION_MARKDOWN_RENDERER_PROFILE,
    interactions,
  });
  renderer.render(snapshot);
  return { root, snapshot, renderer, destroy: () => renderer.destroy() };
}

function parse(source: string, surface: "file" | "message") {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:special-blocks.md`,
    revision: `${surface}-r1`,
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  });
}

function createRoot() {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  return root;
}

function semanticText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("button").forEach((button) => button.remove());
  return copy.textContent ?? "";
}
