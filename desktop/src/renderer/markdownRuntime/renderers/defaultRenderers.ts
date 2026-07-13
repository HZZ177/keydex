import katex from "katex";

import type {
  MarkdownSnapshotBlock,
  MarkdownSnapshotInlineSpan,
  MarkdownSnapshotResource,
} from "../document/MarkdownSnapshot";
import type {
  MarkdownBlockDomInstance,
  MarkdownBlockRendererContext,
  MarkdownBlockRendererDefinition,
  MarkdownBlockRendererDefinitions,
  MarkdownBlockSourceMap,
  MarkdownBlockUpdateResult,
} from "./types";
import { codeBlockRenderer } from "./CodeBlockRenderer";
import { replaceMarkdownActionIcon } from "./domIcons";
import { tableBlockRenderer } from "./TableBlockRenderer";

type ElementFactory = (context: MarkdownBlockRendererContext) => HTMLElement;
type ContentBuilder = (element: HTMLElement, context: MarkdownBlockRendererContext) => void;

export const defaultSemanticMarkdownRenderers: MarkdownBlockRendererDefinitions = Object.freeze({
  heading: semanticRenderer(
    (context) => context.ownerDocument.createElement(`h${context.block.metadata.heading_level ?? 1}`),
    (element, context) => renderInlineRange(element, context, 0, blockText(context).length),
  ),
  paragraph: appendableParagraphRenderer(),
  blockquote: semanticRenderer(
    (context) => context.ownerDocument.createElement("blockquote"),
    (element, context) => {
      const paragraph = context.ownerDocument.createElement("p");
      renderInlineRange(paragraph, context, 0, blockText(context).length);
      element.append(paragraph);
    },
  ),
  list: semanticRenderer(
    (context) => context.ownerDocument.createElement(context.block.metadata.list?.ordered ? "ol" : "ul"),
    renderList,
  ),
  table: tableBlockRenderer,
  code: codeBlockRenderer,
  mermaid: semanticRenderer((context) => context.ownerDocument.createElement("div"), renderCode),
  image: semanticRenderer((context) => context.ownerDocument.createElement("figure"), renderBlockImage),
  math: semanticRenderer((context) => context.ownerDocument.createElement("div"), renderMath),
  html: semanticRenderer((context) => context.ownerDocument.createElement("pre"), renderEscapedSource),
  frontmatter: semanticRenderer((context) => context.ownerDocument.createElement("pre"), renderEscapedSource),
  "thematic-break": semanticRenderer((context) => context.ownerDocument.createElement("hr"), () => undefined),
  unknown: semanticRenderer(
    (context) => context.ownerDocument.createElement("p"),
    (element, context) => renderInlineRange(element, context, 0, blockText(context).length),
  ),
});

function semanticRenderer(createElement: ElementFactory, buildContent: ContentBuilder): MarkdownBlockRendererDefinition {
  return {
    create(context) {
      let current = context;
      let element = createElement(context);
      let cleanups: Array<() => void> = [];
      applyBlockAttributes(element, context);
      buildContent(element, context);
      cleanups = mountResources(element, context);
      const instance: MarkdownBlockDomInstance = {
        get element() {
          return element;
        },
        update(next) {
          const rebuild = next.block.content_hash !== current.block.content_hash
            || next.profile.id !== current.profile.id;
          current = next;
          if (rebuild) {
            cleanups.forEach(safeCleanup);
            cleanups = [];
            const replacement = createElement(next);
            applyBlockAttributes(replacement, next);
            buildContent(replacement, next);
            cleanups = mountResources(replacement, next);
            element.replaceWith(replacement);
            element = replacement;
            return "updated";
          }
          applyBlockAttributes(element, next);
          updateInlineSourceAttributes(element, next.block.inline_spans);
          return "reused";
        },
        sourceMap() {
          return sourceMap(element, current.block);
        },
        measure() {
          const rect = element.getBoundingClientRect();
          return Object.freeze({ width: rect.width, height: rect.height });
        },
        destroy() {
          cleanups.forEach(safeCleanup);
          cleanups = [];
          element.remove();
        },
      };
      return instance;
    },
  };
}

