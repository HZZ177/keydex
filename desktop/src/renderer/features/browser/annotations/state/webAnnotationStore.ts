import { createStore, type StoreApi } from "zustand/vanilla";

import type { BrowserProfileMode, BrowserSurfaceRef } from "../../domain";
import type { WebAnnotationTarget } from "../../runtime";
import {
  readWebAnnotationConflict,
  type WebAnnotationClient,
  type WebAnnotationCreateInput,
  type WebAnnotationDetail,
  type WebAnnotationItem,
  type WebAnnotationAssetRegistrationInput,
  type WebAnnotationMutationResult,
  type WebAnnotationPatchInput,
  type WebAnnotationRetargetInput,
  type WebAnnotationScope,
  type WebAnnotationSource,
  type WebAnnotationTypedProperty,
} from "../api";

export interface WebAnnotationPageActivation {
  readonly scope: WebAnnotationScope;
  readonly url: string;
  readonly title: string;
  readonly canonicalUrl?: string | null;
  readonly profileMode: BrowserProfileMode;
  readonly surface: BrowserSurfaceRef;
  readonly navigationId: string;
}

export interface ActiveWebAnnotationPage extends WebAnnotationPageActivation {
  readonly requestKey: string;
  readonly pageKey: string;
}

export type WebAnnotationPageLoadStatus = "loading" | "ready" | "error";

export interface WebAnnotationPageEntry {
  readonly key: string;
  readonly requestKey: string;
  readonly scope: WebAnnotationScope;
  readonly requestedUrl: string;
  readonly urlKey: string | null;
  readonly resource: WebAnnotationItem["resource"] | null;
  readonly items: readonly WebAnnotationItem[];
  readonly status: WebAnnotationPageLoadStatus;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly loadedAt: string | null;
}

export interface WebAnnotationMutationState {
  readonly kind: "create" | "patch" | "retarget" | "delete";
  readonly annotationId: string | null;
  readonly token: number;
}

export interface WebAnnotationConflictState {
  readonly annotationId: string;
  readonly expectedRevision: number;
  readonly current: WebAnnotationItem;
}

export interface WebAnnotationCreateDraft {
  readonly target: WebAnnotationTarget;
  readonly bodyMarkdown: string;
  readonly tags?: readonly string[];
  readonly properties?: readonly WebAnnotationTypedProperty[];
  readonly stagedAssetIds?: readonly string[];
  readonly stagedAsset?: WebAnnotationAssetRegistrationInput["asset"];
}

export interface WebAnnotationRetargetDraft extends WebAnnotationRetargetInput {
  readonly stagedAsset?: WebAnnotationAssetRegistrationInput["asset"];
}

export interface WebAnnotationStoreState {
  readonly activePage: ActiveWebAnnotationPage | null;
  readonly pages: Readonly<Record<string, WebAnnotationPageEntry | undefined>>;
  readonly aliases: Readonly<Record<string, string | undefined>>;
  readonly mutation: WebAnnotationMutationState | null;
  readonly mutationError: string | null;
  readonly conflict: WebAnnotationConflictState | null;
  readonly mutationSequence: number;
  activatePage(input: WebAnnotationPageActivation): Promise<void>;
  reload(): Promise<void>;
  closeSurface(surface: BrowserSurfaceRef): void;
  createAnnotation(input: WebAnnotationCreateDraft): Promise<WebAnnotationDetail>;
  patchAnnotation(
    annotationId: string,
    input: WebAnnotationPatchInput,
  ): Promise<WebAnnotationMutationResult>;
  retargetAnnotation(
    annotationId: string,
    input: WebAnnotationRetargetDraft,
  ): Promise<WebAnnotationMutationResult>;
  deleteAnnotation(annotationId: string): Promise<void>;
  clearConflict(): void;
  dispose(): void;
}

export type WebAnnotationStore = StoreApi<WebAnnotationStoreState>;

export interface WebAnnotationStoreOptions {
  readonly now?: () => string;
}

