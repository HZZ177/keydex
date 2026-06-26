import {
  Component,
  createElement,
  Fragment,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Check, Copy, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import mermaid from "mermaid";
import katex from "katex";

import { copyText } from "@/renderer/pages/conversation/messages/markdown";
import styles from "../FilePreview.module.css";
import type { MarkdownAnnotationIndexItem } from "./annotationIndex";
import type { MarkdownFindIndex } from "./findIndex";
import type { MarkdownBlock, MarkdownBlockType, MarkdownDocumentModel } from "./types";

export interface MarkdownRenderedAnnotationRange {
  active: boolean;
  annotationId: string;
  blockLocalEnd: number;
  blockLocalStart: number;
  flash: boolean;
  sourceEnd: number;
  sourceStart: number;
}

export interface MarkdownRenderedFindMatch {
  active: boolean;
  blockLocalEnd: number;
  blockLocalStart: number;
  id: string;
  sourceEnd: number;
  sourceStart: number;
}

export interface MarkdownInlineImageProps {
  alt: string;
  src: string;
}

export type MarkdownInlineImageRenderer = (props: MarkdownInlineImageProps) => ReactNode;

export interface MarkdownBlockRendererProps {
  annotationRanges: MarkdownRenderedAnnotationRange[];
  block: MarkdownBlock;
  blockAttributes: MarkdownBlockRootAttributes;
  findMatches: MarkdownRenderedFindMatch[];
  renderImage?: MarkdownInlineImageRenderer;
}

export type MarkdownBlockRenderer = (props: MarkdownBlockRendererProps) => ReactNode;

export type MarkdownBlockRendererRegistry = Partial<Record<MarkdownBlockType, MarkdownBlockRenderer>>;

export type MarkdownBlockRootAttributes = HTMLAttributes<HTMLElement> & {
  "data-markdown-active-target": string;
  "data-markdown-block-id": string;
  "data-markdown-block-find-match-count"?: number;
  "data-markdown-block-index": number;
  "data-markdown-block-type": MarkdownBlockType;
  "data-markdown-source-end": number;
  "data-markdown-source-start": number;
};

export interface MarkdownBlockViewProps {
  active?: boolean;
  activeAnnotationId?: string | null;
  activeFindMatchId?: string | null;
  annotationIndex?: MarkdownAnnotationIndexItem[];
  block: MarkdownBlock;
  findIndex?: MarkdownFindIndex | null;
  flashAnnotationId?: string | null;
  registry?: MarkdownBlockRendererRegistry;
  renderImage?: MarkdownInlineImageRenderer;
}

export interface MarkdownDocumentViewProps {
  activeAnnotationId?: string | null;
  activeFindMatchId?: string | null;
  annotationIndex?: MarkdownAnnotationIndexItem[];
  findIndex?: MarkdownFindIndex | null;
  flashAnnotationId?: string | null;
  model: MarkdownDocumentModel;
  registry?: MarkdownBlockRendererRegistry;
  renderImage?: MarkdownInlineImageRenderer;
}

export const defaultMarkdownBlockRenderers: MarkdownBlockRendererRegistry = {
  blockquote: BlockquoteRenderer,
  code: CodeRenderer,
  fence: CodeRenderer,
  heading: HeadingRenderer,
  html: HtmlSourceRenderer,
  list: ListRenderer,
  paragraph: ParagraphRenderer,
  table: TableRenderer,
  thematic_break: ThematicBreakRenderer,
  unknown: ParagraphRenderer,
};

const MARKDOWN_CODE_HIGHLIGHT_LIMIT = 180_000;

export function MarkdownDocumentView({
  activeAnnotationId = null,
  activeFindMatchId = null,
  annotationIndex = [],
  findIndex = null,
  flashAnnotationId = null,
  model,
  registry,
  renderImage,
}: MarkdownDocumentViewProps) {
  return (
    <div className="keydex-markdown" data-markdown-document-version={model.version}>
      {model.blocks.map((block) => (
        <MarkdownBlockView
          activeAnnotationId={activeAnnotationId}
          activeFindMatchId={activeFindMatchId}
          annotationIndex={annotationIndex}
          block={block}
          findIndex={findIndex}
          flashAnnotationId={flashAnnotationId}
          key={block.id}
          registry={registry}
          renderImage={renderImage}
        />
      ))}
    </div>
  );
}

export function MarkdownBlockView({
  active = false,
  activeAnnotationId = null,
  activeFindMatchId = null,
  annotationIndex = [],
  block,
  findIndex = null,
  flashAnnotationId = null,
  registry,
  renderImage,
}: MarkdownBlockViewProps) {
  const renderers = registry ? { ...defaultMarkdownBlockRenderers, ...registry } : defaultMarkdownBlockRenderers;
  const Renderer = renderers[block.type] ?? ParagraphRenderer;
  const annotationRanges = annotationRangesForBlock(block, annotationIndex, activeAnnotationId, flashAnnotationId);
  const findMatches = findMatchesForBlock(block, findIndex, activeFindMatchId);
  const blockAttributes = {
    ...markdownBlockRootAttributes(block, active),
    "data-markdown-block-find-match-count": findMatches.length || undefined,
  };
  return (
    <MarkdownBlockErrorBoundary block={block} blockAttributes={blockAttributes}>
      <Renderer
        annotationRanges={annotationRanges}
        block={block}
        blockAttributes={blockAttributes}
        findMatches={findMatches}
        renderImage={renderImage}
      />
    </MarkdownBlockErrorBoundary>
  );
}

class MarkdownBlockErrorBoundary extends Component<
  { block: MarkdownBlock; blockAttributes: MarkdownBlockRootAttributes; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {
    // Local block isolation only; do not surface stack traces in the main preview UI.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div {...this.props.blockAttributes} data-markdown-block-error="true" role="alert">
          <span>Markdown block 渲染失败</span>
          <pre>
            <code>{this.props.block.sourceText.slice(0, 2000)}</code>
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function markdownBlockRootAttributes(block: MarkdownBlock, active: boolean): MarkdownBlockRootAttributes {
  return {
    "data-markdown-active-target": active ? "true" : "false",
    "data-markdown-block-id": block.id,
    "data-markdown-block-index": block.index,
    "data-markdown-block-type": block.type,
    "data-markdown-source-end": block.sourceEnd,
    "data-markdown-source-start": block.sourceStart,
  };
}

function HeadingRenderer({ annotationRanges, block, blockAttributes, findMatches }: MarkdownBlockRendererProps) {
  const level = block.metadata.headingLevel ?? 1;
  const sourceStart = headingTextSourceStart(block);
  return createElement(
    `h${level}`,
    { ...blockAttributes, "data-markdown-outline-block-id": block.id },
    renderInlineTextWithMarkers(block.textContent, sourceStart, `${block.id}-heading`, annotationRanges, findMatches),
  );
}

function ParagraphRenderer({ annotationRanges, block, blockAttributes, findMatches, renderImage }: MarkdownBlockRendererProps) {
  const value = block.sourceText.trimEnd() || block.textContent;
  return (
    <p {...blockAttributes}>
      {renderMarkedInlineMarkdown(block, value, annotationRanges, findMatches, block.sourceStart, renderImage)}
    </p>
  );
}

function BlockquoteRenderer({ annotationRanges, block, blockAttributes, findMatches, renderImage }: MarkdownBlockRendererProps) {
  const lines = markdownBlockquoteLines(block);
  return (
    <blockquote {...blockAttributes}>
      <p>
        {lines.map((line, index) => (
          <Fragment key={`${block.id}-quote-${index}`}>
            {index > 0 ? <br /> : null}
            {renderInlineMarkdown(line.text, line.sourceStart, annotationRanges, findMatches, renderImage)}
          </Fragment>
        ))}
      </p>
    </blockquote>
  );
}

function ListRenderer({ annotationRanges, block, blockAttributes, findMatches, renderImage }: MarkdownBlockRendererProps) {
  const items = markdownListItems(block);
  const Tag = block.metadata.listOrdered ? "ol" : "ul";
  return createElement(
    Tag,
    blockAttributes,
    items.map((item, index) => {
      const task = /^\[(x|X| )]\s+(.*)$/.exec(item.text);
      return (
        <li key={`${block.id}-item-${index + 1}`}>
          {task ? (
            <>
              <input checked={task[1].toLowerCase() === "x"} disabled readOnly type="checkbox" />
              {renderInlineMarkdown(
                task[2],
                item.sourceStart + task[0].length - task[2].length,
                annotationRanges,
                findMatches,
                renderImage,
              )}
            </>
          ) : renderInlineMarkdown(item.text, item.sourceStart, annotationRanges, findMatches, renderImage)}
        </li>
      );
    }),
  );
}

function CodeRenderer({ annotationRanges, block, blockAttributes, findMatches }: MarkdownBlockRendererProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const language = block.metadata.language;
  const code = block.textContent;
  const codeSourceStart = markdownCodeContentSourceStart(block);
  const highlighted = useMemo(
    () => (annotationRanges.length || code.length > MARKDOWN_CODE_HIGHLIGHT_LIMIT
      ? renderInlineTextWithMarkers(code, codeSourceStart, `${block.id}-code-plain`, annotationRanges, findMatches)
      : highlightCodeText(code, language, codeSourceStart, annotationRanges, findMatches)),
    [annotationRanges, block.id, code, codeSourceStart, findMatches, language],
  );

  useEffect(() => {
    setCopyState("idle");
  }, [code]);

  const handleCopy = async () => {
    try {
      await copyText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  if (language?.toLowerCase() === "mermaid") {
    return <MermaidBlockRenderer blockAttributes={blockAttributes} code={code} />;
  }

  return (
    <div
      {...blockAttributes}
      data-markdown-code-frame="true"
      data-markdown-code-highlighted={code.length <= MARKDOWN_CODE_HIGHLIGHT_LIMIT ? "true" : "false"}
      data-markdown-code-language={language || "text"}
    >
      <div>
        <span>{language || "text"}</span>
        <button type="button" aria-label="复制代码" data-copy-state={copyState} onClick={handleCopy}>
          {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre data-scroll-axis="x" data-testid="markdown-code-viewport">
        <code>{highlighted}</code>
      </pre>
      {copyState === "failed" ? <span role="alert">复制失败</span> : null}
    </div>
  );
}

function MermaidBlockRenderer({
  blockAttributes,
  code,
}: {
  blockAttributes: MarkdownBlockRootAttributes;
  code: string;
}) {
  const [state, setState] = useState<"error" | "ready" | "rendering">("rendering");
  const [svg, setSvg] = useState("");
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setScale(1);
    let active = true;
    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.left = "-99999px";
    host.style.top = "-99999px";
    document.body.appendChild(host);

    async function renderMermaid() {
      try {
        mermaid.initialize({ securityLevel: "strict", startOnLoad: false });
        await mermaid.parse(code);
        const result = await mermaid.render(`markdown-preview-mermaid-${Date.now()}`, code, host);
        if (active) {
          setSvg(result.svg);
          setState("ready");
        }
      } catch {
        if (active) {
          setState("error");
        }
      }
    }

    renderMermaid();

    return () => {
      active = false;
      host.remove();
    };
  }, [code]);

  return (
    <div {...blockAttributes} data-markdown-mermaid-block="true" data-state={state}>
      {state === "rendering" ? <div role="status">正在渲染 Mermaid</div> : null}
      {state === "ready" ? (
        <>
          <div data-markdown-mermaid-controls="true">
            <button aria-label="放大 Mermaid" onClick={() => setScale((value) => Math.min(3, value + 0.1))} type="button">
              <ZoomIn size={14} />
            </button>
            <button aria-label="缩小 Mermaid" onClick={() => setScale((value) => Math.max(0.4, value - 0.1))} type="button">
              <ZoomOut size={14} />
            </button>
            <button aria-label="重置 Mermaid" onClick={() => setScale(1)} type="button">
              <RotateCcw size={14} />
            </button>
          </div>
          <div
            aria-label="Mermaid diagram"
            data-markdown-mermaid-scale={scale.toFixed(2)}
            data-markdown-mermaid-svg="true"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
            style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
          />
        </>
      ) : null}
      {state === "error" ? (
        <div>
          <div role="alert">Mermaid 渲染失败</div>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function highlightCodeText(
  code: string,
  language: string | undefined,
  sourceStart: number,
  annotationRanges: MarkdownRenderedAnnotationRange[],
  findMatches: MarkdownRenderedFindMatch[],
): ReactNode {
  if (!language || !/^(ts|tsx|js|jsx|javascript|typescript|json|python|py|css|html|xml|yaml|yml)$/i.test(language)) {
    return renderInlineTextWithMarkers(code, sourceStart, "code-text", annotationRanges, findMatches);
  }
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|class|import|from|export|if|else|for|while|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(code)) !== null) {
    if (match.index > cursor) {
      nodes.push(
        ...renderInlineTextWithMarkers(
          code.slice(cursor, match.index),
          sourceStart + cursor,
          `code-text-${cursor}`,
          annotationRanges,
          findMatches,
        ),
      );
    }
    const token = match[0];
    const tokenSourceStart = sourceStart + match.index;
    nodes.push(annotationRanges.length || findMatches.length ? (
      <span data-code-token-kind={codeTokenKind(token)} key={`code-token-${match.index}-${token}`}>
        {renderInlineTextWithMarkers(
          token,
          tokenSourceStart,
          `code-token-${match.index}`,
          annotationRanges,
          findMatches,
        )}
      </span>
    ) : (
      <span
        data-code-token-kind={codeTokenKind(token)}
        key={`code-token-${match.index}-${token}`}
        {...sourceSegmentAttributes(tokenSourceStart, tokenSourceStart + token.length)}
      >
        {token}
      </span>
    ));
    cursor = match.index + token.length;
  }
  if (cursor < code.length) {
    nodes.push(
      ...renderInlineTextWithMarkers(
        code.slice(cursor),
        sourceStart + cursor,
        `code-text-${cursor}`,
        annotationRanges,
        findMatches,
      ),
    );
  }
  return nodes.length ? nodes : renderSourceMappedText(code, sourceStart, "code-text-empty");
}

function codeTokenKind(token: string): string {
  if (/^["'`]/.test(token)) {
    return "string";
  }
  if (/^\d/.test(token)) {
    return "number";
  }
  if (/^(true|false|null|undefined)$/.test(token)) {
    return "literal";
  }
  return "keyword";
}

function HtmlSourceRenderer({ annotationRanges, block, blockAttributes, findMatches }: MarkdownBlockRendererProps) {
  const value = block.sourceText.trimEnd();
  return (
    <pre {...blockAttributes} aria-label="Markdown HTML source">
      <code>{renderInlineTextWithMarkers(value, block.sourceStart, `${block.id}-html`, annotationRanges, findMatches)}</code>
    </pre>
  );
}

function TableRenderer({ annotationRanges, block, blockAttributes, findMatches, renderImage }: MarkdownBlockRendererProps) {
  const rows = parseMarkdownTableRows(block);
  if (!rows.length) {
    return (
      <p {...blockAttributes}>
        {renderInlineTextWithMarkers(
          block.textContent,
          block.sourceStart,
          `${block.id}-table-fallback`,
          annotationRanges,
          findMatches,
        )}
      </p>
    );
  }
  const [header, ...body] = rows.filter((row) => !row.divider);
  return (
    <div
      {...blockAttributes}
      className="keydex-markdown-table-scroll"
      data-markdown-table-scroll="true"
      data-scroll-axis="x"
    >
      <table>
        <thead>
          <tr>
            {header.cells.map((cell, index) => (
              <th key={`${block.id}-head-${index}`}>
                {renderInlineMarkdown(cell.text, cell.sourceStart, annotationRanges, findMatches, renderImage)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`${block.id}-row-${rowIndex}`}>
              {row.cells.map((cell, cellIndex) => (
                <td key={`${block.id}-cell-${rowIndex}-${cellIndex}`}>
                  {renderInlineMarkdown(cell.text, cell.sourceStart, annotationRanges, findMatches, renderImage)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ThematicBreakRenderer({ blockAttributes }: MarkdownBlockRendererProps) {
  return <hr {...blockAttributes} />;
}

interface MarkdownTableCellModel {
  sourceEnd: number;
  sourceStart: number;
  text: string;
}

interface MarkdownVisibleLineModel {
  sourceStart: number;
  text: string;
}

interface MarkdownTableRowModel {
  cells: MarkdownTableCellModel[];
  divider: boolean;
}

function parseMarkdownTableRows(block: MarkdownBlock): MarkdownTableRowModel[] {
  const rows: MarkdownTableRowModel[] = [];
  for (const line of markdownSourceLines(block.sourceText, block.sourceStart)) {
    if (!line.text.includes("|")) {
      continue;
    }
    const cells = parseMarkdownTableCells(line.text, line.sourceStart);
    if (cells.length < 2) {
      continue;
    }
    rows.push({
      cells,
      divider: cells.every((cell) => /^:?-{3,}:?$/.test(cell.text.trim())),
    });
  }
  return rows;
}

function markdownBlockquoteLines(block: MarkdownBlock): MarkdownVisibleLineModel[] {
  return markdownSourceLines(block.sourceText, block.sourceStart)
    .map((line) => {
      const prefix = /^>\s?/.exec(line.text)?.[0] ?? "";
      const textStart = prefix.length + leadingWhitespaceLength(line.text.slice(prefix.length));
      const textEnd = line.text.length - trailingWhitespaceLength(line.text.slice(textStart));
      return {
        sourceStart: line.sourceStart + textStart,
        text: line.text.slice(textStart, Math.max(textStart, textEnd)),
      };
    })
    .filter((line) => line.text.length > 0);
}

function markdownListItems(block: MarkdownBlock): MarkdownVisibleLineModel[] {
  return markdownSourceLines(block.sourceText, block.sourceStart)
    .map((line) => {
      const marker = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line.text)?.[0];
      if (!marker) {
        return null;
      }
      const textStart = marker.length + leadingWhitespaceLength(line.text.slice(marker.length));
      const textEnd = line.text.length - trailingWhitespaceLength(line.text.slice(textStart));
      if (textEnd <= textStart) {
        return null;
      }
      return {
        sourceStart: line.sourceStart + textStart,
        text: line.text.slice(textStart, textEnd),
      };
    })
    .filter((line): line is MarkdownVisibleLineModel => Boolean(line));
}

function markdownSourceLines(
  value: string,
  sourceStart: number,
): Array<{ sourceStart: number; text: string }> {
  const lines: Array<{ sourceStart: number; text: string }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    const lineStart = cursor;
    while (cursor < value.length && value[cursor] !== "\n" && value[cursor] !== "\r") {
      cursor += 1;
    }
    lines.push({
      sourceStart: sourceStart + lineStart,
      text: value.slice(lineStart, cursor),
    });
    if (value[cursor] === "\r" && value[cursor + 1] === "\n") {
      cursor += 2;
    } else if (value[cursor] === "\r" || value[cursor] === "\n") {
      cursor += 1;
    }
  }
  return lines;
}

function parseMarkdownTableCells(line: string, lineSourceStart: number): MarkdownTableCellModel[] {
  const trimmedStart = firstNonWhitespaceIndex(line);
  const trimmedEnd = lastNonWhitespaceIndex(line) + 1;
  if (trimmedStart < 0 || trimmedEnd <= trimmedStart) {
    return [];
  }
  const firstPipe = line.indexOf("|", trimmedStart);
  const lastPipe = line.lastIndexOf("|", trimmedEnd - 1);
  const contentStart = firstPipe === trimmedStart ? firstPipe + 1 : trimmedStart;
  const contentEnd = lastPipe === trimmedEnd - 1 && lastPipe >= contentStart ? lastPipe : trimmedEnd;
  const cells: MarkdownTableCellModel[] = [];
  let cellStart = contentStart;
  for (let index = contentStart; index <= contentEnd; index += 1) {
    const atBoundary = index === contentEnd || (line[index] === "|" && line[index - 1] !== "\\");
    if (!atBoundary) {
      continue;
    }
    const rawStart = cellStart;
    const rawEnd = index;
    const textStart = rawStart + leadingWhitespaceLength(line.slice(rawStart, rawEnd));
    const textEnd = rawEnd - trailingWhitespaceLength(line.slice(rawStart, rawEnd));
    cells.push({
      sourceEnd: lineSourceStart + Math.max(textStart, textEnd),
      sourceStart: lineSourceStart + textStart,
      text: line.slice(textStart, Math.max(textStart, textEnd)),
    });
    cellStart = index + 1;
  }
  return cells;
}

function firstNonWhitespaceIndex(value: string): number {
  const match = /\S/.exec(value);
  return match?.index ?? -1;
}

function lastNonWhitespaceIndex(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(value[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function leadingWhitespaceLength(value: string): number {
  return value.length - value.trimStart().length;
}

function trailingWhitespaceLength(value: string): number {
  return value.length - value.trimEnd().length;
}

function annotationRangesForBlock(
  block: MarkdownBlock,
  annotationIndex: MarkdownAnnotationIndexItem[],
  activeAnnotationId: string | null,
  flashAnnotationId: string | null,
): MarkdownRenderedAnnotationRange[] {
  return annotationIndex
    .flatMap((item) =>
      item.ranges
        .filter((range) => range.blockId === block.id)
        .map((range) => ({
          active: item.annotation.id === activeAnnotationId,
          annotationId: item.annotation.id,
          blockLocalEnd: range.blockLocalEnd,
          blockLocalStart: range.blockLocalStart,
          flash: item.annotation.id === flashAnnotationId,
          sourceEnd: range.sourceEnd,
          sourceStart: range.sourceStart,
        })),
    )
    .sort((left, right) => left.blockLocalStart - right.blockLocalStart || right.blockLocalEnd - left.blockLocalEnd);
}

function findMatchesForBlock(
  block: MarkdownBlock,
  findIndex: MarkdownFindIndex | null,
  activeFindMatchId: string | null,
): MarkdownRenderedFindMatch[] {
  return (findIndex?.matches ?? [])
    .filter((match) => match.blockId === block.id)
    .map((match) => ({
      active: match.id === activeFindMatchId,
      blockLocalEnd: match.blockLocalEnd,
      blockLocalStart: match.blockLocalStart,
      id: match.id,
      sourceEnd: match.sourceEnd,
      sourceStart: match.sourceStart,
    }))
    .sort((left, right) => left.blockLocalStart - right.blockLocalStart || right.blockLocalEnd - left.blockLocalEnd);
}

function renderMarkedInlineMarkdown(
  _block: MarkdownBlock,
  value: string,
  annotationRanges: MarkdownRenderedAnnotationRange[],
  findMatches: MarkdownRenderedFindMatch[],
  sourceStart: number,
  renderImage?: MarkdownInlineImageRenderer,
): ReactNode {
  return renderInlineMarkdown(value, sourceStart, annotationRanges, findMatches, renderImage);
}

function renderInlineTextWithMarkers(
  value: string,
  sourceStart: number,
  keyPrefix: string,
  annotationRanges: MarkdownRenderedAnnotationRange[],
  findMatches: MarkdownRenderedFindMatch[],
  renderImage?: MarkdownInlineImageRenderer,
): ReactNode[] {
  if (!value) {
    return [];
  }
  if (annotationRanges.length) {
    return asNodeArray(renderAnnotatedInlineMarkdown(value, annotationRanges, findMatches, sourceStart, renderImage));
  }
  if (findMatches.length) {
    return asNodeArray(renderFindInlineMarkdown(value, findMatches, sourceStart, renderImage));
  }
  return renderSourceMappedText(value, sourceStart, keyPrefix);
}

function asNodeArray(value: ReactNode): ReactNode[] {
  return Array.isArray(value) ? value : [value];
}

function renderAnnotatedInlineMarkdown(
  value: string,
  annotationRanges: MarkdownRenderedAnnotationRange[],
  findMatches: MarkdownRenderedFindMatch[],
  sourceStart: number,
  renderImage?: MarkdownInlineImageRenderer,
): ReactNode {
  const projectedRanges = projectAnnotationRangesToSlice(annotationRanges, sourceStart, sourceStart + value.length);
  if (!projectedRanges.length) {
    return renderInlineMarkdown(value, sourceStart, [], findMatches, renderImage);
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of projectedRanges) {
    const start = Math.max(0, Math.min(range.blockLocalStart, value.length));
    const end = Math.max(start, Math.min(range.blockLocalEnd, value.length));
    if (end <= start || start < cursor) {
      continue;
    }
    if (start > cursor) {
      nodes.push(renderInlineMarkdown(value.slice(cursor, start), sourceStart + cursor, [], findMatches, renderImage));
    }
    nodes.push(
      <mark
        className={styles.previewAnnotationMark}
        data-active={range.active ? "true" : "false"}
        data-flash={range.flash ? "true" : "false"}
        data-transient-reveal={range.annotationId.startsWith("__file-preview-reveal:") ? "true" : undefined}
        data-preview-annotation-id={range.annotationId}
        data-preview-source-end={range.sourceEnd}
        data-preview-source-start={range.sourceStart}
        key={`annotation-${range.annotationId}-${range.sourceStart}-${range.sourceEnd}`}
      >
        {renderInlineMarkdown(value.slice(start, end), sourceStart + start, [], findMatches, renderImage)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < value.length) {
    nodes.push(renderInlineMarkdown(value.slice(cursor), sourceStart + cursor, [], findMatches, renderImage));
  }
  return nodes;
}

function renderFindInlineMarkdown(
  value: string,
  findMatches: MarkdownRenderedFindMatch[],
  sourceStart: number,
  renderImage?: MarkdownInlineImageRenderer,
): ReactNode {
  const projectedMatches = projectFindMatchesToSlice(findMatches, sourceStart, sourceStart + value.length);
  if (!projectedMatches.length) {
    return renderInlineMarkdown(value, sourceStart, [], [], renderImage);
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of projectedMatches) {
    const start = Math.max(0, Math.min(match.blockLocalStart, value.length));
    const end = Math.max(start, Math.min(match.blockLocalEnd, value.length));
    if (end <= start || start < cursor) {
      continue;
    }
    if (start > cursor) {
      nodes.push(renderInlineMarkdown(value.slice(cursor, start), sourceStart + cursor, [], [], renderImage));
    }
    nodes.push(
      <mark
        className={styles.findMark}
        data-active={match.active ? "true" : "false"}
        data-file-preview-find-match="true"
        data-find-match-id={match.id}
        data-preview-source-end={match.sourceEnd}
        data-preview-source-start={match.sourceStart}
        key={`find-${match.id}-${match.sourceStart}-${match.sourceEnd}`}
      >
        {renderInlineMarkdown(value.slice(start, end), sourceStart + start, [], [], renderImage)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < value.length) {
    nodes.push(renderInlineMarkdown(value.slice(cursor), sourceStart + cursor, [], [], renderImage));
  }
  return nodes;
}

function projectAnnotationRangesToSlice(
  annotationRanges: MarkdownRenderedAnnotationRange[],
  sourceStart: number,
  sourceEnd: number,
): MarkdownRenderedAnnotationRange[] {
  return annotationRanges
    .map((range) => {
      const overlapStart = Math.max(sourceStart, range.sourceStart);
      const overlapEnd = Math.min(sourceEnd, range.sourceEnd);
      if (overlapEnd <= overlapStart) {
        return null;
      }
      return {
        ...range,
        blockLocalEnd: overlapEnd - sourceStart,
        blockLocalStart: overlapStart - sourceStart,
        sourceEnd: overlapEnd,
        sourceStart: overlapStart,
      };
    })
    .filter((range): range is MarkdownRenderedAnnotationRange => Boolean(range))
    .sort((left, right) => left.blockLocalStart - right.blockLocalStart || right.blockLocalEnd - left.blockLocalEnd);
}

function projectFindMatchesToSlice(
  findMatches: MarkdownRenderedFindMatch[],
  sourceStart: number,
  sourceEnd: number,
): MarkdownRenderedFindMatch[] {
  return findMatches
    .map((match) => {
      const overlapStart = Math.max(sourceStart, match.sourceStart);
      const overlapEnd = Math.min(sourceEnd, match.sourceEnd);
      if (overlapEnd <= overlapStart) {
        return null;
      }
      return {
        ...match,
        blockLocalEnd: overlapEnd - sourceStart,
        blockLocalStart: overlapStart - sourceStart,
        sourceEnd: overlapEnd,
        sourceStart: overlapStart,
      };
    })
    .filter((match): match is MarkdownRenderedFindMatch => Boolean(match))
    .sort((left, right) => left.blockLocalStart - right.blockLocalStart || right.blockLocalEnd - left.blockLocalEnd);
}

function renderInlineMarkdown(
  value: string,
  sourceStart = 0,
  annotationRanges: MarkdownRenderedAnnotationRange[] = [],
  findMatches: MarkdownRenderedFindMatch[] = [],
  renderImage?: MarkdownInlineImageRenderer,
): ReactNode {
  const tokenPattern = /(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)([\s\S]+?)\4|(\*|_)([^*_\n]+?)\6|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|`([^`\n]+)`|~~([^~]+)~~|\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<]+))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value)) !== null) {
    if (match.index > cursor) {
      nodes.push(...renderInlineTextWithMarkers(
        value.slice(cursor, match.index),
        sourceStart + cursor,
        `text-${cursor}`,
        annotationRanges,
        findMatches,
      ));
    }
    if (match[1]?.startsWith("![")) {
      const image = { alt: match[2] || "", src: match[3] };
      nodes.push(
        renderImage ? (
          <Fragment key={`inline-image-${match.index}`}>{renderImage(image)}</Fragment>
        ) : (
          <MarkdownInlineImage
            alt={image.alt}
            key={`inline-image-${match.index}`}
            src={image.src}
          />
        ),
      );
    } else if (typeof match[5] === "string") {
      const contentSourceStart = sourceStart + match.index + match[4].length;
      nodes.push(
        <strong key={`inline-strong-${match.index}`} {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[5].length)}>
          {annotationRanges.length || findMatches.length
            ? renderInlineTextWithMarkers(
              match[5],
              contentSourceStart,
              `strong-${match.index}`,
              annotationRanges,
              findMatches,
            )
            : match[5]}
        </strong>,
      );
    } else if (typeof match[7] === "string") {
      const contentSourceStart = sourceStart + match.index + match[6].length;
      nodes.push(
        <em key={`inline-em-${match.index}`} {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[7].length)}>
          {annotationRanges.length || findMatches.length
            ? renderInlineTextWithMarkers(
              match[7],
              contentSourceStart,
              `em-${match.index}`,
              annotationRanges,
              findMatches,
            )
            : match[7]}
        </em>,
      );
    } else {
      const displayMode = typeof match[8] === "string";
      if (typeof match[10] === "string") {
        const contentSourceStart = sourceStart + match.index + 1;
        nodes.push(
          <code key={`inline-code-${match.index}`} {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[10].length)}>
            {annotationRanges.length || findMatches.length
              ? renderInlineTextWithMarkers(
                match[10],
                contentSourceStart,
                `code-${match.index}`,
                annotationRanges,
                findMatches,
              )
              : match[10]}
          </code>,
        );
      } else if (typeof match[11] === "string") {
        const contentSourceStart = sourceStart + match.index + 2;
        nodes.push(
          <del key={`inline-del-${match.index}`} {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[11].length)}>
            {annotationRanges.length || findMatches.length
              ? renderInlineTextWithMarkers(
                match[11],
                contentSourceStart,
                `del-${match.index}`,
                annotationRanges,
                findMatches,
              )
              : match[11]}
          </del>,
        );
      } else if (typeof match[12] === "string") {
        const contentSourceStart = sourceStart + match.index + 1;
        const href = safeMarkdownHref(match[13]);
        const label = annotationRanges.length || findMatches.length
          ? renderInlineTextWithMarkers(
            match[12],
            contentSourceStart,
            `link-${match.index}`,
            annotationRanges,
            findMatches,
          )
          : match[12];
        nodes.push(href ? (
          <a
            href={href}
            key={`inline-link-${match.index}`}
            rel="noreferrer"
            target="_blank"
            {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[12].length)}
          >
            {label}
          </a>
        ) : (
          <span
            key={`inline-link-${match.index}`}
            {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[12].length)}
          >
            {label}
          </span>
        ));
      } else if (typeof match[14] === "string") {
        const contentSourceStart = sourceStart + match.index;
        const href = safeMarkdownHref(match[14]);
        const label = annotationRanges.length || findMatches.length
          ? renderInlineTextWithMarkers(
            match[14],
            contentSourceStart,
            `autolink-${match.index}`,
            annotationRanges,
            findMatches,
          )
          : match[14];
        nodes.push(href ? (
          <a
            href={href}
            key={`inline-autolink-${match.index}`}
            rel="noreferrer"
            target="_blank"
            {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[14].length)}
          >
            {label}
          </a>
        ) : (
          <span
            key={`inline-autolink-${match.index}`}
            {...sourceSegmentAttributes(contentSourceStart, contentSourceStart + match[14].length)}
          >
            {label}
          </span>
        ));
      } else {
        nodes.push(renderKatex(match[8] ?? match[9] ?? "", displayMode, match.index));
      }
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    nodes.push(...renderInlineTextWithMarkers(
      value.slice(cursor),
      sourceStart + cursor,
      `text-${cursor}`,
      annotationRanges,
      findMatches,
    ));
  }
  return nodes.length ? nodes : renderSourceMappedText(value, sourceStart, "text-empty");
}

function MarkdownInlineImage({ alt, src }: { alt: string; src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span data-markdown-image-error="true" role="alert">
        图片加载失败: {alt || src}
      </span>
    );
  }
  return (
    <img
      alt={alt}
      data-markdown-image="true"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

function renderSourceMappedText(value: string, sourceStart: number, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let textIndex = 0;
  while (cursor < value.length) {
    const textStart = cursor;
    while (cursor < value.length && value[cursor] !== "\n" && value[cursor] !== "\r") {
      cursor += 1;
    }
    if (cursor > textStart) {
      nodes.push(
        <span
          data-markdown-source-end={sourceStart + cursor}
          data-markdown-source-start={sourceStart + textStart}
          data-preview-source-end={sourceStart + cursor}
          data-preview-source-start={sourceStart + textStart}
          key={`${keyPrefix}-text-${textIndex}`}
        >
          {value.slice(textStart, cursor)}
        </span>,
      );
      textIndex += 1;
    }
    if (value[cursor] === "\r" || value[cursor] === "\n") {
      const newlineStart = cursor;
      if (value[cursor] === "\r" && value[cursor + 1] === "\n") {
        cursor += 2;
      } else {
        cursor += 1;
      }
      nodes.push(<br key={`${keyPrefix}-br-${newlineStart}`} />);
    }
  }
  return nodes;
}

function sourceSegmentAttributes(sourceStart: number, sourceEnd: number) {
  return {
    "data-markdown-source-end": sourceEnd,
    "data-markdown-source-start": sourceStart,
    "data-preview-source-end": sourceEnd,
    "data-preview-source-start": sourceStart,
  };
}

function safeMarkdownHref(value: string | undefined): string | null {
  const href = value?.trim();
  if (!href) {
    return null;
  }
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (!scheme) {
    return href;
  }
  return /^(https?|mailto|xmpp|irc|ircs)$/.test(scheme) ? href : null;
}

function headingTextSourceStart(block: MarkdownBlock): number {
  const headingMarker = /^(#{1,6})\s+/.exec(block.sourceText);
  if (headingMarker) {
    return block.sourceStart + headingMarker[0].length;
  }
  return block.sourceStart;
}

function markdownCodeContentSourceStart(block: MarkdownBlock): number {
  const fencePrefix = /^(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(block.sourceText);
  if (fencePrefix) {
    return block.sourceStart + fencePrefix[0].length;
  }
  return block.sourceStart;
}

function renderKatex(content: string, displayMode: boolean, index: number): ReactNode {
  const html = katex.renderToString(content, {
    displayMode,
    throwOnError: false,
  });
  const Tag = displayMode ? "span" : "span";
  return (
    <Tag
      data-markdown-math={displayMode ? "display" : "inline"}
      dangerouslySetInnerHTML={{ __html: html }}
      key={`inline-math-${index}`}
    />
  );
}
