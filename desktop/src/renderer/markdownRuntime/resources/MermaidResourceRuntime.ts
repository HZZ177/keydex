import type { MermaidConfig } from "mermaid";

import { getMermaidConfig, type MermaidThemeMode } from "@/renderer/utils/mermaidConfig";
import { normalizeMermaidSvgDimensions } from "@/renderer/utils/mermaidSvg";
import type { MarkdownSnapshotResource } from "../document/MarkdownSnapshot";
import type {
  MarkdownBlockRendererContext,
  MarkdownRendererResourceLifecycle,
} from "../renderers/types";

export interface MarkdownMermaidRenderInput {
  readonly code: string;
  readonly theme: MermaidThemeMode;
  readonly config: MermaidConfig;
  readonly renderId: string;
  readonly ownerDocument: Document;
  readonly signal: AbortSignal;
}

export interface MarkdownMermaidRenderService {
  render(input: MarkdownMermaidRenderInput): Promise<string>;
}

export interface MarkdownMermaidDescriptor {
  readonly svg: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly theme: MermaidThemeMode;
  readonly configKey: string;
  readonly bytes: number;
}

export interface MarkdownMermaidDimensionEvent {
  readonly resource: MarkdownSnapshotResource;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly snapshotRevision: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly element: HTMLElement;
  readonly staleReplaced: boolean;
  readonly fromCache: boolean;
}

export interface MarkdownMermaidStateEvent {
  readonly resourceId: string;
  readonly state: "deferred" | "queued" | "rendering" | "stale" | "ready" | "failed" | "released";
  readonly key: string;
  readonly error: string | null;
}

export interface MarkdownMermaidResourceRuntimeOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly rendererRevision?: string;
  readonly renderService?: MarkdownMermaidRenderService;
  readonly themeFor?: (context: MarkdownBlockRendererContext) => MermaidThemeMode;
  readonly configFor?: (theme: MermaidThemeMode, context: MarkdownBlockRendererContext) => MermaidConfig;
  readonly continuityKeyFor?: (
    resource: MarkdownSnapshotResource,
    context: MarkdownBlockRendererContext,
  ) => string;
  readonly shouldRender?: (element: HTMLElement, context: MarkdownBlockRendererContext) => boolean;
  readonly onDimensions?: (event: MarkdownMermaidDimensionEvent) => void;
  readonly onStateChange?: (event: MarkdownMermaidStateEvent) => void;
}

export interface MarkdownMermaidRuntimeDiagnostics {
  readonly entries: number;
  readonly ready: number;
  readonly pending: number;
  readonly referenced: number;
  readonly bytes: number;
  readonly queued: number;
  readonly active: number;
  readonly peakActive: number;
  readonly maxConcurrent: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly cancellations: number;
  readonly failures: number;
}

interface MermaidEntry {
  readonly key: string;
  readonly resourceId: string;
  readonly controller: AbortController;
  readonly promise: Promise<MarkdownMermaidDescriptor>;
  readonly run: () => Promise<void>;
  descriptor: MarkdownMermaidDescriptor | null;
  started: boolean;
  settled: boolean;
  refs: number;
  bytes: number;
  touched: number;
}

