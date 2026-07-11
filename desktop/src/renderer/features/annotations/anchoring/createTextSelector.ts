import type { TextSelector } from "@/runtime/annotations";

import { assertUtf16Range, type DocumentTextModel, type LogicalRange } from "../document/DocumentTextModel";

export const TEXT_SELECTOR_CONTEXT_CHARACTERS = 64;

export function createTextSelector(
  model: DocumentTextModel,
  range: LogicalRange,
): TextSelector {
  assertUtf16Range(range, model.logicalText.length, "annotation range");
  if (range.end === range.start) {
    throw new RangeError("Annotation selection cannot be empty");
  }
  if (!isCodePointBoundary(model.logicalText, range.start)
    || !isCodePointBoundary(model.logicalText, range.end)) {
    throw new RangeError("Annotation selection cannot split a UTF-16 surrogate pair");
  }
  const exact = model.logicalText.slice(range.start, range.end);
  if (!exact.trim()) {
    throw new Error("Annotation selection cannot contain only whitespace");
  }
  const context = model.contextAt(range);
  const headingPath = [...context.headingPath];
  Object.freeze(headingPath);
  return Object.freeze({
    position: Object.freeze({ start: range.start, end: range.end }),
    quote: Object.freeze({
      exact,
      prefix: lastCodePoints(
        model.logicalText.slice(0, range.start),
        TEXT_SELECTOR_CONTEXT_CHARACTERS,
      ),
      suffix: firstCodePoints(
        model.logicalText.slice(range.end),
        TEXT_SELECTOR_CONTEXT_CHARACTERS,
      ),
    }),
    context: Object.freeze({
      containerType: context.containerType,
      headingPath,
    }),
    textRevision: model.revision.textRevision,
    documentRevision: model.revision.documentRevision,
  });
}

function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function lastCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(-limit).join("");
}

function isCodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) {
    return true;
  }
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
