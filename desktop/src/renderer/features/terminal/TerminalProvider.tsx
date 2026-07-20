import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from "react";
import { useStore } from "zustand";

import {
  isTerminalRuntimeAvailable,
  terminalRuntime,
  TerminalRuntimeError,
  type TerminalAttachment,
  type TerminalProfileSnapshot,
  type TerminalRuntime,
  type TerminalRuntimeEvent,
  type TerminalSnapshot,
} from "@/runtime";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import {
  createLifecycleEventGate,
  subscribeLifecycleEvents,
} from "@/renderer/events/lifecycleEvents";
import {
  useTerminalSessionScope,
  type ActiveTerminalSessionScope,
} from "@/renderer/providers/TerminalSessionScopeProvider";

import { createTerminalStore, type TerminalStore, type TerminalStoreState } from "./terminalStore";

const TERMINAL_ERROR_COOLDOWN_MS = 3000;

export interface TerminalContextValue {
  available: boolean;
  store: TerminalStore;
  runtime: TerminalRuntime;
  scope: ActiveTerminalSessionScope;
  createTerminal(profile?: TerminalProfileSnapshot["id"]): Promise<TerminalSnapshot | null>;
  attachTerminal(
    terminalId: string,
    onEvent: (event: TerminalRuntimeEvent) => void,
  ): Promise<TerminalAttachment>;
  closeTerminal(terminalId: string): Promise<boolean>;
  killTerminal(terminalId: string): Promise<boolean>;
  renameTerminal(terminalId: string, title: string): Promise<boolean>;
  writeTerminal(terminalId: string, data: string | Uint8Array): Promise<boolean>;
  resizeTerminal(
    terminalId: string,
    size: { cols: number; rows: number; pixelWidth?: number; pixelHeight?: number },
  ): Promise<boolean>;
  closeSession(sessionId: string, notify?: boolean): Promise<number>;
  refreshSession(sessionId?: string): Promise<void>;
}

