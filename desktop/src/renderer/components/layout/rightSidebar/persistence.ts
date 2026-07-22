import {
  isRuntimeHttpError,
  type RightSidebarPromotionResponse,
  type RightSidebarScopeRecord,
  type RightSidebarScopeRef,
  type RuntimeBridge,
} from "@/runtime";

import { rightSidebarDefinitionRegistry } from "../rightSidebarRegistry";
import {
  emptyRightSidebarScopeStateV2,
  type RightSidebarPanelState,
  type RightSidebarScopeStateV2,
} from "./types";

const SAVE_DEBOUNCE_MS = 180;

export interface LoadedRightSidebarScope {
  exists: boolean;
  revision: number;
  state: RightSidebarScopeStateV2;
}

interface ScopeEntry extends LoadedRightSidebarScope {
  loaded: boolean;
  loadPromise: Promise<LoadedRightSidebarScope> | null;
  pending: RightSidebarScopeStateV2 | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

let persistenceByRuntime = new WeakMap<RuntimeBridge, RightSidebarScopePersistence>();

export function resetRightSidebarPersistenceForTests(): void {
  persistenceByRuntime = new WeakMap<RuntimeBridge, RightSidebarScopePersistence>();
}

export function rightSidebarPersistenceForRuntime(
  runtime: RuntimeBridge,
): RightSidebarScopePersistence {
  const current = persistenceByRuntime.get(runtime);
  if (current) return current;
  const created = new RightSidebarScopePersistence(runtime);
  persistenceByRuntime.set(runtime, created);
  return created;
}

export class RightSidebarScopePersistence {
  private readonly entries = new Map<string, ScopeEntry>();

  constructor(private readonly runtime: RuntimeBridge) {}

  async load(scopeKey: string): Promise<LoadedRightSidebarScope> {
    const entry = this.entry(scopeKey);
    if (entry.loaded) return snapshot(entry);
    if (entry.loadPromise) return entry.loadPromise;
    const scope = parseRightSidebarScopeKey(scopeKey);
    entry.loadPromise = this.runtime.rightSidebar
      .get(scope)
      .then((record) => {
        if (record) return this.acceptRecord(scopeKey, record);
        entry.loaded = true;
        return snapshot(entry);
      })
      .catch((reason: unknown) => {
        if (isRuntimeHttpError(reason) && reason.status === 404) {
          entry.loaded = true;
          return snapshot(entry);
        }
        throw reason;
      })
      .finally(() => {
        entry.loadPromise = null;
      });
    return entry.loadPromise;
  }

  queueSave(scopeKey: string, state: RightSidebarScopeStateV2): void {
    const entry = this.entry(scopeKey);
    const serialized = serializePersistableRightSidebarState(state);
    if (sameScopeState(serialized, entry.pending ?? entry.state)) return;
    entry.pending = serialized;
    this.scheduleSave(scopeKey, entry);
  }

  async flush(scopeKey: string): Promise<LoadedRightSidebarScope> {
    const entry = this.entry(scopeKey);
    if (entry.saveTimer) {
      clearTimeout(entry.saveTimer);
      entry.saveTimer = null;
    }
    await this.load(scopeKey);
    const local = entry.pending;
    if (!local || sameScopeState(local, entry.state)) {
      entry.pending = null;
      return snapshot(entry);
    }
    return this.saveWithConflictRecovery(scopeKey, local);
  }

  async promote(
    sourceScopeKey: string,
    targetSessionId: string,
  ): Promise<RightSidebarPromotionResponse<unknown> | null> {
    const targetId = targetSessionId.trim();
    if (!targetId) throw new Error("Promotion target session id is required");
    const source = parseRightSidebarScopeKey(sourceScopeKey);
    if (source.kind === "session") {
      if (source.id === targetId) return null;
      throw new Error("Only workspace/global right sidebar scopes can be promoted");
    }
    const savedSource = await this.flush(sourceScopeKey);
    if (!savedSource.exists || savedSource.revision < 1) return null;

    const response = await this.runtime.rightSidebar.promote({
      source_scope_kind: source.kind,
      source_scope_id: source.id,
      source_revision: savedSource.revision,
      target_session_id: targetId,
    });
    this.acceptRecord(`session:${targetId}`, response.target);
    this.replaceEntry(sourceScopeKey, emptyRightSidebarScopeStateV2(), 0, false);
    return response;
  }

