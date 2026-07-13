import type {
  MarkdownMappedPosition,
  MarkdownMountedBlockResolver,
  MarkdownPositionMapper,
} from "../mapping";

export type MarkdownHitRegionKind =
  | "text"
  | "link"
  | "code"
  | "code-action"
  | "table-cell"
  | "image"
  | "annotation";

export interface MarkdownHitRegion {
  readonly kind: MarkdownHitRegionKind;
  readonly element: HTMLElement;
  readonly href: string | null;
  readonly resourceId: string | null;
  readonly annotationId: string | null;
  readonly tableRow: number | null;
  readonly tableColumn: number | null;
}

export interface MarkdownHitTestResult {
  readonly status: "hit" | "none" | "stale";
  readonly reason: "outside-root" | "no-block" | "recycled-node" | "no-region" | null;
  readonly revision: string;
  readonly blockId: string | null;
  readonly blockIndex: number | null;
  readonly blockElement: HTMLElement | null;
  readonly region: MarkdownHitRegion | null;
  readonly position: MarkdownMappedPosition | null;
  readonly rect: DOMRectReadOnly | null;
}

export interface MarkdownHitTestControllerOptions {
  readonly root: HTMLElement;
  readonly mapper: MarkdownPositionMapper;
  readonly mounted: MarkdownMountedBlockResolver;
  readonly onHit?: (result: MarkdownHitTestResult, event: Event) => void;
}

export interface MarkdownHitTestDiagnostics {
  readonly revision: string;
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly attached: boolean;
}

export class MarkdownHitTestController {
  private mapper: MarkdownPositionMapper;
  private readonly root: HTMLElement;
  private readonly mounted: MarkdownMountedBlockResolver;
  private readonly onHit?: (result: MarkdownHitTestResult, event: Event) => void;
  private attached = false;
  private disposed = false;
  private hits = 0;
  private misses = 0;
  private stale = 0;

  constructor(options: MarkdownHitTestControllerOptions) {
    this.root = options.root;
    this.mapper = options.mapper;
    this.mounted = options.mounted;
    this.onHit = options.onHit;
  }

  attach(): () => void {
    this.assertActive();
    if (this.attached) return () => this.detach();
    this.attached = true;
    this.root.addEventListener("click", this.handleEvent);
    this.root.addEventListener("pointerdown", this.handleEvent);
    return () => this.detach();
  }

  setMapper(mapper: MarkdownPositionMapper): void {
    this.assertActive();
    this.mapper = mapper;
  }

  hitTestEvent(event: MouseEvent | PointerEvent): MarkdownHitTestResult {
    this.assertActive();
    const target = event.composedPath().find((entry) => entry instanceof Node) as Node | undefined;
    return this.hitTestNode(target ?? null, undefined, { x: event.clientX, y: event.clientY });
  }

  hitTestNode(
    target: Node | null,
    offset?: number,
    point?: { readonly x: number; readonly y: number },
  ): MarkdownHitTestResult {
    this.assertActive();
    if (!target || (!this.root.contains(target) && target !== this.root)) {
      return this.miss("none", "outside-root");
    }
    const element = target instanceof HTMLElement ? target : target.parentElement;
    const blockElement = element?.closest<HTMLElement>("[data-markdown-block-id]") ?? null;
    if (!blockElement || !this.root.contains(blockElement)) return this.miss("none", "no-block");
    const blockId = blockElement.dataset.markdownBlockId ?? "";
    const blockIndex = blockElement.dataset.markdownBlockIndex;
    if (!blockId || this.mounted.getBlockElement(blockId) !== blockElement
      || !/^\d+$/u.test(blockIndex ?? "")) {
      return this.miss("stale", "recycled-node", blockId || null, blockElement);
    }
    const region = resolveRegion(element!, blockElement);
    if (!region) return this.miss("none", "no-region", blockId, blockElement);
    const domPoint = point ? caretPoint(blockElement, point.x, point.y) : null;
    const mapped = domPoint
      ? this.mapper.domPosition(domPoint.node, domPoint.offset)
      : offset !== undefined
        ? this.mapper.domPosition(target, offset)
        : mapFallbackPosition(this.mapper, element!, blockElement);
    this.hits += 1;
    return Object.freeze({
      status: "hit",
      reason: null,
      revision: this.mapper.snapshot.revision,
      blockId,
      blockIndex: Number(blockIndex),
      blockElement,
      region,
      position: mapped.status === "unmapped" ? null : mapped,
      rect: region.element.getBoundingClientRect(),
    });
  }

