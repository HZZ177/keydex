import {
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Globe2,
  PanelLeftClose,
  PanelRightClose,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { RuntimeBridge } from "@/runtime";
import { TerminalDockAction } from "@/renderer/features/terminal";
import { useRafPanelResize } from "@/renderer/components/layout/useRafPanelResize";
import {
  FilePreview,
  WorkspaceFileBrowser,
  WorkspaceSelector,
  type FilePreviewRevealRequest,
  type MarkdownOutlineItem,
  type MarkdownOutlineRevealRequest,
  type WorkspaceFileBrowserState,
  type WorkspaceSelection,
} from "@/renderer/components/workspace";
import { evictFileMarkdownRuntimeEntry } from "@/renderer/components/workspace/fileMarkdownRuntime";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { composerNewWorkspaceDraftScope } from "@/renderer/features/composer";
import {
  canonicalizeBrowserFileAddress,
  normalizePersistedBrowserTab,
  serializePersistableBrowserTab,
  type BrowserTabCreateOptions,
  type PersistedBrowserTabSnapshot,
} from "@/renderer/features/browser/domain";
import {
  browserGeometryCoordinator,
  browserPanelRuntime,
  browserRuntimePanelId,
  useBrowserOcclusionToken,
} from "@/renderer/features/browser/runtime";
import { BrowserTabSurface } from "@/renderer/features/browser/ui/BrowserTabSurface";
import { rightSidebarPersistenceForRuntime } from "@/renderer/components/layout/rightSidebar/persistence";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { clampWorkbenchAssistantDrawerWidth } from "@/renderer/hooks/layout/layoutStore";
import {
  useAgentSessionController,
  type AgentSessionControllerEnsureSessionRequest,
} from "@/renderer/hooks/useAgentSessionController";
import { createBtwConversationFromSession } from "@/renderer/pages/conversation/conversationForkSource";
import {
  useOptionalPreview,
  type PreviewFileRevealTarget,
  type PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";
import type { PreviewMarkdownViewDescriptor, PreviewRequest } from "@/renderer/providers/previewTypes";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useWorkspaceFileWatchScope } from "@/renderer/providers/FileChangeProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import {
  terminalSessionScopeFromWorkbench,
  usePublishTerminalSessionScope,
} from "@/renderer/providers/TerminalSessionScopeProvider";
import { isAbsoluteFilePath, workspaceRelativeFilePath } from "@/renderer/utils/fileLinks";
import type { AgentSession, PendingInputMode, Workspace } from "@/types/protocol";

import {
  createWorkbenchBrowserAdapter,
  type WorkbenchBrowserTabState,
} from "./workbenchBrowserAdapter";
import {
  closeWorkbenchTabState,
  disposeWorkbenchBrowserTabOnce,
  openWorkbenchBrowserTabState,
  requestWorkbenchAssociatedBrowserReloadState,
} from "./workbenchMainTabModel";
import {
  resolveWorkbenchAssistantDockInlineWidth,
  WorkbenchAssistantSurface,
  type WorkbenchAssistantDockTransitionState,
} from "./WorkbenchAssistantSurface";
import styles from "./WorkbenchModePage.module.css";

