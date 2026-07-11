import { describe, expect, it } from "vitest";

import { markdownLogicalRangeFromDomRange } from "@/renderer/components/workspace/markdownPreviewEngine/selectionRange";
import { createMarkdownTextModel } from "@/renderer/features/annotations/document/MarkdownTextModel";

describe("MarkdownTextModel", () => {
  it("projects logical ranges to one or more exact visible source ranges", () => {
    const source = "# Guide\n\nThis is **bold** and [link](https://example.com).";
    const model = createMarkdownTextModel(source, "sha256:source");
    const start = model.logicalText.indexOf("bold");
    const end = model.logicalText.indexOf("link") + "link".length;
    const ranges = model.toSourceRanges({ start, end });

    expect(ranges.map((range) => source.slice(range.start, range.end)).join("")).toBe("bold and link");
    expect(ranges.length).toBeGreaterThan(1);
    expect(model.projectView({ start, end }).blockRanges).toHaveLength(1);
  });

  it("maps source envelopes back to the same logical visible selection", () => {
    const source = "Paragraph with **important** words.";
    const model = createMarkdownTextModel(source, "sha256:source");
    const sourceStart = source.indexOf("**important**");
    const logical = model.toLogicalRange({
      start: sourceStart,
      end: sourceStart + "**important**".length,
    });

    expect(logical).not.toBeNull();
    expect(model.logicalText.slice(logical?.start, logical?.end)).toBe("important");
    expect(model.toLogicalRange({ start: sourceStart, end: sourceStart + 2 })).toBeNull();
  });

  it("projects cross-block ranges into multiple block and source fragments", () => {
    const source = "# Title\n\nAlpha paragraph.\n\nBeta paragraph.";
    const model = createMarkdownTextModel(source, "sha256:source");
    const start = model.logicalText.indexOf("Alpha");
    const end = model.logicalText.indexOf("Beta") + "Beta".length;
    const projection = model.projectView({ start, end });

    expect(projection.blockRanges).toHaveLength(2);
    expect(projection.sourceRanges.length).toBeGreaterThanOrEqual(2);
    expect(model.contextAt({ start, end }).headingPath).toEqual(["Title"]);
  });

  it("maps source and rendered-preview selections to one logical range", () => {
    const source = "Text with **bold** value.";
    const model = createMarkdownTextModel(source, "sha256:source");
    const boldStart = source.indexOf("bold");
    const sourceProjection = model.projectSelection({
      coordinateSpace: "source",
      range: { start: boldStart, end: boldStart + 4 },
    });
    const boundary = document.createElement("div");
    const segment = document.createElement("strong");
    segment.dataset.markdownSourceStart = String(boldStart);
    segment.dataset.markdownSourceEnd = String(boldStart + 4);
    segment.textContent = "bold";
    boundary.append(segment);
    document.body.append(boundary);
    const domRange = document.createRange();
    domRange.selectNodeContents(segment);
    const previewProjection = markdownLogicalRangeFromDomRange(model, domRange, boundary);

    expect(previewProjection).toEqual({ range: sourceProjection?.logicalRange, reason: null });
    boundary.remove();
  });

  it("keeps logical exact stable while syntax projections change", () => {
    const atx = createMarkdownTextModel("# Title\n\nUse **this**.", "sha256:atx");
    const setext = createMarkdownTextModel("Title\n=====\n\nUse __this__.", "sha256:setext");
    const atxStart = atx.logicalText.indexOf("this");
    const setextStart = setext.logicalText.indexOf("this");

    expect(setext.logicalText).toBe(atx.logicalText);
    expect(setext.revision.textRevision).toBe(atx.revision.textRevision);
    expect(atx.toSourceRanges({ start: atxStart, end: atxStart + 4 }))
      .not.toEqual(setext.toSourceRanges({ start: setextStart, end: setextStart + 4 }));
  });
});
