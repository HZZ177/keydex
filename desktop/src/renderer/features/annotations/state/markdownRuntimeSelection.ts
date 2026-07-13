import type { MarkdownProjectedSelection } from "@/renderer/markdownRuntime/interaction/SelectionController";

import type { DocumentSelection, DocumentTextModel } from "../document/DocumentTextModel";

/** Bridges the new retained Markdown runtime selection into the existing
 * annotation store without reading or reconstructing text from DOM. */
export function annotationSelectionFromMarkdownRuntime(
  selection: MarkdownProjectedSelection | null,
  model: DocumentTextModel | null,
): DocumentSelection | null {
  if (!selection || !model || model.kind !== "markdown") return null;
  if (selection.revision !== model.revision.documentRevision) return null;
  const { start, end } = selection.annotationSelection.range;
  if (start < 0 || end <= start || end > model.logicalText.length) return null;
  if (model.logicalText.slice(start, end) !== selection.logicalText) return null;
  return Object.freeze({
    coordinateSpace: "logical" as const,
    range: Object.freeze({ start, end }),
  });
}
