import type { MarkdownSnapshot, MarkdownSnapshotBlock } from "../document/MarkdownSnapshot";
import {
  estimateMarkdownSnapshotHeights,
  measuredMarkdownBlockOccupiedHeight,
} from "../layout/heightEstimate";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  type MarkdownDocumentRenderStats,
  type MarkdownRendererInteractionHandlers,
  type MarkdownRendererResourceLifecycle,
  type SemanticMarkdownRendererRegistry,
} from "../renderers";
import { DocumentViewRuntime } from "../view/DocumentViewRuntime";

export interface StreamingTailViewOptions {
  readonly registry?: SemanticMarkdownRendererRegistry;
  readonly interactions?: MarkdownRendererInteractionHandlers;
  readonly resourceLifecycle?: MarkdownRendererResourceLifecycle;
  readonly cursorClassName?: string;
  readonly cursorDotClassName?: string;
}

export interface StreamingTailViewPublishOptions {
  readonly displayCursor?: number;
  readonly showCursor?: boolean;
  readonly activeFenceBlockId?: string | null;
}

export interface StreamingTailViewPatch {
  readonly revision: string;
  readonly render: MarkdownDocumentRenderStats;
  readonly preservedBlockIds: readonly string[];
  readonly patchedBlockIds: readonly string[];
  readonly cursorBlockId: string | null;
  readonly renderCount: number;
}

export function setStreamingCursorVisible(cursor: HTMLSpanElement, visible: boolean): void {
  cursor.hidden = !visible;
  if (visible) {
    cursor.style.removeProperty("display");
    cursor.dataset.testid = "streaming-cursor";
  } else {
    // Author CSS sets the cursor to inline-flex and therefore overrides the
    // browser's low-specificity [hidden] rule. Keep hidden cursors out of
    // layout explicitly for user and completed messages.
    cursor.style.display = "none";
    delete cursor.dataset.testid;
  }
}

export function createStreamingCursorElement(
  ownerDocument: Document,
  options: Pick<StreamingTailViewOptions, "cursorClassName" | "cursorDotClassName"> = {},
): HTMLSpanElement {
  const cursor = ownerDocument.createElement("span");
  cursor.dataset.streamingCursor = "true";
  cursor.dataset.streamingMarkdownCursor = "true";
  cursor.setAttribute("aria-hidden", "true");
  if (options.cursorClassName) cursor.className = options.cursorClassName;
  for (let index = 0; index < 3; index += 1) {
    const dot = ownerDocument.createElement("span");
    dot.dataset.streamingCursorDot = "true";
    if (options.cursorDotClassName) dot.className = options.cursorDotClassName;
    cursor.append(dot);
  }
  setStreamingCursorVisible(cursor, false);
  return cursor;
}

export class StreamingTailView {
  readonly cursor: HTMLSpanElement;
  private readonly renderer: DocumentViewRuntime;
  private readonly scrollElement: HTMLElement | null;
  private readonly measuredHeights = new Map<string, {
    readonly height: number;
    readonly contentHash: string;
    readonly logicalEnd: number;
  }>();
  private snapshot: MarkdownSnapshot | null = null;
  private renderCount = 0;
  private measureFrame: number | null = null;
  private measureTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly observedBlocks = new Set<HTMLElement>();
  private disposed = false;