  diagnostics(): MarkdownHitTestDiagnostics {
    return Object.freeze({
      revision: this.mapper.snapshot.revision,
      hits: this.hits,
      misses: this.misses,
      stale: this.stale,
      attached: this.attached,
    });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.root.removeEventListener("click", this.handleEvent);
    this.root.removeEventListener("pointerdown", this.handleEvent);
  }

  destroy(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
  }

  private readonly handleEvent = (event: Event) => {
    if (!(event instanceof MouseEvent)) return;
    this.onHit?.(this.hitTestEvent(event), event);
  };

  private miss(
    status: "none" | "stale",
    reason: Exclude<MarkdownHitTestResult["reason"], null>,
    blockId: string | null = null,
    blockElement: HTMLElement | null = null,
  ): MarkdownHitTestResult {
    this.misses += 1;
    if (status === "stale") this.stale += 1;
    return Object.freeze({
      status,
      reason,
      revision: this.mapper.snapshot.revision,
      blockId,
      blockIndex: null,
      blockElement,
      region: null,
      position: null,
      rect: null,
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown HitTestController is destroyed");
  }
}

function resolveRegion(element: HTMLElement, block: HTMLElement): MarkdownHitRegion | null {
  const annotation = boundedClosest(element, block, "[data-annotation-id]");
  if (annotation) return region("annotation", annotation, { annotationId: annotation.dataset.annotationId ?? null });
  const codeAction = boundedClosest(element, block, "[data-markdown-code-copy]");
  if (codeAction) return region("code-action", codeAction);
  const link = boundedClosest<HTMLAnchorElement>(element, block, "a");
  if (link) return region("link", link, { href: link.getAttribute("href") });
  const image = boundedClosest<HTMLImageElement>(element, block, "img");
  if (image) return region("image", image, { resourceId: image.dataset.markdownResourceId ?? null });
  const cell = boundedClosest<HTMLTableCellElement>(element, block, "th,td");
  if (cell) {
    const row = cell.parentElement as HTMLTableRowElement | null;
    const section = row?.parentElement;
    const table = section?.closest("table");
    const rows = table ? [...table.querySelectorAll("tr")] : [];
    const stableRow = row?.dataset.markdownTableRowIndex;
    return region("table-cell", cell, {
      tableRow: stableRow === undefined ? (row ? rows.indexOf(row) : null) : Number(stableRow),
      tableColumn: row ? [...row.children].indexOf(cell) : null,
    });
  }
  const code = boundedClosest(element, block, "code,pre,[data-markdown-code-frame]");
  if (code) return region("code", code);
  return region("text", block);
}

function region(
  kind: MarkdownHitRegionKind,
  element: HTMLElement,
  overrides: Partial<Omit<MarkdownHitRegion, "kind" | "element">> = {},
): MarkdownHitRegion {
  return Object.freeze({
    kind,
    element,
    href: null,
    resourceId: null,
    annotationId: null,
    tableRow: null,
    tableColumn: null,
    ...overrides,
  });
}

function boundedClosest<T extends HTMLElement = HTMLElement>(
  element: HTMLElement,
  block: HTMLElement,
  selector: string,
): T | null {
  const match = element.closest<T>(selector);
  return match && block.contains(match) ? match : null;
}

function caretPoint(
  block: HTMLElement,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const doc = block.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position && block.contains(position.offsetNode)) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range && block.contains(range.startContainer)) {
    return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function mapFallbackPosition(
  mapper: MarkdownPositionMapper,
  element: HTMLElement,
  block: HTMLElement,
): MarkdownMappedPosition {
  const walker = block.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest("[data-markdown-selection-exclude]")) continue;
    const mapped = mapper.domPosition(node, 0);
    if (mapped.status !== "unmapped") return mapped;
  }
  return mapper.domPosition(block, 0);
}
