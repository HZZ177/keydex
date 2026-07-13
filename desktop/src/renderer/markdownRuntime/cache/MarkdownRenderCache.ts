import type {
  MarkdownSnapshotBlock,
  MarkdownSnapshotResource,
} from "../document/MarkdownSnapshot";
import type { MarkdownRendererProfile } from "../renderers";

export type MarkdownRenderCacheLayer = "descriptor" | "measurement" | "resource";

export interface MarkdownMeasurementEnvironment {
  readonly profile: MarkdownRendererProfile["id"];
  readonly viewportWidth: number;
  readonly themeKey: string;
  readonly fontRevision: string;
  readonly resourceRevision: string;
  readonly resourceIds?: readonly string[];
  readonly zoom?: number;
  readonly devicePixelRatio?: number;
}

export interface MarkdownResourceEnvironment {
  readonly profile: MarkdownRendererProfile["id"];
  readonly themeKey: string;
  readonly resourceRevision: string;
  readonly themeSensitive?: boolean;
}

export interface MarkdownRenderCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly widthBucketSize?: number;
}

export interface MarkdownRenderCacheDiagnostics {
  readonly entries: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly evictions: number;
  readonly layers: Readonly<Record<MarkdownRenderCacheLayer, {
    readonly entries: number;
    readonly bytes: number;
    readonly hits: number;
    readonly misses: number;
  }>>;
}

interface CacheEntry {
  readonly layer: MarkdownRenderCacheLayer;
  readonly key: string;
  readonly lruKey: string;
  readonly blockId: string;
  readonly contentHash: string;
  readonly profile: MarkdownRendererProfile["id"];
  readonly bytes: number;
  readonly value: unknown;
  readonly widthBucket: number | null;
  readonly themeKey: string | null;
  readonly fontRevision: string | null;
  readonly resourceRevision: string | null;
  readonly resourceIds: readonly string[];
  readonly zoom: number | null;
  readonly devicePixelRatio: number | null;
}

interface ResourceInflightEntry {
  readonly key: string;
  readonly blockId: string;
  readonly resourceId: string;
  readonly profile: MarkdownRendererProfile["id"];
  readonly themeKey: string | null;
  readonly resourceRevision: string;
  readonly generation: number;
  readonly promise: Promise<unknown>;
}

interface LayerStats {
  hits: number;
  misses: number;
}

export class MarkdownRenderCache {
  private readonly entriesByLayer: Record<MarkdownRenderCacheLayer, Map<string, CacheEntry>> = {
    descriptor: new Map(),
    measurement: new Map(),
    resource: new Map(),
  };
  private readonly lru = new Map<string, CacheEntry>();
  private readonly stats: Record<MarkdownRenderCacheLayer, LayerStats> = {
    descriptor: { hits: 0, misses: 0 },
    measurement: { hits: 0, misses: 0 },
    resource: { hits: 0, misses: 0 },
  };
  private readonly resourceInflight = new Map<string, ResourceInflightEntry>();
  private readonly resourceGenerations = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly widthBucketSize: number;
  private retainedBytes = 0;
  private evictions = 0;

