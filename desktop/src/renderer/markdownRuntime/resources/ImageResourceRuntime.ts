import type { MarkdownSnapshotResource } from "../document/MarkdownSnapshot";
import type {
  MarkdownBlockRendererContext,
  MarkdownRendererResourceLifecycle,
} from "../renderers/types";

export type MarkdownImageLocation =
  | { readonly kind: "direct"; readonly src: string; readonly cacheLocator: string }
  | { readonly kind: "workspace"; readonly path: string; readonly cacheLocator: string }
  | { readonly kind: "blocked"; readonly reason: string; readonly cacheLocator: string };

export interface MarkdownWorkspaceImageResult {
  readonly dataUrl: string;
  readonly mediaType?: string | null;
  readonly bytes?: number | null;
  readonly revision?: string | null;
}

export interface MarkdownDecodedImage {
  readonly width: number;
  readonly height: number;
}

export interface MarkdownImageResourceDescriptor extends MarkdownDecodedImage {
  readonly src: string;
  readonly mediaType: string | null;
  readonly contentRevision: string;
  readonly bytes: number;
}

export interface MarkdownImageDimensionEvent {
  readonly resource: MarkdownSnapshotResource;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly snapshotRevision: string;
  readonly width: number;
  readonly height: number;
  readonly element: HTMLImageElement;
  readonly fromCache: boolean;
}

export interface MarkdownImageStateEvent {
  readonly resourceId: string;
  readonly state: "pending" | "ready" | "failed" | "released";
  readonly key: string;
  readonly error: string | null;
}

export interface MarkdownImageResourceRuntimeOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly sourcePathFor?: (context: MarkdownBlockRendererContext) => string | null | undefined;
  readonly workspaceKeyFor?: (context: MarkdownBlockRendererContext) => string | null | undefined;
  readonly resourceRevisionFor?: (
    resource: MarkdownSnapshotResource,
    context: MarkdownBlockRendererContext,
  ) => string | null | undefined;
  readonly readWorkspaceImage?: (
    path: string,
    context: MarkdownBlockRendererContext,
    signal: AbortSignal,
  ) => Promise<MarkdownWorkspaceImageResult>;
  readonly decodeImage?: (src: string, signal: AbortSignal) => Promise<MarkdownDecodedImage>;
  readonly onDimensions?: (event: MarkdownImageDimensionEvent) => void;
  readonly onStateChange?: (event: MarkdownImageStateEvent) => void;
}

export interface MarkdownImageResourceDiagnostics {
  readonly entries: number;
  readonly ready: number;
  readonly pending: number;
  readonly referenced: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly aborts: number;
  readonly failures: number;
}

interface ImageEntry {
  readonly key: string;
  readonly resourceId: string;
  readonly controller: AbortController;
  readonly promise: Promise<MarkdownImageResourceDescriptor>;
  descriptor: MarkdownImageResourceDescriptor | null;
  refs: number;
  bytes: number;
  touched: number;
}

