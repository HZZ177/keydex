import { ChevronUp, PanelRightOpen, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  type RuntimeBridge,
  type WorkspaceEntry,
  type WorkspaceSearchResult,
  type WorkspaceSkillSummary,
} from "@/runtime";
import { SendBox, type SelectedFile, type SelectedQuote } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, useRuntimeModelSelection } from "@/renderer/components/model";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";
import type { FileChangePreview } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type {
  AgentChatMessage,
  CommandApprovalRequest,
  Workspace,
} from "@/types/protocol";

import styles from "./WorkbenchAssistantSurface.module.css";

type AssistantSurfaceMode = "capsule" | "composer" | "expanded" | "drawer";
type DockTransitionPhase = "dock-in" | "dock-out";

const DOCK_MORPH_DURATION_MS = 320;

interface DockMorphRect {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

interface DockMorphState {
  phase: DockTransitionPhase;
  from: DockMorphRect;
  to: DockMorphRect | null;
  targetMode: AssistantSurfaceMode;
  active: boolean;
}

export interface WorkbenchAssistantSurfaceProps {
  runtime: RuntimeBridge;
  workspaceId: string;
  workspace?: Workspace | null;
  controller: AgentSessionController;
  creatingSession?: boolean;
  onDockTransitionChange?: (transitioning: boolean) => void;
}

export function WorkbenchAssistantSurface({
  runtime,
  workspaceId,
  workspace,
  controller,
  creatingSession = false,
  onDockTransitionChange,
}: WorkbenchAssistantSurfaceProps) {
  const layout = useLayoutState();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dockTransitionTimerRef = useRef<number | null>(null);
  const [surfaceMode, setSurfaceMode] = useState<AssistantSurfaceMode>("capsule");
  const [composerFocusSeq, setComposerFocusSeq] = useState(0);
  const [dockTransition, setDockTransition] = useState<DockMorphState | null>(null);
  const modelSelection = useRuntimeModelSelection(runtime, "");
  const workspaceSkillScope = useMemo(() => ({ workspaceId }), [workspaceId]);
  const { state: workspaceSkillsState } = useWorkspaceSkills({
    runtime,
    scope: workspaceSkillScope,
    enabled: Boolean(workspaceId),
  });
  const workspaceSkills = workspaceSkillsState.skills;
  const pendingApproval = controller.pendingApproval;
  const projectedMessages = useMemo(() => controller.agentMessages.map(projectAgentMessage), [controller.agentMessages]);
  const accessoryMessages = useMemo(
    () => projectWorkbenchAccessoryMessages(controller.agentMessages),
    [controller.agentMessages],
  );
  const runtimeState = controller.runtimeState;
  const connectionReady = controller.connectionReady;
  const canSend = controller.canSend && !creatingSession && Boolean(workspaceId);
  const canStop = controller.canStop;
  const selectedModel = modelSelection.selectedModel.trim();
  const workspaceLabel = workspace?.root_path ?? workspace?.name ?? workspaceId;
  const drawerWidth = layout.state.workbenchAssistantDrawerWidth;
  const dockLayout = surfaceMode === "drawer" ? "inline" : "overlay";

  const finishDockTransition = useCallback(() => {
    if (dockTransitionTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(dockTransitionTimerRef.current);
    }
    dockTransitionTimerRef.current = null;
    setDockTransition(null);
    onDockTransitionChange?.(false);
  }, [onDockTransitionChange]);

  const beginDockTransition = useCallback(
    (phase: DockTransitionPhase, from: DockMorphRect, targetMode: AssistantSurfaceMode) => {
      if (dockTransitionTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(dockTransitionTimerRef.current);
      }
      dockTransitionTimerRef.current = null;
      onDockTransitionChange?.(true);
      setDockTransition({
        phase,
        from,
        targetMode,
        active: false,
        to: null,
      });
    },
    [onDockTransitionChange],
  );

  useEffect(() => {
    finishDockTransition();
    setSurfaceMode("capsule");
  }, [finishDockTransition, workspaceId]);

  useEffect(() => () => finishDockTransition(), [finishDockTransition]);

  useEffect(() => {
    if (surfaceMode === "capsule" && controller.draft.trim()) {
      setSurfaceMode("composer");
    }
  }, [controller.draft, surfaceMode]);

  useEffect(() => {
    if (pendingApproval) {
      if (surfaceMode !== "drawer") {
        const from = measureCapsuleTargetRect(surfaceRef.current, surfaceMode, fallbackDockSourceRect());
        beginDockTransition("dock-in", from, "drawer");
        setSurfaceMode("drawer");
      }
    }
  }, [beginDockTransition, pendingApproval, surfaceMode]);

  useEffect(() => {
    if ((surfaceMode !== "composer" && surfaceMode !== "expanded") || controller.draft.trim()) {
      return;
    }
    const collapseOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && surfaceRef.current?.contains(target)) {
        return;
      }
      setSurfaceMode("capsule");
    };
    document.addEventListener("pointerdown", collapseOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", collapseOnOutsidePointer);
  }, [controller.draft, surfaceMode]);

