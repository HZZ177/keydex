import {
  MarkdownHeightIndex,
  type MarkdownHeightUpdate,
} from "../layout/HeightIndex";
import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import type { MarkdownSnapshotBlock } from "../document/MarkdownSnapshot";
import {
  RetainedMarkdownDocumentRenderer,
  type MarkdownDocumentRenderStats,
  type MarkdownRendererInteractionHandlers,
  type MarkdownRendererProfile,
  type MarkdownRendererResourceLifecycle,
  type SemanticMarkdownRendererRegistry,
} from "../renderers";
import {
  MarkdownViewportController,
  type MarkdownViewportControllerOptions,
  type MarkdownViewportInput,
  type MarkdownViewportItem,
  type MarkdownViewportResult,
} from "./ViewportController";
import {
  MarkdownScrollAnchorController,
  type MarkdownScrollAnchorControllerOptions,
  type MarkdownScrollAnchorDiagnostics,
} from "./ScrollAnchorController";

export interface DocumentViewRuntimeOptions {
  readonly profile: MarkdownRendererProfile;
  readonly registry?: SemanticMarkdownRendererRegistry;
  readonly interactions?: MarkdownRendererInteractionHandlers;
  readonly resourceLifecycle?: MarkdownRendererResourceLifecycle;
  readonly viewport?: MarkdownViewportControllerOptions;
  readonly scrollAnchor?: MarkdownScrollAnchorControllerOptions;
  readonly protectFocusAndSelection?: boolean;
  readonly onFoldChange?: (
    foldedBlockIds: readonly string[],
    patch: DocumentViewPatchResult | null,
  ) => void;
  readonly now?: () => number;
}

export interface DocumentViewPatchResult {
  readonly revision: string;
  readonly viewport: MarkdownViewportResult;
  readonly render: MarkdownDocumentRenderStats;
  readonly protectedIndices: readonly number[];
  readonly mountedBlockRoots: number;
  readonly durationMs: number;
}

export interface DocumentViewportUpdateOptions {
  readonly origin?: "user" | "programmatic" | "automatic";
}

export interface DocumentViewPublishOptions {
  readonly preserveRevisionGeometry?: boolean;
}

export class DocumentViewRuntime {
  readonly canvas: HTMLDivElement;
  readonly topSpacer: HTMLDivElement;
  readonly bottomSpacer: HTMLDivElement;
  readonly sourceGutter: HTMLDivElement | null;
  readonly foldOverlay: HTMLDivElement | null;
  private readonly renderer: RetainedMarkdownDocumentRenderer;
  private readonly viewportOptions: MarkdownViewportControllerOptions;
  private readonly protectFocusAndSelection: boolean;
  private readonly now: () => number;
  private readonly scrollAnchorOptions: MarkdownScrollAnchorControllerOptions;
  private readonly onFoldChange?: DocumentViewRuntimeOptions["onFoldChange"];
  private heightIndex: MarkdownHeightIndex | null = null;
  private baseHeights: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private viewport: MarkdownViewportController | null = null;
  private scrollAnchor: MarkdownScrollAnchorController | null = null;
  private snapshot: MarkdownSnapshot | null = null;
  private blockIndexById = new Map<string, number>();
  private sourceGutterBlocks = new Map<string, HTMLDivElement>();
  private foldSummaries = new Map<string, HTMLDivElement>();
  private foldDescriptors = new Map<string, MarkdownFoldDescriptor>();
  private foldedBlockIds = new Set<string>();
  private hiddenBlockIndices = new Set<number>();
  private visibleBlockIndices: readonly number[] = Object.freeze([]);
  private renderedBlockIds: readonly string[] = Object.freeze([]);
  private foldMotionTimer: number | null = null;
  private pendingCollapseBlockId: string | null = null;
  private lastViewportInput: MarkdownViewportInput | null = null;
  private disposed = false;

