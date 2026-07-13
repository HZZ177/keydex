import type { MarkdownSnapshotBlock, MarkdownSnapshotInlineSpan } from "../document/MarkdownSnapshot";
import type {
  MarkdownBlockDomInstance,
  MarkdownBlockRendererContext,
  MarkdownBlockRendererDefinition,
  MarkdownBlockSourceMap,
} from "./types";

export interface MarkdownTableRendererOptions {
  readonly maxVisibleRows?: number;
  readonly overscanRows?: number;
  readonly estimatedRowHeight?: number;
  readonly maxViewportHeight?: number;
}

interface TableModel {
  readonly columns: number;
  readonly alignments: readonly ("left" | "center" | "right" | null)[];
  readonly cellStarts: Int32Array;
  readonly cellEnds: Int32Array;
  readonly cellSpanStarts: Int32Array;
  readonly cellSpanEnds: Int32Array;
  readonly cellCount: number;
  readonly rowCount: number;
  readonly bodyRows: number;
}

export function createTableBlockRenderer(options: MarkdownTableRendererOptions = {}): MarkdownBlockRendererDefinition {
  const maxVisibleRows = positiveInteger(options.maxVisibleRows ?? 200, "maxVisibleRows");
  const overscanRows = nonNegativeInteger(options.overscanRows ?? 12, "overscanRows");
  const estimatedRowHeight = positiveNumber(options.estimatedRowHeight ?? 28, "estimatedRowHeight");
  const maxViewportHeight = positiveNumber(options.maxViewportHeight ?? 560, "maxViewportHeight");
  return {
    create(initial) {
      let context = initial;
      let model = tableModel(initial);
      let wrapper = createWrapper(initial, model, model.bodyRows > maxVisibleRows, maxViewportHeight);
      let body = wrapper.querySelector("tbody")!;
      let rows = new Map<number, HTMLTableRowElement>();
      let rowHeight = estimatedRowHeight;
      let frame: number | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let destroyed = false;

      const renderWindow = () => {
        frame = null;
        if (destroyed) return;
        const total = model.bodyRows;
        const virtual = total > maxVisibleRows;
        const viewportRows = Math.max(1, Math.ceil((wrapper.clientHeight || maxViewportHeight) / rowHeight));
        const count = virtual ? Math.min(maxVisibleRows, viewportRows + overscanRows * 2) : total;
        const requestedFirst = virtual ? Math.max(0, Math.floor(wrapper.scrollTop / rowHeight) - overscanRows) : 0;
        const first = Math.min(Math.max(0, total - count), requestedFirst);
        const last = Math.min(total, first + count);
        const next = new Map<number, HTMLTableRowElement>();
        const fragment = wrapper.ownerDocument.createDocumentFragment();
        if (first > 0) fragment.append(spacerRow(wrapper.ownerDocument, model.columns, first * rowHeight, "top"));
        for (let index = first; index < last; index += 1) {
          const retained = rows.get(index);
          const row = retained ?? renderRow(context, index + 1, false, model);
          next.set(index, row);
          fragment.append(row);
        }
        if (last < total) fragment.append(spacerRow(wrapper.ownerDocument, model.columns, (total - last) * rowHeight, "bottom"));
        body.replaceChildren(fragment);
        rows = next;
        const measured = rows.values().next().value?.getBoundingClientRect().height as number | undefined;
        if (measured && Number.isFinite(measured) && measured > 0) rowHeight = measured;
        wrapper.dataset.markdownTableFirstRow = String(first);
        wrapper.dataset.markdownTableLastRow = String(Math.max(first, last - 1));
        wrapper.dataset.markdownTableMountedRows = String(rows.size);
      };
      const schedule = () => {
        if (frame !== null) return;
        if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(renderWindow);
        else {
          frame = -1;
          queueMicrotask(renderWindow);
        }
      };
      const attach = () => {
        wrapper.addEventListener("scroll", schedule, { passive: true });
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(schedule);
          resizeObserver.observe(wrapper);
        }
      };
      const detach = () => {
        wrapper.removeEventListener("scroll", schedule);
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (frame !== null && frame >= 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        frame = null;
      };
      renderWindow();
      attach();
      const instance: MarkdownBlockDomInstance = {
        get element() { return wrapper; },
        update(next) {
          const rebuild = next.block.content_hash !== context.block.content_hash || next.profile.id !== context.profile.id;
          context = next;
          applyBlockAttributes(wrapper, next);
          if (!rebuild) return "reused";
          detach();
          model = tableModel(next);
          const replacement = createWrapper(next, model, model.bodyRows > maxVisibleRows, maxViewportHeight);
          wrapper.replaceWith(replacement);
          wrapper = replacement;
          body = wrapper.querySelector("tbody")!;
          rows.clear();
          rowHeight = estimatedRowHeight;
          renderWindow();
          attach();
          return "updated";
        },
        sourceMap: () => sourceMap(wrapper, context.block, model, rows.keys()),
        measure: () => {
          const rect = wrapper.getBoundingClientRect();
          return Object.freeze({ width: rect.width, height: rect.height });
        },
        destroy() {
          destroyed = true;
          detach();
          rows.clear();
          wrapper.remove();
        },
      };
      return instance;
    },
  };
}