interface MountedMermaid {
  readonly resource: MarkdownSnapshotResource;
  readonly target: HTMLElement;
  readonly context: MarkdownBlockRendererContext;
  readonly output: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly source: HTMLElement | null;
  active: boolean;
  key: string;
  entry: MermaidEntry | null;
  start(force?: boolean): void;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export class MermaidResourceRuntime implements MarkdownRendererResourceLifecycle {
  private readonly entries = new Map<string, MermaidEntry>();
  private readonly continuity = new Map<string, MarkdownMermaidDescriptor>();
  private readonly mounted = new Set<MountedMermaid>();
  private readonly queue: MermaidEntry[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly rendererRevision: string;
  private readonly renderService: MarkdownMermaidRenderService;
  private active = 0;
  private peakActive = 0;
  private retainedBytes = 0;
  private sequence = 0;
  private renderSequence = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private cancellations = 0;
  private failures = 0;
  private destroyed = false;

  constructor(private readonly options: MarkdownMermaidResourceRuntimeOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? 1, "maxConcurrent");
    this.maxQueue = positiveInteger(options.maxQueue ?? 128, "maxQueue");
    this.rendererRevision = options.rendererRevision ?? "mermaid-11";
    this.renderService = options.renderService ?? new BrowserMermaidRenderService();
    if (!options.renderService && this.maxConcurrent !== 1) {
      throw new Error("Browser Mermaid renderer requires maxConcurrent=1 because Mermaid configuration is global");
    }
  }

  mount(
    resource: MarkdownSnapshotResource,
    element: HTMLElement,
    context: MarkdownBlockRendererContext,
  ): (() => void) | void {
    if (resource.kind !== "mermaid") return undefined;
    this.assertActive();
    const output = context.ownerDocument.createElement("div");
    output.dataset.markdownMermaidOutput = "true";
    output.dataset.filePreviewSelectionExcluded = "true";
    output.setAttribute("role", "img");
    output.setAttribute("aria-label", "Mermaid 图表");
    const status = context.ownerDocument.createElement("div");
    status.dataset.markdownMermaidStatus = "true";
    const source = element.querySelector<HTMLElement>("pre");
    element.append(output, status);
    const mounted: MountedMermaid = {
      resource,
      target: element,
      context,
      output,
      status,
      source,
      active: true,
      key: "",
      entry: null,
      start: (_force?: boolean) => undefined,
    };
    mounted.start = (force = false) => this.startMounted(mounted, force);
    this.mounted.add(mounted);
    mounted.start();
    return () => {
      if (!mounted.active) return;
      mounted.active = false;
      this.mounted.delete(mounted);
      this.releaseMounted(mounted);
      output.remove();
      status.remove();
      if (source) source.hidden = false;
      this.trim();
    };
  }

  refresh(force = false): void {
    this.assertActive();
    for (const mounted of this.mounted) mounted.start(force);
  }

  invalidate(predicate: (descriptor: MarkdownMermaidDescriptor, key: string) => boolean = () => true): number {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (!entry.descriptor || entry.refs > 0 || !predicate(entry.descriptor, entry.key)) continue;
      this.removeEntry(entry, false);
      removed += 1;
    }
    return removed;
  }

