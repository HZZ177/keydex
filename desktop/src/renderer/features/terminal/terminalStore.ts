import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  TerminalProfileSnapshot,
  TerminalSnapshot,
  TerminalStatus,
} from "@/runtime/terminalTypes";

export const TERMINAL_PREFERENCES_KEY = "keydex.terminal.preferences.v2";
const LEGACY_TERMINAL_PREFERENCES_KEY = "keydex.terminal.preferences.v1";
export const DEFAULT_TERMINAL_DOCK_HEIGHT = 320;
export const MIN_TERMINAL_DOCK_HEIGHT = 160;
export const DEFAULT_TERMINAL_PROFILE: TerminalProfileSnapshot["id"] = "powershell";

export type TerminalListPresentation = "list" | "compact" | "auto";
export type TerminalAttachState = "idle" | "attaching" | "live" | "gap" | "truncated";
export type TerminalOutputAcceptance = "accepted" | "duplicate" | "gap";

export interface TerminalSessionState {
  workspaceId: string | null;
  terminalIds: string[];
  activeTerminalId: string | null;
  hydrated: boolean;
  cursorByTerminalId: Record<string, number>;
  attachStateByTerminalId: Record<string, TerminalAttachState>;
}

export interface TerminalUiState {
  dockOpen: boolean;
  dockHeight: number;
  defaultProfile: TerminalProfileSnapshot["id"];
  listPresentation: TerminalListPresentation;
}

export interface TerminalStoreState {
  profiles: TerminalProfileSnapshot[];
  profilesLoading: boolean;
  snapshotsById: Record<string, TerminalSnapshot>;
  sessionsById: Record<string, TerminalSessionState>;
  busyKeys: Record<string, boolean>;
  ui: TerminalUiState;
  setProfiles(profiles: TerminalProfileSnapshot[]): void;
  setProfilesLoading(loading: boolean): void;
  hydrateSession(sessionId: string, snapshots: TerminalSnapshot[]): void;
  upsertSnapshot(snapshot: TerminalSnapshot, options?: { activate?: boolean }): void;
  updateTerminalStatus(terminalId: string, status: TerminalStatus, exitCode?: number | null): void;
  renameTerminal(terminalId: string, title: string): void;
  removeTerminal(terminalId: string): void;
  clearSession(sessionId: string): void;
  setSessionWorkspace(sessionId: string, workspaceId: string | null): void;
  setActiveTerminal(sessionId: string, terminalId: string | null): void;
  setBusy(key: string, busy: boolean): void;
  setDockOpen(open: boolean): void;
  setDockHeight(height: number): void;
  setDefaultProfile(profile: TerminalProfileSnapshot["id"]): void;
  setListPresentation(presentation: TerminalListPresentation): void;
  acceptOutput(terminalId: string, seq: number): TerminalOutputAcceptance;
  setAttachState(terminalId: string, state: TerminalAttachState): void;
}

export interface TerminalPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CreateTerminalStoreOptions {
  storage?: TerminalPreferenceStorage | null;
}

export type TerminalStore = StoreApi<TerminalStoreState>;

