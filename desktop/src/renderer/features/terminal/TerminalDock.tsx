import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "@/renderer/components/dialog";
import {
  browserGeometryCoordinator,
  useBrowserSpatialOcclusion,
} from "@/renderer/features/browser/runtime";
import { useTheme } from "@/renderer/providers/ThemeProvider";
import type { TerminalSnapshot } from "@/runtime";

import { TerminalCompactSelector } from "./TerminalCompactSelector";
import { TerminalList } from "./TerminalList";
import { useTerminal, useTerminalStore } from "./TerminalProvider";
import { TerminalRenameDialog } from "./TerminalRenameDialog";
import { TerminalResizeHandle } from "./TerminalResizeHandle";
import { TerminalSurfacePool } from "./TerminalSurfacePool";
import { TerminalToolbar } from "./TerminalToolbar";
import { terminalXtermRegistry } from "./terminalXtermRegistry";
import type { TerminalXtermRegistry } from "./terminalXtermRegistry";
import styles from "./TerminalDock.module.css";

const COMPACT_DOCK_WIDTH = 960;

export function TerminalDock({ registry = terminalXtermRegistry }: { registry?: TerminalXtermRegistry } = {}) {
  const rootRef = useRef<HTMLElement>(null);
  const {
    available,
    scope,
    store,
    createTerminal,
    closeTerminal,
    closeSession,
    renameTerminal,
  } = useTerminal();
  const { theme } = useTheme();
  const ui = useTerminalStore((state) => state.ui);
  const profiles = useTerminalStore((state) => state.profiles);
  const profilesLoading = useTerminalStore((state) => state.profilesLoading);
  const session = useTerminalStore((state) => scope.sessionId ? state.sessionsById[scope.sessionId] ?? null : null);
  const snapshotsById = useTerminalStore((state) => state.snapshotsById);
  const creating = useTerminalStore((state) => Boolean(scope.sessionId && state.busyKeys[`create:${scope.sessionId}`]));
  const [compactByWidth, setCompactByWidth] = useState(false);
  const [pendingClose, setPendingClose] = useState<TerminalSnapshot | null>(null);
  const [renaming, setRenaming] = useState<TerminalSnapshot | null>(null);
  const [closing, setClosing] = useState(false);
  const [pendingCloseAll, setPendingCloseAll] = useState<{ sessionId: string; count: number } | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const autoCreateOpenKeyRef = useRef<string | null>(null);
  const autoCreatePendingRef = useRef(false);
  const terminals = useMemo(
    () => (session?.terminalIds ?? []).flatMap((terminalId) => {
      const snapshot = snapshotsById[terminalId];
      return snapshot ? [snapshot] : [];
    }),
    [session?.terminalIds, snapshotsById],
  );
  const activeTerminal = session?.activeTerminalId ? snapshotsById[session.activeTerminalId] ?? null : null;
  const compact = ui.listPresentation === "compact" || (ui.listPresentation === "auto" && compactByWidth);
  const scopeReady = Boolean(available && scope.sessionId && !scope.loading);
  useBrowserSpatialOcclusion(rootRef, ui.dockOpen, "terminal-dock", { observeResize: false });
  useLayoutEffect(() => {
    if (ui.dockOpen) browserGeometryCoordinator.syncAll();
  }, [ui.dockHeight, ui.dockOpen]);

  useEffect(() => registry.updateTheme(theme), [registry, theme]);
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setCompactByWidth((entry?.contentRect.width ?? element.clientWidth) < COMPACT_DOCK_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const shell = rootRef.current?.parentElement;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const availableHeight = shell.clientHeight > 0 ? shell.clientHeight : window.innerHeight;
      const maximum = Math.max(160, availableHeight * 0.7);
      const current = store.getState().ui.dockHeight;
      if (current > maximum) store.getState().setDockHeight(maximum);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [store]);
  useEffect(() => {
    const toggleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== "Backquote") return;
      if (isEditableTarget(event.target) && !isTerminalTarget(event.target)) return;
      event.preventDefault();
      if (!scopeReady) return;
      store.getState().setDockOpen(!store.getState().ui.dockOpen);
    };
    window.addEventListener("keydown", toggleShortcut);
    return () => window.removeEventListener("keydown", toggleShortcut);
  }, [scopeReady, store]);
  useEffect(() => {
    const sessionId = scope.sessionId;
    if (!ui.dockOpen || !sessionId) {
      autoCreateOpenKeyRef.current = null;
      autoCreatePendingRef.current = false;
      return;
    }
    if (autoCreateOpenKeyRef.current !== sessionId) {
      autoCreateOpenKeyRef.current = sessionId;
      autoCreatePendingRef.current = true;
    }
    if (
      !autoCreatePendingRef.current
      || !scopeReady
      || !session?.hydrated
      || profilesLoading
    ) {
      return;
    }
    autoCreatePendingRef.current = false;
    if (terminals.length > 0 || creating || !profiles.some((profile) => profile.available)) return;
    void createTerminal(ui.defaultProfile);
  }, [
    createTerminal,
    creating,
    profiles,
    profilesLoading,
    scope.sessionId,
    scopeReady,
    session?.hydrated,
    terminals.length,
    ui.defaultProfile,
    ui.dockOpen,
  ]);

  const collapse = () => {
    store.getState().setDockOpen(false);
    window.requestAnimationFrame(() => document.getElementById("terminal-content-action")?.focus());
  };
  const requestClose = useCallback((terminal: TerminalSnapshot) => {
    if (terminal.status === "running" || terminal.status === "starting" || terminal.status === "closing") {
      setPendingClose(terminal);
    } else {
      void closeTerminal(terminal.terminalId);
    }
  }, [closeTerminal]);
  const confirmClose = async () => {
    if (!pendingClose || closing) return;
    setClosing(true);
    const closed = await closeTerminal(pendingClose.terminalId);
    setClosing(false);
    if (closed) setPendingClose(null);
  };
  const confirmCloseAll = async () => {
    if (!pendingCloseAll || closingAll) return;
    const { sessionId } = pendingCloseAll;
    setClosingAll(true);
    await closeSession(sessionId);
    setClosingAll(false);
    if (!store.getState().sessionsById[sessionId]) setPendingCloseAll(null);
  };
  const maxHeight = useCallback(() => {
    const measuredHeight = rootRef.current?.parentElement?.clientHeight ?? 0;
    const shellHeight = measuredHeight > 0 ? measuredHeight : window.innerHeight;
    return Math.max(160, shellHeight * 0.7);
  }, []);
  const selectTerminal = (terminalId: string) => {
    if (scope.sessionId) store.getState().setActiveTerminal(scope.sessionId, terminalId);
  };

  return (
    <section ref={rootRef} className={styles.dock} data-open={ui.dockOpen ? "true" : "false"}
      data-compact={compact ? "true" : "false"} data-testid="terminal-dock" aria-label="终端面板"
      aria-hidden={!ui.dockOpen}>
      <TerminalResizeHandle height={ui.dockHeight} disabled={!ui.dockOpen} getMaxHeight={maxHeight}
        onResize={(height) => store.getState().setDockHeight(height)} />
      <div className={styles.dockHeader}>
        {compact ? (
          <TerminalCompactSelector terminals={terminals} activeTerminalId={session?.activeTerminalId ?? null}
            onSelect={selectTerminal} onClose={requestClose} />
        ) : <span className={styles.panelTitle}>终端</span>}
        <TerminalToolbar profiles={profiles} profilesLoading={profilesLoading} defaultProfile={ui.defaultProfile}
          activeTerminal={activeTerminal} creating={creating}
          onDefaultProfileChange={(profile) => store.getState().setDefaultProfile(profile)}
          onCreate={(profile) => void createTerminal(profile)}
          onRename={() => activeTerminal && setRenaming(activeTerminal)}
          onClose={() => activeTerminal && requestClose(activeTerminal)} onCollapse={collapse} />
      </div>
      <div className={styles.dockBody}>
        {!compact ? <TerminalList terminals={terminals} activeTerminalId={session?.activeTerminalId ?? null}
          closingAll={closingAll} onSelect={selectTerminal} onClose={requestClose}
          onCloseAll={() => scope.sessionId && setPendingCloseAll({ sessionId: scope.sessionId, count: terminals.length })} /> : null}
        <div className={styles.terminalStage}>
          {!scopeReady ? (
            <div className={styles.emptyState}>
              {!available
                ? "内置终端仅在 Keydex 桌面客户端中可用"
                : scope.loading
                  ? "正在准备终端上下文…"
                  : "打开会话后即可使用终端"}
            </div>
          ) : terminals.length === 0 ? (
            <div className={styles.emptyState}>
              <span>当前会话还没有终端</span>
              <button type="button" disabled={creating} onClick={() => void createTerminal(ui.defaultProfile)}>新建终端</button>
            </div>
          ) : null}
          <TerminalSurfacePool registry={registry} />
        </div>
      </div>
      {pendingClose ? (
        <ConfirmDialog title="关闭正在运行的终端？" description="该终端及其启动的子进程会被结束，此操作不可撤销。"
          preview={pendingClose.title} confirmLabel="关闭终端" confirmTone="danger" cancelDisabled={closing}
          confirmDisabled={closing} onCancel={() => !closing && setPendingClose(null)} onConfirm={() => void confirmClose()} />
      ) : null}
      {pendingCloseAll ? (
        <ConfirmDialog title="终止并关闭全部终端？"
          description="当前会话的全部终端及其启动的子进程都会被结束，此操作不可撤销。"
          preview={`${pendingCloseAll.count} 个终端`} confirmLabel="全部终止并关闭" confirmTone="danger"
          cancelDisabled={closingAll} confirmDisabled={closingAll}
          onCancel={() => !closingAll && setPendingCloseAll(null)} onConfirm={() => void confirmCloseAll()} />
      ) : null}
      {renaming ? (
        <TerminalRenameDialog terminal={snapshotsById[renaming.terminalId] ?? renaming}
          onCancel={() => setRenaming(null)} onRename={(title) => renameTerminal(renaming.terminalId, title)} />
      ) : null}
    </section>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-terminal-id]"));
}
