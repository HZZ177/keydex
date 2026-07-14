import {
  assertValidMarkdownSnapshotOnce,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
} from "../document/MarkdownSnapshot";
import { defaultSemanticMarkdownRenderers } from "./defaultRenderers";
import { SemanticMarkdownRendererRegistry } from "./SemanticMarkdownRendererRegistry";
import type {
  MarkdownBlockDomInstance,
  MarkdownBlockRendererContext,
  MarkdownBlockRendererDefinition,
  MarkdownBlockSourceMap,
  MarkdownRendererInteractionHandlers,
  MarkdownRendererProfile,
  MarkdownRendererResourceLifecycle,
} from "./types";

export interface RetainedMarkdownDocumentRendererOptions {
  readonly registry?: SemanticMarkdownRendererRegistry;
  readonly profile: MarkdownRendererProfile;
  readonly interactions?: MarkdownRendererInteractionHandlers;
  readonly resourceLifecycle?: MarkdownRendererResourceLifecycle;
}

export interface MarkdownDocumentRenderStats {
  readonly revision: string;
  readonly blockCount: number;
  readonly created: number;
  readonly reused: number;
  readonly updated: number;
  readonly destroyed: number;
  readonly failed: number;
  readonly preserved: number;
}

export interface MarkdownDocumentRenderOptions {
  readonly blockIndices?: readonly number[];
  readonly preserveBlockIds?: ReadonlySet<string>;
}

interface RetainedBlock {
  readonly definition: MarkdownBlockRendererDefinition;
  readonly instance: MarkdownBlockDomInstance;
  readonly failed: boolean;
  readonly block: MarkdownSnapshotBlock;
}

export class RetainedMarkdownDocumentRenderer {
  private readonly registry: SemanticMarkdownRendererRegistry;
  private readonly profile: MarkdownRendererProfile;
  private readonly interactions: MarkdownRendererInteractionHandlers;
  private readonly resourceLifecycle?: MarkdownRendererResourceLifecycle;
  private blocks = new Map<string, RetainedBlock>();
  private resourcesByBlock = new Map<string, MarkdownSnapshot["resources"][number][]>();
  private snapshot: MarkdownSnapshot | null = null;
  private disposed = false;

  constructor(
    readonly root: HTMLElement,
    options: RetainedMarkdownDocumentRendererOptions,
  ) {
    this.registry = options.registry ?? new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers);
    this.profile = options.profile;
    this.interactions = options.interactions ?? {};
    this.resourceLifecycle = options.resourceLifecycle;
    // A renderer owns its retained root exclusively. Reusing the same host for
    // a new renderer (for example when the conversation preview context
    // changes) must not leave the previous renderer's blocks beside the new
    // Snapshot until deferred nested-root cleanup runs.
    this.root.replaceChildren();
    this.root.classList.add("keydex-markdown");
    this.root.dataset.markdownRetainedDocument = "true";
  }

  render(snapshot: MarkdownSnapshot, options: MarkdownDocumentRenderOptions = {}): MarkdownDocumentRenderStats {
    this.assertActive();
    const sameSnapshot = this.snapshot === snapshot;
    if (!sameSnapshot) this.prepareSnapshot(snapshot);
    const selectedBlocks = options.blockIndices === undefined
      ? snapshot.blocks
      : normalizeSelectedBlocks(snapshot, options.blockIndices);
    const previous = this.blocks;
    const next = new Map<string, RetainedBlock>();
    const preserveBlockIds = options.preserveBlockIds ?? new Set<string>();
    let created = 0;
    let reused = 0;
    let updated = 0;
    let destroyed = 0;
    let failed = 0;
    let preserved = 0;
    for (const blockId of preserveBlockIds) {
      const retained = previous.get(blockId);
      const block = retained && (sameSnapshot
        ? retained.block
        : snapshot.blocks.find((candidate) => candidate.id === blockId));
      if (!block || !retained) throw new Error(`Cannot preserve unmounted Markdown block ${blockId}`);
      next.set(blockId, block === retained.block ? retained : { ...retained, block });
      preserved += 1;
    }

    for (const block of selectedBlocks) {
      if (next.has(block.id)) throw new Error(`Markdown block ${block.id} cannot be selected and preserved`);
      const definition = this.registry.resolve(block.kind);
      const retained = previous.get(block.id);
      if (retained && sameSnapshot && retained.definition === definition && retained.block === block) {
        next.set(block.id, retained);
        reused += 1;
        continue;
      }
      const context = this.context(snapshot, block, this.resourcesByBlock.get(block.id) ?? []);
      if (retained && retained.definition === definition && !retained.failed) {
        try {
          const result = retained.instance.update(context);
          next.set(block.id, { ...retained, block });
          if (result === "reused") reused += 1;
          else updated += 1;
          continue;
        } catch (error) {
          retained.instance.destroy();
          destroyed += 1;
          const fallback = createFallbackInstance(context, error);
          next.set(block.id, { definition, instance: fallback, failed: true, block });
          created += 1;
          failed += 1;
          continue;
        }
      }
      if (retained) {
        retained.instance.destroy();
        destroyed += 1;
      }
      try {
        next.set(block.id, { definition, instance: definition.create(context), failed: false, block });
      } catch (error) {
        next.set(block.id, { definition, instance: createFallbackInstance(context, error), failed: true, block });
        failed += 1;
      }
      created += 1;
    }

    for (const [id, retained] of previous) {
      if (next.has(id)) continue;
      retained.instance.destroy();
      destroyed += 1;
    }
    const renderedBlocks = [...next.values()]
      .map((retained) => retained.block)
      .sort((left, right) => left.index - right.index);
    let cursor = this.root.firstChild;
    for (const block of renderedBlocks) {
      const element = next.get(block.id)?.instance.element;
      if (!element) continue;
      if (element === cursor) cursor = cursor.nextSibling;
      else this.root.insertBefore(element, cursor);
    }

    this.blocks = next;
    this.snapshot = snapshot;
    this.root.dataset.markdownRevision = snapshot.revision;
    this.root.dataset.markdownSurface = snapshot.surface;
    this.root.dataset.markdownRendererProfile = this.profile.id;
    this.root.dataset.markdownBlockCount = String(renderedBlocks.length);
    this.root.dataset.markdownDocumentBlockCount = String(snapshot.blocks.length);
    return Object.freeze({
      revision: snapshot.revision,
      blockCount: renderedBlocks.length,
      created,
      reused,
      updated,
      destroyed,
      failed,
      preserved,
    });
  }

  getBlockElement(blockId: string): HTMLElement | null {
    return this.blocks.get(blockId)?.instance.element ?? null;
  }

  sourceMap(blockId: string): MarkdownBlockSourceMap | null {
    return this.blocks.get(blockId)?.instance.sourceMap() ?? null;
  }

  measure(blockId: string): { readonly width: number; readonly height: number } | null {
    return this.blocks.get(blockId)?.instance.measure() ?? null;
  }

  currentSnapshot(): MarkdownSnapshot | null {
    return this.snapshot;
  }

  destroy(options: { readonly clearRoot?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const retained of this.blocks.values()) retained.instance.destroy();
    this.blocks.clear();
    this.resourcesByBlock.clear();
    this.snapshot = null;
    if (options.clearRoot !== false) this.root.replaceChildren();
    delete this.root.dataset.markdownRevision;
    delete this.root.dataset.markdownBlockCount;
  }

  private context(
    snapshot: MarkdownSnapshot,
    block: MarkdownSnapshotBlock,
    resources: MarkdownBlockRendererContext["resources"],
  ): MarkdownBlockRendererContext {
    return Object.freeze({
      ownerDocument: this.root.ownerDocument,
      snapshot,
      block,
      logicalText: snapshot.logical_text,
      resources,
      profile: this.profile,
      interactions: this.interactions,
      resourceLifecycle: this.resourceLifecycle,
    });
  }

  private prepareSnapshot(snapshot: MarkdownSnapshot): void {
    assertValidMarkdownSnapshotOnce(snapshot);
    if (snapshot.surface !== this.profile.surface || snapshot.renderer_profile !== this.profile.id) {
      throw new Error(`Snapshot ${snapshot.surface}/${snapshot.renderer_profile} does not match ${this.profile.surface}/${this.profile.id}`);
    }
    const resourcesByBlock = new Map<string, MarkdownSnapshot["resources"][number][]>();
    for (const resource of snapshot.resources) {
      const resources = resourcesByBlock.get(resource.block_id) ?? [];
      resources.push(resource);
      resourcesByBlock.set(resource.block_id, resources);
    }
    this.resourcesByBlock = resourcesByBlock;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Retained Markdown renderer is destroyed");
  }
}

