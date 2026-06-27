import { ChevronDown, ChevronUp, Minimize2, SquareArrowOutUpRight, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  type RuntimeBridge,
  type WorkspaceEntry,
  type WorkspaceSearchResult,
  type WorkspaceSkillSummary,
} from "@/runtime";
import { type SelectedFile, type SelectedQuote } from "@/renderer/components/chat/SendBox";
import { useRuntimeModelSelection } from "@/renderer/components/model";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { ConversationComposer } from "@/renderer/pages/conversation/ConversationComposer";
import { ConversationPanel, ConversationPanelComposerAccessory } from "@/renderer/pages/conversation/ConversationPanel";
import { preloadMarkdownCodeBlockRuntime } from "@/renderer/pages/conversation/messages/MarkdownCodeBlock";
import { useConversationPanelModel } from "@/renderer/pages/conversation/useConversationPanelModel";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";
import type {
  CommandApprovalRequest,
  Workspace,
} from "@/types/protocol";

import styles from "./WorkbenchAssistantSurface.module.css";
import { workbenchAssistantGeometryCssVars } from "./workbenchAssistantGeometry";
import {
  createWorkbenchAssistantState,
  workbenchAssistantReducer,
  type AssistantSurfaceMode,
} from "./workbenchAssistantState";

type DockTransitionPhase = "dock-in" | "dock-out";
type AssistantVisualMode = AssistantSurfaceMode | "dock-morph" | "dock-out-morph";

export interface WorkbenchAssistantDockTransitionState {
  phase: DockTransitionPhase | "idle";
  reservedWidth: number;
}

const COMPOSE_TRANSITION_DURATION_MS = 420;
const DOCK_IN_TRANSITION_DURATION_MS = 420;
const DOCK_OUT_TRANSITION_DURATION_MS = 650;
const WORKBENCH_ASSISTANT_MOTION_TRANSITION = {
  type: "tween",
  duration: COMPOSE_TRANSITION_DURATION_MS / 1000,
  ease: [0.2, 0.82, 0.22, 1],
} as const;
const WORKBENCH_ASSISTANT_DOCK_OUT_MOTION_TRANSITION = {
  type: "tween",
  duration: DOCK_OUT_TRANSITION_DURATION_MS / 1000,
  ease: [0.2, 0.82, 0.22, 1],
} as const;
const WORKBENCH_EXPANDED_PANEL_TRANSITION = {
  type: "tween",
  duration: 0.26,
  ease: [0.2, 0.82, 0.22, 1],
} as const;

export interface WorkbenchAssistantSurfaceProps {
  runtime: RuntimeBridge;
  workspaceId: string;
  workspace?: Workspace | null;
  controller: AgentSessionController;
  creatingSession?: boolean;
  onDockTransitionChange?: (transitioning: boolean) => void;
  onDockTransitionLayoutChange?: (state: WorkbenchAssistantDockTransitionState) => void;
}