  constructor(
    readonly host: HTMLElement,
    options: DocumentViewRuntimeOptions,
  ) {
    this.viewportOptions = {
      maxPinnedBlocks: 128,
      ...options.viewport,
    };
    this.protectFocusAndSelection = options.protectFocusAndSelection ?? true;
    this.now = options.now ?? (() => performance.now());
    this.scrollAnchorOptions = { now: this.now, ...options.scrollAnchor };
    this.onFoldChange = options.onFoldChange;
    this.topSpacer = host.ownerDocument.createElement("div");
    this.topSpacer.hidden = true;
    this.topSpacer.dataset.markdownTopSpacer = "true";
    this.canvas = host.ownerDocument.createElement("div");
    this.canvas.dataset.markdownDocumentCanvas = "true";
    this.canvas.style.position = "relative";
    this.canvas.style.width = "100%";
    this.bottomSpacer = host.ownerDocument.createElement("div");
    this.bottomSpacer.hidden = true;
    this.bottomSpacer.dataset.markdownBottomSpacer = "true";
    this.sourceGutter = options.profile.id === "file-preview"
      ? host.ownerDocument.createElement("div")
      : null;
    this.foldOverlay = this.sourceGutter ? host.ownerDocument.createElement("div") : null;
    if (this.sourceGutter) {
      this.sourceGutter.dataset.markdownPreviewSourceGutter = "true";
      this.sourceGutter.addEventListener("click", this.handleGutterClick);
      host.style.position = "relative";
      host.dataset.markdownPreviewSourceGutterHost = "true";
    }
    if (this.foldOverlay) {
      this.foldOverlay.dataset.markdownPreviewFoldOverlay = "true";
      this.foldOverlay.setAttribute("aria-hidden", "true");
    }
    host.replaceChildren(
      this.topSpacer,
      this.canvas,
      this.bottomSpacer,
      ...(this.sourceGutter ? [this.sourceGutter] : []),
      ...(this.foldOverlay ? [this.foldOverlay] : []),
    );
    host.dataset.markdownDocumentViewRuntime = "true";
    this.renderer = new RetainedMarkdownDocumentRenderer(this.canvas, {
      profile: options.profile,
      registry: options.registry,
      interactions: options.interactions,
      resourceLifecycle: options.resourceLifecycle,
    });
  }

  publish(
    snapshot: MarkdownSnapshot,
    heights: ArrayLike<number>,
    viewportInput: MarkdownViewportInput,
    options: DocumentViewPublishOptions = {},
  ): DocumentViewPatchResult {
    this.assertActive();
    if (heights.length !== snapshot.blocks.length) {
      throw new Error(`Height count ${heights.length} does not match ${snapshot.blocks.length} blocks`);
    }
    const stabilizedHeights = options.preserveRevisionGeometry
      ? this.stabilizeRevisionHeights(snapshot, heights)
      : Float64Array.from(heights, (height) => normalizedHeight(height));
    this.snapshot = snapshot;
    const blockIds = new Array<string>(snapshot.blocks.length);
    this.blockIndexById = new Map();
    for (const block of snapshot.blocks) {
      this.blockIndexById.set(block.id, block.index);
      blockIds[block.index] = block.id;
    }
    this.baseHeights = stabilizedHeights;
    this.foldDescriptors = buildFoldDescriptors(snapshot.blocks);
    this.foldedBlockIds = new Set(
      [...this.foldedBlockIds].filter((blockId) => this.foldDescriptors.has(blockId)),
    );
    this.rebuildFoldProjection();
    const hasFoldProjection = this.hiddenBlockIndices.size > 0 || this.foldedBlockIds.size > 0;
    const nextHeightIndex = new MarkdownHeightIndex(
      snapshot.revision,
      hasFoldProjection
        ? snapshot.blocks.map((block) => this.effectiveHeightAt(block.index))
        : this.baseHeights,
    );
    if (this.viewport) this.viewport.reset(nextHeightIndex);
    else this.viewport = new MarkdownViewportController(nextHeightIndex, this.viewportOptions);
    this.heightIndex = nextHeightIndex;
    if (this.scrollAnchor) this.scrollAnchor.reset(nextHeightIndex, blockIds, this.blockIndexById);
    else this.scrollAnchor = new MarkdownScrollAnchorController(
      nextHeightIndex,
      blockIds,
      this.scrollAnchorOptions,
      this.blockIndexById,
    );
    return this.updateViewport(
      { ...viewportInput, revision: snapshot.revision },
      { origin: "programmatic" },
    );
  }

  private stabilizeRevisionHeights(snapshot: MarkdownSnapshot, heights: ArrayLike<number>): Float64Array {
    const next = new Float64Array(heights.length);
    for (let index = 0; index < heights.length; index += 1) {
      next[index] = normalizedHeight(heights[index]);
    }
    const previousSnapshot = this.snapshot;
    if (!previousSnapshot || this.baseHeights.length !== previousSnapshot.blocks.length) return next;
    const previousById = new Map(previousSnapshot.blocks.map((block) => [block.id, block]));
    const nextIds = new Set(snapshot.blocks.map((block) => block.id));
    for (const block of snapshot.blocks) {
      const exact = previousById.get(block.id);
      if (exact) {
        next[block.index] = this.baseHeights[exact.index]!;
        continue;
      }
      const positional = previousSnapshot.blocks[block.index];
      if (positional && positional.kind === block.kind && !nextIds.has(positional.id)) {
        next[block.index] = this.baseHeights[positional.index]!;
      }
    }
    return next;
  }

