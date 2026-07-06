import { PanelLeftClose, PanelRightClose, X } from "lucide-react";
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
import { useRafPanelResize } from "@/renderer/components/layout/useRafPanelResize";
import {
  FilePreview,
  WorkspaceFileBrowser,
  WorkspaceSelector,
  type FilePreviewRevealRequest,
  type WorkspaceSelection,
} from "@/renderer/components/workspace";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
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
import type { PreviewRequest } from "@/renderer/providers/previewTypes";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { isAbsoluteFilePath } from "@/renderer/utils/fileLinks";
import type { AgentSession, Workspace } from "@/types/protocol";

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
}

interface WorkbenchMainPreviewTabState {
  id: string;
  request: PreviewRequest;
  requestId: number;
  revealTarget: PreviewFileRevealTarget | null;
  renderContext: PreviewRenderContext | null;
  sourceEntryId: string | null;
  sourceLabel: string;
  title: string;
}

interface WorkbenchPreviewTabsState {
  activeTabId: string | null;
  tabs: WorkbenchMainPreviewTabState[];
}

interface WorkbenchPreviewTabMenuState {
  tabId: string;
  position: CSSProperties;
}

const DEFAULT_WORKBENCH_BROWSER_WIDTH = 300;
const MIN_WORKBENCH_BROWSER_WIDTH = 220;
const MIN_WORKBENCH_MAIN_PREVIEW_WIDTH = 320;
const WORKBENCH_PREVIEW_TAB_MENU_WIDTH = 148;
const WORKBENCH_PREVIEW_TAB_MENU_HEIGHT = 136;
const WORKBENCH_PREVIEW_TAB_MENU_EDGE = 8;
const EMPTY_WORKBENCH_PREVIEW_TABS: WorkbenchPreviewTabsState = {
  activeTabId: null,
  tabs: [],
};

