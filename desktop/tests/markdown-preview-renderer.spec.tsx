import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMarkdownDocumentModel,
  buildMarkdownFindIndex,
  MarkdownDocumentView,
} from "@/renderer/components/workspace/markdownPreviewEngine";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMock,
}));

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["• first", "• second"]);
    expect(screen.getByText("quoted")).not.toBeNull();
    expect(screen.getByTestId("markdown-code-viewport").textContent).toContain("const value = 1;");

    const firstBlock = document.querySelector("[data-markdown-block-index='0']") as HTMLElement;
    expect(firstBlock.dataset.markdownBlockId).toBe(model.blocks[0].id);
    expect(firstBlock.dataset.markdownSourceStart).toBe("0");
    expect(firstBlock.dataset.markdownSourceEnd).toBe(String(model.blocks[0].sourceEnd));
  });

  it("renders list markers as selectable text nodes", () => {
    const source = ["3. first step", "4. second step"].join("\n");
    const model = buildMarkdownDocumentModel(source);

    render(<MarkdownDocumentView model={model} />);

    const markers = Array.from(document.querySelectorAll("[data-markdown-list-marker='true']"));
    expect(markers.map((marker) => marker.textContent)).toEqual(["3. ", "4. "]);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "3. first step",
      "4. second step",
    ]);
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
    expect(screen.getByText("deleted").closest("del")).not.toBeNull();
    expect(screen.getByText("inlineCode").tagName.toLowerCase()).toBe("code");
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.getByRole("link", { name: "https://example.com/autolink" }).getAttribute("href")).toBe(
      "https://example.com/autolink",
    );
    expect(document.querySelector("br")).not.toBeNull();
  });

  it("renders code blocks with language labels, copy action, highlighting, and large-code fallback", async () => {
    vi.useFakeTimers();
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

    const copyButton = within(codeFrames[0] as HTMLElement).getByRole("button", { name: "复制代码" });
    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(writeText).toHaveBeenCalledWith("const value = 42;\nreturn value;");
    expect(copyButton.getAttribute("data-copy-state")).toBe("copied");

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(copyButton.getAttribute("data-copy-state")).toBe("idle");
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
