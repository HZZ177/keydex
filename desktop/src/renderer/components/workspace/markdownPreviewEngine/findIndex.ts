import type { MarkdownBlock, MarkdownDocumentModel } from "./types";
import { markdownLineColumnAtOffset } from "./sourceMap";

export interface MarkdownFindMatch {
  blockId: string;
  blockIndex: number;
  blockLocalEnd: number;
  blockLocalStart: number;
  id: string;
  lineEnd: number;
  lineStart: number;
  matchText: string;
  snippet: string;
  sourceEnd: number;
  sourceStart: number;
}

export interface MarkdownFindIndex {
  matches: MarkdownFindMatch[];
  query: string;
}

export function buildMarkdownFindIndex(model: MarkdownDocumentModel, query: string): MarkdownFindIndex {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { matches: [], query: "" };
  }
  const matches: MarkdownFindMatch[] = [];
  for (const block of model.blocks) {
    matches.push(...findMatchesInBlock(model.source, block, normalizedQuery, matches.length));
  }
  return {
    matches,
    query: normalizedQuery,
  };
}

function findMatchesInBlock(source: string, block: MarkdownBlock, query: string, offset: number): MarkdownFindMatch[] {
  const matches: MarkdownFindMatch[] = [];
  const haystack = block.sourceText.toLowerCase();
  const needle = query.toLowerCase();
  let localStart = haystack.indexOf(needle);
  while (localStart >= 0) {
    const localEnd = localStart + query.length;
    const sourceStart = block.sourceStart + localStart;
    const sourceEnd = block.sourceStart + localEnd;
    const startPosition = markdownLineColumnAtOffset(source, sourceStart);
    const endPosition = markdownLineColumnAtOffset(source, sourceEnd);
    matches.push({
      blockId: block.id,
      blockIndex: block.index,
      blockLocalEnd: localEnd,
      blockLocalStart: localStart,
      id: `md-find-${offset + matches.length + 1}`,
      lineEnd: endPosition.line,
      lineStart: startPosition.line,
      matchText: block.sourceText.slice(localStart, localEnd),
      snippet: findSnippet(block.sourceText, localStart, localEnd),
      sourceEnd,
      sourceStart,
    });
    localStart = haystack.indexOf(needle, localStart + Math.max(query.length, 1));
  }
  return matches;
}

function findSnippet(value: string, start: number, end: number): string {
  const context = 32;
  const snippetStart = Math.max(0, start - context);
  const snippetEnd = Math.min(value.length, end + context);
  return value.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim();
}