  constructor(options: MarkdownRenderCacheOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 4096, "maxEntries");
    this.maxBytes = positiveInteger(options.maxBytes ?? 64 * 1024 * 1024, "maxBytes");
    this.widthBucketSize = finitePositive(options.widthBucketSize ?? 4, "widthBucketSize");
  }

  getDescriptor<T>(block: MarkdownSnapshotBlock, profile: MarkdownRendererProfile["id"]): T | undefined {
    return this.get<T>("descriptor", descriptorKey(block, profile));
  }

  setDescriptor<T>(
    block: MarkdownSnapshotBlock,
    profile: MarkdownRendererProfile["id"],
    value: T,
    bytes = estimateValueBytes(value),
  ): T {
    this.set({
      layer: "descriptor",
      key: descriptorKey(block, profile),
      blockId: block.id,
      contentHash: block.content_hash,
      profile,
      value,
      bytes,
      widthBucket: null,
      themeKey: null,
      fontRevision: null,
      resourceRevision: null,
      resourceIds: [],
      zoom: null,
      devicePixelRatio: null,
    });
    return value;
  }

  getOrCreateDescriptor<T>(
    block: MarkdownSnapshotBlock,
    profile: MarkdownRendererProfile["id"],
    factory: () => T,
    bytes?: number,
  ): T {
    const cached = this.getDescriptor<T>(block, profile);
    return cached === undefined ? this.setDescriptor(block, profile, factory(), bytes) : cached;
  }

  getMeasurement(block: MarkdownSnapshotBlock, environment: MarkdownMeasurementEnvironment): number | undefined {
    return this.get<number>("measurement", measurementKey(block, environment, this.widthBucketSize));
  }

  setMeasurement(
    block: MarkdownSnapshotBlock,
    environment: MarkdownMeasurementEnvironment,
    height: number,
  ): number {
    if (!Number.isFinite(height) || height < 0) throw new Error("Measured height must be finite and non-negative");
    this.set({
      layer: "measurement",
      key: measurementKey(block, environment, this.widthBucketSize),
      blockId: block.id,
      contentHash: block.content_hash,
      profile: environment.profile,
      value: height,
      bytes: 96,
      widthBucket: widthBucket(environment.viewportWidth, this.widthBucketSize),
      themeKey: environment.themeKey,
      fontRevision: environment.fontRevision,
      resourceRevision: environment.resourceRevision,
      resourceIds: Object.freeze([...(environment.resourceIds ?? [])]),
      zoom: finitePositive(environment.zoom ?? 1, "zoom"),
      devicePixelRatio: finitePositive(environment.devicePixelRatio ?? 1, "devicePixelRatio"),
    });
    return height;
  }

  getResource<T>(
    resource: MarkdownSnapshotResource,
    environment: MarkdownResourceEnvironment,
  ): T | undefined {
    return this.get<T>("resource", resourceKey(resource, environment));
  }

  setResource<T>(
    resource: MarkdownSnapshotResource,
    environment: MarkdownResourceEnvironment,
    value: T,
    bytes = estimateValueBytes(value),
  ): T {
    this.set({
      layer: "resource",
      key: resourceKey(resource, environment),
      blockId: resource.block_id,
      contentHash: resource.content_hash,
      profile: environment.profile,
      value,
      bytes,
      widthBucket: null,
      themeKey: resourceThemeSensitive(resource, environment) ? environment.themeKey : null,
      fontRevision: null,
      resourceRevision: environment.resourceRevision,
      resourceIds: Object.freeze([resource.id]),
      zoom: null,
      devicePixelRatio: null,
    });
    return value;
  }

  getOrCreateResource<T>(
    resource: MarkdownSnapshotResource,
    environment: MarkdownResourceEnvironment,
    factory: () => T | Promise<T>,
    bytes?: number,
  ): Promise<T> {
    const cached = this.getResource<T>(resource, environment);
    if (cached !== undefined) return Promise.resolve(cached);
    const key = resourceKey(resource, environment);
    const existing = this.resourceInflight.get(key);
    if (existing) return existing.promise as Promise<T>;
    const generation = this.resourceGenerations.get(key) ?? 0;
    const promise = Promise.resolve()
      .then(factory)
      .then((value) => {
        if ((this.resourceGenerations.get(key) ?? 0) === generation) {
          this.setResource(resource, environment, value, bytes);
        }
        return value;
      })
      .finally(() => {
        const current = this.resourceInflight.get(key);
        if (current?.promise === promise) this.resourceInflight.delete(key);
      });
    this.resourceInflight.set(key, Object.freeze({
      key,
      blockId: resource.block_id,
      resourceId: resource.id,
      profile: environment.profile,
      themeKey: resourceThemeSensitive(resource, environment) ? environment.themeKey : null,
      resourceRevision: environment.resourceRevision,
      generation,
      promise,
    }));
    return promise;
  }

  invalidateBlock(blockId: string): number {
    const removed = this.invalidate((entry) => entry.blockId === blockId);
    this.invalidateInflight((entry) => entry.blockId === blockId);
    return removed;
  }

  invalidateWidth(viewportWidth: number): number {
    const bucket = widthBucket(viewportWidth, this.widthBucketSize);
    return this.invalidate((entry) => entry.layer === "measurement" && entry.widthBucket === bucket);
  }

  invalidateTheme(themeKey: string): number {
    const removed = this.invalidate((entry) => entry.themeKey === themeKey);
    this.invalidateInflight((entry) => entry.themeKey === themeKey);
    return removed;
  }

  invalidateResource(resourceId: string): number {
    const removed = this.invalidate((entry) => entry.resourceIds.includes(resourceId));
    this.invalidateInflight((entry) => entry.resourceId === resourceId);
    return removed;
  }

  invalidateFont(fontRevision: string): number {
    return this.invalidate((entry) => entry.fontRevision === fontRevision);
  }

  invalidateViewScale(zoom: number, devicePixelRatio: number): number {
    const validZoom = finitePositive(zoom, "zoom");
    const validDpr = finitePositive(devicePixelRatio, "devicePixelRatio");
    return this.invalidate((entry) => entry.layer === "measurement"
      && entry.zoom === validZoom
      && entry.devicePixelRatio === validDpr);
  }

  invalidateResourceRevision(resourceRevision: string): number {
    const removed = this.invalidate((entry) => entry.resourceRevision === resourceRevision);
    this.invalidateInflight((entry) => entry.resourceRevision === resourceRevision);
    return removed;
  }

  invalidateProfile(profile: MarkdownRendererProfile["id"]): number {
    const removed = this.invalidate((entry) => entry.profile === profile);
    this.invalidateInflight((entry) => entry.profile === profile);
    return removed;
  }

  invalidateRevision(validBlocks: ReadonlyMap<string, string>): number {
    const removed = this.invalidate((entry) => entry.layer === "resource"
      ? !validBlocks.has(entry.blockId)
      : validBlocks.get(entry.blockId) !== entry.contentHash);
    this.invalidateInflight((entry) => !validBlocks.has(entry.blockId));
    return removed;
  }

  clear(): void {
    for (const layer of LAYERS) this.entriesByLayer[layer].clear();
    this.lru.clear();
    this.retainedBytes = 0;
    this.invalidateInflight(() => true);
  }

  diagnostics(): MarkdownRenderCacheDiagnostics {
    const layers = Object.fromEntries(LAYERS.map((layer) => {
      const entries = [...this.entriesByLayer[layer].values()];
      return [layer, Object.freeze({
        entries: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        hits: this.stats[layer].hits,
        misses: this.stats[layer].misses,
      })];
    })) as unknown as MarkdownRenderCacheDiagnostics["layers"];
    return Object.freeze({
      entries: this.lru.size,
      bytes: this.retainedBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      evictions: this.evictions,
      layers: Object.freeze(layers),
    });
  }

  private get<T>(layer: MarkdownRenderCacheLayer, key: string): T | undefined {
    const entry = this.entriesByLayer[layer].get(key);
    if (!entry) {
      this.stats[layer].misses += 1;
      return undefined;
    }
    this.stats[layer].hits += 1;
    this.touch(entry);
    return entry.value as T;
  }

  private set(input: Omit<CacheEntry, "lruKey">): void {
    assertNoDomNodes(input.value);
    const bytes = positiveInteger(Math.ceil(input.bytes), "cache entry bytes");
    const lruKey = `${input.layer}\u0000${input.key}`;
    const previous = this.entriesByLayer[input.layer].get(input.key);
    if (previous) this.remove(previous, false);
    const entry: CacheEntry = Object.freeze({ ...input, bytes, lruKey });
    this.entriesByLayer[input.layer].set(input.key, entry);
    this.lru.set(lruKey, entry);
    this.retainedBytes += bytes;
    this.trim();
  }

  private touch(entry: CacheEntry): void {
    this.lru.delete(entry.lruKey);
    this.lru.set(entry.lruKey, entry);
  }

  private trim(): void {
    while (this.lru.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldest = this.lru.values().next().value as CacheEntry | undefined;
      if (!oldest) return;
      this.remove(oldest, true);
    }
  }

  private invalidate(predicate: (entry: CacheEntry) => boolean): number {
    const candidates = [...this.lru.values()].filter(predicate);
    candidates.forEach((entry) => this.remove(entry, false));
    return candidates.length;
  }

  private remove(entry: CacheEntry, eviction: boolean): void {
    if (!this.entriesByLayer[entry.layer].delete(entry.key)) return;
    this.lru.delete(entry.lruKey);
    this.retainedBytes = Math.max(0, this.retainedBytes - entry.bytes);
    if (eviction) this.evictions += 1;
  }

  private invalidateInflight(predicate: (entry: ResourceInflightEntry) => boolean): void {
    for (const entry of this.resourceInflight.values()) {
      if (!predicate(entry)) continue;
      this.resourceGenerations.set(entry.key, entry.generation + 1);
      this.resourceInflight.delete(entry.key);
    }
  }
}