  useEffect(() => {
    if (!dockTransition || dockTransition.to || dockTransition.active) {
      return;
    }
    let cancelled = false;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;

    const activateMorph = () => {
      if (cancelled) {
        return;
      }
      const to =
        dockTransition.phase === "dock-in"
          ? measureDockTargetRect(surfaceRef.current, drawerWidth, dockTransition.from)
          : measureDockOutTargetRect(surfaceRef.current, dockTransition.targetMode, dockTransition.from);
      setDockTransition((current) =>
        current && current.phase === dockTransition.phase
          ? {
              ...current,
              to,
              active: true,
            }
          : current,
      );
      if (typeof window === "undefined") {
        finishDockTransition();
        return;
      }
      dockTransitionTimerRef.current = window.setTimeout(finishDockTransition, DOCK_MORPH_DURATION_MS);
    };

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      activateMorph();
      return () => {
        cancelled = true;
      };
    }

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(activateMorph);
    });

    return () => {
      cancelled = true;
      if (firstFrame !== null) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [dockTransition, drawerWidth, finishDockTransition]);

  useEffect(() => {
    if (
      controller.selectedSkill &&
      !workspaceSkills.some(
        (skill) => skill.name === controller.selectedSkill?.name && skill.source === controller.selectedSkill?.source,
      )
    ) {
      controller.setSelectedSkill(null);
    }
  }, [controller, workspaceSkills]);

  const searchWorkspace = useCallback(
    (query: string, options?: { signal?: AbortSignal }) => runtime.workspace.search({ workspaceId }, query, options),
    [runtime, workspaceId],
  );

  const listWorkspaceDirectory = useCallback(
    (path: string) =>
      runtime.workspace
        .listDirectory({ workspaceId }, path)
        .then((response) => workspaceEntriesToSearchResults(response.entries)),
    [runtime, workspaceId],
  );

  const send = useCallback(
    (files: SelectedFile[] = [], quotes: SelectedQuote[] = []) => controller.send(files, quotes, selectedModel),
    [controller, selectedModel],
  );

  const openComposer = useCallback(() => {
    setSurfaceMode("composer");
    setComposerFocusSeq((seq) => seq + 1);
  }, []);

  const closeDrawer = useCallback(() => {
    const targetMode: AssistantSurfaceMode = controller.draft.trim() ? "composer" : "capsule";
    const from = measureDockTargetRect(surfaceRef.current, drawerWidth, fallbackDockSourceRect());
    beginDockTransition("dock-out", from, targetMode);
    setSurfaceMode(targetMode);
  }, [beginDockTransition, controller.draft, drawerWidth]);

  const dockToDrawer = useCallback(() => {
    const from = measureCapsuleTargetRect(surfaceRef.current, surfaceMode, fallbackDockSourceRect());
    beginDockTransition("dock-in", from, "drawer");
    setSurfaceMode("drawer");
    setComposerFocusSeq((seq) => seq + 1);
  }, [beginDockTransition, surfaceMode]);

  const toggleExpandedLayer = useCallback(() => {
    setSurfaceMode((mode) => {
      if (mode === "expanded") {
        return controller.draft.trim() ? "composer" : "capsule";
      }
      return "expanded";
    });
    setComposerFocusSeq((seq) => seq + 1);
  }, [controller.draft]);

  const ignoreFilePreview = useCallback((_file: FileChangePreview) => undefined, []);

  const submitApproval = useCallback(
    (approved: boolean) =>
      controller.submitApproval({
        decision: approved ? "approved" : "rejected",
        trust_scope: "once",
      }),
    [controller],
  );

  const composer = (
    <WorkbenchComposer
      value={controller.draft}
      runtimeState={creatingSession ? "starting" : runtimeState}
      canSend={canSend}
      canStop={canStop}
      connectionReady={connectionReady}
      modelSelection={modelSelection}
      workspaceSkills={workspaceSkills}
      selectedSkill={controller.selectedSkill}
      fileChipRequest={controller.fileChipRequest}
      quoteChipRequest={controller.quoteChipRequest}
      surfaceMode={surfaceMode}
      autoFocusKey={surfaceMode === "capsule" ? undefined : `workbench-composer:${composerFocusSeq}`}
      onChange={controller.setDraft}
      onSkillChange={controller.setSelectedSkill}
      onSend={send}
      onStop={controller.stop}
      onExpand={toggleExpandedLayer}
      onSearchWorkspace={searchWorkspace}
      onListWorkspaceDirectory={listWorkspaceDirectory}
    />
  );

  const accessory = (
    <ConversationComposerAccessory
      messages={accessoryMessages}
      showScrollToBottom={false}
      showScrollButton={false}
      onFilePreview={ignoreFilePreview}
      onScrollToBottom={() => undefined}
    />
  );

  return (
    <div
      ref={surfaceRef}
      className={styles.surface}
      data-testid="workbench-assistant-surface"
      data-surface-mode={surfaceMode}
      data-dock-layout={dockLayout}
      data-dock-transition={dockTransition?.phase ?? "idle"}
      data-running={runtimeState === "running" ? "true" : "false"}
      data-pending-approval={pendingApproval ? "true" : "false"}
      style={{ "--workbench-assistant-dock-width": `${drawerWidth}px` } as CSSProperties}
    >
      {surfaceMode === "expanded" ? (
        <div className={styles.expandedLayer} data-testid="workbench-expanded-layer">
          <WorkbenchMessageProjection
            messages={projectedMessages}
            runtimeDetail={controller.runtimeDetail}
            workspaceLabel={workspaceLabel}
          />
          {pendingApproval ? (
            <WorkbenchApprovalPrompt
              approval={pendingApproval}
              error={controller.approvalError}
              submitting={controller.approvalSubmitting}
              onSubmit={submitApproval}
            />
          ) : null}
        </div>
      ) : null}
      {surfaceMode === "drawer" ? (
        <aside
          className={styles.drawer}
          data-testid="workbench-assistant-drawer"
          aria-label="工作台助手"
        >
          <header className={styles.drawerHeader}>
            <span>助手</span>
            <button type="button" aria-label="关闭工作台助手侧栏" onClick={closeDrawer}>
              <X size={15} />
            </button>
          </header>
          <WorkbenchMessageProjection
            messages={projectedMessages}
            runtimeDetail={controller.runtimeDetail}
            workspaceLabel={workspaceLabel}
          />
          {pendingApproval ? (
            <WorkbenchApprovalPrompt
              approval={pendingApproval}
              error={controller.approvalError}
              submitting={controller.approvalSubmitting}
              onSubmit={submitApproval}
            />
          ) : null}
          <div className={styles.drawerComposer}>
            <div className={styles.drawerAccessory}>{accessory}</div>
            {composer}
          </div>
        </aside>
      ) : null}
      {surfaceMode !== "drawer" ? (
        <div
          className={styles.capsule}
          data-compose-open={surfaceMode === "capsule" ? "false" : "true"}
          data-testid="workbench-assistant-capsule"
        >
          {surfaceMode === "capsule" ? (
            <div className={styles.capsuleCluster}>
              <div className={styles.capsuleAccessory}>{accessory}</div>
              <button
                className={styles.miniComposer}
                type="button"
                aria-label="展开工作台输入框"
                onClick={openComposer}
              >
                <span>要求后续变更</span>
              </button>
              <button
                className={styles.dockHandle}
                type="button"
                aria-label="将工作台助手展开到右侧"
                title="展开到右侧"
                onClick={dockToDrawer}
              >
                <PanelRightOpen size={15} />
              </button>
            </div>
          ) : (
            <div className={styles.composerStack}>
              <div className={styles.composerAccessory}>{accessory}</div>
              <div className={styles.composerShell}>
                {composer}
                <button
                  className={styles.composerDockHandle}
                  type="button"
                  aria-label="将工作台助手展开到右侧"
                  title="展开到右侧"
                  onClick={dockToDrawer}
                >
                  <PanelRightOpen size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {dockTransition ? <DockMorph transition={dockTransition} /> : null}
    </div>
  );
}

function DockMorph({ transition }: { transition: DockMorphState }) {
  const rect = transition.active && transition.to ? transition.to : transition.from;
  const radius = transition.active && transition.to ? transition.to.radius : transition.from.radius;
  const style = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: `${radius}px`,
  } as CSSProperties;
  return (
    <div
      className={styles.dockMorph}
      data-testid="workbench-assistant-dock-morph"
      data-phase={transition.phase}
      data-active={transition.active ? "true" : "false"}
      aria-hidden="true"
      style={style}
    >
      <div className={styles.dockMorphHeader} />
      <div className={styles.dockMorphLines}>
        <span />
        <span />
        <span />
      </div>
      <div className={styles.dockMorphComposer} />
    </div>
  );
}

function measureCapsuleTargetRect(
  surface: HTMLDivElement | null,
  mode: AssistantSurfaceMode,
  fallback: DockMorphRect,
): DockMorphRect {
  const capsule = surface?.querySelector<HTMLElement>('[data-testid="workbench-assistant-capsule"]') ?? null;
  const radius = mode === "capsule" ? 22 : 20;
  return rectFromElement(capsule, radius) ?? fallbackBottomRect(surface, mode, fallback);
}

function measureDockOutTargetRect(
  surface: HTMLDivElement | null,
  mode: AssistantSurfaceMode,
  fallback: DockMorphRect,
): DockMorphRect {
  return measureCapsuleTargetRect(surface, mode, fallback);
}

function measureDockTargetRect(
  surface: HTMLDivElement | null,
  drawerWidth: number,
  fallback: DockMorphRect,
): DockMorphRect {
  const surfaceRect = rectFromElement(surface, 0);
  const workspaceRect = rectFromElement(surface?.parentElement ?? null, 0);
  if (!workspaceRect) {
    return surfaceRect ?? fallback;
  }
  const width = Math.min(resolveDockInlineWidth(drawerWidth), workspaceRect.width);
  return {
    left: workspaceRect.left + workspaceRect.width - width,
    top: workspaceRect.top,
    width,
    height: workspaceRect.height,
    radius: 0,
  };
}

function rectFromElement(element: Element | null, radius: number): DockMorphRect | null {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return null;
  }
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    radius,
  };
}