export function createTerminalStore(options: CreateTerminalStoreOptions = {}): TerminalStore {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const preferences = readTerminalPreferences(storage);
  const store = createStore<TerminalStoreState>()((set, get) => ({
    profiles: [],
    profilesLoading: false,
    snapshotsById: {},
    sessionsById: {},
    busyKeys: {},
    ui: {
      dockOpen: false,
      dockHeight: clampTerminalDockHeight(preferences.dockHeight ?? DEFAULT_TERMINAL_DOCK_HEIGHT),
      defaultProfile: preferences.defaultProfile ?? DEFAULT_TERMINAL_PROFILE,
      listPresentation: preferences.listPresentation ?? "auto",
    },

    setProfiles: (profiles) => set({ profiles: [...profiles] }),
    setProfilesLoading: (profilesLoading) => set({ profilesLoading }),

    hydrateSession: (sessionId, snapshots) =>
      set((state) => {
        const snapshotsById = { ...state.snapshotsById };
        for (const [terminalId, snapshot] of Object.entries(snapshotsById)) {
          if (snapshot.sessionId === sessionId) delete snapshotsById[terminalId];
        }
        for (const snapshot of snapshots) snapshotsById[snapshot.terminalId] = snapshot;
        const previous = state.sessionsById[sessionId];
        const terminalIds = snapshots.map((snapshot) => snapshot.terminalId);
        const activeTerminalId =
          previous?.activeTerminalId && terminalIds.includes(previous.activeTerminalId)
            ? previous.activeTerminalId
            : terminalIds[0] ?? null;
        return {
          snapshotsById,
          sessionsById: {
            ...state.sessionsById,
            [sessionId]: {
              workspaceId: previous?.workspaceId ?? null,
              terminalIds,
              activeTerminalId,
              hydrated: true,
              cursorByTerminalId: keepKeys(previous?.cursorByTerminalId ?? {}, terminalIds),
              attachStateByTerminalId: keepKeys(previous?.attachStateByTerminalId ?? {}, terminalIds),
            },
          },
        };
      }),

    upsertSnapshot: (snapshot, updateOptions) =>
      set((state) => {
        const session = state.sessionsById[snapshot.sessionId] ?? emptyTerminalSession();
        const terminalIds = session.terminalIds.includes(snapshot.terminalId)
          ? session.terminalIds
          : [...session.terminalIds, snapshot.terminalId];
        return {
          snapshotsById: { ...state.snapshotsById, [snapshot.terminalId]: snapshot },
          sessionsById: {
            ...state.sessionsById,
            [snapshot.sessionId]: {
              ...session,
              terminalIds,
              activeTerminalId:
                updateOptions?.activate || !session.activeTerminalId
                  ? snapshot.terminalId
                  : session.activeTerminalId,
            },
          },
        };
      }),

    updateTerminalStatus: (terminalId, status, exitCode = null) =>
      set((state) => {
        const snapshot = state.snapshotsById[terminalId];
        if (!snapshot) return state;
        return {
          snapshotsById: {
            ...state.snapshotsById,
            [terminalId]: { ...snapshot, status, exitCode, updatedAt: Date.now() },
          },
        };
      }),

    renameTerminal: (terminalId, title) =>
      set((state) => {
        const snapshot = state.snapshotsById[terminalId];
        if (!snapshot) return state;
        return {
          snapshotsById: {
            ...state.snapshotsById,
            [terminalId]: { ...snapshot, title, updatedAt: Date.now() },
          },
        };
      }),

    removeTerminal: (terminalId) =>
      set((state) => {
        const snapshot = state.snapshotsById[terminalId];
        if (!snapshot) return state;
        const snapshotsById = { ...state.snapshotsById };
        delete snapshotsById[terminalId];
        const session = state.sessionsById[snapshot.sessionId] ?? emptyTerminalSession();
        const previousIndex = session.terminalIds.indexOf(terminalId);
        const terminalIds = session.terminalIds.filter((id) => id !== terminalId);
        const activeTerminalId =
          session.activeTerminalId === terminalId
            ? terminalIds[Math.min(Math.max(previousIndex, 0), terminalIds.length - 1)] ?? null
            : session.activeTerminalId;
        const cursorByTerminalId = { ...session.cursorByTerminalId };
        const attachStateByTerminalId = { ...session.attachStateByTerminalId };
        delete cursorByTerminalId[terminalId];
        delete attachStateByTerminalId[terminalId];
        return {
          snapshotsById,
          sessionsById: {
            ...state.sessionsById,
            [snapshot.sessionId]: {
              workspaceId: session.workspaceId,
              terminalIds,
              activeTerminalId,
              hydrated: session.hydrated,
              cursorByTerminalId,
              attachStateByTerminalId,
            },
          },
        };
      }),

    clearSession: (sessionId) =>
      set((state) => {
        const snapshotsById = { ...state.snapshotsById };
        for (const terminalId of state.sessionsById[sessionId]?.terminalIds ?? []) {
          delete snapshotsById[terminalId];
        }
        const sessionsById = { ...state.sessionsById };
        delete sessionsById[sessionId];
        return { snapshotsById, sessionsById };
      }),

    setSessionWorkspace: (sessionId, workspaceId) =>
      set((state) => {
        const session = state.sessionsById[sessionId] ?? emptyTerminalSession();
        if (session.workspaceId === workspaceId) return state;
        return {
          sessionsById: {
            ...state.sessionsById,
            [sessionId]: { ...session, workspaceId },
          },
        };
      }),

    setActiveTerminal: (sessionId, terminalId) =>
      set((state) => {
        const session = state.sessionsById[sessionId] ?? emptyTerminalSession();
        if (terminalId && !session.terminalIds.includes(terminalId)) return state;
        return {
          sessionsById: {
            ...state.sessionsById,
            [sessionId]: { ...session, activeTerminalId: terminalId },
          },
        };
      }),

    setBusy: (key, busy) =>
      set((state) => {
        const busyKeys = { ...state.busyKeys };
        if (busy) busyKeys[key] = true;
        else delete busyKeys[key];
        return { busyKeys };
      }),
    setDockOpen: (dockOpen) => set((state) => ({ ui: { ...state.ui, dockOpen } })),
    setDockHeight: (dockHeight) =>
      set((state) => ({ ui: { ...state.ui, dockHeight: clampTerminalDockHeight(dockHeight) } })),
    setDefaultProfile: (defaultProfile) =>
      set((state) => ({ ui: { ...state.ui, defaultProfile } })),
    setListPresentation: (listPresentation) =>
      set((state) => ({ ui: { ...state.ui, listPresentation } })),

    acceptOutput: (terminalId, seq) => {
      const state = get();
      const snapshot = state.snapshotsById[terminalId];
      if (!snapshot) return "duplicate";
      const session = state.sessionsById[snapshot.sessionId] ?? emptyTerminalSession();
      const cursor = session.cursorByTerminalId[terminalId] ?? 0;
      if (seq <= cursor) return "duplicate";
      const result: TerminalOutputAcceptance = seq === cursor + 1 ? "accepted" : "gap";
      set({
        sessionsById: {
          ...state.sessionsById,
          [snapshot.sessionId]: {
            ...session,
            cursorByTerminalId: { ...session.cursorByTerminalId, [terminalId]: seq },
            attachStateByTerminalId: {
              ...session.attachStateByTerminalId,
              [terminalId]: result === "gap" ? "gap" : "live",
            },
          },
        },
      });
      return result;
    },

    setAttachState: (terminalId, attachState) =>
      set((state) => {
        const snapshot = state.snapshotsById[terminalId];
        if (!snapshot) return state;
        const session = state.sessionsById[snapshot.sessionId] ?? emptyTerminalSession();
        return {
          sessionsById: {
            ...state.sessionsById,
            [snapshot.sessionId]: {
              ...session,
              attachStateByTerminalId: {
                ...session.attachStateByTerminalId,
                [terminalId]: attachState,
              },
            },
          },
        };
      }),
  }));

  persistTerminalPreferences(store, storage);
  return store;
}

