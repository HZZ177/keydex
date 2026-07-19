import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SafeDiffTokens,
  sanitizePierreAlignedAst,
} from "@/renderer/components/diff/aligned/safeHastRenderer";
import type { PierreAlignedAstNode } from "@/renderer/components/diff/engine/pierreAlignedAdapter";

describe("safe Pierre HAST renderer", () => {
  it("preserves text, whitespace, Unicode and nested span token classes", () => {
    const ast: PierreAlignedAstNode = {
      type: "element",
      tagName: "span",
      properties: { className: ["line", "language-ts"], "data-token": "keyword" },
      children: [
        { type: "text", value: "  const " },
        {
          type: "element",
          tagName: "span",
          properties: { className: "pl-k", "aria-label": "关键字" },
          children: [{ type: "text", value: "你好 & <Keydex>\n" }],
        },
      ],
    };
    const tokens = sanitizePierreAlignedAst(ast);
    expect(tokens).toEqual([{
      type: "span",
      classNames: ["line", "language-ts"],
      attributes: { "data-token": "keyword" },
      children: [
        { type: "text", value: "  const " },
        {
          type: "span",
          classNames: ["pl-k"],
          attributes: { "aria-label": "关键字" },
          children: [{ type: "text", value: "你好 & <Keydex>" }],
        },
      ],
    }]);
    const markup = renderToStaticMarkup(<SafeDiffTokens tokens={tokens} />);
    expect(markup).toContain("你好 &amp; &lt;Keydex&gt;");
    expect(markup).toContain("class=\"line language-ts\"");
  });

  it("flattens non-span tags and strips style, events, URLs and unknown properties", () => {
    const ast = {
      type: "element",
      tagName: "script",
      properties: {
        className: ["outer"],
        style: "color:red",
        onClick: "steal()",
        href: "javascript:steal()",
        "data-safe": "yes",
      },
      children: [{
        type: "element",
        tagName: "span",
        properties: {
          className: ["token"],
          style: "background:red",
          onMouseOver: "steal()",
          "data-kind": "word",
        },
        children: [{ type: "text", value: "safe text" }],
      }],
    } as PierreAlignedAstNode;
    const tokens = sanitizePierreAlignedAst(ast);
    const markup = renderToStaticMarkup(<SafeDiffTokens tokens={tokens} />);
    expect(markup).toBe('<span class="token" data-kind="word">safe text</span>');
    expect(markup).not.toMatch(/script|style|onclick|onmouseover|href|javascript/iu);
  });

  it("renders unknown nodes as safe text descendants without HTML injection", () => {
    const tokens = sanitizePierreAlignedAst({
      type: "unknown",
      children: [{ type: "text", value: '<img src=x onerror="bad()">' }],
    });
    const { container } = render(<SafeDiffTokens tokens={tokens} />);
    expect(container.textContent).toBe('<img src=x onerror="bad()">');
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not contain an HTML injection escape hatch", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/safeHastRenderer.tsx"),
      "utf8",
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("innerHTML =");
  });
});