  private async saveWithConflictRecovery(
    scopeKey: string,
    requestedLocal: RightSidebarScopeStateV2,
  ): Promise<LoadedRightSidebarScope> {
    const entry = this.entry(scopeKey);
    const scope = parseRightSidebarScopeKey(scopeKey);
    const base = entry.state;
    let local = requestedLocal;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const record = await this.runtime.rightSidebar.put(scope, local, entry.revision);
        const loaded = this.acceptRecord(scopeKey, record);
        if (entry.pending && sameScopeState(entry.pending, local)) {
          entry.pending = null;
          if (entry.saveTimer) clearTimeout(entry.saveTimer);
          entry.saveTimer = null;
        } else if (entry.pending && !entry.saveTimer) {
          this.scheduleSave(scopeKey, entry);
        }
        return loaded;
      } catch (reason: unknown) {
        if (!isRuntimeHttpError(reason) || reason.status !== 409 || attempt > 0) throw reason;
        const latest = await this.runtime.rightSidebar.get(scope);
        if (!latest) throw new Error("服务端右侧栏状态不存在");
        const remote = normalizePersistedRightSidebarState(latest.state);
        if (!remote) throw new Error("服务端右侧栏状态无法解析");
        entry.state = remote;
        entry.revision = latest.revision;
        entry.exists = true;
        local = mergeRightSidebarScopeConflict(base, local, remote);
        entry.pending = local;
      }
    }
    throw new Error("右侧栏状态冲突恢复失败");
  }

  private acceptRecord(
    scopeKey: string,
    record: RightSidebarScopeRecord<unknown>,
  ): LoadedRightSidebarScope {
    const normalized = normalizePersistedRightSidebarState(record.state);
    if (!normalized) throw new Error("服务端右侧栏状态版本不受支持");
    const entry = this.entry(scopeKey);
    entry.state = normalized;
    entry.revision = record.revision;
    entry.exists = true;
    entry.loaded = true;
    return snapshot(entry);
  }

  private replaceEntry(
    scopeKey: string,
    state: RightSidebarScopeStateV2,
    revision: number,
    exists: boolean,
  ): LoadedRightSidebarScope {
    const entry = this.entry(scopeKey);
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.state = state;
    entry.revision = revision;
    entry.exists = exists;
    entry.loaded = true;
    entry.pending = null;
    entry.saveTimer = null;
    return snapshot(entry);
  }

  private entry(scopeKey: string): ScopeEntry {
    const normalizedKey = formatRightSidebarScopeKey(parseRightSidebarScopeKey(scopeKey));
    const current = this.entries.get(normalizedKey);
    if (current) return current;
    const created: ScopeEntry = {
      exists: false,
      revision: 0,
      state: emptyRightSidebarScopeStateV2(),
      loaded: false,
      loadPromise: null,
      pending: null,
      saveTimer: null,
    };
    this.entries.set(normalizedKey, created);
    return created;
  }

  private scheduleSave(scopeKey: string, entry: ScopeEntry): void {
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null;
      void this.flush(scopeKey).catch((reason: unknown) => {
        console.error("[right-sidebar/persistence] 保存 scope 失败", safeErrorMessage(reason));
      });
    }, SAVE_DEBOUNCE_MS);
  }
}

export function parseRightSidebarScopeKey(scopeKey: string): RightSidebarScopeRef {
  const normalized = scopeKey.trim();
  if (normalized === "global") return { kind: "global", id: null };
  const separator = normalized.indexOf(":");
  const kind = normalized.slice(0, separator);
  const id = normalized.slice(separator + 1).trim();
  if ((kind !== "session" && kind !== "workspace") || !id) {
    throw new Error(`Invalid right sidebar scope key: ${scopeKey}`);
  }
  return { kind, id };
}

export function formatRightSidebarScopeKey(scope: RightSidebarScopeRef): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
}

export function persistableRightSidebarScopeKey(scopeKey: string): string | null {
  try {
    return formatRightSidebarScopeKey(parseRightSidebarScopeKey(scopeKey));
  } catch {
    return null;
  }
}

