import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
} from "react";

import {
  composerNewWorkspaceDraftScope,
  composerSessionDraftScope,
  createComposerDraftStore,
  EMPTY_COMPOSER_DRAFT,
  type ComposerDraft,
  type ComposerDraftStorage,
  type ComposerDraftStore,
  type ComposerDraftUpdate,
} from "./composerDraftStore";
import { subscribeLifecycleEvents } from "@/renderer/events/lifecycleEvents";

const ComposerDraftContext = createContext<ComposerDraftStore | null>(null);

export interface ComposerDraftProviderProps extends PropsWithChildren {
  storage?: ComposerDraftStorage | null;
  persistDelayMs?: number;
}

export function ComposerDraftProvider({
  children,
  storage,
  persistDelayMs,
}: ComposerDraftProviderProps) {
  const store = useMemo(
    () =>
      createComposerDraftStore({
        storage: storage === undefined ? browserStorage() : storage,
        persistDelayMs,
      }),
    [persistDelayMs, storage],
  );

  useEffect(() => {
    const flush = () => store.flush();
    const unsubscribeLifecycle = subscribeLifecycleEvents((event) => {
      if (event.type === "session_purged" && event.session_id) {
        store.clearDraft(composerSessionDraftScope(event.session_id));
      }
      if (event.type === "workspace_purged" && event.workspace_id) {
        store.clearDraft(composerNewWorkspaceDraftScope(event.workspace_id));
      }
    });
    window.addEventListener("pagehide", flush);
    return () => {
      unsubscribeLifecycle();
      window.removeEventListener("pagehide", flush);
      store.dispose();
    };
  }, [store]);

  return <ComposerDraftContext.Provider value={store}>{children}</ComposerDraftContext.Provider>;
}

export interface ComposerDraftBinding {
  scopeKey: string | null;
  draft: ComposerDraft;
  setDraft(update: ComposerDraftUpdate): void;
  setText: Dispatch<SetStateAction<string>>;
  clearDraft(): void;
  copyTo(targetScopeKey: string): void;
  clearScope(scopeKey: string): void;
}

export function useComposerDraft(scopeKey: string | null): ComposerDraftBinding {
  const providedStore = useContext(ComposerDraftContext);
  const fallbackStoreRef = useRef<ComposerDraftStore | null>(null);
  if (!providedStore && !fallbackStoreRef.current) {
    fallbackStoreRef.current = createComposerDraftStore();
  }
  const store = providedStore ?? fallbackStoreRef.current!;
  const normalizedScopeKey = scopeKey?.trim() || null;
  const getSnapshot = useCallback(
    () => (normalizedScopeKey ? store.getDraft(normalizedScopeKey) : EMPTY_COMPOSER_DRAFT),
    [normalizedScopeKey, store],
  );
  const draft = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const setDraft = useCallback(
    (update: ComposerDraftUpdate) => {
      if (normalizedScopeKey) {
        store.updateDraft(normalizedScopeKey, update);
      }
    },
    [normalizedScopeKey, store],
  );
  const setText = useCallback<Dispatch<SetStateAction<string>>>(
    (update) => {
      setDraft((current) => ({
        text: typeof update === "function" ? update(current.text) : update,
      }));
    },
    [setDraft],
  );
  const clearDraft = useCallback(() => {
    if (normalizedScopeKey) {
      store.clearDraft(normalizedScopeKey);
    }
  }, [normalizedScopeKey, store]);
  const copyTo = useCallback(
    (targetScopeKey: string) => {
      if (normalizedScopeKey) {
        store.copyDraft(normalizedScopeKey, targetScopeKey);
      }
    },
    [normalizedScopeKey, store],
  );
  const clearScope = useCallback((targetScopeKey: string) => store.clearDraft(targetScopeKey), [store]);

  useEffect(
    () => () => {
      if (!providedStore) {
        fallbackStoreRef.current?.dispose();
      }
    },
    [providedStore],
  );

  return {
    scopeKey: normalizedScopeKey,
    draft,
    setDraft,
    setText,
    clearDraft,
    copyTo,
    clearScope,
  };
}

function browserStorage(): ComposerDraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
