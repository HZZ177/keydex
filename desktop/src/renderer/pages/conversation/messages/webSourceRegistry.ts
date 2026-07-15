import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { WebActivityPayload, WebActivitySource } from "@/types/protocol";
import { normalizeWebActivityPayload } from "../webActivity";

export interface WebTurnSourceRegistry {
  turnKey: string;
  sources: readonly WebActivitySource[];
  bySourceId: ReadonlyMap<string, WebActivitySource>;
  activityMessageIdsBySourceId: ReadonlyMap<string, readonly string[]>;
}

export function buildWebTurnSourceRegistries(
  messages: readonly ConversationMessage[],
): ReadonlyMap<string, WebTurnSourceRegistry> {
  const builders = new Map<string, RegistryBuilder>();
  for (const message of messages) {
    const activity = webActivityFromMessage(message);
    if (!activity) {
      continue;
    }
    const turnKey = webSourceTurnKey(message);
    const builder = builders.get(turnKey) ?? new RegistryBuilder(turnKey);
    builder.addActivity(message.id, activity);
    builders.set(turnKey, builder);
  }
  return new Map(
    [...builders].map(([turnKey, builder]) => [turnKey, builder.build()] as const),
  );
}

export function webSourceRegistryForMessage(
  registries: ReadonlyMap<string, WebTurnSourceRegistry>,
  message: ConversationMessage,
): WebTurnSourceRegistry | null {
  return registries.get(webSourceTurnKey(message)) ?? null;
}

export function webSourceTurnKey(message: ConversationMessage): string {
  const turnIndex = message.payload.turnIndex ?? message.payload.turn_index;
  if (typeof turnIndex === "number" && Number.isFinite(turnIndex)) {
    return `turn:${turnIndex}`;
  }
  if (message.turnId) {
    return `id:${message.turnId}`;
  }
  return `message:${message.id}`;
}

export function sourceNumbersByFirstReference(
  registry: WebTurnSourceRegistry,
  referencedSourceIds: readonly string[],
): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  const numberByUrl = new Map<string, number>();
  for (const sourceId of referencedSourceIds) {
    const source = registry.bySourceId.get(sourceId);
    if (!source) {
      continue;
    }
    const canonicalUrl = canonicalSourceUrl(source.url);
    const existingNumber = numberByUrl.get(canonicalUrl);
    const number = existingNumber ?? numberByUrl.size + 1;
    numberByUrl.set(canonicalUrl, number);
    numbers.set(sourceId, number);
  }
  return numbers;
}

function webActivityFromMessage(message: ConversationMessage): WebActivityPayload | null {
  return normalizeWebActivityPayload(
    message.payload.web_activity ??
      asRecord(message.payload.result)?.ui_payload ??
      message.payload.ui_payload,
  );
}

class RegistryBuilder {
  private readonly entriesByUrl = new Map<string, SourceEntry>();
  private readonly urlBySourceId = new Map<string, string>();

  constructor(private readonly turnKey: string) {}

  addActivity(messageId: string, activity: WebActivityPayload): void {
    const sources = activity.activity_type === "search"
      ? activity.sources
      : activity.items.flatMap((item) => (item.source ? [item.source] : []));
    for (const source of sources) {
      this.addSource(messageId, source);
    }
  }

  build(): WebTurnSourceRegistry {
    const bySourceId = new Map<string, WebActivitySource>();
    const activityMessageIdsBySourceId = new Map<string, readonly string[]>();
    const sources: WebActivitySource[] = [];
    for (const entry of this.entriesByUrl.values()) {
      sources.push(entry.source);
      for (const sourceId of entry.sourceIds) {
        bySourceId.set(sourceId, entry.source);
        activityMessageIdsBySourceId.set(sourceId, [...entry.messageIds]);
      }
    }
    return {
      turnKey: this.turnKey,
      sources,
      bySourceId,
      activityMessageIdsBySourceId,
    };
  }

  private addSource(messageId: string, source: WebActivitySource): void {
    const canonicalUrl = canonicalSourceUrl(source.url);
    const aliasedUrl = this.urlBySourceId.get(source.source_id);
    const key = aliasedUrl ?? canonicalUrl;
    const existing = this.entriesByUrl.get(key) ?? this.entriesByUrl.get(canonicalUrl);
    if (existing) {
      existing.source = mergeSource(existing.source, source);
      existing.sourceIds.add(source.source_id);
      existing.messageIds.add(messageId);
      this.urlBySourceId.set(source.source_id, key);
      return;
    }
    this.entriesByUrl.set(key, {
      source,
      sourceIds: new Set([source.source_id]),
      messageIds: new Set([messageId]),
    });
    this.urlBySourceId.set(source.source_id, key);
  }
}

interface SourceEntry {
  source: WebActivitySource;
  sourceIds: Set<string>;
  messageIds: Set<string>;
}

function mergeSource(existing: WebActivitySource, incoming: WebActivitySource): WebActivitySource {
  return {
    ...existing,
    title: incoming.title ?? existing.title,
    snippet: incoming.snippet ?? existing.snippet,
    favicon: incoming.favicon ?? existing.favicon,
    published_at: incoming.published_at ?? existing.published_at,
    truncated: existing.truncated || incoming.truncated,
  };
}

function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