export function serializePersistableRightSidebarState(
  state: RightSidebarScopeStateV2,
): RightSidebarScopeStateV2 {
  const panels = Object.fromEntries(
    Object.entries(state.panels).filter(([, panel]) => {
      if (!rightSidebarDefinitionRegistry.getCapabilities(panel).persistable) return false;
      return panel.kind !== "browser" || panel.profileMode === "persistent";
    }),
  ) as Record<string, RightSidebarPanelState>;
  const panelOrder = state.panelOrder.filter((panelId) => panels[panelId]);
  const normalized = rightSidebarDefinitionRegistry.normalizeScopeState(
    {
      version: 2,
      activePanelId: state.activePanelId && panels[state.activePanelId]
        ? state.activePanelId
        : panelOrder[0] ?? null,
      panelOrder,
      panels,
      nextPanelSeq: state.nextPanelSeq,
    },
    { now: new Date().toISOString(), source: "persistence" },
  );
  return normalized ?? emptyRightSidebarScopeStateV2();
}

export function normalizePersistedRightSidebarState(
  raw: unknown,
): RightSidebarScopeStateV2 | null {
  return rightSidebarDefinitionRegistry.normalizeScopeState(raw, {
    now: new Date().toISOString(),
    source: "persistence",
  });
}

export function mergeRightSidebarScopeConflict(
  base: RightSidebarScopeStateV2,
  local: RightSidebarScopeStateV2,
  remote: RightSidebarScopeStateV2,
): RightSidebarScopeStateV2 {
  const selected = new Map<string, RightSidebarPanelState>();
  const panelIds = new Set([
    ...Object.keys(base.panels),
    ...Object.keys(local.panels),
    ...Object.keys(remote.panels),
  ]);
  for (const panelId of panelIds) {
    const basePanel = base.panels[panelId];
    const localPanel = local.panels[panelId];
    const remotePanel = remote.panels[panelId];
    if (basePanel && !localPanel) continue;
    if (!basePanel && !localPanel && remotePanel) {
      selected.set(panelId, remotePanel);
      continue;
    }
    if (!localPanel) continue;
    if (!basePanel) {
      selected.set(panelId, chooseNewerPanel(localPanel, remotePanel));
      continue;
    }
    const localChanged = !samePanel(localPanel, basePanel);
    const remoteChanged = remotePanel ? !samePanel(remotePanel, basePanel) : true;
    if (!localChanged) {
      if (remotePanel) selected.set(panelId, remotePanel);
    } else if (!remoteChanged || !remotePanel) {
      selected.set(panelId, localPanel);
    } else {
      selected.set(panelId, chooseNewerPanel(localPanel, remotePanel));
    }
  }

  const panels = Object.fromEntries(selected) as Record<string, RightSidebarPanelState>;
  const panelOrder = orderedSelectedPanelIds(panels, local.panelOrder, remote.panelOrder);
  const localActiveChanged = local.activePanelId !== base.activePanelId;
  const activePanelId = (
    localActiveChanged && local.activePanelId && panels[local.activePanelId]
      ? local.activePanelId
      : remote.activePanelId && panels[remote.activePanelId]
        ? remote.activePanelId
        : local.activePanelId && panels[local.activePanelId]
          ? local.activePanelId
          : panelOrder[0] ?? null
  );
  return {
    version: 2,
    activePanelId,
    panelOrder,
    panels,
    nextPanelSeq: Math.max(base.nextPanelSeq, local.nextPanelSeq, remote.nextPanelSeq),
  };
}

function chooseNewerPanel(
  local: RightSidebarPanelState,
  remote: RightSidebarPanelState | undefined,
): RightSidebarPanelState {
  if (!remote) return local;
  return remote.lastActivatedAt > local.lastActivatedAt ? remote : local;
}

function orderedSelectedPanelIds(
  panels: Record<string, RightSidebarPanelState>,
  ...orders: readonly string[][]
): string[] {
  const seen = new Set<string>();
  return [...orders.flat(), ...Object.keys(panels).sort()].filter((panelId) => {
    if (!panels[panelId] || seen.has(panelId)) return false;
    seen.add(panelId);
    return true;
  });
}

function samePanel(left: RightSidebarPanelState, right: RightSidebarPanelState): boolean {
  return JSON.stringify(rightSidebarDefinitionRegistry.serializePanel(left)) ===
    JSON.stringify(rightSidebarDefinitionRegistry.serializePanel(right));
}

function sameScopeState(left: RightSidebarScopeStateV2, right: RightSidebarScopeStateV2): boolean {
  return JSON.stringify(rightSidebarDefinitionRegistry.serializeScopeState(left)) ===
    JSON.stringify(rightSidebarDefinitionRegistry.serializeScopeState(right));
}

function snapshot(entry: ScopeEntry): LoadedRightSidebarScope {
  return { exists: entry.exists, revision: entry.revision, state: entry.state };
}

function safeErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "unknown_error";
}