function appendableParagraphRenderer(): MarkdownBlockRendererDefinition {
  return {
    create(initial) {
      let current = initial;
      let element = initial.ownerDocument.createElement("p");
      let cleanups: Array<() => void> = [];
      let virtualPlain: VirtualPlainParagraph | null = null;
      applyBlockAttributes(element, initial);
      if (plainParagraph(initial)) {
        if (blockCharacterLength(initial) > VIRTUAL_PLAIN_PARAGRAPH_THRESHOLD) {
          virtualPlain = new VirtualPlainParagraph(element, initial);
        } else appendPlainTextChunks(element, blockText(initial));
      }
      else renderInlineRange(element, initial, 0, blockText(initial).length);
      cleanups = mountResources(element, initial);
      return {
        get element() { return element; },
        update(next) {
          const appended = appendOnlyPlainParagraph(current, next);
          if (appended !== null) {
            if (virtualPlain) virtualPlain.update(next);
            else if (blockCharacterLength(next) > VIRTUAL_PLAIN_PARAGRAPH_THRESHOLD) {
              virtualPlain = new VirtualPlainParagraph(element, next);
            } else if (appended) appendPlainTextChunks(element, appended);
            applyBlockAttributes(element, next);
            element.dataset.markdownAppendPatches = String(Number(element.dataset.markdownAppendPatches ?? 0) + 1);
            current = next;
            return "updated";
          }
          const rebuild = next.block.content_hash !== current.block.content_hash
            || next.profile.id !== current.profile.id;
          current = next;
          if (rebuild) {
            cleanups.forEach(safeCleanup);
            cleanups = [];
            virtualPlain?.destroy();
            virtualPlain = null;
            const replacement = next.ownerDocument.createElement("p");
            applyBlockAttributes(replacement, next);
            if (plainParagraph(next) && blockCharacterLength(next) > VIRTUAL_PLAIN_PARAGRAPH_THRESHOLD) {
              virtualPlain = new VirtualPlainParagraph(replacement, next);
            } else renderInlineRange(replacement, next, 0, blockText(next).length);
            cleanups = mountResources(replacement, next);
            element.replaceWith(replacement);
            element = replacement;
            return "updated";
          }
          virtualPlain?.refresh();
          applyBlockAttributes(element, next);
          updateInlineSourceAttributes(element, next.block.inline_spans);
          return "reused";
        },
        sourceMap() { return sourceMap(element, current.block); },
        measure() {
          const rect = element.getBoundingClientRect();
          return Object.freeze({ width: rect.width, height: rect.height });
        },
        destroy() {
          virtualPlain?.destroy();
          virtualPlain = null;
          cleanups.forEach(safeCleanup);
          cleanups = [];
          element.remove();
        },
      };
    },
  };
}

const MAX_PLAIN_TEXT_NODE_CHARS = 2 * 1024;
const VIRTUAL_PLAIN_PARAGRAPH_THRESHOLD = 32 * 1024;
const VIRTUAL_PLAIN_OVERSCAN_CHUNKS = 2;
const VIRTUAL_PLAIN_FALLBACK_MOUNTED_CHUNKS = 6;

function plainParagraph(context: MarkdownBlockRendererContext): boolean {
  return context.resources.length === 0 && context.block.inline_spans.every((span) => span.kind === "text");
}

function appendPlainTextChunks(element: HTMLElement, value: string): void {
  let offset = 0;
  const tail = element.lastChild;
  if (tail?.nodeType === Node.TEXT_NODE && tail.textContent !== null && tail.textContent.length < MAX_PLAIN_TEXT_NODE_CHARS) {
    const available = MAX_PLAIN_TEXT_NODE_CHARS - tail.textContent.length;
    const part = value.slice(0, available);
    if (part) (tail as Text).appendData(part);
    offset = part.length;
  }
  while (offset < value.length) {
    const end = Math.min(value.length, offset + MAX_PLAIN_TEXT_NODE_CHARS);
    element.append(element.ownerDocument.createTextNode(value.slice(offset, end)));
    offset = end;
  }
}

class VirtualPlainParagraph {
  private readonly topSpacer: HTMLSpanElement;
  private readonly bottomSpacer: HTMLSpanElement;
  private readonly chunks = new Map<number, HTMLSpanElement>();
  private context: MarkdownBlockRendererContext;
  private disposed = false;