export interface WorkbenchModePageProps {
  runtime: RuntimeBridge;
  workspaceId?: string;
  selectedSessionId?: string;
  externalPreviewPath?: string;
  externalPreviewIntentPath?: string;
  externalPreviewIntentKey?: string;
  selectedWorkspace?: Workspace | null;
  workspaces?: Workspace[];
  workspaceLoading?: boolean;
  workspaceError?: string | null;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onAddWorkspace?: (path: string) => Promise<void> | void;
  onPickWorkspacePath?: () => Promise<string | null>;
  onSessionSelected?: (sessionId: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onRequestNewSession?: () => void;
  onExternalPreviewIntentConsumed?: () => void;
  onExternalPreviewClosed?: () => void;
  onOpenMcpSettings?: () => void;
}

interface WorkbenchMainFileTabState {
  kind: "file";
  id: string;
  request: PreviewRequest;
  requestId: number;
  refreshRequestId: number;
  revealTarget: PreviewFileRevealTarget | null;
  renderContext: PreviewRenderContext | null;
  sourceEntryId: string | null;
  sourceLabel: string;
  title: string;
  markdownView: PreviewMarkdownViewDescriptor;
}

type WorkbenchMainTabState = WorkbenchMainFileTabState | WorkbenchBrowserTabState;

interface WorkbenchPreviewTabsState {
  activeTabId: string | null;
  tabs: WorkbenchMainTabState[];
}

interface PersistedWorkbenchBrowserTabState {
  kind: "browser";
  browser: PersistedBrowserTabSnapshot;
  previewFilePath?: string;
  previewFileKey?: string;
}

interface PersistedWorkbenchPreviewTabsState {
  activeTabId: string | null;
  tabs: Array<WorkbenchMainFileTabState | PersistedWorkbenchBrowserTabState>;
}

interface WorkbenchModeUiState {
  previewBrowserWidth: number;
  previewTabs: WorkbenchPreviewTabsState;
  activeMainPreviewOutline: MarkdownOutlineItem[];
  activeMainPreviewOutlineReady: boolean;
  workspaceBrowserState: WorkspaceFileBrowserState | null;
}

interface WorkbenchPreviewTabMenuState {
  tabId: string;
  position: CSSProperties;
}

interface WorkbenchPreviewTabScrollState {
  hasOverflow: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

const DEFAULT_WORKBENCH_BROWSER_WIDTH = 300;
const MIN_WORKBENCH_BROWSER_WIDTH = 220;
const MIN_WORKBENCH_MAIN_PREVIEW_WIDTH = 320;
const WORKBENCH_PREVIEW_TAB_MENU_WIDTH = 148;
const WORKBENCH_PREVIEW_TAB_MENU_HEIGHT = 136;
const WORKBENCH_PREVIEW_TAB_MENU_EDGE = 8;
const WORKBENCH_PREVIEW_TAB_SCROLL_PADDING = 8;
const EMPTY_WORKBENCH_PREVIEW_TAB_SCROLL_STATE: WorkbenchPreviewTabScrollState = {
  hasOverflow: false,
  canScrollLeft: false,
  canScrollRight: false,
};
const EMPTY_WORKBENCH_PREVIEW_TABS: WorkbenchPreviewTabsState = {
  activeTabId: null,
  tabs: [],
};
const workbenchModeUiStateCacheByRuntime = new WeakMap<RuntimeBridge, Map<string, WorkbenchModeUiState>>();
const WORKBENCH_UI_STORAGE_PREFIX = "keydex.workbench.ui-state.v1";

export function WorkbenchModePage({
  runtime,
  workspaceId,
  selectedSessionId,
  externalPreviewPath,
  externalPreviewIntentPath,
  externalPreviewIntentKey,
  selectedWorkspace,
  workspaces = [],
  workspaceLoading = false,
  workspaceError = null,
  onSelectWorkspace,
  onAddWorkspace,
  onPickWorkspacePath,
  onSessionSelected,
  onSessionCreated,
  onRequestNewSession,
  onExternalPreviewIntentConsumed,
  onExternalPreviewClosed,
  onOpenMcpSettings,
}: WorkbenchModePageProps) {
  const notifications = useNotifications();
  useWorkspaceFileWatchScope(workspaceId);
  const [conversationSendDefaultMode, setConversationSendDefaultMode] = useState<PendingInputMode>("steer");
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const previewContext = useOptionalPreview();
  const layout = useLayoutState();
  const workbenchUiScopeKey = workbenchModeUiScopeKey({ workspaceId, externalPreviewPath });
  // Preserve the currently visible layout once when upgrading from the former per-session cache.
  const legacyWorkbenchUiScopeKey = legacySessionScopedWorkbenchModeUiScopeKey({
    workspaceId,
    selectedSessionId,
    externalPreviewPath,
  });
  const workbenchUiStateCache = workbenchModeUiStateCacheForRuntime(runtime);
  const cachedWorkbenchUiState = cachedWorkbenchModeUiState(
    workbenchUiStateCache,
    workbenchUiScopeKey,
    legacyWorkbenchUiScopeKey,
  );
  const cachedWorkspaceBrowserState =
    cachedWorkbenchUiState?.workspaceBrowserState ?? null;
  const initialWorkbenchUiStateRef = useRef<WorkbenchModeUiState | null | undefined>(undefined);
  if (initialWorkbenchUiStateRef.current === undefined) {
    initialWorkbenchUiStateRef.current = cachedWorkbenchUiState;
  }
  const initialWorkbenchUiState = initialWorkbenchUiStateRef.current;
  const workbenchUiStateScopeKeyRef = useRef(workbenchUiScopeKey);
  const workspaceShellRef = useRef<HTMLElement | null>(null);
  const canvasContentRef = useRef<HTMLDivElement | null>(null);
  const previewBrowserRootWidthRef = useRef(0);
  const browserResizeSessionRef = useRef<number | null>(null);
  const handledFilePanelRequestIdRef = useRef(previewContext?.filePanelRequest?.requestId ?? 0);
  const handledPreviewEntryStampRef = useRef(previewContext?.activeEntry ? previewEntryStamp(previewContext.activeEntry) : "");
  const mainPreviewRequestSeqRef = useRef(maxWorkbenchPreviewRequestId(initialWorkbenchUiState?.previewTabs));
  const browserTabSeqRef = useRef(0);
  const disposedBrowserTabIdsRef = useRef(new Set<string>());
  const [creatingSession, setCreatingSession] = useState(false);
  const [btwSession, setBtwSession] = useState<AgentSession | null>(null);
  const [btwLoadedHistoryTurnCount, setBtwLoadedHistoryTurnCount] = useState<number | null>(null);
  const [dockTransitioning, setDockTransitioning] = useState(false);
  const [dockTransitionLayout, setDockTransitionLayout] = useState<WorkbenchAssistantDockTransitionState>({
    phase: "idle",
    reservedWidth: 0,
  });
  const [previewBrowserWidth, setPreviewBrowserWidth] = useState(
    initialWorkbenchUiState?.previewBrowserWidth ?? DEFAULT_WORKBENCH_BROWSER_WIDTH,
  );
  const [workbenchPreviewTabs, setWorkbenchPreviewTabs] =
    useState<WorkbenchPreviewTabsState>(initialWorkbenchUiState?.previewTabs ?? EMPTY_WORKBENCH_PREVIEW_TABS);
  const workbenchPreviewTabsRef = useRef(workbenchPreviewTabs);
  useEffect(() => {
    workbenchPreviewTabsRef.current = workbenchPreviewTabs;
  }, [workbenchPreviewTabs]);
  const retainedWorkbenchMarkdownViewsRef = useRef(new Map<string, PreviewMarkdownViewDescriptor>());
  useEffect(() => {
    const next = new Map(workbenchPreviewTabs.tabs.flatMap((tab) =>
      tab.kind === "file" ? [[tab.id, tab.markdownView] as const] : []));
    for (const [tabId, descriptor] of retainedWorkbenchMarkdownViewsRef.current) {
      if (!next.has(tabId)) evictFileMarkdownRuntimeEntry(descriptor.scopeId, descriptor.entryId);
    }
    retainedWorkbenchMarkdownViewsRef.current = next;
  }, [workbenchPreviewTabs.tabs]);
  const [activeMainPreviewOutline, setActiveMainPreviewOutline] = useState<MarkdownOutlineItem[]>(
    initialWorkbenchUiState?.activeMainPreviewOutline ?? [],
  );
  const [activeMainPreviewOutlineReady, setActiveMainPreviewOutlineReady] = useState(
    initialWorkbenchUiState?.activeMainPreviewOutlineReady ?? false,
  );
  const [mainPreviewOutlineRevealRequest, setMainPreviewOutlineRevealRequest] =
    useState<MarkdownOutlineRevealRequest | null>(null);
  const [workspaceBrowserState, setWorkspaceBrowserState] = useState<WorkspaceFileBrowserState | null>(
    initialWorkbenchUiState?.workspaceBrowserState ?? null,
  );
  const activeWorkbenchPreviewTab = useMemo(
    () => workbenchPreviewTabs.tabs.find((tab) => tab.id === workbenchPreviewTabs.activeTabId) ?? null,
    [workbenchPreviewTabs.activeTabId, workbenchPreviewTabs.tabs],
  );
  const assistantViewportKey = activeWorkbenchPreviewTab
    ? activeWorkbenchPreviewTab.kind === "file"
      ? `${activeWorkbenchPreviewTab.id}:${activeWorkbenchPreviewTab.requestId}:${activeWorkbenchPreviewTab.refreshRequestId ?? 0}`
      : `${activeWorkbenchPreviewTab.id}:${activeWorkbenchPreviewTab.restoreUrl}`
    : "workspace-browser";
  const [mainPreviewProximity, setMainPreviewProximity] = useState<{
    key: string;
    nearBottom: boolean | null;
  }>({
    key: assistantViewportKey,
    nearBottom: activeWorkbenchPreviewTab?.kind === "file" ? null : false,
  });
  const mainPreviewNearBottom = activeWorkbenchPreviewTab?.kind !== "file"
    ? false
    : mainPreviewProximity.key === assistantViewportKey
      ? mainPreviewProximity.nearBottom
      : null;
  const handleMainPreviewNearBottomChange = useCallback((nearBottom: boolean | null) => {
    setMainPreviewProximity({
      key: assistantViewportKey,
      nearBottom,
    });
  }, [assistantViewportKey]);
  const previousWorkbenchUiScopeRef = useRef({
    externalPreviewPath,
    workspaceId,
  });
  const previousSessionIdRef = useRef(selectedSessionId);
  const handledExternalPreviewIntentKeyRef = useRef<string | null>(null);
  const activeWorkbenchPreviewPath = activeWorkbenchPreviewTab
    ? activeWorkbenchPreviewTab.kind === "file"
      ? targetPathForPreviewRequest(activeWorkbenchPreviewTab.request)
      : activeWorkbenchPreviewTab.previewFilePath ?? null
    : null;
  const selectorValue: WorkspaceSelection = selectedWorkspace
    ? { type: "workspace", workspace: selectedWorkspace }
    : { type: "chat" };
  const workspaceLabel = selectedWorkspace?.root_path ?? selectedWorkspace?.name ?? workspaceId;
  const showPicker = !workspaceId && !externalPreviewPath;
  const showWorkspaceLoading = Boolean(workspaceId && workspaceLoading && !selectedWorkspace && !externalPreviewPath);
  const showWorkspaceUnavailable = Boolean(workspaceId && workspaceError && !selectedWorkspace && !externalPreviewPath);
  const drawerWidth = layout.state.workbenchAssistantDrawerWidth;
  const drawerInlineWidth = resolveWorkbenchAssistantDockInlineWidth(
    drawerWidth,
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const assistantDrawerInline =
    dockTransitionLayout.reservedWidth > 0 &&
    (dockTransitionLayout.phase === "idle" || dockTransitionLayout.phase === "resize");
  const applyDrawerInlineWidth = useCallback((width: number) => {
    const nextInlineWidth = resolveWorkbenchAssistantDockInlineWidth(
      clampWorkbenchAssistantDrawerWidth(width),
      typeof window === "undefined" ? 1280 : window.innerWidth,
    );
    workspaceShellRef.current?.style.setProperty("--workbench-assistant-dock-inline-size", `${nextInlineWidth}px`);
  }, []);
  const previewDrawerWidth = useCallback((width: number) => {
    applyDrawerInlineWidth(width);
  }, [applyDrawerInlineWidth]);
  const commitDrawerWidth = useCallback(
    (width: number) => {
      applyDrawerInlineWidth(width);
      layout.actions.setWorkbenchAssistantDrawerWidth(width);
    },
    [applyDrawerInlineWidth, layout.actions],
  );
  const updateDockTransitionLayout = useCallback((state: WorkbenchAssistantDockTransitionState) => {
    setDockTransitionLayout(state);
  }, []);
  const applyWorkbenchPreviewBrowserWidth = useCallback((width: number) => {
    canvasContentRef.current?.style.setProperty("--workbench-main-browser-width", `${Math.round(width)}px`);
  }, []);
  const clampWorkbenchPreviewBrowserWidth = useCallback((width: number) => {
    const rootWidth =
      previewBrowserRootWidthRef.current || canvasContentRef.current?.getBoundingClientRect().width || 0;
    const maxWidth =
      rootWidth > 0
        ? Math.max(MIN_WORKBENCH_BROWSER_WIDTH, rootWidth - MIN_WORKBENCH_MAIN_PREVIEW_WIDTH)
        : Number.POSITIVE_INFINITY;
    return Math.round(clampNumber(width, MIN_WORKBENCH_BROWSER_WIDTH, maxWidth));
  }, []);
  const previewWorkbenchPreviewBrowserWidth = useCallback(
    (width: number) => {
      applyWorkbenchPreviewBrowserWidth(clampWorkbenchPreviewBrowserWidth(width));
    },
    [applyWorkbenchPreviewBrowserWidth, clampWorkbenchPreviewBrowserWidth],
  );
  const commitWorkbenchPreviewBrowserWidth = useCallback(
    (width: number) => {
      const nextWidth = clampWorkbenchPreviewBrowserWidth(width);
      applyWorkbenchPreviewBrowserWidth(nextWidth);
      setPreviewBrowserWidth(nextWidth);
    },
    [applyWorkbenchPreviewBrowserWidth, clampWorkbenchPreviewBrowserWidth],
  );
  const getWorkbenchPreviewBrowserDragWidth = useCallback(
    (startWidth: number, startX: number, clientX: number) =>
      clampWorkbenchPreviewBrowserWidth(startWidth + clientX - startX),
    [clampWorkbenchPreviewBrowserWidth],
  );
  const beginWorkbenchBrowserInteractiveResize = useCallback((input: {
    readonly startWidth: number;
    readonly startScreenCoordinate: number;
  }) => {
    const rootWidth =
      previewBrowserRootWidthRef.current || canvasContentRef.current?.getBoundingClientRect().width || 0;
    browserResizeSessionRef.current = browserGeometryCoordinator.beginInteractiveResize(
      workbenchBrowserInteractiveResizeInput(
        input.startWidth,
        input.startScreenCoordinate,
        rootWidth,
      ),
    );
  }, []);
  const endWorkbenchBrowserInteractiveResize = useCallback(() => {
    browserGeometryCoordinator.endInteractiveResize(browserResizeSessionRef.current);
    browserResizeSessionRef.current = null;
  }, []);
  const workbenchPreviewResize = useRafPanelResize({
    disabled: !activeWorkbenchPreviewTab,
    width: previewBrowserWidth,
    getWidth: getWorkbenchPreviewBrowserDragWidth,
    onPreview: previewWorkbenchPreviewBrowserWidth,
    onCommit: commitWorkbenchPreviewBrowserWidth,
    onDragStart: beginWorkbenchBrowserInteractiveResize,
    onDragEnd: endWorkbenchBrowserInteractiveResize,
  });
  const startWorkbenchPreviewResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button > 0 || !canvasContentRef.current) {
        return;
      }
      previewBrowserRootWidthRef.current = canvasContentRef.current.getBoundingClientRect().width;
      workbenchPreviewResize.startDrag(event);
    },
    [workbenchPreviewResize],
  );
  const resetWorkbenchPreviewWidth = useCallback((event: MouseEvent<HTMLDivElement>) => {
    workbenchPreviewResize.finishDrag();
    previewBrowserRootWidthRef.current = canvasContentRef.current?.getBoundingClientRect().width || 0;
    commitWorkbenchPreviewBrowserWidth(DEFAULT_WORKBENCH_BROWSER_WIDTH);
    event.preventDefault();
  }, [commitWorkbenchPreviewBrowserWidth, workbenchPreviewResize]);
  const ensureWorkbenchSession = useCallback(
    async ({ title, model }: AgentSessionControllerEnsureSessionRequest) => {
      if (!workspaceId) {
        return null;
      }
      setCreatingSession(true);
      try {
        const session = await runtime.conversation.createSession({
          title,
          session_tag: "chat",
          sessionType: "workspace",
          workspaceId,
          ...(model
            ? {
                currentModelProviderId: model.providerId,
                currentModel: model.model,
              }
            : {}),
        });
        emitSessionCreated(session);
        onSessionCreated?.(session);
        onSessionSelected?.(session.id);
        return session;
      } finally {
        setCreatingSession(false);
      }
    },
    [onSessionCreated, onSessionSelected, runtime, workspaceId],
  );
  const requestNewWorkbenchSession = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    onRequestNewSession?.();
  }, [onRequestNewSession, workspaceId]);
  const promoteWorkbenchSidebarDraft = useCallback(
    async (targetSessionId: string) => {
      if (!workspaceId) return;
      await rightSidebarPersistenceForRuntime(runtime).promote(
        `workspace:${workspaceId}`,
        targetSessionId,
      );
    },
    [runtime, workspaceId],
  );
  const assistantController = useAgentSessionController({
    runtime,
    sessionId: selectedSessionId ?? "",
    enabled: backendReady,
    composerDraftScopeKey: selectedSessionId
      ? undefined
      : workspaceId
        ? composerNewWorkspaceDraftScope(workspaceId)
        : null,
    ensureSession: ensureWorkbenchSession,
    beforeSendToCreatedSession: promoteWorkbenchSidebarDraft,
    conversationSendDefaultMode,
  });
  const terminalSessionScope = useMemo(
    () =>
      terminalSessionScopeFromWorkbench({
        selectedSessionId,
        session: assistantController.session,
        workspace: selectedWorkspace,
        loading: assistantController.loading,
      }),
    [
      assistantController.loading,
      assistantController.session,
      selectedSessionId,
      selectedWorkspace,
    ],
  );
  usePublishTerminalSessionScope("workbench-main", terminalSessionScope, true, 1);
  const btwController = useAgentSessionController({
    runtime,
    sessionId: btwSession?.id ?? "",
    enabled: backendReady,
    historyPageSize: 2,
    loadFullHistory: false,
    syncThreadTasks: false,
    conversationSendDefaultMode,
  });

  useEffect(() => {
    if (!backendReady) {
      setConversationSendDefaultMode("steer");
      return;
    }
    let active = true;
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (active) {
          setConversationSendDefaultMode(settings.general.conversation_send_default_mode ?? "steer");
        }
      })
      .catch(() => {
        if (active) {
          setConversationSendDefaultMode("steer");
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, runtime]);
  const btwActive = Boolean(btwSession?.id);
  const activeAssistantController = btwActive ? btwController : assistantController;
  const workbenchPreviewRenderContext = useMemo<PreviewRenderContext | null>(() => {
    if (!workspaceId || !selectedWorkspace) {
      if (!externalPreviewPath) {
        return null;
      }
      return {
        panelScopeKey: workbenchExternalPreviewPanelScopeKey(externalPreviewPath),
        workspaceAvailable: false,
        workspaceLabel,
        runtime,
      };
    }
    return {
      panelScopeKey: workbenchPreviewPanelScopeKey(workspaceId),
      workspaceId,
      workspaceRootPath: selectedWorkspace.root_path,
      workspaceAvailable: true,
      workspaceLabel,
      runtime,
      onQuoteSelection: activeAssistantController.quoteSelection,
      onStartChatFromAnnotation: activeAssistantController.startChatFromAnnotation,
    };
  }, [
    activeAssistantController.quoteSelection,
    activeAssistantController.startChatFromAnnotation,
    externalPreviewPath,
    runtime,
    selectedWorkspace,
    workspaceId,
    workspaceLabel,
  ]);
  const resetMainPreviewOutline = useCallback(() => {
    setActiveMainPreviewOutline([]);
    setActiveMainPreviewOutlineReady(false);
    setMainPreviewOutlineRevealRequest(null);
  }, []);
  const nextMainPreviewRequestId = useCallback(() => {
    mainPreviewRequestSeqRef.current += 1;
    return mainPreviewRequestSeqRef.current;
  }, []);
  const openWorkbenchMainPreview = useCallback(
    (
      request: PreviewRequest,
      renderContext: PreviewRenderContext | null,
      revealTarget: PreviewFileRevealTarget | null = null,
      sourceEntryId: string | null = null,
      requestId?: number,
      sourceMarkdownView?: PreviewMarkdownViewDescriptor | null,
      refreshExisting = false,
    ) => {
      const tabId = workbenchPreviewTabId(request);
      const existingTab = workbenchPreviewTabsRef.current.tabs.find((item) => item.id === tabId) ?? null;
      const existingActiveTab = workbenchPreviewTabsRef.current.activeTabId === tabId
        ? existingTab?.kind === "file" ? existingTab : null
        : null;
      const canRevealInActiveTab = existingActiveTab?.request.type === request.type;
      const nextRequestId = requestId ?? nextMainPreviewRequestId();
      if (existingActiveTab && canRevealInActiveTab) {
        setWorkbenchPreviewTabs((current) => {
          const next = {
            activeTabId: tabId,
            tabs: current.tabs.map((item) => item.id === tabId && item.kind === "file"
              ? {
                  ...item,
                  request: request.type === "skill-resource" ? request : item.request,
                  requestId: nextRequestId,
                  refreshRequestId: refreshExisting ? (item.refreshRequestId ?? 0) + 1 : (item.refreshRequestId ?? 0),
                  revealTarget,
                  renderContext: renderContext ?? item.renderContext,
                  sourceEntryId: sourceEntryId ?? item.sourceEntryId,
                }
              : item),
          };
          workbenchPreviewTabsRef.current = next;
          return next;
        });
        return;
      }
      resetMainPreviewOutline();
      const tab: WorkbenchMainFileTabState = {
        kind: "file",
        id: tabId,
        request,
        requestId: nextRequestId,
        refreshRequestId: existingTab?.kind === "file" ? existingTab.refreshRequestId : 0,
        revealTarget,
        renderContext,
        sourceEntryId,
        sourceLabel: previewSourceLabel(request),
        title: previewTitle(request),
        markdownView: workbenchMarkdownViewDescriptor(
          request,
          renderContext,
          tabId,
          sourceMarkdownView,
        ),
      };
      setWorkbenchPreviewTabs((current) => {
        const existingIndex = current.tabs.findIndex((item) => item.id === tab.id);
        const tabs =
          existingIndex === -1
            ? [...current.tabs, tab]
            : current.tabs.map((item) => (item.id === tab.id
              ? {
                  ...tab,
                  markdownView: item.kind === "file" && item.markdownView.entryId === tab.markdownView.entryId
                    ? item.markdownView
                    : tab.markdownView,
                }
              : item));
        const next = {
          activeTabId: tab.id,
          tabs,
        };
        workbenchPreviewTabsRef.current = next;
        return next;
      });
    },
    [nextMainPreviewRequestId, resetMainPreviewOutline],
  );
  const openWorkspaceBrowserFilePreview = useCallback(
    (path: string | null, refreshExisting = false) => {
      if (!path) {
        setWorkbenchPreviewTabs(EMPTY_WORKBENCH_PREVIEW_TABS);
        return;
      }
      openWorkbenchMainPreview(
        { type: "file", path },
        workbenchPreviewRenderContext,
        null,
        null,
        undefined,
        null,
        refreshExisting,
      );
    },
    [openWorkbenchMainPreview, workbenchPreviewRenderContext],
  );
  const openWorkbenchBrowserTab = useCallback((options: BrowserTabCreateOptions = {}) => {
    browserTabSeqRef.current += 1;
    try {
      const result = openWorkbenchBrowserTabState(workbenchPreviewTabsRef.current, {
        id: `workbench-browser-${Date.now().toString(36)}-${browserTabSeqRef.current.toString(36)}`,
        now: new Date().toISOString(),
        commandId: `workbench-browser-command-${Date.now().toString(36)}-${browserTabSeqRef.current.toString(36)}`,
        options,
      });
      if (workspaceId) {
        disposedBrowserTabIdsRef.current.delete(
          browserRuntimePanelId(`workspace:${workspaceId}`, result.tab.id),
        );
      }
      workbenchPreviewTabsRef.current = result.state;
      setWorkbenchPreviewTabs(result.state);
    } catch (error) {
      notifications.error(error instanceof Error ? error.message : "无法打开本地 HTML 预览");
    }
  }, [notifications, workspaceId]);
  const updateWorkbenchBrowserTab = useCallback((nextTab: WorkbenchBrowserTabState) => {
    setWorkbenchPreviewTabs((current) => {
      const next = {
        ...current,
        tabs: current.tabs.map((tab) => tab.id === nextTab.id && tab.kind === "browser" ? nextTab : tab),
      };
      workbenchPreviewTabsRef.current = next;
      return next;
    });
  }, []);
  const reloadAssociatedHtmlBrowserTab = useCallback((absolutePath: string) => {
    browserTabSeqRef.current += 1;
    const result = requestWorkbenchAssociatedBrowserReloadState(
      workbenchPreviewTabsRef.current,
      absolutePath,
      `workbench-browser-reload-${Date.now().toString(36)}-${browserTabSeqRef.current.toString(36)}`,
    );
    if (!result.tab) return;
    workbenchPreviewTabsRef.current = result.state;
    setWorkbenchPreviewTabs(result.state);
  }, []);
  const handleMainPreviewMarkdownOutlineChange = useCallback((outline: MarkdownOutlineItem[]) => {
    setActiveMainPreviewOutline(outline);
    setActiveMainPreviewOutlineReady(true);
  }, []);
  const revealMainPreviewMarkdownOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    setMainPreviewOutlineRevealRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      id: item.id,
      line: item.line,
    }));
  }, []);
  const selectWorkbenchPreviewTab = useCallback(
    (tabId: string) => {
      const tab = workbenchPreviewTabs.tabs.find((item) => item.id === tabId);
      if (!tab) {
        return;
      }
      if (workbenchPreviewTabs.activeTabId !== tabId) {
        resetMainPreviewOutline();
      }
      setWorkbenchPreviewTabs((current) =>
        {
          if (current.activeTabId === tabId) {
            return current;
          }
          const next = {
            activeTabId: tabId,
            tabs: current.tabs.map((item) => item.id === tabId && item.kind === "browser"
              ? { ...item, lastActivatedAt: new Date().toISOString() }
              : item),
          };
          workbenchPreviewTabsRef.current = next;
          return next;
        },
      );
      if (tab.kind === "file" && tab.sourceEntryId) {
        previewContext?.switchPreview(tab.sourceEntryId);
      }
    },
    [previewContext, resetMainPreviewOutline, workbenchPreviewTabs.activeTabId, workbenchPreviewTabs.tabs],
  );
  const closeWorkbenchPreviewTab = useCallback(
    (tabId: string) => {
      const result = closeWorkbenchTabState(workbenchPreviewTabsRef.current, tabId);
      const tab = result.closed;
      if (!tab) return;
      const closingExternalPreview =
        tab.kind === "file"
        && tab.request.type === "local-file"
        && externalPreviewPath
        && tab.request.path === externalPreviewPath;
      if (workbenchPreviewTabsRef.current.activeTabId === tabId) {
        resetMainPreviewOutline();
      }
      workbenchPreviewTabsRef.current = result.state;
      setWorkbenchPreviewTabs(result.state);
      if (tab.kind === "file" && tab.sourceEntryId) {
        previewContext?.closePreviewEntry(tab.sourceEntryId);
      }
      if (tab.kind === "browser" && workspaceId) {
        const runtimePanelId = browserRuntimePanelId(`workspace:${workspaceId}`, tab.id);
        disposeWorkbenchBrowserTabOnce(
          disposedBrowserTabIdsRef.current,
          runtimePanelId,
          (id) => browserPanelRuntime.disposeCurrent(id),
        );
      }
      if (workbenchPreviewRenderContext) {
        previewContext?.setPreviewHostContext(workbenchPreviewRenderContext);
      }
      if (closingExternalPreview) {
        onExternalPreviewClosed?.();
      }
    },
    [
      externalPreviewPath,
      onExternalPreviewClosed,
      previewContext,
      resetMainPreviewOutline,
      workbenchPreviewRenderContext,
      workspaceId,
    ],
  );
  const closeActiveWorkbenchPreviewTab = useCallback(() => {
    if (!activeWorkbenchPreviewTab) {
      return;
    }
    closeWorkbenchPreviewTab(activeWorkbenchPreviewTab.id);
  }, [activeWorkbenchPreviewTab, closeWorkbenchPreviewTab]);

  useEffect(() => {
    if (!previewContext || !workbenchPreviewRenderContext) {
      return;
    }
    previewContext.setPreviewHostContext(workbenchPreviewRenderContext);
    return () => previewContext.setPreviewHostContext(null);
  }, [previewContext?.setPreviewHostContext, workbenchPreviewRenderContext]);

  const openWorkbenchBtwConversation = useCallback(async () => {
    const sourceSessionId = assistantController.session?.id?.trim() || selectedSessionId?.trim() || "";
    if (!sourceSessionId) {
      notifications.warning("当前会话无法开启旁路对话");
      return null;
    }
    try {
      const result = await createBtwConversationFromSession(runtime, sourceSessionId);
      if ("error" in result) {
        notifications.warning(result.message);
        return null;
      }
      setBtwSession(result.session);
      setBtwLoadedHistoryTurnCount(result.loadedHistoryTurnCount);
      notifications.success("已打开旁路对话");
      return result.session;
    } catch (reason) {
      notifications.error(`旁路对话创建失败：${errorMessage(reason)}`);
      return null;
    }
  }, [assistantController.session?.id, notifications, runtime, selectedSessionId]);

  const closeWorkbenchBtwConversation = useCallback(() => {
    setBtwSession(null);
    setBtwLoadedHistoryTurnCount(null);
  }, []);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = selectedSessionId;
    if (previousSessionId === selectedSessionId) {
      return;
    }
    handledFilePanelRequestIdRef.current = previewContext?.filePanelRequest?.requestId ?? 0;
    handledPreviewEntryStampRef.current = previewContext?.activeEntry ? previewEntryStamp(previewContext.activeEntry) : "";
    setBtwSession(null);
    setBtwLoadedHistoryTurnCount(null);
  }, [previewContext?.activeEntry, previewContext?.filePanelRequest?.requestId, selectedSessionId]);

  useEffect(() => {
    const previousScope = previousWorkbenchUiScopeRef.current;
    previousWorkbenchUiScopeRef.current = {
      externalPreviewPath,
      workspaceId,
    };
    const workspaceScopeChanged = previousScope.workspaceId !== workspaceId;
    const externalPreviewInvolved = Boolean(previousScope.externalPreviewPath || externalPreviewPath);
    if (!workspaceScopeChanged || externalPreviewInvolved) {
      return;
    }
    handledFilePanelRequestIdRef.current = previewContext?.filePanelRequest?.requestId ?? 0;
    handledPreviewEntryStampRef.current = previewContext?.activeEntry ? previewEntryStamp(previewContext.activeEntry) : "";
    const restoredState = cachedWorkbenchModeUiState(
      workbenchUiStateCache,
      workbenchUiScopeKey,
      legacyWorkbenchUiScopeKey,
    );
    workbenchUiStateScopeKeyRef.current = workbenchUiScopeKey;
    const restoredPreviewBrowserWidth = restoredState?.previewBrowserWidth ?? DEFAULT_WORKBENCH_BROWSER_WIDTH;
    setPreviewBrowserWidth(restoredPreviewBrowserWidth);
    applyWorkbenchPreviewBrowserWidth(restoredPreviewBrowserWidth);
    mainPreviewRequestSeqRef.current = maxWorkbenchPreviewRequestId(restoredState?.previewTabs);
    const restoredPreviewTabs = restoredState?.previewTabs ?? EMPTY_WORKBENCH_PREVIEW_TABS;
    workbenchPreviewTabsRef.current = restoredPreviewTabs;
    setWorkbenchPreviewTabs(restoredPreviewTabs);
    setWorkspaceBrowserState(restoredState?.workspaceBrowserState ?? null);
    setBtwSession(null);
    setBtwLoadedHistoryTurnCount(null);
    setActiveMainPreviewOutline(restoredState?.activeMainPreviewOutline ?? []);
    setActiveMainPreviewOutlineReady(restoredState?.activeMainPreviewOutlineReady ?? false);
    setMainPreviewOutlineRevealRequest(null);
  }, [
    applyWorkbenchPreviewBrowserWidth,
    externalPreviewPath,
    legacyWorkbenchUiScopeKey,
    previewContext?.activeEntry,
    previewContext?.filePanelRequest?.requestId,
    workbenchUiStateCache,
    workbenchUiScopeKey,
    workspaceId,
  ]);

  useEffect(() => {
    if (workbenchUiStateScopeKeyRef.current !== workbenchUiScopeKey) {
      return;
    }
    const nextState: WorkbenchModeUiState = {
      previewBrowserWidth,
      previewTabs: sanitizeWorkbenchPreviewTabs(workbenchPreviewTabs),
      activeMainPreviewOutline,
      activeMainPreviewOutlineReady,
      workspaceBrowserState,
    };
    workbenchUiStateCache.set(workbenchUiScopeKey, nextState);
    persistWorkbenchModeUiState(workbenchUiScopeKey, nextState);
  }, [
    activeMainPreviewOutline,
    activeMainPreviewOutlineReady,
    previewBrowserWidth,
    workbenchPreviewTabs,
    workbenchUiStateCache,
    workbenchUiScopeKey,
    workspaceBrowserState,
  ]);

  useEffect(() => {
    if (!externalPreviewIntentPath) {
      handledExternalPreviewIntentKeyRef.current = null;
      return;
    }
    const intentKey = externalPreviewIntentKey ?? externalPreviewIntentPath;
    if (
      !workbenchPreviewRenderContext ||
      handledExternalPreviewIntentKeyRef.current === intentKey
    ) {
      return;
    }
    handledExternalPreviewIntentKeyRef.current = intentKey;
    const request: PreviewRequest = { type: "local-file", path: externalPreviewIntentPath };
    const tabId = workbenchPreviewTabId(request);
    const existingTab = workbenchPreviewTabs.tabs.find(
      (item): item is WorkbenchMainFileTabState => item.id === tabId && item.kind === "file",
    );
    openWorkbenchMainPreview(
      request,
      workbenchPreviewRenderContext,
      existingTab?.revealTarget ?? null,
      existingTab?.sourceEntryId ?? null,
      undefined,
      existingTab?.markdownView ?? null,
      true,
    );
    onExternalPreviewIntentConsumed?.();
  }, [
    externalPreviewIntentPath,
    externalPreviewIntentKey,
    onExternalPreviewIntentConsumed,
    openWorkbenchMainPreview,
    workbenchPreviewRenderContext,
    workbenchPreviewTabs.tabs,
  ]);

  useEffect(() => {
    if (!externalPreviewPath || !workbenchPreviewRenderContext) {
      return;
    }
    const request: PreviewRequest = { type: "local-file", path: externalPreviewPath };
    const tabId = workbenchPreviewTabId(request);
    const existingTab = workbenchPreviewTabs.tabs.find(
      (item): item is WorkbenchMainFileTabState => item.id === tabId && item.kind === "file",
    );
    if (!existingTab || existingTab.renderContext === workbenchPreviewRenderContext) {
      return;
    }
    setWorkbenchPreviewTabs((current) => ({
      activeTabId: current.activeTabId,
      tabs: current.tabs.map((item) =>
        item.id === tabId && item.kind === "file"
          ? { ...item, renderContext: workbenchPreviewRenderContext }
          : item,
      ),
    }));
  }, [externalPreviewPath, workbenchPreviewRenderContext, workbenchPreviewTabs.tabs]);

  useEffect(() => {
    const activeEntry = previewContext?.open ? previewContext.activeEntry : null;
    if (!activeEntry) {
      return;
    }
    const stamp = previewEntryStamp(activeEntry);
    if (stamp === handledPreviewEntryStampRef.current) {
      return;
    }
    handledPreviewEntryStampRef.current = stamp;
    openWorkbenchMainPreview(
      activeEntry.request,
      activeEntry.renderContext ?? workbenchPreviewRenderContext,
      activeEntry.revealTarget,
      activeEntry.id,
      activeEntry.openedAt,
      activeEntry.markdownView,
    );
  }, [
    openWorkbenchMainPreview,
    previewContext?.activeEntry,
    previewContext?.activeEntry?.openedAt,
    previewContext?.open,
    workbenchPreviewRenderContext,
  ]);

  useEffect(() => {
    const request = previewContext?.filePanelRequest ?? null;
    if (
      !workspaceId ||
      !request?.requestId ||
      request.requestId === handledFilePanelRequestIdRef.current ||
      request.scopeKey !== previewContext?.activeScopeKey ||
      !request.path
    ) {
      return;
    }
    handledFilePanelRequestIdRef.current = request.requestId;
    openWorkbenchMainPreview(
      previewRequestFromPath(request.path),
      request.renderContext ?? workbenchPreviewRenderContext,
      request.revealTarget ?? null,
      null,
      request.requestId,
    );
  }, [
    openWorkbenchMainPreview,
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.path,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.revealTarget,
    previewContext?.filePanelRequest?.renderContext,
    previewContext?.filePanelRequest?.scopeKey,
    workbenchPreviewRenderContext,
    workspaceId,
  ]);

  return (
    <div
      className={styles.root}
      data-testid="workbench-mode-page"
      data-workspace-id={workspaceId ?? ""}
      data-selected-session-id={selectedSessionId ?? ""}
    >
      {showPicker ? (
        <main className={styles.picker} data-testid="workbench-workspace-picker" aria-label="工作台工作空间选择">
          <div className={styles.pickerContent}>
            <span className={styles.label}>Workbench</span>
            <h1>选择工作空间</h1>
            <WorkspaceSelector
              value={selectorValue}
              workspaces={workspaces}
              loading={workspaceLoading}
              allowProjectFreeChat={false}
              onSelectWorkspace={onSelectWorkspace}
              onAddWorkspace={onAddWorkspace}
              onPickWorkspacePath={onPickWorkspacePath}
            />
            {workspaceError ? <p className={styles.error} role="alert">{workspaceError}</p> : null}
          </div>
          <WorkbenchAssistantPlaceholder disabled label="选择工作空间后启用助手" />
        </main>
      ) : showWorkspaceLoading ? (
        <main className={styles.picker} data-testid="workbench-workspace-loading" aria-label="工作台工作空间加载中">
          <div className={styles.pickerContent}>
            <span className={styles.label}>Workbench</span>
            <h1>正在加载工作空间</h1>
            <WorkspaceSelector
              value={selectorValue}
              workspaces={workspaces}
              loading={workspaceLoading}
              allowProjectFreeChat={false}
              onSelectWorkspace={onSelectWorkspace}
              onAddWorkspace={onAddWorkspace}
              onPickWorkspacePath={onPickWorkspacePath}
            />
          </div>
          <WorkbenchAssistantPlaceholder disabled label="工作空间加载中" />
        </main>
      ) : showWorkspaceUnavailable ? (
        <main className={styles.picker} data-testid="workbench-workspace-error" aria-label="工作台工作空间不可用">
          <div className={styles.pickerContent}>
            <span className={styles.label}>Workbench</span>
            <h1>工作空间不可用</h1>
            <p className={styles.error} role="alert">{workspaceError}</p>
            <WorkspaceSelector
              value={selectorValue}
              workspaces={workspaces}
              loading={workspaceLoading}
              allowProjectFreeChat={false}
              onSelectWorkspace={onSelectWorkspace}
              onAddWorkspace={onAddWorkspace}
              onPickWorkspacePath={onPickWorkspacePath}
            />
          </div>
          <WorkbenchAssistantPlaceholder disabled label="选择工作空间后启用助手" />
        </main>
      ) : (
        <main
          ref={workspaceShellRef}
          className={styles.workspace}
          data-testid="workbench-workspace-shell"
          data-assistant-drawer-inline={assistantDrawerInline ? "true" : "false"}
          data-dock-transitioning={dockTransitioning ? "true" : "false"}
          data-dock-transition-phase={dockTransitionLayout.phase}
          style={
            {
              "--workbench-assistant-dock-inline-size": `${drawerInlineWidth}px`,
              "--workbench-dock-reserved-width": `${dockTransitionLayout.reservedWidth}px`,
            } as CSSProperties
          }
          aria-label="工作台"
        >
          <div className={styles.canvas}>
            <div
              ref={canvasContentRef}
              className={styles.canvasContent}
              data-testid="workbench-canvas-content"
              data-main-preview-open={activeWorkbenchPreviewTab ? "true" : "false"}
              style={{ "--workbench-main-browser-width": `${previewBrowserWidth}px` } as CSSProperties}
            >
              <div className={styles.browserPane} data-main-preview-open={activeWorkbenchPreviewTab ? "true" : "false"}>
                {workspaceId && selectedWorkspace ? (
                  <WorkspaceFileBrowser
                    key={workbenchUiScopeKey}
                    runtime={runtime}
                    workspaceId={workspaceId}
                    workspaceRootPath={selectedWorkspace.root_path}
                    label={workspaceLabel}
                    initialNavigationMode={externalPreviewPath ? "outline" : "files"}
                    previewPath={activeWorkbenchPreviewPath}
                    previewRequestId={
                      activeWorkbenchPreviewTab?.kind === "file"
                        ? activeWorkbenchPreviewTab.requestId
                        : 0
                    }
                    previewRevealTarget={
                      activeWorkbenchPreviewTab?.kind === "file"
                        ? activeWorkbenchPreviewTab.revealTarget
                        : null
                    }
                    directoryRevealPath={
                      previewContext?.filePanelRequest?.scopeKey === previewContext?.activeScopeKey
                        ? previewContext?.filePanelRequest?.directoryRevealPath ?? null
                        : null
                    }
                    directoryRevealRequestId={
                      previewContext?.filePanelRequest?.scopeKey === previewContext?.activeScopeKey
                        ? previewContext?.filePanelRequest?.requestId ?? 0
                        : 0
                    }
                    previewPlacement="external"
                    previewOutline={activeMainPreviewOutline}
                    previewOutlineReady={activeMainPreviewOutlineReady}
                    initialState={cachedWorkspaceBrowserState}
                    onPreviewPathChange={openWorkspaceBrowserFilePreview}
                    onPreviewOutlineReveal={revealMainPreviewMarkdownOutlineItem}
                    onQuoteSelection={activeAssistantController.quoteSelection}
                    onStartChatFromAnnotation={activeAssistantController.startChatFromAnnotation}
                    onStateChange={setWorkspaceBrowserState}
                  />
                ) : (
                  <ExternalPreviewPendingPane
                    path={externalPreviewPath ?? activeWorkbenchPreviewPath}
                    outline={activeMainPreviewOutline}
                    outlineReady={activeMainPreviewOutlineReady}
                    onOutlineReveal={revealMainPreviewMarkdownOutlineItem}
                  />
                )}
              </div>
              {activeWorkbenchPreviewTab ? (
                <div
                  className={styles.previewResizeHandle}
                  data-dragging={workbenchPreviewResize.dragging ? "true" : "false"}
                  data-testid="workbench-preview-resize-handle"
                  role="separator"
                  aria-label="调整工作台文件树宽度，双击恢复默认宽度"
                  aria-orientation="vertical"
                  tabIndex={0}
                  title="双击恢复默认宽度"
                  onDoubleClick={resetWorkbenchPreviewWidth}
                  onPointerDown={startWorkbenchPreviewResize}
                />
              ) : null}
              {activeWorkbenchPreviewTab ? (
                <WorkbenchMainPreviewTabs
                  activeTab={activeWorkbenchPreviewTab}
                  context={
                    activeWorkbenchPreviewTab.kind === "file"
                      ? activeWorkbenchPreviewTab.renderContext ?? workbenchPreviewRenderContext
                      : null
                  }
                  fallbackRuntime={runtime}
                  fallbackWorkspaceId={workspaceId}
                  selectedSessionId={selectedSessionId}
                  workspaceRootPath={selectedWorkspace?.root_path}
                  outlineRevealRequest={mainPreviewOutlineRevealRequest}
                  onCloseActive={closeActiveWorkbenchPreviewTab}
                  onCloseTab={closeWorkbenchPreviewTab}
                  onCreateBrowserTab={openWorkbenchBrowserTab}
                  onOpenHtmlBrowserPreview={(absolutePath) => {
                    openWorkbenchBrowserTab({
                      activate: true,
                      previewFilePath: absolutePath,
                    });
                  }}
                  onPersistedHtmlRevision={reloadAssociatedHtmlBrowserTab}
                  onMarkdownOutlineChange={handleMainPreviewMarkdownOutlineChange}
                  onViewportNearBottomChange={handleMainPreviewNearBottomChange}
                  onSelectTab={selectWorkbenchPreviewTab}
                  onUpdateBrowserTab={updateWorkbenchBrowserTab}
                  tabs={workbenchPreviewTabs.tabs}
                />
              ) : null}
            </div>
          </div>
          {workspaceId && selectedWorkspace ? (
            <WorkbenchAssistantSurface
              runtime={runtime}
              workspaceId={workspaceId}
              workspace={selectedWorkspace}
              controller={activeAssistantController}
              creatingSession={btwActive ? false : creatingSession}
              drawerInlineWidth={drawerInlineWidth}
              drawerWidth={drawerWidth}
              btwActive={btwActive}
              btwLoadedHistoryTurnCount={btwLoadedHistoryTurnCount}
              onOpenBtwConversation={openWorkbenchBtwConversation}
              onCloseBtwConversation={closeWorkbenchBtwConversation}
              onEnsureSession={!btwActive ? ensureWorkbenchSession : undefined}
              onRequestNewSession={!btwActive && onRequestNewSession ? requestNewWorkbenchSession : undefined}
              onDrawerWidthCommit={commitDrawerWidth}
              onDrawerWidthPreview={previewDrawerWidth}
              onDockTransitionChange={setDockTransitioning}
              onDockTransitionLayoutChange={updateDockTransitionLayout}
              onOpenMcpSettings={onOpenMcpSettings}
              contentNearBottom={mainPreviewNearBottom}
              contentViewportKey={assistantViewportKey}
            />
          ) : null}
        </main>
      )}
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function workbenchModeUiStateCacheForRuntime(runtime: RuntimeBridge): Map<string, WorkbenchModeUiState> {
  const current = workbenchModeUiStateCacheByRuntime.get(runtime);
  if (current) {
    return current;
  }
  const next = new Map<string, WorkbenchModeUiState>();
  workbenchModeUiStateCacheByRuntime.set(runtime, next);
  return next;
}

function cachedWorkbenchModeUiState(
  cache: Map<string, WorkbenchModeUiState>,
  scopeKey: string,
  legacyScopeKey?: string,
): WorkbenchModeUiState | null {
  const cached = cache.get(scopeKey);
  if (cached) return cached;
  const persisted = readPersistedWorkbenchModeUiState(scopeKey);
  if (persisted) {
    cache.set(scopeKey, persisted);
    return persisted;
  }
  if (!legacyScopeKey || legacyScopeKey === scopeKey) return null;
  const legacy = cache.get(legacyScopeKey) ?? readPersistedWorkbenchModeUiState(legacyScopeKey);
  if (!legacy) return null;
  cache.set(scopeKey, legacy);
  return legacy;
}

function readPersistedWorkbenchModeUiState(scopeKey: string): WorkbenchModeUiState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(workbenchUiStorageKey(scopeKey));
    if (!raw) return null;
    const envelope = JSON.parse(raw) as { scopeKey?: unknown; state?: unknown };
    if (envelope.scopeKey !== scopeKey) return null;
    return normalizePersistedWorkbenchModeUiState(envelope.state);
  } catch {
    return null;
  }
}

