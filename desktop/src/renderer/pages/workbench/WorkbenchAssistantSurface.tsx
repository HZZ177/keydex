import { ArrowLeft, ChevronDown, ChevronUp, Minimize2, SquareArrowOutUpRight, SquarePen, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  type RuntimeBridge,
  type WorkspaceEntry,
  type WorkspaceSearchResult,
  type WorkspaceSkillSummary,
} from "@/runtime";
import {
  agentAttachmentFromSelected,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import { GoalModeAccessory } from "@/renderer/components/chat/GoalModeAccessory";
import {
  isContextCompressionSlashCommand,
  type SlashCommand,
} from "@/renderer/components/chat/SlashCommandMenu";
import { LoadingSkeleton } from "@/renderer/components/loading";
import { useRafPanelResize } from "@/renderer/components/layout/useRafPanelResize";
import { useRuntimeModelSelection, type RuntimeSelectedModel } from "@/renderer/components/model";
import { FileReviewPanel } from "@/renderer/components/review/FileReviewDiff";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useHeldActiveFlag } from "@/renderer/hooks/useHeldActiveFlag";
import {
  clampWorkbenchAssistantDrawerWidth,
  DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH,
} from "@/renderer/hooks/layout/layoutStore";
import type {
  AgentSessionController,
  AgentSessionControllerEnsureSessionRequest,
  AgentSessionControllerEnsureSessionResult,
} from "@/renderer/hooks/useAgentSessionController";
import { ComposerApprovalCard } from "@/renderer/pages/conversation/ComposerApprovalCard";
import { ConversationComposer } from "@/renderer/pages/conversation/ConversationComposer";
import { ConversationPanel, ConversationPanelComposerAccessory } from "@/renderer/pages/conversation/ConversationPanel";
import {
  BTW_CONVERSATION_TITLE,
  createBtwConversationHistorySnapshot,
  filterBtwConversationVisibleMessages,
  type BtwConversationHistorySnapshot,
} from "@/renderer/pages/conversation/conversationForkSource";
import {
  goalContextItem,
  goalSeedContextMetadata,
  runtimeParamsWithGoalContextItem,
  runtimeParamsWithInitialGoalTask,
} from "@/renderer/pages/conversation/goalSeedContext";
import {
  buildTurnNavigationItemsFromMessages,
  type ConversationTurnNavigationItem,
  type MessageListTurnNavigationRequest,
} from "@/renderer/pages/conversation/messages";
import { LineChangeTicker } from "@/renderer/pages/conversation/messages/LineChangeTicker";
import { preloadMarkdownCodeBlockRuntime } from "@/renderer/pages/conversation/messages/MarkdownCodeBlock";
import {
  useConversationPanelModel,
  type ContextWindowUsageStatus,
} from "@/renderer/pages/conversation/useConversationPanelModel";
import {
  usePreview,
  type PreviewFileRevealTarget,
  type PreviewRenderContext,
  type ReviewPanelRequest,
} from "@/renderer/providers/PreviewProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";
import type {
  AgentChatMessage,
  AgentContextItem,
  AgentFileChange,
  AgentSession,
  CommandApprovalRequest,
  FileAccessMode,
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
type MessageTriggerState = "idle" | "priming" | "streaming" | "completed" | "failed" | "approval";
type MessageTriggerPreviewKind = "assistant" | "tool" | "file-change";

interface MessageTriggerPreview {
  addedLines: number;
  kind: MessageTriggerPreviewKind;
  removedLines: number;
  text: string;
}

const MINI_TURN_WAVE_RADIUS = 3.6;
const MINI_TURN_WAVE_FALLOFF_EXPONENT = 1.45;
const MINI_TURN_MARKER_BASE_WIDTH = 12;
const MINI_TURN_MARKER_PEAK_WIDTH = 30;
const MINI_TURN_MARKER_STEP = 12;
const MINI_TURN_MARKER_HIT_HEIGHT = 14;
const MINI_TURN_SCROLL_EDGE = 12;

export interface WorkbenchAssistantDockTransitionState {
  phase: DockTransitionPhase | "idle" | "resize";
  reservedWidth: number;
}

const COMPOSE_TRANSITION_DURATION_MS = 420;
const DOCK_IN_TRANSITION_DURATION_MS = 420;
const DOCK_OUT_TRANSITION_DURATION_MS = 650;
const MESSAGE_TRIGGER_PRIMING_DURATION_MS = 340;
const MESSAGE_CARRIER_STREAM_REFRESH_MS = 560;
const MESSAGE_CARRIER_PENDING_TEXT = "正在等待回复…";
const MESSAGE_CARRIER_TYPEWRITER_TICK_MS = 24;
const MESSAGE_CARRIER_TYPEWRITER_TARGET_MS = 360;
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
const WORKBENCH_EXPANDED_CONTENT_REVEAL_DELAY_MS = 260;

export interface WorkbenchAssistantSurfaceProps {
  runtime: RuntimeBridge;
  workspaceId: string;
  workspace?: Workspace | null;
  controller: AgentSessionController;
  creatingSession?: boolean;
  drawerWidth?: number;
  drawerInlineWidth?: number;
  onEnsureSession?: (
    request: AgentSessionControllerEnsureSessionRequest,
  ) => Promise<AgentSessionControllerEnsureSessionResult>;
  onRequestNewSession?: () => Promise<void> | void;
  onDrawerWidthPreview?: (width: number) => void;
  onDrawerWidthCommit?: (width: number) => void;
  onDockTransitionChange?: (transitioning: boolean) => void;
  onDockTransitionLayoutChange?: (state: WorkbenchAssistantDockTransitionState) => void;
  onOpenMcpSettings?: () => void;
  btwActive?: boolean;
  btwLoadedHistoryTurnCount?: number | null;
  onOpenBtwConversation?: () => Promise<AgentSession | null> | AgentSession | null;
  onCloseBtwConversation?: () => void;
}

export function WorkbenchAssistantSurface({
  runtime,
  workspaceId,
  workspace = null,
  controller,
  creatingSession = false,
  drawerWidth: controlledDrawerWidth,
  drawerInlineWidth: controlledDrawerInlineWidth,
  onEnsureSession,
  onRequestNewSession,
  onDrawerWidthPreview,
  onDrawerWidthCommit,
  onDockTransitionChange,
  onDockTransitionLayoutChange,
  onOpenMcpSettings,
  btwActive = false,
  btwLoadedHistoryTurnCount = null,
  onOpenBtwConversation,
  onCloseBtwConversation,
}: WorkbenchAssistantSurfaceProps) {
  const layout = useLayoutState();
  const notifications = useNotifications();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const assistantChromeRef = useRef<HTMLDivElement | null>(null);
  const dockTransitionTimerRef = useRef<number | null>(null);
  const dockTransitionRunIdRef = useRef(0);
  const composeCollapseTimerRef = useRef<number | null>(null);
  const drawerContentTimerRef = useRef<number | null>(null);
  const expandedContentTimerRef = useRef<number | null>(null);
  const messageTriggerPrimingTimerRef = useRef<number | null>(null);
  const panelMessageCountRef = useRef(0);
  const previousSurfaceModeRef = useRef<AssistantSurfaceMode>("capsule");
  const previousRuntimeStateRef = useRef<ConversationRuntimeState | null>(null);
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
  const [drawerContentReady, setDrawerContentReady] = useState(false);
  const [expandedContentReady, setExpandedContentReady] = useState(false);
  const [messageTriggerPriming, setMessageTriggerPriming] = useState(false);
  const [unreadAssistantMessageKey, setUnreadAssistantMessageKey] = useState<string | null>(null);
  const [allowPersistentTrust, setAllowPersistentTrust] = useState(true);
  const [fileAccessMode, setFileAccessMode] = useState<FileAccessMode>("workspace_trusted");
  const [expandedBottomGap, setExpandedBottomGap] = useState(160);
  const [uncontrolledDrawerWidthPreview, setUncontrolledDrawerWidthPreview] = useState<number | null>(null);
  const [overlayTurnNavigationRequest, setOverlayTurnNavigationRequest] =
    useState<MessageListTurnNavigationRequest | null>(null);
  const [btwHistorySnapshot, setBtwHistorySnapshot] = useState<BtwConversationHistorySnapshot | null>(null);
  const [composerFiles, setComposerFiles] = useState<SelectedFile[]>([]);
  const [composerQuotes, setComposerQuotes] = useState<SelectedQuote[]>([]);
  const [goalComposerOpen, setGoalComposerOpen] = useState(false);
  const [goalCreating, setGoalCreating] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [contextCompressionRunning, setContextCompressionRunning] = useState(false);
  const modelSelection = useRuntimeModelSelection(runtime, null, { enabled: backendReady });
  const workspaceSkillScope = useMemo(() => ({ workspaceId }), [workspaceId]);
  const { state: workspaceSkillsState, refresh: refreshWorkspaceSkills } = useWorkspaceSkills({
    runtime,
    scope: workspaceSkillScope,
    enabled: backendReady && Boolean(workspaceId),
  });
  const workspaceSkills = Array.isArray(workspaceSkillsState.skills) ? workspaceSkillsState.skills : [];
  const previewContext = usePreview();
  const workbenchWorkspaceLabel = workspace?.root_path ?? workspace?.name ?? workspaceId;
  const handledReviewPanelRequestIdRef = useRef(previewContext.reviewPanelRequest?.requestId ?? 0);
  const [workbenchReviewPanel, setWorkbenchReviewPanel] = useState<ReviewPanelRequest | null>(null);
  const pendingApproval = controller.pendingApproval;
  const panelSessionId = controller.session?.id ?? "";
  const workbenchPreviewScopeKey = workspaceId ? workbenchPreviewPanelScopeKey(workspaceId) : undefined;
  const currentFileChipRequestId = controller.fileChipRequest?.requestId ?? 0;
  const currentQuoteChipRequestId = controller.quoteChipRequest?.requestId ?? 0;
  const contextRequestBaselineRef = useRef({
    fileRequestId: -1,
    quoteRequestId: -1,
    sessionId: panelSessionId,
  });
  if (contextRequestBaselineRef.current.sessionId !== panelSessionId) {
    contextRequestBaselineRef.current = {
      fileRequestId: currentFileChipRequestId,
      quoteRequestId: currentQuoteChipRequestId,
      sessionId: panelSessionId,
    };
  }
  const composerFileChipRequest =
    currentFileChipRequestId > contextRequestBaselineRef.current.fileRequestId ? controller.fileChipRequest : null;
  const composerQuoteChipRequest =
    currentQuoteChipRequestId > contextRequestBaselineRef.current.quoteRequestId ? controller.quoteChipRequest : null;
  const panelModel = useConversationPanelModel({
    runtime,
    sessionId: panelSessionId,
    controller,
    previewPanelScopeKey: workbenchPreviewScopeKey,
    validateSelectedSkill: false,
  });
  useEffect(() => {
    if (!btwActive && btwHistorySnapshot !== null) {
      setBtwHistorySnapshot(null);
    }
  }, [btwActive, btwHistorySnapshot]);
  useEffect(() => {
    if (!btwActive || !panelSessionId || controller.loading) {
      return;
    }
    setBtwHistorySnapshot((current) => {
      if (current?.sessionId === panelSessionId) {
        if (btwLoadedHistoryTurnCount !== null && current.loadedTurnCount !== btwLoadedHistoryTurnCount) {
          return {
            ...current,
            loadedTurnCount: btwLoadedHistoryTurnCount,
          };
        }
        return current;
      }
      return createBtwConversationHistorySnapshot(panelSessionId, panelModel.messages, {
        loadedTurnCount: btwLoadedHistoryTurnCount,
      });
    });
  }, [btwActive, btwLoadedHistoryTurnCount, controller.loading, panelModel.messages, panelSessionId]);
  const activeBtwHistorySnapshot =
    btwActive && btwHistorySnapshot?.sessionId === panelSessionId ? btwHistorySnapshot : null;
  const reviewActive = Boolean(workbenchReviewPanel);
  const secondaryPageActive = btwActive || reviewActive;
  const displayPanelMessages = useMemo(() => {
    if (!btwActive) {
      return panelModel.messages;
    }
    if (!activeBtwHistorySnapshot) {
      return [];
    }
    return filterBtwConversationVisibleMessages(panelModel.messages, activeBtwHistorySnapshot);
  }, [activeBtwHistorySnapshot, btwActive, panelModel.messages]);
  const resolvedBtwLoadedHistoryTurnCount = activeBtwHistorySnapshot?.loadedTurnCount ?? 0;
  const displayPanelModel = useMemo(() => {
    if (!btwActive) {
      return panelModel;
    }
    return {
      ...panelModel,
      messages: displayPanelMessages,
      loading: false,
      loadingOlderHistory: false,
      sessionViewState: panelModel.sessionViewState
        ? {
            ...panelModel.sessionViewState,
            historyHasMoreOlder: false,
          }
        : panelModel.sessionViewState,
    };
  }, [btwActive, displayPanelMessages, panelModel]);
  const workbenchPreviewRenderContext = useMemo<PreviewRenderContext>(
    () => ({
      panelScopeKey: workbenchPreviewScopeKey,
      workspaceId,
      workspaceAvailable: Boolean(workspaceId),
      workspaceLabel: workbenchWorkspaceLabel,
      runtime,
      onQuoteSelection: controller.quoteSelection,
      onStartChatFromAnnotation: controller.startChatFromAnnotation,
    }),
    [
      controller.quoteSelection,
      controller.startChatFromAnnotation,
      workbenchPreviewScopeKey,
      runtime,
      workbenchWorkspaceLabel,
      workspaceId,
    ],
  );
  const openWorkbenchFileReference = useCallback(
    (file: SelectedFile) => {
      if (!workspaceId || !file.path) {
        return;
      }
      previewContext.openFilePanel(file.path, workbenchPreviewRenderContext, selectedFileRevealTarget(file));
    },
    [previewContext, workbenchPreviewRenderContext, workspaceId],
  );
  const btwHistoryNotice = useMemo(
    () =>
      btwActive && activeBtwHistorySnapshot
        ? {
            content: `该会话前置${resolvedBtwLoadedHistoryTurnCount}轮历史消息已加载`,
            tone: "success" as const,
            testId: "btw-conversation-history-notice",
            title: `该会话前置${resolvedBtwLoadedHistoryTurnCount}轮历史消息已加载`,
          }
        : null,
    [activeBtwHistorySnapshot, btwActive, resolvedBtwLoadedHistoryTurnCount],
  );
  const panelMessageCount = displayPanelModel.messages.length;
  panelMessageCountRef.current = panelMessageCount;
  const runtimeState = controller.runtimeState;
  const connectionReady = controller.connectionReady;
  const canSend = controller.canSend && !creatingSession && Boolean(workspaceId);
  const canStop = controller.canStop;
  const selectedModel = modelSelection.selectedModel;
  const hasComposerContext = Boolean(controller.selectedSkill || composerFiles.length || composerQuotes.length);
  const hasComposerContent = Boolean(controller.draft.trim() || hasComposerContext || goalComposerOpen);
  const drawerWidth =
    controlledDrawerWidth ?? uncontrolledDrawerWidthPreview ?? layout.state.workbenchAssistantDrawerWidth;
  const dockInlineWidth =
    controlledDrawerInlineWidth ??
    resolveWorkbenchAssistantDockInlineWidth(drawerWidth, typeof window === "undefined" ? 1280 : window.innerWidth);
  const surfaceMode = assistantState.mode;
  const restingBottomTargetMode: AssistantSurfaceMode =
    surfaceMode === "composer" || surfaceMode === "expanded" ? "composer" : "capsule";
  const dockOutTargetMode = dockReturnMode ?? restingBottomTargetMode;
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

  useEffect(() => {
    if (!backendReady) {
      return;
    }
    let active = true;
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (active) {
          setAllowPersistentTrust(settings.command.allow_persistent_trust);
          setFileAccessMode(settings.command.file_access_mode);
        }
      })
      .catch(() => {
        if (active) {
          setAllowPersistentTrust(true);
          setFileAccessMode("workspace_trusted");
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, runtime]);

  useEffect(() => {
    const providerId = controller.session?.current_model_provider_id?.trim() ?? "";
    const model = controller.session?.current_model?.trim() ?? "";
    if (providerId && model) {
      modelSelection.setSelectedModel({ providerId, model });
    }
  }, [controller.session?.current_model_provider_id, controller.session?.current_model]);

  const changeModel = useCallback(
    (selection: RuntimeSelectedModel | null) => {
      modelSelection.setSelectedModel(selection);
      if (!selection || !controller.session?.id) {
        return;
      }
      void runtime.conversation
        .updateSession(controller.session.id, {
          current_model_provider_id: selection.providerId,
          current_model: selection.model,
        })
        .then((updated) => {
          controller.dispatch({ type: "session/upsert", session: updated });
        })
        .catch(() => undefined);
    },
    [controller, modelSelection, runtime],
  );
  const currentSessionTitle =
    (btwActive
      ? BTW_CONVERSATION_TITLE
      : workbenchReviewPanel
        ? workbenchReviewPanel.title || "审阅"
        : controller.session?.title?.trim() || controller.session?.id?.trim()) || "";
  const sessionTitleVisible = Boolean(currentSessionTitle);
  const collapsedDraftPreview = controller.draft.replace(/\s+/g, " ").trim();
  const collapsedComposerLabel = collapsedDraftPreview || (hasComposerContext ? "已添加上下文" : "要求后续变更");
  const composeOpen = bottomSurfaceMode !== "capsule";
  const dockOutCollapsingToCapsule = dockTransitionPhase === "dock-out" && dockOutTargetMode === "capsule";
  const showFullComposerContent = composeOpen || keepComposerContentDuringCollapse || dockOutCollapsingToCapsule;
  const collapsingComposer = (!composeOpen && keepComposerContentDuringCollapse) || dockOutCollapsingToCapsule;
  const dockLayout = surfaceMode === "drawer" && dockTransitionPhase !== "dock-out" ? "inline" : "overlay";
  const renderDrawerContent = surfaceMode === "drawer" && dockTransitionPhase !== "dock-out";
  const bottomSessionTitleVisible = sessionTitleVisible && !renderDrawerContent && dockTransitionPhase !== "dock-in";
  const applyDrawerInlineWidth = useCallback((width: number) => {
    const nextWidth = clampWorkbenchAssistantDrawerWidth(width);
    const nextInlineWidth = resolveWorkbenchAssistantDockInlineWidth(
      nextWidth,
      typeof window === "undefined" ? 1280 : window.innerWidth,
    );
    const surface = surfaceRef.current;
    surface?.style.setProperty("--workbench-assistant-dock-width", `${nextWidth}px`);
    surface?.style.setProperty("--workbench-assistant-dock-inline-size", `${nextInlineWidth}px`);
  }, []);
  const previewDrawerWidth = useCallback(
    (width: number) => {
      applyDrawerInlineWidth(width);
      if (onDrawerWidthPreview) {
        onDrawerWidthPreview(width);
      } else {
        setUncontrolledDrawerWidthPreview(width);
        onDockTransitionLayoutChange?.({
          phase: "resize",
          reservedWidth: resolveWorkbenchAssistantDockInlineWidth(
            width,
            typeof window === "undefined" ? 1280 : window.innerWidth,
          ),
        });
      }
    },
    [applyDrawerInlineWidth, onDockTransitionLayoutChange, onDrawerWidthPreview],
  );
  const commitDrawerWidth = useCallback(
    (width: number) => {
      applyDrawerInlineWidth(width);
      if (onDrawerWidthCommit) {
        onDrawerWidthCommit(width);
      } else {
        setUncontrolledDrawerWidthPreview(null);
        layout.actions.setWorkbenchAssistantDrawerWidth(width);
      }
      if (renderDrawerContent) {
        onDockTransitionLayoutChange?.({
          phase: "idle",
          reservedWidth: resolveWorkbenchAssistantDockInlineWidth(
            width,
            typeof window === "undefined" ? 1280 : window.innerWidth,
          ),
        });
      }
    },
    [applyDrawerInlineWidth, layout.actions, onDockTransitionLayoutChange, onDrawerWidthCommit, renderDrawerContent],
  );
  const drawerResize = useRafPanelResize({
    disabled: !renderDrawerContent,
    width: drawerWidth,
    getWidth: (startWidth, startX, clientX) => clampWorkbenchAssistantDrawerWidth(startWidth + startX - clientX),
    onPreview: previewDrawerWidth,
    onCommit: commitDrawerWidth,
    previewMode: onDrawerWidthPreview ? "sync" : "raf",
  });
  const drawerA2UIRenderSuspended = useHeldActiveFlag(drawerResize.dragging, 180);
  const resetDrawerWidth = () => {
    if (!renderDrawerContent) {
      return;
    }
    drawerResize.finishDrag();
    commitDrawerWidth(DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH);
  };
  const renderMorphContent = dockTransitionPhase !== null;
  const renderBottomContent = !reviewActive;
  const reducedMotion = prefersReducedMotion();
  const drawerDockActionActive = renderDrawerContent || dockTransitionPhase === "dock-out";
  const headerActionsDisabled = dockTransitionPhase !== null;
  const hideMessageTriggerInHeader = renderDrawerContent || dockTransitionPhase === "dock-in";
  const assistantMotionTransition =
    dockTransitionPhase === "dock-out"
      ? WORKBENCH_ASSISTANT_DOCK_OUT_MOTION_TRANSITION
      : WORKBENCH_ASSISTANT_MOTION_TRANSITION;
  const visualComposeOpen = composeOpen || dockOutCollapsingToCapsule;
  const enableDockChildLayout = !reducedMotion && dockTransitionPhase === null && !drawerResize.dragging;
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

  const updateExpandedBottomGap = useCallback(() => {
    const chrome = assistantChromeRef.current;
    if (!chrome || typeof window === "undefined") {
      return;
    }
    const chromeHeight = chrome.getBoundingClientRect().height;
    const maxGap = Math.max(96, window.innerHeight - 180);
    const nextGap = Math.round(Math.min(Math.max(96, chromeHeight + 24), maxGap));
    setExpandedBottomGap((current) => (current === nextGap ? current : nextGap));
  }, []);

  useLayoutEffect(() => {
    updateExpandedBottomGap();
    const chrome = assistantChromeRef.current;
    if (!chrome || typeof window === "undefined") {
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateExpandedBottomGap);
      return () => window.removeEventListener("resize", updateExpandedBottomGap);
    }
    const observer = new ResizeObserver(updateExpandedBottomGap);
    observer.observe(chrome);
    window.addEventListener("resize", updateExpandedBottomGap);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateExpandedBottomGap);
    };
  }, [updateExpandedBottomGap]);

  const latestAssistantMessage = useMemo(() => latestAssistantMessageFrom(controller.agentMessages), [controller.agentMessages]);
  const latestAssistantMessageKey = latestAssistantMessage
    ? `${latestAssistantMessage.id}:${latestAssistantMessage.content.length}:${latestAssistantMessage.status ?? ""}`
    : null;
  const runningMessageTriggerPreview = useMemo(
    () => runningMessageTriggerPreviewFrom(controller.agentMessages),
    [controller.agentMessages],
  );
  const rawMessageTriggerState: MessageTriggerState =
    pendingApproval || runtimeState === "waiting_approval"
      ? "approval"
      : runtimeState === "running"
      ? "streaming"
      : runtimeState === "failed"
        ? "failed"
        : unreadAssistantMessageKey
          ? "completed"
          : "idle";
  const messageTriggerState: MessageTriggerState =
    messageTriggerPriming &&
    rawMessageTriggerState !== "completed" &&
    rawMessageTriggerState !== "failed" &&
    rawMessageTriggerState !== "approval"
      ? "priming"
      : rawMessageTriggerState;
  const visibleMessageTriggerPreview = useMessageCarrierDisplayPreview(
    messageTriggerState,
    runningMessageTriggerPreview,
    reducedMotion,
  );
  const messageTriggerText =
    messageTriggerState === "streaming" || messageTriggerState === "priming"
      ? visibleMessageTriggerPreview?.text ?? MESSAGE_CARRIER_PENDING_TEXT
      : messageTriggerState === "completed"
        ? "回复已完成，点击查看"
        : messageTriggerState === "failed"
          ? "回复失败，点击查看"
          : messageTriggerState === "approval"
            ? "等待审批，点击处理"
            : "";
  const messageTriggerFileDeltas =
    messageTriggerState === "streaming" && visibleMessageTriggerPreview?.kind === "file-change"
      ? {
          added: visibleMessageTriggerPreview.addedLines,
          removed: visibleMessageTriggerPreview.removedLines,
        }
      : null;
  const messageTriggerTextTypewriter =
    messageTriggerState === "streaming" &&
    visibleMessageTriggerPreview?.kind === "assistant" &&
    messageTriggerText !== MESSAGE_CARRIER_PENDING_TEXT &&
    !reducedMotion;
  const messageTriggerLive =
    bottomSurfaceMode === "capsule" &&
    dockTransitionPhase === null &&
    !renderDrawerContent &&
    !renderMorphContent &&
    messageTriggerState !== "idle";
  const messageTriggerLayoutState: MessageTriggerState = messageTriggerLive ? messageTriggerState : "idle";
  const messageCarrierVisible = messageTriggerLayoutState !== "idle";
  const messageButtonVisible = !hideMessageTriggerInHeader && !messageCarrierVisible;
  const turnNavigationItems = useMemo(
    () => buildTurnNavigationItemsFromMessages(displayPanelModel.messages),
    [displayPanelModel.messages],
  );
  const showMiniTurnNavigator =
    surfaceMode !== "expanded" &&
    !renderDrawerContent &&
    (dockTransitionPhase === null || dockTransitionPhase === "dock-out") &&
    turnNavigationItems.length >= 2;

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

  const clearDrawerContentTimer = useCallback(() => {
    if (drawerContentTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(drawerContentTimerRef.current);
    }
    drawerContentTimerRef.current = null;
  }, []);

  const clearExpandedContentTimer = useCallback(() => {
    if (expandedContentTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(expandedContentTimerRef.current);
    }
    expandedContentTimerRef.current = null;
  }, []);

  const finishMessageTriggerPriming = useCallback(() => {
    if (messageTriggerPrimingTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(messageTriggerPrimingTimerRef.current);
    }
    messageTriggerPrimingTimerRef.current = null;
    setMessageTriggerPriming(false);
  }, []);

  const beginMessageTriggerPriming = useCallback(() => {
    if (reducedMotion) {
      finishMessageTriggerPriming();
      return;
    }
    setMessageTriggerPriming(true);
    if (messageTriggerPrimingTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(messageTriggerPrimingTimerRef.current);
    }
    if (typeof window === "undefined") {
      finishMessageTriggerPriming();
      return;
    }
    messageTriggerPrimingTimerRef.current = window.setTimeout(
      finishMessageTriggerPriming,
      MESSAGE_TRIGGER_PRIMING_DURATION_MS,
    );
  }, [finishMessageTriggerPriming, reducedMotion]);

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
    finishMessageTriggerPriming();
    setDockReturnMode(null);
    setUnreadAssistantMessageKey(null);
    previousRuntimeStateRef.current = runtimeState;
    dispatchAssistantState({ type: "workspace-reset" });
    setComposerFiles([]);
    setComposerQuotes([]);
    setGoalComposerOpen(false);
    setGoalCreating(false);
    setGoalError(null);
    handledFileChipRequestIdRef.current = controller.fileChipRequest?.requestId ?? 0;
    handledQuoteChipRequestIdRef.current = controller.quoteChipRequest?.requestId ?? 0;
  }, [finishDockTransition, finishMessageTriggerPriming, workspaceId]);

  useEffect(() => {
    finishMessageTriggerPriming();
    setUnreadAssistantMessageKey(null);
    previousRuntimeStateRef.current = runtimeState;
    setComposerFiles([]);
    setComposerQuotes([]);
    setGoalComposerOpen(false);
    setGoalCreating(false);
    setGoalError(null);
    handledFileChipRequestIdRef.current = controller.fileChipRequest?.requestId ?? 0;
    handledQuoteChipRequestIdRef.current = controller.quoteChipRequest?.requestId ?? 0;
  }, [finishMessageTriggerPriming, panelSessionId]);

  useEffect(() => {
    const previousRuntimeState = previousRuntimeStateRef.current;
    if (runtimeState === "running") {
      setUnreadAssistantMessageKey(null);
    } else if (previousRuntimeState === "running" && latestAssistantMessageKey) {
      setUnreadAssistantMessageKey(
        surfaceMode === "drawer" || surfaceMode === "expanded" ? null : latestAssistantMessageKey,
      );
    }
    previousRuntimeStateRef.current = runtimeState;
  }, [latestAssistantMessageKey, runtimeState, surfaceMode]);

  useEffect(() => {
    if (surfaceMode === "drawer" || surfaceMode === "expanded") {
      setUnreadAssistantMessageKey(null);
    }
  }, [surfaceMode]);

  useEffect(() => () => finishDockTransition(), [finishDockTransition]);

  useEffect(() => () => finishComposeCollapse(), [finishComposeCollapse]);

  useEffect(() => () => clearDrawerContentTimer(), [clearDrawerContentTimer]);

  useEffect(() => () => clearExpandedContentTimer(), [clearExpandedContentTimer]);

  useEffect(() => () => finishMessageTriggerPriming(), [finishMessageTriggerPriming]);

  useEffect(() => {
    clearDrawerContentTimer();
    if (surfaceMode !== "drawer" || dockTransitionPhase !== null) {
      setDrawerContentReady(false);
      return;
    }
    if (panelMessageCountRef.current <= 0 || reducedMotion || typeof window === "undefined") {
      setDrawerContentReady(true);
      return;
    }
    setDrawerContentReady(false);
    drawerContentTimerRef.current = window.setTimeout(() => {
      drawerContentTimerRef.current = null;
      setDrawerContentReady(true);
    }, WORKBENCH_EXPANDED_CONTENT_REVEAL_DELAY_MS);
  }, [clearDrawerContentTimer, dockTransitionPhase, panelSessionId, reducedMotion, surfaceMode]);

  useEffect(() => {
    clearExpandedContentTimer();
    if (surfaceMode !== "expanded" || dockTransitionPhase !== null) {
      setExpandedContentReady(false);
      return;
    }
    if (panelMessageCountRef.current <= 0 || reducedMotion || typeof window === "undefined") {
      setExpandedContentReady(true);
      return;
    }
    setExpandedContentReady(false);
    expandedContentTimerRef.current = window.setTimeout(() => {
      expandedContentTimerRef.current = null;
      setExpandedContentReady(true);
    }, WORKBENCH_EXPANDED_CONTENT_REVEAL_DELAY_MS);
  }, [clearExpandedContentTimer, dockTransitionPhase, panelSessionId, reducedMotion, surfaceMode]);

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
    dispatchAssistantState({ type: "draft-changed", hasDraft: hasComposerContent });
  }, [hasComposerContent]);

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
    if (surfaceMode !== "composer" || hasComposerContent) {
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
  }, [beginComposeCollapse, hasComposerContent, surfaceMode]);

  useEffect(() => {
    if (
      workspaceSkillsState.status === "ready" &&
      controller.selectedSkill &&
      !workspaceSkills.some(
        (skill) => skill.name === controller.selectedSkill?.name && skill.source === controller.selectedSkill?.source,
      )
    ) {
      controller.setSelectedSkill(null);
    }
  }, [controller, workspaceSkills, workspaceSkillsState.status]);

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

  const collapseBottomComposerToCapsule = useCallback(() => {
    beginComposeCollapse();
    dispatchAssistantState({ type: "workspace-reset" });
  }, [beginComposeCollapse]);

  const handleComposerChange = useCallback(
    (value: string) => {
      controller.setDraft(value);
      if (goalError) {
        setGoalError(null);
      }
    },
    [controller, goalError],
  );

  const closeGoalComposer = useCallback(() => {
    if (goalCreating) {
      return;
    }
    setGoalComposerOpen(false);
    setGoalError(null);
  }, [goalCreating]);

  const ensureGoalSession = useCallback(
    async (objective: string, contextItems: AgentContextItem[]) => {
      if (panelSessionId) {
        return panelSessionId;
      }
      if (!onEnsureSession) {
        return null;
      }
      const ensured = await onEnsureSession({
        title: sessionTitleFromPreparedMessage(objective, contextItems),
        message: objective,
        contextItems,
        model: selectedModel,
      });
      if (!ensured) {
        return null;
      }
      if (typeof ensured === "string") {
        return ensured.trim() || null;
      }
      controller.dispatch({ type: "session/upsert", session: ensured });
      return ensured.id?.trim() || null;
    },
    [controller, onEnsureSession, panelSessionId, selectedModel],
  );

  const createGoalTask = useCallback(
    async (
      files: SelectedFile[] = [],
      quotes: SelectedQuote[] = [],
      imageAttachments: SelectedImageAttachment[] = [],
    ) => {
      const prepared = prepareComposerMessage(controller.draft, files, {
        quotes,
        selectedSkill: controller.selectedSkill,
      });
      const attachments = imageAttachments.map(agentAttachmentFromSelected);
      const objective = prepared.message;
      if (!objective) {
        setGoalError("目标不能为空");
        return false;
      }
      if (secondaryPageActive) {
        setGoalError("当前工作台面板无法创建目标");
        return false;
      }
      if (controller.activeTask) {
        setGoalError("当前已有进行中的目标");
        return false;
      }
      setGoalCreating(true);
      setGoalError(null);
      try {
        const targetSessionId = await ensureGoalSession(objective, prepared.contextItems);
        if (!targetSessionId) {
          setGoalError("当前会话无法创建目标");
          return false;
        }
        const task = await runtime.conversation.createThreadTask(targetSessionId, {
          type: "goal",
          objective,
          metadata: goalSeedContextMetadata({
            message: prepared.message,
            contextItems: prepared.contextItems,
            runtimeParams: prepared.runtimeParams,
            attachments,
          }),
        });
        const goalItem = goalContextItem(objective);
        const runtimeParams = runtimeParamsWithInitialGoalTask(
          runtimeParamsWithGoalContextItem(prepared.runtimeParams, goalItem),
          task,
        );
        controller.dispatch({
          type: "event/receive",
          event: {
            action: "task_updated",
            data: {
              session_id: targetSessionId,
              task_id: task.id,
              task,
            },
          },
        });
        const sent = await controller.sendText(prepared.message, selectedModel, {
          clearDraft: true,
          contextItems: [...prepared.contextItems, goalItem],
          runtimeParams,
          attachments,
          targetSessionId,
        });
        if (!sent) {
          await runtime.conversation.deleteThreadTask(targetSessionId, task.id).catch(() => null);
          controller.dispatch({
            type: "event/receive",
            event: {
              action: "task_deleted",
              data: {
                session_id: targetSessionId,
                task_id: task.id,
                task,
              },
            },
          });
          setGoalError("目标消息发送失败，请处理发送问题后重试");
          return false;
        }
        setGoalComposerOpen(false);
        controller.setSelectedSkill(null);
        notifications.success("目标已创建");
        return true;
      } catch (reason) {
        if (isTaskAlreadyOpenError(reason)) {
          const targetSessionId = panelSessionId || "";
          if (targetSessionId) {
            try {
              const tasks = await runtime.conversation.listThreadTasks(targetSessionId);
              controller.dispatch({ type: "tasks/loaded", sessionId: targetSessionId, tasks });
            } catch {
              // Keep the direct create error visible when task refresh also fails.
            }
          }
          setGoalError("当前已有进行中的目标");
          return false;
        }
        setGoalError(errorMessage(reason));
        return false;
      } finally {
        setGoalCreating(false);
      }
    },
    [
      controller,
      ensureGoalSession,
      notifications,
      panelSessionId,
      runtime,
      secondaryPageActive,
      selectedModel,
    ],
  );

  const send = useCallback(
    (
      files: SelectedFile[] = [],
      quotes: SelectedQuote[] = [],
      attachments: SelectedImageAttachment[] = [],
    ) => {
      const result = goalComposerOpen
        ? createGoalTask(files, quotes, attachments)
        : controller.send(files, quotes, attachments, selectedModel);
      void Promise.resolve(result).then((sent) => {
        if (sent === false || surfaceMode !== "composer") {
          return;
        }
        beginMessageTriggerPriming();
        collapseBottomComposerToCapsule();
      });
      return result;
    },
    [
      beginMessageTriggerPriming,
      collapseBottomComposerToCapsule,
      controller,
      createGoalTask,
      goalComposerOpen,
      selectedModel,
      surfaceMode,
    ],
  );

  const openComposer = useCallback(() => {
    dispatchAssistantState({ type: "open-composer" });
  }, []);

  useEffect(() => {
    if (surfaceMode === "drawer" || dockTransitionPhase !== null) {
      return;
    }
    const focusComposerOnPageEnter = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Enter" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        shouldIgnoreWorkbenchPageEnter(event.target)
      ) {
        return;
      }
      event.preventDefault();
      openComposer();
    };
    document.addEventListener("keydown", focusComposerOnPageEnter);
    return () => document.removeEventListener("keydown", focusComposerOnPageEnter);
  }, [dockTransitionPhase, openComposer, surfaceMode]);

  const closeDrawer = useCallback(() => {
    if (btwActive) {
      onCloseBtwConversation?.();
    }
    if (reviewActive) {
      setWorkbenchReviewPanel(null);
    }
    const hasDraft = !btwActive && hasComposerContent;
    setDockReturnMode(hasDraft ? "composer" : "capsule");
    beginDockTransition("dock-out", () => {
      dispatchAssistantState({ type: "close-drawer", hasDraft });
      setDockReturnMode(null);
    });
  }, [beginDockTransition, btwActive, hasComposerContent, onCloseBtwConversation, reviewActive]);

  const collapseDrawerToCapsule = useCallback(() => {
    if (btwActive) {
      onCloseBtwConversation?.();
    }
    if (reviewActive) {
      setWorkbenchReviewPanel(null);
    }
    setDockReturnMode("capsule");
    beginDockTransition("dock-out", () => {
      dispatchAssistantState({ type: "close-drawer", hasDraft: false });
      setDockReturnMode(null);
    });
  }, [beginDockTransition, btwActive, onCloseBtwConversation, reviewActive]);

  const handleComposerEscape = useCallback(() => {
    if (surfaceMode === "drawer") {
      return;
    }
    collapseBottomComposerToCapsule();
  }, [collapseBottomComposerToCapsule, surfaceMode]);

  const dockToDrawer = useCallback(() => {
    finishMessageTriggerPriming();
    setUnreadAssistantMessageKey(null);
    setDockReturnMode(null);
    beginDockTransition("dock-in", () => {
      dispatchAssistantState({ type: "dock-to-drawer" });
    });
  }, [beginDockTransition, finishMessageTriggerPriming]);

  const openBtwConversation = useCallback(() => {
    if (!onOpenBtwConversation || btwActive) {
      return;
    }
    void Promise.resolve(onOpenBtwConversation()).then((session) => {
      if (!session || surfaceMode === "drawer" || surfaceMode === "expanded") {
        return;
      }
      dockToDrawer();
    });
  }, [btwActive, dockToDrawer, onOpenBtwConversation, surfaceMode]);

  const closeWorkbenchReviewPanel = useCallback(() => {
    setWorkbenchReviewPanel(null);
  }, []);

  const openWorkbenchReviewFile = useCallback(
    (path: string) => {
      previewContext.openFilePanel(path, workbenchPreviewRenderContext);
    },
    [previewContext, workbenchPreviewRenderContext],
  );

  useEffect(() => {
    handledReviewPanelRequestIdRef.current = previewContext.reviewPanelRequest?.requestId ?? 0;
    setWorkbenchReviewPanel(null);
  }, [panelSessionId, workspaceId]);

  useEffect(() => {
    const request = previewContext.reviewPanelRequest ?? null;
    if (
      !request?.requestId ||
      request.requestId === handledReviewPanelRequestIdRef.current ||
      !reviewPanelRequestMatchesWorkbench(request, panelSessionId, workspaceId)
    ) {
      return;
    }
    handledReviewPanelRequestIdRef.current = request.requestId;
    setWorkbenchReviewPanel(request);
    if (surfaceMode !== "drawer") {
      dockToDrawer();
    }
  }, [dockToDrawer, panelSessionId, previewContext.reviewPanelRequest, surfaceMode, workspaceId]);

  const runContextCompression = useCallback(
    async () => {
      if (contextCompressionRunning) {
        notifications.warning("上下文压缩正在执行");
        return;
      }
      if (!panelSessionId || secondaryPageActive) {
        notifications.warning("当前会话无法压缩上下文");
        return;
      }
      if (!backendReady) {
        notifications.warning("本地服务尚未就绪");
        return;
      }
      setContextCompressionRunning(true);
      try {
        await runtime.conversation.compressContext(panelSessionId);
        notifications.success("上下文压缩已完成");
        void controller.reloadHistory().catch(() => undefined);
      } catch (reason) {
        notifications.error(contextCompressionErrorMessage(reason));
      } finally {
        setContextCompressionRunning(false);
      }
    },
    [
      backendReady,
      contextCompressionRunning,
      controller,
      notifications,
      panelSessionId,
      runtime,
      secondaryPageActive,
    ],
  );

  const handleSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.id === "bypass-conversation") {
        openBtwConversation();
        return;
      }
      if (isContextCompressionSlashCommand(command)) {
        void runContextCompression();
        return;
      }
      if (command.id === "goal") {
        if (secondaryPageActive) {
          return;
        }
        if (controller.activeTask) {
          notifications.warning("当前已有进行中的目标");
          return;
        }
        setGoalComposerOpen(true);
        setGoalError(null);
        dispatchAssistantState({ type: "open-composer" });
      }
    },
    [
      controller.activeTask,
      notifications,
      openBtwConversation,
      runContextCompression,
      secondaryPageActive,
    ],
  );

  const toggleExpandedLayer = useCallback(() => {
    finishMessageTriggerPriming();
    setUnreadAssistantMessageKey(null);
    if (surfaceMode === "expanded") {
      if (btwActive) {
        onCloseBtwConversation?.();
      }
      if (reviewActive) {
        setWorkbenchReviewPanel(null);
      }
      dispatchAssistantState({ type: "close-expanded", returnMode: "composer" });
      return;
    }
    dispatchAssistantState({ type: "toggle-expanded", hasDraft: hasComposerContent });
  }, [
    btwActive,
    finishMessageTriggerPriming,
    hasComposerContent,
    onCloseBtwConversation,
    reviewActive,
    surfaceMode,
  ]);

  const openExpandedLayerAtTurn = useCallback(
    (targetIndex: number) => {
      finishMessageTriggerPriming();
      setUnreadAssistantMessageKey(null);
      setOverlayTurnNavigationRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        targetIndex,
      }));
      if (surfaceMode !== "expanded") {
        dispatchAssistantState({ type: "toggle-expanded", hasDraft: hasComposerContent });
      }
    },
    [finishMessageTriggerPriming, hasComposerContent, surfaceMode],
  );

  const requestNewSessionFromCapsule = useCallback(() => {
    void onRequestNewSession?.();
  }, [onRequestNewSession]);

  const closeExpandedLayer = useCallback(() => {
    if (surfaceMode !== "expanded") {
      return;
    }
    if (btwActive) {
      onCloseBtwConversation?.();
    }
    if (reviewActive) {
      setWorkbenchReviewPanel(null);
    }
    dispatchAssistantState({
      type: "close-expanded",
      returnMode: secondaryPageActive || hasComposerContent ? "composer" : "capsule",
    });
  }, [btwActive, hasComposerContent, onCloseBtwConversation, reviewActive, secondaryPageActive, surfaceMode]);

  const markComposerFileRequestHandled = useCallback((requestId: number) => {
    contextRequestBaselineRef.current.fileRequestId = Math.max(
      contextRequestBaselineRef.current.fileRequestId,
      requestId,
    );
  }, []);

  const markComposerQuoteRequestHandled = useCallback((requestId: number) => {
    contextRequestBaselineRef.current.quoteRequestId = Math.max(
      contextRequestBaselineRef.current.quoteRequestId,
      requestId,
    );
  }, []);

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

  const goalModeAccessory = useMemo(() => {
    if (!goalComposerOpen || secondaryPageActive) {
      return null;
    }
    return <GoalModeAccessory creating={goalCreating} error={goalError} onClose={closeGoalComposer} />;
  }, [closeGoalComposer, goalComposerOpen, goalCreating, goalError, secondaryPageActive]);

  const composer = (
    <WorkbenchComposer
      key={panelSessionId || "empty-session"}
      value={controller.draft}
      runtimeState={creatingSession ? "starting" : runtimeState}
      canSend={
        contextCompressionRunning
          ? false
          : goalComposerOpen
            ? Boolean(controller.draft.trim()) && !goalCreating && !secondaryPageActive && Boolean(panelSessionId || onEnsureSession)
          : canSend
      }
      canStop={canStop}
      connectionReady={connectionReady}
      modelSelection={{ ...modelSelection, setSelectedModel: changeModel }}
      workspaceSkills={workspaceSkills}
      selectedFiles={composerFiles}
      selectedQuotes={composerQuotes}
      selectedSkill={controller.selectedSkill}
      runtime={runtime}
      sessionId={panelSessionId}
      pendingApproval={pendingApproval}
      fileAccessMode={fileAccessMode}
      workspaceRoots={workspaceRootsForWorkbench(workspace)}
      allowPersistentTrust={allowPersistentTrust}
      approvalSubmitting={controller.approvalSubmitting}
      approvalError={controller.approvalError}
      fileChipRequest={composerFileChipRequest}
      quoteChipRequest={composerQuoteChipRequest}
      contextWindowUsage={displayPanelModel.contextWindowUsage}
      allowBypassConversationSlashCommand={!secondaryPageActive && Boolean(onOpenBtwConversation)}
      allowGoalSlashCommand={!secondaryPageActive}
      allowContextCompressionSlashCommand={!secondaryPageActive && Boolean(panelSessionId)}
      autoFocusKey={
        surfaceMode === "capsule"
          ? undefined
          : `workbench-composer:${composerFocusSeq}:${secondaryPageActive ? `secondary:${currentSessionTitle}` : "main"}`
      }
      onSelectedFilesChange={setComposerFiles}
      onSelectedQuotesChange={setComposerQuotes}
      onChange={handleComposerChange}
      onSkillChange={controller.setSelectedSkill}
      onSubmitApproval={controller.submitApproval}
      onSend={send}
      onStop={controller.stop}
      onEscape={handleComposerEscape}
      onSearchWorkspace={searchWorkspace}
      onListWorkspaceDirectory={listWorkspaceDirectory}
      onOpenFileReference={openWorkbenchFileReference}
      onSlashCommand={handleSlashCommand}
      onRefreshWorkspaceSkills={() => refreshWorkspaceSkills({ forceReload: true })}
      onExternalFileRequestHandled={markComposerFileRequestHandled}
      onExternalQuoteRequestHandled={markComposerQuoteRequestHandled}
      leftAccessory={goalModeAccessory}
      placeholder={goalComposerOpen ? "Keydex 应继续朝哪个目标努力？" : undefined}
    />
  );

  const accessory = (
    <ConversationPanelComposerAccessory
      model={displayPanelModel}
      runtime={runtime}
      showScrollButton={false}
      onOpenMcpSettings={onOpenMcpSettings}
    />
  );

  const hasCodeBlockMessages = useMemo(
    () => displayPanelModel.messages.some((message) => valueContainsMarkdownCodeFence(message)),
    [displayPanelModel.messages],
  );
  useEffect(() => {
    if (!hasCodeBlockMessages) {
      return;
    }
    void preloadMarkdownCodeBlockRuntime().catch(() => undefined);
  }, [hasCodeBlockMessages]);

  const stablePanelMode = renderDrawerContent ? "drawer" : renderMorphContent ? "morph" : "prewarm";
  const shouldMountStablePanel = surfaceMode !== "expanded" && (renderMorphContent || renderDrawerContent);
  const stablePanelContentReady = stablePanelMode === "drawer" && (drawerContentReady || panelMessageCount <= 0);
  const stableReviewPanel =
    shouldMountStablePanel && stablePanelContentReady && workbenchReviewPanel ? (
      <div className={styles.drawerReviewPanel} data-testid="workbench-review-panel">
        <FileReviewPanel
          files={workbenchReviewPanel.files}
          focusedPath={workbenchReviewPanel.focusedPath}
          title={workbenchReviewPanel.title}
          onFocusPath={() => undefined}
          onOpenFile={openWorkbenchReviewFile}
        />
      </div>
    ) : null;
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
  const stableConversationPanel = shouldMountStablePanel && stablePanelContentReady ? (
    <ConversationPanel
      model={displayPanelModel}
      workspaceRuntime={runtime}
      variant="compact"
      emptyText={btwActive ? "旁路对话暂无消息" : "当前工作空间还没有助手消息。"}
      emptyTestId={`workbench-${stablePanelMode === "drawer" ? "drawer" : "morph"}-message-empty`}
      scrollButtonMode="external"
      turnNavigatorMode="auto"
      topNotice={btwHistoryNotice}
      showForkSourceMarkers={!btwActive}
      showForkActions={!btwActive}
      a2uiRenderSuspended={drawerA2UIRenderSuspended}
      className={styles.drawerPanel}
    />
  ) : null;
  const drawerLoadingPanel =
    shouldMountStablePanel && stablePanelMode === "drawer" && !stablePanelContentReady ? (
      <LoadingSkeleton
        aria-label="正在准备侧栏消息历史"
        className={styles.panelLoading}
        lineCount={4}
        testId="workbench-drawer-panel-loading"
        width="compact"
      />
    ) : null;
  const overlayPanelContentReady =
    surfaceMode === "expanded" && dockTransitionPhase === null && (expandedContentReady || panelMessageCount <= 0);
  const overlayReviewPanel =
    overlayPanelContentReady && workbenchReviewPanel ? (
      <div className={styles.overlayReviewPanel} data-testid="workbench-review-panel">
        <FileReviewPanel
          files={workbenchReviewPanel.files}
          focusedPath={workbenchReviewPanel.focusedPath}
          title={workbenchReviewPanel.title}
          onFocusPath={() => undefined}
          onOpenFile={openWorkbenchReviewFile}
        />
      </div>
    ) : null;
  const overlayConversationPanel =
    overlayPanelContentReady ? (
      <ConversationPanel
        model={displayPanelModel}
        workspaceRuntime={runtime}
        variant="overlay"
        emptyLayout="center"
        emptyText={btwActive ? "旁路对话暂无消息" : "当前工作空间还没有助手消息。"}
        emptyTestId="workbench-expanded-message-empty"
        scrollButtonMode="external"
        turnNavigatorMode="auto"
        turnNavigationRequest={overlayTurnNavigationRequest}
        topNotice={btwHistoryNotice}
        showForkSourceMarkers={!btwActive}
        showForkActions={!btwActive}
        className={styles.overlayPanel}
      />
    ) : null;
  const overlayLoadingPanel =
    surfaceMode === "expanded" && dockTransitionPhase === null && !overlayPanelContentReady ? (
      <LoadingSkeleton
        aria-label="正在准备消息历史"
        className={styles.panelLoading}
        lineCount={4}
        testId="workbench-expanded-panel-loading"
        width="compact"
      />
    ) : null;
  const drawerResizeHandle = (
    <div
      className={styles.drawerResizeHandle}
      role="separator"
      aria-label="调整工作台助手侧栏宽度"
      aria-orientation="vertical"
      data-visible={stablePanelMode === "drawer" ? "true" : "false"}
      data-dragging={drawerResize.dragging ? "true" : "false"}
      data-testid="workbench-assistant-drawer-resize-handle"
      tabIndex={stablePanelMode === "drawer" ? 0 : -1}
      title="拖动调整宽度，双击恢复默认宽度"
      onDoubleClick={resetDrawerWidth}
      onPointerDown={(event) => {
        if (event.button > 0) {
          return;
        }
        drawerResize.startDrag(event);
      }}
    />
  );
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
        {secondaryPageActive ? (
          <button
            type="button"
            className={styles.btwBackButton}
            aria-label="返回主对话"
            onClick={btwActive ? onCloseBtwConversation : closeWorkbenchReviewPanel}
          >
            <ArrowLeft size={14} />
            <span>主对话</span>
          </button>
        ) : null}
        <div className={styles.drawerTitle}>
          <span title={currentSessionTitle || undefined}>{currentSessionTitle || "助手"}</span>
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
        data-content-state={stablePanelContentReady ? "ready" : "deferred"}
        data-testid={stablePanelMode === "morph" ? "workbench-assistant-morph-middle" : undefined}
      >
        {stableReviewPanel ?? stableConversationPanel ?? drawerLoadingPanel}
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
      data-drawer-resizing={drawerResize.dragging ? "true" : "false"}
      data-btw-active={btwActive ? "true" : "false"}
      data-review-active={reviewActive ? "true" : "false"}
      data-message-trigger-state={messageTriggerLayoutState}
      data-session-title-visible={bottomSessionTitleVisible ? "true" : "false"}
      data-running={runtimeState === "running" ? "true" : "false"}
      data-pending-approval={pendingApproval ? "true" : "false"}
      style={
        {
          ...geometryVars,
          "--workbench-assistant-dock-width": `${drawerWidth}px`,
          "--workbench-assistant-dock-inline-size": `${dockInlineWidth}px`,
          "--workbench-assistant-expanded-bottom-gap": `${expandedBottomGap}px`,
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
              data-btw-active={btwActive ? "true" : "false"}
              data-review-active={reviewActive ? "true" : "false"}
              data-testid="workbench-expanded-panel-frame"
              initial={{ opacity: 0, y: 16, clipPath: "inset(100% 0 0 0 round 18px)" }}
              animate={{ opacity: 1, y: 0, clipPath: "inset(0% 0 0 0 round 18px)" }}
              exit={{ opacity: 1, y: 18, clipPath: "inset(100% 0 0 0 round 18px)" }}
              transition={reducedMotion ? { duration: 0 } : WORKBENCH_EXPANDED_PANEL_TRANSITION}
              onClick={(event) => event.stopPropagation()}
            >
              {secondaryPageActive ? (
                <div className={styles.btwOverlayHeader} data-testid="workbench-btw-overlay-header">
                  <button
                    type="button"
                    className={styles.btwBackButton}
                    onClick={btwActive ? onCloseBtwConversation : closeWorkbenchReviewPanel}
                    aria-label="返回主对话"
                  >
                    <ArrowLeft size={14} />
                    <span>主对话</span>
                  </button>
                  <span>{currentSessionTitle}</span>
                </div>
              ) : null}
              {overlayReviewPanel ?? overlayConversationPanel ?? overlayLoadingPanel}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <WorkbenchAssistantShell
        mode={visualSurfaceMode}
        geometryMode={geometryMode}
        dockOutTargetMode={dockOutTargetMode}
        dockLayout={dockLayout}
        chromeRef={assistantChromeRef}
        transitionPhase={dockTransitionPhase ?? "idle"}
        reducedMotion={reducedMotion}
        resizing={drawerResize.dragging}
      >
        {drawerResizeHandle}
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
              data-message-trigger-state={messageTriggerLayoutState}
              data-message-trigger-visible={messageButtonVisible ? "true" : "false"}
              data-mini-navigator-visible={showMiniTurnNavigator ? "true" : "false"}
              data-new-session-enabled={onRequestNewSession ? "true" : "false"}
              data-pending-approval={pendingApproval ? "true" : "false"}
              data-session-title-visible={bottomSessionTitleVisible ? "true" : "false"}
              data-testid={renderDrawerContent ? "workbench-assistant-drawer-composer-frame" : "workbench-assistant-composer-frame"}
            >
              <div className={styles.composerFrameHeader}>
                <div
                  className={styles.composerFrameTitle}
                  data-empty={bottomSessionTitleVisible ? "false" : "true"}
                  data-testid="workbench-assistant-session-title"
                  title={bottomSessionTitleVisible ? currentSessionTitle : undefined}
                >
                  {bottomSessionTitleVisible ? currentSessionTitle : ""}
                </div>
                <motion.div
                  className={styles.composerFrameAccessory}
                >
                  {accessory}
                </motion.div>
                {onRequestNewSession ? (
                  <motion.button
                    className={styles.newSessionButton}
                    type="button"
                    aria-label="新会话"
                    title="新会话"
                    disabled={creatingSession}
                    onClick={requestNewSessionFromCapsule}
                  >
                    <SquarePen size={14} />
                  </motion.button>
                ) : null}
                {messageButtonVisible ? (
                  <WorkbenchMessageButton
                    expanded={surfaceMode === "expanded"}
                    disabled={headerActionsDisabled}
                    onClick={toggleExpandedLayer}
                  />
                ) : null}
                {messageCarrierVisible ? (
                  <WorkbenchMessageCarrier
                    expanded={surfaceMode === "expanded"}
                    disabled={headerActionsDisabled}
                    fileDeltas={messageTriggerFileDeltas}
                    state={messageTriggerLayoutState}
                    text={messageTriggerText}
                    typewriter={messageTriggerTextTypewriter}
                    onClick={toggleExpandedLayer}
                  />
                ) : null}
                <motion.button
                  className={styles.dockHandle}
                  type="button"
                  aria-label={drawerDockActionActive ? "收回工作台助手为胶囊" : "将工作台助手展开到右侧"}
                  title={drawerDockActionActive ? "收回胶囊" : "展开到右侧"}
                  disabled={headerActionsDisabled}
                  onClick={drawerDockActionActive ? collapseDrawerToCapsule : dockToDrawer}
                >
                  {drawerDockActionActive ? <Minimize2 size={15} /> : <SquareArrowOutUpRight size={15} />}
                </motion.button>
                {showMiniTurnNavigator ? (
                  <WorkbenchMiniTurnNavigator
                    disabled={headerActionsDisabled}
                    turns={turnNavigationItems}
                    onNavigateTurn={openExpandedLayerAtTurn}
                  />
                ) : null}
              </div>
              <motion.div
                className={styles.inputSurface}
                layout={enableDockChildLayout}
                transition={reducedMotion ? { duration: 0 } : assistantMotionTransition}
                data-compose-open={visualComposeOpen ? "true" : "false"}
                data-compose-collapsing={collapsingComposer ? "true" : "false"}
                data-pending-approval={pendingApproval ? "true" : "false"}
                data-testid={renderDrawerContent ? "workbench-assistant-drawer-input-surface" : "workbench-assistant-input-surface"}
                onClick={composeOpen ? undefined : openComposer}
              >
                {showFullComposerContent ? (
                  <div
                    className={styles.composerShell}
                    data-collapsing={collapsingComposer ? "true" : "false"}
                    data-pending-approval={pendingApproval ? "true" : "false"}
                  >
                    {composer}
                  </div>
                ) : (
                  <button
                    className={styles.miniComposer}
                    type="button"
                    aria-label="展开工作台输入框"
                    title={collapsedComposerLabel}
                    onClick={openComposer}
                  >
                    <span>{collapsedComposerLabel}</span>
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

function shouldIgnoreWorkbenchPageEnter(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    const activeElement = document.activeElement;
    return activeElement instanceof Element ? shouldIgnoreWorkbenchPageEnter(activeElement) : false;
  }
  return Boolean(
    target.closest(
      [
        "input",
        "textarea",
        "select",
        "button",
        "a[href]",
        "[contenteditable]:not([contenteditable='false'])",
        "[role='button']",
        "[role='link']",
        "[role='textbox']",
        "[role='combobox']",
        "[role='menuitem']",
        "[role='option']",
        "[role='treeitem']",
        "[role='gridcell']",
        "[data-workbench-enter-focus-exempt='true']",
      ].join(","),
    ),
  );
}

function reviewPanelRequestMatchesWorkbench(
  request: ReviewPanelRequest,
  panelSessionId: string,
  workspaceId: string | undefined,
): boolean {
  const context = request.renderContext;
  if (context?.sessionId) {
    return context.sessionId === panelSessionId;
  }
  if (context?.workspaceId) {
    return context.workspaceId === workspaceId;
  }
  if (panelSessionId && request.scopeKey === `session:${panelSessionId}`) {
    return true;
  }
  if (workspaceId && request.scopeKey === workbenchPreviewPanelScopeKey(workspaceId)) {
    return true;
  }
  return Boolean(workspaceId && request.scopeKey === `workspace:${workspaceId}`);
}

function workbenchPreviewPanelScopeKey(workspaceId: string): string {
  return `workbench:${workspaceId}`;
}

function WorkbenchMiniTurnNavigator({
  disabled,
  onNavigateTurn,
  turns,
}: {
  disabled: boolean;
  onNavigateTurn: (targetIndex: number) => void;
  turns: ConversationTurnNavigationItem[];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const currentIndicatorRef = useRef<HTMLDivElement>(null);
  const markerRefsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const hoveredIndexRef = useRef<number | null>(null);
  const wavePositionRef = useRef<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [viewportMetrics, setViewportMetrics] = useState({
    clientHeight: 0,
    railViewportTop: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });
  const activeIndex = turns.length - 1;

  const railHeight = miniTurnRailHeight(turns.length);
  const activeTurn = hoveredIndex === null ? null : turns[hoveredIndex] ?? null;
  const currentIndicatorTop = turns.length > 0 ? miniTurnMarkerTop(activeIndex) : null;
  const activeMarkerTop =
    hoveredIndex === null
      ? miniTurnMarkerTop(Math.max(0, activeIndex))
      : miniTurnMarkerTop(hoveredIndex);
  const activeTop = clampNumber(
    activeMarkerTop + viewportMetrics.railViewportTop,
    MINI_TURN_MARKER_HIT_HEIGHT / 2,
    Math.max(
      MINI_TURN_MARKER_HIT_HEIGHT / 2,
      (viewportMetrics.clientHeight || railHeight) - MINI_TURN_MARKER_HIT_HEIGHT / 2,
    ),
  );
  const isScrollable = viewportMetrics.scrollHeight - viewportMetrics.clientHeight > 1;

  const setActiveIndex = (index: number | null) => {
    if (hoveredIndexRef.current === index) {
      return;
    }
    hoveredIndexRef.current = index;
    setHoveredIndex(index);
  };

  const setWavePosition = (wavePosition: number | null) => {
    wavePositionRef.current = wavePosition;
    markerRefsRef.current.forEach((marker, index) => {
      marker?.style.setProperty("--mini-turn-marker-width", `${miniTurnMarkerWidth(index, wavePosition)}px`);
    });
    currentIndicatorRef.current?.style.setProperty(
      "--mini-turn-current-marker-width",
      `${miniTurnMarkerWidth(activeIndex, wavePosition)}px`,
    );
  };

  const updateViewportMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const rail = railRef.current;
    const viewportRect = viewport.getBoundingClientRect();
    const railViewportTop = rail ? rail.getBoundingClientRect().top - viewportRect.top : -viewport.scrollTop;
    const nextMetrics = {
      clientHeight: viewport.clientHeight,
      railViewportTop,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    };
    setViewportMetrics((previous) =>
      previous.clientHeight === nextMetrics.clientHeight &&
      previous.railViewportTop === nextMetrics.railViewportTop &&
      previous.scrollHeight === nextMetrics.scrollHeight &&
      previous.scrollTop === nextMetrics.scrollTop
        ? previous
        : nextMetrics,
    );
  }, []);

  useLayoutEffect(() => {
    markerRefsRef.current = markerRefsRef.current.slice(0, turns.length);
    updateViewportMetrics();
  }, [railHeight, turns.length, updateViewportMetrics]);

  useLayoutEffect(() => {
    currentIndicatorRef.current?.style.setProperty(
      "--mini-turn-current-marker-width",
      `${miniTurnMarkerWidth(activeIndex, wavePositionRef.current)}px`,
    );
  }, [activeIndex]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    updateViewportMetrics();
    if (typeof ResizeObserver === "undefined") {
      if (typeof window === "undefined") {
        return;
      }
      window.addEventListener("resize", updateViewportMetrics);
      return () => {
        window.removeEventListener("resize", updateViewportMetrics);
      };
    }
    const observer = new ResizeObserver(updateViewportMetrics);
    observer.observe(viewport);
    if (railRef.current) {
      observer.observe(railRef.current);
    }
    return () => {
      observer.disconnect();
    };
  }, [updateViewportMetrics]);

  useEffect(() => {
    if (hoveredIndex !== null || turns.length < 2) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientHeight <= 0) {
      return;
    }
    const markerTop = miniTurnMarkerTop(activeIndex) - MINI_TURN_MARKER_HIT_HEIGHT / 2;
    const markerBottom = markerTop + MINI_TURN_MARKER_HIT_HEIGHT;
    const visibleTop = viewport.scrollTop;
    const visibleBottom = visibleTop + viewport.clientHeight;
    let nextScrollTop: number | null = null;

    if (markerTop < visibleTop + MINI_TURN_SCROLL_EDGE) {
      nextScrollTop = markerTop - MINI_TURN_SCROLL_EDGE;
    } else if (markerBottom > visibleBottom - MINI_TURN_SCROLL_EDGE) {
      nextScrollTop = markerBottom + MINI_TURN_SCROLL_EDGE - viewport.clientHeight;
    }

    if (nextScrollTop === null) {
      return;
    }
    viewport.scrollTop = clampNumber(nextScrollTop, 0, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    updateViewportMetrics();
  }, [
    activeIndex,
    hoveredIndex,
    turns.length,
    updateViewportMetrics,
    viewportMetrics.clientHeight,
    viewportMetrics.scrollHeight,
  ]);

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || turns.length === 0 || disabled) {
      return;
    }
    const rect = rail.getBoundingClientRect();
    const relativeY = event.clientY - rect.top - MINI_TURN_MARKER_HIT_HEIGHT / 2;
    if (!Number.isFinite(relativeY)) {
      return;
    }
    const nextWavePosition = clampNumber(relativeY / MINI_TURN_MARKER_STEP, 0, Math.max(0, turns.length - 1));
    setWavePosition(nextWavePosition);
    setActiveIndex(Math.round(nextWavePosition));
  };

  const handlePointerLeave = () => {
    setWavePosition(null);
    setActiveIndex(null);
  };

  const handleNavigateTurn = (targetIndex: number) => {
    if (disabled) {
      return;
    }
    setWavePosition(null);
    setActiveIndex(null);
    onNavigateTurn(targetIndex);
  };

  if (turns.length < 2) {
    return null;
  }

  return (
    <div
      className={styles.miniTurnNavigator}
      data-testid="workbench-mini-turn-navigator"
      data-turn-count={turns.length}
      data-disabled={disabled ? "true" : "false"}
    >
      <div
        className={styles.miniTurnNavigatorViewport}
        data-scrollable={isScrollable ? "true" : "false"}
        data-testid="workbench-mini-turn-navigator-viewport"
        ref={viewportRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onScroll={updateViewportMetrics}
      >
        <div
          className={styles.miniTurnNavigatorRail}
          ref={railRef}
          style={{ "--mini-turn-rail-height": `${railHeight}px` } as CSSProperties}
        >
          {currentIndicatorTop !== null ? (
            <div
              className={styles.miniTurnNavigatorCurrentIndicator}
              aria-hidden="true"
              ref={currentIndicatorRef}
              style={
                {
                  "--mini-turn-current-marker-top": `${currentIndicatorTop}px`,
                  "--mini-turn-current-marker-width": `${MINI_TURN_MARKER_BASE_WIDTH}px`,
                } as CSSProperties
              }
            >
              <span />
            </div>
          ) : null}
          {turns.map((turn, index) => (
            <button
              className={styles.miniTurnNavigatorMarker}
              key={turn.id}
              type="button"
              aria-label={`跳转到第 ${index + 1} 轮：${turn.userPreview}`}
              data-active={index === hoveredIndex ? "true" : "false"}
              data-current={index === activeIndex ? "true" : "false"}
              ref={(node) => {
                markerRefsRef.current[index] = node;
              }}
              onFocus={() => {
                setWavePosition(index);
                setActiveIndex(index);
              }}
              onBlur={handlePointerLeave}
              onClick={(event) => {
                event.currentTarget.blur();
                handleNavigateTurn(turn.targetIndex);
              }}
              style={
                {
                  "--mini-turn-marker-top": `${miniTurnMarkerTop(index)}px`,
                  "--mini-turn-marker-width": `${MINI_TURN_MARKER_BASE_WIDTH}px`,
                } as CSSProperties
              }
            >
              <span />
            </button>
          ))}
        </div>
      </div>
      {activeTurn ? (
        <article
          className={styles.miniTurnNavigatorCard}
          style={{ "--mini-turn-card-top": `${activeTop}px` } as CSSProperties}
          data-testid="workbench-mini-turn-navigator-card"
        >
          <strong>{activeTurn.userPreview}</strong>
          {activeTurn.assistantPreview.length ? (
            <span>{activeTurn.assistantPreview.join("\n")}</span>
          ) : (
            <span>暂无回复</span>
          )}
        </article>
      ) : null}
      <div className={styles.miniTurnNavigatorCount}>{turns.length} turn</div>
    </div>
  );
}

