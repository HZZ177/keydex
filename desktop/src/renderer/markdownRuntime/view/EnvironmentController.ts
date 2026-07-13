import type { MarkdownRenderCache } from "../cache/MarkdownRenderCache";

export type MarkdownEnvironmentChange =
  | "theme" | "font" | "width" | "zoom" | "dpr" | "reduced-motion";

export interface MarkdownViewEnvironment {
  readonly themeKey: string;
  readonly fontRevision: string;
  readonly viewportWidth: number;
  readonly zoom: number;
  readonly devicePixelRatio: number;
  readonly reducedMotion: boolean;
}

export interface MarkdownEnvironmentTransaction {
  readonly previous: MarkdownViewEnvironment;
  readonly current: MarkdownViewEnvironment;
  readonly changes: ReadonlySet<MarkdownEnvironmentChange>;
  readonly requiresRemeasure: boolean;
}

export interface MarkdownEnvironmentControllerOptions {
  readonly ownerDocument?: Document;
  readonly cache?: MarkdownRenderCache;
  readonly mermaidRuntime?: { refresh(force?: boolean): void };
  readonly initialZoom?: number;
  readonly fontRevisionFor?: (ownerDocument: Document, epoch: number) => string;
  readonly onTransaction?: (transaction: MarkdownEnvironmentTransaction) => void;
  readonly onRemeasure?: (transaction: MarkdownEnvironmentTransaction) => void;
  readonly resizeObserverFactory?: (callback: ResizeObserverCallback) => Pick<ResizeObserver, "observe" | "disconnect">;
  readonly mutationObserverFactory?: (callback: MutationCallback) => Pick<MutationObserver, "observe" | "disconnect">;
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export class MarkdownEnvironmentController {
  private readonly ownerDocument: Document;
  private readonly view: Window;
  private readonly resizeObserver: Pick<ResizeObserver, "observe" | "disconnect"> | null;
  private readonly mutationObserver: Pick<MutationObserver, "observe" | "disconnect"> | null;
  private readonly motionQuery: MediaQueryList | null;
  private readonly scheduleFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private environment: MarkdownViewEnvironment;
  private zoom: number;
  private fontEpoch = 0;
  private frame: number | null = null;
  private disposed = false;
  private transactions = 0;
  private remeasurements = 0;

  constructor(readonly host: HTMLElement, private readonly options: MarkdownEnvironmentControllerOptions = {}) {
    this.ownerDocument = options.ownerDocument ?? host.ownerDocument;
    const view = this.ownerDocument.defaultView;
    if (!view) throw new Error("Markdown environment requires a Window");
    this.view = view;
    this.zoom = finitePositive(options.initialZoom ?? 1, "initialZoom");
    this.scheduleFrame = options.scheduleFrame ?? ((callback) => view.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => view.cancelAnimationFrame(handle));
    this.motionQuery = typeof view.matchMedia === "function"
      ? view.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.environment = this.readEnvironment();
    const resizeFactory = options.resizeObserverFactory
      ?? (typeof ResizeObserver === "undefined" ? null : (callback: ResizeObserverCallback) => new ResizeObserver(callback));
    this.resizeObserver = resizeFactory?.(() => this.request()) ?? null;
    const mutationFactory = options.mutationObserverFactory
      ?? (typeof MutationObserver === "undefined" ? null : (callback: MutationCallback) => new MutationObserver(callback));
    this.mutationObserver = mutationFactory?.(() => this.request()) ?? null;
    this.resizeObserver?.observe(host);
    this.mutationObserver?.observe(this.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    this.motionQuery?.addEventListener?.("change", this.handleMotionChange);
    this.view.addEventListener("resize", this.handleWindowResize, { passive: true });
    this.ownerDocument.fonts?.addEventListener?.("loadingdone", this.handleFontsChanged);
    host.dataset.markdownEnvironment = "true";
    this.applyEnvironment(this.environment);
  }

  current(): MarkdownViewEnvironment { return this.environment; }

  setZoom(zoom: number): void {
    this.assertActive();
    const next = finitePositive(zoom, "zoom");
    if (next === this.zoom) return;
    this.zoom = next;
    this.request();
  }

  refresh(): void { this.assertActive(); this.request(); }

  flushNow(): void {
    this.assertActive();
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.flush();
  }

  behavior(requested: ScrollBehavior = "smooth"): ScrollBehavior {
    return this.environment.reducedMotion ? "auto" : requested;
  }

  diagnostics() {
    return Object.freeze({ transactions: this.transactions, remeasurements: this.remeasurements, frameScheduled: this.frame !== null });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.motionQuery?.removeEventListener?.("change", this.handleMotionChange);
    this.view.removeEventListener("resize", this.handleWindowResize);
    this.ownerDocument.fonts?.removeEventListener?.("loadingdone", this.handleFontsChanged);
    delete this.host.dataset.markdownEnvironment;
  }

  private readonly handleMotionChange = () => this.request();
  private readonly handleWindowResize = () => this.request();
  private readonly handleFontsChanged = () => { this.fontEpoch += 1; this.request(); };

  private request(): void {
    if (this.disposed || this.frame !== null) return;
    this.frame = this.scheduleFrame(() => { this.frame = null; this.flush(); });
  }

  private flush(): void {
    if (this.disposed) return;
    const previous = this.environment;
    const current = this.readEnvironment();
    const changes = environmentChanges(previous, current);
    if (!changes.size) return;
    this.environment = current;
    this.applyEnvironment(current);
    if (changes.has("theme")) {
      this.options.cache?.invalidateTheme(previous.themeKey);
      this.options.mermaidRuntime?.refresh();
    }
    if (changes.has("font")) this.options.cache?.invalidateFont(previous.fontRevision);
    if (changes.has("width")) this.options.cache?.invalidateWidth(previous.viewportWidth);
    if (changes.has("zoom") || changes.has("dpr")) {
      this.options.cache?.invalidateViewScale(previous.zoom, previous.devicePixelRatio);
    }
    const requiresRemeasure = [...changes].some((change) => change !== "reduced-motion");
    const transaction = Object.freeze({ previous, current, changes, requiresRemeasure });
    this.transactions += 1;
    this.options.onTransaction?.(transaction);
    if (requiresRemeasure) {
      this.remeasurements += 1;
      this.options.onRemeasure?.(transaction);
    }
  }

  private readEnvironment(): MarkdownViewEnvironment {
    const rect = this.host.getBoundingClientRect();
    const width = rect.width || this.host.clientWidth || 1;
    return Object.freeze({
      themeKey: this.ownerDocument.documentElement.getAttribute("data-theme") || "light",
      fontRevision: this.options.fontRevisionFor?.(this.ownerDocument, this.fontEpoch) ?? `fonts:${this.fontEpoch}`,
      viewportWidth: Math.max(1, width),
      zoom: this.zoom,
      devicePixelRatio: finitePositive(this.view.devicePixelRatio || 1, "devicePixelRatio"),
      reducedMotion: this.motionQuery?.matches ?? false,
    });
  }

  private applyEnvironment(value: MarkdownViewEnvironment): void {
    this.host.dataset.markdownTheme = value.themeKey;
    this.host.dataset.markdownFontRevision = value.fontRevision;
    this.host.dataset.markdownViewportWidth = String(value.viewportWidth);
    this.host.dataset.markdownZoom = String(value.zoom);
    this.host.dataset.markdownDpr = String(value.devicePixelRatio);
    this.host.dataset.markdownReducedMotion = value.reducedMotion ? "true" : "false";
  }

  private assertActive(): void { if (this.disposed) throw new Error("Markdown environment controller is destroyed"); }
}

function environmentChanges(previous: MarkdownViewEnvironment, current: MarkdownViewEnvironment): ReadonlySet<MarkdownEnvironmentChange> {
  const changes = new Set<MarkdownEnvironmentChange>();
  if (previous.themeKey !== current.themeKey) changes.add("theme");
  if (previous.fontRevision !== current.fontRevision) changes.add("font");
  if (previous.viewportWidth !== current.viewportWidth) changes.add("width");
  if (previous.zoom !== current.zoom) changes.add("zoom");
  if (previous.devicePixelRatio !== current.devicePixelRatio) changes.add("dpr");
  if (previous.reducedMotion !== current.reducedMotion) changes.add("reduced-motion");
  return Object.freeze(changes);
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
  return value;
}
