import { buildMarkdownDocumentModel } from "./parser";
import { markdownPreviewContentHash } from "./identity";
import type { BuildMarkdownDocumentModelOptions, MarkdownDocumentModel } from "./types";

export interface MarkdownDocumentModelCacheEntry {
  contentHash: string;
  model: MarkdownDocumentModel;
}

export interface GetMarkdownDocumentModelOptions extends BuildMarkdownDocumentModelOptions {
  cacheKey: string;
  source: string;
}

export class MarkdownDocumentModelCache {
  private readonly entries = new Map<string, MarkdownDocumentModelCacheEntry>();

  constructor(private readonly maxEntries = 12) {}

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  getOrCreate(options: GetMarkdownDocumentModelOptions): MarkdownDocumentModel {
    const contentHash = markdownPreviewContentHash(options.source);
    const entryKey = `${options.cacheKey}:${contentHash}`;
    const cached = this.entries.get(entryKey);
    if (cached) {
      this.entries.delete(entryKey);
      this.entries.set(entryKey, cached);
      return cached.model;
    }
    const model = buildMarkdownDocumentModel(options.source, { idPrefix: options.idPrefix });
    this.entries.set(entryKey, { contentHash, model });
    this.trim();
    return model;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

export const markdownDocumentModelCache = new MarkdownDocumentModelCache();