export function clampTerminalDockHeight(height: number, maxHeight = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(height)) return DEFAULT_TERMINAL_DOCK_HEIGHT;
  return Math.min(maxHeight, Math.max(MIN_TERMINAL_DOCK_HEIGHT, Math.round(height)));
}

function emptyTerminalSession(): TerminalSessionState {
  return {
    workspaceId: null,
    terminalIds: [],
    activeTerminalId: null,
    hydrated: false,
    cursorByTerminalId: {},
    attachStateByTerminalId: {},
  };
}

function keepKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const next: Record<string, T> = {};
  for (const key of keys) {
    if (key in record) next[key] = record[key] as T;
  }
  return next;
}

interface TerminalPreferences {
  dockHeight?: number;
  defaultProfile?: TerminalProfileSnapshot["id"];
  listPresentation?: TerminalListPresentation;
}

function readTerminalPreferences(storage: TerminalPreferenceStorage | null): TerminalPreferences {
  if (!storage) return {};
  try {
    const current = storage.getItem(TERMINAL_PREFERENCES_KEY);
    if (current) return parseTerminalPreferences(current);

    const legacy = storage.getItem(LEGACY_TERMINAL_PREFERENCES_KEY);
    if (!legacy) return {};
    const legacyPreferences = parseTerminalPreferences(legacy);
    const migratedPreferences: TerminalPreferences = {
      ...legacyPreferences,
      defaultProfile:
        legacyPreferences.defaultProfile === "git-bash"
          ? DEFAULT_TERMINAL_PROFILE
          : legacyPreferences.defaultProfile,
    };
    try {
      storage.setItem(TERMINAL_PREFERENCES_KEY, JSON.stringify(migratedPreferences));
    } catch {
      // The migrated preferences still apply for this launch when storage is read-only.
    }
    return migratedPreferences;
  } catch {
    return {};
  }
}

function parseTerminalPreferences(raw: string): TerminalPreferences {
  const value = JSON.parse(raw) as Record<string, unknown>;
  return {
    dockHeight: typeof value.dockHeight === "number" ? value.dockHeight : undefined,
    defaultProfile: isProfileId(value.defaultProfile) ? value.defaultProfile : undefined,
    listPresentation: isListPresentation(value.listPresentation) ? value.listPresentation : undefined,
  };
}

function persistTerminalPreferences(store: TerminalStore, storage: TerminalPreferenceStorage | null) {
  if (!storage) return;
  let previous = "";
  store.subscribe((state) => {
    const serialized = JSON.stringify({
      dockHeight: state.ui.dockHeight,
      defaultProfile: state.ui.defaultProfile,
      listPresentation: state.ui.listPresentation,
    });
    if (serialized === previous) return;
    previous = serialized;
    try {
      storage.setItem(TERMINAL_PREFERENCES_KEY, serialized);
    } catch {
      // Preference persistence must never break the live terminal.
    }
  });
}

function browserStorage(): TerminalPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isProfileId(value: unknown): value is TerminalProfileSnapshot["id"] {
  return value === "git-bash" || value === "powershell" || value === "cmd";
}

function isListPresentation(value: unknown): value is TerminalListPresentation {
  return value === "list" || value === "compact" || value === "auto";
}
