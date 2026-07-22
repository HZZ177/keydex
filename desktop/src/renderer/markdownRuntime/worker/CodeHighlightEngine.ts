import lowlight, { type HighlightLanguageGrammar, type LowlightNode } from "lowlight/lib/core";

import type {
  MarkdownCodeHighlightLanguage,
  MarkdownCodeToken,
  MarkdownCodeTokenKind,
} from "../renderers/CodeHighlightProtocol";

export interface MarkdownCodeGrammarHighlightInput {
  readonly language: MarkdownCodeHighlightLanguage;
  readonly code: string;
  readonly maxTokens: number;
  readonly sourceTruncated?: boolean;
}

export interface MarkdownCodeGrammarHighlightResult {
  readonly language: MarkdownCodeHighlightLanguage;
  readonly tokens: readonly MarkdownCodeToken[];
  readonly truncated: boolean;
}

const languageLoads = new Map<MarkdownCodeHighlightLanguage, Promise<void>>();

export async function highlightCodeWithGrammar(
  input: MarkdownCodeGrammarHighlightInput,
): Promise<MarkdownCodeGrammarHighlightResult> {
  const maxTokens = positiveInteger(input.maxTokens, "maxTokens");
  await ensureLanguage(input.language);
  const tree = lowlight.highlight(input.language, input.code, { prefix: "hljs-" });
  const tokens: MarkdownCodeToken[] = [];
  const state = { cursor: 0, tokenLimitReached: false };
  visitNodes(tree.value, null, tokens, maxTokens, state);
  return Object.freeze({
    language: input.language,
    tokens: Object.freeze(tokens),
    truncated: input.sourceTruncated === true || state.tokenLimitReached,
  });
}

async function ensureLanguage(language: MarkdownCodeHighlightLanguage): Promise<void> {
  const existing = languageLoads.get(language);
  if (existing) return existing;
  const load = LANGUAGE_LOADERS[language]().then((module) => {
    lowlight.registerLanguage(language, module.default);
  }).catch((error) => {
    languageLoads.delete(language);
    throw error;
  });
  languageLoads.set(language, load);
  return load;
}

function visitNodes(
  nodes: readonly LowlightNode[],
  inheritedKind: MarkdownCodeTokenKind | null,
  tokens: MarkdownCodeToken[],
  maxTokens: number,
  state: { cursor: number; tokenLimitReached: boolean },
): boolean {
  for (const node of nodes) {
    if (node.type === "text") {
      const start = state.cursor;
      state.cursor += node.value.length;
      if (inheritedKind && node.value.length > 0 && !appendToken(tokens, start, state.cursor, inheritedKind, maxTokens)) {
        state.tokenLimitReached = true;
        return false;
      }
      continue;
    }
    const kind = tokenKindForClasses(node.properties?.className) ?? inheritedKind;
    if (!visitNodes(node.children, kind, tokens, maxTokens, state)) return false;
  }
  return true;
}

function appendToken(
  tokens: MarkdownCodeToken[],
  start: number,
  end: number,
  kind: MarkdownCodeTokenKind,
  maxTokens: number,
): boolean {
  const previous = tokens.at(-1);
  if (previous?.kind === kind && previous.end === start) {
    tokens[tokens.length - 1] = Object.freeze({ start: previous.start, end, kind });
    return true;
  }
  if (tokens.length >= maxTokens) return false;
  tokens.push(Object.freeze({ start, end, kind }));
  return true;
}

function tokenKindForClasses(classes: readonly string[] | undefined): MarkdownCodeTokenKind | null {
  if (!classes?.length) return null;
  for (const className of classes) {
    const normalized = className.replace(/^hljs-/u, "").replace(/_/gu, "-").toLowerCase();
    const kind = TOKEN_KIND_BY_CLASS.get(normalized);
    if (kind) return kind;
  }
  return null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

const TOKEN_KIND_BY_CLASS = new Map<string, MarkdownCodeTokenKind>([
  ["addition", "addition"],
  ["attr", "attribute"],
  ["attribute", "attribute"],
  ["built-in", "type"],
  ["bullet", "literal"],
  ["class", "type"],
  ["code", "string"],
  ["comment", "comment"],
  ["deletion", "deletion"],
  ["doctag", "keyword"],
  ["formula", "regexp"],
  ["function", "function"],
  ["keyword", "keyword"],
  ["link", "literal"],
  ["literal", "literal"],
  ["meta", "meta"],
  ["meta-keyword", "meta"],
  ["name", "tag"],
  ["number", "number"],
  ["operator", "operator"],
  ["params", "variable"],
  ["property", "property"],
  ["punctuation", "punctuation"],
  ["quote", "comment"],
  ["regexp", "regexp"],
  ["section", "keyword"],
  ["selector-attr", "selector"],
  ["selector-class", "selector"],
  ["selector-id", "selector"],
  ["selector-pseudo", "selector"],
  ["selector-tag", "tag"],
  ["string", "string"],
  ["symbol", "literal"],
  ["tag", "tag"],
  ["template-tag", "keyword"],
  ["template-variable", "variable"],
  ["title", "function"],
  ["type", "type"],
  ["variable", "variable"],
]);

type GrammarModule = { readonly default: HighlightLanguageGrammar };
type GrammarLoader = () => Promise<GrammarModule>;

const LANGUAGE_LOADERS = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  pgsql: () => import("highlight.js/lib/languages/pgsql"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  properties: () => import("highlight.js/lib/languages/properties"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  vbnet: () => import("highlight.js/lib/languages/vbnet"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
} satisfies Record<MarkdownCodeHighlightLanguage, GrammarLoader>;