function persistWorkbenchModeUiState(scopeKey: string, state: WorkbenchModeUiState): void {
  if (typeof window === "undefined") return;
  const previewTabs = serializePersistableWorkbenchPreviewTabs(state.previewTabs);
  const persisted = {
    ...state,
    previewTabs,
    activeMainPreviewOutline: previewTabs.tabs.length ? state.activeMainPreviewOutline : [],
    activeMainPreviewOutlineReady: previewTabs.tabs.length ? state.activeMainPreviewOutlineReady : false,
  };
  try {
    const serialized = JSON.stringify({ scopeKey, state: persisted });
    if (serialized.length > 1_000_000) return;
    window.localStorage.setItem(workbenchUiStorageKey(scopeKey), serialized);
  } catch {
    // Storage can be unavailable or full; the in-memory cache remains authoritative for this run.
  }
}

export function serializePersistableWorkbenchPreviewTabs(
  state: WorkbenchPreviewTabsState,
): PersistedWorkbenchPreviewTabsState {
  const tabs = state.tabs.flatMap((tab): PersistedWorkbenchPreviewTabsState["tabs"] => {
    if (tab.kind === "file") {
      return tab.request.type === "file" || tab.request.type === "local-file"
        ? [{
            ...tab,
            kind: "file",
            renderContext: null,
            sourceEntryId: null,
          }]
        : [];
    }
    const browser = serializePersistableBrowserTab(tab);
    if (!browser) return [];
    return [{
      kind: "browser",
      browser,
      ...(tab.previewFilePath ? { previewFilePath: tab.previewFilePath } : {}),
      ...(tab.previewFileKey ? { previewFileKey: tab.previewFileKey } : {}),
    }];
  });
  const activeTabId = tabs.some((tab) =>
    (tab.kind === "browser" ? tab.browser.id : tab.id) === state.activeTabId)
    ? state.activeTabId
    : (() => {
        const last = tabs.at(-1);
        return last ? (last.kind === "browser" ? last.browser.id : last.id) : null;
      })();
  return { activeTabId, tabs };
}