export function createWebAnnotationStore(
  client: WebAnnotationClient,
  options: WebAnnotationStoreOptions = {},
): WebAnnotationStore {
  const now = options.now ?? (() => new Date().toISOString());
  let activeLoad: AbortController | null = null;
  let loadSequence = 0;

  return createStore<WebAnnotationStoreState>()((set, get) => {
    async function activatePage(input: WebAnnotationPageActivation): Promise<void> {
      const url = input.url.trim();
      if (!url) throw new Error("Web annotation page URL is required");
      activeLoad?.abort();
      const controller = new AbortController();
      activeLoad = controller;
      const requestId = ++loadSequence;
      const requestKey = webAnnotationRequestKey(input.scope, url);
      const pageKey = get().aliases[requestKey] ?? requestKey;
      const cached = get().pages[pageKey];
      const nextActive: ActiveWebAnnotationPage = Object.freeze({
        ...input,
        url,
        requestKey,
        pageKey,
      });
      const loadingEntry: WebAnnotationPageEntry = Object.freeze({
        key: pageKey,
        requestKey,
        scope: input.scope,
        requestedUrl: url,
        urlKey: cached?.urlKey ?? null,
        resource: cached?.resource ?? null,
        items: cached?.items ?? Object.freeze([]),
        status: cached?.items.length ? "ready" : "loading",
        refreshing: true,
        error: null,
        loadedAt: cached?.loadedAt ?? null,
      });
      set((state) => ({
        activePage: nextActive,
        pages: { ...state.pages, [pageKey]: loadingEntry },
      }));

      try {
        const items = await loadAllPages(client, input.scope, url, controller.signal);
        if (controller.signal.aborted || requestId !== loadSequence) return;
        const resource = singlePageResource(items);
        const canonicalKey = resource
          ? webAnnotationCacheKey(input.scope, resource.urlKey)
          : pageKey;
        const entry: WebAnnotationPageEntry = Object.freeze({
          key: canonicalKey,
          requestKey,
          scope: input.scope,
          requestedUrl: url,
          urlKey: resource?.urlKey ?? cached?.urlKey ?? null,
          resource,
          items: Object.freeze([...items]),
          status: "ready",
          refreshing: false,
          error: null,
          loadedAt: now(),
        });
        set((state) => {
          if (state.activePage?.requestKey !== requestKey || requestId !== loadSequence) return state;
          const pages = { ...state.pages, [canonicalKey]: entry };
          if (canonicalKey !== pageKey) delete pages[pageKey];
          return {
            activePage: Object.freeze({ ...state.activePage, pageKey: canonicalKey }),
            aliases: { ...state.aliases, [requestKey]: canonicalKey },
            pages,
          };
        });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || requestId !== loadSequence) return;
        set((state) => {
          if (state.activePage?.requestKey !== requestKey) return state;
          const current = state.pages[state.activePage.pageKey] ?? loadingEntry;
          const hasCachedItems = current.items.length > 0;
          return {
            pages: {
              ...state.pages,
              [current.key]: Object.freeze({
                ...current,
                status: hasCachedItems ? "ready" : "error",
                refreshing: false,
                error: errorMessage(error),
              }),
            },
          };
        });
      } finally {
        if (activeLoad === controller) activeLoad = null;
      }
    }

    function beginMutation(
      kind: WebAnnotationMutationState["kind"],
      annotationId: string | null,
    ): number {
      if (get().mutation) throw new Error("A web annotation mutation is already pending");
      const token = get().mutationSequence + 1;
      set({
        conflict: null,
        mutation: Object.freeze({ kind, annotationId, token }),
        mutationError: null,
        mutationSequence: token,
      });
      return token;
    }

    function finishMutation(token: number): void {
      if (get().mutation?.token === token) set({ mutation: null });
    }

    function failMutation(token: number, error: unknown): void {
      if (get().mutation?.token === token) {
        set({ mutation: null, mutationError: errorMessage(error) });
      }
    }

    function applyDetail(detail: WebAnnotationDetail): void {
      const item: WebAnnotationItem = Object.freeze({
        resource: detail.resource,
        annotation: detail.annotation,
      });
      applyItem(item);
    }

    function applyItem(item: WebAnnotationItem): void {
      const canonicalKey = webAnnotationCacheKey(item.resource.scope, item.resource.urlKey);
      set((state) => {
        const active = state.activePage;
        const existing = state.pages[canonicalKey]
          ?? (active ? state.pages[active.pageKey] : undefined);
        const items = upsertItem(existing?.items ?? [], item);
        const requestKey = existing?.requestKey ?? active?.requestKey
          ?? webAnnotationRequestKey(item.resource.scope, item.resource.urlNormalized);
        const entry: WebAnnotationPageEntry = Object.freeze({
          key: canonicalKey,
          requestKey,
          scope: item.resource.scope,
          requestedUrl: existing?.requestedUrl ?? item.resource.urlNormalized,
          urlKey: item.resource.urlKey,
          resource: item.resource,
          items,
          status: "ready",
          refreshing: false,
          error: null,
          loadedAt: now(),
        });
        const pages = { ...state.pages, [canonicalKey]: entry };
        if (active && active.pageKey !== canonicalKey) delete pages[active.pageKey];
        return {
          activePage: active
            ? Object.freeze({ ...active, pageKey: canonicalKey })
            : null,
          aliases: { ...state.aliases, [requestKey]: canonicalKey },
          pages,
        };
      });
    }

    function recoverConflict(
      annotationId: string,
      error: unknown,
    ): WebAnnotationMutationResult | null {
      const recovered = readWebAnnotationConflict(error);
      if (!recovered) return null;
      applyItem(recovered.current);
      set({
        conflict: Object.freeze({ annotationId, ...recovered }),
        mutationError: null,
      });
      return Object.freeze({ status: "conflict", ...recovered });
    }

    return {
      activePage: null,
      pages: {},
      aliases: {},
      mutation: null,
      mutationError: null,
      conflict: null,
      mutationSequence: 0,
      activatePage,
      async reload() {
        const active = get().activePage;
        if (active) await activatePage(active);
      },
      closeSurface(surface) {
        const active = get().activePage;
        if (!active || !sameSurface(active.surface, surface)) return;
        activeLoad?.abort();
        activeLoad = null;
        loadSequence += 1;
        set({ activePage: null });
      },
      async createAnnotation(input) {
        const active = get().activePage;
        if (!active) throw new Error("No active browser page for web annotation creation");
        const token = beginMutation("create", null);
        const payload: WebAnnotationCreateInput = {
          scope: active.scope,
          source: sourceFromActivePage(active),
          target: input.target,
          bodyMarkdown: input.bodyMarkdown,
          tags: input.tags,
          properties: input.properties,
          stagedAssetIds: input.stagedAsset
            ? [...(input.stagedAssetIds ?? []), input.stagedAsset.assetId]
            : input.stagedAssetIds,
        };
        try {
          if (input.stagedAsset) {
            await client.registerAsset({
              scope: active.scope,
              source: sourceFromActivePage(active),
              asset: input.stagedAsset,
            });
          }
          const detail = await client.create(payload);
          applyDetail(detail);
          finishMutation(token);
          return detail;
        } catch (error) {
          failMutation(token, error);
          throw error;
        }
      },
      async patchAnnotation(annotationId, input) {
        const token = beginMutation("patch", annotationId);
        try {
          const detail = await client.patch(annotationId, input);
          applyDetail(detail);
          finishMutation(token);
          return Object.freeze({ status: "saved", detail });
        } catch (error) {
          const conflict = recoverConflict(annotationId, error);
          if (conflict) {
            finishMutation(token);
            return conflict;
          }
          failMutation(token, error);
          throw error;
        }
      },
      async retargetAnnotation(annotationId, input) {
        const active = get().activePage;
        if (!active) throw new Error("No active browser page for web annotation retarget");
        const token = beginMutation("retarget", annotationId);
        const payload: WebAnnotationRetargetInput = {
          expectedRevision: input.expectedRevision,
          target: input.target,
          stagedAssetIds: input.stagedAsset
            ? [...(input.stagedAssetIds ?? []), input.stagedAsset.assetId]
            : input.stagedAssetIds,
        };
        try {
          if (input.stagedAsset) {
            await client.registerAsset({
              scope: active.scope,
              source: sourceFromActivePage(active),
              asset: input.stagedAsset,
            });
          }
          const detail = await client.retarget(annotationId, payload);
          applyDetail(detail);
          finishMutation(token);
          return Object.freeze({ status: "saved", detail });
        } catch (error) {
          const conflict = recoverConflict(annotationId, error);
          if (conflict) {
            finishMutation(token);
            return conflict;
          }
          failMutation(token, error);
          throw error;
        }
      },
      async deleteAnnotation(annotationId) {
        const token = beginMutation("delete", annotationId);
        try {
          await client.delete(annotationId);
          set((state) => ({
            pages: Object.fromEntries(
              Object.entries(state.pages).map(([key, entry]) => [
                key,
                entry
                  ? Object.freeze({
                      ...entry,
                      items: Object.freeze(
                        entry.items.filter((item) => item.annotation.id !== annotationId),
                      ),
                    })
                  : entry,
              ]),
            ),
          }));
          finishMutation(token);
        } catch (error) {
          failMutation(token, error);
          throw error;
        }
      },
      clearConflict() {
        set({ conflict: null });
      },
      dispose() {
        activeLoad?.abort();
        activeLoad = null;
        loadSequence += 1;
        set({
          activePage: null,
          pages: {},
          aliases: {},
          mutation: null,
          mutationError: null,
          conflict: null,
          mutationSequence: 0,
        });
      },
    };
  });
}

