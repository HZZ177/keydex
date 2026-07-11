import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMarkdownDocumentModel,
  buildMarkdownFindIndex,
  VirtualMarkdownPreview,
  type VirtualMarkdownPreviewHandle,
} from "@/renderer/components/workspace/markdownPreviewEngine";
import { calculateMarkdownPreviewGutterWidth } from "@/renderer/components/workspace/markdownPreviewEngine/VirtualMarkdownPreview";
import { createLargeMarkdownPreviewFixture } from "./fixtures/markdownPreviewEngine";

const virtuosoMock = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
}));

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Virtuoso: React.forwardRef(function VirtuosoMock(props: {
      data: unknown[];
      itemContent: (index: number, item: unknown) => unknown;
      rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
    }, ref) {
      const [requestedStartIndex, setRequestedStartIndex] = React.useState(0);
      const startIndex = Math.min(requestedStartIndex, Math.max(0, props.data.length - 1));
      const endIndex = Math.min(startIndex + 7, props.data.length - 1);
      const rangeChanged = props.rangeChanged;
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: (options: { index: number }) => {
          virtuosoMock.scrollToIndex(options);
          setRequestedStartIndex(Math.max(0, Math.min(options.index, props.data.length - 1)));
        },
      }), [props.data.length]);
      React.useEffect(() => {
        if (endIndex >= 0) {
          rangeChanged?.({ startIndex, endIndex });
        }
      }, [endIndex, rangeChanged, startIndex]);
      return React.createElement(
        "div",
        { "data-testid": "virtuoso-mock" },
        props.data.slice(startIndex, endIndex + 1).map((item, index) =>
          React.createElement(
            "div",
            { "data-testid": "virtuoso-item", key: startIndex + index },
            props.itemContent(startIndex + index, item) as import("react").ReactNode,
          ),
        ),
      );
    }),
  };
});