export function normalizePersistedWorkbenchModeUiState(value: unknown): WorkbenchModeUiState | null {
  if (!isRecord(value)) return null;
  const previewBrowserWidth = value.previewBrowserWidth;
  const rawPreviewTabs = value.previewTabs;
  if (typeof previewBrowserWidth !== "number" || !Number.isFinite(previewBrowserWidth)) return null;
  if (!isRecord(rawPreviewTabs) || !Array.isArray(rawPreviewTabs.tabs)) return null;
  const tabs = rawPreviewTabs.tabs.flatMap((raw): WorkbenchMainTabState[] => {
    const fileTab = normalizePersistedWorkbenchFileTab(raw);
    if (fileTab) return [fileTab];
    const browserTab = normalizePersistedWorkbenchBrowserTab(raw);
    return browserTab ? [browserTab] : [];
  });
  const requestedActive = typeof rawPreviewTabs.activeTabId === "string"
    ? rawPreviewTabs.activeTabId
    : null;
  const previewTabs = sanitizeWorkbenchPreviewTabs({
    activeTabId: tabs.some((tab) => tab.id === requestedActive)
      ? requestedActive
      : tabs.at(-1)?.id ?? null,
    tabs,
  });
  return {
    previewBrowserWidth,
    previewTabs,
    activeMainPreviewOutline: previewTabs.tabs.length > 0 && Array.isArray(value.activeMainPreviewOutline)
      ? value.activeMainPreviewOutline as MarkdownOutlineItem[]
      : [],
    activeMainPreviewOutlineReady: previewTabs.tabs.length > 0
      && value.activeMainPreviewOutlineReady === true,
    workspaceBrowserState: isRecord(value.workspaceBrowserState)
      ? value.workspaceBrowserState as unknown as WorkspaceFileBrowserState
      : null,
  };
}