function miniTurnRailHeight(count: number): number {
  return Math.max(
    MINI_TURN_MARKER_HIT_HEIGHT,
    MINI_TURN_MARKER_HIT_HEIGHT + Math.max(0, count - 1) * MINI_TURN_MARKER_STEP,
  );
}

function miniTurnMarkerTop(index: number): number {
  return MINI_TURN_MARKER_HIT_HEIGHT / 2 + index * MINI_TURN_MARKER_STEP;
}

function miniTurnMarkerWidth(index: number, waveIndex: number | null): number {
  if (waveIndex === null) {
    return MINI_TURN_MARKER_BASE_WIDTH;
  }
  const distance = Math.abs(index - waveIndex);
  const influence = clampNumber(1 - distance / MINI_TURN_WAVE_RADIUS, 0, 1);
  return (
    MINI_TURN_MARKER_BASE_WIDTH +
    (MINI_TURN_MARKER_PEAK_WIDTH - MINI_TURN_MARKER_BASE_WIDTH) *
      Math.pow(influence, MINI_TURN_WAVE_FALLOFF_EXPONENT)
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function WorkbenchMessageButton({
  disabled,
  expanded,
  onClick,
}: {
  disabled: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={styles.messageButton}
      type="button"
      aria-label={expanded ? "收起工作台消息层" : "展开工作台消息层"}
      title={expanded ? "收起消息" : "展开消息"}
      data-expanded={expanded ? "true" : "false"}
      data-state="idle"
      data-testid="workbench-message-trigger"
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.messageButtonIcon} aria-hidden="true">
        {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </span>
    </button>
  );
}

function WorkbenchMessageCarrier({
  disabled,
  expanded,
  fileDeltas,
  onClick,
  state,
  text,
  typewriter,
}: {
  disabled: boolean;
  expanded: boolean;
  fileDeltas: { added: number; removed: number } | null;
  onClick: () => void;
  state: MessageTriggerState;
  text: string;
  typewriter: boolean;
}) {
  const live = state !== "idle";
  const typewriterEnabled = live && !fileDeltas && typewriter;
  const visibleText = useMessageCarrierTypewriterText(text, typewriterEnabled);
  return (
    <button
      className={styles.messageCarrier}
      type="button"
      aria-label={expanded ? "收起工作台消息层" : "展开工作台消息层"}
      title={expanded ? "收起消息" : live ? "查看消息" : "展开消息"}
      data-expanded={expanded ? "true" : "false"}
      data-layout-motion="static"
      data-state={state}
      data-testid="workbench-message-carrier"
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.messageCarrierIcon} aria-hidden="true">
        <span className={styles.messageCarrierDot} />
      </span>
      {fileDeltas ? (
        <LineChangeTicker
          className={`${styles.messageCarrierText} ${styles.messageCarrierLineTicker}`}
          label={text}
          added={fileDeltas.added}
          removed={fileDeltas.removed}
          unit=""
        />
      ) : (
        <span className={styles.messageCarrierText} data-typewriter={typewriterEnabled ? "true" : "false"}>
          {visibleText}
        </span>
      )}
    </button>
  );
}

function useMessageCarrierTypewriterText(text: string, enabled: boolean): string {
  const [displayText, setDisplayText] = useState(() => (enabled ? firstTextCluster(text) : text));
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = null;
  }, []);

  useEffect(() => {
    clearTimer();

    if (!enabled || !text) {
      setDisplayText(text);
      return;
    }

    if (typeof window === "undefined") {
      setDisplayText(text);
      return;
    }

    const clusters = Array.from(text);
    const initialLength = Math.min(1, clusters.length);
    const charsPerTick = Math.max(
      1,
      Math.ceil(clusters.length / Math.max(1, MESSAGE_CARRIER_TYPEWRITER_TARGET_MS / MESSAGE_CARRIER_TYPEWRITER_TICK_MS)),
    );
    let visibleLength = initialLength;
    setDisplayText(clusters.slice(0, visibleLength).join(""));

    const tick = () => {
      visibleLength = Math.min(clusters.length, visibleLength + charsPerTick);
      setDisplayText(clusters.slice(0, visibleLength).join(""));
      if (visibleLength < clusters.length) {
        timerRef.current = window.setTimeout(tick, MESSAGE_CARRIER_TYPEWRITER_TICK_MS);
        return;
      }
      timerRef.current = null;
    };

    timerRef.current = window.setTimeout(tick, MESSAGE_CARRIER_TYPEWRITER_TICK_MS);
    return clearTimer;
  }, [clearTimer, enabled, text]);

  useEffect(() => clearTimer, [clearTimer]);

  return displayText;
}