function createWrapper(
  context: MarkdownBlockRendererContext,
  model: TableModel,
  virtual: boolean,
  maxHeight: number,
): HTMLDivElement {
  const wrapper = context.ownerDocument.createElement("div");
  applyBlockAttributes(wrapper, context);
  wrapper.dataset.markdownTableScroll = "true";
  wrapper.dataset.markdownTableVirtual = virtual ? "true" : "false";
  wrapper.dataset.markdownTableCellCount = String(model.cellCount);
  wrapper.dataset.markdownTableIndexBytes = String(
    model.cellStarts.byteLength + model.cellEnds.byteLength
    + model.cellSpanStarts.byteLength + model.cellSpanEnds.byteLength,
  );
  wrapper.dataset.scrollAxis = virtual ? "both" : "x";
  wrapper.style.overflowX = "auto";
  if (virtual) {
    wrapper.style.overflowY = "auto";
    wrapper.style.maxHeight = `${maxHeight}px`;
  }
  const table = context.ownerDocument.createElement("table");
  const thead = context.ownerDocument.createElement("thead");
  const tbody = context.ownerDocument.createElement("tbody");
  if (model.rowCount > 0) thead.append(renderRow(context, 0, true, model));
  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function renderRow(
  context: MarkdownBlockRendererContext,
  rowIndex: number,
  header: boolean,
  model: TableModel,
): HTMLTableRowElement {
  const element = context.ownerDocument.createElement("tr");
  element.dataset.markdownTableRowIndex = String(rowIndex);
  for (let column = 0; column < model.columns; column += 1) {
    const cellIndex = rowIndex * model.columns + column;
    const exists = cellIndex < model.cellCount;
    const localStart = exists ? model.cellStarts[cellIndex]! : context.block.logical_end - context.block.logical_start;
    const localEnd = exists ? model.cellEnds[cellIndex]! : localStart;
    const spanStart = exists ? model.cellSpanStarts[cellIndex]! : 0;
    const spanEnd = exists ? model.cellSpanEnds[cellIndex]! : 0;
    const item = context.ownerDocument.createElement(header ? "th" : "td");
    item.dataset.markdownTableColumnIndex = String(column);
    item.dataset.markdownLogicalStart = String(context.block.logical_start + localStart);
    item.dataset.markdownLogicalEnd = String(context.block.logical_start + localEnd);
    if (spanEnd > spanStart) {
      let sourceStart = Number.POSITIVE_INFINITY;
      let sourceEnd = 0;
      for (let index = spanStart; index < spanEnd; index += 1) {
        sourceStart = Math.min(sourceStart, context.block.inline_spans[index]!.source_start);
        sourceEnd = Math.max(sourceEnd, context.block.inline_spans[index]!.source_end);
      }
      item.dataset.markdownSourceStart = String(sourceStart);
      item.dataset.markdownSourceEnd = String(sourceEnd);
    }
    const alignment = model.alignments[column];
    if (alignment) item.style.textAlign = alignment;
    renderInlineRange(item, context, localStart, localEnd, spanStart, spanEnd);
    element.append(item);
  }
  return element;
}

function renderInlineRange(
  target: HTMLElement,
  context: MarkdownBlockRendererContext,
  localStart: number,
  localEnd: number,
  spanStart: number,
  spanEnd: number,
): void {
  const text = blockText(context);
  let cursor = localStart;
  for (let index = spanStart; index < spanEnd; index += 1) {
    const span = context.block.inline_spans[index]!;
    const start = Math.max(localStart, span.logical_start - context.block.logical_start);
    const end = Math.min(localEnd, span.logical_end - context.block.logical_start);
    if (start > cursor) target.append(context.ownerDocument.createTextNode(text.slice(cursor, start)));
    if (end <= cursor) continue;
    target.append(inlineElement(context, span, text.slice(Math.max(cursor, start), end)));
    cursor = end;
  }
  if (cursor < localEnd) target.append(context.ownerDocument.createTextNode(text.slice(cursor, localEnd)));
}

function inlineElement(context: MarkdownBlockRendererContext, span: MarkdownSnapshotInlineSpan, text: string): Node {
  if (span.kind === "text") return context.ownerDocument.createTextNode(text);
  const tag = span.kind === "strong" ? "strong"
    : span.kind === "emphasis" ? "em"
      : span.kind === "strikethrough" ? "del"
        : span.kind === "code" ? "code"
          : span.kind === "link" ? "a" : "span";
  const element = context.ownerDocument.createElement(tag);
  element.textContent = text;
  element.dataset.markdownInlineId = span.id;
  element.dataset.markdownInlineKind = span.kind;
  element.dataset.markdownSourceStart = String(span.source_start);
  element.dataset.markdownSourceEnd = String(span.source_end);
  element.dataset.markdownLogicalStart = String(span.logical_start);
  element.dataset.markdownLogicalEnd = String(span.logical_end);
  if (span.kind === "link") {
    const href = String(span.attributes.href ?? "");
    if (!/^(?:javascript|vbscript):/iu.test(href)) (element as HTMLAnchorElement).href = href;
    if (context.interactions.onLinkActivate && href) {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        context.interactions.onLinkActivate?.(event as MouseEvent, { href, block: context.block });
      });
    }
  }
  return element;
}