function normalizeSelectedBlocks(
  snapshot: MarkdownSnapshot,
  indices: readonly number[],
): readonly MarkdownSnapshotBlock[] {
  const seen = new Set<number>();
  const blocks: MarkdownSnapshotBlock[] = [];
  let previous = -1;
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.blocks.length) {
      throw new RangeError(`Markdown render block index ${index} is out of range`);
    }
    if (seen.has(index)) throw new Error(`Duplicate Markdown render block index ${index}`);
    if (index < previous) throw new Error("Markdown render block indices must be ordered");
    seen.add(index);
    previous = index;
    blocks.push(snapshot.blocks[index]);
  }
  return blocks;
}

function createFallbackInstance(
  initialContext: MarkdownBlockRendererContext,
  initialError: unknown,
): MarkdownBlockDomInstance {
  let context = initialContext;
  let element = fallbackElement(context, initialError);
  return {
    get element() {
      return element;
    },
    update(next) {
      context = next;
      const replacement = fallbackElement(next, initialError);
      element.replaceWith(replacement);
      element = replacement;
      return "updated";
    },
    sourceMap() {
      return Object.freeze({
        blockId: context.block.id,
        sourceStart: context.block.source_start,
        sourceEnd: context.block.source_end,
        logicalStart: context.block.logical_start,
        logicalEnd: context.block.logical_end,
        inline: Object.freeze(context.block.inline_spans.map((span) => Object.freeze({ span, element: null }))),
      });
    },
    measure() {
      const rect = element.getBoundingClientRect();
      return Object.freeze({ width: rect.width, height: rect.height });
    },
    destroy() {
      element.remove();
    },
  };
}

function fallbackElement(context: MarkdownBlockRendererContext, error: unknown): HTMLElement {
  const element = context.ownerDocument.createElement("div");
  element.dataset.markdownBlockId = context.block.id;
  element.dataset.markdownBlockKind = context.block.kind;
  element.dataset.markdownBlockError = "true";
  element.dataset.markdownSourceStart = String(context.block.source_start);
  element.dataset.markdownSourceEnd = String(context.block.source_end);
  element.setAttribute("role", "alert");
  const label = context.ownerDocument.createElement("span");
  label.textContent = "Markdown block render failed";
  const source = context.ownerDocument.createElement("pre");
  source.textContent = context.logicalText.slice(context.block.logical_start, context.block.logical_end).slice(0, 2000);
  element.append(label, source);
  element.title = error instanceof Error ? error.message : String(error);
  return element;
}