function fallbackBottomRect(
  surface: HTMLDivElement | null,
  mode: AssistantSurfaceMode,
  fallback: DockMorphRect,
): DockMorphRect {
  const workspaceRect = rectFromElement(surface?.parentElement ?? null, 0);
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const baseLeft = workspaceRect?.left ?? 0;
  const baseTop = workspaceRect?.top ?? 0;
  const baseWidth = workspaceRect?.width ?? viewportWidth;
  const baseHeight = workspaceRect?.height ?? viewportHeight;
  const width = Math.min(mode === "capsule" ? 560 : 640, Math.max(280, baseWidth - 56));
  const height = mode === "capsule" ? 44 : 98;
  if (baseWidth <= 0 || baseHeight <= 0) {
    return fallback;
  }
  return {
    left: Math.round(baseLeft + (baseWidth - width) / 2),
    top: Math.round(baseTop + baseHeight - 16 - height),
    width: Math.round(width),
    height,
    radius: mode === "capsule" ? 22 : 20,
  };
}

function fallbackDockSourceRect(): DockMorphRect {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const width = Math.min(640, Math.max(280, viewportWidth - 56));
  const height = 92;
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.round(viewportHeight - 16 - height),
    width: Math.round(width),
    height,
    radius: 20,
  };
}

function resolveDockInlineWidth(drawerWidth: number): number {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  if (viewportWidth <= 900) {
    return Math.min(380, Math.max(300, viewportWidth * 0.48));
  }
  return Math.min(Math.max(320, drawerWidth), 520, viewportWidth * 0.46);
}