  updateViewport(
    input: MarkdownViewportInput,
    options: DocumentViewportUpdateOptions = {},
  ): DocumentViewPatchResult {
    this.assertActive();
    const snapshot = this.snapshot;
    const viewport = this.viewport;
    if (!snapshot || !viewport || !this.heightIndex) throw new Error("Document View Runtime has no published Snapshot");
    const startedAt = this.now();
    const origin = options.origin ?? "user";
    if (this.lastViewportInput && input.scrollTop !== this.lastViewportInput.scrollTop) {
      if (origin === "user") this.scrollAnchor?.recordUserScroll(input.scrollTop);
      else if (origin === "programmatic") this.scrollAnchor?.recordProgrammaticScroll(input.scrollTop);
    }
    const protectedIndices = this.protectedIndices();
    const pinned = new Set<number>(input.pinnedIndices ?? []);
    protectedIndices.forEach((index) => pinned.add(index));
    const result = viewport.update({
      ...input,
      includedIndices: this.hiddenBlockIndices.size > 0 ? this.visibleBlockIndices : undefined,
      pinnedIndices: pinned,
      revision: snapshot.revision,
    });
    const renderedItems = result.items.filter((item) => !this.isCollapsedBlock(item.index));
    const render = this.renderer.render(snapshot, {
      blockIndices: renderedItems.map((item) => item.index),
    });
    this.renderedBlockIds = Object.freeze(renderedItems.map((item) => snapshot.blocks[item.index]!.id));
    for (const item of renderedItems) {
      const block = snapshot.blocks[item.index];
      const element = this.renderer.getBlockElement(block.id);
      if (!element) continue;
      element.style.position = "absolute";
      if (this.sourceGutter) {
        element.style.removeProperty("inset-inline");
        element.style.insetInlineStart = `${sourceGutterWidth(snapshot.line_count) + 8}px`;
        element.style.insetInlineEnd = "0";
      } else {
        element.style.insetInline = "0";
      }
      // Absolute block-root margins shift painted content without contributing
      // to HeightIndex. Keep root margins neutral and let the index own the
      // complete inter-block gap, otherwise a 12px paragraph margin consumes a
      // 12px indexed gap and the next code header visually collides with it.
      element.style.marginBlockStart = "0";
      element.style.marginBlockEnd = "0";
      // These offsets change only when the height index changes; scrolling does
      // not animate them. `transform` can promote a very tall virtual paragraph
      // to a compositor layer and make WebView2 retain gigabytes of native
      // backing stores. Ordinary absolute `top` keeps rasterization viewport-
      // bounded while preserving O(visible blocks) DOM placement.
      element.style.top = `${item.top}px`;
      if (element.style.transform) element.style.removeProperty("transform");
      // Estimated heights belong only to HeightIndex. Applying the estimate as
      // a DOM minimum creates a measurement feedback loop and leaves short
      // paragraphs with the estimator's trailing block gap as visible blank
      // space.
      if (element.style.minHeight) element.style.removeProperty("min-height");
      element.dataset.markdownBlockTop = String(item.top);
      element.dataset.markdownBlockHeight = String(item.height);
      element.dataset.markdownBlockVisible = item.visible ? "true" : "false";
      element.dataset.markdownBlockPinned = item.pinned ? "true" : "false";
    }
    const totalHeight = result.totalHeight;
    const displayedTotalHeight = import.meta.env.DEV
      && this.host.ownerDocument.documentElement.dataset.zmdrBoundMarkdownGeometry === "true"
      ? Math.min(1_000, totalHeight)
      : totalHeight;
    this.canvas.style.height = `${displayedTotalHeight}px`;
    this.canvas.dataset.markdownTotalHeight = String(totalHeight);
    this.topSpacer.style.height = `${result.topSpacer}px`;
    this.topSpacer.dataset.markdownSpacerHeight = String(result.topSpacer);
    this.bottomSpacer.style.height = `${result.bottomSpacer}px`;
    this.bottomSpacer.dataset.markdownSpacerHeight = String(result.bottomSpacer);
    this.host.dataset.markdownMountedBlockCount = String(renderedItems.length);
    this.host.dataset.markdownRevision = snapshot.revision;
    this.updateSourceGutter(snapshot, result.items, input, displayedTotalHeight);
    this.updateFoldSummaries(snapshot, result.items, displayedTotalHeight);
    this.lastViewportInput = Object.freeze({ ...input, revision: snapshot.revision });
    return Object.freeze({
      revision: snapshot.revision,
      viewport: result,
      render,
      protectedIndices: Object.freeze([...protectedIndices].sort((left, right) => left - right)),
      mountedBlockRoots: renderedItems.length,
      durationMs: Math.max(0, this.now() - startedAt),
    });
  }

