import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from "react";

import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import type {
  AgentActionEnvelope,
  FileChangeEventItem,
  LocalFileChangedData,
  LocalFileWatchBoundData,
  WorkspaceFilesChangedData,
  WorkspaceWatchBoundData,
} from "@/types/protocol";

export interface WorkspaceFileChangeNotification {
  workspaceId: string;
  sequence: number;
  resyncRequired: boolean;
  changes: FileChangeEventItem[];
}

export interface LocalFileChangeNotification {
  watchId: string;
  path: string;
  sequence: number;
  resyncRequired: boolean;
  changes: FileChangeEventItem[];
}

type WorkspaceListener = (notification: WorkspaceFileChangeNotification) => void;
type LocalFileListener = (notification: LocalFileChangeNotification) => void;

export interface FileChangeTransport {
  bindWorkspaceWatch(workspaceId: string): void;
  unbindWorkspaceWatch(workspaceId: string): void;
  bindLocalFileWatch(watchId: string, path: string): void;
  unbindLocalFileWatch(watchId: string): void;
  subscribeEvent(listener: (event: AgentActionEnvelope) => void): () => void;
}

export interface FileChangeContextValue {
  subscribeWorkspace(workspaceId: string, listener: WorkspaceListener): () => void;
  subscribeLocalFile(watchId: string, path: string, listener: LocalFileListener): () => void;
}

interface LocalSubscription {
  path: string;
  listeners: Set<LocalFileListener>;
}

const FileChangeContext = createContext<FileChangeContextValue | null>(null);

