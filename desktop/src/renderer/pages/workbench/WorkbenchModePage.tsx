import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { RuntimeBridge } from "@/runtime";
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

interface WorkbenchMainPreviewState {
  request: PreviewRequest;
  requestId: number;
  revealTarget: PreviewFileRevealTarget | null;
  renderContext: PreviewRenderContext | null;
  sourceEntryId: string | null;
}

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
  const [workbenchMainPreview, setWorkbenchMainPreview] = useState<WorkbenchMainPreviewState | null>(null);
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
      setWorkbenchMainPreview({
        request,
        requestId: requestId ?? nextMainPreviewRequestId(),
        revealTarget,
        renderContext,
        sourceEntryId,
      });
    },
    [nextMainPreviewRequestId],
  );
  const openWorkspaceBrowserFilePreview = useCallback(
    (path: string | null) => {
      if (!path) {
        setWorkbenchMainPreview(null);
        return;
      }
      openWorkbenchMainPreview({ type: "file", path }, workbenchPreviewRenderContext);
    },
    [openWorkbenchMainPreview, workbenchPreviewRenderContext],
  );
  const closeWorkbenchMainPreview = useCallback(() => {
    const sourceEntryId = workbenchMainPreview?.sourceEntryId ?? null;
    setWorkbenchMainPreview(null);
    if (sourceEntryId) {
      previewContext?.closePreviewEntry(sourceEntryId);
    }
    if (workbenchPreviewRenderContext) {
      previewContext?.setPreviewHostContext(workbenchPreviewRenderContext);
    }
  }, [previewContext, workbenchMainPreview?.sourceEntryId, workbenchPreviewRenderContext]);

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
    setWorkbenchMainPreview(null);
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
              className={styles.canvasContent}
              data-testid="workbench-canvas-content"
              data-main-preview-open={workbenchMainPreview ? "true" : "false"}
            >
              {workbenchMainPreview ? (
                <WorkbenchMainFilePreview
                  context={workbenchMainPreview.renderContext ?? workbenchPreviewRenderContext}
                  fallbackRuntime={runtime}
                  fallbackWorkspaceId={workspaceId}
                  request={workbenchMainPreview.request}
                  requestId={workbenchMainPreview.requestId}
                  revealTarget={workbenchMainPreview.revealTarget}
                  onClose={closeWorkbenchMainPreview}
                />
              ) : (
                <WorkspaceFileBrowser
                  runtime={runtime}
                  workspaceId={workspaceId}
                  label={workspaceLabel}
                  previewPlacement="external"
                  onPreviewPathChange={openWorkspaceBrowserFilePreview}
                  onQuoteSelection={activeAssistantController.quoteSelection}
                  onStartChatFromAnnotation={activeAssistantController.startChatFromAnnotation}
                />
              )}
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

function WorkbenchMainFilePreview({
  context,
  fallbackRuntime,
  fallbackWorkspaceId,
  request,
  requestId,
  revealTarget,
  onClose,
}: {
  context: PreviewRenderContext | null;
  fallbackRuntime: RuntimeBridge;
  fallbackWorkspaceId?: string;
  request: PreviewRequest;
  requestId: number;
  revealTarget: PreviewFileRevealTarget | null;
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
    <div className={styles.mainPreview} data-testid="workbench-main-file-preview">
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

function previewEntryStamp(entry: { id: string; openedAt: number }): string {
  return `${entry.id}:${entry.openedAt}`;
}

function workbenchPreviewPanelScopeKey(workspaceId: string): string {
  return `workbench:${workspaceId}`;
}
