import type { TextSelector } from "@/runtime/annotations";

import { freezeRange, type DocumentTextModel, type LogicalRange } from "../document/DocumentTextModel";

export type TextAnchorResolution =
  | {
      readonly status: "resolved";
      readonly range: LogicalRange;
      readonly strategy: "position" | "unique-quote" | "quote-context" | "document-context";
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

  const candidates = exactMatches(model.logicalText, exact);
  if (candidates.length === 0) {
    return Object.freeze({ status: "changed" });
  }
  if (candidates.length === 1) {
    return resolved(candidates[0], "unique-quote");
  }

  const quoteContextMatches = candidates.filter((candidate) =>
    prefixMatches(model.logicalText, candidate, selector.quote.prefix)
    && suffixMatches(model.logicalText, candidate, selector.quote.suffix));
  if (quoteContextMatches.length === 1) {
    return resolved(quoteContextMatches[0], "quote-context");
  }

  const documentContextPool = quoteContextMatches.length > 0 ? quoteContextMatches : candidates;
  const documentContextMatches = documentContextPool.filter((candidate) =>
    contextMatches(model, candidate, selector));
  if (documentContextMatches.length === 1) {
    return resolved(documentContextMatches[0], "document-context");
  }

  return Object.freeze({
    status: "ambiguous",
    candidates: Object.freeze(candidates.map(freezeRange)),
  });
}

function exactMatches(text: string, exact: string): LogicalRange[] {
  const matches: LogicalRange[] = [];
  let cursor = 0;
  while (cursor <= text.length - exact.length) {
    const start = text.indexOf(exact, cursor);
    if (start < 0) {
      break;
    }
    matches.push({ start, end: start + exact.length });
    cursor = start + 1;
  }
  return matches;
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