function descriptorKey(block: MarkdownSnapshotBlock, profile: MarkdownRendererProfile["id"]): string {
  return `${profile}\u0000${block.id}\u0000${block.content_hash}`;
}

function measurementKey(
  block: MarkdownSnapshotBlock,
  environment: MarkdownMeasurementEnvironment,
  bucketSize: number,
): string {
  return [
    environment.profile,
    block.id,
    block.content_hash,
    widthBucket(environment.viewportWidth, bucketSize),
    environment.themeKey,
    environment.fontRevision,
    environment.resourceRevision,
    finitePositive(environment.zoom ?? 1, "zoom"),
    finitePositive(environment.devicePixelRatio ?? 1, "devicePixelRatio"),
  ].join("\u0000");
}

function resourceKey(
  resource: MarkdownSnapshotResource,
  environment: MarkdownResourceEnvironment,
): string {
  return [
    environment.profile,
    resource.block_id,
    resource.id,
    resource.cache_key,
    environment.resourceRevision,
    resourceThemeSensitive(resource, environment) ? environment.themeKey : "*",
  ].join("\u0000");
}

function resourceThemeSensitive(
  resource: MarkdownSnapshotResource,
  environment: MarkdownResourceEnvironment,
): boolean {
  return environment.themeSensitive ?? (resource.kind === "mermaid" || resource.kind === "math");
}