  constructor(private readonly element: HTMLElement, initial: MarkdownBlockRendererContext) {
    this.context = initial;
    this.topSpacer = initial.ownerDocument.createElement("span");
    this.topSpacer.dataset.markdownPlainTopSpacer = "true";
    this.topSpacer.setAttribute("aria-hidden", "true");
    this.topSpacer.style.display = "none";
    this.bottomSpacer = initial.ownerDocument.createElement("span");
    this.bottomSpacer.dataset.markdownPlainBottomSpacer = "true";
    this.bottomSpacer.setAttribute("aria-hidden", "true");
    this.bottomSpacer.style.display = "none";
    this.element.replaceChildren(this.topSpacer, this.bottomSpacer);
    this.element.dataset.markdownVirtualPlainParagraph = "true";
    this.refresh();
  }

  update(next: MarkdownBlockRendererContext): void {
    this.context = next;
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    const length = blockCharacterLength(this.context);
    const count = Math.max(1, Math.ceil(length / MAX_PLAIN_TEXT_NODE_CHARS));
    const { fullChunkHeight, lastChunkHeight, totalHeight } = this.geometry(length, count);
    const mounted = this.mountedRange(count, fullChunkHeight, totalHeight);
    const selected = this.selectedChunkIndexes(count);
    const indexes = new Set<number>();
    for (let index = mounted.start; index < mounted.end; index += 1) indexes.add(index);
    selected.forEach((index) => indexes.add(index));
    const ordered = [...indexes].sort((left, right) => left - right);
    const first = ordered[0] ?? 0;
    const last = ordered.at(-1) ?? first;
    // HeightIndex/canvas own the full logical height. Never stretch this text
    // element with giant spacer boxes: WebView2 can retain native paint/layout
    // backing proportional to that box even when only a few chunks are mounted.
    this.topSpacer.style.height = "0px";
    this.bottomSpacer.style.height = "0px";
    this.topSpacer.dataset.markdownVirtualOffset = String(first * fullChunkHeight);
    const desired: Node[] = [this.topSpacer];
    for (const index of ordered) desired.push(this.chunk(index, count, fullChunkHeight, lastChunkHeight));
    desired.push(this.bottomSpacer);
    reconcileChildren(this.element, desired);
    for (const [index, chunk] of this.chunks) {
      if (indexes.has(index)) continue;
      chunk.remove();
      this.chunks.delete(index);
    }
    this.element.dataset.markdownVirtualPlainTotalCharacters = String(length);
    this.element.dataset.markdownVirtualPlainChunkCount = String(count);
    this.element.dataset.markdownVirtualPlainMountedChunks = String(ordered.length);
    this.element.dataset.markdownVirtualPlainFirstChunk = String(first);
    this.element.dataset.markdownVirtualPlainLastChunk = String(last);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chunks.clear();
    delete this.element.dataset.markdownVirtualPlainParagraph;
  }

  private chunk(index: number, count: number, fullHeight: number, lastHeight: number): HTMLSpanElement {
    const start = index * MAX_PLAIN_TEXT_NODE_CHARS;
    const end = Math.min(blockCharacterLength(this.context), start + MAX_PLAIN_TEXT_NODE_CHARS);
    const absoluteStart = this.context.block.logical_start + start;
    const absoluteEnd = this.context.block.logical_start + end;
    const text = import.meta.env.DEV
      && this.context.ownerDocument.documentElement.dataset.zmdrSuppressVirtualPlainText === "true"
      ? ""
      : this.context.logicalText.slice(absoluteStart, absoluteEnd);
    const chunk = this.chunks.get(index) ?? this.context.ownerDocument.createElement("span");
    chunk.dataset.markdownPlainTextChunk = "true";
    chunk.dataset.markdownPlainTextChunkIndex = String(index);
    chunk.dataset.markdownLogicalStart = String(absoluteStart);
    chunk.dataset.markdownLogicalEnd = String(absoluteEnd);
    chunk.style.display = "block";
    chunk.style.position = "absolute";
    chunk.style.insetInline = "0";
    chunk.style.top = import.meta.env.DEV
      && this.context.ownerDocument.documentElement.dataset.zmdrBoundMarkdownGeometry === "true"
      ? "0px"
      : `${index * fullHeight}px`;
    chunk.style.minHeight = `${index === count - 1 ? lastHeight : fullHeight}px`;
    if (chunk.textContent !== text) chunk.textContent = text;
    this.chunks.set(index, chunk);
    return chunk;
  }

