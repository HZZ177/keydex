import type { TerminalStoreState } from "./terminalStore";

export function selectTerminalSession(state: TerminalStoreState, sessionId: string | null) {
  return sessionId ? state.sessionsById[sessionId] ?? null : null;
}

export function selectActiveTerminal(state: TerminalStoreState, sessionId: string | null) {
  const session = selectTerminalSession(state, sessionId);
  return session?.activeTerminalId ? state.snapshotsById[session.activeTerminalId] ?? null : null;
}

export function selectSessionTerminals(state: TerminalStoreState, sessionId: string | null) {
  const session = selectTerminalSession(state, sessionId);
  return (session?.terminalIds ?? []).flatMap((id) => {
    const snapshot = state.snapshotsById[id];
    return snapshot ? [snapshot] : [];
  });
}

export function selectRunningTerminalCount(
  state: TerminalStoreState,
  sessionId: string | null,
): number {
  return selectSessionTerminals(state, sessionId).filter(
    (terminal) => terminal.status === "running",
  ).length;
}
