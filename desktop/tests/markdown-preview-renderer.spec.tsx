import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildMarkdownAnnotationIndex,
  buildMarkdownDocumentModel,
  buildMarkdownFindIndex,
  MarkdownDocumentView,
} from "@/renderer/components/workspace/markdownPreviewEngine";
import { createSourceRangeAnchor } from "@/renderer/components/workspace/filePreviewAnnotations";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMock,
}));

describe("MarkdownDocumentView", () => {
  it("renders basic markdown blocks with stable block metadata", () => {
    const source = [
      "# Title",
      "",
      "Paragraph text.",
      "",
      "- first",
      "- second",
      "",
      "> quoted",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);

    render(<MarkdownDocumentView model={model} />);

    expect(screen.getByRole("heading", { name: "Title" })).not.toBeNull();
    expect(screen.getByText("Paragraph text.")).not.toBeNull();
    expect(screen.getByRole("list")).not.toBeNull();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["first", "second"]);
    expect(screen.getByText("quoted")).not.toBeNull();
    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("const value = 1;");

    const firstBlock = document.querySelector("[data-markdown-block-index='0']") as HTMLElement;
    expect(firstBlock.dataset.markdownBlockId).toBe(model.blocks[0].id);
    expect(firstBlock.dataset.markdownSourceStart).toBe("0");
    expect(firstBlock.dataset.markdownSourceEnd).toBe(String(model.blocks[0].sourceEnd));
  });

  it("renders tables and keeps markdown html as inert source text", () => {
    const source = [
      "| Name | Value |",
      "| --- | --- |",
      "| Table Cell Unique Target | 42 |",
      "",
      "<script>window.__unsafe = true</script>",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);

    render(<MarkdownDocumentView model={model} />);

    const table = screen.getByRole("table");
    expect(table.parentElement?.getAttribute("data-markdown-table-scroll")).toBe("true");
    expect(within(table).getByRole("columnheader", { name: "Name" })).not.toBeNull();
    expect(within(table).getByRole("cell", { name: "Table Cell Unique Target" })).not.toBeNull();
    expect(screen.getByText("<script>window.__unsafe = true</script>")).not.toBeNull();
    expect((window as Window & { __unsafe?: boolean }).__unsafe).toBeUndefined();
  });

  it("keeps table cells source-mapped for find and annotations", () => {
    const source = [
      "| Name | Value |",
      "| --- | --- |",
      "| Table Cell Unique Target | 42 |",
      "| Other | Target Tail |",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const annotationStart = source.indexOf("Table Cell Unique Target");
    const annotationIndex = buildMarkdownAnnotationIndex(model, [
      {
        anchor_json: createSourceRangeAnchor(
          source,
          annotationStart,
          annotationStart + "Table Cell Unique Target".length,
          "preview",
        ),
        anchor_type: "selection",
        id: "ann-table-cell",
      },
    ]);
    const findIndex = buildMarkdownFindIndex(model, "Target");

    const { rerender } = render(<MarkdownDocumentView annotationIndex={annotationIndex} model={model} />);

    const annotationMark = document.querySelector("[data-preview-annotation-id='ann-table-cell']") as HTMLElement;
    expect(annotationMark).not.toBeNull();
    expect(annotationMark.textContent).toBe("Table Cell Unique Target");
    expect(annotationMark.closest("[data-markdown-table-scroll='true']")).not.toBeNull();
    expect(annotationMark.getAttribute("data-preview-source-start")).toBe(String(annotationStart));

    rerender(<MarkdownDocumentView activeFindMatchId={findIndex.matches[1].id} findIndex={findIndex} model={model} />);

    const findMarks = Array.from(document.querySelectorAll("[data-file-preview-find-match='true']"));
    expect(findMarks.map((mark) => mark.textContent)).toEqual(["Target", "Target"]);
    expect(findMarks.every((mark) => mark.className.includes("findMark"))).toBe(true);
    expect(findMarks[1].getAttribute("data-active")).toBe("true");
    expect(findMarks.every((mark) => mark.closest("td"))).toBe(true);
  });

  it("renders markdown images lazily and math with KaTeX output", () => {
    const source = [
      "![Workspace Image](fixtures/images/workspace-image.png)",
      "",
      "Inline math $a^2 + b^2 = c^2$",
      "",
      "$$",
      "\\int_0^1 x^2 dx",
      "$$",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);

    render(<MarkdownDocumentView model={model} />);

    const image = screen.getByRole("img", { name: "Workspace Image" }) as HTMLImageElement;
    expect(image.getAttribute("data-markdown-image")).toBe("true");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("src")).toBe("fixtures/images/workspace-image.png");
    fireEvent.error(image);
    expect(screen.getByRole("alert").textContent).toContain("图片加载失败");
    expect(document.querySelector("[data-markdown-math='inline']")?.innerHTML).toContain("katex");
    expect(document.querySelector("[data-markdown-math='display']")?.innerHTML).toContain("katex-display");
  });

  it("renders GFM task list, strikethrough, inline code, links, autolinks, and breaks", () => {
    const source = [
      "- [x] completed task",
      "- [ ] pending task",
      "",
      "~~deleted~~ `inlineCode` [docs](https://example.com/docs) https://example.com/autolink",
      "break line two",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);

    render(<MarkdownDocumentView model={model} />);

    const checkboxes = document.querySelectorAll("input[type='checkbox']");
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("deleted").tagName.toLowerCase()).toBe("del");
    expect(screen.getByText("inlineCode").tagName.toLowerCase()).toBe("code");
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.getByRole("link", { name: "https://example.com/autolink" }).getAttribute("href")).toBe(
      "https://example.com/autolink",
    );
    expect(document.querySelector("br")).not.toBeNull();
  });

  it("renders code blocks with language labels, copy action, highlighting, and large-code fallback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
    });
    const source = [
      "```ts",
      "const value = 42;",
      "return value;",
      "```",
      "",
      "```txt",
      `${"x".repeat(190_000)}`,
      "```",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);

    render(<MarkdownDocumentView model={model} />);

    const codeFrames = document.querySelectorAll("[data-markdown-code-frame='true']");
    expect(codeFrames).toHaveLength(2);
    expect((codeFrames[0] as HTMLElement).getAttribute("data-markdown-code-language")).toBe("ts");
    expect((codeFrames[0] as HTMLElement).getAttribute("data-markdown-code-highlighted")).toBe("true");
    expect(within(codeFrames[0] as HTMLElement).getByText("const").getAttribute("data-code-token-kind")).toBe("keyword");
    expect(within(codeFrames[0] as HTMLElement).getByText("42").getAttribute("data-code-token-kind")).toBe("number");
    expect((codeFrames[1] as HTMLElement).getAttribute("data-markdown-code-highlighted")).toBe("false");

    fireEvent.click(within(codeFrames[0] as HTMLElement).getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const value = 42;\nreturn value;"));
    await waitFor(() =>
      expect(
        within(codeFrames[0] as HTMLElement).getByRole("button", { name: "复制代码" }).getAttribute("data-copy-state"),
      ).toBe("copied"),
    );
  });

  it("renders mermaid fences lazily with a local success state", async () => {
    mermaidMock.initialize.mockReset();
    mermaidMock.parse.mockReset().mockResolvedValue({ diagramType: "flowchart-v2" });
    mermaidMock.render.mockReset().mockResolvedValue({
      svg: '<svg role="img" aria-label="Rendered Mermaid"></svg>',
    });
    const model = buildMarkdownDocumentModel(["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"));

    render(<MarkdownDocumentView model={model} />);

    expect(screen.getByRole("status")).not.toBeNull();
    expect(await screen.findByRole("img", { name: "Mermaid diagram" })).not.toBeNull();
    const svg = document.querySelector("[data-markdown-mermaid-svg='true']") as HTMLElement;
    expect(svg.getAttribute("data-markdown-mermaid-scale")).toBe("1.00");
    fireEvent.click(screen.getByRole("button", { name: "放大 Mermaid" }));
    expect(svg.getAttribute("data-markdown-mermaid-scale")).toBe("1.10");
    fireEvent.click(screen.getByRole("button", { name: "缩小 Mermaid" }));
    expect(svg.getAttribute("data-markdown-mermaid-scale")).toBe("1.00");
    fireEvent.click(screen.getByRole("button", { name: "重置 Mermaid" }));
    expect(svg.getAttribute("data-markdown-mermaid-scale")).toBe("1.00");
    expect(mermaidMock.parse).toHaveBeenCalledWith("flowchart TD\n  A --> B");
    expect(mermaidMock.render).toHaveBeenCalled();
    expect(document.querySelector("[data-markdown-mermaid-block='true']")?.getAttribute("data-state")).toBe("ready");
  });

  it("keeps mermaid errors local and leaves the source visible", async () => {
    mermaidMock.initialize.mockReset();
    mermaidMock.parse.mockReset().mockRejectedValue(new Error("bad diagram"));
    mermaidMock.render.mockReset();
    const model = buildMarkdownDocumentModel(["```mermaid", "flowchart TD", "  broken -->", "```"].join("\n"));

    render(<MarkdownDocumentView model={model} />);

    expect((await screen.findByRole("alert")).textContent).toBe("Mermaid 渲染失败");
    expect(screen.getByText(/broken -->/)).not.toBeNull();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(document.querySelector("[data-markdown-mermaid-block='true']")?.getAttribute("data-state")).toBe("error");
  });

  it("renders annotation markers with active and flash state without DOM mutation", () => {
    const source = ["# Notes", "", "alpha target", "", "beta target", ""].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const alphaStart = source.indexOf("alpha");
    const alphaTargetStart = source.indexOf("target", alphaStart);
    const betaEnd = source.indexOf("target", source.indexOf("beta")) + "target".length;
    const annotationIndex = buildMarkdownAnnotationIndex(model, [
      {
        anchor_json: createSourceRangeAnchor(source, alphaStart, alphaStart + "alpha".length, "preview"),
        anchor_type: "selection",
        id: "ann-active",
      },
      {
        anchor_json: createSourceRangeAnchor(source, alphaTargetStart, betaEnd, "preview", "target beta target"),
        anchor_type: "selection",
        id: "ann-cross",
      },
    ]);

    render(
      <MarkdownDocumentView
        activeAnnotationId="ann-active"
        annotationIndex={annotationIndex}
        flashAnnotationId="ann-cross"
        model={model}
      />,
    );

    const active = document.querySelector("[data-preview-annotation-id='ann-active']") as HTMLElement;
    expect(active.textContent).toBe("alpha");
    expect(active.getAttribute("data-active")).toBe("true");
    expect(active.getAttribute("data-flash")).toBe("false");
    expect(active.getAttribute("data-preview-source-start")).toBe(String(alphaStart));

    const crossMarkers = document.querySelectorAll("[data-preview-annotation-id='ann-cross']");
    expect(crossMarkers).toHaveLength(2);
    expect(Array.from(crossMarkers).every((marker) => marker.getAttribute("data-flash") === "true")).toBe(true);
  });

  it("updates annotation markers when the annotation index changes after mutations", () => {
    const source = ["# Notes", "", "alpha target", ""].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const alphaStart = source.indexOf("alpha");
    const annotation = {
      anchor_json: createSourceRangeAnchor(source, alphaStart, alphaStart + "alpha".length, "preview"),
      anchor_type: "selection",
      id: "ann-created",
    };

    const { rerender } = render(<MarkdownDocumentView annotationIndex={[]} model={model} />);
    expect(document.querySelector("[data-preview-annotation-id='ann-created']")).toBeNull();

    rerender(<MarkdownDocumentView annotationIndex={buildMarkdownAnnotationIndex(model, [annotation])} model={model} />);
    expect(document.querySelector("[data-preview-annotation-id='ann-created']")?.textContent).toBe("alpha");

    rerender(<MarkdownDocumentView annotationIndex={[]} model={model} />);
    expect(document.querySelector("[data-preview-annotation-id='ann-created']")).toBeNull();
  });

  it("renders preview find marks with active state from the find index", () => {
    const source = ["# Find", "", "alpha target", "", "beta Target", ""].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const findIndex = buildMarkdownFindIndex(model, "target");

    render(<MarkdownDocumentView activeFindMatchId={findIndex.matches[1].id} findIndex={findIndex} model={model} />);

    const marks = document.querySelectorAll("[data-file-preview-find-match='true']");
    expect(marks).toHaveLength(2);
    expect(Array.from(marks).map((mark) => mark.textContent)).toEqual(["target", "Target"]);
    expect(Array.from(marks).every((mark) => mark.className.includes("findMark"))).toBe(true);
    expect(marks[0].getAttribute("data-active")).toBe("false");
    expect(marks[1].getAttribute("data-active")).toBe("true");
  });

  it("renders preview find marks across visible markdown block renderers", () => {
    const source = [
      "# Target Heading",
      "",
      "- Target item",
      "- [x] Target task",
      "",
      "> Target quote",
      "",
      "<section>",
      "Target html",
      "</section>",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Row | Target cell |",
      "",
      "Target paragraph",
      "",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const findIndex = buildMarkdownFindIndex(model, "target");

    render(<MarkdownDocumentView findIndex={findIndex} model={model} />);

    const marks = document.querySelectorAll("[data-file-preview-find-match='true']");
    expect(Array.from(marks).map((mark) => mark.closest("[data-markdown-block-type]")?.getAttribute("data-markdown-block-type"))).toEqual([
      "heading",
      "list",
      "list",
      "blockquote",
      "paragraph",
      "table",
      "paragraph",
    ]);
  });

  it("isolates renderer failures to the current markdown block", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = buildMarkdownDocumentModel(["# Safe Heading", "", "bad block", ""].join("\n"));

    try {
      render(
        <MarkdownDocumentView
          model={model}
          registry={{
            paragraph: () => {
              throw new Error("bad renderer");
            },
          }}
        />,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(screen.getByRole("heading", { name: "Safe Heading" })).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Markdown block 渲染失败");
    expect(screen.getByText("bad block")).not.toBeNull();
  });
});
