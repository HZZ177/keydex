import {
  FileText,
  Maximize2,
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
  type MouseEvent as ReactMouseEvent,
  type PropsWithChildren,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { BROWSER_LIMITS } from "@/renderer/features/browser/config";
import { browserGeometryCoordinator } from "@/renderer/features/browser/runtime";
import {
  createWebAnnotationClient,
  webAnnotationNavigator,
  type WebAnnotationContextSnapshot,
} from "@/renderer/features/browser/annotations";
import { subscribeNavigateToWebAnnotation } from "@/renderer/events/webAnnotationContext";
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
import { AppTooltipLayer } from "@/renderer/components/tooltip";
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
  TerminalDock,
  TerminalDockAction,
  useTerminalStore,
} from "@/renderer/features/terminal";

import {
  RightSidebarResizeHandle,
  type RightSidebarResizeDragInput,
} from "./RightSidebarResizeHandle";
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
import {
  rightSidebarDefinitionRegistry,
  type ConversationPanelQuoteRequest,
  type ConversationPanelState,
  type FilesPanelState,
  type JsonObject,
  type ReviewPanelState,
  type RightSidebarPanelKind,
  type RightSidebarPanelState,
} from "./rightSidebarRegistry";
import {
  conversationPanelCreateInput,
  normalizeConversationPanelState,
} from "./rightSidebar/panels/conversation";
import {
  filesPanelCreateInput,
  normalizeFilesPanelState,
  serializeFilesPanelState,
} from "./rightSidebar/panels/files";
import {
  normalizeReviewPanelState,
  reviewPanelCreateInput,
  serializeReviewPanelState,
} from "./rightSidebar/panels/review";
import {
  RightSidebarRegisteredPanelHost,
  RightSidebarRegisteredTab,
} from "./rightSidebar/RightSidebarHost";
import { RightSidebarPanelIconGlyph } from "./rightSidebar/icons";
import {
  panelIdsByKind,
  removeRegisteredPanels,
  replaceRegisteredPanel,
  previewScopePanelIds,
  type PreviewScopePanelState,
} from "./rightSidebar/scopeAdapter";
import {
  persistableRightSidebarScopeKey,
  rightSidebarPersistenceForRuntime,
  serializePersistableRightSidebarState,
} from "./rightSidebar/persistence";

const LazyFilePreview = lazy(() =>
  import("@/renderer/components/workspace/FilePreview").then((module) => ({ default: module.FilePreview })),
);

const LEGACY_FILES_PANEL_ID = "right-sidebar:files";
const LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const FILES_PANEL_ID_PREFIX = "right-sidebar:files:";
const INITIAL_PANEL_ID_PREFIX = "right-sidebar:initial:";
const CONVERSATION_PANEL_ID_PREFIX = "right-sidebar:conversation:";
const REVIEW_PANEL_ID_PREFIX = "right-sidebar:review:";
const GLOBAL_RIGHT_SIDEBAR_SCOPE = "global";
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

type RightSidebarFilePanelState = FilesPanelState;

type RightSidebarConversationPanelState = ConversationPanelState;

type RightSidebarReviewPanelState = ReviewPanelState;

type RightSidebarScopePanelState = PreviewScopePanelState;

interface RightSidebarTabMenuState {
  panelId: string;
  position: CSSProperties;
}

interface WebAnnotationNavigationRequest {
  readonly requestId: number;
  readonly snapshot: WebAnnotationContextSnapshot;
}

