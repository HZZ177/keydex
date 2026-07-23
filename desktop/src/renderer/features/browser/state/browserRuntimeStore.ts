import { createStore, type StoreApi } from "zustand/vanilla";

import {
  eventBelongsToCursor,
  type BrowserEventEnvelope,
  type BrowserProfileMode,
  type BrowserSurfaceRef,
} from "../domain";
import { BROWSER_INTERNAL_BLANK_URL } from "../config";

export type BrowserSurfaceStatus = "creating" | "ready" | "destroyed" | "failed";
export type BrowserSurfaceResourceState = "visible" | "warm" | "native_suspended" | "discarded";

export interface BrowserNavigationRuntime {
  readonly navigationId: string | null;
  readonly url: string;
  readonly title: string;
  readonly faviconUrl: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly errorCategory: string | null;
}

export interface BrowserSurfaceRuntime {
  readonly panelId: string;
  readonly generation: number;
  readonly profileMode: BrowserProfileMode;
  readonly surface: BrowserSurfaceRef | null;
  readonly status: BrowserSurfaceStatus;
  readonly lastSequence: number;
  readonly capabilities: readonly string[];
  readonly navigation: BrowserNavigationRuntime;
  readonly commandError: string | null;
  readonly resourceState: BrowserSurfaceResourceState;
}

export interface BrowserRuntimeState {
  readonly surfaces: Readonly<Record<string, BrowserSurfaceRuntime | undefined>>;
  beginCreate(panelId: string, generation: number, profileMode: BrowserProfileMode, initialUrl: string): void;
  applyEvent(event: BrowserEventEnvelope): boolean;
  failCommand(panelId: string, generation: number, message: string): void;
  setResourceState(panelId: string, generation: number, resourceState: BrowserSurfaceResourceState): void;
  discard(panelId: string, generation: number): void;
  forget(panelId: string, generation: number): void;
  reset(): void;
}

export type BrowserRuntimeStore = StoreApi<BrowserRuntimeState>;

export function createBrowserRuntimeStore(): BrowserRuntimeStore {
  return createStore<BrowserRuntimeState>()((set, get) => ({
    surfaces: {},
    beginCreate(panelId, generation, profileMode, initialUrl) {
      const existing = get().surfaces[panelId];
      if (existing && existing.generation > generation) return;
      set((state) => ({
        surfaces: {
          ...state.surfaces,
          [panelId]: createPendingSurface(panelId, generation, profileMode, initialUrl),
        },
      }));
    },
    applyEvent(event) {
      const current = get().surfaces[event.panelId];
      if (!current || current.generation !== event.generation) return false;

      const surface = current.surface ?? (event.kind === "surface.ready"
        ? { panelId: event.panelId, surfaceId: event.surfaceId, generation: event.generation }
        : null);
      if (!surface || !eventBelongsToCursor(event, { ...surface, lastSequence: current.lastSequence })) {
        return false;
      }
      if (
        event.navigationId
        && current.navigation.navigationId
        && event.kind !== "navigation.started"
        && event.navigationId !== current.navigation.navigationId
      ) {
        return false;
      }

      const next = reduceBrowserEvent({ ...current, surface }, event);
      set((state) => ({ surfaces: { ...state.surfaces, [event.panelId]: next } }));
      return true;
    },
    failCommand(panelId, generation, message) {
      const current = get().surfaces[panelId];
      if (!current || current.generation !== generation) return;
      set((state) => ({
        surfaces: {
          ...state.surfaces,
          [panelId]: { ...current, commandError: message, status: current.surface ? current.status : "failed" },
        },
      }));
    },
    setResourceState(panelId, generation, resourceState) {
      const current = get().surfaces[panelId];
      if (!current || current.generation !== generation) return;
      set((state) => ({
        surfaces: { ...state.surfaces, [panelId]: { ...current, resourceState } },
      }));
    },
    discard(panelId, generation) {
      const current = get().surfaces[panelId];
      if (!current || current.generation !== generation) return;
      set((state) => ({
        surfaces: {
          ...state.surfaces,
          [panelId]: {
            ...current,
            surface: null,
            status: "destroyed",
            resourceState: "discarded",
            navigation: { ...current.navigation, loading: false },
          },
        },
      }));
    },
    forget(panelId, generation) {
      const current = get().surfaces[panelId];
      if (!current || current.generation !== generation) return;
      set((state) => {
        const surfaces = { ...state.surfaces };
        delete surfaces[panelId];
        return { surfaces };
      });
    },
    reset() {
      set({ surfaces: {} });
    },
  }));
}

export function bindBrowserHostEvents(
  client: { subscribe(subscriber: (event: BrowserEventEnvelope) => void): () => void },
  store: BrowserRuntimeStore,
): () => void {
  return client.subscribe((event) => {
    store.getState().applyEvent(event);
  });
}

function createPendingSurface(
  panelId: string,
  generation: number,
  profileMode: BrowserProfileMode,
  initialUrl: string,
): BrowserSurfaceRuntime {
  return {
    panelId,
    generation,
    profileMode,
    surface: null,
    status: "creating",
    lastSequence: 0,
    capabilities: [],
    navigation: {
      navigationId: null,
      url: browserDisplayUrl(initialUrl),
      title: "",
      faviconUrl: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      errorCategory: null,
    },
    commandError: null,
    resourceState: "visible",
  };
}

function reduceBrowserEvent(
  current: BrowserSurfaceRuntime,
  event: BrowserEventEnvelope,
): BrowserSurfaceRuntime {
  let status = current.status;
  let capabilities = current.capabilities;
  let navigation = current.navigation;

  switch (event.kind) {
    case "surface.ready":
      status = "ready";
      capabilities = event.payload.capabilities;
      break;
    case "surface.destroyed":
      status = "destroyed";
      navigation = { ...navigation, loading: false };
      break;
    case "navigation.started":
      navigation = {
        ...navigation,
        navigationId: event.navigationId ?? null,
        url: browserDisplayUrl(event.payload.url),
        loading: true,
        errorCategory: null,
      };
      break;
    case "navigation.committed":
    case "navigation.completed":
    case "page.source":
      navigation = { ...navigation, url: browserDisplayUrl(event.payload.url) };
      break;
    case "navigation.failed":
      navigation = {
        ...navigation,
        url: browserDisplayUrl(event.payload.url),
        loading: false,
        errorCategory: event.payload.errorCategory,
      };
      break;
    case "download.requested":
    case "download.started":
      // WebView2 may report a failed top-level navigation before it reports that
      // the same response became a download. The download owns that response;
      // it must not replace the still-live document with our navigation error UI.
      navigation = {
        ...navigation,
        loading: false,
        errorCategory: null,
      };
      break;
    case "page.title":
      navigation = { ...navigation, title: event.payload.title };
      break;
    case "page.favicon":
      navigation = { ...navigation, faviconUrl: event.payload.faviconUrl };
      break;
    case "page.history":
      navigation = {
        ...navigation,
        canGoBack: event.payload.canGoBack,
        canGoForward: event.payload.canGoForward,
      };
      break;
    case "page.loading":
      navigation = { ...navigation, loading: event.payload.loading };
      break;
    case "resource.state_changed":
      return {
        ...current,
        lastSequence: event.sequence,
        resourceState: event.payload.next,
        commandError: null,
      };
  }

  return {
    ...current,
    status,
    capabilities,
    navigation,
    lastSequence: event.sequence,
    commandError: null,
  };
}

function browserDisplayUrl(value: string): string {
  return value === BROWSER_INTERNAL_BLANK_URL ? "" : value;
}