function useMessageCarrierDisplayPreview(
  state: MessageTriggerState,
  preview: MessageTriggerPreview | null,
  reducedMotion: boolean,
): MessageTriggerPreview | null {
  const [displayPreview, setDisplayPreview] = useState<MessageTriggerPreview | null>(() =>
    state === "streaming" ? preview : null,
  );
  const pendingPreviewRef = useRef<MessageTriggerPreview | null>(null);
  const displayKeyRef = useRef("");
  const refreshTimerRef = useRef<number | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = null;
  }, []);

  const flushPendingPreview = useCallback(() => {
    refreshTimerRef.current = null;
    const pendingPreview = pendingPreviewRef.current;
    displayKeyRef.current = messageTriggerPreviewKey(pendingPreview);
    setDisplayPreview(pendingPreview);
  }, []);

  useEffect(() => {
    pendingPreviewRef.current = preview;

    if (state !== "streaming") {
      clearRefreshTimer();
      displayKeyRef.current = "";
      setDisplayPreview(null);
      return;
    }

    if (!preview) {
      clearRefreshTimer();
      displayKeyRef.current = "";
      setDisplayPreview(null);
      return;
    }

    const nextKey = messageTriggerPreviewKey(preview);
    const shouldThrottle = preview.kind === "assistant" && !reducedMotion;

    if (!shouldThrottle) {
      clearRefreshTimer();
      displayKeyRef.current = nextKey;
      setDisplayPreview(preview);
      return;
    }

    if (!displayKeyRef.current || displayPreview?.kind !== "assistant") {
      clearRefreshTimer();
      displayKeyRef.current = nextKey;
      setDisplayPreview(preview);
      return;
    }

    if (nextKey === displayKeyRef.current || refreshTimerRef.current !== null) {
      return;
    }

    if (typeof window === "undefined") {
      displayKeyRef.current = nextKey;
      setDisplayPreview(preview);
      return;
    }

    refreshTimerRef.current = window.setTimeout(flushPendingPreview, MESSAGE_CARRIER_STREAM_REFRESH_MS);
  }, [clearRefreshTimer, displayPreview?.kind, flushPendingPreview, preview, reducedMotion, state]);

  useEffect(() => clearRefreshTimer, [clearRefreshTimer]);

  return displayPreview;
}

