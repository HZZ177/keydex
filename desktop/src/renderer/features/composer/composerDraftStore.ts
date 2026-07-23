import type { SkillSummary } from "@/runtime";
import type { SelectedFile } from "@/renderer/components/chat/SendBox/fileSelection";
import type { SelectedImageAttachment } from "@/renderer/components/chat/SendBox/imageAttachments";
import type { SelectedQuote } from "@/renderer/components/chat/SendBox/quoteSelection";
import {
  incognitoWebReferenceRegistry,
  isIncognitoWebAnnotationId,
  webAnnotationSnapshotFromContextItem,
  type SelectedWebAnnotationReference,
} from "@/renderer/features/browser/annotations/chat";
import type { AgentContextItem } from "@/types/protocol";
import {
  normalizePastedTextFragments,
  type PastedTextFragment,
} from "@/renderer/components/chat/SendBox/collapsiblePaste";

export const COMPOSER_DRAFT_STORAGE_KEY = "keydex.composer-drafts.v1";
export const COMPOSER_DRAFT_SCHEMA_VERSION = 1;

const DEFAULT_PERSIST_DELAY_MS = 250;
const MAX_PERSISTED_DRAFTS = 100;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ComposerDraft {
  text: string;
  pastedTextFragments: PastedTextFragment[];
  selectedSkill: SkillSummary | null;
  files: SelectedFile[];
  quotes: SelectedQuote[];
  attachments: SelectedImageAttachment[];
  webAnnotations: SelectedWebAnnotationReference[];
  replayedContextItems: AgentContextItem[];
  updatedAt: number;
}

export type ComposerDraftUpdate =
  | Partial<Omit<ComposerDraft, "updatedAt">>
  | ((current: ComposerDraft) => Partial<Omit<ComposerDraft, "updatedAt">> | ComposerDraft);

export interface ComposerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ComposerDraftStoreOptions {
  storage?: ComposerDraftStorage | null;
  persistDelayMs?: number;
  now?: () => number;
}

export interface ComposerDraftStore {
  getDraft(scopeKey: string): ComposerDraft;
  subscribe(listener: () => void): () => void;
  updateDraft(scopeKey: string, update: ComposerDraftUpdate): void;
  removeWebAnnotation(annotationId: string): number;
  replaceDraft(scopeKey: string, draft: ComposerDraft): void;
  copyDraft(sourceScopeKey: string, targetScopeKey: string): void;
  clearDraft(scopeKey: string): void;
  flush(): void;
  dispose(): void;
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({
  text: "",
  pastedTextFragments: [],
  selectedSkill: null,
  files: [],
  quotes: [],
  attachments: [],
  webAnnotations: [],
  replayedContextItems: [],
  updatedAt: 0,
});

export function composerSessionDraftScope(sessionId: string): string {
  return `session:${sessionId.trim()}`;
}

export function composerNewWorkspaceDraftScope(workspaceId: string): string {
  return `new-workspace:${workspaceId.trim()}`;
}

export function composerPendingWorkspaceDraftScope(rootPath: string): string {
  return `new-workspace-path:${rootPath.trim()}`;
}

export const COMPOSER_NEW_CHAT_DRAFT_SCOPE = "new-chat";

export function createComposerDraftStore(options: ComposerDraftStoreOptions = {}): ComposerDraftStore {
  const storage = options.storage ?? null;
  const persistDelayMs = Math.max(0, options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS);
  const now = options.now ?? Date.now;
  let drafts = readPersistedDrafts(storage, now());
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const publish = () => listeners.forEach((listener) => listener());
  const schedulePersist = () => {
    if (!storage || persistTimer !== null) {
      return;
    }
    if (persistDelayMs === 0) {
      writePersistedDrafts(storage, drafts, now());
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writePersistedDrafts(storage, drafts, now());
    }, persistDelayMs);
  };
  const commit = (scopeKey: string, draft: ComposerDraft) => {
    const normalizedScopeKey = scopeKey.trim();
    if (!normalizedScopeKey) {
      return;
    }
    const normalized = normalizeDraft(draft, now());
    const retainedWebAnnotationIds = new Set(
      normalized.webAnnotations.map((reference) => reference.annotationId),
    );
    for (const reference of drafts[normalizedScopeKey]?.webAnnotations ?? []) {
      if (
        isIncognitoWebAnnotationId(reference.annotationId)
        && !retainedWebAnnotationIds.has(reference.annotationId)
        && !Object.entries(drafts).some(([draftScopeKey, existing]) => (
          draftScopeKey !== normalizedScopeKey
          && existing.webAnnotations.some((item) => item.annotationId === reference.annotationId)
        ))
      ) {
        incognitoWebReferenceRegistry.discard(reference.annotationId);
      }
    }
    if (!composerDraftHasContent(normalized)) {
      if (!(normalizedScopeKey in drafts)) {
        return;
      }
      const next = { ...drafts };
      delete next[normalizedScopeKey];
      drafts = next;
    } else {
      drafts = { ...drafts, [normalizedScopeKey]: normalized };
    }
    publish();
    schedulePersist();
  };