function normalizePersistedWorkbenchFileTab(raw: unknown): WorkbenchMainFileTabState | null {
  if (!isRecord(raw) || (raw.kind !== undefined && raw.kind !== "file")) return null;
  const request = raw.request;
  if (!isRecord(request)
    || (request.type !== "file" && request.type !== "local-file")
    || typeof request.path !== "string"
    || !request.path.trim()
    || typeof raw.id !== "string"
    || !raw.id
    || typeof raw.requestId !== "number"
    || !Number.isFinite(raw.requestId)
    || typeof raw.refreshRequestId !== "number"
    || !Number.isFinite(raw.refreshRequestId)
    || typeof raw.title !== "string"
    || typeof raw.sourceLabel !== "string"
    || !isRecord(raw.markdownView)) return null;
  return {
    ...(raw as unknown as WorkbenchMainFileTabState),
    kind: "file",
    renderContext: null,
    sourceEntryId: null,
  };
}

function normalizePersistedWorkbenchBrowserTab(raw: unknown): WorkbenchBrowserTabState | null {
  if (!isRecord(raw) || raw.kind !== "browser" || !isRecord(raw.browser)) return null;
  const allowedKeys = new Set(["kind", "browser", "previewFilePath", "previewFileKey"]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;
  const browser = normalizePersistedBrowserTab(raw.browser);
  if (!browser) return null;
  if (raw.previewFilePath === undefined && raw.previewFileKey === undefined) {
    return { ...browser, kind: "browser" };
  }
  if (typeof raw.previewFilePath !== "string" || typeof raw.previewFileKey !== "string") return null;
  try {
    const previewFile = canonicalizeBrowserFileAddress(raw.previewFilePath);
    if (previewFile.canonicalKey !== raw.previewFileKey) return null;
    return {
      ...browser,
      kind: "browser",
      previewFilePath: previewFile.windowsPath,
      previewFileKey: previewFile.canonicalKey,
    };
  } catch {
    return null;
  }
}

function workbenchUiStorageKey(scopeKey: string): string {
  return `${WORKBENCH_UI_STORAGE_PREFIX}:${hashText(scopeKey)}`;
}

export function workbenchModeUiScopeKey({
  workspaceId,
  externalPreviewPath,
}: {
  workspaceId?: string;
  externalPreviewPath?: string;
}) {
  if (workspaceId) {
    return `workspace:${workspaceId}`;
  }
  if (externalPreviewPath) {
    return `external:${hashText(externalPreviewPath)}`;
  }
  return "picker";
}

function legacySessionScopedWorkbenchModeUiScopeKey({
  workspaceId,
  selectedSessionId,
  externalPreviewPath,
}: {
  workspaceId?: string;
  selectedSessionId?: string;
  externalPreviewPath?: string;
}) {
  return workspaceId
    ? `workspace:${workspaceId}:session:${selectedSessionId ?? ""}`
    : workbenchModeUiScopeKey({ externalPreviewPath });
}

function sanitizeWorkbenchPreviewTabs(state: WorkbenchPreviewTabsState): WorkbenchPreviewTabsState {
  if (!state.tabs.length) {
    return EMPTY_WORKBENCH_PREVIEW_TABS;
  }
  return {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((tab) => tab.kind === "file"
      ? {
          ...tab,
          renderContext: null,
          sourceEntryId: null,
        }
      : {
          id: tab.id,
          kind: "browser",
          title: tab.title,
          ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
          restoreUrl: tab.restoreUrl,
          restoreUrlSanitized: tab.restoreUrlSanitized,
          profileMode: tab.profileMode,
          zoomFactor: tab.zoomFactor,
          createdAt: tab.createdAt,
          lastActivatedAt: tab.lastActivatedAt,
          ...(tab.previewFilePath ? { previewFilePath: tab.previewFilePath } : {}),
          ...(tab.previewFileKey ? { previewFileKey: tab.previewFileKey } : {}),
        }),
  };
}

function maxWorkbenchPreviewRequestId(state?: WorkbenchPreviewTabsState | null): number {
  return state?.tabs.reduce(
    (maxRequestId, tab) => tab.kind === "file"
      ? Math.max(maxRequestId, tab.requestId)
      : maxRequestId,
    0,
  ) ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function workbenchBrowserInteractiveResizeInput(
  startWidth: number,
  startScreenX: number,
  rootWidth: number,
) {
  const maxWidth = rootWidth > 0
    ? Math.max(MIN_WORKBENCH_BROWSER_WIDTH, rootWidth - MIN_WORKBENCH_MAIN_PREVIEW_WIDTH)
    : startWidth;
  return {
    placement: "left" as const,
    startScreenX,
    minDelta: MIN_WORKBENCH_BROWSER_WIDTH - startWidth,
    maxDelta: maxWidth - startWidth,
  };
}

function workbenchPreviewTabMenuPosition(clientX: number, clientY: number): CSSProperties {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return {
    left: Math.max(
      WORKBENCH_PREVIEW_TAB_MENU_EDGE,
      Math.min(clientX, viewportWidth - WORKBENCH_PREVIEW_TAB_MENU_WIDTH - WORKBENCH_PREVIEW_TAB_MENU_EDGE),
    ),
    top: Math.max(
      WORKBENCH_PREVIEW_TAB_MENU_EDGE,
      Math.min(clientY, viewportHeight - WORKBENCH_PREVIEW_TAB_MENU_HEIGHT - WORKBENCH_PREVIEW_TAB_MENU_EDGE),
    ),
  };
}

function scrollWorkbenchPreviewTabStripTo(strip: HTMLElement, left: number, behavior: ScrollBehavior) {
  const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const nextScrollLeft = clampNumber(left, 0, maxScrollLeft);
  if (Math.abs(nextScrollLeft - strip.scrollLeft) < 1) {
    return;
  }
  if (typeof strip.scrollTo === "function") {
    strip.scrollTo({ left: nextScrollLeft, behavior });
  } else {
    strip.scrollLeft = nextScrollLeft;
  }
}

function scrollWorkbenchPreviewTabStripBy(strip: HTMLElement, delta: number, behavior: ScrollBehavior = "smooth") {
  scrollWorkbenchPreviewTabStripTo(strip, strip.scrollLeft + delta, behavior);
}

function scrollWorkbenchPreviewTabIntoView(
  strip: HTMLElement,
  tab: HTMLElement,
  behavior: ScrollBehavior = "auto",
) {
  if (strip.scrollWidth <= strip.clientWidth) {
    return;
  }
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const leftOverflow = tabRect.left - stripRect.left;
  const rightOverflow = tabRect.right - stripRect.right;

  if (leftOverflow < 0) {
    scrollWorkbenchPreviewTabStripTo(
      strip,
      strip.scrollLeft + leftOverflow - WORKBENCH_PREVIEW_TAB_SCROLL_PADDING,
      behavior,
    );
    return;
  }

  if (rightOverflow > 0) {
    scrollWorkbenchPreviewTabStripTo(
      strip,
      strip.scrollLeft + rightOverflow + WORKBENCH_PREVIEW_TAB_SCROLL_PADDING,
      behavior,
    );
  }
}

function workbenchPreviewTabScrollState(strip: HTMLElement): WorkbenchPreviewTabScrollState {
  const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
  return {
    hasOverflow: maxScrollLeft > 1,
    canScrollLeft: strip.scrollLeft > 1,
    canScrollRight: strip.scrollLeft < maxScrollLeft - 1,
  };
}

export function WorkbenchMainPreviewTabs({
  activeTab,
  context,
  fallbackRuntime,
  fallbackWorkspaceId,
  selectedSessionId,
  workspaceRootPath,
  outlineRevealRequest,
  onCloseActive,
  onCloseTab,
  onCreateBrowserTab,
  onOpenHtmlBrowserPreview,
  onPersistedHtmlRevision,
  onMarkdownOutlineChange,
  onViewportNearBottomChange,
  onSelectTab,
  onUpdateBrowserTab,
  tabs,
}: {
  activeTab: WorkbenchMainTabState;
  context: PreviewRenderContext | null;
  fallbackRuntime: RuntimeBridge;
  fallbackWorkspaceId?: string;
  selectedSessionId?: string;
  workspaceRootPath?: string;
  outlineRevealRequest?: MarkdownOutlineRevealRequest | null;
  onCloseActive: () => void;
  onCloseTab: (tabId: string) => void;
  onCreateBrowserTab: (options?: BrowserTabCreateOptions) => void;
  onOpenHtmlBrowserPreview?: (absolutePath: string) => void;
  onPersistedHtmlRevision?: (absolutePath: string) => void;
  onMarkdownOutlineChange?: (outline: MarkdownOutlineItem[]) => void;
  onViewportNearBottomChange?: (nearBottom: boolean | null) => void;
  onSelectTab: (tabId: string) => void;
  onUpdateBrowserTab: (tab: WorkbenchBrowserTabState) => void;
  tabs: WorkbenchMainTabState[];
}) {
  const tabMenuRef = useRef<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const previewTabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [tabMenu, setTabMenu] = useState<WorkbenchPreviewTabMenuState | null>(null);
  const [tabScrollState, setTabScrollState] = useState<WorkbenchPreviewTabScrollState>(
    EMPTY_WORKBENCH_PREVIEW_TAB_SCROLL_STATE,
  );
  useBrowserOcclusionToken(Boolean(tabMenu), "menu");
  const closeTabMenu = useCallback(() => {
    setTabMenu(null);
  }, []);
  const setPreviewTabElement = useCallback((tabId: string, element: HTMLDivElement | null) => {
    if (element) {
      previewTabElementsRef.current.set(tabId, element);
    } else {
      previewTabElementsRef.current.delete(tabId);
    }
  }, []);
  const openTabMenu = useCallback((event: MouseEvent<HTMLElement>, tabId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setTabMenu({
      tabId,
      position: workbenchPreviewTabMenuPosition(event.clientX, event.clientY),
    });
  }, []);
  const tabMenuTargets = useMemo(() => {
    const tabId = tabMenu?.tabId ?? null;
    const tabIds = tabs.map((tab) => tab.id);
    const tabIndex = tabId ? tabIds.indexOf(tabId) : -1;
    if (tabIndex < 0) {
      return {
        left: [],
        right: [],
        other: [],
        all: tabIds,
      };
    }
    return {
      left: tabIds.slice(0, tabIndex),
      right: tabIds.slice(tabIndex + 1),
      other: tabIds.filter((item) => item !== tabId),
      all: tabIds,
    };
  }, [tabMenu?.tabId, tabs]);
  const updateTabScrollState = useCallback(() => {
    const strip = tabStripRef.current;
    const nextState = strip ? workbenchPreviewTabScrollState(strip) : EMPTY_WORKBENCH_PREVIEW_TAB_SCROLL_STATE;
    setTabScrollState((current) =>
      current.hasOverflow === nextState.hasOverflow &&
      current.canScrollLeft === nextState.canScrollLeft &&
      current.canScrollRight === nextState.canScrollRight
        ? current
        : nextState,
    );
  }, []);
  const closeTabMenuTargets = useCallback(
    (tabIds: string[]) => {
      closeTabMenu();
      tabIds.forEach((tabId) => onCloseTab(tabId));
    },
    [closeTabMenu, onCloseTab],
  );
  const scrollPreviewTabs = useCallback((direction: "left" | "right") => {
    const strip = tabStripRef.current;
    if (!strip) {
      return;
    }
    const scrollDistance = Math.max(120, strip.clientWidth * 0.75);
    scrollWorkbenchPreviewTabStripBy(strip, direction === "left" ? -scrollDistance : scrollDistance);
    updateTabScrollState();
  }, [updateTabScrollState]);

  useEffect(() => {
    const strip = tabStripRef.current;
    const activeTabElement = previewTabElementsRef.current.get(activeTab.id);
    if (strip && activeTabElement) {
      scrollWorkbenchPreviewTabIntoView(strip, activeTabElement);
    }
    updateTabScrollState();
  }, [activeTab.id, tabs.length, updateTabScrollState]);

  useEffect(() => {
    const strip = tabStripRef.current;
    updateTabScrollState();
    window.addEventListener("resize", updateTabScrollState);

    if (typeof ResizeObserver === "undefined" || !strip) {
      return () => window.removeEventListener("resize", updateTabScrollState);
    }

    const resizeObserver = new ResizeObserver(updateTabScrollState);
    resizeObserver.observe(strip);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateTabScrollState);
    };
  }, [tabs.length, updateTabScrollState]);

  useEffect(() => {
    if (!tabMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && tabMenuRef.current?.contains(target)) {
        return;
      }
      closeTabMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closeTabMenu, tabMenu]);

  useEffect(() => {
    if (!tabMenu) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeTabMenu();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeTabMenu, tabMenu]);

  useEffect(() => {
    if (!tabMenu) {
      return;
    }
    window.addEventListener("resize", closeTabMenu);
    window.addEventListener("scroll", closeTabMenu, true);
    return () => {
      window.removeEventListener("resize", closeTabMenu);
      window.removeEventListener("scroll", closeTabMenu, true);
    };
  }, [closeTabMenu, tabMenu]);

  useEffect(() => {
    if (tabMenu && !tabs.some((tab) => tab.id === tabMenu.tabId)) {
      closeTabMenu();
    }
  }, [closeTabMenu, tabMenu, tabs]);

  return (
    <section
      className={styles.mainPreview}
      data-active-tab-kind={activeTab.kind}
      data-open-tab-count={tabs.length}
      data-testid={activeTab.kind === "file"
        ? "workbench-main-file-preview"
        : "workbench-main-browser-preview"}
    >
      <div
        className={styles.previewTabRail}
        data-overflow={tabScrollState.hasOverflow ? "true" : "false"}
        data-testid="workbench-preview-tab-rail"
      >
        {tabScrollState.hasOverflow ? (
          <button
            className={`${styles.previewTabScrollButton} ${styles.previewTabScrollButtonLeft}`}
            type="button"
            aria-label="向左移动预览tab"
            title="向左移动预览tab"
            data-testid="workbench-preview-tab-scroll-left"
            disabled={!tabScrollState.canScrollLeft}
            onClick={() => scrollPreviewTabs("left")}
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
        ) : null}
        <div
          className={styles.previewTabStrip}
          data-testid="workbench-preview-tab-strip"
          ref={tabStripRef}
          role="tablist"
          aria-label="工作台预览"
          onScroll={updateTabScrollState}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab.id;
            return (
              <div
                className={styles.previewTab}
                data-active={active ? "true" : "false"}
                data-app-context-menu="local"
                data-menu-open={tabMenu?.tabId === tab.id ? "true" : undefined}
                data-preview-tab="true"
                key={tab.id}
                ref={(element) => setPreviewTabElement(tab.id, element)}
                onContextMenu={(event) => openTabMenu(event, tab.id)}
              >
                <button
                  className={styles.previewTabMain}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-profile-mode={tab.kind === "browser" ? tab.profileMode : undefined}
                  data-tab-kind={tab.kind}
                  data-navigation-command-kind={
                    tab.kind === "browser" ? tab.navigationCommand?.kind : undefined
                  }
                  data-navigation-command-source={
                    tab.kind === "browser" ? tab.navigationCommand?.source : undefined
                  }
                  title={workbenchMainTabSourceLabel(tab)}
                  onClick={() => onSelectTab(tab.id)}
                >
                  {tab.kind === "browser" ? (
                    <span className={styles.previewTabIcon} data-testid={`workbench-browser-tab-icon-${tab.id}`}>
                      {tab.previewFilePath || tab.restoreUrl.toLowerCase().startsWith("file:") ? (
                        <FileCode2 aria-hidden size={13} strokeWidth={1.8} />
                      ) : tab.faviconUrl ? (
                        <img alt="" aria-hidden src={tab.faviconUrl} />
                      ) : (
                        <Globe2 aria-hidden size={13} strokeWidth={1.8} />
                      )}
                    </span>
                  ) : null}
                  <span className={styles.previewTabTitle}>{tab.title}</span>
                  {tab.kind === "browser" && tab.profileMode === "incognito" ? (
                    <span className={styles.previewTabProfileBadge}>无痕</span>
                  ) : null}
                </button>
                <button
                  className={styles.previewTabClose}
                  type="button"
                  aria-label={`关闭预览 ${tab.title}`}
                  title={`关闭预览 ${tab.title}`}
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
        {tabScrollState.hasOverflow ? (
          <button
            className={`${styles.previewTabScrollButton} ${styles.previewTabScrollButtonRight}`}
            type="button"
            aria-label="向右移动预览tab"
            title="向右移动预览tab"
            data-testid="workbench-preview-tab-scroll-right"
            disabled={!tabScrollState.canScrollRight}
            onClick={() => scrollPreviewTabs("right")}
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        ) : null}
        <TerminalDockAction
          badgeClassName={styles.previewTabTerminalBadge}
          className={styles.previewTabTerminalAction}
        />
      </div>
      {tabMenu ? (
        <div
          aria-label="工作台文件预览tab菜单"
          className={styles.previewTabMenu}
          data-app-context-menu="local"
          ref={tabMenuRef}
          role="menu"
          style={tabMenu.position}
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
            disabled={tabMenuTargets.left.length === 0}
            onClick={() => closeTabMenuTargets(tabMenuTargets.left)}
          >
            <PanelLeftClose size={14} />
            <span>关闭左侧tab</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={tabMenuTargets.right.length === 0}
            onClick={() => closeTabMenuTargets(tabMenuTargets.right)}
          >
            <PanelRightClose size={14} />
            <span>关闭右侧tab</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={tabMenuTargets.other.length === 0}
            onClick={() => closeTabMenuTargets(tabMenuTargets.other)}
          >
            <X size={14} />
            <span>关闭其他tab</span>
          </button>
          <button type="button" role="menuitem" onClick={() => closeTabMenuTargets(tabMenuTargets.all)}>
            <X size={14} />
            <span>关闭所有tab</span>
          </button>
        </div>
      ) : null}
      {activeTab.kind === "file" ? (
        <WorkbenchMainFilePreview
          context={context}
          fallbackRuntime={fallbackRuntime}
          fallbackWorkspaceId={fallbackWorkspaceId}
          workspaceRootPath={workspaceRootPath}
          outlineRevealRequest={outlineRevealRequest}
          request={activeTab.request}
          requestId={activeTab.requestId}
          refreshRequestId={activeTab.refreshRequestId ?? 0}
          markdownView={activeTab.markdownView}
          revealTarget={activeTab.revealTarget}
          title={activeTab.title}
          onClose={onCloseActive}
          onOpenHtmlBrowserPreview={onOpenHtmlBrowserPreview}
          onPersistedHtmlRevision={onPersistedHtmlRevision}
          onMarkdownOutlineChange={onMarkdownOutlineChange}
          onViewportNearBottomChange={onViewportNearBottomChange}
        />
      ) : fallbackWorkspaceId ? (
        <WorkbenchMainBrowserTab
          active
          selectedSessionId={selectedSessionId}
          state={activeTab}
          workspaceId={fallbackWorkspaceId}
          onActivate={onSelectTab}
          onClose={onCloseTab}
          onCreate={onCreateBrowserTab}
          onUpdate={onUpdateBrowserTab}
        />
      ) : null}
    </section>
  );
}

function WorkbenchMainBrowserTab({
  active,
  selectedSessionId,
  state,
  workspaceId,
  onActivate,
  onClose,
  onCreate,
  onUpdate,
}: {
  active: boolean;
  selectedSessionId?: string;
  state: WorkbenchBrowserTabState;
  workspaceId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: (options?: BrowserTabCreateOptions) => void;
  onUpdate: (state: WorkbenchBrowserTabState) => void;
}) {
  const host = useMemo(
    () => createWorkbenchBrowserAdapter({
      workspaceId,
      selectedSessionId,
      active,
      state,
      updateState: onUpdate,
      createTab: onCreate,
      activateTab: onActivate,
      closeTab: onClose,
    }),
    [
      active,
      onActivate,
      onClose,
      onCreate,
      onUpdate,
      selectedSessionId,
      state,
      workspaceId,
    ],
  );
  return (
    <div
      className={styles.mainPreviewBody}
      data-browser-adapter="workbench"
      data-testid="workbench-browser-tab-content"
    >
      <BrowserTabSurface host={host} />
    </div>
  );
}

function workbenchMainTabSourceLabel(tab: WorkbenchMainTabState): string {
  if (tab.kind === "file") return tab.sourceLabel;
  return tab.previewFilePath || tab.restoreUrl || tab.title;
}

function WorkbenchMainFilePreview({
  context,
  fallbackRuntime,
  fallbackWorkspaceId,
  workspaceRootPath,
  outlineRevealRequest,
  request,
  requestId,
  refreshRequestId,
  markdownView,
  revealTarget,
  title,
  onClose,
  onMarkdownOutlineChange,
  onViewportNearBottomChange,
  onOpenHtmlBrowserPreview,
  onPersistedHtmlRevision,
}: {
  context: PreviewRenderContext | null;
  fallbackRuntime: RuntimeBridge;
  fallbackWorkspaceId?: string;
  workspaceRootPath?: string;
  outlineRevealRequest?: MarkdownOutlineRevealRequest | null;
  request: PreviewRequest;
  requestId: number;
  refreshRequestId: number;
  markdownView: PreviewMarkdownViewDescriptor;
  revealTarget: PreviewFileRevealTarget | null;
  title: string;
  onClose: () => void;
  onMarkdownOutlineChange?: (outline: MarkdownOutlineItem[]) => void;
  onViewportNearBottomChange?: (nearBottom: boolean | null) => void;
  onOpenHtmlBrowserPreview?: (absolutePath: string) => void;
  onPersistedHtmlRevision?: (absolutePath: string) => void;
}) {
  const sourceRevealRequest = useMemo<FilePreviewRevealRequest | null>(() => {
    if (!revealTarget) {
      return null;
    }
    return {
      annotationId: revealTarget.annotationId ?? null,
      requestId,
      selectedText: revealTarget.selectedText ?? null,
      lineStart: revealTarget.lineStart ?? null,
      lineEnd: revealTarget.lineEnd ?? null,
      sourceStart: revealTarget.sourceStart ?? null,
      sourceEnd: revealTarget.sourceEnd ?? null,
    };
  }, [
    requestId,
    revealTarget?.annotationId,
    revealTarget?.lineEnd,
    revealTarget?.lineStart,
    revealTarget?.selectedText,
    revealTarget?.sourceEnd,
    revealTarget?.sourceStart,
  ]);
  const workspaceAnnotationPath = useMemo(
    () => request.type === "local-file" && workspaceRootPath
      ? workspaceRelativeFilePath(request.path, workspaceRootPath)
      : undefined,
    [request, workspaceRootPath],
  );

  return (
    <div className={styles.mainPreviewBody} role="tabpanel" aria-label={title}>
      <FilePreview
        breadcrumbRootLabel={context?.workspaceLabel}
        workspaceId={context?.workspaceId ?? fallbackWorkspaceId}
        workspaceRootPath={workspaceRootPath ?? context?.workspaceRootPath}
        sessionId={context?.sessionId}
        workspaceAnnotationPath={workspaceAnnotationPath}
        request={request}
        refreshRequestId={refreshRequestId}
        runtime={context?.runtime ?? fallbackRuntime}
        outlineRevealRequest={outlineRevealRequest}
        sourceRevealRequest={sourceRevealRequest}
        markdownViewDescriptor={markdownView}
        onMarkdownOutlineChange={onMarkdownOutlineChange}
        onViewportNearBottomChange={onViewportNearBottomChange}
        onOpenHtmlBrowserPreview={onOpenHtmlBrowserPreview}
        onPersistedHtmlRevision={onPersistedHtmlRevision}
        onQuoteSelection={context?.onQuoteSelection}
        onStartChatFromAnnotation={context?.onStartChatFromAnnotation}
        onClose={onClose}
        chrome="panel"
      />
    </div>
  );
}

function WorkbenchAssistantPlaceholder({ disabled = false, label }: { disabled?: boolean; label: string }) {
  return (
    <div
      className={styles.assistantCapsule}
      data-testid="workbench-assistant-capsule"
      data-disabled={disabled ? "true" : "false"}
      aria-disabled={disabled}
    >
      <span>{label}</span>
    </div>
  );
}

function ExternalPreviewPendingPane({
  path,
  outline,
  outlineReady,
  onOutlineReveal,
}: {
  path?: string | null;
  outline: MarkdownOutlineItem[];
  outlineReady: boolean;
  onOutlineReveal: (item: MarkdownOutlineItem) => void;
}) {
  const displayPath = path?.trim() ?? "";
  const displayName = displayPath ? fileName(displayPath) : "Local file";
  const showOutline = outlineReady && outline.length > 0;

  return (
    <aside className={styles.externalPreviewPendingPane} data-testid="workbench-external-preview-pending-pane">
      <header className={styles.externalPreviewPendingHeader} aria-label={displayPath || displayName}>
        <span className={styles.externalPreviewPendingLabel}>Local file</span>
        <span className={styles.externalPreviewPendingPath}>{displayName}</span>
      </header>
      {showOutline ? (
        <nav className={styles.externalPreviewOutline} aria-label="Outline">
          {outline.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.externalPreviewOutlineItem}
              style={{ paddingLeft: `${Math.min(Math.max(item.level - 1, 0), 5) * 10}px` }}
              onClick={() => onOutlineReveal(item)}
            >
              <span>{item.title}</span>
            </button>
          ))}
        </nav>
      ) : null}
    </aside>
  );
}