function WorkbenchAssistantShell({
  children,
  chromeRef,
  dockLayout,
  dockOutTargetMode,
  geometryMode,
  mode,
  reducedMotion,
  resizing,
  transitionPhase,
}: {
  children: ReactNode;
  chromeRef: RefObject<HTMLDivElement | null>;
  dockLayout: "inline" | "overlay";
  dockOutTargetMode: AssistantSurfaceMode;
  geometryMode: AssistantSurfaceMode;
  mode: AssistantVisualMode;
  reducedMotion: boolean;
  resizing: boolean;
  transitionPhase: DockTransitionPhase | "idle";
}) {
  const chromeLayout =
    reducedMotion || resizing || transitionPhase !== "idle" ? false : "position";
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
      data-resizing={resizing ? "true" : "false"}
    >
      <motion.div
        ref={chromeRef}
        className={styles.chrome}
        data-testid="workbench-assistant-chrome"
        data-dock-out-target={dockOutTargetMode}
        data-geometry-mode={geometryMode}
        data-shell-mode={mode}
        data-resizing={resizing ? "true" : "false"}
        layout={chromeLayout}
        transition={reducedMotion ? { duration: 0 } : chromeMotionTransition}
      >
        {children}
      </motion.div>
    </div>
  );
}

export function resolveWorkbenchAssistantDockInlineWidth(drawerWidth: number, viewportWidth: number): number {
  if (viewportWidth <= 900) {
    return Math.min(380, Math.max(300, viewportWidth * 0.48));
  }
  return Math.min(Math.max(320, drawerWidth), 520, viewportWidth * 0.46);
}