  const store: ComposerDraftStore = {
    getDraft(scopeKey) {
      return drafts[scopeKey.trim()] ?? EMPTY_COMPOSER_DRAFT;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateDraft(scopeKey, update) {
      const current = store.getDraft(scopeKey);
      const patch = typeof update === "function" ? update(current) : update;
      commit(scopeKey, { ...current, ...patch, updatedAt: now() });
    },
    removeWebAnnotation(annotationId) {
      const normalizedId = annotationId.trim();
      if (!normalizedId) return 0;
      let removedCount = 0;
      for (const [scopeKey, draft] of Object.entries(drafts)) {
        const webAnnotations = draft.webAnnotations.filter((reference) => {
          const remove = reference.annotationId === normalizedId;
          if (remove) removedCount += 1;
          return !remove;
        });
        const replayedContextItems = draft.replayedContextItems.filter((item) => {
          const remove = webAnnotationSnapshotFromContextItem(item)?.reference.annotationId === normalizedId;
          if (remove) removedCount += 1;
          return !remove;
        });
        if (
          webAnnotations.length === draft.webAnnotations.length
          && replayedContextItems.length === draft.replayedContextItems.length
        ) {
          continue;
        }
        commit(scopeKey, {
          ...draft,
          webAnnotations,
          replayedContextItems,
          updatedAt: now(),
        });
      }
      return removedCount;
    },
    replaceDraft(scopeKey, draft) {
      commit(scopeKey, draft);
    },
    copyDraft(sourceScopeKey, targetScopeKey) {
      const source = store.getDraft(sourceScopeKey);
      if (source === EMPTY_COMPOSER_DRAFT || sourceScopeKey.trim() === targetScopeKey.trim()) {
        return;
      }
      commit(targetScopeKey, source);
    },
    clearDraft(scopeKey) {
      commit(scopeKey, EMPTY_COMPOSER_DRAFT);
    },
    flush() {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (storage) {
        writePersistedDrafts(storage, drafts, now());
      }
    },
    dispose() {
      store.flush();
      listeners.clear();
    },
  };
  return store;
}

export function composerDraftHasContent(draft: ComposerDraft): boolean {
  return Boolean(
    draft.text ||
      draft.selectedSkill ||
      draft.files.length ||
      draft.quotes.length ||
      draft.attachments.length ||
      draft.webAnnotations.length ||
      draft.replayedContextItems.length,
  );
}

function readPersistedDrafts(
  storage: ComposerDraftStorage | null,
  currentTime: number,
): Record<string, ComposerDraft> {
  if (!storage) {
    return {};
  }
  try {
    const parsed = JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as { version?: unknown; drafts?: unknown };
    if (record.version !== COMPOSER_DRAFT_SCHEMA_VERSION || !record.drafts || typeof record.drafts !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(record.drafts as Record<string, unknown>)
        .flatMap(([scopeKey, value]) => {
          const draft = decodeDraft(value);
          if (!scopeKey.trim() || !draft || currentTime - draft.updatedAt > DRAFT_TTL_MS) {
            return [];
          }
          return [[scopeKey, draft] as const];
        })
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, MAX_PERSISTED_DRAFTS),
    );
  } catch {
    return {};
  }
}

function writePersistedDrafts(
  storage: ComposerDraftStorage,
  drafts: Record<string, ComposerDraft>,
  currentTime: number,
) {
  const entries = Object.entries(drafts)
    .map(([scopeKey, draft]) => [scopeKey, persistableDraft(draft)] as const)
    .filter(([, draft]) => currentTime - draft.updatedAt <= DRAFT_TTL_MS && composerDraftHasContent(draft))
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_PERSISTED_DRAFTS);
  try {
    if (!entries.length) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      return;
    }
    storage.setItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: COMPOSER_DRAFT_SCHEMA_VERSION,
        drafts: Object.fromEntries(entries),
      }),
    );
  } catch {
    // Runtime draft state remains available even when browser storage is unavailable or full.
  }
}

