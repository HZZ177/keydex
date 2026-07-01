import {
  FileText,
  Folder,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import {
  MAX_RIGHT_SIDEBAR_RATIO,
  MIN_RIGHT_SIDEBAR_RATIO,
  SIDEBAR_COLLAPSED_WIDTH,
  clampRightSidebarRatio,
} from "@/renderer/hooks/layout/layoutStore";
import type { RightSidebarPlacement } from "@/renderer/hooks/layout/layoutStore";
import { useSidebarCollapseMotion } from "@/renderer/hooks/layout/useSidebarCollapseMotion";
import {
  useOptionalPreview,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { ConnectionStatus } from "@/renderer/components/runtime";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { AppMode } from "@/renderer/components/layout/appMode";
import {
  BTW_CONVERSATION_TITLE,
  createBtwConversationFromSession,
} from "@/renderer/pages/conversation/conversationForkSource";
import type { AgentSession } from "@/types/protocol";

import { RightSidebarResizeHandle } from "./RightSidebarResizeHandle";
import { RightSidebarInitialPage } from "./RightSidebarInitialPage";
import {
  RightSidebarConversationContext,
  useOptionalRightSidebarConversation,
  type OpenBtwConversationRequest,
  type OpenRightSidebarConversationRequest,
} from "./RightSidebarConversationContext";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { Sider } from "./Sider";
import { Titlebar } from "./Titlebar";
import { ProductShowcaseOverlay, type ProductShowcaseOverlayPhase } from "./ProductShowcaseOverlay";
import styles from "./Layout.module.css";
import type { SiderEntry } from "./Sider";
import type { WorkbenchWorkspaceSelectorProps } from "./workbenchWorkspaceSelector";

const LazyWorkspaceFileBrowser = lazy(() =>
  import("@/renderer/components/workspace/WorkspaceFileBrowser").then((module) => ({
    default: module.WorkspaceFileBrowser,
  })),
);
const LazyFilePreview = lazy(() =>
  import("@/renderer/components/workspace/FilePreview").then((module) => ({ default: module.FilePreview })),
);
const LazyConversationSessionSurface = lazy(() =>
  import("@/renderer/pages/conversation/ConversationSessionSurface").then((module) => ({
    default: module.ConversationSessionSurface,
  })),
);

const LEGACY_FILES_PANEL_ID = "right-sidebar:files";
const FILES_PANEL_ID_PREFIX = "right-sidebar:files:";
const INITIAL_PANEL_ID_PREFIX = "right-sidebar:initial:";
const CONVERSATION_PANEL_ID_PREFIX = "right-sidebar:conversation:";
const GLOBAL_RIGHT_SIDEBAR_SCOPE = "global";
const APP_MODE_SWITCH_NAVIGATION_DELAY_MS = 180;
const FULL_CONTENT_MIN_WIDTH = 420;
const RATIO_PRECISION = 1000;

interface RightSidebarFilePanelState {
  id: string;
  filePreviewPath: string | null;
  filePreviewRequestId: number;
  filePreviewRevealTarget: PreviewFileRevealTarget | null;
}

interface RightSidebarConversationPanelState {
  id: string;
  sessionId: string;
  title: string;
  sourceSessionId: string | null;
}

interface RightSidebarScopePanelState {
  activePanelId: string | null;
  panelOrder: string[];
  filePanelIds: string[];
  filePanels: Record<string, RightSidebarFilePanelState>;
  conversationPanelIds: string[];
  conversationPanels: Record<string, RightSidebarConversationPanelState>;
  initialPanelIds: string[];
  nextPanelSeq: number;
}

const EMPTY_RIGHT_SIDEBAR_SCOPE_STATE: RightSidebarScopePanelState = {
  activePanelId: null,
  panelOrder: [],
  filePanelIds: [],
  filePanels: {},
  conversationPanelIds: [],
  conversationPanels: {},
  initialPanelIds: [],
  nextPanelSeq: 0,
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown;
};

function roundSidebarRatio(ratio: number) {
  return Math.round(ratio * RATIO_PRECISION) / RATIO_PRECISION;
}

function maxRightSidebarRatioWithContentGuard(availableWidth: number, guardContentMinWidth: boolean) {
  if (!guardContentMinWidth || availableWidth <= 0) {
    return MAX_RIGHT_SIDEBAR_RATIO;
  }
  const maxRatioForContent = (availableWidth - FULL_CONTENT_MIN_WIDTH) / availableWidth;
  return roundSidebarRatio(
    Math.max(MIN_RIGHT_SIDEBAR_RATIO, Math.min(MAX_RIGHT_SIDEBAR_RATIO, maxRatioForContent)),
  );
}

function clampRightSidebarRatioForLayout(ratio: number, maxRatio: number) {
  return Math.min(maxRatio, clampRightSidebarRatio(ratio));
}

function initialShellWidth() {
  return typeof window === "undefined" ? 0 : Math.round(window.innerWidth);
}

function measureShellWidth(shell: HTMLElement | null) {
  const rectWidth = shell?.getBoundingClientRect().width ?? 0;
  return Math.round(rectWidth > 0 ? rectWidth : initialShellWidth());
}

function rightSidebarGeometryForShellWidth(
  shellWidth: number,
  activeSidebarWidth: number,
  ratio: number,
  guardContentMinWidth: boolean,
) {
  const availableWidth = Math.max(0, shellWidth - activeSidebarWidth);
  const maxRatio = maxRightSidebarRatioWithContentGuard(availableWidth, guardContentMinWidth);
  const effectiveRatio = clampRightSidebarRatioForLayout(ratio, maxRatio);
  return {
    availableWidth,
    maxRatio,
    ratio: effectiveRatio,
    width: Math.round(availableWidth * effectiveRatio),
  };
}

export interface LayoutProps extends PropsWithChildren {
  runtime?: RuntimeBridge;
  title?: string;
  appMode?: AppMode;
  modeSwitchTargets?: Partial<Record<AppMode, string>>;
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  activePath?: string;
  contentMode?: "reading" | "full";
  showChatBucket?: boolean;
  newConversationPath?: string;
  deleteActiveFallbackPath?: string;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  workbenchWorkspaceSelector?: WorkbenchWorkspaceSelectorProps;
  resetRightSidebarKey?: string;
  onNavigate?: (path: string) => void;
}

export function Layout({
  children,
  runtime = runtimeBridge,
  title = "Keydex",
  appMode = "agent",
  modeSwitchTargets,
  projects,
  conversations,
  activePath,
  contentMode = "reading",
  showChatBucket,
  newConversationPath,
  deleteActiveFallbackPath,
  getSessionPath,
  getWorkspaceNewConversationPath,
  workbenchWorkspaceSelector,
  resetRightSidebarKey,
  onNavigate,
}: LayoutProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const previewContext = useOptionalPreview();
  const lastPreviewOpenStampRef = useRef<string | null>(
    previewContext?.open ? previewOpenStamp(previewContext.activeEntry) : null,
  );
  const lastPreviewCollapseRequestRef = useRef(previewContext?.collapseRequestId ?? 0);
  const lastFilePanelOpenRequestRef = useRef(previewContext?.filePanelRequest?.requestId ?? 0);
  const lastPreviewScopeKeyRef = useRef<string | null>(previewContext?.activeScopeKey ?? null);
  const lastRightSidebarResetKeyRef = useRef<string | null>(null);
  const appModeNavigationTimerRef = useRef<number | null>(null);
  const shellWidthRef = useRef(initialShellWidth());
  const shellMeasureFrameRef = useRef<number | null>(null);
  const [rightSidebarMode, setRightSidebarMode] = useState<"split" | "maximized">("split");
  const [rightSidebarPanelStateByScope, setRightSidebarPanelStateByScope] = useState<Record<string, RightSidebarScopePanelState>>({});
  const [productShowcasePhase, setProductShowcasePhase] = useState<ProductShowcaseOverlayPhase | null>(null);
  const { state, actions } = useLayoutState();
  const runtimeConnection = useOptionalRuntimeConnection();
  const notifications = useNotifications();
  const collapsed = state.sidebarCollapsed;
  const globalRightSidebarEnabled = appMode !== "workbench";
  const { sidebarMotion, toggleSidebar } = useSidebarCollapseMotion(actions.toggleSidebar);
  const {
    sidebarMotion: rightSidebarMotion,
    startSidebarMotion: startRightSidebarMotion,
  } = useSidebarCollapseMotion(actions.toggleRightSidebar);
  const setLivePanelWidth = useCallback((property: string, width: number) => {
    shellRef.current?.style.setProperty(property, `${width}px`);
  }, []);
  const activeSidebarWidth = collapsed ? SIDEBAR_COLLAPSED_WIDTH : state.sidebarWidth;
  const guardContentMinWidth = contentMode === "full";
  const activeSidebarWidthRef = useRef(activeSidebarWidth);
  const rightSidebarRatioRef = useRef(state.rightSidebarRatio);
  const guardContentMinWidthRef = useRef(guardContentMinWidth);
  activeSidebarWidthRef.current = activeSidebarWidth;
  rightSidebarRatioRef.current = state.rightSidebarRatio;
  guardContentMinWidthRef.current = guardContentMinWidth;
  const getRightSidebarAvailableWidth = useCallback(() => {
    const liveShellWidth = measureShellWidth(shellRef.current);
    shellWidthRef.current = liveShellWidth;
    return Math.max(0, liveShellWidth - activeSidebarWidthRef.current);
  }, []);
  const rightSidebarGeometry = rightSidebarGeometryForShellWidth(
    shellWidthRef.current,
    activeSidebarWidth,
    state.rightSidebarRatio,
    guardContentMinWidth,
  );
  const rightSidebarMaxRatio = rightSidebarGeometry.maxRatio;
  const rightSidebarRatio = rightSidebarGeometry.ratio;
  const rightSidebarWidth = rightSidebarGeometry.width;
  const getRightSidebarMaxRatio = useCallback(
    (availableWidth: number) => maxRightSidebarRatioWithContentGuard(availableWidth, guardContentMinWidthRef.current),
    [],
  );
  const previewSidebarWidth = useCallback(
    (width: number) => setLivePanelWidth("--sidebar-width", width),
    [setLivePanelWidth],
  );
  const previewRightSidebarRatio = useCallback(
    (ratio: number) => {
      const shell = shellRef.current;
      if (!shell) {
        return;
      }
      const availableWidth = getRightSidebarAvailableWidth();
      const nextRatio = clampRightSidebarRatioForLayout(ratio, getRightSidebarMaxRatio(availableWidth));
      shell.style.setProperty("--right-sidebar-ratio", String(nextRatio));
      shell.style.setProperty("--right-sidebar-width", `${Math.round(availableWidth * nextRatio)}px`);
    },
    [getRightSidebarAvailableWidth, getRightSidebarMaxRatio],
  );
  const getLiveRightSidebarMaxRatio = useCallback(
    () => getRightSidebarMaxRatio(getRightSidebarAvailableWidth()),
    [getRightSidebarAvailableWidth, getRightSidebarMaxRatio],
  );
  const applyRightSidebarGeometry = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const measuredWidth = measureShellWidth(shell);
    shellWidthRef.current = measuredWidth;
    const geometry = rightSidebarGeometryForShellWidth(
      measuredWidth,
      activeSidebarWidthRef.current,
      rightSidebarRatioRef.current,
      guardContentMinWidthRef.current,
    );
    shell.style.setProperty("--right-sidebar-ratio", String(geometry.ratio));
    shell.style.setProperty("--right-sidebar-width", `${geometry.width}px`);
  }, []);
  const scheduleRightSidebarGeometry = useCallback(() => {
    if (typeof window === "undefined") {
      applyRightSidebarGeometry();
      return;
    }
    if (shellMeasureFrameRef.current !== null) {
      return;
    }
    shellMeasureFrameRef.current = window.requestAnimationFrame(() => {
      shellMeasureFrameRef.current = null;
      applyRightSidebarGeometry();
    });
  }, [applyRightSidebarGeometry]);
  const setRightSidebarResizing = useCallback((resizing: boolean) => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    if (resizing) {
      shell.dataset.rightSidebarResizing = "true";
      return;
    }
    delete shell.dataset.rightSidebarResizing;
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    scheduleRightSidebarGeometry();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleRightSidebarGeometry);
      return () => window.removeEventListener("resize", scheduleRightSidebarGeometry);
    }
    const observer = new ResizeObserver(scheduleRightSidebarGeometry);
    observer.observe(shell);
    window.addEventListener("resize", scheduleRightSidebarGeometry);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleRightSidebarGeometry);
      if (shellMeasureFrameRef.current !== null) {
        window.cancelAnimationFrame(shellMeasureFrameRef.current);
        shellMeasureFrameRef.current = null;
      }
    };
  }, [scheduleRightSidebarGeometry]);

  useLayoutEffect(() => {
    applyRightSidebarGeometry();
  }, [activeSidebarWidth, applyRightSidebarGeometry, guardContentMinWidth, state.rightSidebarRatio]);

  useEffect(() => {
    const activeScopeKey = previewContext?.activeScopeKey ?? null;
    if (lastPreviewScopeKeyRef.current === activeScopeKey) {
      return;
    }
    lastPreviewScopeKeyRef.current = activeScopeKey;

    if (previewContext?.open) {
      lastPreviewOpenStampRef.current = previewOpenStamp(previewContext.activeEntry);
    }

    const filePanelRequest = previewContext?.filePanelRequest ?? null;
    if (filePanelRequest?.requestId && filePanelRequest.scopeKey === activeScopeKey) {
      lastFilePanelOpenRequestRef.current = filePanelRequest.requestId;
    }
  }, [
    previewContext?.activeEntry,
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.scopeKey,
    previewContext?.open,
  ]);

  useEffect(() => {
    const activeEntry = previewContext?.open ? previewContext.activeEntry : null;
    if (!activeEntry) {
      return;
    }
    const openedStamp = previewOpenStamp(activeEntry);
    if (openedStamp === lastPreviewOpenStampRef.current) {
      return;
    }
    lastPreviewOpenStampRef.current = openedStamp;
    if (!globalRightSidebarEnabled) {
      return;
    }
    if (!state.rightSidebarOpen) {
      setRightSidebarMode("split");
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [
    actions,
    globalRightSidebarEnabled,
    previewContext?.activeEntry,
    previewContext?.open,
    startRightSidebarMotion,
    state.rightSidebarOpen,
  ]);

  useEffect(() => {
    const collapseRequestId = previewContext?.collapseRequestId ?? 0;
    if (collapseRequestId === 0 || collapseRequestId === lastPreviewCollapseRequestRef.current) {
      return;
    }
    lastPreviewCollapseRequestRef.current = collapseRequestId;
    if (!globalRightSidebarEnabled) {
      return;
    }
    setRightSidebarMode("split");
    if (state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(false);
  }, [
    actions,
    globalRightSidebarEnabled,
    previewContext?.collapseRequestId,
    startRightSidebarMotion,
    state.rightSidebarOpen,
  ]);

  useEffect(() => {
    const filePanelRequest = previewContext?.filePanelRequest ?? null;
    if (
      !filePanelRequest?.requestId ||
      filePanelRequest.requestId === lastFilePanelOpenRequestRef.current ||
      filePanelRequest.scopeKey !== previewContext?.activeScopeKey
    ) {
      return;
    }
    lastFilePanelOpenRequestRef.current = filePanelRequest.requestId;
    if (!globalRightSidebarEnabled) {
      return;
    }
    setRightSidebarMode("split");
    if (!state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [
    actions,
    globalRightSidebarEnabled,
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.scopeKey,
    startRightSidebarMotion,
    state.rightSidebarOpen,
  ]);

  const closeRightSidebar = useCallback(() => {
    if (!globalRightSidebarEnabled) {
      return;
    }
    setRightSidebarMode("split");
    if (state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(false);
  }, [actions, globalRightSidebarEnabled, startRightSidebarMotion, state.rightSidebarOpen]);

  const openRightSidebar = useCallback(() => {
    if (!globalRightSidebarEnabled) {
      return;
    }
    setRightSidebarMode("split");
    if (!state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [actions, globalRightSidebarEnabled, startRightSidebarMotion, state.rightSidebarOpen]);

  const openConversationPanel = useCallback(
    (request: OpenRightSidebarConversationRequest) => {
      const session = request.session;
      if (!session?.id) {
        return;
      }
      const scopeKey = previewContext?.activeScopeKey ?? GLOBAL_RIGHT_SIDEBAR_SCOPE;
      setRightSidebarPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
        const next = activateOrCreateConversationPanel(previous, {
          session,
          title: request.title,
          sourceSessionId: request.sourceSessionId,
        });
        if (sameRightSidebarScopePanelState(previous, next)) {
          return current;
        }
        return { ...current, [scopeKey]: next };
      });
      openRightSidebar();
    },
    [openRightSidebar, previewContext?.activeScopeKey],
  );

  const openBtwConversationFromSession = useCallback(
    async ({ sessionId, runtime: requestRuntime }: OpenBtwConversationRequest) => {
      const cleanedSessionId = sessionId.trim();
      if (!cleanedSessionId) {
        notifications.warning("当前会话无法开启旁路对话");
        return null;
      }
      try {
        const result = await createBtwConversationFromSession(requestRuntime, cleanedSessionId);
        if ("error" in result) {
          notifications.warning(result.message);
          return null;
        }
        openConversationPanel({
          session: result.session,
          sourceSessionId: cleanedSessionId,
          title: result.session.title || BTW_CONVERSATION_TITLE,
        });
        notifications.success("已打开旁路对话");
        return result.session;
      } catch (reason) {
        notifications.error(`旁路对话创建失败：${errorMessage(reason)}`);
        return null;
      }
    },
    [notifications, openConversationPanel],
  );

  const rightSidebarConversationValue = useMemo(
    () => ({
      openConversationPanel,
      openBtwConversationFromSession,
    }),
    [openBtwConversationFromSession, openConversationPanel],
  );

  const maximizeRightSidebar = useCallback(() => {
    if (!globalRightSidebarEnabled) {
      return;
    }
    if (!state.rightSidebarOpen) {
      actions.setRightSidebarOpen(true);
    }
    startRightSidebarMotion();
    setRightSidebarMode("maximized");
  }, [actions, globalRightSidebarEnabled, startRightSidebarMotion, state.rightSidebarOpen]);

  const restoreRightSidebar = useCallback(() => {
    if (!globalRightSidebarEnabled) {
      return;
    }
    startRightSidebarMotion();
    setRightSidebarMode("split");
  }, [globalRightSidebarEnabled, startRightSidebarMotion]);

  const swapRightSidebarPlacement = useCallback(() => {
    if (!globalRightSidebarEnabled) {
      return;
    }
    setRightSidebarMode("split");
    startRightSidebarMotion();

    const applyPlacementSwap = () => actions.toggleRightSidebarPlacement();
    const viewTransitionDocument = typeof document === "undefined" ? null : (document as ViewTransitionDocument);
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!prefersReducedMotion && typeof viewTransitionDocument?.startViewTransition === "function") {
      viewTransitionDocument.startViewTransition(() => {
        flushSync(applyPlacementSwap);
      });
      return;
    }

    applyPlacementSwap();
  }, [actions, globalRightSidebarEnabled, startRightSidebarMotion]);

  const navigateFromShell = useCallback(
    (path: string) => {
      if (path === "/guid" || path.startsWith("/guid?")) {
        closeRightSidebar();
      }
      onNavigate?.(path);
    },
    [closeRightSidebar, onNavigate],
  );

  const clearAppModeNavigationTimer = useCallback(() => {
    if (appModeNavigationTimerRef.current === null || typeof window === "undefined") {
      appModeNavigationTimerRef.current = null;
      return;
    }
    window.clearTimeout(appModeNavigationTimerRef.current);
    appModeNavigationTimerRef.current = null;
  }, []);

  const switchAppMode = useCallback(
    (mode: AppMode) => {
      clearAppModeNavigationTimer();
      if (mode === appMode) {
        return;
      }
      const target = modeSwitchTargets?.[mode];
      if (!target || target === activePath) {
        return;
      }
      if (typeof window === "undefined" || prefersReducedMotion()) {
        onNavigate?.(target);
        return;
      }
      appModeNavigationTimerRef.current = window.setTimeout(() => {
        appModeNavigationTimerRef.current = null;
        onNavigate?.(target);
      }, APP_MODE_SWITCH_NAVIGATION_DELAY_MS);
    },
    [activePath, appMode, clearAppModeNavigationTimer, modeSwitchTargets, onNavigate],
  );

  const openProductShowcase = useCallback(() => {
    setProductShowcasePhase("open");
  }, []);

  const closeProductShowcase = useCallback(() => {
    setProductShowcasePhase((phase) => (phase ? "exiting" : phase));
  }, []);

  const handleProductShowcaseExited = useCallback(() => {
    setProductShowcasePhase(null);
  }, []);

  useEffect(() => () => clearAppModeNavigationTimer(), [clearAppModeNavigationTimer]);

  useEffect(() => {
    if (!resetRightSidebarKey || lastRightSidebarResetKeyRef.current === resetRightSidebarKey) {
      return;
    }
    lastRightSidebarResetKeyRef.current = resetRightSidebarKey;
    closeRightSidebar();
  }, [closeRightSidebar, resetRightSidebarKey]);

  const rightSidebarOpen = globalRightSidebarEnabled && state.rightSidebarOpen;
  const rightSidebarMaximized = rightSidebarOpen && rightSidebarMode === "maximized";
  const rightSidebarOnLeft = state.rightSidebarPlacement === "left";
  const openRightSidebarLabel = rightSidebarOnLeft ? "展开左侧栏" : "展开右侧栏";
  const OpenRightSidebarIcon = rightSidebarOnLeft ? PanelLeftOpen : PanelRightOpen;
  const showRuntimeStatus = Boolean(runtimeConnection?.error);

  return (
    <RightSidebarConversationContext.Provider value={rightSidebarConversationValue}>
    <div
      ref={shellRef}
      className={styles.shell}
      data-testid="app-shell"
      data-sidebar={collapsed ? "collapsed" : "expanded"}
      data-sidebar-motion={sidebarMotion ? "true" : "false"}
      data-right-sidebar={rightSidebarOpen ? "open" : "closed"}
      data-right-sidebar-enabled={globalRightSidebarEnabled ? "true" : "false"}
      data-right-sidebar-mode={rightSidebarMaximized ? "maximized" : "split"}
      data-right-sidebar-motion={rightSidebarMotion ? "true" : "false"}
      data-right-sidebar-placement={state.rightSidebarPlacement}
      data-workspace={state.workspaceOpen ? "open" : "closed"}
      data-preview={state.previewOpen ? "open" : "closed"}
      style={
        {
          "--sidebar-width": `${state.sidebarWidth}px`,
          "--content-min-width": `${FULL_CONTENT_MIN_WIDTH}px`,
          "--right-sidebar-ratio": String(rightSidebarRatio),
          "--right-sidebar-width": `${rightSidebarWidth}px`,
          "--workspace-panel-width": `${state.workspaceWidth}px`,
          "--preview-panel-width": `${state.previewWidth}px`,
        } as CSSProperties
      }
    >
      <Titlebar
        title={title}
        onBrandClick={openProductShowcase}
        modeSwitch={{
          currentMode: appMode,
          onModeChange: switchAppMode,
        }}
        workbenchWorkspaceSelector={workbenchWorkspaceSelector}
      />

      {showRuntimeStatus && runtimeConnection ? (
        <ConnectionStatus
          state={runtimeConnection.runtimeState}
          onClearAll={runtimeConnection.clearAllErrors}
          onClearError={runtimeConnection.clearError}
          onRetry={runtimeConnection.retry}
        />
      ) : null}

      <div className={styles.body}>
        <Sider
          appMode={appMode}
          runtime={runtime}
          activePath={activePath}
          collapsed={collapsed}
          projects={projects}
          conversations={conversations}
          showChatBucket={showChatBucket}
          newConversationPath={newConversationPath}
          deleteActiveFallbackPath={deleteActiveFallbackPath}
          getSessionPath={getSessionPath}
          getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
          onToggleSidebar={toggleSidebar}
          onNavigate={navigateFromShell}
        />
        <SidebarResizeHandle
          disabled={collapsed}
          width={state.sidebarWidth}
          onResizePreview={previewSidebarWidth}
          onResize={actions.setSidebarWidth}
        />

        <section className={styles.content} data-content={contentMode} aria-label="主内容区">
          <div className={styles.readingColumn} data-content={contentMode}>
            {children}
          </div>
        </section>
        {globalRightSidebarEnabled && !rightSidebarOpen ? (
          <button
            className={styles.contentRightSidebarToggle}
            data-icon={rightSidebarOnLeft ? "panel-left-open" : "panel-right-open"}
            type="button"
            aria-label={openRightSidebarLabel}
            title={openRightSidebarLabel}
            onClick={openRightSidebar}
          >
            <OpenRightSidebarIcon size={17} strokeWidth={2.1} />
          </button>
        ) : null}

        {globalRightSidebarEnabled ? (
          <>
            <RightSidebarResizeHandle
              disabled={!rightSidebarOpen || rightSidebarMaximized}
              ratio={rightSidebarRatio}
              maxRatio={rightSidebarMaxRatio}
              getMaxRatio={getLiveRightSidebarMaxRatio}
              placement={state.rightSidebarPlacement}
              getAvailableWidth={getRightSidebarAvailableWidth}
              onResizePreview={previewRightSidebarRatio}
              onResize={actions.setRightSidebarRatio}
              onResizeDragChange={setRightSidebarResizing}
              onSwapPlacement={swapRightSidebarPlacement}
            />
            <RightSidebarPanel
              open={rightSidebarOpen}
              maximized={rightSidebarMaximized}
              placement={state.rightSidebarPlacement}
              runtime={runtime}
              panelStateByScope={rightSidebarPanelStateByScope}
              setPanelStateByScope={setRightSidebarPanelStateByScope}
              onNavigateToConversation={(sessionId) => onNavigate?.(resolveSessionPath(sessionId, getSessionPath))}
              onOpenModelSettings={() => onNavigate?.("/settings/model-defaults")}
              onClose={closeRightSidebar}
              onMaximize={maximizeRightSidebar}
              onRestore={restoreRightSidebar}
            />
          </>
        ) : null}
      </div>
      {productShowcasePhase ? (
        <ProductShowcaseOverlay
          phase={productShowcasePhase}
          onRequestClose={closeProductShowcase}
          onExited={handleProductShowcaseExited}
        />
      ) : null}
    </div>
    </RightSidebarConversationContext.Provider>
  );
}

function RightSidebarPanel({
  open,
  maximized,
  placement,
  runtime,
  panelStateByScope,
  setPanelStateByScope,
  onNavigateToConversation,
  onOpenModelSettings,
  onClose,
  onMaximize,
  onRestore,
}: {
  open: boolean;
  maximized: boolean;
  placement: RightSidebarPlacement;
  runtime: RuntimeBridge;
  panelStateByScope: Record<string, RightSidebarScopePanelState>;
  setPanelStateByScope: Dispatch<SetStateAction<Record<string, RightSidebarScopePanelState>>>;
  onNavigateToConversation?: (sessionId: string) => void;
  onOpenModelSettings?: () => void;
  onClose: () => void;
  onMaximize: () => void;
  onRestore: () => void;
}) {
  const previewContext = useOptionalPreview();
  const rightSidebarConversation = useOptionalRightSidebarConversation();
  const activeScopeKey = previewContext?.activeScopeKey ?? GLOBAL_RIGHT_SIDEBAR_SCOPE;
  const syncedPreviewOpenStampsRef = useRef<Set<string>>(new Set());
  const previousFilePanelScopeRef = useRef(activeScopeKey);
  const previousScopeHadFilePanelRef = useRef(false);
  const request = previewContext?.open ? previewContext.request : null;
  const renderContext = previewContext?.activeRenderContext;
  const rawFilePanelRequest = previewContext?.filePanelRequest ?? null;
  const filePanelRequest =
    rawFilePanelRequest && rawFilePanelRequest.scopeKey === previewContext?.activeScopeKey
      ? rawFilePanelRequest
      : null;
  const filePanelRenderContext = filePanelRequest?.renderContext ?? renderContext;
  const entries = previewContext?.entries ?? [];
  const activeEntryId = previewContext?.activeEntryId ?? null;
  const hostContext = previewContext?.hostContext ?? null;
  const scopedPanelState = normalizeRightSidebarScopePanelState(panelStateByScope[activeScopeKey]);
  const activePanelId = scopedPanelState.activePanelId;
  const filePanelIds = scopedPanelState.filePanelIds;
  const filePanels = scopedPanelState.filePanels;
  const conversationPanelIds = scopedPanelState.conversationPanelIds;
  const conversationPanels = scopedPanelState.conversationPanels;
  const initialPanelIds = scopedPanelState.initialPanelIds;
  const entryIds = entries.map((entry) => entry.id);
  const orderedPanelIds = orderedRightSidebarPanelIds(scopedPanelState, entryIds);
  const canOpenFiles = Boolean(
    filePanelRenderContext?.workspaceAvailable &&
      filePanelRenderContext?.runtime &&
      (filePanelRenderContext?.sessionId || filePanelRenderContext?.workspaceId),
  );
  const canOpenBtwConversation = Boolean(hostContext?.sessionId && hostContext.runtime);
  const resolvedActivePanelId = activePanelId ?? activeEntryId ?? orderedPanelIds[0] ?? null;
  const activeFilePanel = resolvedActivePanelId ? (filePanels[resolvedActivePanelId] ?? null) : null;
  const activeConversationPanel = resolvedActivePanelId ? (conversationPanels[resolvedActivePanelId] ?? null) : null;
  const activePreviewEntry =
    resolvedActivePanelId && !activeFilePanel && !activeConversationPanel && !initialPanelIds.includes(resolvedActivePanelId)
      ? entries.find((entry) => entry.id === resolvedActivePanelId) ?? null
      : null;
  const activeRequest = activePreviewEntry?.request ?? (resolvedActivePanelId === activeEntryId ? request : null);
  const activeRenderContext = activePreviewEntry?.renderContext ?? renderContext;
  const filePanelQuoteSelection = useCallback(
    (request: PreviewQuoteSelectionRequest) => {
      filePanelRenderContext?.onQuoteSelection?.(request);
      if (maximized) {
        onRestore();
      }
    },
    [filePanelRenderContext?.onQuoteSelection, maximized, onRestore],
  );
  const activePreviewQuoteSelection = useCallback(
    (request: PreviewQuoteSelectionRequest) => {
      activeRenderContext?.onQuoteSelection?.(request);
      if (maximized) {
        onRestore();
      }
    },
    [activeRenderContext?.onQuoteSelection, maximized, onRestore],
  );
  const showFilesPanel = Boolean(activeFilePanel);
  const showConversationPanel = Boolean(activeConversationPanel);
  const panelActivePreviewEntryId =
    open && resolvedActivePanelId && !activeFilePanel && !activeConversationPanel && !initialPanelIds.includes(resolvedActivePanelId)
      ? activePreviewEntry?.id ?? (resolvedActivePanelId === activeEntryId ? activeEntryId : null)
      : null;

  const updateActiveScopePanelState = useCallback(
    (updater: (state: RightSidebarScopePanelState) => RightSidebarScopePanelState) => {
      setPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[activeScopeKey]);
        const next = updater(previous);
        if (sameRightSidebarScopePanelState(previous, next)) {
          return current;
        }
        return { ...current, [activeScopeKey]: next };
      });
    },
    [activeScopeKey],
  );

  useEffect(() => {
    previewContext?.setPreviewPanelOpen(open, panelActivePreviewEntryId);
  }, [open, panelActivePreviewEntryId, previewContext]);

  useEffect(() => {
    const scopeChanged = previousFilePanelScopeRef.current !== activeScopeKey;
    const previousScopeHadFilePanel = previousScopeHadFilePanelRef.current;
    previousFilePanelScopeRef.current = activeScopeKey;
    previousScopeHadFilePanelRef.current = filePanelIds.length > 0;
    if (!scopeChanged || !previousScopeHadFilePanel || !open || !canOpenFiles || filePanelIds.length > 0) {
      return;
    }
    updateActiveScopePanelState((current) => activateOrCreateFilePanel(current));
  }, [activeScopeKey, canOpenFiles, filePanelIds.length, open, updateActiveScopePanelState]);

  useEffect(() => {
    const activeEntry = previewContext?.activeEntry;
    if (!activeEntryId || !activeEntry) {
      return;
    }
    const stamp = `${activeEntryId}:${activeEntry.openedAt}`;
    if (syncedPreviewOpenStampsRef.current.has(stamp)) {
      return;
    }
    syncedPreviewOpenStampsRef.current.add(stamp);
    updateActiveScopePanelState((current) => ({
      ...current,
      activePanelId: activeEntryId,
      panelOrder: appendPanelOrder(current.panelOrder, activeEntryId),
    }));
  }, [activeEntryId, previewContext?.activeEntry?.openedAt, updateActiveScopePanelState]);

  useEffect(() => {
    if (canOpenFiles || filePanelIds.length === 0) {
      return;
    }
    updateActiveScopePanelState((current) => {
      const activeFilePanelId = activeFilePanelIdForState(current);
      const nextPanelOrder = current.panelOrder.filter((id) => !current.filePanels[id]);
      const activePanelId =
        activeFilePanelId && current.activePanelId === activeFilePanelId
          ? activeEntryId ?? nextPanelOrder[0] ?? null
          : current.activePanelId;
      return {
        ...current,
        activePanelId,
        panelOrder: nextPanelOrder,
        filePanelIds: [],
        filePanels: {},
      };
    });
  }, [activeEntryId, canOpenFiles, filePanelIds.length, updateActiveScopePanelState]);

  useEffect(() => {
    const filePanelRequestId = filePanelRequest?.requestId ?? 0;
    if (!filePanelRequestId || !canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) =>
      activateOrCreateFilePanel(current, {
        path: filePanelRequest?.path ?? null,
        requestId: filePanelRequestId,
        revealTarget: filePanelRequest?.revealTarget ?? null,
        preferExisting: true,
      }),
    );
  }, [
    canOpenFiles,
    filePanelRequest?.path,
    filePanelRequest?.requestId,
    filePanelRequest?.revealTarget,
    updateActiveScopePanelState,
  ]);

  const openFilesPanel = useCallback(() => {
    if (!canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) => activateOrCreateFilePanel(current));
  }, [canOpenFiles, updateActiveScopePanelState]);

  const openBtwConversationFromHost = useCallback(() => {
    const sessionId = hostContext?.sessionId?.trim() ?? "";
    const hostRuntime = hostContext?.runtime;
    if (!sessionId || !hostRuntime) {
      return;
    }
    void rightSidebarConversation?.openBtwConversationFromSession({
      sessionId,
      runtime: hostRuntime,
    });
  }, [hostContext?.runtime, hostContext?.sessionId, rightSidebarConversation]);

  const closeFilesPanel = useCallback(
    (panelId: string) => {
      const remainingFilePanelIds = filePanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        entries.length === 0 &&
        initialPanelIds.length === 0 &&
        conversationPanelIds.length === 0 &&
        remainingFilePanelIds.length === 0 &&
        resolvedActivePanelId === panelId;
      updateActiveScopePanelState((current) => {
        const nextFilePanelIds = current.filePanelIds.filter((id) => id !== panelId);
        const nextFilePanels = { ...current.filePanels };
        delete nextFilePanels[panelId];
        if (current.activePanelId !== panelId) {
          return {
            ...current,
            panelOrder: current.panelOrder.filter((id) => id !== panelId),
            filePanelIds: nextFilePanelIds,
            filePanels: nextFilePanels,
          };
        }
        const nextPanelId = nextPanelIdAfterRemoval(current.panelOrder, panelId);
        return {
          ...current,
          activePanelId: nextPanelId ?? activeEntryId ?? entries[0]?.id ?? current.conversationPanelIds[0] ?? null,
          panelOrder: current.panelOrder.filter((id) => id !== panelId),
          filePanelIds: nextFilePanelIds,
          filePanels: nextFilePanels,
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      activeEntryId,
      entries,
      conversationPanelIds.length,
      filePanelIds,
      initialPanelIds.length,
      onClose,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const closePreviewEntry = useCallback(
    (entryId: string) => {
      const closedIndex = entries.findIndex((entry) => entry.id === entryId);
      const remainingEntries = entries.filter((entry) => entry.id !== entryId);
      const closedActivePanel = resolvedActivePanelId === entryId;
      const shouldCloseSidebar =
        remainingEntries.length === 0 &&
        filePanelIds.length === 0 &&
        conversationPanelIds.length === 0 &&
        initialPanelIds.length === 0 &&
        resolvedActivePanelId === entryId;
      previewContext?.closePreviewEntry(entryId);
      updateActiveScopePanelState((current) => {
        if (current.activePanelId !== entryId && !closedActivePanel) {
          return { ...current, panelOrder: current.panelOrder.filter((id) => id !== entryId) };
        }
        const nextEntry =
          remainingEntries[Math.max(0, Math.min(closedIndex - 1, remainingEntries.length - 1))] ?? null;
        return {
          ...current,
          activePanelId:
            nextEntry?.id ??
            nextPanelIdAfterRemoval(current.panelOrder, entryId) ??
            current.filePanelIds[0] ??
            current.conversationPanelIds[0] ??
            null,
          panelOrder: current.panelOrder.filter((id) => id !== entryId),
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      entries,
      conversationPanelIds.length,
      filePanelIds.length,
      initialPanelIds.length,
      onClose,
      previewContext,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const openPanelEntry = useCallback(
    (entryId: string) => {
      updateActiveScopePanelState((current) => ({
        ...current,
        activePanelId: entryId,
        panelOrder: appendPanelOrder(current.panelOrder, entryId),
      }));
      previewContext?.switchPreview(entryId);
    },
    [previewContext, updateActiveScopePanelState],
  );

  const activateFilesPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) =>
        current.filePanels[panelId] ? { ...current, activePanelId: panelId } : current,
      );
    },
    [updateActiveScopePanelState],
  );

  const activateConversationPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) =>
        current.conversationPanels[panelId] ? { ...current, activePanelId: panelId } : current,
      );
    },
    [updateActiveScopePanelState],
  );

  const closeConversationPanel = useCallback(
    (panelId: string) => {
      const remainingConversationPanelIds = conversationPanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        resolvedActivePanelId === panelId &&
        remainingConversationPanelIds.length === 0 &&
        filePanelIds.length === 0 &&
        initialPanelIds.length === 0 &&
        entries.length === 0;
      updateActiveScopePanelState((current) => {
        const nextConversationPanelIds = current.conversationPanelIds.filter((id) => id !== panelId);
        const nextConversationPanels = { ...current.conversationPanels };
        delete nextConversationPanels[panelId];
        if (current.activePanelId !== panelId) {
          return {
            ...current,
            panelOrder: current.panelOrder.filter((id) => id !== panelId),
            conversationPanelIds: nextConversationPanelIds,
            conversationPanels: nextConversationPanels,
          };
        }
        const nextPanelId = nextPanelIdAfterRemoval(current.panelOrder, panelId);
        return {
          ...current,
          activePanelId: nextPanelId ?? activeEntryId ?? entries[0]?.id ?? current.filePanelIds[0] ?? null,
          panelOrder: current.panelOrder.filter((id) => id !== panelId),
          conversationPanelIds: nextConversationPanelIds,
          conversationPanels: nextConversationPanels,
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      activeEntryId,
      conversationPanelIds,
      entries,
      filePanelIds.length,
      initialPanelIds.length,
      onClose,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const openInitialPanel = useCallback(() => {
    updateActiveScopePanelState((current) => {
      const nextPanelSeq = current.nextPanelSeq + 1;
      const panelId = `${INITIAL_PANEL_ID_PREFIX}${nextPanelSeq}`;
      return {
        ...current,
        activePanelId: panelId,
        panelOrder: [...current.panelOrder, panelId],
        initialPanelIds: [...current.initialPanelIds, panelId],
        nextPanelSeq,
      };
    });
  }, [updateActiveScopePanelState]);

  const activateInitialPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) => ({ ...current, activePanelId: panelId }));
    },
    [updateActiveScopePanelState],
  );

  const closeInitialPanel = useCallback(
    (panelId: string) => {
      const remainingInitialPanels = initialPanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        resolvedActivePanelId === panelId &&
        remainingInitialPanels.length === 0 &&
        filePanelIds.length === 0 &&
        conversationPanelIds.length === 0 &&
        entries.length === 0;
      updateActiveScopePanelState((current) => {
        const nextInitialPanelIds = current.initialPanelIds.filter((id) => id !== panelId);
        if (current.activePanelId !== panelId) {
          return {
            ...current,
            panelOrder: current.panelOrder.filter((id) => id !== panelId),
            initialPanelIds: nextInitialPanelIds,
          };
        }
        const nextPanelId = nextPanelIdAfterRemoval(current.panelOrder, panelId);
        return {
          ...current,
          activePanelId: nextPanelId ?? activeEntryId ?? entries[0]?.id ?? current.filePanelIds[0] ?? current.conversationPanelIds[0] ?? null,
          panelOrder: current.panelOrder.filter((id) => id !== panelId),
          initialPanelIds: nextInitialPanelIds,
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      activeEntryId,
      entries,
      conversationPanelIds.length,
      filePanelIds.length,
      initialPanelIds,
      onClose,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const updateFilePanelPreviewPath = useCallback(
    (path: string | null) => {
      const panelId = activeFilePanel?.id;
      if (!panelId) {
        return;
      }
      updateActiveScopePanelState((current) => {
        const panel = current.filePanels[panelId];
        if (!panel) {
          return current;
        }
        return {
          ...current,
          filePanels: {
            ...current.filePanels,
            [panelId]: {
              ...panel,
              filePreviewPath: path,
              filePreviewRequestId: panel.filePreviewRequestId + 1,
              filePreviewRevealTarget: null,
            },
          },
        };
      });
    },
    [activeFilePanel?.id, updateActiveScopePanelState],
  );

  const controls = (
    <RightSidebarControls
      maximized={maximized}
      placement={placement}
      onClose={onClose}
      onMaximize={onMaximize}
      onRestore={onRestore}
    />
  );
  const panelLabel = placement === "left" ? "左侧栏" : "右侧栏";

  return (
    <aside className={styles.rightSidebar} aria-label={panelLabel} aria-hidden={!open}>
      {open ? (
        <>
          <div className={styles.rightSidebarTopbar}>
            <div className={styles.rightSidebarTabArea}>
              <div className={styles.rightSidebarTabs} role="tablist" aria-label="侧边栏窗口">
                {orderedPanelIds.map((panelId) => {
                  const filePanel = filePanels[panelId];
                  if (filePanel) {
                    const active = resolvedActivePanelId === panelId;
                    return (
                      <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={panelId}>
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          title="文件"
                          onClick={() => activateFilesPanel(panelId)}
                        >
                          <Folder size={12} />
                          <span>文件</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label="关闭侧边栏窗口 文件"
                          title="关闭侧边栏窗口 文件"
                          onClick={(event) => {
                            event.stopPropagation();
                            closeFilesPanel(panelId);
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  }
                  const conversationPanel = conversationPanels[panelId];
                  if (conversationPanel) {
                    const active = resolvedActivePanelId === panelId;
                    const title = conversationPanel.title || "旁路对话";
                    return (
                      <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={panelId}>
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          title={title}
                          onClick={() => activateConversationPanel(panelId)}
                        >
                          <MessageSquare size={12} />
                          <span>{title}</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label={`关闭侧边栏窗口 ${title}`}
                          title={`关闭侧边栏窗口 ${title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeConversationPanel(panelId);
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  }
                  if (initialPanelIds.includes(panelId)) {
                    const title = initialPanelTitle(panelId);
                    const active = resolvedActivePanelId === panelId;
                    return (
                      <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={panelId}>
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          title={title}
                          onClick={() => activateInitialPanel(panelId)}
                        >
                          <FileText size={12} />
                          <span>{title}</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label={`关闭侧边栏窗口 ${title}`}
                          title={`关闭侧边栏窗口 ${title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeInitialPanel(panelId);
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  }
                  const entry = entries.find((item) => item.id === panelId);
                  if (!entry) {
                    return null;
                  }
                  const active = resolvedActivePanelId === entry.id;
                  return (
                    <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={entry.id}>
                      <button
                        className={styles.rightSidebarTabMain}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        title={entry.sourceLabel}
                        onClick={() => openPanelEntry(entry.id)}
                      >
                        <FileText size={12} />
                        <span>{entry.title}</span>
                      </button>
                      <button
                        className={styles.rightSidebarTabClose}
                        type="button"
                        aria-label={`关闭侧边栏窗口 ${entry.title}`}
                        title={`关闭侧边栏窗口 ${entry.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closePreviewEntry(entry.id);
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                className={styles.rightSidebarAddTab}
                type="button"
                aria-label="新建侧边栏页面"
                title="新建侧边栏页面"
                onClick={openInitialPanel}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className={styles.rightSidebarPanelControls}>
              {controls}
            </div>
          </div>
          {conversationPanelIds.map((panelId) => {
            const conversationPanel = conversationPanels[panelId];
            if (!conversationPanel) {
              return null;
            }
            return (
              <div
                className={styles.rightSidebarBody}
                data-content="conversation"
                hidden={resolvedActivePanelId !== panelId}
                key={panelId}
              >
                <Suspense fallback={<RightSidebarLoading label="正在加载旁路对话" />}>
                  <LazyConversationSessionSurface
                    threadId={conversationPanel.sessionId}
                    runtime={runtime}
                    mode="sidecar"
                    previewPanelScopeKey={activeScopeKey}
                    onNavigateToConversation={onNavigateToConversation}
                    onOpenModelSettings={onOpenModelSettings}
                  />
                </Suspense>
              </div>
            );
          })}
          {!showConversationPanel ? (
            showFilesPanel &&
            filePanelRenderContext?.runtime &&
            (filePanelRenderContext.sessionId || filePanelRenderContext.workspaceId) ? (
              <div className={styles.rightSidebarBody} data-content="files">
                <Suspense fallback={<RightSidebarLoading label="正在加载文件" />}>
                  <LazyWorkspaceFileBrowser
                    key={`${activeScopeKey}:${activeFilePanel?.id ?? "files"}`}
                    label={filePanelRenderContext.workspaceLabel}
                    runtime={filePanelRenderContext.runtime}
                    workspaceId={filePanelRenderContext.workspaceId}
                    sessionId={filePanelRenderContext.sessionId}
                    previewPath={activeFilePanel?.filePreviewPath ?? null}
                    previewRequestId={activeFilePanel?.filePreviewRequestId ?? 0}
                    previewRevealTarget={activeFilePanel?.filePreviewRevealTarget ?? null}
                    onQuoteSelection={filePanelRenderContext.onQuoteSelection ? filePanelQuoteSelection : undefined}
                    onStartChatFromAnnotation={filePanelRenderContext.onStartChatFromAnnotation}
                    onPreviewPathChange={updateFilePanelPreviewPath}
                  />
                </Suspense>
              </div>
            ) : activeRequest ? (
              <div className={styles.rightSidebarBody} data-content="preview">
                <Suspense fallback={<RightSidebarLoading label="正在加载预览" />}>
                  <LazyFilePreview
                    breadcrumbRootLabel={
                      activeRequest.type === "content" && !activeRequest.sourcePath
                        ? undefined
                        : activeRenderContext?.workspaceLabel
                    }
                    workspaceId={activeRenderContext?.workspaceId}
                    sessionId={activeRenderContext?.sessionId}
                    request={activeRequest}
                    runtime={activeRenderContext?.runtime}
                    onQuoteSelection={activeRenderContext?.onQuoteSelection ? activePreviewQuoteSelection : undefined}
                    onStartChatFromAnnotation={activeRenderContext?.onStartChatFromAnnotation}
                    chrome="panel"
                  />
                </Suspense>
              </div>
            ) : (
              <div className={styles.rightSidebarBody} data-content="empty">
                <RightSidebarInitialPage
                  canOpenFiles={canOpenFiles}
                  canOpenBtwConversation={canOpenBtwConversation}
                  onOpenFiles={openFilesPanel}
                  onOpenBtwConversation={openBtwConversationFromHost}
                />
              </div>
            )
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function RightSidebarLoading({ label }: { label: string }) {
  return <LoadingSkeleton className={styles.rightSidebarLoading} label={label} />;
}

function previewOpenStamp(entry: { id: string; openedAt: number } | null): string | null {
  return entry ? `${entry.id}:${entry.openedAt}` : null;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function sameRightSidebarScopePanelState(
  left: RightSidebarScopePanelState,
  right: RightSidebarScopePanelState,
): boolean {
  return (
    left.activePanelId === right.activePanelId &&
    left.nextPanelSeq === right.nextPanelSeq &&
    sameStringArray(left.panelOrder, right.panelOrder) &&
    sameStringArray(left.filePanelIds, right.filePanelIds) &&
    sameStringArray(left.conversationPanelIds, right.conversationPanelIds) &&
    sameFilePanels(left, right) &&
    sameConversationPanels(left, right) &&
    sameStringArray(left.initialPanelIds, right.initialPanelIds)
  );
}

type LegacyRightSidebarScopePanelState = Partial<RightSidebarScopePanelState> & {
  filesOpen?: boolean;
  initialPanelSeq?: number;
  filePreviewPath?: string | null;
  filePreviewRequestId?: number;
};

function normalizeRightSidebarScopePanelState(
  state: LegacyRightSidebarScopePanelState | null | undefined,
): RightSidebarScopePanelState {
  const filePanels = { ...(state?.filePanels ?? {}) };
  let filePanelIds = state?.filePanelIds ?? [];
  if (filePanelIds.length === 0 && state?.filesOpen) {
    filePanelIds = [LEGACY_FILES_PANEL_ID];
    filePanels[LEGACY_FILES_PANEL_ID] = {
      id: LEGACY_FILES_PANEL_ID,
      filePreviewPath: state.filePreviewPath ?? null,
      filePreviewRequestId: state.filePreviewRequestId ?? 0,
      filePreviewRevealTarget: null,
    };
  }
  const conversationPanelIds = state?.conversationPanelIds ?? [];
  const conversationPanels = { ...(state?.conversationPanels ?? {}) };
  const initialPanelIds = state?.initialPanelIds ?? [];
  const nextPanelSeq = Math.max(
    state?.nextPanelSeq ?? state?.initialPanelSeq ?? 0,
    maxPanelSeq([...filePanelIds, ...conversationPanelIds, ...initialPanelIds]),
  );
  const panelOrder = orderedUniquePanelIds(state?.panelOrder ?? [], [
    ...filePanelIds,
    ...conversationPanelIds,
    ...initialPanelIds,
  ]);

  return {
    ...EMPTY_RIGHT_SIDEBAR_SCOPE_STATE,
    ...state,
    panelOrder,
    filePanelIds,
    filePanels,
    conversationPanelIds,
    conversationPanels,
    initialPanelIds,
    nextPanelSeq,
  };
}

function activateOrCreateFilePanel(
  state: RightSidebarScopePanelState,
  options: {
    path?: string | null;
    requestId?: number;
    revealTarget?: PreviewFileRevealTarget | null;
    preferExisting?: boolean;
  } = {},
): RightSidebarScopePanelState {
  const activeFilePanelId = activeFilePanelIdForState(state);
  const reusableFilePanelId = activeFilePanelId ?? (options.preferExisting ? state.filePanelIds[0] : null);
  if (reusableFilePanelId) {
    return activateExistingFilePanel(state, reusableFilePanelId, options);
  }

  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${FILES_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    filePanelIds: [...state.filePanelIds, panelId],
    filePanels: {
      ...state.filePanels,
      [panelId]: {
        id: panelId,
        filePreviewPath: hasPanelPathOption(options) ? options.path ?? null : null,
        filePreviewRequestId: options.requestId ?? 0,
        filePreviewRevealTarget: options.revealTarget ?? null,
      },
    },
    initialPanelIds: activeInitialPanelId
      ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
      : state.initialPanelIds,
    nextPanelSeq,
  };
}

function activateExistingFilePanel(
  state: RightSidebarScopePanelState,
  panelId: string,
  options: { path?: string | null; requestId?: number; revealTarget?: PreviewFileRevealTarget | null },
): RightSidebarScopePanelState {
  const panel = state.filePanels[panelId];
  if (!panel) {
    return state;
  }
  if (!hasPanelPathOption(options) && !options.requestId) {
    return { ...state, activePanelId: panelId };
  }
  return {
    ...state,
    activePanelId: panelId,
    filePanels: {
      ...state.filePanels,
      [panelId]: {
        ...panel,
        filePreviewPath: hasPanelPathOption(options) ? options.path ?? null : panel.filePreviewPath,
        filePreviewRequestId: options.requestId
          ? Math.max(panel.filePreviewRequestId + 1, options.requestId)
          : panel.filePreviewRequestId,
        filePreviewRevealTarget: Object.prototype.hasOwnProperty.call(options, "revealTarget")
          ? options.revealTarget ?? null
          : panel.filePreviewRevealTarget,
      },
    },
  };
}

function activeFilePanelIdForState(state: RightSidebarScopePanelState): string | null {
  return state.activePanelId && state.filePanels[state.activePanelId] ? state.activePanelId : null;
}

function activeInitialPanelIdForState(state: RightSidebarScopePanelState): string | null {
  return state.activePanelId && state.initialPanelIds.includes(state.activePanelId) ? state.activePanelId : null;
}

function activateOrCreateConversationPanel(
  state: RightSidebarScopePanelState,
  options: {
    session: AgentSession;
    title?: string | null;
    sourceSessionId?: string | null;
  },
): RightSidebarScopePanelState {
  const sessionId = options.session.id.trim();
  if (!sessionId) {
    return state;
  }
  const existingPanelId =
    state.conversationPanelIds.find((panelId) => state.conversationPanels[panelId]?.sessionId === sessionId) ?? null;
  if (existingPanelId) {
    return activateExistingConversationPanel(state, existingPanelId, options);
  }

  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${CONVERSATION_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    conversationPanelIds: [...state.conversationPanelIds, panelId],
    conversationPanels: {
      ...state.conversationPanels,
      [panelId]: conversationPanelState(panelId, options),
    },
    initialPanelIds: activeInitialPanelId
      ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
      : state.initialPanelIds,
    nextPanelSeq,
  };
}

function activateExistingConversationPanel(
  state: RightSidebarScopePanelState,
  panelId: string,
  options: {
    session: AgentSession;
    title?: string | null;
    sourceSessionId?: string | null;
  },
): RightSidebarScopePanelState {
  const panel = state.conversationPanels[panelId];
  if (!panel) {
    return state;
  }
  return {
    ...state,
    activePanelId: panelId,
    conversationPanels: {
      ...state.conversationPanels,
      [panelId]: {
        ...panel,
        title: conversationPanelTitle(options),
        sourceSessionId: options.sourceSessionId ?? panel.sourceSessionId,
      },
    },
  };
}

function conversationPanelState(
  panelId: string,
  options: {
    session: AgentSession;
    title?: string | null;
    sourceSessionId?: string | null;
  },
): RightSidebarConversationPanelState {
  return {
    id: panelId,
    sessionId: options.session.id,
    title: conversationPanelTitle(options),
    sourceSessionId: options.sourceSessionId ?? null,
  };
}

function conversationPanelTitle(options: { session: AgentSession; title?: string | null }): string {
  return options.title?.trim() || options.session.title?.trim() || BTW_CONVERSATION_TITLE;
}

function orderedRightSidebarPanelIds(state: RightSidebarScopePanelState, entryIds: string[]): string[] {
  return orderedUniquePanelIds(state.panelOrder, [
    ...state.filePanelIds,
    ...state.conversationPanelIds,
    ...state.initialPanelIds,
    ...entryIds,
  ]);
}

function orderedUniquePanelIds(preferredOrder: string[], panelIds: string[]): string[] {
  const availableIds = new Set(panelIds);
  const orderedIds = preferredOrder.filter((id) => availableIds.delete(id));
  return [...orderedIds, ...panelIds.filter((id) => availableIds.delete(id))];
}

function appendPanelOrder(panelOrder: string[], panelId: string): string[] {
  return panelOrder.includes(panelId) ? panelOrder : [...panelOrder, panelId];
}

function nextPanelIdAfterRemoval(panelOrder: string[], removedPanelId: string): string | null {
  const panelIndex = panelOrder.indexOf(removedPanelId);
  const remainingPanelOrder = panelOrder.filter((id) => id !== removedPanelId);
  if (remainingPanelOrder.length === 0) {
    return null;
  }
  if (panelIndex === -1) {
    return remainingPanelOrder[0] ?? null;
  }
  return remainingPanelOrder[Math.max(0, Math.min(panelIndex, remainingPanelOrder.length - 1))] ?? null;
}

function hasPanelPathOption(options: { path?: string | null }): boolean {
  return Object.prototype.hasOwnProperty.call(options, "path");
}

function maxPanelSeq(panelIds: string[]): number {
  return panelIds.reduce((maxSeq, panelId) => {
    const prefix = panelSeqPrefix(panelId);
    if (!panelId.startsWith(prefix)) {
      return maxSeq;
    }
    const seq = Number(panelId.slice(prefix.length));
    return Number.isFinite(seq) ? Math.max(maxSeq, seq) : maxSeq;
  }, 0);
}

function panelSeqPrefix(panelId: string): string {
  if (panelId.startsWith(INITIAL_PANEL_ID_PREFIX)) {
    return INITIAL_PANEL_ID_PREFIX;
  }
  if (panelId.startsWith(CONVERSATION_PANEL_ID_PREFIX)) {
    return CONVERSATION_PANEL_ID_PREFIX;
  }
  return FILES_PANEL_ID_PREFIX;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFilePanels(left: RightSidebarScopePanelState, right: RightSidebarScopePanelState): boolean {
  return left.filePanelIds.every((panelId) => {
    const leftPanel = left.filePanels[panelId];
    const rightPanel = right.filePanels[panelId];
    return (
      Boolean(leftPanel) &&
      Boolean(rightPanel) &&
      leftPanel.filePreviewPath === rightPanel.filePreviewPath &&
      leftPanel.filePreviewRequestId === rightPanel.filePreviewRequestId &&
      samePreviewFileRevealTarget(leftPanel.filePreviewRevealTarget, rightPanel.filePreviewRevealTarget)
    );
  });
}

function sameConversationPanels(left: RightSidebarScopePanelState, right: RightSidebarScopePanelState): boolean {
  return left.conversationPanelIds.every((panelId) => {
    const leftPanel = left.conversationPanels[panelId];
    const rightPanel = right.conversationPanels[panelId];
    return (
      Boolean(leftPanel) &&
      Boolean(rightPanel) &&
      leftPanel.sessionId === rightPanel.sessionId &&
      leftPanel.title === rightPanel.title &&
      leftPanel.sourceSessionId === rightPanel.sourceSessionId
    );
  });
}

function samePreviewFileRevealTarget(
  left: PreviewFileRevealTarget | null | undefined,
  right: PreviewFileRevealTarget | null | undefined,
): boolean {
  return (
    (left?.selectedText ?? null) === (right?.selectedText ?? null) &&
    (left?.lineStart ?? null) === (right?.lineStart ?? null) &&
    (left?.lineEnd ?? null) === (right?.lineEnd ?? null) &&
    (left?.sourceStart ?? null) === (right?.sourceStart ?? null) &&
    (left?.sourceEnd ?? null) === (right?.sourceEnd ?? null)
  );
}

function initialPanelTitle(panelId: string): string {
  return "新tab";
}

function resolveSessionPath(sessionId: string, getSessionPath?: (sessionId: string) => string): string {
  return getSessionPath?.(sessionId) ?? `/guid/${encodeURIComponent(sessionId)}`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "操作失败";
}

function RightSidebarControls({
  maximized,
  placement,
  onClose,
  onMaximize,
  onRestore,
}: {
  maximized: boolean;
  placement: RightSidebarPlacement;
  onClose: () => void;
  onMaximize: () => void;
  onRestore: () => void;
}) {
  const onLeft = placement === "left";
  const placementLabel = onLeft ? "左侧栏" : "右侧栏";
  const CloseIcon = onLeft ? PanelLeftClose : PanelRightClose;

  return (
    <>
      <button
        className={styles.rightSidebarIconButton}
        data-icon={maximized ? "minimize-2" : "maximize-2"}
        type="button"
        aria-label={maximized ? `缩小${placementLabel}` : `展开${placementLabel}到对话区域`}
        title={maximized ? `缩小${placementLabel}` : `展开${placementLabel}到对话区域`}
        onClick={maximized ? onRestore : onMaximize}
      >
        {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
      <button
        className={styles.rightSidebarIconButton}
        data-icon={onLeft ? "panel-left-close" : "panel-right-close"}
        type="button"
        aria-label={`折叠${placementLabel}`}
        title={`折叠${placementLabel}`}
        onClick={onClose}
      >
        <CloseIcon size={17} strokeWidth={2.1} />
      </button>
    </>
  );
}