function latestAssistantMessageFrom(messages: AgentChatMessage[]): AgentChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) {
      return message;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}

function runningMessageTriggerPreviewFrom(messages: AgentChatMessage[]): MessageTriggerPreview | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "tool" && isRunningAgentMessage(message)) {
      return toolMessageTriggerPreview(message);
    }
    if (message.role === "assistant" && isRunningAgentMessage(message)) {
      const preview = assistantMessagePreview(message.content);
      if (preview) {
        return {
          addedLines: 0,
          kind: "assistant",
          removedLines: 0,
          text: preview,
        };
      }
    }
  }
  return null;
}

function toolMessageTriggerPreview(message: AgentChatMessage): MessageTriggerPreview {
  const toolName = message.toolName?.trim() ?? "";
  if (isEditToolName(toolName)) {
    const deltas = lineDeltasFromFileChanges(fileChangesFromAgentTool(message));
    return {
      addedLines: deltas.added,
      kind: "file-change",
      removedLines: deltas.removed,
      text: editToolActivityLabel(toolName),
    };
  }
  return {
    addedLines: 0,
    kind: "tool",
    removedLines: 0,
    text: toolExecutionLabel(toolName),
  };
}

function assistantMessagePreview(content: string): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, "代码片段")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/g, "")
    .trim();
  return normalized.length > 96 ? normalized.slice(-96) : normalized;
}