  updateMeasuredHeights(
    updates: readonly MarkdownHeightUpdate[],
    revision: string,
  ): DocumentViewPatchResult | null {
    this.assertActive();
    if (!this.heightIndex) throw new Error("Document View Runtime has no HeightIndex");
    if (revision !== this.heightIndex.revision) {
      throw new Error(`Stale height revision ${revision}; current revision is ${this.heightIndex.revision}`);
    }
    const effectiveUpdates = updates.map((update) => {
      if (!Number.isSafeInteger(update.index) || update.index < 0 || update.index >= this.baseHeights.length) {
        throw new RangeError(`Measured Markdown block ${update.index} is out of range`);
      }
      this.baseHeights[update.index] = normalizedHeight(update.height);
      return Object.freeze({
        ...update,
        height: this.effectiveHeightAt(update.index),
      });
    });
    if (!this.lastViewportInput) {
      const delta = this.heightIndex.updateBatch(effectiveUpdates, { revision });
      return delta === 0 ? null : this.updateViewport({ scrollTop: 0, viewportHeight: 0 }, { origin: "automatic" });
    }
    const anchor = this.scrollAnchor?.capture({
      scrollTop: this.lastViewportInput.scrollTop,
      viewportHeight: this.lastViewportInput.viewportHeight,
    });
    if (!anchor || !this.scrollAnchor) {
      const delta = this.heightIndex.updateBatch(effectiveUpdates, { revision });
      return delta === 0 ? null : this.updateViewport(this.lastViewportInput, { origin: "automatic" });
    }
    const correction = this.scrollAnchor.applyHeightUpdates(anchor, effectiveUpdates, {
      revision,
      currentScrollTop: this.lastViewportInput.scrollTop,
      viewportHeight: this.lastViewportInput.viewportHeight,
    });
    if (!correction.heightChanged) return null;
    return this.updateViewport({
      ...this.lastViewportInput,
      scrollTop: correction.scrollTop,
    }, { origin: "automatic" });
  }

  scrollAnchorDiagnostics(): MarkdownScrollAnchorDiagnostics | null {
    return this.scrollAnchor?.diagnostics() ?? null;
  }

  currentSnapshot(): MarkdownSnapshot | null {
    return this.snapshot;
  }

  getBlockElement(blockId: string): HTMLElement | null {
    return this.renderer.getBlockElement(blockId);
  }

  getBlockIndex(blockId: string): number | null {
    return this.blockIndexById.get(blockId) ?? null;
  }

  getBlockSourceMap(blockId: string) {
    return this.renderer.sourceMap(blockId);
  }

  getHeightIndex(): MarkdownHeightIndex | null {
    return this.heightIndex;
  }

  baseHeightAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.baseHeights.length) {
      throw new RangeError(`Base Markdown height ${index} is out of range`);
    }
    return this.baseHeights[index]!;
  }

  isBlockContentMeasurable(blockId: string): boolean {
    const index = this.blockIndexById.get(blockId);
    return index !== undefined
      && !this.hiddenBlockIndices.has(index)
      && !this.isCollapsedBlock(index)
      && this.renderedBlockIds.includes(blockId);
  }

  currentFoldedBlockIds(): readonly string[] {
    return Object.freeze([...this.foldedBlockIds]);
  }

  setFoldedBlockIds(blockIds: readonly string[]): DocumentViewPatchResult | null {
    this.assertActive();
    const next = new Set(blockIds);
    if (this.snapshot) {
      for (const blockId of next) {
        if (!this.foldDescriptors.has(blockId)) next.delete(blockId);
      }
    }
    if (setsEqual(this.foldedBlockIds, next)) return null;
    this.cancelFoldMotion();
    this.foldedBlockIds = next;
    if (!this.snapshot || !this.heightIndex) return null;
    return this.applyFoldProjection();
  }

  expandForBlock(blockId: string): DocumentViewPatchResult | null {
    const targetIndex = this.blockIndexById.get(blockId);
    if (targetIndex === undefined || this.foldedBlockIds.size === 0) return null;
    const next = new Set(this.foldedBlockIds);
    next.delete(blockId);
    for (const foldedId of this.foldedBlockIds) {
      const descriptor = this.foldDescriptors.get(foldedId);
      if (descriptor?.kind === "section"
        && targetIndex > descriptor.index
        && targetIndex < descriptor.endIndex) {
        next.delete(foldedId);
      }
    }
    if (setsEqual(next, this.foldedBlockIds)) return null;
    const expandedIds = [...this.foldedBlockIds].filter((foldedId) => !next.has(foldedId));
    const patch = this.setFoldedBlockIds([...next]);
    this.startExpandMotion(expandedIds);
    this.onFoldChange?.(this.currentFoldedBlockIds(), patch);
    return patch;
  }

  mountedBlockIds(): readonly string[] {
    return this.renderedBlockIds;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewport?.dispose();
    this.cancelFoldMotion();
    this.renderer.destroy();
    this.sourceGutter?.removeEventListener("click", this.handleGutterClick);
    this.snapshot = null;
    this.heightIndex = null;
    this.baseHeights = new Float64Array(0);
    this.viewport = null;
    this.scrollAnchor = null;
    this.blockIndexById.clear();
    this.sourceGutterBlocks.clear();
    this.foldSummaries.clear();
    this.foldDescriptors.clear();
    this.foldedBlockIds.clear();
    this.hiddenBlockIndices.clear();
    this.visibleBlockIndices = Object.freeze([]);
    this.renderedBlockIds = Object.freeze([]);
    this.lastViewportInput = null;
    this.host.replaceChildren();
    delete this.host.dataset.markdownDocumentViewRuntime;
    delete this.host.dataset.markdownMountedBlockCount;
    delete this.host.dataset.markdownRevision;
    delete this.host.dataset.markdownPreviewSourceGutterHost;
  }

  private protectedIndices(): ReadonlySet<number> {
    const protectedIndices = new Set<number>();
    if (!this.protectFocusAndSelection) return protectedIndices;
    const activeElement = this.host.ownerDocument.activeElement;
    this.addNodeBlockIndex(activeElement, protectedIndices);
    const selection = this.host.ownerDocument.getSelection?.();
    if (selection?.rangeCount) {
      this.addNodeBlockIndex(selection.anchorNode, protectedIndices);
      this.addNodeBlockIndex(selection.focusNode, protectedIndices);
      const range = selection.getRangeAt(0);
      for (const index of this.viewport?.mountedIndices() ?? []) {
        const block = this.snapshot?.blocks[index];
        const element = block ? this.renderer.getBlockElement(block.id) : null;
        if (!element) continue;
        try {
          if (range.intersectsNode(element)) protectedIndices.add(index);
        } catch {
          // Detached selection nodes are ignored.
        }
      }
    }
    return protectedIndices;
  }

  private updateSourceGutter(
    snapshot: MarkdownSnapshot,
    items: readonly MarkdownViewportItem[],
    input: MarkdownViewportInput,
    totalHeight: number,
  ): void {
    const gutter = this.sourceGutter;
    if (!gutter) return;
    const width = sourceGutterWidth(snapshot.line_count);
    gutter.style.width = `${width}px`;
    gutter.style.height = `${totalHeight}px`;
    gutter.dataset.markdownPreviewLineCount = String(snapshot.line_count);
    this.host.style.setProperty("--markdown-preview-source-gutter-width", `${width}px`);
    const retainedIds = new Set<string>();
    for (const item of items) {
      const block = snapshot.blocks[item.index];
      if (!block || this.hiddenBlockIndices.has(block.index)) continue;
      retainedIds.add(block.id);
      let blockGutter = this.sourceGutterBlocks.get(block.id);
      if (!blockGutter) {
        blockGutter = gutter.ownerDocument.createElement("div");
        blockGutter.dataset.markdownPreviewGutterBlockId = block.id;
        const control = gutter.ownerDocument.createElement("span");
        control.dataset.markdownPreviewFoldPlaceholder = "true";
        const numbers = gutter.ownerDocument.createElement("div");
        numbers.dataset.markdownPreviewLineNumber = "true";
        numbers.setAttribute("aria-hidden", "true");
        blockGutter.append(control, numbers);
        gutter.append(blockGutter);
        this.sourceGutterBlocks.set(block.id, blockGutter);
      }
      const descriptor = this.foldDescriptors.get(block.id) ?? null;
      const collapsed = this.foldedBlockIds.has(block.id);
      this.updateFoldControl(blockGutter, block, descriptor, collapsed);
      blockGutter.style.top = `${item.top}px`;
      blockGutter.style.height = `${item.height}px`;
      blockGutter.dataset.foldKind = descriptor?.kind ?? "";
      blockGutter.dataset.collapsed = collapsed ? "true" : "false";
      const fullLineCount = blockLineSpan(block);
      const displayedLineCount = collapsed ? 1 : fullLineCount;
      const lineHeight = collapsed ? 18 : Math.max(18, this.baseHeights[block.index]! / displayedLineCount);
      const visible = visibleGutterLineWindow(block.line_start, displayedLineCount, lineHeight, item, input);
      const numbers = blockGutter.children[1] as HTMLDivElement;
      numbers.style.top = `${visible.localStart * lineHeight}px`;
      numbers.style.setProperty("--markdown-preview-gutter-line-height", `${lineHeight}px`);
      numbers.dataset.markdownPreviewSourceLineStart = String(visible.sourceStart + 1);
      numbers.dataset.markdownPreviewSourceLineEnd = String(visible.sourceEnd);
      const text = lineNumberText(visible.sourceStart + 1, visible.sourceEnd);
      if (numbers.textContent !== text) numbers.textContent = text;
    }
    for (const [blockId, element] of this.sourceGutterBlocks) {
      if (retainedIds.has(blockId)) continue;
      element.remove();
      this.sourceGutterBlocks.delete(blockId);
    }
  }

  private updateFoldControl(
    blockGutter: HTMLDivElement,
    block: MarkdownSnapshotBlock,
    descriptor: MarkdownFoldDescriptor | null,
    collapsed: boolean,
  ): void {
    const current = blockGutter.firstElementChild as HTMLElement | null;
    if (!descriptor) {
      if (current?.dataset.markdownPreviewFoldPlaceholder !== "true") {
        const placeholder = blockGutter.ownerDocument.createElement("span");
        placeholder.dataset.markdownPreviewFoldPlaceholder = "true";
        current?.replaceWith(placeholder);
      }
      return;
    }
    let button = current?.dataset.markdownPreviewFoldButton === "true"
      ? current as HTMLButtonElement
      : null;
    if (!button) {
      button = blockGutter.ownerDocument.createElement("button");
      button.type = "button";
      button.dataset.markdownPreviewFoldButton = "true";
      current?.replaceWith(button);
    }
    const target = descriptor.kind === "section" ? "章节" : "内容";
    const action = collapsed ? "展开" : "折叠";
    const startLine = block.line_start + 1;
    const endLine = descriptor.kind === "section"
      ? this.snapshot?.blocks[descriptor.endIndex - 1]?.line_end ?? block.line_end
      : block.line_end;
    button.dataset.markdownPreviewFoldBlockId = block.id;
    button.dataset.markdownPreviewFoldKind = descriptor.kind;
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.setAttribute("aria-label", `${action}第 ${startLine} 行${target}`);
    button.title = `${action}第 ${startLine} 行${target}（${startLine}-${Math.max(startLine, endLine)} 行）`;
  }

  private updateFoldSummaries(
    snapshot: MarkdownSnapshot,
    items: readonly MarkdownViewportItem[],
    totalHeight: number,
  ): void {
    const overlay = this.foldOverlay;
    if (!overlay) return;
    overlay.style.height = `${totalHeight}px`;
    const retainedIds = new Set<string>();
    for (const item of items) {
      const block = snapshot.blocks[item.index];
      const descriptor = block ? this.foldDescriptors.get(block.id) : null;
      if (!block || !descriptor || !this.foldedBlockIds.has(block.id)) continue;
      retainedIds.add(block.id);
      let summary = this.foldSummaries.get(block.id);
      if (!summary) {
        summary = overlay.ownerDocument.createElement("div");
        summary.dataset.markdownPreviewCollapsedSummary = "true";
        overlay.append(summary);
        this.foldSummaries.set(block.id, summary);
      }
      summary.dataset.markdownPreviewCollapsedBlock = descriptor.kind === "block" ? "true" : "false";
      summary.dataset.markdownPreviewCollapsedSection = descriptor.kind === "section" ? "true" : "false";
      summary.style.insetInlineStart = `${sourceGutterWidth(snapshot.line_count) + 8}px`;
      summary.style.insetInlineEnd = "0";
      summary.style.top = `${item.top + (descriptor.kind === "section" ? this.baseHeights[item.index]! : 0)}px`;
      summary.textContent = `已折叠 ${descriptor.lineCount} 行`;
    }
    for (const [blockId, element] of this.foldSummaries) {
      if (retainedIds.has(blockId)) continue;
      element.remove();
      this.foldSummaries.delete(blockId);
    }
  }

  private readonly handleGutterClick = (event: MouseEvent): void => {
    const target = event.target instanceof this.host.ownerDocument.defaultView!.Element
      ? event.target.closest<HTMLButtonElement>("[data-markdown-preview-fold-button='true']")
      : null;
    if (!target || !this.sourceGutter?.contains(target)) return;
    const blockId = target.dataset.markdownPreviewFoldBlockId;
    if (!blockId || !this.foldDescriptors.has(blockId)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.pendingCollapseBlockId === blockId) {
      this.cancelFoldMotion();
      return;
    }
    if (this.foldedBlockIds.has(blockId)) {
      const next = new Set(this.foldedBlockIds);
      next.delete(blockId);
      const patch = this.setFoldedBlockIds([...next]);
      this.startExpandMotion([blockId]);
      this.onFoldChange?.(this.currentFoldedBlockIds(), patch);
      return;
    }
    this.startCollapseMotion(blockId);
  };

  private startCollapseMotion(blockId: string): void {
    this.cancelFoldMotion();
    this.pendingCollapseBlockId = blockId;
    this.markFoldMotion([blockId], "collapse");
    const button = [...(this.sourceGutter?.querySelectorAll<HTMLButtonElement>(
      "[data-markdown-preview-fold-button='true']",
    ) ?? [])].find((candidate) => candidate.dataset.markdownPreviewFoldBlockId === blockId);
    if (button) button.dataset.markdownPreviewFoldPending = "true";
    const view = this.host.ownerDocument.defaultView;
    if (!view || view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.finishPendingCollapse();
      return;
    }
    this.foldMotionTimer = view.setTimeout(() => this.finishPendingCollapse(), FOLD_COLLAPSE_MOTION_MS);
  }

  private finishPendingCollapse(): void {
    const blockId = this.pendingCollapseBlockId;
    if (!blockId) return;
    this.clearFoldMotionAttributes();
    this.pendingCollapseBlockId = null;
    this.foldMotionTimer = null;
    const next = new Set(this.foldedBlockIds);
    next.add(blockId);
    const patch = this.setFoldedBlockIds([...next]);
    this.onFoldChange?.(this.currentFoldedBlockIds(), patch);
  }

  private startExpandMotion(blockIds: readonly string[]): void {
    if (!blockIds.length) return;
    this.markFoldMotion(blockIds, "expand");
    const view = this.host.ownerDocument.defaultView;
    if (!view || view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.clearFoldMotionAttributes();
      return;
    }
    this.foldMotionTimer = view.setTimeout(() => {
      this.foldMotionTimer = null;
      this.clearFoldMotionAttributes();
    }, FOLD_EXPAND_MOTION_MS);
  }

  private markFoldMotion(blockIds: readonly string[], phase: "collapse" | "expand"): void {
    for (const blockId of blockIds) {
      const descriptor = this.foldDescriptors.get(blockId);
      if (!descriptor) continue;
      for (let index = descriptor.index; index < descriptor.endIndex; index += 1) {
        // Never promote an enormous virtual block to an animated compositor
        // layer. Its fold chevron and bounded summary still animate, while
        // ordinary mounted blocks retain the full content transition.
        if ((this.baseHeights[index] ?? 0) > MAX_FOLD_ANIMATED_BLOCK_HEIGHT) continue;
        const child = this.snapshot?.blocks[index];
        const element = child ? this.renderer.getBlockElement(child.id) : null;
        if (element) element.dataset.markdownPreviewFoldMotion = phase;
        const gutter = child ? this.sourceGutterBlocks.get(child.id) : null;
        if (gutter) gutter.dataset.markdownPreviewFoldMotion = phase;
      }
    }
  }

  private cancelFoldMotion(): void {
    const view = this.host.ownerDocument.defaultView;
    if (this.foldMotionTimer !== null && view) view.clearTimeout(this.foldMotionTimer);
    this.foldMotionTimer = null;
    this.pendingCollapseBlockId = null;
    this.clearFoldMotionAttributes();
  }

  private clearFoldMotionAttributes(): void {
    this.canvas.querySelectorAll<HTMLElement>("[data-markdown-preview-fold-motion]").forEach((element) => {
      delete element.dataset.markdownPreviewFoldMotion;
    });
    this.sourceGutter?.querySelectorAll<HTMLElement>("[data-markdown-preview-fold-motion]").forEach((element) => {
      delete element.dataset.markdownPreviewFoldMotion;
    });
    this.sourceGutter?.querySelectorAll<HTMLElement>("[data-markdown-preview-fold-pending]").forEach((element) => {
      delete element.dataset.markdownPreviewFoldPending;
    });
  }

  private applyFoldProjection(): DocumentViewPatchResult | null {
    const heightIndex = this.heightIndex;
    const snapshot = this.snapshot;
    if (!heightIndex || !snapshot) return null;
    this.rebuildFoldProjection();
    const updates: MarkdownHeightUpdate[] = [];
    for (let index = 0; index < snapshot.blocks.length; index += 1) {
      const height = this.effectiveHeightAt(index);
      if (height !== heightIndex.heightAt(index)) updates.push({ index, height });
    }
    if (!updates.length) {
      return this.lastViewportInput
        ? this.updateViewport(this.lastViewportInput, { origin: "automatic" })
        : null;
    }
    const input = this.lastViewportInput ?? { scrollTop: 0, viewportHeight: 0, revision: snapshot.revision };
    const anchor = this.scrollAnchor?.capture({
      scrollTop: input.scrollTop,
      viewportHeight: input.viewportHeight,
    });
    if (!anchor || !this.scrollAnchor) {
      heightIndex.updateBatch(updates, { revision: snapshot.revision });
      return this.updateViewport(input, { origin: "automatic" });
    }
    const correction = this.scrollAnchor.applyHeightUpdates(anchor, updates, {
      revision: snapshot.revision,
      currentScrollTop: input.scrollTop,
      viewportHeight: input.viewportHeight,
    });
    return this.updateViewport({ ...input, scrollTop: correction.scrollTop }, { origin: "automatic" });
  }

  private rebuildFoldProjection(): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.hiddenBlockIndices.clear();
      this.visibleBlockIndices = Object.freeze([]);
      return;
    }
    if (this.foldedBlockIds.size === 0) {
      this.hiddenBlockIndices.clear();
      this.visibleBlockIndices = Object.freeze([]);
      return;
    }
    const hidden = new Set<number>();
    let hiddenUntil = -1;
    for (const block of snapshot.blocks) {
      if (block.index < hiddenUntil) {
        hidden.add(block.index);
        continue;
      }
      const descriptor = this.foldDescriptors.get(block.id);
      if (descriptor?.kind === "section" && this.foldedBlockIds.has(block.id)) {
        hiddenUntil = descriptor.endIndex;
      }
    }
    this.hiddenBlockIndices = hidden;
    this.visibleBlockIndices = Object.freeze(
      snapshot.blocks.flatMap((block) => hidden.has(block.index) ? [] : [block.index]),
    );
  }

  private effectiveHeightAt(index: number): number {
    if (this.hiddenBlockIndices.has(index)) return 0;
    const block = this.snapshot?.blocks[index];
    const descriptor = block ? this.foldDescriptors.get(block.id) : null;
    if (!block || !descriptor || !this.foldedBlockIds.has(block.id)) return this.baseHeights[index] ?? 0;
    return descriptor.kind === "section"
      ? (this.baseHeights[index] ?? 0) + COLLAPSED_SECTION_SUMMARY_HEIGHT
      : COLLAPSED_BLOCK_HEIGHT;
  }

  private isCollapsedBlock(index: number): boolean {
    const block = this.snapshot?.blocks[index];
    const descriptor = block ? this.foldDescriptors.get(block.id) : null;
    return descriptor?.kind === "block" && this.foldedBlockIds.has(block!.id);
  }

  private addNodeBlockIndex(node: Node | null, target: Set<number>): void {
    const element = node instanceof this.host.ownerDocument.defaultView!.Element
      ? node
      : node?.parentElement;
    if (!element || !this.canvas.contains(element)) return;
    const blockId = element.closest<HTMLElement>("[data-markdown-block-id]")?.dataset.markdownBlockId;
    const index = blockId ? this.blockIndexById.get(blockId) : undefined;
    if (index !== undefined) target.add(index);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Document View Runtime is destroyed");
  }
}

