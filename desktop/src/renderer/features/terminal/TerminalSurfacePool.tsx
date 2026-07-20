import { useEffect, useMemo } from "react";

import { useTerminal, useTerminalStore } from "./TerminalProvider";
import { TerminalSurface } from "./TerminalSurface";
import { terminalXtermRegistry, type TerminalXtermRegistry } from "./terminalXtermRegistry";
import styles from "./TerminalSurface.module.css";

export function TerminalSurfacePool({
  registry = terminalXtermRegistry,
}: {
  registry?: TerminalXtermRegistry;
}) {
  const { scope } = useTerminal();
  const snapshotsById = useTerminalStore((state) => state.snapshotsById);
  const sessionsById = useTerminalStore((state) => state.sessionsById);
  const dockOpen = useTerminalStore((state) => state.ui.dockOpen);
  const allSnapshots = useMemo(
    () => Object.values(snapshotsById).sort((left, right) => left.createdAt - right.createdAt),
    [snapshotsById],
  );
  const activeTerminalId = scope.sessionId
    ? sessionsById[scope.sessionId]?.activeTerminalId ?? null
    : null;
  useEffect(() => {
    registry.disposeMissing(allSnapshots.map((snapshot) => snapshot.terminalId));
  }, [allSnapshots, registry]);
  return (
    <div className={styles.pool} data-testid="terminal-surface-pool">
      {allSnapshots.map((snapshot) => {
        const active = snapshot.terminalId === activeTerminalId;
        const visible = Boolean(dockOpen && active && snapshot.sessionId === scope.sessionId);
        return (
          <TerminalSurface
            key={snapshot.terminalId}
            snapshot={snapshot}
            active={active}
            visible={visible}
            registry={registry}
          />
        );
      })}
    </div>
  );
}

