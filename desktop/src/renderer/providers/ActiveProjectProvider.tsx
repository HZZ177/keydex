import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import {
  deriveActiveProjectState,
  reduceActiveProjectState,
  type ActiveProjectDiscovery,
  type ActiveProjectState,
} from "@/renderer/features/git/activeProject";

export interface ActiveProjectSelectionStorage {
  get(workspaceId: string): string | null;
  set(workspaceId: string, repoId: string): void;
  clear(workspaceId: string): void;
}

export function createActiveProjectSelectionStorage(): ActiveProjectSelectionStorage {
  const selectedByWorkspace = new Map<string, string>();
  return {
    get: (workspaceId) => selectedByWorkspace.get(workspaceId) ?? null,
    set: (workspaceId, repoId) => selectedByWorkspace.set(workspaceId, repoId),
    clear: (workspaceId) => selectedByWorkspace.delete(workspaceId),
  };
}

interface ActiveProjectStore {
  getState(): ActiveProjectState;
  subscribe(listener: () => void): () => void;
  setDiscovery(discovery: ActiveProjectDiscovery): void;
  selectRepo(repoId: string): void;
}

function createActiveProjectStore(
  initialDiscovery: ActiveProjectDiscovery,
  storage: ActiveProjectSelectionStorage,
): ActiveProjectStore {
  let state = deriveWithStoredSelection(initialDiscovery, storage);
  const listeners = new Set<() => void>();

  const publish = (next: ActiveProjectState) => {
    if (Object.is(next, state)) return;
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDiscovery: (discovery) => publish(deriveWithStoredSelection(discovery, storage)),
    selectRepo: (repoId) => {
      const next = reduceActiveProjectState(state, { type: "select_repo", repoId });
      if (next === state) return;
      if (next.status === "ready" || next.status === "multi_repo") {
        storage.set(next.workspaceId, next.selectedRepoId);
      }
      publish(next);
    },
  };
}

function deriveWithStoredSelection(
  discovery: ActiveProjectDiscovery,
  storage: ActiveProjectSelectionStorage,
): ActiveProjectState {
  if (!discovery.project || discovery.selectedRepoId !== undefined) {
    return deriveActiveProjectState(discovery);
  }
  const stored = storage.get(discovery.project.workspaceId);
  const roots = discovery.repoRoots ?? [];
  return deriveActiveProjectState({
    ...discovery,
    selectedRepoId: stored && roots.some((root) => root.id === stored) ? stored : undefined,
  });
}

const defaultSelectionStorage = createActiveProjectSelectionStorage();
const ActiveProjectContext = createContext<ActiveProjectStore | null>(null);

export interface ActiveProjectProviderProps extends PropsWithChildren {
  discovery: ActiveProjectDiscovery;
  selectionStorage?: ActiveProjectSelectionStorage;
}

export function ActiveProjectProvider({
  children,
  discovery,
  selectionStorage = defaultSelectionStorage,
}: ActiveProjectProviderProps) {
  const storeRef = useRef<ActiveProjectStore | null>(null);
  if (!storeRef.current) storeRef.current = createActiveProjectStore(discovery, selectionStorage);

  useEffect(() => {
    storeRef.current?.setDiscovery(discovery);
  }, [discovery]);

  return <ActiveProjectContext.Provider value={storeRef.current}>{children}</ActiveProjectContext.Provider>;
}

function useActiveProjectStore(optional: boolean): ActiveProjectStore | null {
  const store = useContext(ActiveProjectContext);
  if (!store && !optional) throw new Error("ActiveProjectProvider is missing");
  return store;
}

export function useActiveProjectState(): ActiveProjectState {
  const store = useActiveProjectStore(false)!;
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useOptionalActiveProjectState(): ActiveProjectState | null {
  const store = useActiveProjectStore(true);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getState ?? (() => null),
    store?.getState ?? (() => null),
  );
}

export function useActiveProjectSelector<T>(selector: (state: ActiveProjectState) => T): T {
  const store = useActiveProjectStore(false)!;
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function useSelectActiveGitRepository(): (repoId: string) => void {
  return useActiveProjectStore(false)!.selectRepo;
}