  private geometry(length: number, count: number): { fullChunkHeight: number; lastChunkHeight: number; totalHeight: number } {
    const width = Math.max(320, this.element.clientWidth || this.element.closest<HTMLElement>('[data-message-list-scroll="true"]')?.clientWidth || 800);
    const charactersPerLine = Math.max(8, Math.floor((width - 32) / 8));
    const fullChunkHeight = Math.max(22, Math.ceil(MAX_PLAIN_TEXT_NODE_CHARS / charactersPerLine) * 22);
    const lastCharacters = length - (count - 1) * MAX_PLAIN_TEXT_NODE_CHARS;
    const lastChunkHeight = Math.max(22, Math.ceil(Math.max(1, lastCharacters) / charactersPerLine) * 22);
    return { fullChunkHeight, lastChunkHeight, totalHeight: (count - 1) * fullChunkHeight + lastChunkHeight };
  }

  private mountedRange(count: number, chunkHeight: number, totalHeight: number): { start: number; end: number } {
    const scroller = this.element.closest<HTMLElement>('[data-message-list-scroll="true"]');
    if (!scroller || !this.element.isConnected) {
      return { start: Math.max(0, count - VIRTUAL_PLAIN_FALLBACK_MOUNTED_CHUNKS), end: count };
    }
    const elementRect = this.element.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const visibleTop = Math.max(0, Math.min(totalHeight, scrollerRect.top - elementRect.top));
    const visibleBottom = Math.max(visibleTop, Math.min(totalHeight, scrollerRect.bottom - elementRect.top));
    return {
      start: Math.max(0, Math.floor(visibleTop / chunkHeight) - VIRTUAL_PLAIN_OVERSCAN_CHUNKS),
      end: Math.min(count, Math.ceil(visibleBottom / chunkHeight) + VIRTUAL_PLAIN_OVERSCAN_CHUNKS + 1),
    };
  }

  private selectedChunkIndexes(count: number): number[] {
    const selection = this.element.ownerDocument.getSelection?.();
    if (!selection || selection.rangeCount === 0) return [];
    const indexes = new Set<number>();
    for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
      const range = selection.getRangeAt(rangeIndex);
      for (const node of [range.startContainer, range.endContainer]) {
        const chunk = (node instanceof Element ? node : node.parentElement)
          ?.closest<HTMLElement>("[data-markdown-plain-text-chunk-index]");
        if (!chunk || !this.element.contains(chunk)) continue;
        const index = Number(chunk.dataset.markdownPlainTextChunkIndex);
        if (Number.isSafeInteger(index) && index >= 0 && index < count) indexes.add(index);
      }
    }
    return [...indexes];
  }
}

function blockCharacterLength(context: MarkdownBlockRendererContext): number {
  return Math.max(0, context.block.logical_end - context.block.logical_start);
}

function reconcileChildren(parent: HTMLElement, desired: readonly Node[]): void {
  const desiredSet = new Set(desired);
  for (const child of [...parent.childNodes]) if (!desiredSet.has(child)) child.remove();
  let cursor = parent.firstChild;
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
}

function appendOnlyPlainParagraph(
  previous: MarkdownBlockRendererContext,
  next: MarkdownBlockRendererContext,
): string | null {
  if (
    previous.profile.id !== next.profile.id
    || previous.block.id !== next.block.id
    || previous.block.logical_start !== next.block.logical_start
    || previous.resources.length > 0
    || next.resources.length > 0
    || previous.block.inline_spans.some((span) => span.kind !== "text")
    || next.block.inline_spans.some((span) => span.kind !== "text")
  ) return null;
  const previousLength = previous.block.logical_end - previous.block.logical_start;
  const nextLength = next.block.logical_end - next.block.logical_start;
  if (nextLength <= previousLength) return null;
  const windowSize = Math.min(512, previousLength);
  if (
    previous.logicalText.slice(previous.block.logical_start, previous.block.logical_start + windowSize)
      !== next.logicalText.slice(next.block.logical_start, next.block.logical_start + windowSize)
    || previous.logicalText.slice(previous.block.logical_end - windowSize, previous.block.logical_end)
      !== next.logicalText.slice(next.block.logical_start + previousLength - windowSize, next.block.logical_start + previousLength)
  ) return null;
  return next.logicalText.slice(next.block.logical_start + previousLength, next.block.logical_end);
}