function messageTriggerPreviewKey(preview: MessageTriggerPreview | null): string {
  if (!preview) {
    return "";
  }
  return `${preview.kind}:${preview.text}:${preview.addedLines}:${preview.removedLines}`;
}

function firstTextCluster(text: string): string {
  return Array.from(text)[0] ?? "";
}

function isRunningAgentMessage(message: AgentChatMessage): boolean {
  return Boolean(message.streaming || message.status === "running" || message.status === "streaming");
}

function isEditToolName(toolName: string): boolean {
  return ["write_file", "apply_patch", "edit_file", "create_file", "delete_file"].includes(toolName);
}

function editToolActivityLabel(toolName: string): string {
  if (toolName === "create_file") {
    return "正在创建文件";
  }
  if (toolName === "write_file") {
    return "正在写入文件";
  }
  if (toolName === "delete_file") {
    return "正在删除文件";
  }
  return "正在编辑文件";
}

function toolExecutionLabel(toolName: string): string {
  const label = knownToolLabel(toolName);
  if (label) {
    return `正在执行${label}`;
  }
  return toolName ? `正在执行 ${toolName} 工具` : "正在执行工具";
}

function knownToolLabel(toolName: string): string {
  switch (toolName) {
    case "run_cmd":
    case "run_powershell":
    case "run_git_bash":
      return "命令";
    case "read_file":
    case "read_text_file":
    case "open_file":
      return "文件读取";
    case "list_directory":
    case "list_dir":
    case "read_directory":
      return "目录读取";
    case "search_files":
    case "search_text":
    case "grep_files":
    case "workspace_search":
    case "search":
    case "grep":
      return "搜索";
    case "update_plan":
      return "计划更新";
    case "load_skill":
      return "Skill 加载";
    default:
      return "";
  }
}

