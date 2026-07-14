import type { TextSelector } from "@/runtime/annotations";

import { freezeRange, type DocumentTextModel, type LogicalRange } from "../document/DocumentTextModel";

export type TextAnchorResolution =
  | {
      readonly status: "resolved";
      readonly range: LogicalRange;
      readonly strategy: "position" | "document-position" | "unique-quote" | "quote-context" | "document-context";
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly LogicalRange[];
    }
  | {
      readonly status: "changed";
    };

export function resolveTextAnchor(
  model: DocumentTextModel,
  selector: TextSelector,
): TextAnchorResolution {
  const exact = selector.quote.exact;
  if (!exact) {
    throw new Error("Text selector exact quote cannot be empty");
  }

  const original = selector.position;
  if (isRangeInside(original, model.logicalText.length)
    && model.logicalText.slice(original.start, original.end) === exact) {
    return resolved(original, "position");
  }

  const nearby = resolveSameDocumentProjectionDrift(model, selector);
  if (nearby) {
    return resolved(nearby, "document-position");
  }

  const candidates = exactMatches(model.logicalText, exact);
  if (candidates.total === 0) {
    return Object.freeze({ status: "changed" });
  }
  if (candidates.total === 1) {
    return resolved(candidates.ranges[0]!, "unique-quote");
  }

  const quoteContextMatches = exactMatches(
    model.logicalText,
    exact,
    (candidate) => prefixMatches(model.logicalText, candidate, selector.quote.prefix)
      && suffixMatches(model.logicalText, candidate, selector.quote.suffix),
  );
  if (quoteContextMatches.total === 1) {
    return resolved(quoteContextMatches.ranges[0]!, "quote-context");
  }

  const documentContextPool = quoteContextMatches.total > 0 ? quoteContextMatches : candidates;
  if (!documentContextPool.truncated) {
    const documentContextMatches = documentContextPool.ranges.filter((candidate) =>
      contextMatches(model, candidate, selector));
    if (documentContextMatches.length === 1) {
      return resolved(documentContextMatches[0], "document-context");
    }
  }

  return Object.freeze({
    status: "ambiguous",
    candidates: Object.freeze(candidates.ranges.map(freezeRange)),
  });
}

const SAME_DOCUMENT_DRIFT_RADIUS = 4_096;
const MAX_AMBIGUOUS_CANDIDATES = 16;

interface ExactMatchSearch {
  readonly ranges: readonly LogicalRange[];
  readonly total: number;
  readonly truncated: boolean;
}

function resolveSameDocumentProjectionDrift(
  model: DocumentTextModel,
  selector: TextSelector,
): LogicalRange | null {
  if (selector.documentRevision !== model.revision.documentRevision
    || selector.textRevision === model.revision.textRevision) {
    return null;
  }
  const origin = selector.position.start;
  if (!Number.isSafeInteger(origin)) return null;
  const start = Math.max(0, origin - SAME_DOCUMENT_DRIFT_RADIUS);
  const end = Math.min(model.logicalText.length, origin + SAME_DOCUMENT_DRIFT_RADIUS);
  const quoteMatch = nearestExactMatch(
    model.logicalText,
    selector.quote.exact,
    origin,
    start,
    end,
    (candidate) => prefixMatches(model.logicalText, candidate, selector.quote.prefix)
      && suffixMatches(model.logicalText, candidate, selector.quote.suffix),
  );
  return quoteMatch ?? nearestExactMatch(
    model.logicalText,
    selector.quote.exact,
    origin,
    start,
    end,
  );
}

function nearestExactMatch(
  text: string,
  exact: string,
  origin: number,
  start: number,
  end: number,
  predicate: (candidate: LogicalRange) => boolean = () => true,
): LogicalRange | null {
  let best: LogicalRange | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;
  let cursor = start;
  while (cursor <= end - exact.length) {
    const matchStart = text.indexOf(exact, cursor);
    if (matchStart < 0 || matchStart > end - exact.length) break;
    const candidate = { start: matchStart, end: matchStart + exact.length };
    if (predicate(candidate)) {
      const distance = Math.abs(matchStart - origin);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
        tied = false;
      } else if (distance === bestDistance) {
        tied = true;
      }
    }
    cursor = matchStart + 1;
  }
  return tied ? null : best;
}

function exactMatches(
  text: string,
  exact: string,
  predicate: (candidate: LogicalRange) => boolean = () => true,
): ExactMatchSearch {
  const ranges: LogicalRange[] = [];
  let total = 0;
  let cursor = 0;
  while (cursor <= text.length - exact.length) {
    const start = text.indexOf(exact, cursor);
    if (start < 0) {
      break;
    }
    const candidate = { start, end: start + exact.length };
    if (predicate(candidate)) {
      total += 1;
      if (ranges.length < MAX_AMBIGUOUS_CANDIDATES) ranges.push(candidate);
    }
    cursor = start + 1;
  }
  return Object.freeze({
    ranges: Object.freeze(ranges),
    total,
    truncated: total > ranges.length,
  });
}

function prefixMatches(text: string, candidate: LogicalRange, prefix: string): boolean {
  if (!prefix) {
    return true;
  }
  return text.slice(Math.max(0, candidate.start - prefix.length), candidate.start) === prefix;
}

function suffixMatches(text: string, candidate: LogicalRange, suffix: string): boolean {
  if (!suffix) {
    return true;
  }
  return text.slice(candidate.end, candidate.end + suffix.length) === suffix;
}

function contextMatches(
  model: DocumentTextModel,
  candidate: LogicalRange,
  selector: TextSelector,
): boolean {
  const context = model.contextAt(candidate);
  return context.containerType === selector.context.containerType
    && sameStrings(context.headingPath, selector.context.headingPath);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRangeInside(range: LogicalRange, length: number): boolean {
  return Number.isSafeInteger(range.start)
    && Number.isSafeInteger(range.end)
    && range.start >= 0
    && range.end > range.start
    && range.end <= length;
}

function resolved(
  range: LogicalRange,
  strategy: Extract<TextAnchorResolution, { status: "resolved" }>["strategy"],
): TextAnchorResolution {
  return Object.freeze({ status: "resolved", range: freezeRange(range), strategy });
}