function WorkbenchApprovalPrompt({
  approval,
  error,
  submitting,
  onSubmit,
}: {
  approval: CommandApprovalRequest;
  error: string | null;
  submitting: boolean;
  onSubmit: (approved: boolean) => void;
}) {
  return (
    <section className={styles.approvalPrompt} data-testid="workbench-approval-prompt" aria-label="工作台审批">
      <strong>{approval.title || "需要批准"}</strong>
      <p>{approval.description || approval.tool_name || "Agent 需要你确认后继续。"}</p>
      {error ? <p className={styles.approvalError} role="alert">{error}</p> : null}
      <div className={styles.approvalActions}>
        <button type="button" disabled={submitting} onClick={() => onSubmit(false)}>
          拒绝
        </button>
        <button type="button" disabled={submitting} data-primary="true" onClick={() => onSubmit(true)}>
          批准
        </button>
      </div>
    </section>
  );
}

function WorkbenchComposer({
  value,
  runtimeState,
  canSend,
  canStop,
  connectionReady,
  modelSelection,
  workspaceSkills,
  selectedSkill,
  fileChipRequest,
  quoteChipRequest,
  surfaceMode,
  autoFocusKey,
  onChange,
  onSkillChange,
  onSend,
  onStop,
  onExpand,
  onSearchWorkspace,
  onListWorkspaceDirectory,
}: {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  connectionReady: boolean;
  modelSelection: ReturnType<typeof useRuntimeModelSelection>;
  workspaceSkills: WorkspaceSkillSummary[];
  selectedSkill: WorkspaceSkillSummary | null;
  fileChipRequest: AgentSessionController["fileChipRequest"];
  quoteChipRequest: AgentSessionController["quoteChipRequest"];
  surfaceMode: AssistantSurfaceMode;
  autoFocusKey?: string;
  onChange: (value: string) => void;
  onSkillChange: (skill: WorkspaceSkillSummary | null) => void;
  onSend: (files?: SelectedFile[], quotes?: SelectedQuote[]) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onExpand: () => void;
  onSearchWorkspace: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
  onListWorkspaceDirectory: (path: string) => Promise<WorkspaceSearchResult[]>;
}) {
  return (
    <SendBox
      value={value}
      runtimeState={runtimeState}
      canSend={canSend}
      canStop={canStop}
      ariaLabel="工作台助手表单"
      inputLabel="工作台助手输入"
      placeholder="要求后续变更"
      statusText={composerStatusText(runtimeState, connectionReady)}
      variant="keydex"
      autoFocusKey={autoFocusKey}
      className={styles.composer}
      controls={
        <button
          className={styles.iconButton}
          type="button"
          aria-label={surfaceMode === "expanded" ? "收起工作台消息层" : "展开工作台消息层"}
          title={surfaceMode === "expanded" ? "收起消息" : "展开消息"}
          onClick={onExpand}
        >
          <ChevronUp size={15} />
        </button>
      }
      rightControls={
        <RuntimeModelSelector
          model={modelSelection.selectedModel}
          modelOptions={modelSelection.modelOptions}
          modelLoadState={modelSelection.modelLoadState}
          modelError={modelSelection.modelError}
          disabled={isBusy(runtimeState)}
          placement="top"
          onModelChange={modelSelection.setSelectedModel}
        />
      }
      allowFileSelection
      externalFileRequest={fileChipRequest}
      externalQuoteRequest={quoteChipRequest}
      workspaceSkills={workspaceSkills}
      selectedSkill={selectedSkill}
      onChange={onChange}
      onSkillChange={onSkillChange}
      onSend={onSend}
      onStop={onStop}
      onSearchWorkspace={onSearchWorkspace}
      onListWorkspaceDirectory={onListWorkspaceDirectory}
    />
  );
}

