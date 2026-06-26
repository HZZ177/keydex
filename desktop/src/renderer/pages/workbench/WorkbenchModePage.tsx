import { useCallback, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import { WorkspaceFileBrowser, WorkspaceSelector, type WorkspaceSelection } from "@/renderer/components/workspace";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import type { AgentSession, Workspace } from "@/types/protocol";

import { WorkbenchAssistantSurface } from "./WorkbenchAssistantSurface";
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
}: WorkbenchModePageProps) {
  const [creatingSession, setCreatingSession] = useState(false);
  const [dockTransitioning, setDockTransitioning] = useState(false);
  const selectorValue: WorkspaceSelection = selectedWorkspace
    ? { type: "workspace", workspace: selectedWorkspace }
    : { type: "chat" };
  const workspaceLabel = selectedWorkspace?.root_path ?? selectedWorkspace?.name ?? workspaceId;
  const showPicker = !workspaceId;
  const showWorkspaceUnavailable = Boolean(workspaceId && workspaceError && !selectedWorkspace);
  const ensureWorkbenchSession = useCallback(
    async ({ title }: { title: string }) => {
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
  const assistantController = useAgentSessionController({
    runtime,
    sessionId: selectedSessionId ?? "",
    ensureSession: ensureWorkbenchSession,
  });

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
          className={styles.workspace}
          data-testid="workbench-workspace-shell"
          data-dock-transitioning={dockTransitioning ? "true" : "false"}
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
                onQuoteSelection={assistantController.quoteSelection}
                onStartChatFromAnnotation={assistantController.startChatFromAnnotation}
              />
            </div>
          </div>
          <WorkbenchAssistantSurface
            runtime={runtime}
            workspaceId={workspaceId}
            workspace={selectedWorkspace}
            controller={assistantController}
            creatingSession={creatingSession}
            onDockTransitionChange={setDockTransitioning}
          />
        </main>
      )}
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