const MAX_EAGER_GUTTER_LINES = 256;
const GUTTER_LINE_OVERSCAN = 24;
const COLLAPSED_BLOCK_HEIGHT = 38;
const COLLAPSED_SECTION_SUMMARY_HEIGHT = 42;
const FOLD_COLLAPSE_MOTION_MS = 180;
const FOLD_EXPAND_MOTION_MS = 160;
const MAX_FOLD_ANIMATED_BLOCK_HEIGHT = 1_600;

type MarkdownFoldKind = "block" | "section";

interface MarkdownFoldDescriptor {
  readonly index: number;
  readonly kind: MarkdownFoldKind;
  readonly endIndex: number;
  readonly lineCount: number;
}

function sourceGutterWidth(lineCount: number): number {
  const normalized = Number.isFinite(lineCount) ? Math.max(1, Math.floor(lineCount)) : 1;
  return Math.max(50, 26 + String(normalized).length * 7);
}

function visibleGutterLineWindow(
  sourceStart: number,
  lineCount: number,
  lineHeight: number,
  item: MarkdownViewportItem,
  input: MarkdownViewportInput,
): { readonly localStart: number; readonly sourceStart: number; readonly sourceEnd: number } {
  if (lineCount <= MAX_EAGER_GUTTER_LINES) {
    return { localStart: 0, sourceStart, sourceEnd: sourceStart + lineCount };
  }
  const viewportStart = Math.max(0, input.scrollTop - item.top);
  const viewportEnd = Math.min(item.height, input.scrollTop + input.viewportHeight - item.top);
  const localStart = Math.max(0, Math.floor(viewportStart / lineHeight) - GUTTER_LINE_OVERSCAN);
  const localEnd = Math.min(
    lineCount,
    Math.max(localStart + 1, Math.ceil(Math.max(viewportStart, viewportEnd) / lineHeight) + GUTTER_LINE_OVERSCAN),
  );
  return {
    localStart,
    sourceStart: sourceStart + localStart,
    sourceEnd: sourceStart + localEnd,
  };
}

