import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { createGitStore, type GitStore, type GitStoreState } from "@/renderer/features/git/store/gitStore";
import { GitStoreController } from "@/renderer/features/git/store/gitStoreController";
import { GitOperationNotificationBridge } from "@/renderer/features/git/GitNotifications";
import { repositoryOwningPath } from "@/renderer/features/git/repositoryRoots";
import type { GitRuntime } from "@/runtime/git";
import type { GitRepositoryId } from "@/runtime/gitTypes";

import { useOptionalActiveProjectState } from "./ActiveProjectProvider";
import { useOptionalAgentSessionRuntime } from "./AgentSessionProvider";
import { useOptionalFileChanges } from "./FileChangeProvider";

interface GitContextValue {
  store: GitStore;
  controller: GitStoreController;
  runtime: GitRuntime;
}

const GitContext = createContext<GitContextValue | null>(null);

export function GitProvider({ children, runtime }: PropsWithChildren<{ runtime: GitRuntime }>) {
  const activeProject = useOptionalActiveProjectState();
  const agentRuntime = useOptionalAgentSessionRuntime();
  const fileChanges = useOptionalFileChanges();
  const subscribeAgentEvent = agentRuntime?.subscribeEvent;
  const bindGitRepositoryWatch = agentRuntime?.bindGitRepositoryWatch;
  const unbindGitRepositoryWatch = agentRuntime?.unbindGitRepositoryWatch;
  const boundGitRepositoryIdsRef = useRef(new Set<string>());
  const value = useMemo<GitContextValue>(() => {
    let storage: Storage | null = null;
    try {
      storage = typeof window === "undefined" ? null : window.localStorage;
    } catch {
      storage = null;
    }
    const store = createGitStore({ storage });
    return { store, controller: new GitStoreController(store, runtime), runtime };
  }, [runtime]);

  const workspaceId = activeProject && activeProject.status !== "none" ? activeProject.workspaceId : null;
  const projectRoot = activeProject && activeProject.status !== "none" ? activeProject.projectPath : null;

  useEffect(() => {
    if (!workspaceId || !projectRoot) {
      value.store.getState().clearActiveProject();
      return;
    }
    let disposed = false;
    void value.controller.activateProject({ workspaceId, projectRoot }).then(() => {
      if (disposed || !bindGitRepositoryWatch) return;
      const project = value.store.getState().projects[workspaceId];
      if (!project || project.projectRoot !== projectRoot) return;
      for (const repositoryId of project.repositoryIds) {
        bindGitRepositoryWatch(workspaceId, projectRoot, repositoryId);
        boundGitRepositoryIdsRef.current.add(repositoryId);
      }
    });
    return () => {
      disposed = true;
      if (!unbindGitRepositoryWatch) return;
      for (const repositoryId of boundGitRepositoryIdsRef.current) {
        unbindGitRepositoryWatch(repositoryId);
      }
      boundGitRepositoryIdsRef.current.clear();
    };
  }, [bindGitRepositoryWatch, projectRoot, unbindGitRepositoryWatch, value, workspaceId]);

  useEffect(() => {
    if (!subscribeAgentEvent) return;
    return subscribeAgentEvent((event) => {
      if (event.action === "gitMetadataChanged") {
        value.runtime.acceptEvent(event.action, event.data);
        const domains = Array.isArray(event.data.domains) ? event.data.domains.map(String) : [];
        if (domains.includes("repositories")) {
          const repositoryId = String(event.data.repository_id ?? "");
          const repository = value.store.getState().repositories[repositoryId];
          const project = repository
            ? value.store.getState().projects[repository.workspaceId]
            : null;
          if (project && value.store.getState().activeWorkspaceId === project.workspaceId) {
            const previousIds = [...project.repositoryIds];
            void value.controller.activateProject({
              workspaceId: project.workspaceId,
              projectRoot: project.projectRoot,
            }).then(() => {
              const refreshed = value.store.getState().projects[project.workspaceId];
              if (!refreshed || refreshed.projectRoot !== project.projectRoot) return;
              for (const removedId of previousIds.filter((id) => !refreshed.repositoryIds.includes(id))) {
                unbindGitRepositoryWatch?.(removedId);
                boundGitRepositoryIdsRef.current.delete(removedId);
              }
              for (const addedId of refreshed.repositoryIds) {
                if (boundGitRepositoryIdsRef.current.has(addedId)) continue;
                bindGitRepositoryWatch?.(project.workspaceId, project.projectRoot, addedId);
                boundGitRepositoryIdsRef.current.add(addedId);
              }
            });
          }
        }
        return;
      }
      if (event.action === "gitRepositoryWatchBound" && event.data.resync_required === true) {
        const repositoryId = String(event.data.repository_id ?? "") as GitRepositoryId;
        if (repositoryId) value.controller.handleRepositoryWatchResync(repositoryId);
      }
    });
  }, [bindGitRepositoryWatch, subscribeAgentEvent, unbindGitRepositoryWatch, value]);

  useEffect(() => {
    if (!fileChanges || !workspaceId || !projectRoot) return;
    return fileChanges.subscribeWorkspace(workspaceId, (notification) => {
      const state = value.store.getState();
      const project = state.projects[workspaceId];
      if (!project || project.projectRoot !== projectRoot) return;
      if (notification.resyncRequired) {
        value.controller.handleExternalWorktreeChanges(project.repositoryIds);
        return;
      }
      const roots = project.repositoryIds
        .map((repositoryId) => state.repositories[repositoryId])
        .filter((repository) => Boolean(repository))
        .map((repository) => ({
          id: repository.id,
          rootPath: repository.rootPath,
          displayPath: repository.displayPath,
          kind: repository.kind,
          parentRepoId: repository.parentRepoId ?? undefined,
        }));
      const worktreePathChanges = notification.changes.flatMap((change) => {
        const absolutePath = absoluteWorkspacePath(projectRoot, change.path);
        const owner = repositoryOwningPath(roots, absolutePath);
        const path = owner ? repositoryRelativePath(owner.rootPath, absolutePath) : null;
        return owner && path ? [{ repositoryId: owner.id as GitRepositoryId, path }] : [];
      });
      void value.controller.handleExternalWorktreePaths(worktreePathChanges);
    });
  }, [fileChanges, projectRoot, value, workspaceId]);

  useEffect(() => () => value.controller.dispose(), [value]);

  return (
    <GitContext.Provider value={value}>
      <GitOperationNotificationBridge store={value.store} />
      {children}
    </GitContext.Provider>
  );
}