function applyBlockAttributes(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  const { block, profile } = context;
  element.dataset.markdownBlockId = block.id;
  element.dataset.markdownBlockKind = block.kind;
  element.dataset.markdownBlockIndex = String(block.index);
  element.dataset.markdownSourceStart = String(block.source_start);
  element.dataset.markdownSourceEnd = String(block.source_end);
  element.dataset.markdownLogicalStart = String(block.logical_start);
  element.dataset.markdownLogicalEnd = String(block.logical_end);
  element.dataset.markdownRendererProfile = profile.id;
  if (block.kind === "heading") element.dataset.markdownOutlineBlockId = block.id;
}

function renderList(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  const itemMetadata = context.block.metadata.list?.items;
  if (itemMetadata?.length) {
    renderStructuredList(element, context, itemMetadata);
    return;
  }
  const text = blockText(context);
  const ranges = lineRanges(text);
  const expected = context.block.metadata.list?.item_count ?? ranges.length;
  const items = ranges.slice(0, Math.max(expected, 1));
  for (const range of items) {
    const item = context.ownerDocument.createElement("li");
    const marker = listMarker(context.ownerDocument, element.tagName === "OL", null);
    const content = context.ownerDocument.createElement("span");
    content.dataset.markdownListContent = "true";
    renderInlineRange(content, context, range.start, range.end);
    item.append(marker, content);
    element.append(item);
  }
  if (element.tagName === "OL" && context.block.metadata.list?.start !== null) {
    (element as HTMLOListElement).start = context.block.metadata.list?.start ?? 1;
  }
}

function renderStructuredList(
  root: HTMLElement,
  context: MarkdownBlockRendererContext,
  items: NonNullable<NonNullable<MarkdownSnapshotBlock["metadata"]["list"]>["items"]>,
): void {
  interface Level { depth: number; list: HTMLElement; lastItem: HTMLLIElement | null }
  const levels: Level[] = [{ depth: 0, list: root, lastItem: null }];
  for (const itemModel of items) {
    while (levels.length > 1 && levels.at(-1)!.depth > itemModel.depth) levels.pop();
    while (levels.at(-1)!.depth < itemModel.depth) {
      const parent = levels.at(-1)!;
      const nested = context.ownerDocument.createElement(itemModel.ordered ? "ol" : "ul");
      nested.dataset.markdownNestedList = "true";
      if (itemModel.ordered && itemModel.ordinal !== null) (nested as HTMLOListElement).start = itemModel.ordinal;
      (parent.lastItem ?? parent.list).append(nested);
      levels.push({ depth: parent.depth + 1, list: nested, lastItem: null });
    }
    const level = levels.at(-1)!;
    const item = context.ownerDocument.createElement("li");
    item.dataset.markdownListDepth = String(itemModel.depth);
    if (itemModel.checked !== null) item.dataset.markdownTaskItem = "true";
    const marker = listMarker(context.ownerDocument, itemModel.ordered, itemModel.ordinal);
    const content = context.ownerDocument.createElement("span");
    content.dataset.markdownListContent = "true";
    if (itemModel.checked !== null) {
      const checkbox = context.ownerDocument.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = itemModel.checked;
      checkbox.disabled = true;
      checkbox.tabIndex = -1;
      checkbox.dataset.markdownTaskCheckbox = "true";
      checkbox.dataset.markdownSelectionExclude = "true";
      content.append(checkbox);
    }
    renderInlineRange(content, context, itemModel.logical_start, itemModel.logical_end);
    item.append(marker, content);
    level.list.append(item);
    level.lastItem = item;
  }
  if (root.tagName === "OL" && context.block.metadata.list?.start !== null) {
    (root as HTMLOListElement).start = context.block.metadata.list?.start ?? 1;
  }
}

