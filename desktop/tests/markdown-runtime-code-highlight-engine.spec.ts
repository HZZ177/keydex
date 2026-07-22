import { describe, expect, it } from "vitest";

import {
  MARKDOWN_CODE_HIGHLIGHT_LANGUAGES,
  resolveMarkdownCodeHighlightLanguage,
} from "@/renderer/markdownRuntime/renderers/CodeHighlightProtocol";
import { highlightCodeWithGrammar } from "@/renderer/markdownRuntime/worker/CodeHighlightEngine";

describe("Markdown code grammar highlight engine", () => {
  it("highlights SQL keywords, strings, numbers, and comments with real grammar tokens", async () => {
    const code = "SELECT id, 'ready', 42 FROM jobs WHERE active = true; -- queued";
    const result = await highlightCodeWithGrammar({ language: "sql", code, maxTokens: 1_000 });

    expect(tokenTexts(code, result, "keyword")).toEqual(expect.arrayContaining(["SELECT", "FROM", "WHERE"]));
    expect(tokenTexts(code, result, "string")).toContain("'ready'");
    expect(tokenTexts(code, result, "number")).toContain("42");
    expect(tokenTexts(code, result, "comment")).toContain("-- queued");
    expect(result.truncated).toBe(false);
  });

  it.each([
    ["bash", "if test -f app.env; then echo \"ready\"; fi", "keyword", "if"],
    ["python", "def greet(name):\n    return f\"hello {name}\"", "keyword", "def"],
    ["rust", "fn main() { let ready = true; }", "keyword", "fn"],
  ] as const)("highlights %s with its own grammar", async (language, code, kind, token) => {
    const result = await highlightCodeWithGrammar({ language, code, maxTokens: 1_000 });
    expect(tokenTexts(code, result, kind)).toContain(token);
  });

  it("keeps grammar output bounded by the token limit", async () => {
    const code = Array.from({ length: 100 }, (_, index) => `SELECT ${index} FROM table_${index};`).join("\n");
    const result = await highlightCodeWithGrammar({ language: "sql", code, maxTokens: 8 });
    expect(result.tokens.length).toBeLessThanOrEqual(8);
    expect(result.truncated).toBe(true);
  });

  it("normalizes common aliases without eagerly importing their grammars", () => {
    expect(resolveMarkdownCodeHighlightLanguage("SQL")).toBe("sql");
    expect(resolveMarkdownCodeHighlightLanguage("sh")).toBe("bash");
    expect(resolveMarkdownCodeHighlightLanguage("tsx")).toBe("typescript");
    expect(resolveMarkdownCodeHighlightLanguage("c++")).toBe("cpp");
    expect(resolveMarkdownCodeHighlightLanguage("toml")).toBe("ini");
    expect(resolveMarkdownCodeHighlightLanguage("unknown-language")).toBeNull();
    expect(MARKDOWN_CODE_HIGHLIGHT_LANGUAGES).toContain("sql");
    expect(MARKDOWN_CODE_HIGHLIGHT_LANGUAGES.length).toBeGreaterThanOrEqual(30);
  });
});

function tokenTexts(
  code: string,
  result: Awaited<ReturnType<typeof highlightCodeWithGrammar>>,
  kind: string,
): string[] {
  return result.tokens
    .filter((token) => token.kind === kind)
    .map((token) => code.slice(token.start, token.end));
}
