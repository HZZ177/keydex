import type { WebActivitySource } from "@/types/protocol";

import { sourceNumbersByFirstReference, type WebTurnSourceRegistry } from "./webSourceRegistry";

const SOURCE_MARKER_PATTERN = /\[\[[\t ]*source[\t ]*[:：][\t ]*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})[\t ]*\]\]|【【[\t ]*source[\t ]*[:：][\t ]*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})[\t ]*】】/giu;
const SOURCE_HREF_PREFIX = "#keydex-web-source=";

export interface WebSourceCitation {
  sourceId: string;
  sourceIds: readonly string[];
  number: number;
  source: WebActivitySource;
}

export interface WebSourceMarkerProjection {
  markdown: string;
  referencedSourceIds: readonly string[];
  citations: readonly WebSourceCitation[];
}

export function projectWebSourceMarkers(
  source: string,
  registry: WebTurnSourceRegistry,
): WebSourceMarkerProjection {
  const protectedRanges = markdownProtectedRanges(source);
  const matches: SourceMarkerMatch[] = [];
  SOURCE_MARKER_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(SOURCE_MARKER_PATTERN)) {
    const index = match.index;
    const raw = match[0];
    const sourceId = match[1] ?? match[2];
    if (
      index === undefined ||
      isEscaped(source, index) ||
      rangeIsProtected(index, index + raw.length, protectedRanges)
    ) {
      continue;
    }
    const registeredSourceId = registry.bySourceId.has(sourceId) ? sourceId : null;
    matches.push({
      start: registeredSourceId ? index : unknownMarkerRemovalStart(source, index),
      end: index + raw.length,
      sourceId: registeredSourceId,
    });
  }

  const referencedSourceIds = matches.flatMap((match) => (
    match.sourceId ? [match.sourceId] : []
  ));
  const numberBySourceId = sourceNumbersByFirstReference(registry, referencedSourceIds);
  const citationsByNumber = new Map<number, WebSourceCitation>();
  let cursor = 0;
  let markdown = "";
  for (const match of matches) {
    if (!match.sourceId) {
      markdown += source.slice(cursor, match.start);
      cursor = match.end;
      continue;
    }
    const number = numberBySourceId.get(match.sourceId);
    const webSource = registry.bySourceId.get(match.sourceId);
    if (!number || !webSource) {
      continue;
    }
    markdown += source.slice(cursor, match.start);
    markdown += `[${number}](${webSourceCitationHref(match.sourceId)})`;
    cursor = match.end;
    const existingCitation = citationsByNumber.get(number);
    if (!existingCitation) {
      citationsByNumber.set(number, {
        sourceId: match.sourceId,
        sourceIds: [match.sourceId],
        number,
        source: webSource,
      });
    } else if (!existingCitation.sourceIds.includes(match.sourceId)) {
      citationsByNumber.set(number, {
        ...existingCitation,
        sourceIds: [...existingCitation.sourceIds, match.sourceId],
      });
    }
  }
  markdown += source.slice(cursor);

  return {
    markdown,
    referencedSourceIds,
    citations: [...citationsByNumber.values()],
  };
}

export function webSourceCitationHref(sourceId: string): string {
  return `${SOURCE_HREF_PREFIX}${encodeURIComponent(sourceId)}`;
}

export function webSourceIdFromCitationHref(href: string): string | null {
  const value = href.trim();
  if (!value.startsWith(SOURCE_HREF_PREFIX)) {
    return null;
  }
  try {
    const sourceId = decodeURIComponent(value.slice(SOURCE_HREF_PREFIX.length));
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sourceId) ? sourceId : null;
  } catch {
    return null;
  }
}

interface SourceMarkerMatch {
  start: number;
  end: number;
  sourceId: string | null;
}

interface ProtectedRange {
  start: number;
  end: number;
}

function markdownProtectedRanges(source: string): ProtectedRange[] {
  const ranges = fencedCodeRanges(source);
  ranges.push(...inlineCodeRanges(source, ranges));
  ranges.push(...markdownLinkRanges(source));
  return ranges.sort((left, right) => left.start - right.start);
}

function fencedCodeRanges(source: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const lines = source.matchAll(/.*(?:\r?\n|$)/gu);
  let opening: { start: number; marker: string; length: number } | null = null;
  for (const lineMatch of lines) {
    const start = lineMatch.index ?? 0;
    const line = lineMatch[0].replace(/\r?\n$/u, "");
    if (!lineMatch[0]) continue;
    if (!opening) {
      const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (match) opening = { start, marker: match[1][0], length: match[1].length };
      continue;
    }
    const closingPattern = new RegExp(`^ {0,3}${escapeRegExp(opening.marker)}{${opening.length},}[\\t ]*$`, "u");
    if (closingPattern.test(line)) {
      ranges.push({ start: opening.start, end: start + lineMatch[0].length });
      opening = null;
    }
  }
  if (opening) ranges.push({ start: opening.start, end: source.length });
  return ranges;
}

function inlineCodeRanges(source: string, existing: readonly ProtectedRange[]): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  for (let index = 0; index < source.length;) {
    const protectedRange = containingRange(index, existing);
    if (protectedRange) {
      index = protectedRange.end;
      continue;
    }
    if (source[index] !== "`") {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (source[index + runLength] === "`") runLength += 1;
    const marker = "`".repeat(runLength);
    const closing = source.indexOf(marker, index + runLength);
    if (closing < 0 || rangeIsProtected(closing, closing + runLength, existing)) {
      index += runLength;
      continue;
    }
    ranges.push({ start: index, end: closing + runLength });
    index = closing + runLength;
  }
  return ranges;
}

function markdownLinkRanges(source: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  for (let close = 0; close < source.length - 1; close += 1) {
    if (source[close] !== "]" || (source[close + 1] !== "(" && source[close + 1] !== "[")) continue;
    const start = findOpeningBracket(source, close);
    if (start < 0) continue;
    if (source[close + 1] === "(") {
      const end = findClosingDelimiter(source, close + 1, "(", ")");
      if (end >= 0) ranges.push({ start: source[start - 1] === "!" ? start - 1 : start, end: end + 1 });
      continue;
    }
    const referenceEnd = source.indexOf("]", close + 2);
    if (referenceEnd >= 0 && !source.slice(close + 2, referenceEnd).includes("\n")) {
      ranges.push({ start: source[start - 1] === "!" ? start - 1 : start, end: referenceEnd + 1 });
    }
  }
  return ranges;
}

function findOpeningBracket(source: string, close: number): number {
  let depth = 1;
  for (let cursor = close - 1; cursor >= 0 && source[cursor] !== "\n"; cursor -= 1) {
    if (isEscaped(source, cursor)) continue;
    if (source[cursor] === "]") depth += 1;
    if (source[cursor] === "[") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function findClosingDelimiter(
  source: string,
  openingIndex: number,
  opening: string,
  closing: string,
): number {
  let depth = 1;
  for (let cursor = openingIndex + 1; cursor < source.length && source[cursor] !== "\n"; cursor += 1) {
    if (isEscaped(source, cursor)) continue;
    if (source[cursor] === opening) depth += 1;
    if (source[cursor] === closing) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function rangeIsProtected(start: number, end: number, ranges: readonly ProtectedRange[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function containingRange(index: number, ranges: readonly ProtectedRange[]): ProtectedRange | null {
  return ranges.find((range) => index >= range.start && index < range.end) ?? null;
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function unknownMarkerRemovalStart(source: string, markerStart: number): number {
  return markerStart > 0 && (source[markerStart - 1] === " " || source[markerStart - 1] === "\t")
    ? markerStart - 1
    : markerStart;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