function previewRequestFromPath(path: string): PreviewRequest {
  return isAbsoluteFilePath(path) ? { type: "local-file", path } : { type: "file", path };
}

export function workbenchMarkdownViewDescriptor(
  request: PreviewRequest,
  context: PreviewRenderContext | null,
  tabId: string,
  source: PreviewMarkdownViewDescriptor | null | undefined,
): PreviewMarkdownViewDescriptor {
  if (source) {
    return Object.freeze({
      ...source,
      viewId: "workbench-main-preview",
      kind: "workbench",
    });
  }
  const scopeId = context?.panelScopeKey
    ?? (context?.workspaceId ? `workspace:${context.workspaceId}` : context?.sessionId ? `session:${context.sessionId}` : "workbench:global");
  return Object.freeze({
    scopeId,
    entryId: `workbench:${tabId}`,
    viewId: "workbench-main-preview",
    kind: "workbench",
  });
}

function workbenchPreviewTabId(request: PreviewRequest): string {
  if (request.type === "file" || request.type === "local-file") {
    return `file:${request.path}`;
  }
  if (request.type === "diff") {
    return `diff:${request.path}:${hashText(request.diff)}`;
  }
  if (request.type === "diff-document") {
    return `diff-document:${request.document.id}:${request.document.sourceVersion}`;
  }
  if (request.type === "skill-resource") {
    return `skill-resource:${request.skillSource}:${request.skillName}:${request.resourcePath}`;
  }
  return `content:${request.contentType}:${request.title}:${hashText(request.content)}`;
}

function previewTitle(request: PreviewRequest): string {
  if (request.type === "content" || request.type === "skill-resource" || request.type === "diff-document") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: PreviewRequest): string {
  if (request.type === "skill-resource") {
    return `Skill · ${request.skillName}/${request.resourcePath}`;
  }
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
  }
  if (request.type === "diff-document") {
    return request.sourceLabel ?? request.sourcePath ?? "差异内容";
  }
  return request.path;
}

function targetPathForPreviewRequest(request: PreviewRequest): string | null {
  if ("path" in request) {
    return request.path;
  }
  return request.type === "content" || request.type === "diff-document" ? request.sourcePath ?? null : null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function previewEntryStamp(entry: { id: string; openedAt: number }): string {
  return `${entry.id}:${entry.openedAt}`;
}

function workbenchPreviewPanelScopeKey(workspaceId: string): string {
  return `workbench:${workspaceId}`;
}

function workbenchExternalPreviewPanelScopeKey(path: string): string {
  return `workbench:external:${hashText(path)}`;
}