interface MountedImage {
  active: boolean;
  key: string;
  entry: ImageEntry | null;
  fallback: HTMLElement | null;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class ImageResourceRuntime implements MarkdownRendererResourceLifecycle {
  private readonly entries = new Map<string, ImageEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly decodeImage: NonNullable<MarkdownImageResourceRuntimeOptions["decodeImage"]>;
  private sequence = 0;
  private retainedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private aborts = 0;
  private failures = 0;
  private destroyed = false;

  constructor(private readonly options: MarkdownImageResourceRuntimeOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.decodeImage = options.decodeImage ?? decodeBrowserImage;
  }

  mount(
    resource: MarkdownSnapshotResource,
    element: HTMLElement,
    context: MarkdownBlockRendererContext,
  ): (() => void) | void {
    if (resource.kind !== "image") return undefined;
    this.assertActive();
    const image = imageElement(element);
    if (!image) return undefined;
    const mounted: MountedImage = { active: true, key: "", entry: null, fallback: null };
    const start = () => {
      if (!mounted.active) return;
      this.releaseMounted(mounted, resource.id);
      clearFallback(mounted);
      const location = resolveMarkdownImageLocation(
        resource.url,
        this.options.sourcePathFor?.(context),
        this.options.workspaceKeyFor?.(context),
      );
      const revision = this.options.resourceRevisionFor?.(resource, context) ?? "default";
      const key = imageResourceKey(location, resource, revision);
      mounted.key = key;
      preparePendingImage(image, context.block.kind === "image");
      if (location.kind === "blocked") {
        this.failMounted(mounted, image, resource, context, key, new Error(location.reason), start);
        return;
      }
      const acquired = this.acquire(key, resource, location, revision, context);
      mounted.entry = acquired.entry;
      acquired.entry.refs += 1;
      acquired.entry.touched = ++this.sequence;
      const publish = (descriptor: MarkdownImageResourceDescriptor, fromCache: boolean) => {
        applyReadyImage(image, descriptor);
        this.options.onDimensions?.(Object.freeze({
          resource,
          blockId: context.block.id,
          blockIndex: context.block.index,
          snapshotRevision: context.snapshot.revision,
          width: descriptor.width,
          height: descriptor.height,
          element: image,
          fromCache,
        }));
        this.emit(resource.id, "ready", key, null);
      };
      if (acquired.entry.descriptor) {
        publish(acquired.entry.descriptor, true);
        return;
      }
      this.emit(resource.id, "pending", key, null);
      void acquired.entry.promise.then((descriptor) => {
        if (!mounted.active || mounted.entry !== acquired.entry) return;
        publish(descriptor, acquired.fromCache);
      }).catch((error) => {
        if (!mounted.active || mounted.entry !== acquired.entry || isAbortError(error)) return;
        this.failMounted(mounted, image, resource, context, key, error, start);
      });
    };
    start();
    return () => {
      if (!mounted.active) return;
      mounted.active = false;
      clearFallback(mounted);
      this.releaseMounted(mounted, resource.id);
      image.removeAttribute("aria-busy");
      this.trim();
    };
  }

  invalidate(predicate: (descriptor: MarkdownImageResourceDescriptor, key: string) => boolean = () => true): number {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (!entry.descriptor || !predicate(entry.descriptor, entry.key)) continue;
      if (entry.refs > 0) continue;
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

  diagnostics(): MarkdownImageResourceDiagnostics {
    const values = [...this.entries.values()];
    return Object.freeze({
      entries: values.length,
      ready: values.filter((entry) => entry.descriptor !== null).length,
      pending: values.filter((entry) => entry.descriptor === null).length,
      referenced: values.filter((entry) => entry.refs > 0).length,
      bytes: this.retainedBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      aborts: this.aborts,
      failures: this.failures,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(abortError("Image runtime destroyed"));
    }
    this.entries.clear();
    this.retainedBytes = 0;
  }

  private acquire(
    key: string,
    resource: MarkdownSnapshotResource,
    location: Exclude<MarkdownImageLocation, { kind: "blocked" }>,
    revision: string,
    context: MarkdownBlockRendererContext,
  ): { entry: ImageEntry; fromCache: boolean } {
    const existing = this.entries.get(key);
    if (existing) {
      this.hits += 1;
      existing.touched = ++this.sequence;
      return { entry: existing, fromCache: existing.descriptor !== null };
    }
    this.misses += 1;
    const controller = new AbortController();
    let entry!: ImageEntry;
    const promise = this.load(location, revision, context, controller.signal)
      .then((descriptor) => {
        if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
        entry.descriptor = descriptor;
        entry.bytes = descriptor.bytes;
        this.retainedBytes += descriptor.bytes;
        this.trim();
        return descriptor;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        if (!isAbortError(error)) {
          this.failures += 1;
          this.emit(resource.id, "failed", key, errorMessage(error));
        }
        throw error;
      });
    entry = {
      key,
      resourceId: resource.id,
      controller,
      promise,
      descriptor: null,
      refs: 0,
      bytes: 0,
      touched: ++this.sequence,
    };
    this.entries.set(key, entry);
    return { entry, fromCache: false };
  }

  private async load(
    location: Exclude<MarkdownImageLocation, { kind: "blocked" }>,
    revision: string,
    context: MarkdownBlockRendererContext,
    signal: AbortSignal,
  ): Promise<MarkdownImageResourceDescriptor> {
    let src: string;
    let mediaType: string | null = null;
    let bytes: number | null = null;
    let contentRevision = revision;
    if (location.kind === "workspace") {
      if (!this.options.readWorkspaceImage) throw new Error("Workspace image reader is unavailable");
      const loaded = await this.options.readWorkspaceImage(location.path, context, signal);
      src = safeDirectImageUrl(loaded.dataUrl);
      if (!src) throw new Error("Workspace image response is not a safe image URL");
      mediaType = loaded.mediaType ?? mediaTypeFromDataUrl(src);
      bytes = loaded.bytes ?? null;
      contentRevision = loaded.revision ?? revision;
    } else {
      src = location.src;
      mediaType = mediaTypeFromDataUrl(src);
    }
    const decoded = await this.decodeImage(src, signal);
    if (!validDimension(decoded.width) || !validDimension(decoded.height)) {
      throw new Error("Decoded image dimensions are invalid");
    }
    return Object.freeze({
      src,
      mediaType,
      contentRevision,
      width: decoded.width,
      height: decoded.height,
      bytes: Math.max(256, bytes ?? src.length * 2 + 128),
    });
  }

  private failMounted(
    mounted: MountedImage,
    image: HTMLImageElement,
    resource: MarkdownSnapshotResource,
    context: MarkdownBlockRendererContext,
    key: string,
    error: unknown,
    retry: () => void,
  ): void {
    image.dataset.markdownImageState = "failed";
    image.removeAttribute("aria-busy");
    image.removeAttribute("src");
    image.hidden = true;
    mounted.fallback = imageFallback(
      image,
      resource.alt || resource.url || "Image unavailable",
      retry,
      errorMessage(error),
    );
    this.options.onStateChange?.(Object.freeze({
      resourceId: resource.id,
      state: "failed",
      key,
      error: errorMessage(error),
    }));
    // Keep the semantic block and source mapping alive; only the resource view fails.
    void context;
  }

  private releaseMounted(mounted: MountedImage, resourceId: string): void {
    const entry = mounted.entry;
    mounted.entry = null;
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.touched = ++this.sequence;
    this.emit(resourceId, "released", entry.key, null);
    if (entry.refs === 0 && entry.descriptor === null && !entry.controller.signal.aborted) {
      this.aborts += 1;
      entry.controller.abort(abortError("Image resource released"));
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
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

  private removeEntry(entry: ImageEntry, eviction: boolean): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    this.retainedBytes = Math.max(0, this.retainedBytes - entry.bytes);
    if (!entry.controller.signal.aborted && entry.descriptor === null) entry.controller.abort(abortError());
    if (eviction) this.evictions += 1;
  }

  private emit(resourceId: string, state: MarkdownImageStateEvent["state"], key: string, error: string | null): void {
    this.options.onStateChange?.(Object.freeze({ resourceId, state, key, error }));
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error("ImageResourceRuntime is destroyed");
  }
}

export function resolveMarkdownImageLocation(
  url: string | null,
  sourcePath?: string | null,
  workspaceKey?: string | null,
): MarkdownImageLocation {
  const raw = (url ?? "").trim();
  if (!raw) return blocked("Image URL is empty", raw);
  const direct = safeDirectImageUrl(raw);
  if (direct) return Object.freeze({ kind: "direct", src: direct, cacheLocator: `direct:${direct}` });
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || /^[a-z]:[\\/]/iu.test(raw) || /[\u0000-\u001f]/u.test(raw)) {
    return blocked("Image URL scheme or absolute filesystem path is not allowed", raw);
  }
  if (!workspaceKey) return blocked("Workspace scope is required for a relative image", raw);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.split(/[?#]/u, 1)[0] ?? "");
  } catch {
    return blocked("Image path contains invalid percent encoding", raw);
  }
  const normalized = normalizeWorkspacePath(decoded, sourcePath);
  if (!normalized) return blocked("Image path escapes the workspace or is invalid", raw);
  return Object.freeze({
    kind: "workspace",
    path: normalized,
    cacheLocator: `workspace:${workspaceKey}:${normalized}`,
  });
}

export async function decodeBrowserImage(src: string, signal: AbortSignal): Promise<MarkdownDecodedImage> {
  if (signal.aborted) throw signal.reason ?? abortError();
  return new Promise<MarkdownDecodedImage>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve(Object.freeze({ width: image.naturalWidth, height: image.naturalHeight }));
    };
    const abort = () => {
      image.src = "";
      finish(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      void decoded.then(() => finish()).catch(finish);
    };
    image.onerror = () => finish(new Error("Image load or decode failed"));
    image.src = src;
  });
}

function normalizeWorkspacePath(value: string, sourcePath?: string | null): string | null {
  const normalizedValue = value.replace(/\\/gu, "/");
  const base = normalizedValue.startsWith("/")
    ? []
    : directorySegments((sourcePath ?? "").replace(/\\/gu, "/"));
  const segments = [...base];
  for (const segment of normalizedValue.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}

function directorySegments(sourcePath: string): string[] {
  if (!sourcePath || /^[a-z][a-z0-9+.-]*:/iu.test(sourcePath)) return [];
  const parts = sourcePath.replace(/^\/+/, "").split("/");
  if (parts.length > 0) parts.pop();
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      result.pop();
      continue;
    }
    result.push(part);
  }
  return result;
}

function safeDirectImageUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//iu.test(trimmed) || /^blob:/iu.test(trimmed)) return trimmed;
  if (/^data:image\/(?:avif|bmp|gif|jpeg|jpg|png|svg\+xml|webp)(?:;|,)/iu.test(trimmed)) return trimmed;
  return "";
}