export function FileChangeProvider({
  children,
  transport,
}: PropsWithChildren<{ transport?: FileChangeTransport }>) {
  const agentRuntime = useOptionalAgentSessionRuntime();
  const resolvedTransport = transport ?? agentRuntime ?? null;
  if (!resolvedTransport) {
    throw new Error("FileChangeProvider 需要 AgentSessionProvider 或显式 transport");
  }

  const workspaceListenersRef = useRef(new Map<string, Set<WorkspaceListener>>());
  const localListenersRef = useRef(new Map<string, LocalSubscription>());
  const workspaceSequencesRef = useRef(new Map<string, number>());
  const localSequencesRef = useRef(new Map<string, number>());

  const subscribeWorkspace = useCallback<FileChangeContextValue["subscribeWorkspace"]>(
    (workspaceId, listener) => {
      const cleaned = workspaceId.trim();
      if (!cleaned) {
        return () => undefined;
      }
      let listeners = workspaceListenersRef.current.get(cleaned);
      if (!listeners) {
        listeners = new Set();
        workspaceListenersRef.current.set(cleaned, listeners);
        resolvedTransport.bindWorkspaceWatch(cleaned);
      }
      listeners.add(listener);
      return () => {
        const current = workspaceListenersRef.current.get(cleaned);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          workspaceListenersRef.current.delete(cleaned);
          workspaceSequencesRef.current.delete(cleaned);
          resolvedTransport.unbindWorkspaceWatch(cleaned);
        }
      };
    },
    [resolvedTransport],
  );

  const subscribeLocalFile = useCallback<FileChangeContextValue["subscribeLocalFile"]>(
    (watchId, path, listener) => {
      const cleanedWatchId = watchId.trim();
      const cleanedPath = path.trim();
      if (!cleanedWatchId || !cleanedPath) {
        return () => undefined;
      }
      let subscription = localListenersRef.current.get(cleanedWatchId);
      if (subscription && subscription.path !== cleanedPath) {
        throw new Error("同一 watch_id 不能绑定不同文件");
      }
      if (!subscription) {
        subscription = { path: cleanedPath, listeners: new Set() };
        localListenersRef.current.set(cleanedWatchId, subscription);
        resolvedTransport.bindLocalFileWatch(cleanedWatchId, cleanedPath);
      }
      subscription.listeners.add(listener);
      return () => {
        const current = localListenersRef.current.get(cleanedWatchId);
        if (!current) {
          return;
        }
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          localListenersRef.current.delete(cleanedWatchId);
          localSequencesRef.current.delete(cleanedWatchId);
          resolvedTransport.unbindLocalFileWatch(cleanedWatchId);
        }
      };
    },
    [resolvedTransport],
  );

  useEffect(
    () =>
      resolvedTransport.subscribeEvent((event) => {
        if (event.action === "workspaceWatchBound") {
          const data = event.data as unknown as WorkspaceWatchBoundData;
          workspaceSequencesRef.current.set(data.workspace_id, data.sequence);
          notifyWorkspace(workspaceListenersRef.current, {
            workspaceId: data.workspace_id,
            sequence: data.sequence,
            resyncRequired: true,
            changes: [],
          });
          return;
        }
        if (event.action === "workspaceFilesChanged") {
          const data = event.data as unknown as WorkspaceFilesChangedData;
          const previous = workspaceSequencesRef.current.get(data.workspace_id);
          const gap = previous !== undefined && data.sequence !== previous + 1;
          workspaceSequencesRef.current.set(data.workspace_id, data.sequence);
          notifyWorkspace(workspaceListenersRef.current, {
            workspaceId: data.workspace_id,
            sequence: data.sequence,
            resyncRequired: gap || data.resync_required,
            changes: gap || data.resync_required ? [] : data.changes,
          });
          return;
        }
        if (event.action === "workspaceWatchUnbound") {
          const workspaceId = String(event.data.workspace_id ?? "");
          workspaceSequencesRef.current.delete(workspaceId);
          return;
        }
        if (event.action === "localFileWatchBound") {
          const data = event.data as unknown as LocalFileWatchBoundData;
          localSequencesRef.current.set(data.watch_id, data.sequence);
          notifyLocal(localListenersRef.current, {
            watchId: data.watch_id,
            path: data.path,
            sequence: data.sequence,
            resyncRequired: true,
            changes: [],
          });
          return;
        }
        if (event.action === "localFileChanged") {
          const data = event.data as unknown as LocalFileChangedData;
          const previous = localSequencesRef.current.get(data.watch_id);
          const gap = previous !== undefined && data.sequence !== previous + 1;
          localSequencesRef.current.set(data.watch_id, data.sequence);
          notifyLocal(localListenersRef.current, {
            watchId: data.watch_id,
            path: data.path,
            sequence: data.sequence,
            resyncRequired: gap || data.resync_required,
            changes: gap || data.resync_required ? [] : data.changes,
          });
          return;
        }
        if (event.action === "localFileWatchUnbound") {
          localSequencesRef.current.delete(String(event.data.watch_id ?? ""));
        }
      }),
    [resolvedTransport],
  );

  useEffect(
    () => () => {
      for (const workspaceId of workspaceListenersRef.current.keys()) {
        resolvedTransport.unbindWorkspaceWatch(workspaceId);
      }
      for (const watchId of localListenersRef.current.keys()) {
        resolvedTransport.unbindLocalFileWatch(watchId);
      }
      workspaceListenersRef.current.clear();
      localListenersRef.current.clear();
      workspaceSequencesRef.current.clear();
      localSequencesRef.current.clear();
    },
    [resolvedTransport],
  );

  const value = useMemo<FileChangeContextValue>(
    () => ({ subscribeWorkspace, subscribeLocalFile }),
    [subscribeLocalFile, subscribeWorkspace],
  );
  return <FileChangeContext.Provider value={value}>{children}</FileChangeContext.Provider>;
}

export function useFileChanges(): FileChangeContextValue {
  const value = useContext(FileChangeContext);
  if (!value) {
    throw new Error("useFileChanges 必须在 FileChangeProvider 内使用");
  }
  return value;
}

export function useOptionalFileChanges(): FileChangeContextValue | null {
  return useContext(FileChangeContext);
}

export function useWorkspaceFileWatchScope(workspaceId?: string | null): void {
  const fileChanges = useOptionalFileChanges();
  useEffect(() => {
    const cleaned = workspaceId?.trim() ?? "";
    if (!fileChanges || !cleaned) {
      return;
    }
    return fileChanges.subscribeWorkspace(cleaned, () => undefined);
  }, [fileChanges, workspaceId]);
}

function notifyWorkspace(
  subscriptions: Map<string, Set<WorkspaceListener>>,
  notification: WorkspaceFileChangeNotification,
) {
  for (const listener of subscriptions.get(notification.workspaceId) ?? []) {
    listener(notification);
  }
}

function notifyLocal(
  subscriptions: Map<string, LocalSubscription>,
  notification: LocalFileChangeNotification,
) {
  for (const listener of subscriptions.get(notification.watchId)?.listeners ?? []) {
    listener(notification);
  }
}