function normalizeDraft(draft: ComposerDraft, updatedAt: number): ComposerDraft {
  const text = typeof draft.text === "string" ? draft.text : "";
  return {
    text,
    pastedTextFragments: normalizePastedTextFragments(text, draft.pastedTextFragments),
    selectedSkill: normalizeSkill(draft.selectedSkill),
    files: recordArray<SelectedFile>(draft.files),
    quotes: recordArray<SelectedQuote>(draft.quotes),
    attachments: recordArray<SelectedImageAttachment>(draft.attachments).map(normalizeRuntimeAttachment),
    webAnnotations: normalizeWebAnnotationReferences(draft.webAnnotations),
    replayedContextItems: normalizeReplayedContextItems(draft.replayedContextItems),
    updatedAt,
  };
}

function decodeDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<ComposerDraft>;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  if (!updatedAt) {
    return null;
  }
  const text = typeof raw.text === "string" ? raw.text : "";
  return {
    text,
    pastedTextFragments: normalizePastedTextFragments(text, raw.pastedTextFragments),
    selectedSkill: normalizeSkill(raw.selectedSkill),
    files: recordArray<SelectedFile>(raw.files),
    quotes: recordArray<SelectedQuote>(raw.quotes),
    attachments: recordArray<SelectedImageAttachment>(raw.attachments).map(stripAttachmentPreview),
    webAnnotations: normalizeWebAnnotationReferences(raw.webAnnotations)
      .filter((reference) => !isIncognitoWebAnnotationId(reference.annotationId)),
    replayedContextItems: normalizeReplayedContextItems(raw.replayedContextItems)
      .filter((item) => {
        const snapshot = webAnnotationSnapshotFromContextItem(item);
        return !snapshot || !isIncognitoWebAnnotationId(snapshot.reference.annotationId);
      }),
    updatedAt,
  };
}

function persistableDraft(draft: ComposerDraft): ComposerDraft {
  const webAnnotations = draft.webAnnotations
    .filter((reference) => !isIncognitoWebAnnotationId(reference.annotationId));
  const replayedContextItems = draft.replayedContextItems.filter((item) => {
    const snapshot = webAnnotationSnapshotFromContextItem(item);
    return !snapshot || !isIncognitoWebAnnotationId(snapshot.reference.annotationId);
  });
  return {
    ...draft,
    pastedTextFragments: draft.pastedTextFragments.map((fragment) => ({ ...fragment })),
    files: draft.files.map((file) => ({ ...file })),
    quotes: draft.quotes.map((quote) => ({ ...quote })),
    attachments: draft.attachments.map(stripAttachmentPreview),
    webAnnotations: webAnnotations.map((reference) => ({ ...reference })),
    replayedContextItems: replayedContextItems.map((item) => ({
      ...item,
      ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
    })),
  };
}

function stripAttachmentPreview(attachment: SelectedImageAttachment): SelectedImageAttachment {
  const { previewUrl: _previewUrl, ...persisted } = attachment;
  return { ...persisted, previewUrl: null };
}

function normalizeRuntimeAttachment(attachment: SelectedImageAttachment): SelectedImageAttachment {
  return {
    ...attachment,
    previewUrl: attachment.previewUrl?.startsWith("blob:") ? null : attachment.previewUrl ?? null,
  };
}

function normalizeSkill(value: unknown): SkillSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<SkillSummary>;
  if (
    typeof raw.name !== "string" ||
    typeof raw.description !== "string" ||
    typeof raw.source !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.locator !== "string"
  ) {
    return null;
  }
  return raw as SkillSummary;
}

function recordArray<T extends object>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => Boolean(item && typeof item === "object")).map((item) => ({ ...item }))
    : [];
}

function normalizeWebAnnotationReferences(value: unknown): SelectedWebAnnotationReference[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Partial<SelectedWebAnnotationReference>;
    const annotationId = typeof raw.annotationId === "string" ? raw.annotationId.trim() : "";
    const selectedAt = typeof raw.selectedAt === "string" ? raw.selectedAt.trim() : "";
    const sourcePanelId = typeof raw.sourcePanelId === "string" ? raw.sourcePanelId.trim() : "";
    if (
      !annotationId
      || annotationId.length > 128
      || ids.has(annotationId)
      || !Number.isInteger(raw.selectedRevision)
      || (raw.selectedRevision ?? 0) < 1
      || !selectedAt
      || selectedAt.length > 64
    ) return [];
    ids.add(annotationId);
    return [{
      annotationId,
      selectedRevision: raw.selectedRevision!,
      selectedAt,
      ...(sourcePanelId ? { sourcePanelId: sourcePanelId.slice(0, 128) } : {}),
    }];
  });
}

function normalizeReplayedContextItems(value: unknown): AgentContextItem[] {
  return recordArray<AgentContextItem>(value).flatMap((item) => {
    const normalized = {
      ...item,
      ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
    };
    return webAnnotationSnapshotFromContextItem(normalized) ? [normalized] : [];
  });
}