function WorkbenchMessageProjection({
  messages,
  runtimeDetail,
  workspaceLabel,
}: {
  messages: ProjectedMessage[];
  runtimeDetail: string | null;
  workspaceLabel: string;
}) {
  const visibleMessages = messages.slice(-8);
  return (
    <div className={styles.messages} data-testid="workbench-message-projection" aria-label="工作台助手消息">
      {visibleMessages.length ? (
        visibleMessages.map((message) => (
          <article className={styles.messageBubble} data-role={message.role} key={message.id}>
            <span>{message.label}</span>
            <p>{message.content}</p>
          </article>
        ))
      ) : (
        <article className={styles.messageBubble} data-role="status">
          <span>{workspaceLabel}</span>
          <p>当前工作空间还没有助手消息。</p>
        </article>
      )}
      {runtimeDetail ? (
        <article className={styles.messageBubble} data-role="error" role="alert">
          <span>运行状态</span>
          <p>{runtimeDetail}</p>
        </article>
      ) : null}
    </div>
  );
}

interface ProjectedMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "status" | "error";
  label: string;
  content: string;
}

function projectWorkbenchAccessoryMessages(messages: AgentChatMessage[]): ConversationMessage[] {
  return messages
    .map<ConversationMessage | null>((message, index) => {
      const createdAt = new Date(message.timestamp || Date.now()).toISOString();
      const base = {
        id: `workbench:${message.id}`,
        threadId: message.sessionId,
        turnId: message.turnIndex === undefined || message.turnIndex === null ? null : `turn:${message.turnIndex}`,
        itemId: message.runId ?? message.toolCallId ?? message.id,
        content: message.content,
        createdAt,
        updatedAt: createdAt,
      };
      if (message.role === "user") {
        return {
          ...base,
          kind: "user" as const,
          payload: { text: message.content, _sortSeq: index },
        };
      }
      if (message.toolName === "update_plan") {
        const parsedResult = parseMaybeJson(message.toolResult);
        return {
          ...base,
          kind: "plan" as const,
          status: workbenchMessageStatus(message),
          payload: {
            call: { name: message.toolName, arguments: message.toolParams },
            result: parsedResult ?? message.toolResult,
            ui_payload: message.uiPayload,
            uiPayload: message.uiPayload,
            output_data: parsedResult,
            _sortSeq: index,
          },
        };
      }
      const fileChanges = message.fileChanges ?? fileChangesFromUiPayload(message.uiPayload);
      if (message.role === "tool" && fileChanges.length) {
        return {
          ...base,
          kind: "file_change" as const,
          status: workbenchMessageStatus(message),
          payload: {
            tool_name: message.toolName,
            toolName: message.toolName,
            params: message.toolParams,
            files: fileChanges,
            ui_payload: message.uiPayload,
            uiPayload: message.uiPayload,
            result: {
              status: message.status,
              files: fileChanges,
              ui_payload: message.uiPayload,
            },
            _sortSeq: index,
          },
        };
      }
      return null;
    })
    .filter((message): message is ConversationMessage => message !== null);
}