export function useOptionalGitStore(): GitStore | null {
  return useContext(GitContext)?.store ?? null;
}

export function useGitStore(): GitStore {
  const store = useOptionalGitStore();
  if (!store) throw new Error("GitProvider is missing");
  return store;
}

export function useOptionalGitController(): GitStoreController | null {
  return useContext(GitContext)?.controller ?? null;
}

export function useOptionalGitRuntime(): GitRuntime | null {
  return useContext(GitContext)?.runtime ?? null;
}

export function useOptionalGitStoreSelector<T>(selector: (state: GitStoreState) => T): T | null {
  const store = useOptionalGitStore();
  const cacheRef = useRef<{ state: GitStoreState; selector: typeof selector; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    if (!store) return null;
    const state = store.getState();
    const cached = cacheRef.current;
    if (cached?.state === state && cached.selector === selector) return cached.value;
    const value = selector(state);
    cacheRef.current = { state, selector, value };
    return value;
  }, [selector, store]);
  return useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    getSnapshot,
    getSnapshot,
  );
}

function emptySubscribe(): () => void {
  return () => undefined;
}

function absoluteWorkspacePath(projectRoot: string, path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/")) return path;
  return `${projectRoot.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

function repositoryRelativePath(repositoryRoot: string, path: string): string | null {
  const root = repositoryRoot.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  const candidate = path.trim().replaceAll("\\", "/");
  const caseInsensitive = /^[A-Za-z]:\//.test(root);
  const comparableRoot = caseInsensitive ? root.toLocaleLowerCase() : root;
  const comparableCandidate = caseInsensitive ? candidate.toLocaleLowerCase() : candidate;
  if (!comparableCandidate.startsWith(`${comparableRoot}/`)) return null;
  return candidate.slice(root.length + 1).replace(/^\/+/, "") || null;
}