  constructor(readonly root: HTMLElement, options: StreamingTailViewOptions = {}) {
    this.renderer = new DocumentViewRuntime(root, {
      profile: CONVERSATION_MARKDOWN_RENDERER_PROFILE,
      registry: options.registry,
      interactions: options.interactions,
      resourceLifecycle: options.resourceLifecycle,
      viewport: { defaultOverscanPx: 1400, maxPinnedBlocks: 128 },
    });
    this.scrollElement = root.closest<HTMLElement>('[data-message-list-scroll="true"]');
    this.scrollElement?.addEventListener("scroll", this.handleScroll, { passive: true });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (this.snapshot) this.scheduleMeasurement(this.snapshot.revision);
        });
    this.cursor = createStreamingCursorElement(root.ownerDocument, options);
    root.append(this.cursor);
    root.dataset.streamingMarkdownTailView = "true";
  }

  publish(snapshot: MarkdownSnapshot, options: StreamingTailViewPublishOptions = {}): StreamingTailViewPatch {
    this.assertActive();
    if (snapshot.surface !== "message" || snapshot.renderer_profile !== "conversation") {
      throw new Error("StreamingTailView requires a message/conversation Snapshot");
    }
    if (import.meta.env.DEV
      && this.root.ownerDocument.documentElement.dataset.zmdrDisableStreamingTailView === "true") {
      this.snapshot = snapshot;
      this.renderCount += 1;
      return Object.freeze({
        revision: snapshot.revision,
        render: Object.freeze({
          revision: snapshot.revision,
          blockCount: snapshot.blocks.length,
          created: 0,
          reused: 0,
          updated: 0,
          destroyed: 0,
          failed: 0,
          preserved: 0,
        }),
        preservedBlockIds: Object.freeze([]),
        patchedBlockIds: Object.freeze([]),
        cursorBlockId: null,
        renderCount: this.renderCount,
      });
    }
    const previousSnapshot = this.snapshot;
    const preservedBlockIds = reusableStablePrefixIds(previousSnapshot, snapshot);
    const preserve = new Set(preservedBlockIds);
    const heights = estimateMarkdownSnapshotHeights(snapshot, {
      viewportWidth: Math.max(320, this.root.clientWidth || this.scrollElement?.clientWidth || 800),
    });
    snapshot.blocks.forEach((block, index) => {
      const measured = this.measuredHeights.get(block.id);
      if (measured?.contentHash === block.content_hash && measured.logicalEnd === block.logical_end) {
        heights[index] = measured.height;
      } else if (measured) {
        this.measuredHeights.delete(block.id);
      }
    });
    const patch = this.renderer.publish(snapshot, heights, this.viewportInput());
    this.syncMeasurementObservers();
    const patchIndices = patch.viewport.items
      .map((item) => item.index)
      .filter((index) => !preserve.has(snapshot.blocks[index].id));
    const preservedMounted = preservedBlockIds.filter((blockId) => this.renderer.getBlockElement(blockId) !== null).length;
    const render: MarkdownDocumentRenderStats = Object.freeze({
      ...patch.render,
      preserved: preservedMounted,
      reused: Math.max(0, patch.render.reused - preservedMounted),
    });
    this.snapshot = snapshot;
    this.renderCount += 1;
    const cursorBlockId = this.updateCursor(options);
    if (isAppendOnlyPlainTail(previousSnapshot, snapshot)) this.scheduleIdleMeasurement(snapshot.revision);
    else this.scheduleMeasurement(snapshot.revision);
    this.root.dataset.streamingMarkdownRevision = snapshot.revision;
    this.root.dataset.streamingMarkdownRenderCount = String(this.renderCount);
    this.root.dataset.streamingMarkdownPreservedBlocks = String(preservedBlockIds.length);
    this.root.dataset.streamingMarkdownPatchedBlocks = String(patchIndices.length);
    return Object.freeze({
      revision: snapshot.revision,
      render,
      preservedBlockIds: Object.freeze(preservedBlockIds),
      patchedBlockIds: Object.freeze(patchIndices.map((index) => snapshot.blocks[index].id)),
      cursorBlockId,
      renderCount: this.renderCount,
    });
  }

  updateDisplay(options: StreamingTailViewPublishOptions = {}): string | null {
    this.assertActive();
    return this.updateCursor(options);
  }

  currentSnapshot(): MarkdownSnapshot | null {
    return this.snapshot;
  }

  getBlockElement(blockId: string): HTMLElement | null {
    return this.renderer.getBlockElement(blockId);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scrollElement?.removeEventListener("scroll", this.handleScroll);
    if (this.measureFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
    if (this.measureTimer !== null) {
      clearTimeout(this.measureTimer);
      this.measureTimer = null;
    }
    this.renderer.destroy();
    this.resizeObserver?.disconnect();
    this.observedBlocks.clear();
    delete this.root.dataset.streamingMarkdownTailView;
    delete this.root.dataset.streamingMarkdownRevision;
    delete this.root.dataset.streamingMarkdownRenderCount;
  }

  private updateCursor(options: StreamingTailViewPublishOptions): string | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    const displayCursor = Math.max(0, Math.min(snapshot.source_characters, options.displayCursor ?? snapshot.source_characters));
    const block = blockAtOrBefore(snapshot.blocks, displayCursor);
    const element = block ? this.renderer.getBlockElement(block.id) : null;
    if (element) element.after(this.cursor);
    else this.root.append(this.cursor);
    const activeFenceBlockId = options.activeFenceBlockId === undefined
      ? inferredActiveFence(snapshot)
      : options.activeFenceBlockId;
    setStreamingCursorVisible(this.cursor, options.showCursor !== false);
    this.cursor.dataset.streamingMarkdownDisplayCursor = String(displayCursor);
    if (block) this.cursor.dataset.streamingMarkdownCursorBlockId = block.id;
    else delete this.cursor.dataset.streamingMarkdownCursorBlockId;
    if (activeFenceBlockId) this.cursor.dataset.streamingMarkdownActiveFenceBlockId = activeFenceBlockId;
    else delete this.cursor.dataset.streamingMarkdownActiveFenceBlockId;
    return block?.id ?? null;
  }

  private viewportInput(): { scrollTop: number; viewportHeight: number } {
    const scroller = this.scrollElement;
    if (!scroller) {
      const total = this.renderer.getHeightIndex()?.totalHeight;
      return { scrollTop: 0, viewportHeight: Math.max(1, total ?? 1_000_000_000) };
    }
    const rootRect = this.root.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      scrollTop: Math.max(0, scrollerRect.top - rootRect.top),
      viewportHeight: Math.max(1, scroller.clientHeight || scrollerRect.height || 1),
    };
  }

  private readonly handleScroll = () => {
    if (this.disposed || !this.snapshot) return;
    this.renderer.updateViewport({
      ...this.viewportInput(),
      revision: this.snapshot.revision,
    }, { origin: "user" });
    this.syncMeasurementObservers();
    this.updateCursor({
      displayCursor: Number(this.cursor.dataset.streamingMarkdownDisplayCursor ?? this.snapshot.source_characters),
      showCursor: !this.cursor.hidden,
    });
    this.scheduleMeasurement(this.snapshot.revision);
  };

  private scheduleMeasurement(revision: string): void {
    if (this.measureTimer !== null) {
      clearTimeout(this.measureTimer);
      this.measureTimer = null;
    }
    if (typeof requestAnimationFrame !== "function") return;
    if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = null;
      if (this.disposed || this.snapshot?.revision !== revision) return;
      const updates = this.renderer.mountedBlockIds().flatMap((blockId) => {
        const block = this.snapshot?.blocks.find((candidate) => candidate.id === blockId);
        const element = this.renderer.getBlockElement(blockId);
        const borderBoxHeight = element?.getBoundingClientRect().height ?? 0;
        const height = block && borderBoxHeight > 0
          ? measuredMarkdownBlockOccupiedHeight(
              borderBoxHeight,
              block.index,
              this.snapshot?.blocks.length ?? 0,
            )
          : 0;
        const measured = this.measuredHeights.get(blockId);
        if (!block
          || !Number.isFinite(height)
          || height <= 0
          || measured?.height === height
            && measured.contentHash === block.content_hash
            && measured.logicalEnd === block.logical_end) return [];
        this.measuredHeights.set(blockId, {
          height,
          contentHash: block.content_hash,
          logicalEnd: block.logical_end,
        });
        return [{ index: block.index, height, kind: "measured" as const }];
      });
      if (updates.length) {
        this.renderer.updateMeasuredHeights(updates, revision);
        this.syncMeasurementObservers();
      }
    });
  }

  private syncMeasurementObservers(): void {
    if (!this.resizeObserver) return;
    const next = new Set<HTMLElement>();
    for (const blockId of this.renderer.mountedBlockIds()) {
      const element = this.renderer.getBlockElement(blockId);
      if (!element) continue;
      next.add(element);
      if (!this.observedBlocks.has(element)) this.resizeObserver.observe(element);
    }
    for (const element of this.observedBlocks) {
      if (!next.has(element)) this.resizeObserver.unobserve(element);
    }
    this.observedBlocks.clear();
    next.forEach((element) => this.observedBlocks.add(element));
  }

  private scheduleIdleMeasurement(revision: string): void {
    if (this.measureFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
    if (this.measureTimer !== null) clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => {
      this.measureTimer = null;
      if (this.disposed || this.snapshot?.revision !== revision) return;
      this.scheduleMeasurement(revision);
    }, 250);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("StreamingTailView is destroyed");
  }
}

