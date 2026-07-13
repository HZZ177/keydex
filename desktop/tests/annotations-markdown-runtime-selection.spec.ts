import { describe, expect, it } from "vitest";

import { annotationSelectionFromMarkdownRuntime } from "@/renderer/features/annotations/state/markdownRuntimeSelection";
import { createMarkdownTextModel } from "./fixtures/annotationMarkdown";
import type { MarkdownProjectedSelection } from "@/renderer/markdownRuntime/interaction/SelectionController";

describe("annotation selection bridge for retained Markdown runtime", () => {
  it("accepts the runtime logical projection without reading DOM", () => {
    const model = createMarkdownTextModel("Alpha\n\nBeta target", "sha256:r1");
    const start = model.logicalText.indexOf("Alpha");
    const end = model.logicalText.indexOf("target") + 6;
    const selection = projectedSelection("sha256:r1", model.logicalText.slice(start, end), start, end);

    expect(annotationSelectionFromMarkdownRuntime(selection, model)).toEqual({
      coordinateSpace: "logical",
      range: { start, end },
    });
  });

  it("rejects stale revisions, empty projections, and mismatched logical text", () => {
    const model = createMarkdownTextModel("Alpha target", "sha256:r1");
    expect(annotationSelectionFromMarkdownRuntime(projectedSelection("sha256:old", "Alpha", 0, 5), model)).toBeNull();
    expect(annotationSelectionFromMarkdownRuntime(projectedSelection("sha256:r1", "", 2, 2), model)).toBeNull();
    expect(annotationSelectionFromMarkdownRuntime(projectedSelection("sha256:r1", "wrong", 0, 5), model)).toBeNull();
  });
});

function projectedSelection(
  revision: string,
  logicalText: string,
  start: number,
  end: number,
): MarkdownProjectedSelection {
  return {
    revision,
    direction: "forward",
    nativeText: logicalText,
    logicalText,
    logicalStart: start,
    logicalEnd: end,
    sourceStart: start,
    sourceEnd: end,
    blockRanges: [],
    pinnedBlockIds: [],
    pinnedIndices: new Set(),
    anchor: { blockId: "block-a", blockLocalLogicalOffset: 0 },
    focus: { blockId: "block-b", blockLocalLogicalOffset: end - start },
    annotationSelection: { coordinateSpace: "logical", range: { start, end } },
  };
}
