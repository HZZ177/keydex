import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import { stableMarkdownIdentityHash } from "../document/identity";
import { markdownLogicalOffsetToSource } from "../mapping";

export interface MarkdownFindOptions {
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly limit?: number;
  readonly shouldCancel?: () => boolean;
}

export interface MarkdownFindMatch {
  readonly id: string;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly blockLocalStart: number;
  readonly blockLocalEnd: number;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly matchText: string;
  readonly snippet: string;
}

export interface MarkdownFindIndex {
  readonly revision: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly limited: boolean;
  readonly matches: readonly MarkdownFindMatch[];
}

export class MarkdownFindCancelledError extends Error {
  constructor() {
    super("Markdown find cancelled");
    this.name = "AbortError";
  }
}

export function buildMarkdownFindIndex(
  snapshot: MarkdownSnapshot,
  query: string,
  options: MarkdownFindOptions = {},
): MarkdownFindIndex {
  const normalizedQuery = query.trim();
  const caseSensitive = options.caseSensitive ?? false;
  const wholeWord = options.wholeWord ?? false;
  const limit = options.limit ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Markdown find limit must be non-negative");
  if (!normalizedQuery || limit === 0) {
    return freezeIndex(snapshot.revision, normalizedQuery, caseSensitive, wholeWord, false, []);
  }
  // Rendered selections may contain a visual line break where an equivalent
  // paragraph contains a space. Keep non-whitespace characters literal while
  // treating each query whitespace run as one-or-more whitespace characters.
  const expression = new RegExp(
    normalizedQuery.split(/\s+/gu).map(escapeRegExp).join("\\s+"),
    caseSensitive ? "gu" : "giu",
  );
  const matches: MarkdownFindMatch[] = [];
  const queryHash = stableMarkdownIdentityHash(`${caseSensitive}:${wholeWord}:${normalizedQuery}`);
  let limited = false;
  for (const block of snapshot.blocks) {
    checkpoint(options);
    const text = snapshot.logical_text.slice(block.logical_start, block.logical_end);
    expression.lastIndex = 0;
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      if (wholeWord && !isWholeWord(text, match.index, match.index + match[0].length)) continue;
      const logicalStart = block.logical_start + match.index;
      const logicalEnd = logicalStart + match[0].length;
      const sourceStart = markdownLogicalOffsetToSource(block, logicalStart, "forward");
      const sourceEnd = markdownLogicalOffsetToSource(block, logicalEnd, "backward");
      matches.push(Object.freeze({
        id: `md-find-${queryHash}-${block.id}-${match.index}`,
        blockId: block.id,
        blockIndex: block.index,
        blockLocalStart: match.index,
        blockLocalEnd: match.index + match[0].length,
        logicalStart,
        logicalEnd,
        sourceStart,
        sourceEnd,
        matchText: match[0],
        snippet: snippet(text, match.index, match.index + match[0].length),
      }));
      if (matches.length >= limit) {
        limited = true;
        return freezeIndex(snapshot.revision, normalizedQuery, caseSensitive, wholeWord, limited, matches);
      }
      if ((matches.length & 1023) === 0) checkpoint(options);
    }
  }
  return freezeIndex(snapshot.revision, normalizedQuery, caseSensitive, wholeWord, limited, matches);
}

function freezeIndex(
  revision: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  limited: boolean,
  matches: readonly MarkdownFindMatch[],
): MarkdownFindIndex {
  return Object.freeze({
    revision,
    query,
    caseSensitive,
    wholeWord,
    limited,
    matches: Object.freeze([...matches]),
  });
}

function isWholeWord(value: string, start: number, end: number): boolean {
  return !isWordCodePoint(codePointBefore(value, start)) && !isWordCodePoint(value.codePointAt(end));
}

function codePointBefore(value: string, offset: number): number | undefined {
  if (offset <= 0) return undefined;
  const previous = value.charCodeAt(offset - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && offset >= 2) return value.codePointAt(offset - 2);
  return previous;
}

function isWordCodePoint(value: number | undefined): boolean {
  return value !== undefined && /[\p{Letter}\p{Number}_]/u.test(String.fromCodePoint(value));
}

function snippet(value: string, start: number, end: number): string {
  return value.slice(Math.max(0, start - 32), Math.min(value.length, end + 32)).replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function checkpoint(options: MarkdownFindOptions): void {
  if (options.shouldCancel?.()) throw new MarkdownFindCancelledError();
}