  sweepUnreferenced(): number {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.refs > 0) continue;
      this.removeEntry(entry, false);
      removed += 1;
    }
    return removed;
  }

  diagnostics(): MarkdownMermaidRuntimeDiagnostics {
    const entries = [...this.entries.values()];
    return Object.freeze({
      entries: entries.length,
      ready: entries.filter((entry) => entry.descriptor !== null).length,
      pending: entries.filter((entry) => entry.descriptor === null).length,
      referenced: entries.filter((entry) => entry.refs > 0).length,
      bytes: this.retainedBytes,
      queued: this.queue.filter((entry) => !entry.started && !entry.controller.signal.aborted).length,
      active: this.active,
      peakActive: this.peakActive,
      maxConcurrent: this.maxConcurrent,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      cancellations: this.cancellations,
      failures: this.failures,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const mounted of this.mounted) {
      mounted.active = false;
      mounted.output.remove();
      mounted.status.remove();
      if (mounted.source) mounted.source.hidden = false;
    }
    this.mounted.clear();
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(abortError("Mermaid runtime destroyed"));
    }
    this.entries.clear();
    this.queue.length = 0;
    this.continuity.clear();
    this.retainedBytes = 0;
  }

  private startMounted(mounted: MountedMermaid, force: boolean): void {
    if (!mounted.active) return;
    this.releaseMounted(mounted);
    const { resource, context, target } = mounted;
    const code = blockText(context).trim();
    const continuityKey = this.continuityKey(resource, context);
    const stale = this.continuity.get(continuityKey) ?? null;
    if (stale) applyMermaidOutput(mounted.output, stale, true);
    else mounted.output.replaceChildren();
    if (!code) {
      this.failMounted(mounted, new Error("Mermaid content is empty"), stale);
      return;
    }
    if (!force && this.options.shouldRender && !this.options.shouldRender(target, context)) {
      setMountedState(mounted, "deferred", stale ? "Previous Mermaid result" : "Mermaid source");
      this.emit(resource.id, "deferred", "", null);
      return;
    }
    const theme = this.options.themeFor?.(context) ?? documentTheme(context.ownerDocument);
    const config = this.options.configFor?.(theme, context) ?? getMermaidConfig(theme);
    const configKey = stableConfigKey(config);
    const key = [resource.content_hash, theme, configKey, this.rendererRevision].join("\u0000");
    mounted.key = key;
    const acquired = this.acquire(key, resource, code, theme, config, context);
    mounted.entry = acquired.entry;
    acquired.entry.refs += 1;
    acquired.entry.touched = ++this.sequence;
    if (acquired.entry.descriptor) {
      this.publishMounted(mounted, acquired.entry.descriptor, continuityKey, true, Boolean(stale));
      return;
    }
    setMountedState(mounted, stale ? "stale" : acquired.entry.started ? "rendering" : "queued", stale
      ? "Updating Mermaid"
      : acquired.entry.started ? "Rendering Mermaid" : "Mermaid queued");
    this.emit(resource.id, stale ? "stale" : acquired.entry.started ? "rendering" : "queued", key, null);
    void acquired.entry.promise.then((descriptor) => {
      if (!mounted.active || mounted.entry !== acquired.entry) return;
      this.publishMounted(mounted, descriptor, continuityKey, acquired.fromCache, Boolean(stale));
    }).catch((error) => {
      if (!mounted.active || mounted.entry !== acquired.entry || isAbortError(error)) return;
      this.failMounted(mounted, error, stale);
    });
  }

  private acquire(
    key: string,
    resource: MarkdownSnapshotResource,
    code: string,
    theme: MermaidThemeMode,
    config: MermaidConfig,
    context: MarkdownBlockRendererContext,
  ): { entry: MermaidEntry; fromCache: boolean } {
    const existing = this.entries.get(key);
    if (existing && !existing.controller.signal.aborted) {
      this.hits += 1;
      existing.touched = ++this.sequence;
      return { entry: existing, fromCache: existing.descriptor !== null };
    }
    if (existing) this.removeEntry(existing, false);
    this.misses += 1;
    const controller = new AbortController();
    let resolve!: (value: MarkdownMermaidDescriptor) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MarkdownMermaidDescriptor>((yes, no) => { resolve = yes; reject = no; });
    let entry!: MermaidEntry;
    const run = async () => {
      if (entry.started || entry.controller.signal.aborted) return;
      entry.started = true;
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      this.emit(resource.id, "rendering", key, null);
      try {
        const svg = await this.renderService.render({
          code,
          theme,
          config,
          renderId: `markdown-runtime-mermaid-${++this.renderSequence}`,
          ownerDocument: context.ownerDocument,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
        const normalized = normalizeMermaidSvgDimensions(svg);
        const safeSvg = sanitizeMermaidSvg(normalized.svg, context.ownerDocument);
        const descriptor = Object.freeze({
          svg: safeSvg,
          width: normalized.dimensions?.width ?? null,
          height: normalized.dimensions?.height ?? null,
          theme,
          configKey: stableConfigKey(config),
          bytes: Math.max(256, safeSvg.length * 2 + 192),
        });
        entry.descriptor = descriptor;
        entry.bytes = descriptor.bytes;
        entry.settled = true;
        this.retainedBytes += descriptor.bytes;
        this.trim();
        resolve(descriptor);
      } catch (error) {
        entry.settled = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
        if (!isAbortError(error)) {
          this.failures += 1;
          this.emit(resource.id, "failed", key, errorMessage(error));
        }
        reject(error);
      } finally {
        this.active = Math.max(0, this.active - 1);
        this.pump();
      }
    };
    entry = {
      key,
      resourceId: resource.id,
      controller,
      promise,
      run,
      descriptor: null,
      started: false,
      settled: false,
      refs: 0,
      bytes: 0,
      touched: ++this.sequence,
    };
    this.entries.set(key, entry);
    if (this.queue.length >= this.maxQueue) {
      this.entries.delete(key);
      entry.settled = true;
      reject(new Error("Mermaid render queue budget exceeded"));
    } else {
      this.queue.push(entry);
      this.pump();
    }
    return { entry, fromCache: false };
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.controller.signal.aborted || entry.started || entry.settled) continue;
      void entry.run();
    }
  }

  private publishMounted(
    mounted: MountedMermaid,
    descriptor: MarkdownMermaidDescriptor,
    continuityKey: string,
    fromCache: boolean,
    staleReplaced: boolean,
  ): void {
    this.continuity.set(continuityKey, descriptor);
    applyMermaidOutput(mounted.output, descriptor, false);
    setMountedState(mounted, "ready", "");
    this.options.onDimensions?.(Object.freeze({
      resource: mounted.resource,
      blockId: mounted.context.block.id,
      blockIndex: mounted.context.block.index,
      snapshotRevision: mounted.context.snapshot.revision,
      width: descriptor.width,
      height: descriptor.height,
      element: mounted.target,
      staleReplaced,
      fromCache,
    }));
    this.emit(mounted.resource.id, "ready", mounted.key, null);
  }

  private failMounted(
    mounted: MountedMermaid,
    error: unknown,
    stale: MarkdownMermaidDescriptor | null,
  ): void {
    const state = stale ? "stale" : "failed";
    if (stale) applyMermaidOutput(mounted.output, stale, true);
    setMountedState(mounted, state, stale ? "Mermaid update failed" : "Mermaid render failed", true);
    const retry = mounted.context.ownerDocument.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.dataset.markdownMermaidRetry = "true";
    retry.addEventListener("click", () => mounted.start(true));
    mounted.status.append(retry);
    this.emit(mounted.resource.id, "failed", mounted.key, errorMessage(error));
  }

  private releaseMounted(mounted: MountedMermaid): void {
    const entry = mounted.entry;
    mounted.entry = null;
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.touched = ++this.sequence;
    this.emit(mounted.resource.id, "released", entry.key, null);
    if (entry.refs === 0 && !entry.settled && !entry.controller.signal.aborted) {
      this.cancellations += 1;
      entry.controller.abort(abortError("Mermaid resource released"));
      if (!entry.started) {
        entry.settled = true;
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      }
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.refs === 0 && entry.descriptor !== null)
        .sort((left, right) => left.touched - right.touched)[0];
      if (!candidate) return;
      this.removeEntry(candidate, true);
    }
  }

  private removeEntry(entry: MermaidEntry, eviction: boolean): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    this.retainedBytes = Math.max(0, this.retainedBytes - entry.bytes);
    if (entry.descriptor) {
      for (const [key, descriptor] of this.continuity) {
        if (descriptor === entry.descriptor) this.continuity.delete(key);
      }
    }
    if (!entry.settled && !entry.controller.signal.aborted) entry.controller.abort(abortError());
    if (eviction) this.evictions += 1;
  }

  private continuityKey(resource: MarkdownSnapshotResource, context: MarkdownBlockRendererContext): string {
    return this.options.continuityKeyFor?.(resource, context)
      ?? `${context.snapshot.document_id}\u0000${context.block.index}\u0000mermaid`;
  }

  private emit(resourceId: string, state: MarkdownMermaidStateEvent["state"], key: string, error: string | null): void {
    this.options.onStateChange?.(Object.freeze({ resourceId, state, key, error }));
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error("MermaidResourceRuntime is destroyed");
  }
}