function listMarker(owner: Document, ordered: boolean, ordinal: number | null): HTMLSpanElement {
  const marker = owner.createElement("span");
  marker.dataset.markdownListMarker = "true";
  marker.dataset.markdownSelectionExclude = "true";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = ordered ? `${ordinal ?? 1}. ` : "• ";
  return marker;
}

function renderTable(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  const columns = Math.max(1, context.block.metadata.table?.columns ?? 1);
  const values = blockText(context).split("\n");
  const rows = chunk(values, columns);
  const head = context.ownerDocument.createElement("thead");
  const body = context.ownerDocument.createElement("tbody");
  rows.forEach((valuesInRow, rowIndex) => {
    const row = context.ownerDocument.createElement("tr");
    valuesInRow.forEach((value, columnIndex) => {
      const cell = context.ownerDocument.createElement(rowIndex === 0 ? "th" : "td");
      const alignment = context.block.metadata.table?.alignments[columnIndex];
      if (alignment) cell.style.textAlign = alignment;
      cell.textContent = value;
      row.append(cell);
    });
    (rowIndex === 0 ? head : body).append(row);
  });
  element.append(head, body);
}

function renderCode(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  element.dataset.markdownCodeFrame = "true";
  element.dataset.markdownCodeLanguage = context.block.metadata.language ?? "text";
  if (context.block.kind === "mermaid") {
    element.dataset.markdownMermaidBlock = "true";
    const resource = context.resources.find((entry) => entry.kind === "mermaid");
    if (resource) element.dataset.markdownResourceId = resource.id;
  }
  const header = context.ownerDocument.createElement("div");
  header.dataset.markdownCodeHeader = "true";
  const language = context.ownerDocument.createElement("span");
  language.textContent = context.block.metadata.language ?? "text";
  header.append(language);
  const pre = context.ownerDocument.createElement("pre");
  const code = context.ownerDocument.createElement("code");
  code.textContent = blockText(context);
  if (context.block.metadata.language) code.className = `language-${safeClass(context.block.metadata.language)}`;
  pre.append(code);
  element.append(header, pre);
  if (context.profile.codeActions && context.interactions.onCodeCopy) {
    const button = context.ownerDocument.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", context.block.kind === "mermaid" ? "复制 Mermaid 源码" : "复制代码");
    button.title = context.block.kind === "mermaid" ? "复制 Mermaid 源码" : "复制代码";
    button.dataset.markdownCodeCopy = "true";
    button.dataset.markdownSelectionExclude = "true";
    button.style.userSelect = "none";
    replaceMarkdownActionIcon(button, "copy");
    button.addEventListener("click", () => {
      const result = context.interactions.onCodeCopy?.({
        code: blockText(context),
        language: context.block.metadata.language ?? null,
        block: context.block,
      });
      Promise.resolve(result).then(() => {
        if (!button.isConnected) return;
        replaceMarkdownActionIcon(button, "check");
        button.ownerDocument.defaultView?.setTimeout(() => {
          if (button.isConnected) replaceMarkdownActionIcon(button, "copy");
        }, 1_400);
      }).catch(() => undefined);
    });
    header.append(button);
  }
  if (context.block.kind === "mermaid" && context.interactions.onMermaidPreview) {
    element.dataset.testid = "preview-mermaid-pane";
    element.dataset.layout = "document";
    const open = context.ownerDocument.createElement("button");
    open.type = "button";
    open.setAttribute("aria-label", "打开 Mermaid 预览");
    open.title = "打开 Mermaid 预览";
    open.dataset.markdownSelectionExclude = "true";
    replaceMarkdownActionIcon(open, "maximize");
    open.addEventListener("click", () => context.interactions.onMermaidPreview?.({
      code: blockText(context),
      block: context.block,
    }));
    header.append(open);
  }
}

function renderBlockImage(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  const resource = context.resources.find((entry) => entry.kind === "image");
  const image = context.ownerDocument.createElement("img");
  const src = safeUrl(resource?.url ?? "", true);
  if (src) image.src = src;
  image.alt = resource?.alt ?? "";
  if (resource) image.dataset.markdownResourceId = resource.id;
  installImageInteraction(image, context, src, image.alt);
  element.append(image);
}

function renderMath(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  element.dataset.markdownMath = "display";
  element.setAttribute("role", "math");
  renderKatex(element, stripMathDelimiters(blockText(context), true), true);
}