function tableModel(context: MarkdownBlockRendererContext): TableModel {
  const columns = Math.max(1, context.block.metadata.table?.columns ?? 1);
  const text = blockText(context);
  const { starts, ends } = logicalCellRanges(text);
  const cellSpanStarts = new Int32Array(starts.length);
  const cellSpanEnds = new Int32Array(starts.length);
  const spans = context.block.inline_spans;
  let spanCursor = 0;
  for (let cell = 0; cell < starts.length; cell += 1) {
    const logicalStart = context.block.logical_start + starts[cell]!;
    const logicalEnd = context.block.logical_start + ends[cell]!;
    while (spanCursor < spans.length && spans[spanCursor]!.logical_end <= logicalStart) spanCursor += 1;
    cellSpanStarts[cell] = spanCursor;
    let spanEnd = spanCursor;
    while (spanEnd < spans.length && spans[spanEnd]!.logical_start < logicalEnd) spanEnd += 1;
    cellSpanEnds[cell] = spanEnd;
  }
  const rowCount = Math.ceil(starts.length / columns);
  return Object.freeze({
    columns,
    alignments: context.block.metadata.table?.alignments ?? Object.freeze(Array.from({ length: columns }, () => null)),
    cellStarts: starts,
    cellEnds: ends,
    cellSpanStarts,
    cellSpanEnds,
    cellCount: starts.length,
    rowCount,
    bodyRows: Math.max(0, rowCount - 1),
  });
}

function logicalCellRanges(value: string): { starts: Int32Array; ends: Int32Array } {
  let count = 1;
  for (let index = 0; index < value.length; index += 1) if (value[index] === "\n") count += 1;
  const starts = new Int32Array(count);
  const ends = new Int32Array(count);
  let start = 0;
  let cell = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || value[index] === "\n") {
      starts[cell] = start;
      ends[cell] = index;
      cell += 1;
      start = index + 1;
    }
  }
  return { starts, ends };
}

function spacerRow(owner: Document, columns: number, height: number, position: string): HTMLTableRowElement {
  const row = owner.createElement("tr");
  row.dataset.markdownTableSpacer = position;
  const cell = owner.createElement("td");
  cell.colSpan = columns;
  cell.style.height = `${height}px`;
  cell.style.padding = "0";
  cell.style.border = "0";
  row.append(cell);
  return row;
}

function applyBlockAttributes(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  const block = context.block;
  element.dataset.markdownBlockId = block.id;
  element.dataset.markdownBlockKind = block.kind;
  element.dataset.markdownBlockIndex = String(block.index);
  element.dataset.markdownSourceStart = String(block.source_start);
  element.dataset.markdownSourceEnd = String(block.source_end);
  element.dataset.markdownLogicalStart = String(block.logical_start);
  element.dataset.markdownLogicalEnd = String(block.logical_end);
  element.dataset.markdownRendererProfile = context.profile.id;
}

function sourceMap(
  element: HTMLElement,
  block: MarkdownSnapshotBlock,
  model: TableModel,
  mountedBodyRows: Iterable<number>,
): MarkdownBlockSourceMap {
  const byId = new Map<string, HTMLElement>();
  element.querySelectorAll<HTMLElement>("[data-markdown-inline-id]").forEach((item) => {
    if (item.dataset.markdownInlineId) byId.set(item.dataset.markdownInlineId, item);
  });
  const spanIndices = new Set<number>();
  collectRowSpanIndices(model, 0, spanIndices);
  for (const bodyRow of mountedBodyRows) collectRowSpanIndices(model, bodyRow + 1, spanIndices);
  return Object.freeze({
    blockId: block.id,
    sourceStart: block.source_start,
    sourceEnd: block.source_end,
    logicalStart: block.logical_start,
    logicalEnd: block.logical_end,
    inline: Object.freeze([...spanIndices].sort((left, right) => left - right).map((index) => {
      const span = block.inline_spans[index]!;
      return Object.freeze({ span, element: byId.get(span.id) ?? null });
    })),
  });
}

function collectRowSpanIndices(model: TableModel, row: number, output: Set<number>): void {
  for (let column = 0; column < model.columns; column += 1) {
    const cell = row * model.columns + column;
    if (cell >= model.cellCount) return;
    for (let index = model.cellSpanStarts[cell]!; index < model.cellSpanEnds[cell]!; index += 1) output.add(index);
  }
}

function blockText(context: MarkdownBlockRendererContext): string {
  return context.logicalText.slice(context.block.logical_start, context.block.logical_end);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export const tableBlockRenderer = createTableBlockRenderer();