function imageResourceKey(
  location: MarkdownImageLocation,
  resource: MarkdownSnapshotResource,
  revision: string,
): string {
  return [location.cacheLocator, resource.content_hash, revision].join("\u0000");
}

function imageElement(element: HTMLElement): HTMLImageElement | null {
  if (element.tagName === "IMG") return element as HTMLImageElement;
  return element.querySelector<HTMLImageElement>("img");
}

function preparePendingImage(image: HTMLImageElement, blockImage: boolean): void {
  image.hidden = false;
  image.removeAttribute("src");
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.dataset.markdownImageState = "pending";
  image.setAttribute("aria-busy", "true");
  if (blockImage && !image.style.minHeight) image.style.minHeight = "160px";
}

function applyReadyImage(image: HTMLImageElement, descriptor: MarkdownImageResourceDescriptor): void {
  image.src = descriptor.src;
  image.width = descriptor.width;
  image.height = descriptor.height;
  image.style.aspectRatio = `${descriptor.width} / ${descriptor.height}`;
  image.style.removeProperty("min-height");
  image.dataset.markdownImageState = "ready";
  image.dataset.markdownImageWidth = String(descriptor.width);
  image.dataset.markdownImageHeight = String(descriptor.height);
  image.removeAttribute("aria-busy");
}

function imageFallback(image: HTMLImageElement, label: string, retry: () => void, error: string): HTMLElement {
  const fallback = image.ownerDocument.createElement("span");
  fallback.dataset.markdownImageFallback = "true";
  fallback.setAttribute("role", "img");
  fallback.setAttribute("aria-label", label);
  fallback.title = error;
  fallback.dataset.markdownImageError = error;
  const text = image.ownerDocument.createElement("span");
  text.textContent = label;
  const button = image.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = "Retry";
  button.dataset.markdownImageRetry = "true";
  button.addEventListener("click", retry);
  fallback.append(text, button);
  image.after(fallback);
  return fallback;
}

function clearFallback(mounted: MountedImage): void {
  mounted.fallback?.remove();
  mounted.fallback = null;
}

function mediaTypeFromDataUrl(src: string): string | null {
  return /^data:([^;,]+)/iu.exec(src)?.[1]?.toLowerCase() ?? null;
}

function validDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function blocked(reason: string, locator: string): MarkdownImageLocation {
  return Object.freeze({ kind: "blocked", reason, cacheLocator: `blocked:${locator}` });
}

function abortError(message = "Image resource aborted"): DOMException {
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
