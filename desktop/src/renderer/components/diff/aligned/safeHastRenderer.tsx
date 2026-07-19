import { Fragment, createElement, type ReactNode } from "react";

import type { PierreAlignedAstNode } from "../engine/pierreAlignedAdapter";
import type { DiffTokenNode } from "./alignedDiffModel";

export function sanitizePierreAlignedAst(
  node: PierreAlignedAstNode | undefined,
): readonly DiffTokenNode[] {
  if (!node) return Object.freeze([]);
  if (node.type === "text") {
    return Object.freeze([{ type: "text", value: stripLineEnding(node.value) }]);
  }
  if (node.type === "unknown" || node.tagName.toLowerCase() !== "span") {
    return Object.freeze(node.children.flatMap((child) => sanitizePierreAlignedAst(child)));
  }
  const classNames = classNamesFrom(node.properties.className);
  const attributes = safeAttributes(node.properties);
  return Object.freeze([Object.freeze({
    type: "span",
    classNames: Object.freeze(classNames),
    ...(Object.keys(attributes).length > 0 ? { attributes: Object.freeze(attributes) } : {}),
    children: Object.freeze(node.children.flatMap((child) => sanitizePierreAlignedAst(child))),
  })]);
}

export function SafeDiffTokens({ tokens }: { readonly tokens: readonly DiffTokenNode[] }) {
  return <>{renderSafeDiffTokens(tokens)}</>;
}

export function renderSafeDiffTokens(tokens: readonly DiffTokenNode[]): readonly ReactNode[] {
  return tokens.map((token, index) => {
    if (token.type === "text") return token.value;
    return createElement(
      "span",
      {
        key: index,
        ...(token.classNames.length > 0 ? { className: token.classNames.join(" ") } : {}),
        ...(token.attributes ?? {}),
      },
      createElement(Fragment, null, ...renderSafeDiffTokens(token.children)),
    );
  });
}

function classNamesFrom(value: string | number | boolean | readonly string[] | undefined): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/\s+/u) : [];
  return candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && !/[\u0000-\u001f\u007f]/u.test(candidate));
}

function safeAttributes(
  properties: Readonly<Record<string, string | number | boolean | readonly string[]>>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!/^(?:data|aria)-[a-z0-9_.:-]+$/u.test(name)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[name] = String(value);
    }
  }
  return safe;
}

function stripLineEnding(value: string): string {
  return value.replace(/\r?\n$/u, "");
}
