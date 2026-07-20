import {
  Bot,
  FileDiff,
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
  SquareTerminal,
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
  type MouseEvent as ReactMouseEvent,
  type PropsWithChildren,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useHeldActiveFlag } from "@/renderer/hooks/useHeldActiveFlag";
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
  type ReviewPanelRequest,
} from "@/renderer/providers/PreviewProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { useOptionalActiveProjectState } from "@/renderer/providers/ActiveProjectProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { ConnectionStatus } from "@/renderer/components/runtime";
import { LoadingSkeleton } from "@/renderer/components/loading";
import { AgentReviewDiffPanel } from "@/renderer/components/review/AgentReviewDiffPanel";
import type { KeydexDiffDocument } from "@/renderer/components/diff/model";
import {
  GitToolWindow,
  type GitProjectSelectorProps,
} from "@/renderer/features/git/components/GitToolWindow";
import type { WorkspaceSelection } from "@/renderer/components/workspace";
import {
  activeProjectDiscoveryFromWorkspace,
  usePublishActiveProjectDiscovery,
} from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { A2UIRenderSuspensionProvider } from "@/renderer/pages/conversation/messages/a2ui/A2UIRenderSuspensionContext";
import type { SelectedQuote } from "@/renderer/components/chat/SendBox";
import type { FileReviewChange } from "@/renderer/utils/fileReview";
import {
  gitPath,
  parseWorkbenchPath,
  workbenchGitPath,
  type AppMode,
} from "@/renderer/components/layout/appMode";
import {
  BTW_CONVERSATION_TITLE,
  createBtwConversationFromSession,
} from "@/renderer/pages/conversation/conversationForkSource";
import type { AgentSession, Workspace } from "@/types/protocol";
import type { SubagentRunSnapshot } from "@/types/subagents";
import {
  SubagentInvocationDetail,
  SubagentPanelHeader,
  SubagentRunList,
} from "@/renderer/pages/conversation/subagents/SubagentSidebarPanel";
import {
  selectRunningTerminalCount,
  TerminalDock,
  useTerminal,
  useTerminalStore,
} from "@/renderer/features/terminal";