function lineNumberText(startInclusive: number, endInclusive: number): string {
  let text = "";
  for (let line = startInclusive; line <= endInclusive; line += 1) {
    if (text) text += "\n";
    text += String(line);
  }
  return text;
}

function buildFoldDescriptors(
  blocks: readonly MarkdownSnapshotBlock[],
): Map<string, MarkdownFoldDescriptor> {
  const sectionEnds = new Map<number, number>();
  const openHeadings: Array<{ readonly index: number; readonly level: number }> = [];
  for (const block of blocks) {
    if (block.kind !== "heading" || !block.metadata.heading_level) continue;
    while (openHeadings.length > 0 && openHeadings.at(-1)!.level >= block.metadata.heading_level) {
      const heading = openHeadings.pop()!;
      sectionEnds.set(heading.index, block.index);
    }
    openHeadings.push({ index: block.index, level: block.metadata.heading_level });
  }
  while (openHeadings.length > 0) sectionEnds.set(openHeadings.pop()!.index, blocks.length);

  const descriptors = new Map<string, MarkdownFoldDescriptor>();
  for (const block of blocks) {
    if (block.kind === "heading") {
      const endIndex = sectionEnds.get(block.index) ?? block.index + 1;
      if (endIndex <= block.index + 1) continue;
      const last = blocks[endIndex - 1]!;
      descriptors.set(block.id, Object.freeze({
        index: block.index,
        kind: "section",
        endIndex,
        lineCount: Math.max(1, last.line_end - block.line_end),
      }));
      continue;
    }
    if (blocks.length > 1 && blockLineSpan(block) > 1) {
      descriptors.set(block.id, Object.freeze({
        index: block.index,
        kind: "block",
        endIndex: block.index + 1,
        lineCount: blockLineSpan(block),
      }));
    }
  }
  return descriptors;
}

function blockLineSpan(block: MarkdownSnapshotBlock): number {
  return Math.max(1, block.line_end - block.line_start);
}

function normalizedHeight(height: number): number {
  if (!Number.isFinite(height) || height < 0) throw new Error("Height must be finite and non-negative");
  return height;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