function renderEscapedSource(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  element.dataset.markdownEscapedSource = "true";
  if (context.block.kind === "html") element.dataset.markdownHtmlPolicy = "escaped";
  if (context.block.kind === "frontmatter") element.dataset.markdownFrontmatter = "yaml";
  const code = context.ownerDocument.createElement("code");
  if (context.block.kind === "frontmatter") code.className = "language-yaml";
  code.textContent = blockText(context);
  element.append(code);
}

function renderInlineRange(
  container: HTMLElement,
  context: MarkdownBlockRendererContext,
  rangeStart: number,
  rangeEnd: number,
): void {
  const text = blockText(context);
  const spans = context.block.inline_spans
    .map((span) => ({
      span,
      start: Math.max(0, span.logical_start - context.block.logical_start),
      end: Math.max(0, span.logical_end - context.block.logical_start),
    }))
    .filter((entry) => entry.end > rangeStart && entry.start < rangeEnd)
    .sort((left, right) => left.start - right.start);
  let cursor = rangeStart;
  for (const entry of spans) {
    const start = Math.max(rangeStart, entry.start);
    const end = Math.min(rangeEnd, entry.end);
    if (start > cursor) container.append(context.ownerDocument.createTextNode(text.slice(cursor, start)));
    if (end <= cursor) continue;
    const value = text.slice(Math.max(cursor, start), end);
    container.append(inlineNode(context, entry.span, value));
    cursor = end;
  }
  if (cursor < rangeEnd) container.append(context.ownerDocument.createTextNode(text.slice(cursor, rangeEnd)));
}

function inlineNode(
  context: MarkdownBlockRendererContext,
  span: MarkdownSnapshotInlineSpan,
  value: string,
): Node {
  if (span.kind === "text") return context.ownerDocument.createTextNode(value);
  if (span.kind === "softbreak" || span.kind === "hardbreak") return context.ownerDocument.createElement("br");
  if (span.kind === "image") {
    const image = context.ownerDocument.createElement("img");
    const src = safeUrl(String(span.attributes.src ?? ""), true);
    if (src) image.src = src;
    image.alt = String(span.attributes.alt ?? value);
    const resource = resourceForInline(context.resources, "image", src);
    if (resource) image.dataset.markdownResourceId = resource.id;
    installImageInteraction(image, context, src, image.alt);
    applyInlineAttributes(image, span);
    return image;
  }
  if (span.kind === "math") {
    const math = context.ownerDocument.createElement("span");
    applyInlineAttributes(math, span);
    math.dataset.markdownMath = "inline";
    math.setAttribute("role", "math");
    renderKatex(math, stripMathDelimiters(value, false), false);
    return math;
  }
  const tag = span.kind === "strong"
    ? "strong"
    : span.kind === "emphasis"
      ? "em"
      : span.kind === "strikethrough"
        ? "del"
        : span.kind === "code"
          ? "code"
          : span.kind === "link"
            ? "a"
            : "span";
  const element = context.ownerDocument.createElement(tag);
  element.textContent = value;
  applyInlineAttributes(element, span);
  if (element.tagName === "A") {
    const anchor = element as HTMLAnchorElement;
    const href = safeUrl(String(span.attributes.href ?? ""), false);
    if (href) anchor.href = href;
    anchor.dataset.markdownLinkNavigation = context.profile.linkNavigation;
    if (context.profile.linkNavigation === "native" && isExternalUrl(href)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
    if (context.profile.linkNavigation === "host" && context.interactions.onLinkActivate && href) {
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        context.interactions.onLinkActivate?.(event, { href, block: context.block });
      });
    }
  }
  if (span.kind === "html") element.dataset.markdownHtmlEscaped = "true";
  return element;
}

function renderKatex(element: HTMLElement, source: string, displayMode: boolean): void {
  try {
    element.innerHTML = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: "warn",
      maxExpand: 1_000,
      maxSize: 20,
      output: "htmlAndMathml",
    });
    element.dataset.markdownMathState = "ready";
  } catch (error) {
    element.replaceChildren();
    element.dataset.markdownMathState = "failed";
    element.setAttribute("role", "alert");
    const label = element.ownerDocument.createElement("span");
    label.textContent = "Math render failed";
    const code = element.ownerDocument.createElement("code");
    code.textContent = source;
    element.append(label, code);
    element.title = error instanceof Error ? error.message : String(error);
  }
}