import { RightSidebarResizeHandle } from "./RightSidebarResizeHandle";
import { RightSidebarInitialPage } from "./RightSidebarInitialPage";
import {
  RightSidebarConversationContext,
  useOptionalRightSidebarConversation,
  type OpenBtwConversationRequest,
  type OpenRightSidebarConversationRequest,
  type SubagentInvocationPanelDetails,
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
const REVIEW_PANEL_ID_PREFIX = "right-sidebar:review:";
const GLOBAL_RIGHT_SIDEBAR_SCOPE = "global";
const APP_MODE_SWITCH_NAVIGATION_DELAY_MS = 180;
const FULL_CONTENT_MIN_WIDTH = 420;
const RATIO_PRECISION = 1000;
const RIGHT_SIDEBAR_TAB_MENU_WIDTH = 148;
const RIGHT_SIDEBAR_TAB_MENU_HEIGHT = 136;
const RIGHT_SIDEBAR_TAB_MENU_EDGE = 8;
const AGENT_GIT_PROJECT_PRIORITY = 100;

interface LayoutUiState {
  rightSidebarMode: "split" | "maximized";
  rightSidebarPanelStateByScope: Record<string, RightSidebarScopePanelState>;
}

interface RightSidebarFilePanelState {
  id: string;
  filePreviewPath: string | null;
  filePreviewRequestId: number;
  filePreviewRevealTarget: PreviewFileRevealTarget | null;
  directoryRevealPath: string | null;
  directoryRevealRequestId: number;
}

interface RightSidebarConversationPanelState {
  id: string;
  kind: "conversation" | "subagent";
  status: "opening" | "ready";
  sessionId: string;
  title: string;
  sourceSessionId: string | null;
  parentSessionId: string | null;
  quoteRequest: RightSidebarConversationQuoteRequest | null;
  loadedHistoryTurnCount: number | null;
  subagentRun: SubagentRunSnapshot | null;
  subagentInvocation: SubagentInvocationPanelDetails | null;
}

interface RightSidebarReviewPanelState {
  id: string;
  title: string;
  files: FileReviewChange[];
  document: KeydexDiffDocument | null;
  focusedPath: string | null;
  panelKey: string;
  sourceMessageId: string | null;
  toolCallId: string | null;
  requestId: number;
}

interface RightSidebarConversationQuoteRequest {
  requestId: number;
  quote: SelectedQuote;
}

interface RightSidebarScopePanelState {
  activePanelId: string | null;
  panelOrder: string[];
  filePanelIds: string[];
  filePanels: Record<string, RightSidebarFilePanelState>;
  conversationPanelIds: string[];
  conversationPanels: Record<string, RightSidebarConversationPanelState>;
  reviewPanelIds: string[];
  reviewPanels: Record<string, RightSidebarReviewPanelState>;
  initialPanelIds: string[];
  nextPanelSeq: number;
}

interface RightSidebarTabMenuState {
  panelId: string;
  position: CSSProperties;
}

const EMPTY_RIGHT_SIDEBAR_SCOPE_STATE: RightSidebarScopePanelState = {
  activePanelId: null,
  panelOrder: [],
  filePanelIds: [],
  filePanels: {},
  conversationPanelIds: [],
  conversationPanels: {},
  reviewPanelIds: [],
  reviewPanels: {},
  initialPanelIds: [],
  nextPanelSeq: 0,
};
let layoutUiStateCacheByRuntime = new WeakMap<RuntimeBridge, Map<string, LayoutUiState>>();

export function resetLayoutUiStateCacheForTests(): void {
  layoutUiStateCacheByRuntime = new WeakMap<RuntimeBridge, Map<string, LayoutUiState>>();
}

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

function layoutUiStateCacheForRuntime(runtime: RuntimeBridge): Map<string, LayoutUiState> {
  const current = layoutUiStateCacheByRuntime.get(runtime);
  if (current) {
    return current;
  }
  const next = new Map<string, LayoutUiState>();
  layoutUiStateCacheByRuntime.set(runtime, next);
  return next;
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

function sameNavigationPath(left: string | undefined, right: string | undefined): boolean {
  return navigationPathname(left) === navigationPathname(right);
}

function navigationPathname(path: string | undefined): string {
  return path?.split(/[?#]/u, 1)[0]?.replace(/\/+$/u, "") ?? "";
}

function isSessionNavigationPath(path: string): boolean {
  const pathname = navigationPathname(path);
  if (/^\/conversation\/[^/]+$/u.test(pathname)) {
    return true;
  }
  return Boolean(parseWorkbenchPath(pathname)?.sessionId);
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
  archiveActiveFallbackPath?: string;
  workspaceArchiveFallbackPath?: string;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  workbenchWorkspaceSelector?: WorkbenchWorkspaceSelectorProps;
  routePrimarySurface?: "content" | "git";
  routeGitNavigation?: boolean;
  resetRightSidebarKey?: string;
  onNavigate?: (path: string) => void;
}

interface PendingSessionNavigation {
  sourcePath: string;
  targetPath: string;
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
  archiveActiveFallbackPath,
  workspaceArchiveFallbackPath,
  getSessionPath,
  getWorkspaceNewConversationPath,
  workbenchWorkspaceSelector,
  routePrimarySurface,
  routeGitNavigation = false,
  resetRightSidebarKey,
  onNavigate,
}: LayoutProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const previewContext = useOptionalPreview();
  // Conversation timeline units live in retained React roots, so their sidebar
  // callbacks can outlive the render that supplied them. Resolve the host scope
  // when an action runs instead of pinning it inside that retained callback.
  const activeRightSidebarScopeKeyRef = useRef(
    previewContext?.activeScopeKey ?? GLOBAL_RIGHT_SIDEBAR_SCOPE,
  );
  activeRightSidebarScopeKeyRef.current =
    previewContext?.activeScopeKey ?? GLOBAL_RIGHT_SIDEBAR_SCOPE;
  const lastPreviewOpenStampRef = useRef<string | null>(
    previewContext?.open ? previewOpenStamp(previewContext.activeEntry) : null,
  );
  const lastPreviewCollapseRequestRef = useRef(previewContext?.collapseRequestId ?? 0);
  const lastFilePanelOpenRequestRef = useRef(previewContext?.filePanelRequest?.requestId ?? 0);
  const lastReviewPanelOpenRequestRef = useRef(previewContext?.reviewPanelRequest?.requestId ?? 0);
  const lastPreviewScopeKeyRef = useRef<string | null>(previewContext?.activeScopeKey ?? null);
  const lastRightSidebarResetKeyRef = useRef<string | null>(null);
  const appModeNavigationTimerRef = useRef<number | null>(null);
  const shellWidthRef = useRef(initialShellWidth());
  const shellMeasureFrameRef = useRef<number | null>(null);
  const layoutUiStateCache = layoutUiStateCacheForRuntime(runtime);
  const initialLayoutUiStateRef = useRef<LayoutUiState | null | undefined>(undefined);
  if (initialLayoutUiStateRef.current === undefined) {
    initialLayoutUiStateRef.current = layoutUiStateCache.get("main") ?? null;
  }
  const initialLayoutUiState = initialLayoutUiStateRef.current;
  const [rightSidebarMode, setRightSidebarMode] = useState<"split" | "maximized">(
    initialLayoutUiState?.rightSidebarMode ?? "split",
  );
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const [rightSidebarResizeActive, setRightSidebarResizeActive] = useState(false);
  const [localPrimarySurface, setLocalPrimarySurface] = useState<"content" | "git">("content");
  const [pendingSessionNavigation, setPendingSessionNavigation] = useState<PendingSessionNavigation | null>(null);
  const sessionNavigationPending = Boolean(
    pendingSessionNavigation
      && sameNavigationPath(activePath, pendingSessionNavigation.sourcePath)
      && !sameNavigationPath(activePath, pendingSessionNavigation.targetPath),
  );
  const pendingSessionPath = sessionNavigationPending ? pendingSessionNavigation?.targetPath : undefined;
  const shellActivePath = pendingSessionPath ?? activePath;
  const primarySurface = sessionNavigationPending ? "content" : (routePrimarySurface ?? localPrimarySurface);
  const [gitSurfaceRetained, setGitSurfaceRetained] = useState(primarySurface === "git");
  const gitSurfaceMounted = gitSurfaceRetained || primarySurface === "git";
  const [agentGitWorkspaces, setAgentGitWorkspaces] = useState<Workspace[]>([]);
  const [agentGitWorkspacesLoading, setAgentGitWorkspacesLoading] = useState(false);
  const [agentGitWorkspaceCatalogLoaded, setAgentGitWorkspaceCatalogLoaded] = useState(false);
  const [agentGitOverrideWorkspace, setAgentGitOverrideWorkspace] = useState<Workspace | null>(null);
  const [rightSidebarPanelStateByScope, setRightSidebarPanelStateByScope] = useState<
    Record<string, RightSidebarScopePanelState>
  >(initialLayoutUiState?.rightSidebarPanelStateByScope ?? {});
  const [productShowcasePhase, setProductShowcasePhase] = useState<ProductShowcaseOverlayPhase | null>(null);
  const { state, actions } = useLayoutState();
  const runtimeConnection = useOptionalRuntimeConnection();
  const activeProjectState = useOptionalActiveProjectState();
  const notifications = useNotifications();
  const { available: terminalAvailable, scope: terminalScope, store: terminalStore } = useTerminal();
  const terminalDockOpen = useTerminalStore((terminalState) => terminalState.ui.dockOpen);
  const terminalDockHeight = useTerminalStore((terminalState) => terminalState.ui.dockHeight);
  const runningTerminalCount = useTerminalStore((terminalState) =>
    selectRunningTerminalCount(terminalState, terminalScope.sessionId),
  );
  useEffect(() => {
    if (primarySurface === "git") setGitSurfaceRetained(true);
  }, [primarySurface]);
  useEffect(() => {
    setPendingSessionNavigation((current) => {
      if (!current || sameNavigationPath(activePath, current.sourcePath)) {
        return current;
      }
      return null;
    });
  }, [activePath]);
  const agentGitOverrideDiscovery = useMemo(
    () => activeProjectDiscoveryFromWorkspace(agentGitOverrideWorkspace, false),
    [agentGitOverrideWorkspace],
  );
  usePublishActiveProjectDiscovery(
    "git-panel-agent-selector",
    agentGitOverrideDiscovery,
    !routeGitNavigation
      && appMode === "agent"
      && primarySurface === "git"
      && agentGitOverrideWorkspace !== null,
    AGENT_GIT_PROJECT_PRIORITY,
  );
  const collapsed = state.sidebarCollapsed;
  const sidebarEnabled = appMode !== "project";
  const globalRightSidebarEnabled = appMode === "agent";
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
  const rightSidebarOpenRef = useRef(state.rightSidebarOpen);
  const rightSidebarRatioRef = useRef(state.rightSidebarRatio);
  const guardContentMinWidthRef = useRef(guardContentMinWidth);
  activeSidebarWidthRef.current = activeSidebarWidth;
  rightSidebarOpenRef.current = state.rightSidebarOpen;
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
  const a2uiRenderSuspendedForLayoutResize = useHeldActiveFlag(
    sidebarResizeActive || rightSidebarResizeActive,
    180,
  );
  const getRightSidebarMaxRatio = useCallback(
    (availableWidth: number) => maxRightSidebarRatioWithContentGuard(availableWidth, guardContentMinWidthRef.current),
    [],
  );
  const previewSidebarWidth = useCallback(
    (width: number) => setLivePanelWidth("--sidebar-width", width),
    [setLivePanelWidth],
  );
  const setSidebarResizing = useCallback((resizing: boolean) => {
    setSidebarResizeActive((current) => (current === resizing ? current : resizing));
  }, []);
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
    setRightSidebarResizeActive((current) => (current === resizing ? current : resizing));
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
    layoutUiStateCache.set("main", {
      rightSidebarMode,
      rightSidebarPanelStateByScope,
    });
  }, [layoutUiStateCache, rightSidebarMode, rightSidebarPanelStateByScope]);

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
    const reviewPanelRequest = previewContext?.reviewPanelRequest ?? null;
    if (reviewPanelRequest?.requestId && reviewPanelRequest.scopeKey === activeScopeKey) {
      lastReviewPanelOpenRequestRef.current = reviewPanelRequest.requestId;
    }
  }, [
    previewContext?.activeEntry,
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.scopeKey,
    previewContext?.open,
    previewContext?.reviewPanelRequest?.requestId,
    previewContext?.reviewPanelRequest?.scopeKey,
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

  useEffect(() => {
    const reviewPanelRequest = previewContext?.reviewPanelRequest ?? null;
    if (
      !reviewPanelRequest?.requestId ||
      reviewPanelRequest.requestId === lastReviewPanelOpenRequestRef.current ||
      reviewPanelRequest.scopeKey !== previewContext?.activeScopeKey
    ) {
      return;
    }
    lastReviewPanelOpenRequestRef.current = reviewPanelRequest.requestId;
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
    previewContext?.reviewPanelRequest?.requestId,
    previewContext?.reviewPanelRequest?.scopeKey,
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
    if (!rightSidebarOpenRef.current) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [actions, globalRightSidebarEnabled, startRightSidebarMotion]);

  const gitEnabled = Boolean(activeProjectState && activeProjectState.status !== "none");
  const openGitToolWindow = useCallback(() => {
    if (!gitEnabled) {
      return;
    }
    closeRightSidebar();
    if (routeGitNavigation && activeProjectState && activeProjectState.status !== "none") {
      onNavigate?.(
        appMode === "workbench"
          ? workbenchGitPath(activeProjectState.workspaceId)
          : gitPath(activeProjectState.workspaceId),
      );
      return;
    }
    setLocalPrimarySurface("git");
  }, [activeProjectState, appMode, closeRightSidebar, gitEnabled, onNavigate, routeGitNavigation]);

  useEffect(() => {
    if (
      appMode !== "agent"
      || primarySurface !== "git"
      || agentGitWorkspaceCatalogLoaded
    ) {
      return;
    }
    let active = true;
    setAgentGitWorkspacesLoading(true);
    void runtime.workspaces
      .list()
      .then((response) => {
        if (!active) return;
        setAgentGitWorkspaces(response.list.filter((workspace) => workspace.archived_at === null));
        setAgentGitWorkspaceCatalogLoaded(true);
        setAgentGitWorkspacesLoading(false);
      })
      .catch((reason) => {
        if (!active) return;
        notifications.error(errorMessage(reason));
        setAgentGitWorkspacesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    agentGitWorkspaceCatalogLoaded,
    appMode,
    notifications,
    primarySurface,
    runtime,
  ]);

  useEffect(() => {
    if (appMode !== "agent" || primarySurface !== "git") {
      setAgentGitOverrideWorkspace(null);
    }
  }, [appMode, primarySurface]);

  const agentGitProjectSelection = useMemo<WorkspaceSelection>(() => {
    if (agentGitOverrideWorkspace) {
      return { type: "workspace", workspace: agentGitOverrideWorkspace };
    }
    if (activeProjectState && activeProjectState.status !== "none") {
      const activeWorkspace = agentGitWorkspaces.find(
        (workspace) => workspace.id === activeProjectState.workspaceId,
      );
      if (activeWorkspace) {
        return { type: "workspace", workspace: activeWorkspace };
      }
      return {
        type: "pending",
        rootPath: activeProjectState.projectPath,
        name: activeProjectState.name,
      };
    }
    return { type: "chat" };
  }, [activeProjectState, agentGitOverrideWorkspace, agentGitWorkspaces]);

  const selectAgentGitWorkspace = useCallback((workspace: Workspace) => {
    if (routeGitNavigation) {
      onNavigate?.(gitPath(workspace.id));
      return;
    }
    setAgentGitOverrideWorkspace(workspace);
  }, [onNavigate, routeGitNavigation]);

  const gitProjectSelector = useMemo<GitProjectSelectorProps | undefined>(() => {
    if (appMode === "workbench") {
      return workbenchWorkspaceSelector;
    }
    if (appMode !== "agent") {
      return undefined;
    }
    return {
      value: agentGitProjectSelection,
      workspaces: agentGitWorkspaces,
      loading: agentGitWorkspacesLoading,
      onSelectWorkspace: selectAgentGitWorkspace,
    };
  }, [
    agentGitProjectSelection,
    agentGitWorkspaces,
    agentGitWorkspacesLoading,
    appMode,
    selectAgentGitWorkspace,
    workbenchWorkspaceSelector,
  ]);

  const openConversationPanel = useCallback(
    (request: OpenRightSidebarConversationRequest) => {
      const session = request.session;
      if (!session?.id) {
        return;
      }
      const scopeKey = activeRightSidebarScopeKeyRef.current;
      setRightSidebarPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
        const next = activateOrCreateConversationPanel(previous, {
          session,
          title: request.title,
          sourceSessionId: request.sourceSessionId,
          quote: request.quote,
          loadedHistoryTurnCount: request.loadedHistoryTurnCount,
        });
        if (sameRightSidebarScopePanelState(previous, next)) {
          return current;
        }
        return { ...current, [scopeKey]: next };
      });
      openRightSidebar();
    },
    [openRightSidebar],
  );

  const openSubagentPanel = useCallback(
    (run: SubagentRunSnapshot) => {
      const scopeKey = activeRightSidebarScopeKeyRef.current;
      setRightSidebarPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
        const next = activateOrCreateSubagentPanel(previous, run);
        if (sameRightSidebarScopePanelState(previous, next)) return current;
        return { ...current, [scopeKey]: next };
      });
      openRightSidebar();
    },
    [openRightSidebar],
  );

  const openSubagentList = useCallback(
    (parentSessionId: string) => {
      const cleanedParentId = parentSessionId.trim();
      if (!cleanedParentId) return;
      const scopeKey = activeRightSidebarScopeKeyRef.current;
      setRightSidebarPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
        const next = activateOrCreateSubagentList(previous, cleanedParentId);
        if (sameRightSidebarScopePanelState(previous, next)) return current;
        return { ...current, [scopeKey]: next };
      });
      openRightSidebar();
    },
    [openRightSidebar],
  );

  const openSubagentInvocationPanel = useCallback(
    (details: SubagentInvocationPanelDetails) => {
      if (!details.parentSessionId.trim() || !details.invocationId.trim()) return;
      const scopeKey = activeRightSidebarScopeKeyRef.current;
      setRightSidebarPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
        const next = activateOrCreateSubagentInvocationPanel(previous, details);
        if (sameRightSidebarScopePanelState(previous, next)) return current;
        return { ...current, [scopeKey]: next };
      });
      openRightSidebar();
    },
    [openRightSidebar],
  );

  const removeConversationPanel = useCallback((scopeKey: string, panelId: string) => {
    setRightSidebarPanelStateByScope((current) => {
      const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
      const next = removeConversationPanelFromState(previous, panelId);
      if (sameRightSidebarScopePanelState(previous, next)) {
        return current;
      }
      return { ...current, [scopeKey]: next };
    });
  }, []);

  const openBtwConversationFromSession = useCallback(
    async ({ sessionId, runtime: requestRuntime, quote }: OpenBtwConversationRequest) => {
      const cleanedSessionId = sessionId.trim();
      if (!cleanedSessionId) {
        notifications.warning("当前会话无法开启旁路对话");
        return null;
      }
      const scopeKey = activeRightSidebarScopeKeyRef.current;
      let openingPanelId: string | null = null;
      flushSync(() => {
        setRightSidebarPanelStateByScope((current) => {
          const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
          const { panelId, state: next } = activateOrCreateOpeningConversationPanel(previous, {
            sourceSessionId: cleanedSessionId,
            quote,
          });
          openingPanelId = panelId;
          if (sameRightSidebarScopePanelState(previous, next)) {
            return current;
          }
          return { ...current, [scopeKey]: next };
        });
        openRightSidebar();
      });
      try {
        const result = await createBtwConversationFromSession(requestRuntime, cleanedSessionId);
        if ("error" in result) {
          if (openingPanelId) {
            removeConversationPanel(scopeKey, openingPanelId);
          }
          notifications.warning(result.message);
          return null;
        }
        let resolvedPanel = false;
        const panelId = openingPanelId;
        if (panelId) {
          setRightSidebarPanelStateByScope((current) => {
            const previous = normalizeRightSidebarScopePanelState(current[scopeKey]);
            const next = resolveOpeningConversationPanel(previous, panelId, {
              session: result.session,
              sourceSessionId: cleanedSessionId,
              title: result.session.title || BTW_CONVERSATION_TITLE,
              loadedHistoryTurnCount: result.loadedHistoryTurnCount,
            });
            resolvedPanel = !sameRightSidebarScopePanelState(previous, next);
            if (!resolvedPanel) {
              return current;
            }
            return { ...current, [scopeKey]: next };
          });
        }
        if (resolvedPanel) {
          notifications.success("已打开旁路对话");
        }
        return result.session;
      } catch (reason) {
        if (openingPanelId) {
          removeConversationPanel(scopeKey, openingPanelId);
        }
        notifications.error(`旁路对话创建失败：${errorMessage(reason)}`);
        return null;
      }
    },
    [notifications, openRightSidebar, removeConversationPanel],
  );

  const rightSidebarConversationValue = useMemo(
    () => ({
      openConversationPanel,
      openSubagentList,
      openSubagentPanel,
      openSubagentInvocationPanel,
      openBtwConversationFromSession,
    }),
    [
      openBtwConversationFromSession,
      openConversationPanel,
      openSubagentInvocationPanel,
      openSubagentList,
      openSubagentPanel,
    ],
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
      setPendingSessionNavigation(
        isSessionNavigationPath(path) && !sameNavigationPath(activePath, path)
          ? { sourcePath: activePath ?? "", targetPath: path }
          : null,
      );
      setLocalPrimarySurface("content");
      if (path === "/guid" || path.startsWith("/guid?")) {
        closeRightSidebar();
      }
      onNavigate?.(path);
    },
    [activePath, closeRightSidebar, onNavigate],
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
      setLocalPrimarySurface("content");
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
    if (!gitEnabled && routePrimarySurface === undefined) {
      setLocalPrimarySurface("content");
    }
  }, [gitEnabled, routePrimarySurface]);

  useEffect(() => {
    if (!resetRightSidebarKey || lastRightSidebarResetKeyRef.current === resetRightSidebarKey) {
      return;
    }
    lastRightSidebarResetKeyRef.current = resetRightSidebarKey;
    closeRightSidebar();
  }, [closeRightSidebar, resetRightSidebarKey]);

  const rightSidebarAvailable = globalRightSidebarEnabled && primarySurface !== "git";
  const rightSidebarOpen = rightSidebarAvailable && state.rightSidebarOpen;
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
        data-primary-surface={primarySurface}
        data-session-navigation-pending={sessionNavigationPending ? "true" : "false"}
        data-sidebar={collapsed ? "collapsed" : "expanded"}
        data-sidebar-motion={sidebarMotion ? "true" : "false"}
        data-right-sidebar={rightSidebarOpen ? "open" : "closed"}
        data-right-sidebar-enabled={rightSidebarAvailable ? "true" : "false"}
        data-right-sidebar-mode={rightSidebarMaximized ? "maximized" : "split"}
        data-right-sidebar-motion={rightSidebarMotion ? "true" : "false"}
        data-right-sidebar-placement={state.rightSidebarPlacement}
        data-workspace={state.workspaceOpen ? "open" : "closed"}
        data-preview={state.previewOpen ? "open" : "closed"}
        data-terminal-dock={terminalDockOpen ? "open" : "closed"}
        style={
          {
            "--sidebar-width": `${state.sidebarWidth}px`,
            "--content-min-width": `${FULL_CONTENT_MIN_WIDTH}px`,
            "--right-sidebar-ratio": String(rightSidebarRatio),
            "--right-sidebar-width": `${rightSidebarWidth}px`,
            "--workspace-panel-width": `${state.workspaceWidth}px`,
            "--preview-panel-width": `${state.previewWidth}px`,
            "--terminal-dock-size": terminalDockOpen ? `${terminalDockHeight}px` : "0px",
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
          projectGitMenu={{ onOpenToolWindow: openGitToolWindow }}
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

        <A2UIRenderSuspensionProvider suspended={a2uiRenderSuspendedForLayoutResize}>
          <div className={styles.body}>
            {sidebarEnabled ? (
              <>
                <Sider
                  appMode={appMode}
                  runtime={runtime}
                  activePath={shellActivePath}
                  collapsed={collapsed}
                  projects={projects}
                  conversations={conversations}
                  showChatBucket={showChatBucket}
                  newConversationPath={newConversationPath}
                  archiveActiveFallbackPath={archiveActiveFallbackPath}
                  workspaceArchiveFallbackPath={workspaceArchiveFallbackPath}
                  getSessionPath={getSessionPath}
                  getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
                  gitActive={primarySurface === "git"}
                  gitEnabled={gitEnabled}
                  onToggleSidebar={toggleSidebar}
                  onOpenGit={openGitToolWindow}
                  onNavigate={navigateFromShell}
                />
                <SidebarResizeHandle
                  disabled={collapsed}
                  width={state.sidebarWidth}
                  onResizePreview={previewSidebarWidth}
                  onResize={actions.setSidebarWidth}
                  onResizeDragChange={setSidebarResizing}
                />
              </>
            ) : null}

            <section
              className={styles.content}
              data-content={primarySurface === "git" ? "git" : contentMode}
              aria-label="主内容区"
            >
              <div
                className={styles.readingColumn}
                data-content={contentMode}
                data-primary-content="conversation"
                hidden={primarySurface === "git"}
                aria-busy={sessionNavigationPending || undefined}
              >
                {sessionNavigationPending ? (
                  <LoadingSkeleton
                    aria-label="正在加载会话"
                    className={styles.sessionNavigationLoading}
                    lineCount={4}
                    testId="session-navigation-loading"
                  />
                ) : children}
              </div>
              {gitSurfaceMounted ? (
                <div className={styles.gitPrimarySurface} hidden={primarySurface !== "git"}>
                  <GitToolWindow
                    active={primarySurface === "git"}
                    project={activeProjectState}
                    maximized
                    projectSelector={gitProjectSelector}
                  />
                </div>
              ) : null}
            </section>
            <div className={styles.contentTopActions} data-testid="content-top-actions">
              <button
                id="terminal-content-action"
                className={styles.contentTopAction}
                type="button"
                aria-label={terminalDockOpen ? "收起终端" : "打开终端"}
                aria-pressed={terminalDockOpen}
                title={
                  !terminalAvailable
                    ? "内置终端仅在 Keydex 桌面客户端中可用"
                    : terminalScope.loading
                      ? "会话正在加载，终端暂不可用"
                      : !terminalScope.sessionId
                        ? "打开会话后可使用终端"
                        : "终端（Ctrl+`）"
                }
                disabled={!terminalAvailable || !terminalScope.sessionId || terminalScope.loading}
                data-active={terminalDockOpen ? "true" : "false"}
                data-running-count={runningTerminalCount}
                onClick={() => terminalStore.getState().setDockOpen(!terminalStore.getState().ui.dockOpen)}
              >
                <SquareTerminal size={17} strokeWidth={2.1} />
                {runningTerminalCount > 0 ? (
                  <span className={styles.terminalCountBadge} aria-hidden="true">
                    {runningTerminalCount}
                  </span>
                ) : null}
              </button>
              {rightSidebarAvailable && !rightSidebarOpen ? (
                <button
                  className={styles.contentTopAction}
                  data-icon={rightSidebarOnLeft ? "panel-left-open" : "panel-right-open"}
                  type="button"
                  aria-label={openRightSidebarLabel}
                  title={openRightSidebarLabel}
                  onClick={openRightSidebar}
                >
                  <OpenRightSidebarIcon size={17} strokeWidth={2.1} />
                </button>
              ) : null}
            </div>

            {rightSidebarAvailable ? (
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
                  a2uiRenderSuspended={a2uiRenderSuspendedForLayoutResize}
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
        </A2UIRenderSuspensionProvider>
        <TerminalDock />
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
  a2uiRenderSuspended,
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
  a2uiRenderSuspended: boolean;
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
  const rightSidebarTabMenuRef = useRef<HTMLDivElement | null>(null);
  const [rightSidebarTabMenu, setRightSidebarTabMenu] = useState<RightSidebarTabMenuState | null>(null);
  const request = previewContext?.open ? previewContext.request : null;
  const renderContext = previewContext?.activeRenderContext;
  const rawFilePanelRequest = previewContext?.filePanelRequest ?? null;
  const filePanelRequest =
    rawFilePanelRequest && rawFilePanelRequest.scopeKey === previewContext?.activeScopeKey
      ? rawFilePanelRequest
      : null;
  const rawReviewPanelRequest = previewContext?.reviewPanelRequest ?? null;
  const reviewPanelRequest =
    rawReviewPanelRequest && rawReviewPanelRequest.scopeKey === previewContext?.activeScopeKey
      ? rawReviewPanelRequest
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
  const reviewPanelIds = scopedPanelState.reviewPanelIds;
  const reviewPanels = scopedPanelState.reviewPanels;
  const initialPanelIds = scopedPanelState.initialPanelIds;
  const entryIds = entries.map((entry) => entry.id);
  const orderedPanelIds = orderedRightSidebarPanelIds(scopedPanelState, entryIds);
  const canOpenFiles = Boolean(
    filePanelRenderContext?.workspaceAvailable &&
      filePanelRenderContext?.runtime &&
      (filePanelRenderContext?.sessionId || filePanelRenderContext?.workspaceId),
  );
  const canOpenBtwConversation = Boolean(hostContext?.sessionId && hostContext.runtime);
  const canOpenSubagents = Boolean(hostContext?.sessionId);
  const canOpenReview = true;
  const resolvedActivePanelId = activePanelId ?? activeEntryId ?? orderedPanelIds[0] ?? null;
  const activeFilePanel = resolvedActivePanelId ? (filePanels[resolvedActivePanelId] ?? null) : null;
  const activeConversationPanel = resolvedActivePanelId ? (conversationPanels[resolvedActivePanelId] ?? null) : null;
  const activeReviewPanel = resolvedActivePanelId ? (reviewPanels[resolvedActivePanelId] ?? null) : null;
  const activePreviewEntry =
    resolvedActivePanelId &&
    !activeFilePanel &&
    !activeConversationPanel &&
    !activeReviewPanel &&
    !initialPanelIds.includes(resolvedActivePanelId)
      ? entries.find((entry) => entry.id === resolvedActivePanelId) ?? null
      : null;
  const activeRequest = activePreviewEntry?.request ?? (resolvedActivePanelId === activeEntryId ? request : null);
  const activeRenderContext = activePreviewEntry?.renderContext ?? renderContext;
  const activeRevealTarget = activePreviewEntry?.revealTarget ?? null;
  const activePreviewMarkdownView = useMemo(
    () => activePreviewEntry ? Object.freeze({
      ...activePreviewEntry.markdownView,
      viewId: "right-sidebar-preview",
      kind: "sidebar" as const,
    }) : undefined,
    [activePreviewEntry],
  );
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
  const showReviewPanel = Boolean(activeReviewPanel);
  const panelActivePreviewEntryId =
    open &&
    resolvedActivePanelId &&
    !activeFilePanel &&
    !activeConversationPanel &&
    !activeReviewPanel &&
    !initialPanelIds.includes(resolvedActivePanelId)
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

  const closeRightSidebarTabMenu = useCallback(() => {
    setRightSidebarTabMenu(null);
  }, []);

  const openRightSidebarTabMenu = useCallback((event: ReactMouseEvent<HTMLElement>, panelId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setRightSidebarTabMenu({
      panelId,
      position: rightSidebarTabMenuPosition(event.clientX, event.clientY),
    });
  }, []);

  useEffect(() => {
    if (!rightSidebarTabMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && rightSidebarTabMenuRef.current?.contains(target)) {
        return;
      }
      closeRightSidebarTabMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closeRightSidebarTabMenu, rightSidebarTabMenu]);

  useEffect(() => {
    if (!rightSidebarTabMenu) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRightSidebarTabMenu();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeRightSidebarTabMenu, rightSidebarTabMenu]);

  useEffect(() => {
    if (!rightSidebarTabMenu) {
      return;
    }
    window.addEventListener("resize", closeRightSidebarTabMenu);
    window.addEventListener("scroll", closeRightSidebarTabMenu, true);
    return () => {
      window.removeEventListener("resize", closeRightSidebarTabMenu);
      window.removeEventListener("scroll", closeRightSidebarTabMenu, true);
    };
  }, [closeRightSidebarTabMenu, rightSidebarTabMenu]);

  useEffect(() => {
    if (!open || (rightSidebarTabMenu && !orderedPanelIds.includes(rightSidebarTabMenu.panelId))) {
      closeRightSidebarTabMenu();
    }
  }, [closeRightSidebarTabMenu, open, orderedPanelIds, rightSidebarTabMenu]);

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
        ...(filePanelRequest?.directoryRevealPath ? {} : { path: filePanelRequest?.path ?? null }),
        requestId: filePanelRequestId,
        directoryRevealPath: filePanelRequest?.directoryRevealPath ?? null,
        revealTarget: filePanelRequest?.revealTarget ?? null,
        preferExisting: true,
      }),
    );
  }, [
    canOpenFiles,
    filePanelRequest?.directoryRevealPath,
    filePanelRequest?.path,
    filePanelRequest?.requestId,
    filePanelRequest?.revealTarget,
    updateActiveScopePanelState,
  ]);

  useEffect(() => {
    const reviewPanelRequestId = reviewPanelRequest?.requestId ?? 0;
    if (!reviewPanelRequest || !reviewPanelRequestId) {
      return;
    }
    updateActiveScopePanelState((current) =>
      activateOrCreateReviewPanel(current, reviewPanelRequest),
    );
  }, [reviewPanelRequest, updateActiveScopePanelState]);

  const openFilesPanel = useCallback(() => {
    if (!canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) => activateOrCreateFilePanel(current));
  }, [canOpenFiles, updateActiveScopePanelState]);

  const openReviewPanel = useCallback(() => {
    updateActiveScopePanelState((current) =>
      activateOrCreateReviewPanel(current, {
        requestId: 0,
        scopeKey: activeScopeKey,
        files: [],
        document: null,
        focusedPath: null,
        panelKey: "manual",
        sourceMessageId: null,
        title: "审阅",
        toolCallId: null,
        renderContext: null,
      }),
    );
  }, [activeScopeKey, updateActiveScopePanelState]);

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

  const openSubagentsFromHost = useCallback(() => {
    const sessionId = hostContext?.sessionId?.trim() ?? "";
    if (!sessionId) return;
    rightSidebarConversation?.openSubagentList(sessionId);
  }, [hostContext?.sessionId, rightSidebarConversation]);

  const closeFilesPanel = useCallback(
    (panelId: string) => {
      const remainingFilePanelIds = filePanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        entries.length === 0 &&
        initialPanelIds.length === 0 &&
        conversationPanelIds.length === 0 &&
        reviewPanelIds.length === 0 &&
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
          activePanelId:
            nextPanelId ??
            activeEntryId ??
            entries[0]?.id ??
            current.reviewPanelIds[0] ??
            current.conversationPanelIds[0] ??
            null,
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
      reviewPanelIds.length,
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
        reviewPanelIds.length === 0 &&
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
            current.reviewPanelIds[0] ??
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
      reviewPanelIds.length,
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

  const activateReviewPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) =>
        current.reviewPanels[panelId] ? { ...current, activePanelId: panelId } : current,
      );
    },
    [updateActiveScopePanelState],
  );

  const closeReviewPanel = useCallback(
    (panelId: string) => {
      const remainingReviewPanelIds = reviewPanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        resolvedActivePanelId === panelId &&
        remainingReviewPanelIds.length === 0 &&
        conversationPanelIds.length === 0 &&
        filePanelIds.length === 0 &&
        initialPanelIds.length === 0 &&
        entries.length === 0;
      updateActiveScopePanelState((current) => {
        const nextReviewPanelIds = current.reviewPanelIds.filter((id) => id !== panelId);
        const nextReviewPanels = { ...current.reviewPanels };
        delete nextReviewPanels[panelId];
        if (current.activePanelId !== panelId) {
          return {
            ...current,
            panelOrder: current.panelOrder.filter((id) => id !== panelId),
            reviewPanelIds: nextReviewPanelIds,
            reviewPanels: nextReviewPanels,
          };
        }
        const nextPanelId = nextPanelIdAfterRemoval(current.panelOrder, panelId);
        return {
          ...current,
          activePanelId:
            nextPanelId ??
            activeEntryId ??
            entries[0]?.id ??
            current.filePanelIds[0] ??
            nextReviewPanelIds[0] ??
            current.conversationPanelIds[0] ??
            null,
          panelOrder: current.panelOrder.filter((id) => id !== panelId),
          reviewPanelIds: nextReviewPanelIds,
          reviewPanels: nextReviewPanels,
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
      initialPanelIds.length,
      onClose,
      resolvedActivePanelId,
      reviewPanelIds,
      updateActiveScopePanelState,
    ],
  );

  const closeConversationPanel = useCallback(
    (panelId: string) => {
      const remainingConversationPanelIds = conversationPanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        resolvedActivePanelId === panelId &&
        remainingConversationPanelIds.length === 0 &&
        filePanelIds.length === 0 &&
        reviewPanelIds.length === 0 &&
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
          activePanelId:
            nextPanelId ??
            activeEntryId ??
            entries[0]?.id ??
            current.filePanelIds[0] ??
            current.reviewPanelIds[0] ??
            null,
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
      reviewPanelIds.length,
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
        reviewPanelIds.length === 0 &&
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
          activePanelId:
            nextPanelId ??
            activeEntryId ??
            entries[0]?.id ??
            current.filePanelIds[0] ??
            current.reviewPanelIds[0] ??
            current.conversationPanelIds[0] ??
            null,
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
      reviewPanelIds.length,
      updateActiveScopePanelState,
    ],
  );

  const closeRightSidebarPanels = useCallback(
    (panelIds: string[]) => {
      const closeSet = new Set(panelIds.filter((panelId) => orderedPanelIds.includes(panelId)));
      if (closeSet.size === 0) {
        return;
      }

      const remainingPanelIds = orderedPanelIds.filter((panelId) => !closeSet.has(panelId));
      entries.forEach((entry) => {
        if (closeSet.has(entry.id)) {
          previewContext?.closePreviewEntry(entry.id);
        }
      });
      updateActiveScopePanelState((current) => {
        const nextPanelOrder = current.panelOrder.filter((panelId) => !closeSet.has(panelId));
        const currentActivePanelId = current.activePanelId ?? resolvedActivePanelId;
        const remainingPanelIdSet = new Set(remainingPanelIds);
        const nextActivePanelId =
          currentActivePanelId && remainingPanelIdSet.has(currentActivePanelId)
            ? currentActivePanelId
            : nextPanelIdAfterBulkRemoval(orderedPanelIds, closeSet, currentActivePanelId) ?? null;
        return {
          ...current,
          activePanelId: nextActivePanelId,
          panelOrder: nextPanelOrder,
          filePanelIds: current.filePanelIds.filter((panelId) => !closeSet.has(panelId)),
          filePanels: omitRecordKeys(current.filePanels, closeSet),
          conversationPanelIds: current.conversationPanelIds.filter((panelId) => !closeSet.has(panelId)),
          conversationPanels: omitRecordKeys(current.conversationPanels, closeSet),
          reviewPanelIds: current.reviewPanelIds.filter((panelId) => !closeSet.has(panelId)),
          reviewPanels: omitRecordKeys(current.reviewPanels, closeSet),
          initialPanelIds: current.initialPanelIds.filter((panelId) => !closeSet.has(panelId)),
        };
      });
      if (remainingPanelIds.length === 0) {
        onClose();
      }
    },
    [entries, onClose, orderedPanelIds, previewContext, resolvedActivePanelId, updateActiveScopePanelState],
  );

  const rightSidebarTabMenuTargets = useMemo(() => {
    const panelId = rightSidebarTabMenu?.panelId ?? null;
    const panelIndex = panelId ? orderedPanelIds.indexOf(panelId) : -1;
    if (panelIndex < 0) {
      return {
        left: [],
        right: [],
        other: [],
        all: orderedPanelIds,
      };
    }
    return {
      left: orderedPanelIds.slice(0, panelIndex),
      right: orderedPanelIds.slice(panelIndex + 1),
      other: orderedPanelIds.filter((item) => item !== panelId),
      all: orderedPanelIds,
    };
  }, [orderedPanelIds, rightSidebarTabMenu?.panelId]);

  const closeRightSidebarTabMenuTargets = useCallback(
    (targets: string[]) => {
      closeRightSidebarTabMenu();
      closeRightSidebarPanels(targets);
    },
    [closeRightSidebarPanels, closeRightSidebarTabMenu],
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

  const updateReviewPanelFocusedPath = useCallback(
    (path: string) => {
      const panelId = activeReviewPanel?.id;
      if (!panelId) {
        return;
      }
      updateActiveScopePanelState((current) => {
        const panel = current.reviewPanels[panelId];
        if (!panel) {
          return current;
        }
        return {
          ...current,
          reviewPanels: {
            ...current.reviewPanels,
            [panelId]: {
              ...panel,
              focusedPath: path,
            },
          },
        };
      });
    },
    [activeReviewPanel?.id, updateActiveScopePanelState],
  );

  const openReviewFile = useCallback(
    (path: string) => {
      if (!canOpenFiles) {
        return;
      }
      previewContext?.openFilePanel(path, filePanelRenderContext ?? undefined);
    },
    [canOpenFiles, filePanelRenderContext, previewContext],
  );

  const handleConversationQuoteRequestHandled = useCallback(
    (panelId: string, requestId: number) => {
      updateActiveScopePanelState((current) => {
        const panel = current.conversationPanels[panelId];
        if (!panel?.quoteRequest || panel.quoteRequest.requestId !== requestId) {
          return current;
        }
        return {
          ...current,
          conversationPanels: {
            ...current.conversationPanels,
            [panelId]: {
              ...panel,
              quoteRequest: null,
            },
          },
        };
      });
    },
    [updateActiveScopePanelState],
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
                      <div
                        className={styles.rightSidebarTab}
                        data-active={active ? "true" : "false"}
                        data-app-context-menu="local"
                        data-menu-open={rightSidebarTabMenu?.panelId === panelId ? "true" : undefined}
                        key={panelId}
                        onContextMenu={(event) => openRightSidebarTabMenu(event, panelId)}
                      >
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => activateFilesPanel(panelId)}
                        >
                          <Folder size={12} />
                          <span>文件</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label="关闭侧边栏窗口 文件"
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
                    const ConversationIcon = conversationPanel.kind === "subagent" ? Bot : MessageSquare;
                    return (
                      <div
                        className={styles.rightSidebarTab}
                        data-active={active ? "true" : "false"}
                        data-app-context-menu="local"
                        data-menu-open={rightSidebarTabMenu?.panelId === panelId ? "true" : undefined}
                        key={panelId}
                        onContextMenu={(event) => openRightSidebarTabMenu(event, panelId)}
                      >
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => activateConversationPanel(panelId)}
                        >
                          <ConversationIcon size={12} />
                          <span>{title}</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label={`关闭侧边栏窗口 ${title}`}
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
                  const reviewPanel = reviewPanels[panelId];
                  if (reviewPanel) {
                    const active = resolvedActivePanelId === panelId;
                    const title = reviewPanel.title || "审阅";
                    return (
                      <div
                        className={styles.rightSidebarTab}
                        data-active={active ? "true" : "false"}
                        data-app-context-menu="local"
                        data-menu-open={rightSidebarTabMenu?.panelId === panelId ? "true" : undefined}
                        key={panelId}
                        onContextMenu={(event) => openRightSidebarTabMenu(event, panelId)}
                      >
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => activateReviewPanel(panelId)}
                        >
                          <FileDiff size={12} />
                          <span>审阅</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label="关闭侧边栏窗口 审阅"
                          onClick={(event) => {
                            event.stopPropagation();
                            closeReviewPanel(panelId);
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
                      <div
                        className={styles.rightSidebarTab}
                        data-active={active ? "true" : "false"}
                        data-app-context-menu="local"
                        data-menu-open={rightSidebarTabMenu?.panelId === panelId ? "true" : undefined}
                        key={panelId}
                        onContextMenu={(event) => openRightSidebarTabMenu(event, panelId)}
                      >
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => activateInitialPanel(panelId)}
                        >
                          <FileText size={12} />
                          <span>{title}</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label={`关闭侧边栏窗口 ${title}`}
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
                    <div
                      className={styles.rightSidebarTab}
                      data-active={active ? "true" : "false"}
                      data-app-context-menu="local"
                      data-menu-open={rightSidebarTabMenu?.panelId === panelId ? "true" : undefined}
                      key={entry.id}
                      onContextMenu={(event) => openRightSidebarTabMenu(event, panelId)}
                    >
                      <button
                        className={styles.rightSidebarTabMain}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => openPanelEntry(entry.id)}
                      >
                        <FileText size={12} />
                        <span>{entry.title}</span>
                      </button>
                      <button
                        className={styles.rightSidebarTabClose}
                        type="button"
                        aria-label={`关闭侧边栏窗口 ${entry.title}`}
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
                onClick={openInitialPanel}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className={styles.rightSidebarPanelControls}>
              {controls}
            </div>
          </div>
          {rightSidebarTabMenu ? (
            <div
              aria-label="侧边栏tab菜单"
              className={styles.rightSidebarTabMenu}
              data-app-context-menu="local"
              ref={rightSidebarTabMenuRef}
              role="menu"
              style={rightSidebarTabMenu.position}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={rightSidebarTabMenuTargets.left.length === 0}
                onClick={() => closeRightSidebarTabMenuTargets(rightSidebarTabMenuTargets.left)}
              >
                <PanelLeftClose size={14} />
                <span>关闭左侧tab</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={rightSidebarTabMenuTargets.right.length === 0}
                onClick={() => closeRightSidebarTabMenuTargets(rightSidebarTabMenuTargets.right)}
              >
                <PanelRightClose size={14} />
                <span>关闭右侧tab</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={rightSidebarTabMenuTargets.other.length === 0}
                onClick={() => closeRightSidebarTabMenuTargets(rightSidebarTabMenuTargets.other)}
              >
                <X size={14} />
                <span>关闭其他tab</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => closeRightSidebarTabMenuTargets(rightSidebarTabMenuTargets.all)}
              >
                <X size={14} />
                <span>关闭所有tab</span>
              </button>
            </div>
          ) : null}
          {conversationPanelIds.map((panelId) => {
            const conversationPanel = conversationPanels[panelId];
            if (!conversationPanel) {
              return null;
            }
            return (
              <div
                className={styles.rightSidebarBody}
                data-content={conversationPanel.kind === "subagent" ? "subagent" : "conversation"}
                hidden={resolvedActivePanelId !== panelId}
                key={panelId}
              >
                {conversationPanel.status === "opening" ? (
                  <RightSidebarLoading label="正在打开旁路对话" />
                ) : conversationPanel.kind === "subagent" ? (
                  conversationPanel.subagentRun ? (
                    <div className={styles.subagentPanel}>
                      <SubagentPanelHeader
                        role={conversationPanel.subagentRun.role}
                        onBack={() => rightSidebarConversation?.openSubagentList(
                          conversationPanel.parentSessionId ?? conversationPanel.subagentRun?.parent_session_id ?? "",
                        )}
                      />
                      <div className={styles.subagentConversation}>
                        <Suspense fallback={<RightSidebarLoading label="正在加载 Sub-Agent 对话" />}>
                          <LazyConversationSessionSurface
                            threadId={conversationPanel.subagentRun.child_session_id}
                            runtime={runtime}
                            mode="sidecar"
                            previewPanelScopeKey={activeScopeKey}
                            sidecarQuoteRequest={null}
                            sidecarLoadedHistoryTurnCount={null}
                            subagentRun={conversationPanel.subagentRun}
                            a2uiRenderSuspended={a2uiRenderSuspended}
                            onNavigateToConversation={onNavigateToConversation}
                            onOpenModelSettings={onOpenModelSettings}
                          />
                        </Suspense>
                      </div>
                    </div>
                  ) : conversationPanel.subagentInvocation ? (
                    <SubagentInvocationDetail
                      details={conversationPanel.subagentInvocation}
                      onBack={() => rightSidebarConversation?.openSubagentList(
                        conversationPanel.parentSessionId ?? conversationPanel.subagentInvocation?.parentSessionId ?? "",
                      )}
                    />
                  ) : (
                    <SubagentRunList parentSessionId={conversationPanel.parentSessionId ?? ""} />
                  )
                ) : (
                  <Suspense fallback={<RightSidebarLoading label="正在加载旁路对话" />}>
                    <LazyConversationSessionSurface
                      threadId={conversationPanel.sessionId}
                      runtime={runtime}
                      mode="sidecar"
                      previewPanelScopeKey={activeScopeKey}
                      sidecarQuoteRequest={conversationPanel.quoteRequest}
                      sidecarLoadedHistoryTurnCount={conversationPanel.loadedHistoryTurnCount}
                      subagentRun={conversationPanel.subagentRun}
                      a2uiRenderSuspended={a2uiRenderSuspended}
                      onSidecarQuoteRequestHandled={(requestId) =>
                        handleConversationQuoteRequestHandled(panelId, requestId)
                      }
                      onNavigateToConversation={onNavigateToConversation}
                      onOpenModelSettings={onOpenModelSettings}
                    />
                  </Suspense>
                )}
              </div>
            );
          })}
          {!showConversationPanel ? (
            showReviewPanel && activeReviewPanel ? (
              <div className={styles.rightSidebarBody} data-content="review">
                <AgentReviewDiffPanel
                  files={activeReviewPanel.files}
                  document={activeReviewPanel.document}
                  focusedPath={activeReviewPanel.focusedPath}
                  title={activeReviewPanel.title}
                  scopeKey={`${activeScopeKey}:${activeReviewPanel.id}`}
                  onFocusPath={updateReviewPanelFocusedPath}
                  onOpenFile={canOpenFiles ? openReviewFile : undefined}
                />
              </div>
            ) : showFilesPanel &&
            filePanelRenderContext?.runtime &&
            (filePanelRenderContext.sessionId || filePanelRenderContext.workspaceId) ? (
              <div className={styles.rightSidebarBody} data-content="files">
                <Suspense fallback={<RightSidebarLoading label="正在加载文件" />}>
                  <LazyWorkspaceFileBrowser
                    key={`${activeScopeKey}:${activeFilePanel?.id ?? "files"}`}
                    label={filePanelRenderContext.workspaceLabel}
                    runtime={filePanelRenderContext.runtime}
                    workspaceId={filePanelRenderContext.workspaceId}
                    workspaceRootPath={filePanelRenderContext.workspaceRootPath}
                    sessionId={filePanelRenderContext.sessionId}
                    previewPath={activeFilePanel?.filePreviewPath ?? null}
                    previewRequestId={activeFilePanel?.filePreviewRequestId ?? 0}
                    previewRevealTarget={activeFilePanel?.filePreviewRevealTarget ?? null}
                    directoryRevealPath={activeFilePanel?.directoryRevealPath ?? null}
                    directoryRevealRequestId={activeFilePanel?.directoryRevealRequestId ?? 0}
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
                    workspaceRootPath={activeRenderContext?.workspaceRootPath}
                    sessionId={activeRenderContext?.sessionId}
                    request={activeRequest}
                    runtime={activeRenderContext?.runtime}
                    sourceRevealRequest={
                      activeRevealTarget
                        ? {
                            requestId: activePreviewEntry?.openedAt ?? 0,
                            ...activeRevealTarget,
                          }
                        : null
                    }
                    markdownViewDescriptor={activePreviewMarkdownView}
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
                  canOpenSubagents={canOpenSubagents}
                  canOpenReview={canOpenReview}
                  onOpenFiles={openFilesPanel}
                  onOpenBtwConversation={openBtwConversationFromHost}
                  onOpenSubagents={openSubagentsFromHost}
                  onOpenReview={openReviewPanel}
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
    sameStringArray(left.reviewPanelIds, right.reviewPanelIds) &&
    sameFilePanels(left, right) &&
    sameConversationPanels(left, right) &&
    sameReviewPanels(left, right) &&
    sameStringArray(left.initialPanelIds, right.initialPanelIds)
  );
}

type LegacyRightSidebarScopePanelState = Partial<RightSidebarScopePanelState> & {
  filesOpen?: boolean;
  initialPanelSeq?: number;
  filePreviewPath?: string | null;
  filePreviewRequestId?: number;
  toolPanelIds?: string[];
  toolPanels?: Record<string, unknown>;
};

function normalizeRightSidebarScopePanelState(
  state: LegacyRightSidebarScopePanelState | null | undefined,
): RightSidebarScopePanelState {
  const {
    toolPanelIds: retiredToolPanelIdsRaw = [],
    toolPanels: retiredToolPanels,
    ...supportedState
  } = state ?? {};
  void retiredToolPanels;
  const filePanels = Object.fromEntries(
    Object.entries(state?.filePanels ?? {}).map(([panelId, panel]) => [
      panelId,
      {
        ...panel,
        directoryRevealPath: panel.directoryRevealPath ?? null,
        directoryRevealRequestId: panel.directoryRevealRequestId ?? 0,
      },
    ]),
  );
  let filePanelIds = state?.filePanelIds ?? [];
  if (filePanelIds.length === 0 && state?.filesOpen) {
    filePanelIds = [LEGACY_FILES_PANEL_ID];
    filePanels[LEGACY_FILES_PANEL_ID] = {
      id: LEGACY_FILES_PANEL_ID,
      filePreviewPath: state.filePreviewPath ?? null,
      filePreviewRequestId: state.filePreviewRequestId ?? 0,
      filePreviewRevealTarget: null,
      directoryRevealPath: null,
      directoryRevealRequestId: 0,
    };
  }
  const conversationPanelIds = state?.conversationPanelIds ?? [];
  const conversationPanels = Object.fromEntries(
    Object.entries(state?.conversationPanels ?? {}).map(([panelId, panel]) => [
      panelId,
      {
        ...panel,
        kind: panel.kind ?? (panel.subagentRun ? "subagent" : "conversation"),
        status: panel.status ?? "ready",
        parentSessionId: panel.parentSessionId ?? panel.subagentRun?.parent_session_id ?? null,
        quoteRequest: panel.quoteRequest ?? null,
        loadedHistoryTurnCount: panel.loadedHistoryTurnCount ?? null,
        subagentRun: panel.subagentRun ?? null,
        subagentInvocation: panel.subagentInvocation ?? null,
      },
    ]),
  );
  const reviewPanelIds = state?.reviewPanelIds ?? [];
  const reviewPanels = { ...(state?.reviewPanels ?? {}) };
  const retiredToolPanelIds = new Set(retiredToolPanelIdsRaw);
  const initialPanelIds = state?.initialPanelIds ?? [];
  const nextPanelSeq = Math.max(
    state?.nextPanelSeq ?? state?.initialPanelSeq ?? 0,
    maxPanelSeq([
      ...filePanelIds,
      ...conversationPanelIds,
      ...reviewPanelIds,
      ...initialPanelIds,
    ]),
  );
  const panelOrder = orderedUniquePanelIds(
    (state?.panelOrder ?? []).filter((panelId) => !retiredToolPanelIds.has(panelId)),
    [
      ...filePanelIds,
      ...conversationPanelIds,
      ...reviewPanelIds,
      ...initialPanelIds,
    ],
  );
  const activePanelId = state?.activePanelId && retiredToolPanelIds.has(state.activePanelId)
    ? null
    : state?.activePanelId ?? null;

  return {
    ...EMPTY_RIGHT_SIDEBAR_SCOPE_STATE,
    ...supportedState,
    activePanelId,
    panelOrder,
    filePanelIds,
    filePanels,
    conversationPanelIds,
    conversationPanels,
    reviewPanelIds,
    reviewPanels,
    initialPanelIds,
    nextPanelSeq,
  };
}

function activateOrCreateFilePanel(
  state: RightSidebarScopePanelState,
  options: {
    path?: string | null;
    requestId?: number;
    directoryRevealPath?: string | null;
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
        filePreviewRequestId: hasPanelPathOption(options) ? options.requestId ?? 0 : 0,
        filePreviewRevealTarget: options.revealTarget ?? null,
        directoryRevealPath: options.directoryRevealPath ?? null,
        directoryRevealRequestId: options.directoryRevealPath ? options.requestId ?? 0 : 0,
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
  options: {
    path?: string | null;
    requestId?: number;
    directoryRevealPath?: string | null;
    revealTarget?: PreviewFileRevealTarget | null;
  },
): RightSidebarScopePanelState {
  const panel = state.filePanels[panelId];
  if (!panel) {
    return state;
  }
  if (!hasPanelPathOption(options) && !options.requestId && !options.directoryRevealPath) {
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
          ? hasPanelPathOption(options)
            ? Math.max(panel.filePreviewRequestId + 1, options.requestId)
            : panel.filePreviewRequestId
          : panel.filePreviewRequestId,
        filePreviewRevealTarget: Object.prototype.hasOwnProperty.call(options, "revealTarget")
          ? options.revealTarget ?? null
          : panel.filePreviewRevealTarget,
        directoryRevealPath: Object.prototype.hasOwnProperty.call(options, "directoryRevealPath")
          ? options.directoryRevealPath ?? null
          : panel.directoryRevealPath,
        directoryRevealRequestId: options.directoryRevealPath && options.requestId
          ? Math.max(panel.directoryRevealRequestId + 1, options.requestId)
          : panel.directoryRevealRequestId,
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

function activateOrCreateReviewPanel(
  state: RightSidebarScopePanelState,
  request: ReviewPanelRequest,
): RightSidebarScopePanelState {
  const existingPanelId =
    state.reviewPanelIds.find((panelId) => state.reviewPanels[panelId]?.panelKey === request.panelKey) ?? null;
  if (existingPanelId) {
    return activateExistingReviewPanel(state, existingPanelId, request);
  }

  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${REVIEW_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    reviewPanelIds: [...state.reviewPanelIds, panelId],
    reviewPanels: {
      ...state.reviewPanels,
      [panelId]: reviewPanelState(panelId, request),
    },
    initialPanelIds: activeInitialPanelId
      ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
      : state.initialPanelIds,
    nextPanelSeq,
  };
}

function activateExistingReviewPanel(
  state: RightSidebarScopePanelState,
  panelId: string,
  request: ReviewPanelRequest,
): RightSidebarScopePanelState {
  const panel = state.reviewPanels[panelId];
  if (!panel) {
    return state;
  }
  return {
    ...state,
    activePanelId: panelId,
    reviewPanels: {
      ...state.reviewPanels,
      [panelId]: {
        ...panel,
        title: request.title || panel.title,
        files: request.files,
        document: request.document,
        focusedPath: request.focusedPath ?? request.files[0]?.path ?? panel.focusedPath,
        sourceMessageId: request.sourceMessageId,
        toolCallId: request.toolCallId,
        requestId: Math.max(panel.requestId + 1, request.requestId),
      },
    },
  };
}

function reviewPanelState(panelId: string, request: ReviewPanelRequest): RightSidebarReviewPanelState {
  return {
    id: panelId,
    title: request.title || "审阅",
    files: request.files,
    document: request.document,
    focusedPath: request.focusedPath ?? request.files[0]?.path ?? null,
    panelKey: request.panelKey,
    sourceMessageId: request.sourceMessageId,
    toolCallId: request.toolCallId,
    requestId: request.requestId,
  };
}

function activateOrCreateConversationPanel(
  state: RightSidebarScopePanelState,
  options: {
    session: AgentSession;
    title?: string | null;
    sourceSessionId?: string | null;
    quote?: SelectedQuote | null;
    loadedHistoryTurnCount?: number | null;
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
    quote?: SelectedQuote | null;
    loadedHistoryTurnCount?: number | null;
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
        kind: "conversation",
        status: "ready",
        title: conversationPanelTitle(options),
        sourceSessionId: options.sourceSessionId ?? panel.sourceSessionId,
        parentSessionId: null,
        quoteRequest: options.quote ? nextConversationQuoteRequest(options.quote, panel.quoteRequest) : panel.quoteRequest,
        loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? panel.loadedHistoryTurnCount,
        subagentRun: null,
        subagentInvocation: null,
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
    quote?: SelectedQuote | null;
    loadedHistoryTurnCount?: number | null;
  },
): RightSidebarConversationPanelState {
  return {
    id: panelId,
    kind: "conversation",
    status: "ready",
    sessionId: options.session.id,
    title: conversationPanelTitle(options),
    sourceSessionId: options.sourceSessionId ?? null,
    parentSessionId: null,
    quoteRequest: options.quote ? nextConversationQuoteRequest(options.quote, null) : null,
    loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? null,
    subagentRun: null,
    subagentInvocation: null,
  };
}

function activateOrCreateSubagentPanel(
  state: RightSidebarScopePanelState,
  run: SubagentRunSnapshot,
): RightSidebarScopePanelState {
  const existingPanelId =
    state.conversationPanelIds.find(
      (panelId) => {
        const panel = state.conversationPanels[panelId];
        return panel?.kind === "subagent" && panel.parentSessionId === run.parent_session_id;
      },
    ) ?? null;
  if (existingPanelId) {
    const panel = state.conversationPanels[existingPanelId];
    return {
      ...state,
      activePanelId: existingPanelId,
      conversationPanels: {
        ...state.conversationPanels,
        [existingPanelId]: {
          ...panel,
          kind: "subagent",
          status: "ready",
          title: subagentPanelTitle(run),
          sessionId: run.child_session_id,
          sourceSessionId: run.parent_session_id,
          parentSessionId: run.parent_session_id,
          quoteRequest: null,
          loadedHistoryTurnCount: null,
          subagentRun: run,
          subagentInvocation: null,
        },
      },
    };
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
      [panelId]: {
        id: panelId,
        kind: "subagent",
        status: "ready",
        sessionId: run.child_session_id,
        title: subagentPanelTitle(run),
        sourceSessionId: run.parent_session_id,
        parentSessionId: run.parent_session_id,
        quoteRequest: null,
        loadedHistoryTurnCount: null,
        subagentRun: run,
        subagentInvocation: null,
      },
    },
    initialPanelIds: activeInitialPanelId
      ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
      : state.initialPanelIds,
    nextPanelSeq,
  };
}

function activateOrCreateSubagentList(
  state: RightSidebarScopePanelState,
  parentSessionId: string,
): RightSidebarScopePanelState {
  return activateOrCreateSubagentWorkspace(state, parentSessionId, {
    sessionId: "",
    subagentRun: null,
    subagentInvocation: null,
  });
}

function activateOrCreateSubagentInvocationPanel(
  state: RightSidebarScopePanelState,
  details: SubagentInvocationPanelDetails,
): RightSidebarScopePanelState {
  return activateOrCreateSubagentWorkspace(state, details.parentSessionId, {
    sessionId: "",
    subagentRun: null,
    subagentInvocation: details,
  });
}

function activateOrCreateSubagentWorkspace(
  state: RightSidebarScopePanelState,
  parentSessionId: string,
  selection: Pick<RightSidebarConversationPanelState, "sessionId" | "subagentRun" | "subagentInvocation">,
): RightSidebarScopePanelState {
  const existingPanelId = state.conversationPanelIds.find((panelId) => {
    const panel = state.conversationPanels[panelId];
    return panel?.kind === "subagent" && panel.parentSessionId === parentSessionId;
  }) ?? null;
  if (existingPanelId) {
    const panel = state.conversationPanels[existingPanelId];
    return {
      ...state,
      activePanelId: existingPanelId,
      conversationPanels: {
        ...state.conversationPanels,
        [existingPanelId]: {
          ...panel,
          ...selection,
          kind: "subagent",
          status: "ready",
          title: "子智能体",
          sourceSessionId: parentSessionId,
          parentSessionId,
          quoteRequest: null,
          loadedHistoryTurnCount: null,
        },
      },
    };
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
      [panelId]: {
        id: panelId,
        kind: "subagent",
        status: "ready",
        title: "子智能体",
        sourceSessionId: parentSessionId,
        parentSessionId,
        quoteRequest: null,
        loadedHistoryTurnCount: null,
        ...selection,
      },
    },
    initialPanelIds: activeInitialPanelId
      ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
      : state.initialPanelIds,
    nextPanelSeq,
  };
}

function subagentPanelTitle(_run: SubagentRunSnapshot): string {
  return "子智能体";
}

function activateOrCreateOpeningConversationPanel(
  state: RightSidebarScopePanelState,
  options: {
    sourceSessionId: string;
    quote?: SelectedQuote | null;
  },
): { panelId: string; state: RightSidebarScopePanelState } {
  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${CONVERSATION_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    panelId,
    state: {
      ...state,
      activePanelId: panelId,
      panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
      conversationPanelIds: [...state.conversationPanelIds, panelId],
      conversationPanels: {
        ...state.conversationPanels,
        [panelId]: openingConversationPanelState(panelId, options),
      },
      initialPanelIds: activeInitialPanelId
        ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
        : state.initialPanelIds,
      nextPanelSeq,
    },
  };
}

function openingConversationPanelState(
  panelId: string,
  options: {
    sourceSessionId: string;
    quote?: SelectedQuote | null;
  },
): RightSidebarConversationPanelState {
  return {
    id: panelId,
    kind: "conversation",
    status: "opening",
    sessionId: "",
    title: BTW_CONVERSATION_TITLE,
    sourceSessionId: options.sourceSessionId,
    parentSessionId: null,
    quoteRequest: options.quote ? nextConversationQuoteRequest(options.quote, null) : null,
    loadedHistoryTurnCount: null,
    subagentRun: null,
    subagentInvocation: null,
  };
}

function resolveOpeningConversationPanel(
  state: RightSidebarScopePanelState,
  panelId: string,
  options: {
    session: AgentSession;
    title?: string | null;
    sourceSessionId?: string | null;
    loadedHistoryTurnCount?: number | null;
  },
): RightSidebarScopePanelState {
  const panel = state.conversationPanels[panelId];
  if (!panel || panel.status !== "opening") {
    return state;
  }
  return {
    ...state,
    activePanelId: state.activePanelId ?? panelId,
    conversationPanels: {
      ...state.conversationPanels,
      [panelId]: {
        ...panel,
        kind: "conversation",
        status: "ready",
        sessionId: options.session.id,
        title: conversationPanelTitle(options),
        sourceSessionId: options.sourceSessionId ?? panel.sourceSessionId,
        parentSessionId: null,
        loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? panel.loadedHistoryTurnCount,
        subagentRun: null,
        subagentInvocation: null,
      },
    },
  };
}

function removeConversationPanelFromState(
  state: RightSidebarScopePanelState,
  panelId: string,
): RightSidebarScopePanelState {
  if (!state.conversationPanels[panelId]) {
    return state;
  }
  const nextConversationPanelIds = state.conversationPanelIds.filter((id) => id !== panelId);
  const nextConversationPanels = { ...state.conversationPanels };
  delete nextConversationPanels[panelId];
  const nextPanelOrder = state.panelOrder.filter((id) => id !== panelId);
  return {
    ...state,
    activePanelId: state.activePanelId === panelId ? nextPanelIdAfterRemoval(state.panelOrder, panelId) : state.activePanelId,
    panelOrder: nextPanelOrder,
    conversationPanelIds: nextConversationPanelIds,
    conversationPanels: nextConversationPanels,
  };
}

function nextConversationQuoteRequest(
  quote: SelectedQuote,
  previous: RightSidebarConversationQuoteRequest | null,
): RightSidebarConversationQuoteRequest {
  return {
    requestId: (previous?.requestId ?? 0) + 1,
    quote,
  };
}

function conversationPanelTitle(options: { session: AgentSession; title?: string | null }): string {
  return options.title?.trim() || options.session.title?.trim() || BTW_CONVERSATION_TITLE;
}

function orderedRightSidebarPanelIds(state: RightSidebarScopePanelState, entryIds: string[]): string[] {
  return orderedUniquePanelIds(state.panelOrder, [
    ...state.filePanelIds,
    ...state.conversationPanelIds,
    ...state.reviewPanelIds,
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

function rightSidebarTabMenuPosition(clientX: number, clientY: number): CSSProperties {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return {
    left: Math.max(
      RIGHT_SIDEBAR_TAB_MENU_EDGE,
      Math.min(clientX, viewportWidth - RIGHT_SIDEBAR_TAB_MENU_WIDTH - RIGHT_SIDEBAR_TAB_MENU_EDGE),
    ),
    top: Math.max(
      RIGHT_SIDEBAR_TAB_MENU_EDGE,
      Math.min(clientY, viewportHeight - RIGHT_SIDEBAR_TAB_MENU_HEIGHT - RIGHT_SIDEBAR_TAB_MENU_EDGE),
    ),
  };
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

function nextPanelIdAfterBulkRemoval(
  panelOrder: string[],
  removedPanelIds: Set<string>,
  anchorPanelId: string | null,
): string | null {
  const remainingPanelOrder = panelOrder.filter((panelId) => !removedPanelIds.has(panelId));
  if (remainingPanelOrder.length === 0) {
    return null;
  }
  const anchorIndex = anchorPanelId ? panelOrder.indexOf(anchorPanelId) : -1;
  if (anchorIndex === -1) {
    return remainingPanelOrder[0] ?? null;
  }
  return remainingPanelOrder[Math.max(0, Math.min(anchorIndex, remainingPanelOrder.length - 1))] ?? null;
}

function omitRecordKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  const next = { ...record };
  keys.forEach((key) => {
    delete next[key];
  });
  return next;
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
  if (panelId.startsWith(REVIEW_PANEL_ID_PREFIX)) {
    return REVIEW_PANEL_ID_PREFIX;
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
      samePreviewFileRevealTarget(leftPanel.filePreviewRevealTarget, rightPanel.filePreviewRevealTarget) &&
      leftPanel.directoryRevealPath === rightPanel.directoryRevealPath &&
      leftPanel.directoryRevealRequestId === rightPanel.directoryRevealRequestId
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
      leftPanel.kind === rightPanel.kind &&
      leftPanel.status === rightPanel.status &&
      leftPanel.sessionId === rightPanel.sessionId &&
      leftPanel.title === rightPanel.title &&
      leftPanel.sourceSessionId === rightPanel.sourceSessionId &&
      leftPanel.parentSessionId === rightPanel.parentSessionId &&
      leftPanel.loadedHistoryTurnCount === rightPanel.loadedHistoryTurnCount &&
      leftPanel.subagentRun?.run_id === rightPanel.subagentRun?.run_id &&
      leftPanel.subagentRun?.version === rightPanel.subagentRun?.version &&
      sameSubagentInvocation(leftPanel.subagentInvocation, rightPanel.subagentInvocation) &&
      sameConversationQuoteRequest(leftPanel.quoteRequest, rightPanel.quoteRequest)
    );
  });
}

function sameSubagentInvocation(
  left: SubagentInvocationPanelDetails | null,
  right: SubagentInvocationPanelDetails | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.invocationId === right.invocationId &&
    left.parentSessionId === right.parentSessionId &&
    left.role === right.role &&
    left.task === right.task &&
    left.state === right.state &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage
  );
}

function sameReviewPanels(left: RightSidebarScopePanelState, right: RightSidebarScopePanelState): boolean {
  return left.reviewPanelIds.every((panelId) => {
    const leftPanel = left.reviewPanels[panelId];
    const rightPanel = right.reviewPanels[panelId];
    return (
      Boolean(leftPanel) &&
      Boolean(rightPanel) &&
      leftPanel.title === rightPanel.title &&
      leftPanel.focusedPath === rightPanel.focusedPath &&
      leftPanel.panelKey === rightPanel.panelKey &&
      leftPanel.sourceMessageId === rightPanel.sourceMessageId &&
      leftPanel.toolCallId === rightPanel.toolCallId &&
      leftPanel.requestId === rightPanel.requestId &&
      sameFileReviewChanges(leftPanel.files, rightPanel.files)
    );
  });
}

function sameFileReviewChanges(left: FileReviewChange[], right: FileReviewChange[]): boolean {
  return (
    left.length === right.length &&
    left.every((leftFile, index) => {
      const rightFile = right[index];
      return (
        Boolean(rightFile) &&
        leftFile.path === rightFile.path &&
        leftFile.operation === rightFile.operation &&
        leftFile.additions === rightFile.additions &&
        leftFile.deletions === rightFile.deletions &&
        leftFile.diff === rightFile.diff &&
        leftFile.content === rightFile.content &&
        leftFile.oldPath === rightFile.oldPath &&
        leftFile.newPath === rightFile.newPath
      );
    })
  );
}

function sameConversationQuoteRequest(
  left: RightSidebarConversationQuoteRequest | null,
  right: RightSidebarConversationQuoteRequest | null,
): boolean {
  return (
    (left?.requestId ?? null) === (right?.requestId ?? null) &&
    (left?.quote.id ?? null) === (right?.quote.id ?? null)
  );
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