export class BrowserMermaidRenderService implements MarkdownMermaidRenderService {
  async render(input: MarkdownMermaidRenderInput): Promise<string> {
    checkpoint(input.signal);
    await yieldToFirstPaint(input.ownerDocument, input.signal);
    const { default: mermaid } = await import("mermaid");
    checkpoint(input.signal);
    mermaid.initialize(input.config);
    await mermaid.parse(input.code, { suppressErrors: false });
    checkpoint(input.signal);
    const host = input.ownerDocument.createElement("div");
    host.dataset.mermaidRenderHost = "true";
    host.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    input.ownerDocument.body.append(host);
    try {
      const result = await mermaid.render(input.renderId, input.code, host);
      checkpoint(input.signal);
      return typeof result === "string" ? result : result.svg;
    } finally {
      host.remove();
      cleanupGlobalMermaidErrors(input.ownerDocument);
    }
  }
}

async function yieldToFirstPaint(ownerDocument: Document, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const view = ownerDocument.defaultView;
    if (!view) {
      queueMicrotask(resolve);
      return;
    }
    let frame = 0;
    const abort = () => {
      if (frame) view.cancelAnimationFrame(frame);
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    frame = view.requestAnimationFrame(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
  checkpoint(signal);
}

export function sanitizeMermaidSvg(svg: string, ownerDocument: Document = document): string {
  if (!svg.trim()) throw new Error("Mermaid returned empty SVG");
  const parser = new ownerDocument.defaultView!.DOMParser();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("Mermaid returned malformed SVG");
  const root = parsed.documentElement;
  if (root.localName.toLowerCase() !== "svg") throw new Error("Mermaid result is not SVG");
  parsed.querySelectorAll("script,iframe,object,embed,audio,video").forEach((element) => element.remove());
  parsed.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")
        || ((name === "href" || name === "xlink:href") && /^(?:javascript|vbscript|data:text)/iu.test(value))
        || (name === "style" && /url\s*\(\s*["']?\s*(?:javascript|vbscript):/iu.test(value))) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return new ownerDocument.defaultView!.XMLSerializer().serializeToString(root);
}

function applyMermaidOutput(output: HTMLElement, descriptor: MarkdownMermaidDescriptor, stale: boolean): void {
  output.innerHTML = descriptor.svg;
  output.dataset.markdownMermaidStale = stale ? "true" : "false";
  output.dataset.markdownMermaidTheme = descriptor.theme;
  if (descriptor.width !== null) output.dataset.markdownMermaidWidth = String(descriptor.width);
  if (descriptor.height !== null) output.dataset.markdownMermaidHeight = String(descriptor.height);
}

function setMountedState(
  mounted: MountedMermaid,
  state: "deferred" | "queued" | "rendering" | "stale" | "ready" | "failed",
  message: string,
  alert = false,
): void {
  mounted.target.dataset.markdownMermaidState = state;
  mounted.status.replaceChildren();
  if (message) {
    mounted.status.textContent = message;
    mounted.status.setAttribute("role", alert ? "alert" : "status");
  } else {
    mounted.status.removeAttribute("role");
  }
  const hasOutput = mounted.output.childNodes.length > 0;
  mounted.output.hidden = !hasOutput;
  if (mounted.source) mounted.source.hidden = hasOutput && state !== "failed";
}

function stableConfigKey(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number") return entry;
    if (typeof entry === "function") return `[function:${entry.name || "anonymous"}]`;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry !== "object") return String(entry);
    if (seen.has(entry)) return "[circular]";
    seen.add(entry);
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  };
  return JSON.stringify(normalize(value));
}

function blockText(context: MarkdownBlockRendererContext): string {
  return context.logicalText.slice(context.block.logical_start, context.block.logical_end);
}

function documentTheme(ownerDocument: Document): MermaidThemeMode {
  return ownerDocument.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function cleanupGlobalMermaidErrors(ownerDocument: Document): void {
  ownerDocument.querySelectorAll<HTMLElement>("body > div[id^='dmermaid-'], body > svg[id^='mermaid-']")
    .forEach((element) => element.remove());
}

function checkpoint(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError();
}

function abortError(message = "Mermaid render aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
