import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { RuntimeBridge } from "@/runtime";
import { WorkspaceFileBrowser, WorkspaceSelector, type WorkspaceSelection } from "@/renderer/components/workspace";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { clampWorkbenchAssistantDrawerWidth } from "@/renderer/hooks/layout/layoutStore";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { createBtwConversationFromSession } from "@/renderer/pages/conversation/conversationForkSource";
import { useOptionalPreview, type PreviewFileRevealTarget } from "@/renderer/providers/PreviewProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
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

interface WorkbenchFilePreviewRequest {
  path: string | null;
  requestId: number;
  revealTarget: PreviewFileRevealTarget | null;
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
  const previewContext = useOptionalPreview();
  const layout = useLayoutState();
  const workspaceShellRef = useRef<HTMLElement | null>(null);
  const handledFilePanelRequestIdRef = useRef(previewContext?.filePanelRequest?.requestId ?? 0);
  const [creatingSession, setCreatingSession] = useState(false);
  const [btwSession, setBtwSession] = useState<AgentSession | null>(null);
  const [dockTransitioning, setDockTransitioning] = useState(false);
  const [dockTransitionLayout, setDockTransitionLayout] = useState<WorkbenchAssistantDockTransitionState>({
    phase: "idle",
    reservedWidth: 0,
  });
  const [workspacePreviewRequest, setWorkspacePreviewRequest] = useState<WorkbenchFilePreviewRequest>({
    path: null,
    requestId: 0,
    revealTarget: null,
  });
  const selectorValue: WorkspaceSelection = selectedWorkspace
    ? { type: "workspace", workspace: selectedWorkspace }
    : { type: "chat" };
  const workspaceLabel = selectedWorkspace?.root_path ?? selectedWorkspace?.name ?? workspaceId;
  const showPicker = !workspaceId;
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
    async ({ title, model }: { title: string; model?: { providerId: string; model: string } | null }) => {
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
    ensureSession: ensureWorkbenchSession,
  });
  const btwController = useAgentSessionController({
    runtime,
    sessionId: btwSession?.id ?? "",
    historyPageSize: 2,
    loadFullHistory: false,
  });
  const btwActive = Boolean(btwSession?.id);
  const activeAssistantController = btwActive ? btwController : assistantController;

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
      notifications.success("已打开旁路对话");
      return result.session;
    } catch (reason) {
      notifications.error(`旁路对话创建失败：${errorMessage(reason)}`);
      return null;
    }
  }, [assistantController.session?.id, notifications, runtime, selectedSessionId]);

  const closeWorkbenchBtwConversation = useCallback(() => {
    setBtwSession(null);
  }, []);

  useEffect(() => {
    handledFilePanelRequestIdRef.current = previewContext?.filePanelRequest?.requestId ?? 0;
    setWorkspacePreviewRequest({ path: null, requestId: 0, revealTarget: null });
    setBtwSession(null);
  }, [selectedSessionId, workspaceId]);

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
    setWorkspacePreviewRequest({
      path: request.path,
      requestId: request.requestId,
      revealTarget: request.revealTarget ?? null,
    });
  }, [
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.path,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.revealTarget,
    previewContext?.filePanelRequest?.scopeKey,
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
            >
              <WorkspaceFileBrowser
                runtime={runtime}
                workspaceId={workspaceId}
                label={workspaceLabel}
                previewPath={workspacePreviewRequest.path}
                previewRequestId={workspacePreviewRequest.requestId}
                previewRevealTarget={workspacePreviewRequest.revealTarget}
                onQuoteSelection={activeAssistantController.quoteSelection}
                onStartChatFromAnnotation={activeAssistantController.startChatFromAnnotation}
              />
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
            onOpenBtwConversation={openWorkbenchBtwConversation}
            onCloseBtwConversation={closeWorkbenchBtwConversation}
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