export function WorkbenchModePage({
  runtime,
  workspaceId,
  selectedSessionId,
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
}: WorkbenchModePageProps) {
  const notifications = useNotifications();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const previewContext = useOptionalPreview();
  const layout = useLayoutState();
  const workspaceShellRef = useRef<HTMLElement | null>(null);
  const canvasContentRef = useRef<HTMLDivElement | null>(null);
  const previewBrowserRootWidthRef = useRef(0);
  const handledFilePanelRequestIdRef = useRef(previewContext?.filePanelRequest?.requestId ?? 0);
  const handledPreviewEntryStampRef = useRef(previewContext?.activeEntry ? previewEntryStamp(previewContext.activeEntry) : "");
  const mainPreviewRequestSeqRef = useRef(0);
  const [creatingSession, setCreatingSession] = useState(false);
  const [btwSession, setBtwSession] = useState<AgentSession | null>(null);
  const [btwLoadedHistoryTurnCount, setBtwLoadedHistoryTurnCount] = useState<number | null>(null);
  const [dockTransitioning, setDockTransitioning] = useState(false);
  const [dockTransitionLayout, setDockTransitionLayout] = useState<WorkbenchAssistantDockTransitionState>({
    phase: "idle",
    reservedWidth: 0,
  });
  const [previewBrowserWidth, setPreviewBrowserWidth] = useState(DEFAULT_WORKBENCH_BROWSER_WIDTH);
  const [workbenchPreviewTabs, setWorkbenchPreviewTabs] =
    useState<WorkbenchPreviewTabsState>(EMPTY_WORKBENCH_PREVIEW_TABS);
  const activeWorkbenchPreviewTab = useMemo(
    () => workbenchPreviewTabs.tabs.find((tab) => tab.id === workbenchPreviewTabs.activeTabId) ?? null,
    [workbenchPreviewTabs.activeTabId, workbenchPreviewTabs.tabs],
  );
  const activeWorkbenchPreviewPath = activeWorkbenchPreviewTab
    ? targetPathForPreviewRequest(activeWorkbenchPreviewTab.request)
    : null;
  const selectorValue: WorkspaceSelection = selectedWorkspace
    ? { type: "workspace", workspace: selectedWorkspace }
    : { type: "chat" };
  const workspaceLabel = selectedWorkspace?.root_path ?? selectedWorkspace?.name ?? workspaceId;
  const showPicker = !workspaceId;
  const showWorkspaceLoading = Boolean(workspaceId && workspaceLoading && !selectedWorkspace);
  const showWorkspaceUnavailable = Boolean(workspaceId && workspaceError && !selectedWorkspace);
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
  const workbenchPreviewResize = useRafPanelResize({
    disabled: !activeWorkbenchPreviewTab,
    width: previewBrowserWidth,
    getWidth: getWorkbenchPreviewBrowserDragWidth,
    onPreview: previewWorkbenchPreviewBrowserWidth,
    onCommit: commitWorkbenchPreviewBrowserWidth,
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
  const assistantController = useAgentSessionController({
    runtime,
    sessionId: selectedSessionId ?? "",
    enabled: backendReady,
    ensureSession: ensureWorkbenchSession,
  });
  const btwController = useAgentSessionController({
    runtime,
    sessionId: btwSession?.id ?? "",
    enabled: backendReady,
    historyPageSize: 2,
    loadFullHistory: false,
    syncThreadTasks: false,
  });
  const btwActive = Boolean(btwSession?.id);
  const activeAssistantController = btwActive ? btwController : assistantController;
  const workbenchPreviewRenderContext = useMemo<PreviewRenderContext | null>(() => {
    if (!workspaceId) {
      return null;
    }
    return {
      panelScopeKey: workbenchPreviewPanelScopeKey(workspaceId),
      workspaceId,
      workspaceAvailable: true,
      workspaceLabel,
      runtime,
      onQuoteSelection: activeAssistantController.quoteSelection,
      onStartChatFromAnnotation: activeAssistantController.startChatFromAnnotation,
    };
  }, [
    activeAssistantController.quoteSelection,
    activeAssistantController.startChatFromAnnotation,
    runtime,
    workspaceId,
    workspaceLabel,
  ]);
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
    ) => {
      const tab: WorkbenchMainPreviewTabState = {
        id: workbenchPreviewTabId(request),
        request,
        requestId: requestId ?? nextMainPreviewRequestId(),
        revealTarget,
        renderContext,
        sourceEntryId,
        sourceLabel: previewSourceLabel(request),
        title: previewTitle(request),
      };
      setWorkbenchPreviewTabs((current) => {
        const existingIndex = current.tabs.findIndex((item) => item.id === tab.id);
        const tabs =
          existingIndex === -1
            ? [...current.tabs, tab]
            : current.tabs.map((item) => (item.id === tab.id ? tab : item));
        return {
          activeTabId: tab.id,
          tabs,
        };
      });
    },
    [nextMainPreviewRequestId],
  );
  const openWorkspaceBrowserFilePreview = useCallback(
    (path: string | null) => {
      if (!path) {
        setWorkbenchPreviewTabs(EMPTY_WORKBENCH_PREVIEW_TABS);
        return;
      }
      openWorkbenchMainPreview({ type: "file", path }, workbenchPreviewRenderContext);
    },
    [openWorkbenchMainPreview, workbenchPreviewRenderContext],
  );
  const selectWorkbenchPreviewTab = useCallback(
    (tabId: string) => {
      const tab = workbenchPreviewTabs.tabs.find((item) => item.id === tabId);
      if (!tab) {
        return;
      }
      setWorkbenchPreviewTabs((current) =>
        current.activeTabId === tabId
          ? current
          : {
              ...current,
              activeTabId: tabId,
            },
      );
      if (tab.sourceEntryId) {
        previewContext?.switchPreview(tab.sourceEntryId);
      }
    },
    [previewContext, workbenchPreviewTabs.tabs],
  );
  const closeWorkbenchPreviewTab = useCallback(
    (tabId: string) => {
      const tab = workbenchPreviewTabs.tabs.find((item) => item.id === tabId) ?? null;
      setWorkbenchPreviewTabs((current) => {
        const closingIndex = current.tabs.findIndex((item) => item.id === tabId);
        if (closingIndex === -1) {
          return current;
        }
        const tabs = current.tabs.filter((item) => item.id !== tabId);
        if (tabs.length === 0) {
          return EMPTY_WORKBENCH_PREVIEW_TABS;
        }
        const activeTabId =
          current.activeTabId === tabId
            ? (tabs[Math.max(0, Math.min(closingIndex - 1, tabs.length - 1))]?.id ?? null)
            : current.activeTabId;
        return {
          activeTabId,
          tabs,
        };
      });
      if (tab?.sourceEntryId) {
        previewContext?.closePreviewEntry(tab.sourceEntryId);
      }
      if (workbenchPreviewRenderContext) {
        previewContext?.setPreviewHostContext(workbenchPreviewRenderContext);
      }
    },
    [previewContext, workbenchPreviewRenderContext, workbenchPreviewTabs.tabs],
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
    handledFilePanelRequestIdRef.current = previewContext?.filePanelRequest?.requestId ?? 0;
    handledPreviewEntryStampRef.current = previewContext?.activeEntry ? previewEntryStamp(previewContext.activeEntry) : "";
    setWorkbenchPreviewTabs(EMPTY_WORKBENCH_PREVIEW_TABS);
    setBtwSession(null);
    setBtwLoadedHistoryTurnCount(null);
  }, [selectedSessionId, workspaceId]);

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
                <WorkspaceFileBrowser
                  runtime={runtime}
                  workspaceId={workspaceId}
                  label={workspaceLabel}
                  previewPath={activeWorkbenchPreviewPath}
                  previewRequestId={activeWorkbenchPreviewTab?.requestId ?? 0}
                  previewRevealTarget={activeWorkbenchPreviewTab?.revealTarget ?? null}
                  previewPlacement="external"
                  onPreviewPathChange={openWorkspaceBrowserFilePreview}
                  onQuoteSelection={activeAssistantController.quoteSelection}
                  onStartChatFromAnnotation={activeAssistantController.startChatFromAnnotation}
                />
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
                  context={activeWorkbenchPreviewTab.renderContext ?? workbenchPreviewRenderContext}
                  fallbackRuntime={runtime}
                  fallbackWorkspaceId={workspaceId}
                  onCloseActive={closeActiveWorkbenchPreviewTab}
                  onCloseTab={closeWorkbenchPreviewTab}
                  onSelectTab={selectWorkbenchPreviewTab}
                  tabs={workbenchPreviewTabs.tabs}
                />
              ) : null}
            </div>
          </div>
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
          />
        </main>
      )}
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function WorkbenchMainPreviewTabs({
  activeTab,
  context,
  fallbackRuntime,
  fallbackWorkspaceId,
  onCloseActive,
  onCloseTab,
  onSelectTab,
  tabs,
}: {
  activeTab: WorkbenchMainPreviewTabState;
  context: PreviewRenderContext | null;
  fallbackRuntime: RuntimeBridge;
  fallbackWorkspaceId?: string;
  onCloseActive: () => void;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
  tabs: WorkbenchMainPreviewTabState[];
}) {
  const tabMenuRef = useRef<HTMLDivElement | null>(null);
  const [tabMenu, setTabMenu] = useState<WorkbenchPreviewTabMenuState | null>(null);
  const closeTabMenu = useCallback(() => {
    setTabMenu(null);
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
  const closeTabMenuTargets = useCallback(
    (tabIds: string[]) => {
      closeTabMenu();
      tabIds.forEach((tabId) => onCloseTab(tabId));
    },
    [closeTabMenu, onCloseTab],
  );

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
      data-open-tab-count={tabs.length}
      data-testid="workbench-main-file-preview"
    >
      <div className={styles.previewTabStrip} role="tablist" aria-label="工作台文件预览">
        {tabs.map((tab) => {
          const active = tab.id === activeTab.id;
          return (
            <div
              className={styles.previewTab}
              data-active={active ? "true" : "false"}
              data-app-context-menu="local"
              data-menu-open={tabMenu?.tabId === tab.id ? "true" : undefined}
              key={tab.id}
              onContextMenu={(event) => openTabMenu(event, tab.id)}
            >
              <button
                className={styles.previewTabMain}
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.sourceLabel}
                onClick={() => onSelectTab(tab.id)}
              >
                <span className={styles.previewTabTitle}>{tab.title}</span>
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
      <WorkbenchMainFilePreview
        context={context}
        fallbackRuntime={fallbackRuntime}
        fallbackWorkspaceId={fallbackWorkspaceId}
        request={activeTab.request}
        requestId={activeTab.requestId}
        revealTarget={activeTab.revealTarget}
        title={activeTab.title}
        onClose={onCloseActive}
      />
    </section>
  );
}

function WorkbenchMainFilePreview({
  context,
  fallbackRuntime,
  fallbackWorkspaceId,
  request,
  requestId,
  revealTarget,
  title,
  onClose,
}: {
  context: PreviewRenderContext | null;
  fallbackRuntime: RuntimeBridge;
  fallbackWorkspaceId?: string;
  request: PreviewRequest;
  requestId: number;
  revealTarget: PreviewFileRevealTarget | null;
  title: string;
  onClose: () => void;
}) {
  const sourceRevealRequest = useMemo<FilePreviewRevealRequest | null>(() => {
    if (!revealTarget) {
      return null;
    }
    return {
      requestId,
      selectedText: revealTarget.selectedText ?? null,
      lineStart: revealTarget.lineStart ?? null,
      lineEnd: revealTarget.lineEnd ?? null,
      sourceStart: revealTarget.sourceStart ?? null,
      sourceEnd: revealTarget.sourceEnd ?? null,
    };
  }, [
    requestId,
    revealTarget?.lineEnd,
    revealTarget?.lineStart,
    revealTarget?.selectedText,
    revealTarget?.sourceEnd,
    revealTarget?.sourceStart,
  ]);

  return (
    <div className={styles.mainPreviewBody} role="tabpanel" aria-label={title}>
      <FilePreview
        breadcrumbRootLabel={context?.workspaceLabel}
        workspaceId={context?.workspaceId ?? fallbackWorkspaceId}
        sessionId={context?.sessionId}
        request={request}
        runtime={context?.runtime ?? fallbackRuntime}
        sourceRevealRequest={sourceRevealRequest}
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

function previewRequestFromPath(path: string): PreviewRequest {
  return isAbsoluteFilePath(path) ? { type: "local-file", path } : { type: "file", path };
}

function workbenchPreviewTabId(request: PreviewRequest): string {
  if (request.type === "file" || request.type === "local-file") {
    return `file:${request.path}`;
  }
  if (request.type === "diff") {
    return `diff:${request.path}:${hashText(request.diff)}`;
  }
  return `content:${request.contentType}:${request.title}:${hashText(request.content)}`;
}

function previewTitle(request: PreviewRequest): string {
  if (request.type === "content") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: PreviewRequest): string {
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
  }
  return request.path;
}

function targetPathForPreviewRequest(request: PreviewRequest): string | null {
  if ("path" in request) {
    return request.path;
  }
  return request.sourcePath ?? null;
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