function reusableStablePrefixIds(
  previous: MarkdownSnapshot | null,
  next: MarkdownSnapshot,
): string[] {
  if (!previous) return [];
  const previousStable = stableBlocks(previous);
  const nextStableIds = new Set(stableBlocks(next).map((block) => block.id));
  return previousStable
    .filter((block) => nextStableIds.has(block.id))
    .filter((block) => {
      const candidate = next.blocks.find((nextBlock) => nextBlock.id === block.id);
      return candidate
        && candidate.content_hash === block.content_hash
        && candidate.source_start === block.source_start
        && candidate.source_end === block.source_end
        && candidate.logical_start === block.logical_start
        && candidate.logical_end === block.logical_end;
    })
    .map((block) => block.id);
}

function stableBlocks(snapshot: MarkdownSnapshot): readonly MarkdownSnapshotBlock[] {
  return snapshot.stream.kind === "streaming"
    ? snapshot.blocks.slice(0, snapshot.stream.prefix_block_count)
    : snapshot.blocks;
}

function blockAtOrBefore(blocks: readonly MarkdownSnapshotBlock[], sourceOffset: number): MarkdownSnapshotBlock | null {
  let low = 0;
  let high = blocks.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle].source_start <= sourceOffset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate >= 0 ? blocks[candidate] : null;
}

function inferredActiveFence(snapshot: MarkdownSnapshot): string | null {
  if (snapshot.stream.kind !== "streaming") return null;
  const tail = snapshot.blocks[snapshot.stream.tail_block_start];
  return tail && (tail.kind === "code" || tail.kind === "mermaid" || tail.kind === "math")
    ? tail.id
    : null;
}

function isAppendOnlyPlainTail(previous: MarkdownSnapshot | null, next: MarkdownSnapshot): boolean {
  if (!previous || previous.stream.kind !== "streaming" || next.stream.kind !== "streaming") return false;
  const previousTail = previous.blocks.at(-1);
  const nextTail = next.blocks.at(-1);
  return Boolean(previousTail
    && nextTail
    && previousTail.id === nextTail.id
    && previousTail.kind === "paragraph"
    && nextTail.kind === "paragraph"
    && previousTail.logical_start === nextTail.logical_start
    && nextTail.logical_end > previousTail.logical_end
    && previousTail.inline_spans.every((span) => span.kind === "text")
    && nextTail.inline_spans.every((span) => span.kind === "text"));
}