export function webAnnotationScopeKey(scope: WebAnnotationScope): string {
  if (scope.kind === "global") {
    if (scope.id !== null) throw new Error("Global web annotation scope cannot have an id");
    return "global";
  }
  const id = scope.id?.trim();
  if (!id) throw new Error(`${scope.kind} web annotation scope requires an id`);
  return `${scope.kind}:${id}`;
}

export function webAnnotationCacheKey(scope: WebAnnotationScope, urlKey: string): string {
  const normalizedUrlKey = urlKey.trim();
  if (!normalizedUrlKey) throw new Error("Web annotation url_key is required");
  return `${webAnnotationScopeKey(scope)}|url-key:${normalizedUrlKey}`;
}

export function webAnnotationRequestKey(scope: WebAnnotationScope, url: string): string {
  return `${webAnnotationScopeKey(scope)}|url:${url.trim()}`;
}

async function loadAllPages(
  client: WebAnnotationClient,
  scope: WebAnnotationScope,
  url: string,
  signal: AbortSignal,
): Promise<readonly WebAnnotationItem[]> {
  const items: WebAnnotationItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.list({ scope, url, cursor, limit: 100, signal });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !signal.aborted);
  return Object.freeze(items);
}

function singlePageResource(
  items: readonly WebAnnotationItem[],
): WebAnnotationItem["resource"] | null {
  const resource = items[0]?.resource ?? null;
  if (!resource) return null;
  if (items.some((item) => item.resource.urlKey !== resource.urlKey)) {
    throw new Error("Web annotation page response contains multiple URL identities");
  }
  return resource;
}

function upsertItem(
  items: readonly WebAnnotationItem[],
  item: WebAnnotationItem,
): readonly WebAnnotationItem[] {
  const next = items.filter((candidate) => candidate.annotation.id !== item.annotation.id);
  next.push(item);
  next.sort((left, right) => {
    const byCreated = left.annotation.createdAt.localeCompare(right.annotation.createdAt);
    return byCreated || left.annotation.id.localeCompare(right.annotation.id);
  });
  return Object.freeze(next);
}

function sourceFromActivePage(active: ActiveWebAnnotationPage): WebAnnotationSource {
  return Object.freeze({
    url: active.url,
    title: active.title,
    canonicalUrl: active.canonicalUrl ?? null,
    profileMode: active.profileMode,
  });
}

function sameSurface(left: BrowserSurfaceRef, right: BrowserSurfaceRef): boolean {
  return left.panelId === right.panelId
    && left.surfaceId === right.surfaceId
    && left.generation === right.generation;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === "object"
    && (error as { name?: unknown }).name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "网页批注请求失败";
}