function stripMathDelimiters(value: string, display: boolean): string {
  const trimmed = value.trim();
  if (display && trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (!display && trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function installImageInteraction(
  image: HTMLImageElement,
  context: MarkdownBlockRendererContext,
  src: string,
  alt: string,
): void {
  image.dataset.markdownImageActivation = context.profile.imageActivation;
  if (context.profile.imageActivation === "preview" && context.interactions.onImageActivate && src) {
    image.addEventListener("click", (event) => {
      context.interactions.onImageActivate?.(event, {
        src: image.currentSrc || image.getAttribute("src") || src,
        alt,
        block: context.block,
      });
    });
  }
}

function applyInlineAttributes(element: HTMLElement, span: MarkdownSnapshotInlineSpan): void {
  element.dataset.markdownInlineId = span.id;
  element.dataset.markdownInlineKind = span.kind;
  element.dataset.markdownSourceStart = String(span.source_start);
  element.dataset.markdownSourceEnd = String(span.source_end);
  element.dataset.markdownLogicalStart = String(span.logical_start);
  element.dataset.markdownLogicalEnd = String(span.logical_end);
}

function updateInlineSourceAttributes(element: HTMLElement, spans: readonly MarkdownSnapshotInlineSpan[]): void {
  const byId = new Map(spans.map((span) => [span.id, span]));
  element.querySelectorAll<HTMLElement>("[data-markdown-inline-id]").forEach((entry) => {
    const span = byId.get(entry.dataset.markdownInlineId ?? "");
    if (span) applyInlineAttributes(entry, span);
  });
}

function mountResources(element: HTMLElement, context: MarkdownBlockRendererContext): Array<() => void> {
  if (!context.resourceLifecycle) return [];
  const resourceElements = new Map<string, HTMLElement>();
  element.querySelectorAll<HTMLElement>("[data-markdown-resource-id]").forEach((entry) => {
    const id = entry.dataset.markdownResourceId;
    if (id) resourceElements.set(id, entry);
  });
  const cleanups: Array<() => void> = [];
  for (const resource of context.resources) {
    const cleanup = context.resourceLifecycle.mount(resource, resourceElements.get(resource.id) ?? element, context);
    if (cleanup) cleanups.push(cleanup);
  }
  return cleanups;
}

function sourceMap(element: HTMLElement, block: MarkdownSnapshotBlock): MarkdownBlockSourceMap {
  const elements = new Map<string, HTMLElement>();
  element.querySelectorAll<HTMLElement>("[data-markdown-inline-id]").forEach((entry) => {
    const id = entry.dataset.markdownInlineId;
    if (id) elements.set(id, entry);
  });
  return Object.freeze({
    blockId: block.id,
    sourceStart: block.source_start,
    sourceEnd: block.source_end,
    logicalStart: block.logical_start,
    logicalEnd: block.logical_end,
    inline: Object.freeze(block.inline_spans.map((span) => Object.freeze({
      span,
      element: elements.get(span.id) ?? null,
    }))),
  });
}

function blockText(context: MarkdownBlockRendererContext): string {
  return context.logicalText.slice(context.block.logical_start, context.block.logical_end);
}

function lineRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || value[index] === "\n") {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  return ranges;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

function resourceForInline(
  resources: readonly MarkdownSnapshotResource[],
  kind: MarkdownSnapshotResource["kind"],
  url: string,
): MarkdownSnapshotResource | undefined {
  return resources.find((resource) => resource.kind === kind && safeUrl(resource.url ?? "", true) === url);
}

function safeUrl(value: string, image: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(?:javascript|vbscript):/iu.test(trimmed)) return "";
  if (/^data:/iu.test(trimmed) && !(image && /^data:image\//iu.test(trimmed))) return "";
  if (image && /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)
    && !/^(?:https?:|blob:|data:image\/)/iu.test(trimmed)) return "";
  return trimmed;
}

function isExternalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function safeClass(value: string): string {
  return value.replace(/[^a-z0-9_-]/giu, "-").slice(0, 64);
}

function safeCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Resource cleanup is isolated to its block.
  }
}