function fileChangesFromAgentTool(message: AgentChatMessage): AgentFileChange[] {
  const changes = [...(message.fileChanges ?? [])];
  const payloadChanges = fileChangesFromUnknownPayload(message.uiPayload);
  payloadChanges.forEach((change) => changes.push(change));
  return changes;
}

function fileChangesFromUnknownPayload(payload: unknown): AgentFileChange[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  const source = Array.isArray(record.files)
    ? record.files
    : Array.isArray(record.changes)
      ? record.changes
      : [];
  return source
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, index) => ({
      ...item,
      path: stringValue(item.path) || `file-${index + 1}`,
    }));
}

function lineDeltasFromFileChanges(changes: AgentFileChange[]): { added: number; removed: number } {
  return changes.reduce(
    (totals, change) => ({
      added: totals.added + lineDeltaNumber(change.added_lines ?? change.additions),
      removed: totals.removed + lineDeltaNumber(change.deleted_lines ?? change.removed_lines ?? change.deletions),
    }),
    { added: 0, removed: 0 },
  );
}

function lineDeltaNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function WorkbenchComposer({
  value,
  runtimeState,
  canSend,
  canStop,
  connectionReady,
  modelSelection,
  workspaceSkills,
  selectedFiles,
  selectedQuotes,
  selectedSkill,
  runtime,
  sessionId,
  pendingApproval,
  fileAccessMode,
  workspaceRoots,
  allowPersistentTrust,
  approvalSubmitting,
  approvalError,
  fileChipRequest,
  quoteChipRequest,
  contextWindowUsage,
  allowBypassConversationSlashCommand,
  allowGoalSlashCommand,
  allowContextCompressionSlashCommand,
  autoFocusKey,
  leftAccessory,
  placeholder,
  onSelectedFilesChange,
  onSelectedQuotesChange,
  onChange,
  onSkillChange,
  onSubmitApproval,
  onSend,
  onStop,
  onEscape,
  onSearchWorkspace,
  onListWorkspaceDirectory,
  onOpenFileReference,
  onSlashCommand,
  onRefreshWorkspaceSkills,
  onExternalFileRequestHandled,
  onExternalQuoteRequestHandled,
}: {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  connectionReady: boolean;
  modelSelection: ReturnType<typeof useRuntimeModelSelection>;
  workspaceSkills: WorkspaceSkillSummary[];
  selectedFiles: SelectedFile[];
  selectedQuotes: SelectedQuote[];
  selectedSkill: WorkspaceSkillSummary | null;
  runtime: RuntimeBridge;
  sessionId?: string | null;
  pendingApproval: CommandApprovalRequest | null;
  fileAccessMode: FileAccessMode;
  workspaceRoots: string[];
  allowPersistentTrust: boolean;
  approvalSubmitting: boolean;
  approvalError: string | null;
  fileChipRequest: AgentSessionController["fileChipRequest"];
  quoteChipRequest: AgentSessionController["quoteChipRequest"];
  contextWindowUsage: ContextWindowUsageStatus | null;
  allowBypassConversationSlashCommand?: boolean;
  allowGoalSlashCommand?: boolean;
  allowContextCompressionSlashCommand?: boolean;
  autoFocusKey?: string;
  leftAccessory?: ReactNode;
  placeholder?: string;
  onSelectedFilesChange: (files: SelectedFile[]) => void;
  onSelectedQuotesChange: (quotes: SelectedQuote[]) => void;
  onChange: (value: string) => void;
  onSkillChange: (skill: WorkspaceSkillSummary | null) => void;
  onSubmitApproval: AgentSessionController["submitApproval"];
  onSend: (
    files?: SelectedFile[],
    quotes?: SelectedQuote[],
    attachments?: SelectedImageAttachment[],
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onEscape?: () => void;
  onSearchWorkspace: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
  onListWorkspaceDirectory: (path: string) => Promise<WorkspaceSearchResult[]>;
  onOpenFileReference: (file: SelectedFile) => void;
  onSlashCommand?: (command: SlashCommand) => void;
  onRefreshWorkspaceSkills?: () => void | Promise<void>;
  onExternalFileRequestHandled?: (requestId: number) => void;
  onExternalQuoteRequestHandled?: (requestId: number) => void;
}) {
  if (pendingApproval) {
    return (
      <div className={styles.composerApprovalSlot}>
        <ComposerApprovalCard
          allowPersistentTrust={allowPersistentTrust}
          approval={pendingApproval}
          error={approvalError}
          submitting={approvalSubmitting}
          onSubmit={onSubmitApproval}
        />
      </div>
    );
  }

  return (
    <ConversationComposer
      value={value}
      runtimeState={runtimeState}
      canSend={canSend}
      canStop={canStop}
      connectionReady={connectionReady}
      modelSelection={modelSelection}
      workspaceSkills={workspaceSkills}
      selectedFiles={selectedFiles}
      selectedQuotes={selectedQuotes}
      selectedSkill={selectedSkill}
      runtime={runtime}
      sessionId={sessionId}
      fileAccessMode={fileAccessMode}
      workspaceRoots={workspaceRoots}
      allowBypassConversationSlashCommand={allowBypassConversationSlashCommand}
      allowGoalSlashCommand={allowGoalSlashCommand}
      allowContextCompressionSlashCommand={allowContextCompressionSlashCommand}
      autoFocusKey={autoFocusKey}
      className={styles.composer}
      leftAccessory={leftAccessory}
      placeholder={placeholder ?? "要求后续变更"}
      ariaLabel="工作台助手表单"
      inputLabel="工作台助手输入"
      modelSelectorPlacement="top"
      contextWindowUsage={contextWindowUsage}
      externalFileRequest={fileChipRequest}
      externalQuoteRequest={quoteChipRequest}
      onSelectedFilesChange={onSelectedFilesChange}
      onSelectedQuotesChange={onSelectedQuotesChange}
      onChange={onChange}
      onSkillChange={onSkillChange}
      onSend={onSend}
      onStop={onStop}
      onEscape={onEscape}
      onSearchWorkspace={onSearchWorkspace}
      onListWorkspaceDirectory={onListWorkspaceDirectory}
      onOpenFileReference={onOpenFileReference}
      onSlashCommand={onSlashCommand}
      onRefreshWorkspaceSkills={onRefreshWorkspaceSkills}
      onExternalFileRequestHandled={onExternalFileRequestHandled}
      onExternalQuoteRequestHandled={onExternalQuoteRequestHandled}
    />
  );
}

function sessionTitleFromPreparedMessage(text: string, contextItems: AgentContextItem[]): string {
  const title = text.trim() || contextItems[0]?.label || "工作台对话";
  return title.slice(0, 32);
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

function contextCompressionErrorMessage(reason: unknown): string {
  const code = runtimeErrorCode(reason);
  if (code === "context_compression_disabled") {
    return "上下文压缩未启用";
  }
  if (code === "session_busy") {
    return "当前会话正在运行，无法压缩上下文";
  }
  if (code === "checkpoint_not_found") {
    return "当前会话还没有可压缩的上下文";
  }
  if (code === "no_compressible_messages") {
    return "当前会话没有可压缩的历史上下文";
  }
  if (code === "model_config_error") {
    return "快速模型配置不可用，无法生成压缩摘要";
  }
  if (code === "llm_error") {
    return "压缩摘要生成失败";
  }
  return errorMessage(reason);
}

function runtimeErrorCode(reason: unknown): string | null {
  const record = objectRecord(reason);
  if (typeof record?.code === "string") {
    return record.code;
  }
  const detail = objectRecord(record?.detail);
  if (typeof detail?.code === "string") {
    return detail.code;
  }
  const details = objectRecord(record?.details);
  if (typeof details?.code === "string") {
    return details.code;
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isTaskAlreadyOpenError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") {
    return false;
  }
  const code = (reason as { code?: unknown }).code;
  if (code === "task_already_open") {
    return true;
  }
  const message = (reason as { message?: unknown }).message;
  return typeof message === "string" && message.includes("task_already_open");
}

function workspaceEntriesToSearchResults(entries: WorkspaceEntry[]): WorkspaceSearchResult[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    type: entry.type,
  }));
}

function selectedFileRevealTarget(file: SelectedFile): PreviewFileRevealTarget | null {
  if (!file.lineStart && !file.lineEnd && file.sourceStart == null && file.sourceEnd == null) {
    return null;
  }
  return {
    selectedText: file.selectedText ?? null,
    lineStart: file.lineStart ?? null,
    lineEnd: file.lineEnd ?? null,
    sourceStart: file.sourceStart ?? null,
    sourceEnd: file.sourceEnd ?? null,
  };
}

function workspaceRootsForWorkbench(workspace: Workspace | null | undefined): string[] {
  return workspace?.root_path ? [workspace.root_path] : [];
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
