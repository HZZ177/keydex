export type MarkdownMultiViewMode = "preview" | "source" | "split";
export type MarkdownMultiViewSurface = "preview" | "source";

export interface MarkdownSharedViewAnchor {
  readonly sourceOffset: number;
  readonly blockId?: string | null;
  readonly alignment?: "start" | "center" | "end" | "nearest";
}

export interface MarkdownViewSyncIntent extends MarkdownSharedViewAnchor {
  readonly kind: "scroll" | "cursor" | "reveal" | "annotation";
  readonly annotationId?: string;
}

export interface MarkdownViewSyncContext {
  readonly epoch: number;
  readonly revision: string;
  readonly signal: AbortSignal;
}

export interface MarkdownMultiViewAdapter {
  readonly id: string;
  readonly surface: MarkdownMultiViewSurface;
  currentRevision(): string | null;
  captureAnchor(): MarkdownSharedViewAnchor | null;
  apply(intent: MarkdownViewSyncIntent, context: MarkdownViewSyncContext): void | Promise<void>;
}

export interface MarkdownViewLocalEvent {
  readonly intent: MarkdownViewSyncIntent;
  readonly revision: string;
  readonly causeEpoch?: number;
}

export class MarkdownMultiViewCoordinator {
  private readonly adapters = new Map<string, MarkdownMultiViewAdapter>();
  private readonly appliedEpochByView = new Map<string, number>();
  private mode: MarkdownMultiViewMode;
  private revision: string;
  private epoch = 0;
  private active: AbortController | null = null;
  private disposed = false;

  constructor(options: { mode: MarkdownMultiViewMode; revision: string }) {
    this.mode = options.mode;
    this.revision = required(options.revision, "revision");
  }

  register(adapter: MarkdownMultiViewAdapter): () => void {
    this.assertActive();
    const id = required(adapter.id, "view id");
    if (this.adapters.has(id)) throw new Error(`Markdown view ${id} is already registered`);
    this.adapters.set(id, adapter);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.adapters.delete(id);
      this.appliedEpochByView.delete(id);
    };
  }

  async setMode(mode: MarkdownMultiViewMode, preferredOriginId?: string): Promise<number | null> {
    this.assertActive();
    if (mode === this.mode) return null;
    const origin = preferredOriginId ? this.adapters.get(preferredOriginId) : this.primaryAdapter(this.mode);
    const anchor = origin?.captureAnchor() ?? this.primaryAdapter(mode)?.captureAnchor() ?? null;
    this.mode = mode;
    if (!anchor) return null;
    return this.dispatch(origin?.id ?? null, { ...anchor, kind: "scroll" }, mode);
  }

  reportLocal(originId: string, event: MarkdownViewLocalEvent): Promise<number | null> {
    this.assertActive();
    const origin = this.adapters.get(originId);
    if (!origin) return Promise.resolve(null);
    if (event.revision !== this.revision || origin.currentRevision() !== this.revision) {
      return Promise.resolve(null);
    }
    if (event.causeEpoch !== undefined && this.appliedEpochByView.get(originId) === event.causeEpoch) {
      return Promise.resolve(null);
    }
    return this.dispatch(originId, event.intent, this.mode);
  }

  navigate(intent: MarkdownViewSyncIntent): Promise<number | null> {
    this.assertActive();
    return this.dispatch(null, intent, this.mode);
  }

  reconcileRevision(revision: string): void {
    this.assertActive();
    const next = required(revision, "revision");
    if (next === this.revision) return;
    this.revision = next;
    this.epoch += 1;
    this.active?.abort(new DOMException("Markdown multi-view revision changed", "AbortError"));
    this.active = null;
    this.appliedEpochByView.clear();
  }

  diagnostics() {
    return Object.freeze({
      mode: this.mode,
      revision: this.revision,
      epoch: this.epoch,
      registeredViews: this.adapters.size,
      previewViews: [...this.adapters.values()].filter((adapter) => adapter.surface === "preview").length,
      sourceViews: [...this.adapters.values()].filter((adapter) => adapter.surface === "source").length,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.active?.abort(new DOMException("Markdown multi-view coordinator destroyed", "AbortError"));
    this.active = null;
    this.adapters.clear();
    this.appliedEpochByView.clear();
  }

  private async dispatch(
    originId: string | null,
    intent: MarkdownViewSyncIntent,
    mode: MarkdownMultiViewMode,
  ): Promise<number | null> {
    validateIntent(intent);
    const targets = [...this.adapters.values()].filter((adapter) =>
      adapter.id !== originId
      && adapter.currentRevision() === this.revision
      && surfaceEnabled(mode, adapter.surface));
    if (!targets.length) return null;
    this.active?.abort(new DOMException("Markdown multi-view sync superseded", "AbortError"));
    const controller = new AbortController();
    this.active = controller;
    const epoch = ++this.epoch;
    targets.forEach((adapter) => this.appliedEpochByView.set(adapter.id, epoch));
    await Promise.all(targets.map(async (adapter) => {
      try {
        await adapter.apply(intent, { epoch, revision: this.revision, signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    }));
    if (this.active === controller) this.active = null;
    return epoch;
  }

  private primaryAdapter(mode: MarkdownMultiViewMode): MarkdownMultiViewAdapter | null {
    const preferred = mode === "source" ? "source" : "preview";
    return [...this.adapters.values()].find((adapter) => adapter.surface === preferred) ?? null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown multi-view coordinator is destroyed");
  }
}

function surfaceEnabled(mode: MarkdownMultiViewMode, surface: MarkdownMultiViewSurface): boolean {
  return mode === "split" || mode === surface;
}

function validateIntent(intent: MarkdownViewSyncIntent): void {
  if (!Number.isSafeInteger(intent.sourceOffset) || intent.sourceOffset < 0) {
    throw new Error("Markdown sync sourceOffset must be a non-negative integer");
  }
  if (intent.kind === "annotation" && !intent.annotationId?.trim()) {
    throw new Error("Markdown annotation sync requires annotationId");
  }
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}