export interface TerminalProviderProps extends PropsWithChildren {
  runtimeAvailable?: boolean;
  runtime?: TerminalRuntime;
  store?: TerminalStore;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function TerminalProvider({
  children,
  runtimeAvailable,
  runtime = terminalRuntime,
  store: injectedStore,
}: TerminalProviderProps) {
  const available = runtimeAvailable ?? (runtime !== terminalRuntime || isTerminalRuntimeAvailable());
  const storeRef = useRef<TerminalStore | null>(null);
  if (!storeRef.current) storeRef.current = injectedStore ?? createTerminalStore();
  const store = storeRef.current;
  const scope = useTerminalSessionScope();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const notifications = useNotifications();
  const refreshGenerationRef = useRef(0);
  const errorCooldownRef = useRef(new Map<string, number>());

  const reportError = useCallback(
    (reason: unknown, terminalId = "global") => {
      const error =
        reason instanceof TerminalRuntimeError
          ? reason
          : new TerminalRuntimeError("terminal_internal", reason instanceof Error ? reason.message : "终端操作失败");
      const key = `${error.code}:${terminalId}`;
      const now = Date.now();
      if (now - (errorCooldownRef.current.get(key) ?? 0) < TERMINAL_ERROR_COOLDOWN_MS) return;
      errorCooldownRef.current.set(key, now);
      notifications.error(terminalErrorMessage(error));
    },
    [notifications],
  );

  useEffect(() => {
    const state = store.getState();
    if (!available) {
      state.setProfiles([]);
      state.setProfilesLoading(false);
      return;
    }
    state.setProfilesLoading(true);
    let active = true;
    void runtime
      .listProfiles()
      .then((profiles) => {
        if (active) {
          const state = store.getState();
          state.setProfiles(profiles);
          if (!profiles.some((profile) => profile.id === state.ui.defaultProfile && profile.available)) {
            const fallback = profiles.find((profile) => profile.available);
            if (fallback) store.getState().setDefaultProfile(fallback.id);
          }
        }
      })
      .catch((error) => {
        if (active) reportError(error, "profiles");
      })
      .finally(() => {
        if (active) store.getState().setProfilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [available, reportError, runtime, store]);

  const refreshSession = useCallback(
    async (requestedSessionId?: string) => {
      if (!available) return;
      const sessionId = requestedSessionId ?? scopeRef.current.sessionId;
      if (!sessionId) return;
      const generation = ++refreshGenerationRef.current;
      try {
        const snapshots = await runtime.list(sessionId);
        if (
          generation !== refreshGenerationRef.current ||
          (!requestedSessionId && scopeRef.current.sessionId !== sessionId)
        ) {
          return;
        }
        store.getState().hydrateSession(sessionId, snapshots);
      } catch (error) {
        reportError(error, `session:${sessionId}`);
      }
    },
    [available, reportError, runtime, store],
  );

  useEffect(() => {
    if (!scope.sessionId || scope.loading) return;
    store.getState().setSessionWorkspace(scope.sessionId, scope.workspaceId);
    if (!available) return;
    void refreshSession(scope.sessionId);
  }, [available, refreshSession, scope.loading, scope.sessionId, scope.workspaceId, store]);

  const createTerminal = useCallback(
    async (requestedProfile?: TerminalProfileSnapshot["id"]) => {
      if (!available) {
        notifications.info("内置终端仅在 Keydex 桌面客户端中可用");
        return null;
      }
      const currentScope = scopeRef.current;
      if (!currentScope.sessionId || currentScope.loading) {
        notifications.info("请先打开一个可用会话，再创建终端");
        return null;
      }
      const state = store.getState();
      const profile = chooseAvailableProfile(state, requestedProfile);
      if (!profile) {
        notifications.warning("当前电脑没有可用的终端配置");
        return null;
      }
      const busyKey = `create:${currentScope.sessionId}`;
      state.setBusy(busyKey, true);
      try {
        const snapshot = await runtime.create({
          sessionId: currentScope.sessionId,
          cwd: currentScope.initialCwd,
          profile,
          cols: 80,
          rows: 24,
        });
        if (scopeRef.current.sessionId !== currentScope.sessionId) {
          await refreshSession(currentScope.sessionId);
          return snapshot;
        }
        store.getState().upsertSnapshot(snapshot, { activate: true });
        store.getState().setDockOpen(true);
        return snapshot;
      } catch (error) {
        reportError(error, `session:${currentScope.sessionId}`);
        return null;
      } finally {
        store.getState().setBusy(busyKey, false);
      }
    },
    [available, notifications, refreshSession, reportError, runtime, store],
  );

  const attachTerminal = useCallback(
    async (terminalId: string, onEvent: (event: TerminalRuntimeEvent) => void) => {
      if (!available) {
        throw new TerminalRuntimeError("terminal_runtime_unavailable", "内置终端仅在 Keydex 桌面客户端中可用");
      }
      const state = store.getState();
      const snapshot = state.snapshotsById[terminalId];
      const cursor = snapshot
        ? state.sessionsById[snapshot.sessionId]?.cursorByTerminalId[terminalId] ?? 0
        : 0;
      state.setAttachState(terminalId, "attaching");
      const attachment = await runtime.attach(terminalId, {
        afterSeq: cursor,
        onEvent: (event) => {
          applyTerminalEvent(store, event, onEvent, reportError);
        },
        onError: (error) => reportError(error, terminalId),
      });
      store.getState().upsertSnapshot(attachment.snapshot);
      for (const event of attachment.replay) {
        applyTerminalEvent(store, event, onEvent, reportError);
      }
      store.getState().setAttachState(terminalId, "live");
      return attachment;
    },
    [available, reportError, runtime, store],
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      if (!available) return false;
      try {
        await runtime.close(terminalId);
        store.getState().removeTerminal(terminalId);
        notifications.success("终端已关闭");
        return true;
      } catch (error) {
        reportError(error, terminalId);
        return false;
      }
    },
    [available, notifications, reportError, runtime, store],
  );

  const killTerminal = useCallback(
    async (terminalId: string) => {
      if (!available) return false;
      try {
        await runtime.kill(terminalId);
        return true;
      } catch (error) {
        reportError(error, terminalId);
        return false;
      }
    },
    [available, reportError, runtime],
  );

  const renameTerminal = useCallback(
    async (terminalId: string, rawTitle: string) => {
      if (!available) return false;
      const title = rawTitle.trim();
      if (!title || [...title].length > 80) {
        notifications.warning("终端名称需要包含 1 到 80 个字符");
        return false;
      }
      try {
        const snapshot = await runtime.rename(terminalId, title);
        store.getState().upsertSnapshot(snapshot);
        return true;
      } catch (error) {
        reportError(error, terminalId);
        return false;
      }
    },
    [available, notifications, reportError, runtime, store],
  );

  const writeTerminal = useCallback(
    async (terminalId: string, data: string | Uint8Array) => {
      if (!available) return false;
      try {
        await runtime.write(terminalId, data);
        return true;
      } catch (error) {
        reportError(error, terminalId);
        return false;
      }
    },
    [available, reportError, runtime],
  );

  const resizeTerminal = useCallback(
    async (
      terminalId: string,
      size: { cols: number; rows: number; pixelWidth?: number; pixelHeight?: number },
    ) => {
      if (!available) return false;
      try {
        await runtime.resize(terminalId, size);
        return true;
      } catch (error) {
        reportError(error, terminalId);
        return false;
      }
    },
    [available, reportError, runtime],
  );

  const closeSession = useCallback(
    async (sessionId: string, notify = true) => {
      if (!available) return 0;
      try {
        const count = await runtime.closeSession(sessionId);
        store.getState().clearSession(sessionId);
        if (notify && count > 0) notifications.info(`已清理 ${count} 个会话终端`);
        return count;
      } catch (error) {
        reportError(error, `session:${sessionId}`);
        return 0;
      }
    },
    [available, notifications, reportError, runtime, store],
  );

  useEffect(() => {
    if (!available) return;
    const acceptLifecycleEvent = createLifecycleEventGate();
    return subscribeLifecycleEvents((event) => {
      if (!acceptLifecycleEvent(event)) return;
      if ((event.type === "session_archived" || event.type === "session_purged") && event.session_id) {
        void closeSession(event.session_id);
        return;
      }
      if (event.type !== "workspace_sessions_purged" || !event.workspace_id) return;
      const sessionIds = Object.entries(store.getState().sessionsById)
        .filter(([, session]) => session.workspaceId === event.workspace_id)
        .map(([sessionId]) => sessionId);
      if (sessionIds.length === 0) return;
      void Promise.all(sessionIds.map((sessionId) => closeSession(sessionId, false))).then((counts) => {
        const count = counts.reduce((total, current) => total + current, 0);
        if (count > 0) notifications.info(`已清理 ${count} 个项目会话终端`);
      });
    });
  }, [available, closeSession, notifications, store]);

  const value = useMemo<TerminalContextValue>(
    () => ({
      available,
      store,
      runtime,
      scope,
      createTerminal,
      attachTerminal,
      closeTerminal,
      killTerminal,
      renameTerminal,
      writeTerminal,
      resizeTerminal,
      closeSession,
      refreshSession,
    }),
    [
      available,
      attachTerminal,
      closeSession,
      closeTerminal,
      createTerminal,
      killTerminal,
      renameTerminal,
      resizeTerminal,
      refreshSession,
      runtime,
      scope,
      store,
      writeTerminal,
    ],
  );
  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("TerminalProvider is missing");
  return value;
}

export function useTerminalStore<T>(selector: (state: TerminalStoreState) => T): T {
  const { store } = useTerminal();
  return useStore(store, selector);
}

function chooseAvailableProfile(
  state: TerminalStoreState,
  requested?: TerminalProfileSnapshot["id"],
): TerminalProfileSnapshot["id"] | null {
  const preferred = requested ?? state.ui.defaultProfile;
  if (state.profiles.some((profile) => profile.id === preferred && profile.available)) return preferred;
  return state.profiles.find((profile) => profile.available)?.id ?? null;
}

function applyTerminalEvent(
  store: TerminalStore,
  event: TerminalRuntimeEvent,
  onEvent: (event: TerminalRuntimeEvent) => void,
  reportError: (reason: unknown, terminalId?: string) => void,
) {
  const state = store.getState();
  if (event.event === "output") {
    const acceptance = state.acceptOutput(event.terminalId, event.seq);
    if (acceptance === "duplicate") return;
    if (acceptance === "gap") {
      reportError(new TerminalRuntimeError("terminal_event_gap", "终端输出出现缺口"), event.terminalId);
    }
    onEvent(event);
    return;
  }
  if (event.event === "replayTruncated") {
    state.setAttachState(event.terminalId, "truncated");
    reportError(new TerminalRuntimeError("terminal_replay_truncated", "较早的终端输出已被截断"), event.terminalId);
  } else if (event.event === "exited") {
    state.updateTerminalStatus(event.terminalId, "exited", event.exitCode);
  } else {
    state.updateTerminalStatus(event.terminalId, "failed");
    reportError(new TerminalRuntimeError(event.code, event.message), event.terminalId);
  }
  onEvent(event);
}

function terminalErrorMessage(error: TerminalRuntimeError): string {
  switch (error.code) {
    case "terminal_session_limit_reached":
      return "当前会话已达到 8 个终端上限";
    case "terminal_global_limit_reached":
      return "Keydex 已达到 24 个终端上限";
    case "terminal_profile_unavailable":
      return "所选终端配置在当前电脑上不可用";
    case "terminal_cwd_invalid":
      return "终端初始目录无效";
    default:
      return error.message || "终端操作失败";
  }
}