export function WorkbenchAssistantSurface({
  runtime,
  workspaceId,
  controller,
  creatingSession = false,
  onDockTransitionChange,
  onDockTransitionLayoutChange,
}: WorkbenchAssistantSurfaceProps) {
  const layout = useLayoutState();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dockTransitionTimerRef = useRef<number | null>(null);
  const dockTransitionRunIdRef = useRef(0);
  const composeCollapseTimerRef = useRef<number | null>(null);
  const previousSurfaceModeRef = useRef<AssistantSurfaceMode>("capsule");
  const handledFileChipRequestIdRef = useRef(controller.fileChipRequest?.requestId ?? 0);
  const handledQuoteChipRequestIdRef = useRef(controller.quoteChipRequest?.requestId ?? 0);
  const [assistantState, dispatchAssistantState] = useReducer(
    workbenchAssistantReducer,
    undefined,
    createWorkbenchAssistantState,
  );
  const [dockTransitionPhase, setDockTransitionPhase] = useState<DockTransitionPhase | null>(null);
  const [dockReturnMode, setDockReturnMode] = useState<"capsule" | "composer" | null>(null);
  const [keepComposerContentDuringCollapse, setKeepComposerContentDuringCollapse] = useState(false);
  const modelSelection = useRuntimeModelSelection(runtime, "");
  const workspaceSkillScope = useMemo(() => ({ workspaceId }), [workspaceId]);
  const { state: workspaceSkillsState } = useWorkspaceSkills({
    runtime,
    scope: workspaceSkillScope,
    enabled: Boolean(workspaceId),
  });
  const workspaceSkills = workspaceSkillsState.skills;
  const pendingApproval = controller.pendingApproval;
  const panelSessionId = controller.session?.id ?? "";
  const panelModel = useConversationPanelModel({
    runtime,
    sessionId: panelSessionId,
    controller,
  });
  const runtimeState = controller.runtimeState;
  const connectionReady = controller.connectionReady;
  const canSend = controller.canSend && !creatingSession && Boolean(workspaceId);
  const canStop = controller.canStop;
  const selectedModel = modelSelection.selectedModel.trim();
  const drawerWidth = layout.state.workbenchAssistantDrawerWidth;
  const dockInlineWidth = resolveDockInlineWidth(drawerWidth);
  const surfaceMode = assistantState.mode;
  const dockOutTargetMode = dockReturnMode ?? (controller.draft.trim() ? "composer" : "capsule");
  const restingVisualSurfaceMode: AssistantVisualMode = surfaceMode === "expanded" ? "composer" : surfaceMode;
  const visualSurfaceMode: AssistantVisualMode =
    dockTransitionPhase === "dock-in"
      ? "dock-morph"
      : dockTransitionPhase === "dock-out"
        ? "dock-out-morph"
        : restingVisualSurfaceMode;
  const bottomSurfaceMode: AssistantSurfaceMode =
    dockTransitionPhase === "dock-in"
      ? "composer"
      : dockTransitionPhase === "dock-out"
        ? dockOutTargetMode
        : surfaceMode === "expanded"
          ? "composer"
          : surfaceMode;
  const composerFocusSeq = assistantState.focusSeq;
  const composeOpen = bottomSurfaceMode !== "capsule";
  const dockOutCollapsingToCapsule = dockTransitionPhase === "dock-out" && dockOutTargetMode === "capsule";
  const showFullComposerContent = composeOpen || keepComposerContentDuringCollapse || dockOutCollapsingToCapsule;
  const collapsingComposer = (!composeOpen && keepComposerContentDuringCollapse) || dockOutCollapsingToCapsule;
  const dockLayout = surfaceMode === "drawer" && dockTransitionPhase !== "dock-out" ? "inline" : "overlay";
  const renderDrawerContent = surfaceMode === "drawer" && dockTransitionPhase !== "dock-out";
  const renderMorphContent = dockTransitionPhase !== null;
  const renderBottomContent = true;
  const reducedMotion = prefersReducedMotion();
  const assistantMotionTransition =
    dockTransitionPhase === "dock-out"
      ? WORKBENCH_ASSISTANT_DOCK_OUT_MOTION_TRANSITION
      : WORKBENCH_ASSISTANT_MOTION_TRANSITION;
  const visualComposeOpen = composeOpen || dockOutCollapsingToCapsule;
  const enableDockChildLayout = !reducedMotion && dockTransitionPhase === null;
  const geometryMode: AssistantSurfaceMode =
    dockTransitionPhase === "dock-in"
      ? "drawer"
      : dockTransitionPhase === "dock-out"
        ? dockOutTargetMode
        : surfaceMode === "expanded"
          ? "composer"
          : surfaceMode;
  const geometryVars = workbenchAssistantGeometryCssVars(geometryMode, {
    drawerWidth,
    viewportWidth: typeof window === "undefined" ? 1440 : window.innerWidth,
  });

  const finishDockTransition = useCallback((reservedWidth = 0) => {
    dockTransitionRunIdRef.current += 1;
    if (dockTransitionTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(dockTransitionTimerRef.current);
    }
    dockTransitionTimerRef.current = null;
    setDockTransitionPhase(null);
    onDockTransitionChange?.(false);
    onDockTransitionLayoutChange?.({ phase: "idle", reservedWidth });
  }, [onDockTransitionChange, onDockTransitionLayoutChange]);

  const finishComposeCollapse = useCallback(() => {
    if (composeCollapseTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(composeCollapseTimerRef.current);
    }
    composeCollapseTimerRef.current = null;
    setKeepComposerContentDuringCollapse(false);
  }, []);

  const beginComposeCollapse = useCallback(() => {
    if (reducedMotion) {
      finishComposeCollapse();
      return;
    }
    setKeepComposerContentDuringCollapse(true);
    if (composeCollapseTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(composeCollapseTimerRef.current);
    }
    if (typeof window === "undefined") {
      finishComposeCollapse();
      return;
    }
    composeCollapseTimerRef.current = window.setTimeout(finishComposeCollapse, COMPOSE_TRANSITION_DURATION_MS);
  }, [finishComposeCollapse, reducedMotion]);

  const beginDockTransition = useCallback(
    (phase: DockTransitionPhase, onComplete: () => void) => {
      const durationMs = phase === "dock-out" ? DOCK_OUT_TRANSITION_DURATION_MS : DOCK_IN_TRANSITION_DURATION_MS;
      const transitionRunId = dockTransitionRunIdRef.current + 1;
      dockTransitionRunIdRef.current = transitionRunId;
      if (dockTransitionTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(dockTransitionTimerRef.current);
      }
      dockTransitionTimerRef.current = null;
      if (phase === "dock-in") {
        void preloadMarkdownCodeBlockRuntime().catch(() => undefined);
      }
      const completeTransition = () => {
        if (dockTransitionRunIdRef.current !== transitionRunId) {
          return;
        }
        if (phase === "dock-out") {
          finishDockTransition(0);
          onComplete();
          return;
        }
        onComplete();
        finishDockTransition(dockInlineWidth);
      };
      if (reducedMotion) {
        completeTransition();
        return;
      }
      onDockTransitionChange?.(true);
      onDockTransitionLayoutChange?.({ phase, reservedWidth: dockInlineWidth });
      setDockTransitionPhase(phase);
      if (typeof window === "undefined") {
        completeTransition();
        return;
      }
      dockTransitionTimerRef.current = window.setTimeout(() => {
        dockTransitionTimerRef.current = null;
        completeTransition();
      }, durationMs);
    },
    [dockInlineWidth, finishDockTransition, onDockTransitionChange, onDockTransitionLayoutChange, reducedMotion],
  );

  useEffect(() => {
    finishDockTransition();
    setDockReturnMode(null);
    dispatchAssistantState({ type: "workspace-reset" });
    handledFileChipRequestIdRef.current = controller.fileChipRequest?.requestId ?? 0;
    handledQuoteChipRequestIdRef.current = controller.quoteChipRequest?.requestId ?? 0;
  }, [finishDockTransition, panelSessionId, workspaceId]);

  useEffect(() => () => finishDockTransition(), [finishDockTransition]);

  useEffect(() => () => finishComposeCollapse(), [finishComposeCollapse]);

  useEffect(() => {
    const previousMode = previousSurfaceModeRef.current;
    previousSurfaceModeRef.current = surfaceMode;

    if (surfaceMode !== "capsule") {
      finishComposeCollapse();
      return;
    }

    if (keepComposerContentDuringCollapse) {
      return;
    }

    const shouldKeepContent =
      !reducedMotion && (previousMode === "composer" || previousMode === "expanded");
    if (!shouldKeepContent) {
      finishComposeCollapse();
      return;
    }

    beginComposeCollapse();
  }, [
    beginComposeCollapse,
    finishComposeCollapse,
    keepComposerContentDuringCollapse,
    reducedMotion,
    surfaceMode,
  ]);

  useEffect(() => {
    dispatchAssistantState({ type: "draft-changed", hasDraft: Boolean(controller.draft.trim()) });
  }, [controller.draft]);

  useEffect(() => {
    const fileRequestId = controller.fileChipRequest?.requestId ?? 0;
    const quoteRequestId = controller.quoteChipRequest?.requestId ?? 0;
    const hasNewContextRequest =
      fileRequestId > handledFileChipRequestIdRef.current ||
      quoteRequestId > handledQuoteChipRequestIdRef.current;
    handledFileChipRequestIdRef.current = Math.max(handledFileChipRequestIdRef.current, fileRequestId);
    handledQuoteChipRequestIdRef.current = Math.max(handledQuoteChipRequestIdRef.current, quoteRequestId);
    if (!hasNewContextRequest || surfaceMode === "drawer") {
      return;
    }
    dispatchAssistantState({ type: "context-injected" });
  }, [controller.fileChipRequest?.requestId, controller.quoteChipRequest?.requestId, surfaceMode]);

  useEffect(() => {
    if (pendingApproval) {
      if (surfaceMode !== "drawer") {
        setDockReturnMode(null);
        beginDockTransition("dock-in", () => {
          dispatchAssistantState({ type: "approval-pending" });
        });
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
      beginComposeCollapse();
      dispatchAssistantState({ type: "workspace-reset" });
    };
    document.addEventListener("pointerdown", collapseOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", collapseOnOutsidePointer);
  }, [beginComposeCollapse, controller.draft, surfaceMode]);

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
    dispatchAssistantState({ type: "open-composer" });
  }, []);

  const closeDrawer = useCallback(() => {
    const hasDraft = Boolean(controller.draft.trim());
    setDockReturnMode(hasDraft ? "composer" : "capsule");
    beginDockTransition("dock-out", () => {
      dispatchAssistantState({ type: "close-drawer", hasDraft });
      setDockReturnMode(null);
    });
  }, [beginDockTransition, controller.draft]);

  const collapseDrawerToCapsule = useCallback(() => {
    setDockReturnMode("capsule");
    beginDockTransition("dock-out", () => {
      dispatchAssistantState({ type: "close-drawer", hasDraft: false });
      setDockReturnMode(null);
    });
  }, [beginDockTransition]);

  const dockToDrawer = useCallback(() => {
    setDockReturnMode(null);
    beginDockTransition("dock-in", () => {
      dispatchAssistantState({ type: "dock-to-drawer" });
    });
  }, [beginDockTransition]);

  const toggleExpandedLayer = useCallback(() => {
    dispatchAssistantState({ type: "toggle-expanded", hasDraft: Boolean(controller.draft.trim()) });
  }, [controller.draft]);

  const closeExpandedLayer = useCallback(() => {
    if (surfaceMode !== "expanded") {
      return;
    }
    dispatchAssistantState({ type: "toggle-expanded", hasDraft: Boolean(controller.draft.trim()) });
  }, [controller.draft, surfaceMode]);

  useEffect(() => {
    if (surfaceMode !== "expanded") {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closeExpandedLayer();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [closeExpandedLayer, surfaceMode]);

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
      autoFocusKey={surfaceMode === "capsule" ? undefined : `workbench-composer:${composerFocusSeq}`}
      onChange={controller.setDraft}
      onSkillChange={controller.setSelectedSkill}
      onSend={send}
      onStop={controller.stop}
      onSearchWorkspace={searchWorkspace}
      onListWorkspaceDirectory={listWorkspaceDirectory}
    />
  );

  const accessory = <ConversationPanelComposerAccessory model={panelModel} showScrollButton={false} />;

  const hasCodeBlockMessages = useMemo(
    () => panelModel.messages.some((message) => valueContainsMarkdownCodeFence(message)),
    [panelModel.messages],
  );
  const stablePanelMode = renderDrawerContent ? "drawer" : renderMorphContent ? "morph" : "prewarm";
  const shouldMountStablePanel =
    surfaceMode !== "expanded" && (hasCodeBlockMessages || renderMorphContent || renderDrawerContent);
  const stablePanelTestId =
    stablePanelMode === "drawer"
      ? "workbench-assistant-drawer"
      : stablePanelMode === "morph"
        ? "workbench-assistant-morph-panel"
        : "workbench-assistant-panel-prewarm";
  const stablePanelHeaderTestId =
    stablePanelMode === "drawer"
      ? "workbench-assistant-drawer-header"
      : stablePanelMode === "morph"
        ? "workbench-assistant-morph-header"
        : undefined;
  const stableConversationPanel = shouldMountStablePanel ? (
    <ConversationPanel
      model={panelModel}
      workspaceRuntime={runtime}
      variant="compact"
      emptyText="当前工作空间还没有助手消息。"
      emptyTestId={`workbench-${stablePanelMode === "drawer" ? "drawer" : "morph"}-message-empty`}
      scrollButtonMode="external"
      turnNavigatorMode="hidden"
      className={styles.drawerPanel}
    />
  ) : null;
  const overlayConversationPanel =
    surfaceMode === "expanded" && dockTransitionPhase === null ? (
      <ConversationPanel
        model={panelModel}
        workspaceRuntime={runtime}
        variant="overlay"
        emptyText="当前工作空间还没有助手消息。"
        emptyTestId="workbench-expanded-message-empty"
        scrollButtonMode="external"
        turnNavigatorMode="hidden"
        className={styles.overlayPanel}
      />
    ) : null;
  const stableAssistantPanel = shouldMountStablePanel ? (
    <section
      className={[
        styles.morphPanel,
        stablePanelMode === "drawer" ? styles.drawer : "",
        stablePanelMode === "prewarm" ? styles.prewarmPanel : "",
      ].filter(Boolean).join(" ")}
      data-panel-mode={stablePanelMode}
      data-testid={stablePanelTestId}
      aria-hidden={stablePanelMode === "prewarm" ? "true" : undefined}
      aria-label={stablePanelMode === "drawer" ? "工作台助手" : "工作台助手过渡面板"}
    >
      <header className={styles.drawerHeader} data-testid={stablePanelHeaderTestId}>
        <div className={styles.drawerTitle}>
          <span>助手</span>
          <small>{drawerStatusText(runtimeState, pendingApproval)}</small>
        </div>
        <button
          type="button"
          aria-label="关闭工作台助手侧栏"
          aria-hidden={stablePanelMode === "drawer" ? undefined : "true"}
          data-visible={stablePanelMode === "drawer" ? "true" : "false"}
          tabIndex={stablePanelMode === "drawer" ? 0 : -1}
          onClick={closeDrawer}
        >
          <X size={15} />
        </button>
      </header>
      <div
        className={styles.morphMiddle}
        data-testid={stablePanelMode === "morph" ? "workbench-assistant-morph-middle" : undefined}
      >
        {stableConversationPanel}
        {stablePanelMode !== "prewarm" && pendingApproval ? (
          <WorkbenchApprovalPrompt
            approval={pendingApproval}
            error={controller.approvalError}
            submitting={controller.approvalSubmitting}
            onSubmit={submitApproval}
          />
        ) : null}
      </div>
    </section>
  ) : null;

  return (
    <div
      ref={surfaceRef}
      className={styles.surface}
      data-testid="workbench-assistant-surface"
      data-surface-mode={surfaceMode}
      data-visual-mode={visualSurfaceMode}
      data-geometry-mode={geometryMode}
      data-dock-out-target={dockOutTargetMode}
      data-dock-layout={dockLayout}
      data-dock-transition={dockTransitionPhase ?? "idle"}
      data-running={runtimeState === "running" ? "true" : "false"}
      data-pending-approval={pendingApproval ? "true" : "false"}
      style={
        {
          ...geometryVars,
          "--workbench-assistant-dock-width": `${drawerWidth}px`,
          "--workbench-assistant-dock-inline-size": `${dockInlineWidth}px`,
        } as CSSProperties
      }
    >
      <AnimatePresence initial={false}>
        {surfaceMode === "expanded" && dockTransitionPhase === null ? (
          <motion.div
            key="workbench-expanded-layer"
            className={styles.expandedLayer}
            data-testid="workbench-expanded-layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 1 }}
            transition={reducedMotion ? { duration: 0 } : WORKBENCH_EXPANDED_PANEL_TRANSITION}
            onClick={(event) => {
              event.preventDefault();
              closeExpandedLayer();
            }}
          >
            <motion.div
              className={styles.expandedPanelFrame}
              data-testid="workbench-expanded-panel-frame"
              initial={{ opacity: 0, y: 16, clipPath: "inset(100% 0 0 0 round 18px)" }}
              animate={{ opacity: 1, y: 0, clipPath: "inset(0% 0 0 0 round 18px)" }}
              exit={{ opacity: 1, y: 18, clipPath: "inset(100% 0 0 0 round 18px)" }}
              transition={reducedMotion ? { duration: 0 } : WORKBENCH_EXPANDED_PANEL_TRANSITION}
              onClick={(event) => event.stopPropagation()}
            >
              {overlayConversationPanel}
              {pendingApproval ? (
                <WorkbenchApprovalPrompt
                  approval={pendingApproval}
                  error={controller.approvalError}
                  submitting={controller.approvalSubmitting}
                  onSubmit={submitApproval}
                />
              ) : null}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <WorkbenchAssistantShell
        mode={visualSurfaceMode}
        geometryMode={geometryMode}
        dockOutTargetMode={dockOutTargetMode}
        dockLayout={dockLayout}
        transitionPhase={dockTransitionPhase ?? "idle"}
        reducedMotion={reducedMotion}
      >
        {stableAssistantPanel}
        {renderBottomContent ? (
          <motion.div
            className={styles.capsule}
            layout={enableDockChildLayout ? "position" : false}
            transition={reducedMotion ? { duration: 0 } : assistantMotionTransition}
            data-compose-open={visualComposeOpen ? "true" : "false"}
            data-compose-collapsing={collapsingComposer ? "true" : "false"}
            data-testid="workbench-assistant-capsule"
          >
            <motion.div
              className={styles.composerFrame}
              layout={enableDockChildLayout}
              transition={reducedMotion ? { duration: 0 } : assistantMotionTransition}
              data-compose-open={visualComposeOpen ? "true" : "false"}
              data-compose-collapsing={collapsingComposer ? "true" : "false"}
              data-testid={renderDrawerContent ? "workbench-assistant-drawer-composer-frame" : "workbench-assistant-composer-frame"}
            >
              <div className={styles.composerFrameHeader}>
                <motion.div
                  className={styles.composerFrameAccessory}
                >
                  {accessory}
                </motion.div>
                {renderDrawerContent ? (
                  <motion.button
                    className={styles.headerActionButton}
                    type="button"
                    aria-label="收回工作台助手为胶囊"
                    title="收回胶囊"
                    onClick={collapseDrawerToCapsule}
                  >
                    <Minimize2 size={15} />
                  </motion.button>
                ) : renderMorphContent ? null : (
                  <>
                    <motion.button
                      className={styles.headerActionButton}
                      type="button"
                      aria-label={surfaceMode === "expanded" ? "收起工作台消息层" : "展开工作台消息层"}
                      title={surfaceMode === "expanded" ? "收起消息" : "展开消息"}
                      data-expanded={surfaceMode === "expanded" ? "true" : "false"}
                      onClick={toggleExpandedLayer}
                    >
                      {surfaceMode === "expanded" ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                    </motion.button>
                    <motion.button
                      className={styles.dockHandle}
                      type="button"
                      aria-label="将工作台助手展开到右侧"
                      title="展开到右侧"
                      onClick={dockToDrawer}
                    >
                      <SquareArrowOutUpRight size={15} />
                    </motion.button>
                  </>
                )}
              </div>
              <motion.div
                className={styles.inputSurface}
                layout={enableDockChildLayout}
                transition={reducedMotion ? { duration: 0 } : assistantMotionTransition}
                data-compose-open={visualComposeOpen ? "true" : "false"}
                data-compose-collapsing={collapsingComposer ? "true" : "false"}
                data-testid={renderDrawerContent ? "workbench-assistant-drawer-input-surface" : "workbench-assistant-input-surface"}
                onClick={composeOpen ? undefined : openComposer}
              >
                {showFullComposerContent ? (
                  <div className={styles.composerShell} data-collapsing={collapsingComposer ? "true" : "false"}>
                    {composer}
                  </div>
                ) : (
                  <button
                    className={styles.miniComposer}
                    type="button"
                    aria-label="展开工作台输入框"
                    onClick={openComposer}
                  >
                    <span>要求后续变更</span>
                  </button>
                )}
              </motion.div>
            </motion.div>
          </motion.div>
        ) : null}
      </WorkbenchAssistantShell>
    </div>
  );
}

function WorkbenchAssistantShell({
  children,
  dockLayout,
  dockOutTargetMode,
  geometryMode,
  mode,
  reducedMotion,
  transitionPhase,
}: {
  children: ReactNode;
  dockLayout: "inline" | "overlay";
  dockOutTargetMode: AssistantSurfaceMode;
  geometryMode: AssistantSurfaceMode;
  mode: AssistantVisualMode;
  reducedMotion: boolean;
  transitionPhase: DockTransitionPhase | "idle";
}) {
  const chromeLayout =
    reducedMotion || transitionPhase !== "idle" ? false : "position";
  const chromeMotionTransition =
    transitionPhase === "dock-out"
      ? WORKBENCH_ASSISTANT_DOCK_OUT_MOTION_TRANSITION
      : WORKBENCH_ASSISTANT_MOTION_TRANSITION;

  return (
    <div
      className={styles.shell}
      data-testid="workbench-assistant-shell"
      data-dock-layout={dockLayout}
      data-dock-out-target={dockOutTargetMode}
      data-geometry-mode={geometryMode}
      data-shell-mode={mode}
      data-transition-phase={transitionPhase}
    >
      <motion.div
        className={styles.chrome}
        data-testid="workbench-assistant-chrome"
        data-dock-out-target={dockOutTargetMode}
        data-geometry-mode={geometryMode}
        data-shell-mode={mode}
        layout={chromeLayout}
        transition={reducedMotion ? { duration: 0 } : chromeMotionTransition}
      >
        {children}
      </motion.div>
    </div>
  );
}

function resolveDockInlineWidth(drawerWidth: number): number {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  if (viewportWidth <= 900) {
    return Math.min(380, Math.max(300, viewportWidth * 0.48));
  }
  return Math.min(Math.max(320, drawerWidth), 520, viewportWidth * 0.46);
}

function valueContainsMarkdownCodeFence(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.includes("```") || value.includes("~~~");
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsMarkdownCodeFence(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      valueContainsMarkdownCodeFence(item, depth + 1),
    );
  }
  return false;
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
  autoFocusKey,
  onChange,
  onSkillChange,
  onSend,
  onStop,
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
  autoFocusKey?: string;
  onChange: (value: string) => void;
  onSkillChange: (skill: WorkspaceSkillSummary | null) => void;
  onSend: (files?: SelectedFile[], quotes?: SelectedQuote[]) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onSearchWorkspace: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
  onListWorkspaceDirectory: (path: string) => Promise<WorkspaceSearchResult[]>;
}) {
  return (
    <ConversationComposer
      value={value}
      runtimeState={runtimeState}
      canSend={canSend}
      canStop={canStop}
      connectionReady={connectionReady}
      modelSelection={modelSelection}
      workspaceSkills={workspaceSkills}
      selectedSkill={selectedSkill}
      autoFocusKey={autoFocusKey}
      className={styles.composer}
      placeholder="要求后续变更"
      ariaLabel="工作台助手表单"
      inputLabel="工作台助手输入"
      modelSelectorPlacement="top"
      externalFileRequest={fileChipRequest}
      externalQuoteRequest={quoteChipRequest}
      onChange={onChange}
      onSkillChange={onSkillChange}
      onSend={onSend}
      onStop={onStop}
      onSearchWorkspace={onSearchWorkspace}
      onListWorkspaceDirectory={onListWorkspaceDirectory}
    />
  );
}

function workspaceEntriesToSearchResults(entries: WorkspaceEntry[]): WorkspaceSearchResult[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    type: entry.type,
  }));
}

function drawerStatusText(state: ConversationRuntimeState, pendingApproval: CommandApprovalRequest | null): string {
  if (pendingApproval) {
    return "等待审批";
  }
  if (state === "running") {
    return "运行中";
  }
  if (state === "starting") {
    return "启动中";
  }
  if (state === "cancelling") {
    return "停止中";
  }
  return "就绪";
}