function workbenchMessageStatus(message: AgentChatMessage): ConversationMessage["status"] {
  if (message.status === "running" || message.status === "pending") {
    return "running";
  }
  if (message.status === "error" || message.status === "failed") {
    return "failed";
  }
  if (message.status === "cancelled") {
    return "cancelled";
  }
  return "completed";
}

function fileChangesFromUiPayload(uiPayload: Record<string, unknown> | undefined): NonNullable<AgentChatMessage["fileChanges"]> {
  if (!uiPayload) {
    return [];
  }
  const raw = Array.isArray(uiPayload.files)
    ? uiPayload.files
    : Array.isArray(uiPayload.changes)
      ? uiPayload.changes
      : [];
  return raw.filter((item): item is NonNullable<AgentChatMessage["fileChanges"]>[number] =>
    Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof (item as { path?: unknown }).path === "string"),
  );
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function projectAgentMessage(message: AgentChatMessage): ProjectedMessage {
  if (message.role === "user") {
    return { id: message.id, role: "user", label: "你", content: message.content || "已发送上下文" };
  }
  if (message.role === "assistant") {
    return { id: message.id, role: "assistant", label: "Agent", content: message.content || "正在整理回复" };
  }
  if (message.role === "tool") {
    return {
      id: message.id,
      role: "tool",
      label: message.toolName || "工具调用",
      content: message.toolError || message.toolResult || message.content || "工具正在运行",
    };
  }
  if (message.role === "error") {
    return { id: message.id, role: "error", label: "错误", content: message.content || "执行失败" };
  }
  return { id: message.id, role: "status", label: message.role, content: message.content || "状态更新" };
}

function workspaceEntriesToSearchResults(entries: WorkspaceEntry[]): WorkspaceSearchResult[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    type: entry.type,
  }));
}

function isBusy(state: ConversationRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "waiting_approval" || state === "cancelling";
}

function composerStatusText(state: ConversationRuntimeState, connectionReady: boolean): string {
  if (!connectionReady) {
    return "正在连接后端";
  }
  if (state === "idle" || state === "running") {
    return "";
  }
  if (state === "starting") {
    return "正在发起对话";
  }
  if (state === "waiting_approval") {
    return "等待审批确认";
  }
  if (state === "cancelling") {
    return "正在停止";
  }
  return "可以修改后重新发送";
}