describe("VirtualMarkdownPreview", () => {
  beforeEach(() => {
    virtuosoMock.scrollToIndex.mockClear();
  });

  it("grows the source gutter with the document line-number digit count", () => {
    expect(calculateMarkdownPreviewGutterWidth(999)).toBe(50);
    expect(calculateMarkdownPreviewGutterWidth(1000)).toBe(54);
    expect(calculateMarkdownPreviewGutterWidth(10_000)).toBe(61);
  });

  it("renders only mounted markdown blocks and exposes mounted metrics", async () => {
    const model = buildMarkdownDocumentModel(createLargeMarkdownPreviewFixture(24));
    const mountedChanges: string[][] = [];

    render(<VirtualMarkdownPreview model={model} onMountedBlockIdsChange={(ids) => mountedChanges.push(ids)} />);

    expect(screen.getByTestId("virtuoso-mock")).not.toBeNull();
    expect(document.querySelectorAll("[data-markdown-block-id]").length).toBeLessThan(model.blocks.length);
    expect(document.querySelectorAll("[data-markdown-block-id]").length).toBe(8);
    const root = document.querySelector("[data-markdown-virtual-preview='true']") as HTMLElement;
    expect(root.dataset.markdownBlockCount).toBe(String(model.blocks.length));
    expect(root.dataset.markdownModelReady).toBe("true");
    expect(await screen.findByText("E2E Large Markdown Title")).not.toBeNull();
    expect(mountedChanges.at(-1)).toHaveLength(8);
    expect(Number(root.dataset.markdownMountedHeavyBlockCount)).toBeGreaterThan(0);
  });

  it("renders source line gutter only when enabled", () => {
    const model = buildMarkdownDocumentModel([
      "# Title",
      "",
      "Paragraph text",
      "",
      "- first item",
      "- second item",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
    ].join("\n"));

    const { rerender } = render(<VirtualMarkdownPreview model={model} />);

    expect(document.querySelector("[data-markdown-preview-line-number='true']")).toBeNull();

    rerender(<VirtualMarkdownPreview model={model} showSourceGutter />);

    expect(Array.from(document.querySelectorAll("[data-markdown-preview-line-number='true']")).map((node) => node.textContent)).toEqual([
      "1",
      "3",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    expect(screen.getByRole("button", { name: "折叠第 1 行章节" })).not.toBeNull();
  });

  it("folds heading sections and multiline preview blocks from the gutter", async () => {
    const source = [
      "# Title",
      "",
      "intro text",
      "",
      "## Child",
      "",
      "child text",
      "",
      "# Next",
      "",
      "next text",
      "",
      "line one",
      "line two",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const ref = createRef<VirtualMarkdownPreviewHandle>();

    render(<VirtualMarkdownPreview model={model} ref={ref} showSourceGutter />);

    fireEvent.click(screen.getByRole("button", { name: "折叠第 1 行章节" }));

    expect(screen.getByRole("heading", { name: "Title" })).not.toBeNull();
    expect(screen.getByText("intro text").closest("[data-markdown-preview-block-frame='true']")?.getAttribute("data-fold-exiting")).toBe("true");
    expect(screen.getByText("已折叠 6 行")).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("intro text")).toBeNull());
    expect(screen.queryByRole("heading", { name: "Child" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Next" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开第 1 行章节" }));
    expect(screen.getByText("intro text")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Child" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "折叠第 13 行内容" }));
    expect(screen.queryByText("line one")).toBeNull();
    expect(screen.getByText("已折叠 2 行")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开第 13 行内容" }));
    expect(screen.getByText("line one")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "折叠第 1 行章节" }));
    let revealFolded!: Promise<void>;
    act(() => {
      revealFolded = ref.current?.revealBlock(model.blocks[2].id, { align: "center" }) ?? Promise.resolve();
    });
    await act(async () => revealFolded);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ align: "center", index: 2 });
  });

  it("provides one Promise block reveal transaction", async () => {
    const model = buildMarkdownDocumentModel(createLargeMarkdownPreviewFixture(24));
    const ref = createRef<VirtualMarkdownPreviewHandle>();
    render(<VirtualMarkdownPreview model={model} ref={ref} />);
    const target = model.blocks[20];

    let revealBlock!: Promise<void>;
    act(() => {
      revealBlock = ref.current?.revealBlock(target.id, { align: "center" }) ?? Promise.resolve();
    });
    await act(async () => revealBlock);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ align: "center", index: 20 });
    await expect(ref.current?.revealBlock("missing-block")).rejects.toThrow("unavailable");
    await expect(ref.current?.revealIndex(-1)).rejects.toThrow("unavailable");
  });

  it("reveals find matches by match id", async () => {
    const source = createLargeMarkdownPreviewFixture(24);
    const model = buildMarkdownDocumentModel(source);
    const findIndex = buildMarkdownFindIndex(model, "tail-search-target");
    const target = findIndex.matches.at(-1);
    expect(target).toBeTruthy();
    const ref = createRef<VirtualMarkdownPreviewHandle>();
    render(<VirtualMarkdownPreview findIndex={findIndex} model={model} ref={ref} />);

    let revealFind!: Promise<void>;
    act(() => {
      revealFind = ref.current?.revealFindMatch(target?.id ?? "", { align: "center" }) ?? Promise.resolve();
    });
    await act(async () => revealFind);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ align: "center", index: target?.blockIndex });
    await expect(ref.current?.revealFindMatch("missing")).rejects.toThrow("unavailable");
  });

  it("cancels obsolete and explicitly aborted reveal requests", async () => {
    const model = buildMarkdownDocumentModel(createLargeMarkdownPreviewFixture(24));
    const ref = createRef<VirtualMarkdownPreviewHandle>();
    render(<VirtualMarkdownPreview model={model} ref={ref} />);
    let first!: Promise<void>;
    let second!: Promise<void>;

    act(() => {
      first = ref.current?.revealBlock(model.blocks[20].id) ?? Promise.resolve();
      second = ref.current?.revealBlock(model.blocks[2].id) ?? Promise.resolve();
    });

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await act(async () => second);

    const controller = new AbortController();
    controller.abort();
    await expect(ref.current?.revealBlock(model.blocks[3].id, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