const EMPTY_RIGHT_SIDEBAR_SCOPE_STATE: RightSidebarScopePanelState = {
  version: 2,
  activePanelId: null,
  panelOrder: [],
  panels: {},
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
  const shellWidthRef = useRef(initialShellWidth());
  const shellMeasureFrameRef = useRef<number | null>(null);
  const browserResizeSessionRef = useRef<number | null>(null);
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
  const [webAnnotationNavigationRequest, setWebAnnotationNavigationRequest] = useState<
    WebAnnotationNavigationRequest | null
  >(null);
  const sessionNavigationPending = Boolean(
    pendingSessionNavigation
      && sameNavigationPath(activePath, pendingSessionNavigation.sourcePath)
      && !sameNavigationPath(activePath, pendingSessionNavigation.targetPath),
  );
  const primaryContentNavigationPending = sessionNavigationPending && appMode !== "workbench";
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
  const rightSidebarPanelStateByScopeRef = useRef(rightSidebarPanelStateByScope);
  rightSidebarPanelStateByScopeRef.current = rightSidebarPanelStateByScope;
  const loadedRightSidebarScopesRef = useRef(new Set<string>());
  const rightSidebarPersistence = useMemo(
    () => rightSidebarPersistenceForRuntime(runtime),
    [runtime],
  );
  const [productShowcasePhase, setProductShowcasePhase] = useState<ProductShowcaseOverlayPhase | null>(null);
  const { state, actions } = useLayoutState();
  const runtimeConnection = useOptionalRuntimeConnection();
  const activeProjectState = useOptionalActiveProjectState();
  const notifications = useNotifications();
  const terminalDockOpen = useTerminalStore((terminalState) => terminalState.ui.dockOpen);
  const terminalDockHeight = useTerminalStore((terminalState) => terminalState.ui.dockHeight);
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
  const setRightSidebarResizing = useCallback((
    resizing: boolean,
    input?: RightSidebarResizeDragInput,
  ) => {
    const shell = shellRef.current;
    setRightSidebarResizeActive((current) => (current === resizing ? current : resizing));
    if (!shell) {
      return;
    }
    if (resizing && input) {
      shell.dataset.rightSidebarResizing = "true";
      browserResizeSessionRef.current = browserGeometryCoordinator.beginInteractiveResize(input);
      return;
    }
    delete shell.dataset.rightSidebarResizing;
    browserGeometryCoordinator.endInteractiveResize(browserResizeSessionRef.current);
    browserResizeSessionRef.current = null;
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

  const persistentRightSidebarScopeKey = globalRightSidebarEnabled && primarySurface !== "git"
    ? persistableRightSidebarScopeKey(
      previewContext?.activeScopeKey ?? GLOBAL_RIGHT_SIDEBAR_SCOPE,
    )
    : null;
  useEffect(() => {
    const scopeKey = persistentRightSidebarScopeKey;
    if (!scopeKey) return;
    let cancelled = false;
    void rightSidebarPersistence
      .load(scopeKey)
      .then((loaded) => {
        if (cancelled) return;
        const current = normalizeRightSidebarScopePanelState(
          rightSidebarPanelStateByScopeRef.current[scopeKey],
        );
        const restored: RightSidebarScopePanelState = loaded.exists
          ? { ...loaded.state, initialPanelIds: [] }
          : current;
        loadedRightSidebarScopesRef.current.add(scopeKey);
        setRightSidebarPanelStateByScope((states) => {
          const previous = normalizeRightSidebarScopePanelState(states[scopeKey]);
          if (sameRightSidebarScopePanelState(previous, restored)) return states;
          return { ...states, [scopeKey]: restored };
        });
        if (!loaded.exists && Object.keys(serializePersistableRightSidebarState(current).panels).length) {
          rightSidebarPersistence.queueSave(scopeKey, current);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) notifications.error(errorMessage(reason));
      });
    return () => {
      cancelled = true;
      if (loadedRightSidebarScopesRef.current.has(scopeKey)) {
        void rightSidebarPersistence.flush(scopeKey).catch(() => undefined);
      }
    };
  }, [notifications, persistentRightSidebarScopeKey, rightSidebarPersistence]);

  useEffect(() => {
    if (!persistentRightSidebarScopeKey) return;
    if (!loadedRightSidebarScopesRef.current.has(persistentRightSidebarScopeKey)) return;
    const current = rightSidebarPanelStateByScope[persistentRightSidebarScopeKey];
    if (!current) return;
    rightSidebarPersistence.queueSave(persistentRightSidebarScopeKey, current);
  }, [
    persistentRightSidebarScopeKey,
    rightSidebarPanelStateByScope,
    rightSidebarPersistence,
  ]);

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

  useEffect(() => subscribeNavigateToWebAnnotation(({ snapshot }) => {
    setWebAnnotationNavigationRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      snapshot,
    }));
    openRightSidebar();
  }), [openRightSidebar]);

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

  const switchAppMode = useCallback(
    (mode: AppMode) => {
      if (mode === appMode) {
        return;
      }
      const target = modeSwitchTargets?.[mode];
      if (!target || target === activePath) {
        return;
      }
      setLocalPrimarySurface("content");
      onNavigate?.(target);
    },
    [activePath, appMode, modeSwitchTargets, onNavigate],
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
                aria-busy={primaryContentNavigationPending || undefined}
              >
                {primaryContentNavigationPending ? (
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
            {appMode !== "workbench" ? (
              <div className={styles.contentTopActions} data-testid="content-top-actions">
                <TerminalDockAction
                  badgeClassName={styles.terminalCountBadge}
                  className={styles.contentTopAction}
                />
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
            ) : null}

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
                  webAnnotationNavigationRequest={webAnnotationNavigationRequest}
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
  webAnnotationNavigationRequest,
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
  webAnnotationNavigationRequest: WebAnnotationNavigationRequest | null;
  onNavigateToConversation?: (sessionId: string) => void;
  onOpenModelSettings?: () => void;
  onClose: () => void;
  onMaximize: () => void;
  onRestore: () => void;
}) {
  const previewContext = useOptionalPreview();
  const notifications = useNotifications();
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
  const filePanelIds = panelIdsByKind(scopedPanelState, "files");
  const conversationPanelIds = panelIdsByKind(scopedPanelState, "conversation");
  const reviewPanelIds = panelIdsByKind(scopedPanelState, "review");
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
  const resolvedActivePanelId = activePanelId ?? activeEntryId ?? orderedPanelIds[0] ?? null;
  const activeRegisteredPanel = resolvedActivePanelId
    ? scopedPanelState.panels[resolvedActivePanelId] ?? null
    : null;
  const activePreviewEntry =
    resolvedActivePanelId &&
    !activeRegisteredPanel &&
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
  const activePreviewQuoteSelection = useCallback(
    (request: PreviewQuoteSelectionRequest) => {
      activeRenderContext?.onQuoteSelection?.(request);
      if (maximized) {
        onRestore();
      }
    },
    [activeRenderContext?.onQuoteSelection, maximized, onRestore],
  );
  const panelActivePreviewEntryId =
    open &&
    resolvedActivePanelId &&
    !activeRegisteredPanel &&
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
      const fileIds = new Set(panelIdsByKind(current, "files"));
      const next = removeRegisteredPanels(current, fileIds);
      return {
        ...next,
        activePanelId: current.activePanelId && fileIds.has(current.activePanelId)
          ? activeEntryId ?? next.activePanelId
          : next.activePanelId,
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

  const openDefaultRegisteredPanel = useCallback(
    (kind: RightSidebarPanelKind, forceNew = false, input?: JsonObject) => {
      updateActiveScopePanelState((current) => {
        const activePanel = current.activePanelId
          ? current.panels[current.activePanelId]
          : null;
        if (!forceNew && activePanel?.kind === kind) return current;
        if (kind === "browser") {
          const browserPanelIds = panelIdsByKind(current, "browser");
          if (browserPanelIds.length >= BROWSER_LIMITS.maxPanelMetadata) {
            return { ...current, activePanelId: browserPanelIds.at(-1) ?? current.activePanelId };
          }
        }
        const definition = rightSidebarDefinitionRegistry.get(kind);
        const singletonPanelId = definition.multiplicity === "singleton"
          ? panelIdsByKind(current, kind)[0] ?? null
          : null;
        if (singletonPanelId) {
          return { ...current, activePanelId: singletonPanelId };
        }
        const activeInitialPanelId = activeInitialPanelIdForState(current);
        const nextPanelSeq = activeInitialPanelId
          ? current.nextPanelSeq
          : current.nextPanelSeq + 1;
        const panelId = activeInitialPanelId ?? rightSidebarDefinitionRegistry.panelId(
          kind,
          nextPanelSeq,
        );
        const panel = rightSidebarDefinitionRegistry.create(kind, {
          id: panelId,
          sequence: nextPanelSeq,
          now: new Date().toISOString(),
          input,
        });
        return {
          ...current,
          activePanelId: panelId,
          panelOrder: activeInitialPanelId
            ? current.panelOrder
            : [...current.panelOrder, panelId],
          panels: { ...current.panels, [panelId]: panel },
          initialPanelIds: activeInitialPanelId
            ? current.initialPanelIds.filter((id) => id !== activeInitialPanelId)
            : current.initialPanelIds,
          nextPanelSeq,
        };
      });
    },
    [updateActiveScopePanelState],
  );

  const lastWebAnnotationNavigationRequestRef = useRef(0);
  useEffect(() => {
    if (
      !webAnnotationNavigationRequest
      || webAnnotationNavigationRequest.requestId === lastWebAnnotationNavigationRequestRef.current
    ) return;
    lastWebAnnotationNavigationRequestRef.current = webAnnotationNavigationRequest.requestId;
    const snapshot = webAnnotationNavigationRequest.snapshot;
    const openSourcePanel = (documentUrl: string) => openDefaultRegisteredPanel(
      "browser",
      true,
      { restoreUrl: documentUrl },
    );
    void createWebAnnotationClient(runtime.http).get(snapshot.reference.annotationId)
      .then((detail) => webAnnotationNavigator.navigate({
        scopeKey: activeScopeKey,
        target: {
          annotationId: detail.annotation.id,
          resourceId: detail.resource.id,
          urlKey: detail.resource.urlKey,
          documentUrl: detail.resource.documentUrl,
        },
        createPanel: openSourcePanel,
      }))
      .then((result) => {
        if (result.status === "evidence_only") {
          notifications.warning("已打开网页来源；当前页面无法唯一定位该批注，历史快照保持不变");
        } else if (result.status === "unavailable") {
          notifications.warning(`暂时无法定位网页批注：${result.reason}`);
        }
      })
      .catch(() => {
        openSourcePanel(snapshot.page.documentUrl);
        notifications.warning("源批注已删除或暂时不可用，已打开发送时页面；历史快照保持不变");
      });
  }, [activeScopeKey, notifications, openDefaultRegisteredPanel, runtime.http, webAnnotationNavigationRequest]);

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

  const activateRegisteredPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) => (
        current.panels[panelId]
          ? { ...current, activePanelId: panelId }
          : current
      ));
    },
    [updateActiveScopePanelState],
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
        const withoutRegistered = removeRegisteredPanels(current, closeSet);
        return {
          ...withoutRegistered,
          activePanelId: nextActivePanelId,
          panelOrder: nextPanelOrder,
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

  const updateRegisteredPanelState = useCallback(
    (nextPanel: RightSidebarPanelState) => {
      updateActiveScopePanelState((current) => {
        const previousPanel = current.panels[nextPanel.id];
        return previousPanel?.kind === nextPanel.kind
          ? replaceRegisteredPanel(current, nextPanel)
          : current;
      });
    },
    [updateActiveScopePanelState],
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
        const panel = current.panels[panelId];
        if (panel?.kind !== "conversation" || !panel.quoteRequest || panel.quoteRequest.requestId !== requestId) {
          return current;
        }
        return replaceRegisteredPanel(current, { ...panel, quoteRequest: null });
      });
    },
    [updateActiveScopePanelState],
  );

  const initialActionOverrides: Record<
    string,
    { available: boolean; onSelect(): void }
  > = {
    conversation: {
      available: canOpenBtwConversation,
      onSelect: openBtwConversationFromHost,
    },
    subagents: {
      available: canOpenSubagents,
      onSelect: openSubagentsFromHost,
    },
  };
  const defaultPanelAvailability: Partial<Record<RightSidebarPanelKind, boolean>> = {
    files: canOpenFiles,
  };
  const initialPageActions = rightSidebarDefinitionRegistry.listInitialActions().flatMap((action) => {
    const actionState = initialActionOverrides[action.id] ?? {
      available: defaultPanelAvailability[action.kind] ?? true,
      onSelect: () => openDefaultRegisteredPanel(action.kind),
    };
    return actionState.available ? [{
      id: action.id,
      label: action.label,
      icon: <RightSidebarPanelIconGlyph icon={action.icon} size={14} strokeWidth={1.9} />,
      onSelect: actionState.onSelect,
    }] : [];
  });

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
          <AppTooltipLayer
            defaultPlacement="bottom"
            delayMs={260}
            ownerId="right-sidebar-chrome"
            scopeSelector="[data-right-sidebar-chrome-tooltips='true']"
          />
          <div
            className={styles.rightSidebarTopbar}
            data-app-tooltip-owner="right-sidebar-chrome"
            data-right-sidebar-chrome-tooltips="true"
          >
            <div className={styles.rightSidebarTabArea}>
              <div className={styles.rightSidebarTabs} role="tablist" aria-label="侧边栏窗口">
                {orderedPanelIds.map((panelId) => {
                  const registeredPanel = scopedPanelState.panels[panelId];
                  if (registeredPanel) {
                    return (
                      <RightSidebarRegisteredTab
                        active={resolvedActivePanelId === panelId}
                        key={panelId}
                        menuOpen={rightSidebarTabMenu?.panelId === panelId}
                        panel={registeredPanel}
                        onActivate={() => activateRegisteredPanel(panelId)}
                        onClose={() => closeRightSidebarPanels([panelId])}
                        onContextMenu={(event) => openRightSidebarTabMenu(event, panelId)}
                      />
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
                          data-tooltip-label={title}
                          onClick={() => activateInitialPanel(panelId)}
                        >
                          <FileText size={12} />
                          <span>{title}</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label={`关闭侧边栏窗口 ${title}`}
                          data-tooltip-label={`关闭 ${title}`}
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
                        data-tooltip-label={entry.title}
                        onClick={() => openPanelEntry(entry.id)}
                      >
                        <FileText size={12} />
                        <span>{entry.title}</span>
                      </button>
                      <button
                        className={styles.rightSidebarTabClose}
                        type="button"
                        aria-label={`关闭侧边栏窗口 ${entry.title}`}
                        data-tooltip-label={`关闭 ${entry.title}`}
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
                data-tooltip-label="新建侧边栏页面"
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
          <RightSidebarRegisteredPanelHost
            browserHostContext={{
              onCreatePanel: (url) => openDefaultRegisteredPanel(
                "browser",
                true,
                url ? { restoreUrl: url } : undefined,
              ),
              onActivatePanel: activateRegisteredPanel,
              onClosePanel: (panelId) => closeRightSidebarPanels([panelId]),
            }}
            activePanelId={resolvedActivePanelId}
            conversationHostContext={{
              runtime,
              a2uiRenderSuspended,
              onNavigateToConversation,
              onOpenModelSettings,
              onQuoteRequestHandled: handleConversationQuoteRequestHandled,
              onOpenSubagentList: (parentSessionId) =>
                rightSidebarConversation?.openSubagentList(parentSessionId),
            }}
            filesHostContext={
              filePanelRenderContext?.runtime &&
              (filePanelRenderContext.sessionId || filePanelRenderContext.workspaceId)
                ? {
                    maximized,
                    renderContext: filePanelRenderContext,
                    onRestore,
                  }
                : null
            }
            panelOrder={orderedPanelIds}
            panels={scopedPanelState.panels}
            reviewHostContext={{
              onOpenFile: canOpenFiles ? openReviewFile : undefined,
            }}
            scopeKey={activeScopeKey}
            onUpdatePanel={updateRegisteredPanelState}
          />
          {!activeRegisteredPanel ? (
            activeRequest ? (
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
                  actions={initialPageActions}
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

function sameRightSidebarScopePanelState(
  left: RightSidebarScopePanelState,
  right: RightSidebarScopePanelState,
): boolean {
  return (
    left.activePanelId === right.activePanelId &&
    left.nextPanelSeq === right.nextPanelSeq &&
    sameStringArray(left.panelOrder, right.panelOrder) &&
    sameRegisteredPanels(left.panels, right.panels) &&
    sameStringArray(left.initialPanelIds, right.initialPanelIds)
  );
}

function sameRegisteredPanels(
  left: Record<string, RightSidebarPanelState>,
  right: Record<string, RightSidebarPanelState>,
): boolean {
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  return sameStringArray(leftIds, rightIds) && leftIds.every((panelId) =>
    JSON.stringify(rightSidebarDefinitionRegistry.serializePanel(left[panelId])) ===
    JSON.stringify(rightSidebarDefinitionRegistry.serializePanel(right[panelId])),
  );
}

export type LegacyRightSidebarScopePanelState = Partial<RightSidebarScopePanelState> & {
  filePanelIds?: string[];
  filePanels?: Record<string, Partial<RightSidebarFilePanelState>>;
  conversationPanelIds?: string[];
  conversationPanels?: Record<string, Partial<Omit<RightSidebarConversationPanelState, "kind">> & {
    kind?: "conversation" | "subagent";
  }>;
  reviewPanelIds?: string[];
  reviewPanels?: Record<string, Partial<RightSidebarReviewPanelState>>;
  filesOpen?: boolean;
  initialPanelSeq?: number;
  filePreviewPath?: string | null;
  filePreviewRequestId?: number;
  toolPanelIds?: string[];
  toolPanels?: Record<string, unknown>;
};

export function normalizeRightSidebarScopePanelState(
  state: LegacyRightSidebarScopePanelState | null | undefined,
): RightSidebarScopePanelState {
  const retiredToolPanelIdsRaw = state?.toolPanelIds ?? [];
  const filePanels = Object.fromEntries(
    Object.entries(state?.filePanels ?? {}).flatMap(([panelId, panel]) => {
      const normalized = normalizeFilesPanelState({
        id: panel.id ?? panelId,
        kind: "files",
        schemaVersion: 1,
        filePreviewPath: panel.filePreviewPath ?? null,
        filePreviewRequestId: panel.filePreviewRequestId ?? 0,
        filePreviewRevealTarget: panel.filePreviewRevealTarget ?? null,
        directoryRevealPath: panel.directoryRevealPath ?? null,
        directoryRevealRequestId: panel.directoryRevealRequestId ?? 0,
        createdAt: panel.createdAt ?? LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP,
        lastActivatedAt: panel.lastActivatedAt ?? LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP,
      });
      return normalized?.id === panelId ? [[panelId, normalized] as const] : [];
    }),
  );
  let filePanelIds = state?.filePanelIds ?? [];
  if (filePanelIds.length === 0 && state?.filesOpen) {
    filePanelIds = [LEGACY_FILES_PANEL_ID];
    filePanels[LEGACY_FILES_PANEL_ID] = rightSidebarDefinitionRegistry.create("files", {
      id: LEGACY_FILES_PANEL_ID,
      sequence: 0,
      now: LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP,
      input: filesPanelCreateInput({
        path: state.filePreviewPath ?? null,
        requestId: state.filePreviewRequestId ?? 0,
      }),
    });
  }
  const conversationPanelIds = state?.conversationPanelIds ?? [];
  const conversationPanels = Object.fromEntries(
    Object.entries(state?.conversationPanels ?? {}).flatMap(([panelId, panel]) => {
      const legacyKind = (panel as unknown as { kind?: unknown }).kind;
      try {
        const normalized = rightSidebarDefinitionRegistry.create("conversation", {
          id: panel.id ?? panelId,
          sequence: maxPanelSeq([panelId]),
          now: panel.createdAt ?? LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP,
          input: conversationPanelCreateInput({
            conversationKind: panel.conversationKind ?? (
              legacyKind === "subagent" || panel.subagentRun ? "subagent" : "conversation"
            ),
            status: panel.status ?? "ready",
            sessionId: panel.sessionId ?? "",
            title: panel.title || (legacyKind === "subagent" ? "子智能体" : BTW_CONVERSATION_TITLE),
            sourceSessionId: panel.sourceSessionId ?? null,
            parentSessionId: panel.parentSessionId ?? panel.subagentRun?.parent_session_id ?? null,
            quoteRequest: panel.quoteRequest ?? null,
            loadedHistoryTurnCount: panel.loadedHistoryTurnCount ?? null,
            subagentRun: panel.subagentRun ?? null,
            subagentInvocation: panel.subagentInvocation ?? null,
          }),
        });
        return normalized.id === panelId ? [[panelId, normalized] as const] : [];
      } catch {
        return [];
      }
    }),
  );
  const reviewPanelIds = state?.reviewPanelIds ?? [];
  const reviewPanels = Object.fromEntries(
    Object.entries(state?.reviewPanels ?? {}).flatMap(([panelId, panel]) => {
      try {
        const normalized = rightSidebarDefinitionRegistry.create("review", {
          id: panel.id ?? panelId,
          sequence: maxPanelSeq([panelId]),
          now: panel.createdAt ?? LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP,
          input: reviewPanelCreateInput({
            title: panel.title || "审阅",
            files: panel.files ?? [],
            document: panel.document ?? null,
            focusedPath: panel.focusedPath ?? null,
            panelKey: panel.panelKey || panelId,
            sourceMessageId: panel.sourceMessageId ?? null,
            toolCallId: panel.toolCallId ?? null,
            requestId: panel.requestId ?? 0,
          }),
        });
        return normalized.id === panelId ? [[panelId, normalized] as const] : [];
      } catch {
        return [];
      }
    }),
  );
  const retiredToolPanelIds = new Set(retiredToolPanelIdsRaw);
  const currentPanels = Object.fromEntries(
    Object.entries(state?.panels ?? {}).flatMap(([panelId, panel]) => {
      const normalized = rightSidebarDefinitionRegistry.normalizePanel(panel, {
        now: LEGACY_RIGHT_SIDEBAR_PANEL_TIMESTAMP,
        source: "migration",
      });
      return normalized?.id === panelId ? [[panelId, normalized] as const] : [];
    }),
  );
  const panels: Record<string, RightSidebarPanelState> = {
    ...currentPanels,
    ...filePanels,
    ...conversationPanels,
    ...reviewPanels,
  };
  const initialPanelIds = state?.initialPanelIds ?? [];
  const invalidPersistedPanelIds = new Set([
    ...Object.keys(state?.panels ?? {}),
    ...Object.keys(state?.filePanels ?? {}),
    ...Object.keys(state?.conversationPanels ?? {}),
    ...Object.keys(state?.reviewPanels ?? {}),
    ...filePanelIds,
    ...conversationPanelIds,
    ...reviewPanelIds,
  ].filter((panelId) => !panels[panelId]));
  const externalPanelIds = (state?.panelOrder ?? []).filter(
    (panelId) => !invalidPersistedPanelIds.has(panelId) && !retiredToolPanelIds.has(panelId),
  );
  const nextPanelSeq = Math.max(
    state?.nextPanelSeq ?? state?.initialPanelSeq ?? 0,
    maxPanelSeq([
      ...filePanelIds,
      ...conversationPanelIds,
      ...reviewPanelIds,
      ...Object.keys(currentPanels),
      ...initialPanelIds,
    ]),
  );
  const panelOrder = orderedUniquePanelIds(
    (state?.panelOrder ?? []).filter((panelId) => !retiredToolPanelIds.has(panelId)),
    [
      ...Object.keys(filePanels),
      ...Object.keys(conversationPanels),
      ...Object.keys(reviewPanels),
      ...Object.keys(currentPanels),
      ...initialPanelIds,
      ...externalPanelIds,
    ],
  );
  const requestedActivePanelId = state?.activePanelId ?? null;
  const activePanelId = requestedActivePanelId && panelOrder.includes(requestedActivePanelId)
    ? requestedActivePanelId
    : panelOrder[0] ?? null;

  return {
    version: 2,
    activePanelId,
    panelOrder,
    panels,
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
  const reusableFilePanelId = activeFilePanelId ?? (
    options.preferExisting ? panelIdsByKind(state, "files")[0] : null
  );
  if (reusableFilePanelId) {
    return activateExistingFilePanel(state, reusableFilePanelId, options);
  }

  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${FILES_PANEL_ID_PREFIX}${nextPanelSeq}`;
  const panel = rightSidebarDefinitionRegistry.create("files", {
    id: panelId,
    sequence: nextPanelSeq,
    now: new Date().toISOString(),
    input: filesPanelCreateInput(options),
  });
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    panels: {
      ...state.panels,
      [panelId]: panel,
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
  const panel = state.panels[panelId];
  if (panel?.kind !== "files") {
    return state;
  }
  if (!hasPanelPathOption(options) && !options.requestId && !options.directoryRevealPath) {
    return { ...state, activePanelId: panelId };
  }
  const nextPanel = normalizeFilesPanelState({
    ...serializeFilesPanelState(panel),
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
    lastActivatedAt: new Date().toISOString(),
  });
  if (!nextPanel) {
    return state;
  }
  return {
    ...replaceRegisteredPanel(state, nextPanel),
    activePanelId: panelId,
  };
}

function activeFilePanelIdForState(state: RightSidebarScopePanelState): string | null {
  return state.activePanelId && state.panels[state.activePanelId]?.kind === "files"
    ? state.activePanelId
    : null;
}

function activeInitialPanelIdForState(state: RightSidebarScopePanelState): string | null {
  return state.activePanelId && state.initialPanelIds.includes(state.activePanelId) ? state.activePanelId : null;
}

function activateOrCreateReviewPanel(
  state: RightSidebarScopePanelState,
  request: ReviewPanelRequest,
): RightSidebarScopePanelState {
  const existingPanelId =
    panelIdsByKind(state, "review").find((panelId) => {
      const panel = state.panels[panelId];
      return panel?.kind === "review" && panel.panelKey === request.panelKey;
    }) ?? null;
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
    panels: {
      ...state.panels,
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
  const panel = state.panels[panelId];
  if (panel?.kind !== "review") {
    return state;
  }
  const nextPanel = normalizeReviewPanelState({
    ...serializeReviewPanelState(panel),
    title: request.title || panel.title,
    files: request.files,
    document: request.document,
    focusedPath: request.focusedPath ?? request.files[0]?.path ?? panel.focusedPath,
    sourceMessageId: request.sourceMessageId,
    toolCallId: request.toolCallId,
    requestId: Math.max(panel.requestId + 1, request.requestId),
    lastActivatedAt: new Date().toISOString(),
  });
  if (!nextPanel) {
    return state;
  }
  return {
    ...replaceRegisteredPanel(state, nextPanel),
    activePanelId: panelId,
  };
}

function reviewPanelState(panelId: string, request: ReviewPanelRequest): RightSidebarReviewPanelState {
  return rightSidebarDefinitionRegistry.create("review", {
    id: panelId,
    sequence: maxPanelSeq([panelId]),
    now: new Date().toISOString(),
    input: reviewPanelCreateInput({
      title: request.title || "审阅",
      files: request.files,
      document: request.document,
      focusedPath: request.focusedPath ?? request.files[0]?.path ?? null,
      panelKey: request.panelKey,
      sourceMessageId: request.sourceMessageId,
      toolCallId: request.toolCallId,
      requestId: request.requestId,
    }),
  });
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
    panelIdsByKind(state, "conversation").find((panelId) => {
      const panel = state.panels[panelId];
      return panel?.kind === "conversation" && panel.sessionId === sessionId;
    }) ?? null;
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
    panels: {
      ...state.panels,
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
  const panel = state.panels[panelId];
  if (panel?.kind !== "conversation") {
    return state;
  }
  return {
    ...replaceRegisteredPanel(state, {
      ...panel,
      conversationKind: "conversation",
      status: "ready",
      title: conversationPanelTitle(options),
      sourceSessionId: options.sourceSessionId ?? panel.sourceSessionId,
      parentSessionId: null,
      quoteRequest: options.quote ? nextConversationQuoteRequest(options.quote, panel.quoteRequest) : panel.quoteRequest,
      loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? panel.loadedHistoryTurnCount,
      subagentRun: null,
      subagentInvocation: null,
    }),
    activePanelId: panelId,
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
  return createConversationPanelViaDefinition(panelId, {
    conversationKind: "conversation",
    status: "ready",
    sessionId: options.session.id,
    title: conversationPanelTitle(options),
    sourceSessionId: options.sourceSessionId ?? null,
    parentSessionId: null,
    quoteRequest: options.quote ? nextConversationQuoteRequest(options.quote, null) : null,
    loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? null,
    subagentRun: null,
    subagentInvocation: null,
  });
}

function createConversationPanelViaDefinition(
  panelId: string,
  options: Parameters<typeof conversationPanelCreateInput>[0],
): RightSidebarConversationPanelState {
  return rightSidebarDefinitionRegistry.create("conversation", {
    id: panelId,
    sequence: maxPanelSeq([panelId]),
    now: new Date().toISOString(),
    input: conversationPanelCreateInput(options),
  });
}

function activateOrCreateSubagentPanel(
  state: RightSidebarScopePanelState,
  run: SubagentRunSnapshot,
): RightSidebarScopePanelState {
  const existingPanelId =
    panelIdsByKind(state, "conversation").find(
      (panelId) => {
        const panel = state.panels[panelId];
        return panel?.kind === "conversation" &&
          panel.conversationKind === "subagent" &&
          panel.parentSessionId === run.parent_session_id;
      },
    ) ?? null;
  if (existingPanelId) {
    const panel = state.panels[existingPanelId];
    if (panel?.kind !== "conversation") return state;
    return {
      ...replaceRegisteredPanel(state, {
        ...panel,
        conversationKind: "subagent",
        status: "ready",
        title: subagentPanelTitle(run),
        sessionId: run.child_session_id,
        sourceSessionId: run.parent_session_id,
        parentSessionId: run.parent_session_id,
        quoteRequest: null,
        loadedHistoryTurnCount: null,
        subagentRun: run,
        subagentInvocation: null,
      }),
      activePanelId: existingPanelId,
    };
  }
  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${CONVERSATION_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    panels: {
      ...state.panels,
      [panelId]: createConversationPanelViaDefinition(panelId, {
        conversationKind: "subagent",
        status: "ready",
        sessionId: run.child_session_id,
        title: subagentPanelTitle(run),
        sourceSessionId: run.parent_session_id,
        parentSessionId: run.parent_session_id,
        quoteRequest: null,
        loadedHistoryTurnCount: null,
        subagentRun: run,
        subagentInvocation: null,
      }),
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
  const existingPanelId = panelIdsByKind(state, "conversation").find((panelId) => {
    const panel = state.panels[panelId];
    return panel?.kind === "conversation" &&
      panel.conversationKind === "subagent" &&
      panel.parentSessionId === parentSessionId;
  }) ?? null;
  if (existingPanelId) {
    const panel = state.panels[existingPanelId];
    if (panel?.kind !== "conversation") return state;
    return {
      ...replaceRegisteredPanel(state, {
        ...panel,
        ...selection,
        conversationKind: "subagent",
        status: "ready",
        title: "子智能体",
        sourceSessionId: parentSessionId,
        parentSessionId,
        quoteRequest: null,
        loadedHistoryTurnCount: null,
      }),
      activePanelId: existingPanelId,
    };
  }
  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${CONVERSATION_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    panels: {
      ...state.panels,
      [panelId]: createConversationPanelViaDefinition(panelId, {
        conversationKind: "subagent",
        status: "ready",
        title: "子智能体",
        sourceSessionId: parentSessionId,
        parentSessionId,
        quoteRequest: null,
        loadedHistoryTurnCount: null,
        ...selection,
      }),
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
      panels: {
        ...state.panels,
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
  return createConversationPanelViaDefinition(panelId, {
    conversationKind: "conversation",
    status: "opening",
    sessionId: "",
    title: BTW_CONVERSATION_TITLE,
    sourceSessionId: options.sourceSessionId,
    parentSessionId: null,
    quoteRequest: options.quote ? nextConversationQuoteRequest(options.quote, null) : null,
    loadedHistoryTurnCount: null,
    subagentRun: null,
    subagentInvocation: null,
  });
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
  const panel = state.panels[panelId];
  if (panel?.kind !== "conversation" || panel.status !== "opening") {
    return state;
  }
  return {
    ...replaceRegisteredPanel(state, {
      ...panel,
      conversationKind: "conversation",
      status: "ready",
      sessionId: options.session.id,
      title: conversationPanelTitle(options),
      sourceSessionId: options.sourceSessionId ?? panel.sourceSessionId,
      parentSessionId: null,
      loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? panel.loadedHistoryTurnCount,
      subagentRun: null,
      subagentInvocation: null,
    }),
    activePanelId: state.activePanelId ?? panelId,
  };
}

function removeConversationPanelFromState(
  state: RightSidebarScopePanelState,
  panelId: string,
): RightSidebarScopePanelState {
  if (state.panels[panelId]?.kind !== "conversation") {
    return state;
  }
  const nextPanelOrder = state.panelOrder.filter((id) => id !== panelId);
  const next = removeRegisteredPanels(state, new Set([panelId]));
  return {
    ...next,
    activePanelId: state.activePanelId === panelId ? nextPanelIdAfterRemoval(state.panelOrder, panelId) : state.activePanelId,
    panelOrder: nextPanelOrder,
  };
}

function nextConversationQuoteRequest(
  quote: SelectedQuote,
  previous: ConversationPanelQuoteRequest | null,
): ConversationPanelQuoteRequest {
  return {
    requestId: (previous?.requestId ?? 0) + 1,
    quote,
  };
}

function conversationPanelTitle(options: { session: AgentSession; title?: string | null }): string {
  return options.title?.trim() || options.session.title?.trim() || BTW_CONVERSATION_TITLE;
}

function orderedRightSidebarPanelIds(state: RightSidebarScopePanelState, entryIds: string[]): string[] {
  return previewScopePanelIds(state, entryIds);
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
  return sameRegisteredPanels(left.panels, right.panels);
}

function sameConversationPanels(left: RightSidebarScopePanelState, right: RightSidebarScopePanelState): boolean {
  return sameRegisteredPanels(left.panels, right.panels);
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
  return sameRegisteredPanels(left.panels, right.panels);
}

function sameFileReviewChanges(left: readonly FileReviewChange[], right: readonly FileReviewChange[]): boolean {
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
  left: ConversationPanelQuoteRequest | null,
  right: ConversationPanelQuoteRequest | null,
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
        data-tooltip-label={maximized ? `缩小${placementLabel}` : `展开${placementLabel}到对话区域`}
        onClick={maximized ? onRestore : onMaximize}
      >
        {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
      <button
        className={styles.rightSidebarIconButton}
        data-icon={onLeft ? "panel-left-close" : "panel-right-close"}
        type="button"
        aria-label={`折叠${placementLabel}`}
        data-tooltip-label={`折叠${placementLabel}`}
        onClick={onClose}
      >
        <CloseIcon size={17} strokeWidth={2.1} />
      </button>
    </>
  );
}
