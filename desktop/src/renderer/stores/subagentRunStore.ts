import type { SubagentRunSnapshot } from "@/types/subagents";
import type { AgentActionEnvelope } from "@/types/protocol";
import {
  routeSubagentEvent,
  snapshotsFromSubagentEvent,
} from "@/renderer/stores/subagentEventRouting";


export interface SubagentRunsState {
  runsById: Record<string, SubagentRunSnapshot>;
  runIdsByParent: Record<string, string[]>;
  runIdsBySubagent: Record<string, string[]>;
  unreadRunIds: Record<string, true>;
}

export function createInitialSubagentRunsState(): SubagentRunsState {
  return {
    runsById: {},
    runIdsByParent: {},
    runIdsBySubagent: {},
    unreadRunIds: {},
  };
}

export function mergeSubagentRunSnapshot(
  state: SubagentRunsState,
  snapshot: SubagentRunSnapshot,
): SubagentRunsState {
  const existing = state.runsById[snapshot.run_id];
  if (existing) {
    assertStableRunIdentity(existing, snapshot);
    if (snapshot.version < existing.version) return state;
    if (snapshot.version === existing.version) {
      if (JSON.stringify(snapshot) === JSON.stringify(existing)) return state;
      throw new Error(`conflicting Sub-Agent snapshot for ${snapshot.run_id} version ${snapshot.version}`);
    }
    if (isTerminal(existing.state)) return state;
  }
  const next = cloneState(state);
  next.runsById[snapshot.run_id] = snapshot;
  next.runIdsByParent[snapshot.parent_session_id] = insertOrderedRunId(
    next.runIdsByParent[snapshot.parent_session_id],
    snapshot.run_id,
    next.runsById,
  );
  next.runIdsBySubagent[snapshot.subagent_id] = insertOrderedRunId(
    next.runIdsBySubagent[snapshot.subagent_id],
    snapshot.run_id,
    next.runsById,
  );
  return next;
}

export function replaceParentSubagentRuns(
  state: SubagentRunsState,
  parentSessionId: string,
  snapshots: SubagentRunSnapshot[],
): SubagentRunsState {
  const cleanedParentId = parentSessionId.trim();
  if (!cleanedParentId) return state;
  for (const snapshot of snapshots) {
    if (snapshot.parent_session_id !== cleanedParentId) {
      throw new Error("parent snapshot response contains a Run from another parent");
    }
  }
  const incomingRunIds = new Set(snapshots.map((snapshot) => snapshot.run_id));
  const removedRunIds = Object.values(state.runsById)
    .filter(
      (snapshot) =>
        snapshot.parent_session_id === cleanedParentId && !incomingRunIds.has(snapshot.run_id),
    )
    .map((snapshot) => snapshot.run_id);
  if (removedRunIds.length === 0) {
    return snapshots.reduce(
      (current, snapshot) => mergeSubagentRunSnapshot(current, snapshot),
      state,
    );
  }

  const removed = new Set(removedRunIds);
  const reconciled = cloneState(state);
  for (const runId of removed) {
    delete reconciled.runsById[runId];
    delete reconciled.unreadRunIds[runId];
  }
  reconciled.runIdsByParent[cleanedParentId] = (
    reconciled.runIdsByParent[cleanedParentId] ?? []
  ).filter((runId) => !removed.has(runId));
  for (const [subagentId, runIds] of Object.entries(reconciled.runIdsBySubagent)) {
    const retained = runIds.filter((runId) => !removed.has(runId));
    if (retained.length > 0) {
      reconciled.runIdsBySubagent[subagentId] = retained;
    } else {
      delete reconciled.runIdsBySubagent[subagentId];
    }
  }
  return snapshots.reduce(
    (current, snapshot) => mergeSubagentRunSnapshot(current, snapshot),
    reconciled,
  );
}

export function reduceSubagentRunEvent(
  state: SubagentRunsState,
  event: AgentActionEnvelope,
): SubagentRunsState {
  if (routeSubagentEvent(event) !== "runtime") return state;
  const snapshots = snapshotsFromSubagentEvent(event);
  if (event.action === "subagent_runs_snapshot") {
    const parentSessionId = String(event.data.session_id ?? "").trim();
    return replaceParentSubagentRuns(state, parentSessionId, snapshots);
  }
  const next = snapshots.reduce(
    (current, snapshot) => mergeSubagentRunSnapshot(current, snapshot),
    state,
  );
  if (event.action !== "subagent_run_updated") return next;
  const unread = snapshots.some((snapshot) => {
    const previous = state.runsById[snapshot.run_id];
    return !previous || snapshot.version > previous.version;
  });
  if (!unread) return next;
  const marked = cloneState(next);
  for (const snapshot of snapshots) marked.unreadRunIds[snapshot.run_id] = true;
  return marked;
}

export function markSubagentRunRead(state: SubagentRunsState, runId: string): SubagentRunsState {
  if (!state.unreadRunIds[runId]) return state;
  const next = cloneState(state);
  delete next.unreadRunIds[runId];
  return next;
}

export function selectSubagentRun(
  state: SubagentRunsState,
  runId: string,
): SubagentRunSnapshot | null {
  return state.runsById[runId] ?? null;
}

export function selectParentSubagentRuns(
  state: SubagentRunsState,
  parentSessionId: string,
): SubagentRunSnapshot[] {
  return (state.runIdsByParent[parentSessionId] ?? [])
    .map((runId) => state.runsById[runId])
    .filter((run): run is SubagentRunSnapshot => Boolean(run));
}

export function selectSubagentHistory(
  state: SubagentRunsState,
  subagentId: string,
): SubagentRunSnapshot[] {
  return (state.runIdsBySubagent[subagentId] ?? [])
    .map((runId) => state.runsById[runId])
    .filter((run): run is SubagentRunSnapshot => Boolean(run));
}

function cloneState(state: SubagentRunsState): SubagentRunsState {
  return {
    runsById: { ...state.runsById },
    runIdsByParent: Object.fromEntries(
      Object.entries(state.runIdsByParent).map(([key, value]) => [key, [...value]]),
    ),
    runIdsBySubagent: Object.fromEntries(
      Object.entries(state.runIdsBySubagent).map(([key, value]) => [key, [...value]]),
    ),
    unreadRunIds: { ...state.unreadRunIds },
  };
}

function insertOrderedRunId(
  current: string[] | undefined,
  runId: string,
  runsById: Record<string, SubagentRunSnapshot>,
): string[] {
  const ids = [...new Set([...(current ?? []), runId])];
  return ids.sort((leftId, rightId) => compareRuns(runsById[leftId], runsById[rightId]));
}

function compareRuns(left: SubagentRunSnapshot, right: SubagentRunSnapshot): number {
  return (
    left.parent_timeline_sequence - right.parent_timeline_sequence ||
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.run_id.localeCompare(right.run_id)
  );
}

function assertStableRunIdentity(
  previous: SubagentRunSnapshot,
  incoming: SubagentRunSnapshot,
): void {
  for (const key of [
    "subagent_id",
    "child_session_id",
    "parent_session_id",
    "parent_timeline_sequence",
    "role",
    "initiated_by",
  ] as const) {
    if (previous[key] !== incoming[key]) {
      throw new Error(`Sub-Agent Run identity changed for ${previous.run_id}: ${key}`);
    }
  }
}

function isTerminal(state: SubagentRunSnapshot["state"]): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(state);
}