function widthBucket(value: number, bucketSize: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("viewportWidth must be finite and positive");
  return Math.max(bucketSize, Math.round(value / bucketSize) * bucketSize);
}

function estimateValueBytes(value: unknown): number {
  if (typeof value === "string") return Math.max(1, value.length * 2);
  if (value instanceof ArrayBuffer) return Math.max(1, value.byteLength);
  if (ArrayBuffer.isView(value)) return Math.max(1, value.byteLength);
  try {
    return Math.max(1, JSON.stringify(value).length * 2);
  } catch {
    return 256;
  }
}

function assertNoDomNodes(value: unknown): void {
  if (typeof Node === "undefined" || value === null || typeof value !== "object") return;
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof Node) throw new Error("MarkdownRenderCache cannot retain live DOM nodes");
    if (current === null || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof Map) {
      for (const [key, item] of current) pending.push(key, item);
    } else if (current instanceof Set) {
      for (const item of current) pending.push(item);
    } else if (!(current instanceof ArrayBuffer) && !ArrayBuffer.isView(current)) {
      pending.push(...Object.values(current));
    }
    if (visited.size > 4096) throw new Error("MarkdownRenderCache value graph is too large to validate safely");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  return value;
}

const LAYERS: readonly MarkdownRenderCacheLayer[] = ["descriptor", "measurement", "resource"];
