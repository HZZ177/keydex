import { ArrowDown } from "lucide-react";
import {
  type ReactNode,
  type PointerEvent,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { ConversationMessage, ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { normalizeMessageContent } from "@/renderer/utils/messageContent";
import type { AgentSessionFork } from "@/types/protocol";
import { useOptionalPreview, type PreviewContextValue } from "@/renderer/providers/PreviewProvider";

import styles from "./MessageList.module.css";
import { ApprovalPrompt, type ApprovalDecisionHandler } from "./ApprovalPrompt";
import { A2UIBlock, type A2UICancelHandler, type A2UISubmitHandler } from "./a2ui";
import { CommandExecutionBlock } from "./CommandExecutionBlock";
import { ConversationScrollRail } from "./ConversationScrollRail";
import { ConversationTurnNavigator, type ConversationTurnNavigationItem } from "./ConversationTurnNavigator";
import { ErrorItem } from "./ErrorItem";
import { FileChangeBlock, type FileChangePreview } from "./FileChangeBlock";
import { MessageGroupBlock } from "./MessageGroupBlock";
import { McpElicitationPrompt, type McpElicitationResolveHandler } from "./McpElicitationPrompt";
import { AgentLoadingIcon } from "./MessageAgentStatus";
import { MessageThinking } from "./MessageThinking";
import { MessageActionFooter, MessageText, ProcessingDuration, StreamingCursor } from "./MessageText";
import { SkillActivationBlock } from "./SkillActivationBlock";
import { ThreadTaskStatusBlock } from "./ThreadTaskStatusBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { WebActivityBlock, webActivityFromMessage } from "./WebActivityBlock";
import { processMessages, type ProcessedMessageItem } from "./processMessages";
import { conversationBaselineDiagnostics } from "./conversationBaselineDiagnostics";
import {
  isLiveA2UIStreamMessage,
  projectConversationRenderUnits,
  type ConversationRenderUnit,
  type ConversationRenderTurn,
} from "../timeline/ConversationRenderUnit";
import {
  ConversationTimelineSurface,
  type ConversationTimelineSurfaceHandle,
} from "../timeline/ConversationTimelineSurface";
import { ConversationNavigationController } from "../timeline/ConversationNavigationController";
import { ConversationPinRegistry } from "../timeline/ConversationPinRegistry";
import {
  ConversationHydrationScheduler,
  type ConversationHydrationCandidate,
} from "@/renderer/markdownRuntime/history/ConversationHydrationScheduler";
import { conversationMarkdownAdapter, conversationMarkdownRuntimeStore } from "./conversationMarkdownRuntime";
import type { ToolDetailsLoader } from "./useLazyToolDetails";
import { useConversationFollowController } from "../timeline/useConversationFollowController";

const CONVERSATION_TIMELINE_OVERSCAN_PX = 1000;
const TAIL_BOOTSTRAP_SKELETON_DELAY_MS = 100;
const LOAD_OLDER_TRIGGER_PX = 44;
const LOAD_OLDER_ARM_PX = 120;
const USER_SCROLL_SETTLE_MS = 180;
const TURN_FOCUS_FLASH_DURATION_MS = 1300;
const STREAMING_CURSOR_IDLE_DELAY_MS = 450;
const CONVERSATION_HOT_TAIL_TURNS = 3;
const CONVERSATION_HOT_TAIL_MAX_UNITS = 32;
const EMPTY_CONVERSATION_UNIT_IDS: readonly string[] = Object.freeze([]);
const MESSAGE_LIST_BOTTOM_BUFFER_PX: Readonly<Record<MessageListVariant, number>> = Object.freeze({
  full: 80,
  compact: 64,
  overlay: 96,
});

export interface MessageListProps {
  messages: ConversationMessage[];
  loading?: boolean;
  isProcessing?: boolean;
  variant?: MessageListVariant;
  performanceProfile?: MessageListPerformanceProfile;
  turnNavigatorMode?: MessageListTurnNavigatorMode;
  turnNavigationRequest?: MessageListTurnNavigationRequest | null;
  onTurnNavigate?: (targetIndex: number) => void;
  topNotice?: MessageListTopNotice | null;
  emptyLayout?: MessageListEmptyLayout;
  emptyText?: string;
  emptyTestId?: string;
  runtimeState?: ConversationRuntimeState;
  turnFirstTokenAtMs?: number | null;
  runtimeDetail?: string | null;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  previewContextOverride?: PreviewContextValue | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onResolveMcpElicitation?: McpElicitationResolveHandler;
  a2uiDebugInfoEnabled?: boolean;
  a2uiRenderSuspended?: boolean;
  onA2UISubmit?: A2UISubmitHandler;
  onA2UICancel?: A2UICancelHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string, comment?: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onForkFromMessage?: (message: ConversationMessage) => void;
  onNavigateToForkSource?: (fork: AgentSessionFork) => void;
  showForkSourceMarkers?: boolean;
  onReverseFromMessage?: (message: ConversationMessage) => void;
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void | Promise<void>;
  scrollButtonMode?: "inline" | "external";
  onScrollControlsChange?: (controls: MessageListScrollControls) => void;
}

export interface MessageListScrollControls {
  showScrollToBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export interface MessageListTopNotice {
  content: ReactNode;
  tone?: "default" | "success";
  testId?: string;
  title?: string;
}

export type MessageListVariant = "full" | "compact" | "overlay";
export type MessageListPerformanceProfile = "default" | "interactivePanel";
export type MessageListEmptyLayout = "default" | "center";
export type MessageListTurnNavigatorMode = "auto" | "hidden";
export interface MessageListTurnNavigationRequest {
  requestId: number;
  targetIndex?: number;
  targetTurnIndex?: number;
  flash?: boolean;
}

export function MessageList({
  messages,
  loading = false,
  isProcessing = false,
  runtimeState,
  turnFirstTokenAtMs = null,
  variant = "full",
  performanceProfile = "default",
  turnNavigatorMode,
  turnNavigationRequest,
  onTurnNavigate,
  topNotice = null,
  emptyLayout = "default",
  emptyText = "暂无消息",
  emptyTestId = "message-empty",
  renderMessage,
  workspaceRuntime,
  workspaceScope,
  previewContextOverride,
  onApprovalDecision,
  onResolveMcpElicitation,
  a2uiDebugInfoEnabled = false,
  a2uiRenderSuspended = false,
  onA2UISubmit,
  onA2UICancel,
  onFilePreview,
  onLoadToolDetails,
  onTerminateCommand,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onForkFromMessage,
  onNavigateToForkSource,
  showForkSourceMarkers = true,
  onReverseFromMessage,
  hasMoreOlder = false,
  loadingOlder = false,
  onLoadOlder,
  scrollButtonMode = "inline",
  onScrollControlsChange,
}: MessageListProps) {
  conversationBaselineDiagnostics.record({
    stage: "message-list-render",
    itemCount: messages.length,
  });
  const inheritedPreviewContext = useOptionalPreview();
  const previewContext = previewContextOverride === undefined ? inheritedPreviewContext : previewContextOverride;
  const olderLoadAnchorRef = useRef<{ runtime: true } | null>(null);
  const olderLoadRequestedRef = useRef(false);
  const olderLoadArmedRef = useRef(false);
  const nativeScrollbarDragRef = useRef(false);
  const virtualScrollerRef = useRef<HTMLElement | null>(null);
  const conversationTimelineRef = useRef<ConversationTimelineSurfaceHandle | null>(null);
  const conversationNavigationRef = useRef<ConversationNavigationController | null>(null);
  const navigationRequestSequenceRef = useRef(0);
  const conversationPinRegistryRef = useRef<ConversationPinRegistry | null>(null);
  const conversationHydrationRef = useRef<ConversationHydrationScheduler | null>(null);
  const hoveredAgentTurnFooterRef = useRef<HTMLElement | null>(null);
  if (!conversationNavigationRef.current) conversationNavigationRef.current = new ConversationNavigationController();
  if (!conversationPinRegistryRef.current) conversationPinRegistryRef.current = new ConversationPinRegistry();
  const conversationNavigation = conversationNavigationRef.current;
  const conversationPinRegistry = conversationPinRegistryRef.current;
  const tailReadinessFrameRef = useRef<number | null>(null);
  const tailReadinessObserverRef = useRef<MutationObserver | null>(null);
  const evaluateTailReadinessRef = useRef<() => void>(() => undefined);
  const userScrollInteractionRef = useRef(false);
  const userScrollSettleTimerRef = useRef<number | null>(null);
  const flashTurnFrameRef = useRef<number | null>(null);
  const hydrationIdleRef = useRef<number | null>(null);
  const hydrationTimeoutRef = useRef<number | null>(null);
  const flashTurnTimeoutRef = useRef<number | null>(null);
  const [showOlderTrigger, setShowOlderTrigger] = useState(false);
  const [flashingTurnIndex, setFlashingTurnIndex] = useState<number | null>(null);
  const [showTailBootstrapSkeleton, setShowTailBootstrapSkeleton] = useState(false);
  const [timelineScroller, setTimelineScroller] = useState<HTMLElement | null>(null);
  const visibleMessages = useMemo(() => messages.filter((message) => message.kind !== "plan"), [messages]);
  const processedMessages = useMemo(() => processMessages(visibleMessages), [visibleMessages]);
  const displayItems = processedMessages;
  const timeline = useMemo(() => buildConversationTimeline(displayItems), [displayItems]);
  const displayBlocks = timeline.blocks;
  const displayTurns = timeline.turns;
  const turnNavigationItems = useMemo(() => buildTurnNavigationItems(displayTurns), [displayTurns]);
  const effectiveTurnNavigatorMode = turnNavigatorMode ?? (variant === "full" ? "auto" : "hidden");
  const showTurnNavigator = effectiveTurnNavigatorMode === "auto" && turnNavigationItems.length >= 2;
  const turnRuntimeActive = isProcessing || isActiveTurnRuntimeState(runtimeState);
  const assistantTurnFooters = useMemo(
    () => collectAssistantTurnFooters(displayTurns, turnRuntimeActive, turnFirstTokenAtMs),
    [displayTurns, turnFirstTokenAtMs, turnRuntimeActive],
  );
  const turnEndStreamingCursor = useMemo(
    () => collectTurnEndStreamingCursor(displayTurns, isProcessing),
    [displayTurns, isProcessing],
  );
  const a2uiRenderPressure = useMemo(() => calculateA2UIRenderPressure(displayBlocks), [displayBlocks]);
  const [visibleTurnIndexes, setVisibleTurnIndexes] = useState<Set<number>>(() => new Set());
  const conversationIdentity = conversationSessionIdentity(visibleMessages);
  const externalTurnNavigationIndex = useMemo(
    () => resolveTurnNavigationIndex(turnNavigationRequest, displayTurns),
    [displayTurns, turnNavigationRequest],
  );
  const externalTurnNavigationRequestId = turnNavigationRequest?.requestId;
  const shouldAutoFollowMessages = externalTurnNavigationIndex === null;
  const autoScroll = useConversationFollowController(displayBlocks.length, {
    autoFollow: shouldAutoFollowMessages,
    identity: conversationIdentity,
  });
  const bottomBufferHeight = MESSAGE_LIST_BOTTOM_BUFFER_PX[variant];
  const canLoadOlder = Boolean(hasMoreOlder && onLoadOlder);
  const olderLoader = useMemo(
    () => renderOlderLoader({ canLoadOlder, loadingOlder, showTrigger: showOlderTrigger }),
    [canLoadOlder, loadingOlder, showOlderTrigger],
  );
  const renderedTopNotice = useMemo(() => renderTopNotice(topNotice), [topNotice]);
  const virtualRuntimeUnits = useMemo<readonly ConversationRenderUnit[]>(() => {
    const globalVersion = [
      isProcessing ? "processing" : "settled",
      a2uiDebugInfoEnabled ? "a2ui-debug" : "a2ui-normal",
      a2uiRenderSuspended ? "a2ui-suspended" : "a2ui-active",
      showForkSourceMarkers ? "fork-markers" : "no-fork-markers",
      turnFirstTokenAtMs ?? "no-first-token",
      flashingTurnIndex ?? "no-flash",
    ].join(":");
    const topUnit: ConversationRenderUnit = Object.freeze({
      id: "conversation-runtime:top",
      kind: "status",
      owner: "react",
      turnId: null,
      turnIndex: null,
      businessTurnIndex: null,
      sourceMessageIds: Object.freeze([]),
      item: null,
      parentUnitId: null,
      dynamic: loadingOlder,
      interactive: false,
      pinPolicy: "never",
      measurementPolicy: loadingOlder ? "observe-until-settled" : "estimate-once",
      estimatedHeight: 22 + (canLoadOlder ? 46 : 0) + (topNotice ? 48 : 0),
      renderVersion: `top:${canLoadOlder}:${loadingOlder}:${showOlderTrigger}:${String(topNotice?.content ?? "")}`,
    });
    const bottomUnit: ConversationRenderUnit = Object.freeze({
      id: "conversation-runtime:bottom",
      kind: "status",
      owner: "shell",
      turnId: null,
      turnIndex: null,
      businessTurnIndex: null,
      sourceMessageIds: Object.freeze([]),
      item: null,
      parentUnitId: null,
      dynamic: false,
      interactive: false,
      pinPolicy: "never",
      measurementPolicy: "estimate-once",
      estimatedHeight: bottomBufferHeight,
      renderVersion: `bottom:${bottomBufferHeight}`,
    });
    return Object.freeze([
      topUnit,
      ...timeline.runtimeUnits.map((unit) => {
        const activeFooterVersion = unit.kind === "footer" && unit.turnIndex === displayTurns.length - 1
          ? turnEndStreamingCursor.activityKey
          : "settled-footer";
        return Object.freeze({
          ...unit,
          renderVersion: `${unit.renderVersion}:${globalVersion}:${activeFooterVersion}`,
        });
      }),
      bottomUnit,
    ]);
  }, [
    a2uiDebugInfoEnabled,
    a2uiRenderSuspended,
    bottomBufferHeight,
    canLoadOlder,
    displayTurns.length,
    flashingTurnIndex,
    isProcessing,
    loadingOlder,
    showForkSourceMarkers,
    showOlderTrigger,
    timeline.runtimeUnits,
    topNotice,
    turnEndStreamingCursor.activityKey,
    turnFirstTokenAtMs,
  ]);
  const hydrationCandidates = useMemo(
    () => buildConversationHydrationCandidates(displayItems, timeline.runtimeUnits),
    [displayItems, timeline.runtimeUnits],
  );
  const hotTailUnitIds = useMemo(
    () => tailUnitIds(
      timeline.runtimeUnits,
      displayTurns.length,
      CONVERSATION_HOT_TAIL_TURNS,
      CONVERSATION_HOT_TAIL_MAX_UNITS,
    ),
    [displayTurns.length, timeline.runtimeUnits],
  );
  const residentTailUnitIds = autoScroll.shouldFollowTail ? hotTailUnitIds : EMPTY_CONVERSATION_UNIT_IDS;
  const hydrationSessionId = hydrationCandidates[0]?.sessionId ?? visibleMessages[0]?.threadId ?? "";
  const scrollControls = autoScroll;
  const scrollToConversationBottom = useCallback((behavior?: ScrollBehavior) => {
    conversationNavigation.recordUserScroll();
    autoScroll.scrollToBottom(behavior);
  }, [autoScroll.scrollToBottom, conversationNavigation]);
  const highlightedTurnNavigationIndexes = useMemo(
    () => findVisibleTurnNavigationIndexes(turnNavigationItems, visibleTurnIndexes),
    [turnNavigationItems, visibleTurnIndexes],
  );

  const setVisibleTurnIndexesIfChanged = useCallback((nextVisibleIndexes: Set<number>) => {
    setVisibleTurnIndexes((current) => (areNumberSetsEqual(current, nextVisibleIndexes) ? current : nextVisibleIndexes));
  }, []);

  const requestLoadOlder = useCallback(
    (scroller: HTMLElement | null) => {
      if (
        !scroller ||
        !canLoadOlder ||
        loadingOlder ||
        olderLoadRequestedRef.current ||
        !olderLoadArmedRef.current ||
        scroller.scrollTop > LOAD_OLDER_TRIGGER_PX
      ) {
        return;
      }
      olderLoadRequestedRef.current = true;
      if (!conversationNavigation.beginPrepend()) return;
      olderLoadAnchorRef.current = { runtime: true };
      autoScroll.beginHistoryRestore();
      void onLoadOlder?.();
    },
    [autoScroll.beginHistoryRestore, canLoadOlder, conversationNavigation, loadingOlder, onLoadOlder],
  );

  const updateOlderLoadTrigger = useCallback(
    (scroller: HTMLElement | null) => {
      if (!scroller || !canLoadOlder || loadingOlder) {
        setShowOlderTrigger(false);
        return;
      }
      if (scroller.scrollTop > LOAD_OLDER_ARM_PX) {
        olderLoadArmedRef.current = true;
      }
      const nearTop = scroller.scrollTop <= LOAD_OLDER_TRIGGER_PX;
      setShowOlderTrigger(nearTop);
      if (nearTop) {
        requestLoadOlder(scroller);
      }
    },
    [canLoadOlder, loadingOlder, requestLoadOlder],
  );

  const updateVisibleVirtualTurns = useCallback((scroller: HTMLElement | null) => {
    if (!autoScroll.snapshot.bootstrapCommitted || !showTurnNavigator || nativeScrollbarDragRef.current) {
      return;
    }
    const nextVisibleIndexes = visibleTurnIndexesFromMountedTurns(scroller, displayTurns.length);
    if (!nextVisibleIndexes.size) {
      return;
    }
    setVisibleTurnIndexesIfChanged(nextVisibleIndexes);
  }, [autoScroll.snapshot.bootstrapCommitted, displayTurns.length, setVisibleTurnIndexesIfChanged, showTurnNavigator]);

  const evaluateTailReadiness = useCallback(() => {
    const runtime = conversationTimelineRef.current;
    const tailUnit = virtualRuntimeUnits.at(-2);
    if (!runtime || !tailUnit || tailUnit.id === "conversation-runtime:top") {
      if (virtualScrollerRef.current) virtualScrollerRef.current.dataset.tailReadiness = "runtime-unavailable";
      autoScroll.setTailReady(false);
      return;
    }
    const tailElement = runtime.getUnitElement(tailUnit.id);
    if (!tailElement) {
      if (virtualScrollerRef.current) virtualScrollerRef.current.dataset.tailReadiness = "tail-unmounted";
      autoScroll.setTailReady(false);
      return;
    }
    const unitsById = new Map(virtualRuntimeUnits.map((unit) => [unit.id, unit]));
    const markdownReady = runtime.mountedUnitIds().every((unitId) => {
      const unit = unitsById.get(unitId);
      if (unit?.owner !== "markdown-runtime") return true;
      if (renderMessage) return true;
      const unitElement = runtime.getUnitElement(unitId);
      if (!unitElement || unitElement.dataset.conversationUnitMeasurementPending) return false;
      const host = unitElement.querySelector<HTMLElement>(
        "[data-message-markdown-runtime-status]",
      );
      return Boolean(host && host.dataset.messageMarkdownRuntimeStatus !== "loading");
    });
    if (virtualScrollerRef.current) {
      virtualScrollerRef.current.dataset.tailReadiness = markdownReady ? "ready" : "markdown-loading";
    }
    autoScroll.setTailReady(markdownReady);
  }, [autoScroll.setTailReady, renderMessage, virtualRuntimeUnits]);
  evaluateTailReadinessRef.current = evaluateTailReadiness;

  const scheduleTailReadinessCheck = useCallback(() => {
    if (tailReadinessFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      evaluateTailReadinessRef.current();
      return;
    }
    tailReadinessFrameRef.current = requestAnimationFrame(() => {
      tailReadinessFrameRef.current = null;
      evaluateTailReadinessRef.current();
    });
  }, []);

  const markNativeScrollbarDrag = useCallback((event: { clientX: number; clientY: number }, scroller: HTMLElement) => {
    if (isNativeScrollbarPointerStart(event, scroller)) {
      nativeScrollbarDragRef.current = true;
      return true;
    }
    return false;
  }, []);

  const scheduleUserScrollSettled = useCallback(() => {
    if (typeof window === "undefined") return;
    if (userScrollSettleTimerRef.current !== null) window.clearTimeout(userScrollSettleTimerRef.current);
    userScrollSettleTimerRef.current = window.setTimeout(() => {
      userScrollSettleTimerRef.current = null;
      userScrollInteractionRef.current = false;
      conversationTimelineRef.current?.setUserScrollInteraction(false);
    }, USER_SCROLL_SETTLE_MS);
  }, []);

  const finishUserScrollInteraction = useCallback(() => {
    if (typeof window !== "undefined" && userScrollSettleTimerRef.current !== null) {
      window.clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
    userScrollInteractionRef.current = false;
    conversationTimelineRef.current?.setUserScrollInteraction(false);
  }, []);

  const beginUserScrollInteraction = useCallback(() => {
    userScrollInteractionRef.current = true;
    conversationTimelineRef.current?.setUserScrollInteraction(true);
  }, []);

  const suspendConversationHydration = useCallback(() => {
    conversationHydrationRef.current?.suspend();
    if (typeof window === "undefined") return;
    if (hydrationIdleRef.current !== null && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(hydrationIdleRef.current);
      hydrationIdleRef.current = null;
    }
    if (hydrationTimeoutRef.current !== null) {
      window.clearTimeout(hydrationTimeoutRef.current);
      hydrationTimeoutRef.current = null;
    }
  }, []);

  const handleControlledScrollbarInteraction = useCallback((active: boolean) => {
    nativeScrollbarDragRef.current = active;
    if (active) {
      suspendConversationHydration();
      autoScroll.beginScrollbarDrag();
      conversationTimelineRef.current?.setControlledScrollInteraction(true);
      conversationNavigation.recordUserScroll();
      return;
    }
    conversationTimelineRef.current?.setControlledScrollInteraction(false);
    autoScroll.endScrollbarDrag();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => updateVisibleVirtualTurns(virtualScrollerRef.current));
    }
  }, [
    autoScroll.beginScrollbarDrag,
    autoScroll.endScrollbarDrag,
    conversationNavigation,
    suspendConversationHydration,
    updateVisibleVirtualTurns,
  ]);

  const handleVirtualScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (userScrollInteractionRef.current) scheduleUserScrollSettled();
      updateOlderLoadTrigger(event.currentTarget);
      updateVisibleVirtualTurns(event.currentTarget);
    },
    [scheduleUserScrollSettled, updateOlderLoadTrigger, updateVisibleVirtualTurns],
  );

  const setConversationTimelineScroller = useCallback(
    (element: HTMLElement | null) => {
      virtualScrollerRef.current = element;
      setTimelineScroller((current) => current === element ? current : element);
      tailReadinessObserverRef.current?.disconnect();
      tailReadinessObserverRef.current = null;
      if (element) {
        autoScroll.setScrollerRef(element);
        conversationNavigation.attach(conversationTimelineRef.current);
        conversationPinRegistry.attach(element, conversationTimelineRef.current);
        if (typeof MutationObserver !== "undefined") {
          const observer = new MutationObserver(() => scheduleTailReadinessCheck());
          observer.observe(element, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["data-message-markdown-runtime-status"],
          });
          tailReadinessObserverRef.current = observer;
        }
      } else if (!element) {
        autoScroll.setScrollerRef(null);
        conversationNavigation.attach(null);
        conversationPinRegistry.attach(null, null);
      }
    },
    [autoScroll.setScrollerRef, conversationNavigation, conversationPinRegistry, scheduleTailReadinessCheck],
  );

  const updateConversationHydrationWindow = useCallback(() => {
    if (typeof Worker !== "undefined" && hydrationSessionId) {
      conversationHydrationRef.current ??= new ConversationHydrationScheduler({
        store: conversationMarkdownRuntimeStore(),
        adapter: conversationMarkdownAdapter(),
      });
      const runtime = conversationTimelineRef.current;
      conversationHydrationRef.current.update({
        sessionId: hydrationSessionId,
        candidates: hydrationCandidates,
        mountedUnitIds: runtime?.mountedUnitIds() ?? [],
        navigationUnitIds: externalTurnNavigationIndex === null
          ? []
          : [timeline.turnUnitIds[externalTurnNavigationIndex]].filter((value): value is string => Boolean(value)),
      });
      const diagnostics = conversationHydrationRef.current.diagnostics();
      if (virtualScrollerRef.current) {
        virtualScrollerRef.current.dataset.conversationHydrationSelected = String(diagnostics.selected);
        virtualScrollerRef.current.dataset.conversationHydrationCandidates = String(diagnostics.candidates);
      }
    }
  }, [externalTurnNavigationIndex, hydrationCandidates, hydrationSessionId, timeline.turnUnitIds]);

  const handleConversationViewportChanged = useCallback(() => {
    scheduleTailReadinessCheck();
    if (autoScroll.snapshot.bootstrapCommitted) updateVisibleVirtualTurns(virtualScrollerRef.current);
    suspendConversationHydration();
    if (typeof requestAnimationFrame !== "function") {
      updateConversationHydrationWindow();
      return;
    }
    // Debounce from the latest viewport change. Continuous wheel/scroll input
    // must never overlap speculative Markdown parsing.
    hydrationTimeoutRef.current = window.setTimeout(() => {
      hydrationTimeoutRef.current = null;
      if (typeof window.requestIdleCallback === "function") {
        hydrationIdleRef.current = window.requestIdleCallback(() => {
          hydrationIdleRef.current = null;
          updateConversationHydrationWindow();
        });
      } else updateConversationHydrationWindow();
    }, 180);
  }, [
    autoScroll.snapshot.bootstrapCommitted,
    scheduleTailReadinessCheck,
    suspendConversationHydration,
    updateConversationHydrationWindow,
    updateVisibleVirtualTurns,
    virtualRuntimeUnits,
  ]);

  const handleConversationTimelinePublished = useCallback(() => {
    conversationNavigation.attach(conversationTimelineRef.current);
    conversationPinRegistry.attach(virtualScrollerRef.current, conversationTimelineRef.current);
    conversationPinRegistry.sync(virtualRuntimeUnits);
    updateConversationHydrationWindow();
    scheduleTailReadinessCheck();
    if (autoScroll.snapshot.bootstrapCommitted) updateVisibleVirtualTurns(virtualScrollerRef.current);
  }, [
    autoScroll.snapshot.bootstrapCommitted,
    conversationNavigation,
    conversationPinRegistry,
    scheduleTailReadinessCheck,
    updateConversationHydrationWindow,
    updateVisibleVirtualTurns,
    virtualRuntimeUnits,
  ]);

  const handleVirtualPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (markNativeScrollbarDrag(event, event.currentTarget)) beginUserScrollInteraction();
      conversationNavigation.recordUserScroll();
    },
    [beginUserScrollInteraction, conversationNavigation, markNativeScrollbarDrag],
  );

  const handleUserWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;
    beginUserScrollInteraction();
    scheduleUserScrollSettled();
    conversationNavigation.recordUserScroll();
  }, [beginUserScrollInteraction, conversationNavigation, scheduleUserScrollSettled]);

  const setHoveredAgentTurnFooter = useCallback((footer: HTMLElement | null) => {
    const current = hoveredAgentTurnFooterRef.current;
    if (current === footer) return;
    current?.removeAttribute("data-agent-turn-hover");
    footer?.setAttribute("data-agent-turn-hover", "true");
    hoveredAgentTurnFooterRef.current = footer;
  }, []);

  const handleAgentTurnPointerOver = useCallback((event: PointerEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      setHoveredAgentTurnFooter(null);
      return;
    }
    const unit = target.closest<HTMLElement>("[data-conversation-unit-id][data-turn-index]");
    const unitKind = unit?.dataset.conversationUnitKind;
    if (
      !unit
      || !event.currentTarget.contains(unit)
      || unitKind === "user-markdown"
      || unitKind === "turn-shell"
    ) {
      setHoveredAgentTurnFooter(null);
      return;
    }
    const turnIndex = unit.dataset.turnIndex;
    const footerHost = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      '[data-conversation-unit-kind="footer"][data-turn-index]',
    )).find((candidate) => candidate.dataset.turnIndex === turnIndex);
    setHoveredAgentTurnFooter(
      footerHost?.querySelector<HTMLElement>('[data-testid="message-turn-footer"]') ?? null,
    );
  }, [setHoveredAgentTurnFooter]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const finishNativeScrollbarDrag = () => {
      if (!nativeScrollbarDragRef.current) {
        return;
      }
      nativeScrollbarDragRef.current = false;
      scheduleUserScrollSettled();
      window.requestAnimationFrame(() => {
        updateVisibleVirtualTurns(virtualScrollerRef.current);
      });
    };
    window.addEventListener("pointerup", finishNativeScrollbarDrag);
    window.addEventListener("pointercancel", finishNativeScrollbarDrag);
    window.addEventListener("blur", finishNativeScrollbarDrag);
    return () => {
      window.removeEventListener("pointerup", finishNativeScrollbarDrag);
      window.removeEventListener("pointercancel", finishNativeScrollbarDrag);
      window.removeEventListener("blur", finishNativeScrollbarDrag);
    };
  }, [scheduleUserScrollSettled, updateVisibleVirtualTurns]);

  useEffect(() => {
    if (loading || !canLoadOlder) {
      olderLoadArmedRef.current = false;
      olderLoadRequestedRef.current = false;
      olderLoadAnchorRef.current = null;
      setShowOlderTrigger(false);
    }
  }, [canLoadOlder, isProcessing, loading, visibleMessages[0]?.id]);

  useEffect(() => {
    if (conversationHydrationRef.current && hydrationSessionId) {
      conversationHydrationRef.current.switchSession(hydrationSessionId);
    }
    return () => {
      if (hydrationIdleRef.current !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(hydrationIdleRef.current);
        hydrationIdleRef.current = null;
      }
      if (hydrationTimeoutRef.current !== null) {
        window.clearTimeout(hydrationTimeoutRef.current);
        hydrationTimeoutRef.current = null;
      }
    };
  }, [hydrationSessionId]);

  useEffect(() => () => {
    conversationHydrationRef.current?.destroy();
    conversationHydrationRef.current = null;
    tailReadinessObserverRef.current?.disconnect();
    tailReadinessObserverRef.current = null;
    if (tailReadinessFrameRef.current !== null) cancelAnimationFrame(tailReadinessFrameRef.current);
    if (userScrollSettleTimerRef.current !== null) window.clearTimeout(userScrollSettleTimerRef.current);
    userScrollInteractionRef.current = false;
    conversationTimelineRef.current?.setUserScrollInteraction(false);
    conversationTimelineRef.current?.setControlledScrollInteraction(false);
  }, []);

  useEffect(() => {
    if (autoScroll.snapshot.bootstrapCommitted || !visibleMessages.length) {
      setShowTailBootstrapSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowTailBootstrapSkeleton(true), TAIL_BOOTSTRAP_SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoScroll.snapshot.bootstrapCommitted, conversationIdentity, visibleMessages.length]);

  useLayoutEffect(() => {
    if (!autoScroll.snapshot.bootstrapCommitted) {
      setVisibleTurnIndexesIfChanged(new Set());
      scheduleTailReadinessCheck();
      return;
    }
    updateVisibleVirtualTurns(virtualScrollerRef.current);
  }, [
    autoScroll.snapshot.bootstrapCommitted,
    scheduleTailReadinessCheck,
    setVisibleTurnIndexesIfChanged,
    updateVisibleVirtualTurns,
  ]);

  useLayoutEffect(() => {
    setVisibleTurnIndexes((current) => normalizeVisibleTurnIndexes(current, displayTurns.length));
  }, [displayTurns.length]);

  useLayoutEffect(() => {
    if (loadingOlder) {
      return;
    }
    const anchor = olderLoadAnchorRef.current;
    if (!anchor) {
      olderLoadRequestedRef.current = false;
      return;
    }
    const scroller = virtualScrollerRef.current;
    if (!scroller) {
      olderLoadAnchorRef.current = null;
      olderLoadRequestedRef.current = false;
      autoScroll.endHistoryRestore();
      return;
    }
    conversationNavigation.attach(conversationTimelineRef.current);
    conversationNavigation.completePrepend();
    olderLoadAnchorRef.current = null;
    olderLoadRequestedRef.current = false;
    autoScroll.endHistoryRestore();
  }, [autoScroll.endHistoryRestore, conversationNavigation, displayTurns.length, loadingOlder]);

  useEffect(() => {
    if (a2uiRenderSuspended) autoScroll.suspend("a2ui-render-resize");
    else autoScroll.resume("a2ui-render-resumed");
  }, [a2uiRenderSuspended, autoScroll.resume, autoScroll.suspend]);

  useEffect(() => {
    onScrollControlsChange?.({
      showScrollToBottom: scrollControls.showScrollToBottom,
      scrollToBottom: scrollToConversationBottom,
    });
  }, [onScrollControlsChange, scrollControls.showScrollToBottom, scrollToConversationBottom]);

  const clearTurnFlashTimers = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (flashTurnFrameRef.current !== null) {
      window.cancelAnimationFrame(flashTurnFrameRef.current);
      flashTurnFrameRef.current = null;
    }
    if (flashTurnTimeoutRef.current !== null) {
      window.clearTimeout(flashTurnTimeoutRef.current);
      flashTurnTimeoutRef.current = null;
    }
  }, []);

  const triggerTurnFlash = useCallback(
    (index: number) => {
      if (!turnNavigationRequest?.flash || index < 0 || index >= displayTurns.length) {
        return;
      }
      clearTurnFlashTimers();
      setFlashingTurnIndex(null);
      if (typeof window === "undefined") {
        setFlashingTurnIndex(index);
        return;
      }
      flashTurnFrameRef.current = window.requestAnimationFrame(() => {
        flashTurnFrameRef.current = null;
        setFlashingTurnIndex(index);
        flashTurnTimeoutRef.current = window.setTimeout(() => {
          flashTurnTimeoutRef.current = null;
          setFlashingTurnIndex((current) => (current === index ? null : current));
        }, TURN_FOCUS_FLASH_DURATION_MS);
      });
    },
    [clearTurnFlashTimers, displayTurns.length, turnNavigationRequest?.flash],
  );

  useEffect(() => () => clearTurnFlashTimers(), [clearTurnFlashTimers]);

  const navigateToTurn = useCallback(
    (index: number, request?: { requestId?: string | number; flash?: boolean }) => {
      if (index < 0 || index >= displayTurns.length) {
        return true;
      }
      onTurnNavigate?.(index);
      const unitId = timeline.turnUnitIds[index];
      if (!unitId) {
        return false;
      }
      autoScroll.beginNavigation();
      // A direct jump must not keep a second island of expensive A2UI DOM at
      // the tail. Release tail residency before mounting the destination;
      // normal residency is restored when the user returns to the bottom.
      conversationTimelineRef.current?.setResidentUnits(EMPTY_CONVERSATION_UNIT_IDS);
      const revealed = conversationNavigation.requestNavigation({
        requestId: request?.requestId ?? `turn-navigator:${++navigationRequestSequenceRef.current}`,
        unitId,
        align: "start",
        flash: request?.flash,
        source: request?.requestId === undefined ? "turn-navigator" : "external",
        onRevealed: () => {
          autoScroll.endNavigation();
          setVisibleTurnIndexesIfChanged(new Set([index]));
          if (request?.flash) triggerTurnFlash(index);
        },
      });
      return revealed;
    },
    [
      autoScroll.beginNavigation,
      autoScroll.endNavigation,
      conversationNavigation,
      displayTurns.length,
      onTurnNavigate,
      setVisibleTurnIndexesIfChanged,
      timeline.turnUnitIds,
      triggerTurnFlash,
    ],
  );

  useEffect(() => {
    if (externalTurnNavigationRequestId === undefined || loading || externalTurnNavigationIndex === null) {
      return;
    }
    const requestId = `external:${externalTurnNavigationRequestId}`;
    navigateToTurn(externalTurnNavigationIndex, {
      requestId,
      flash: turnNavigationRequest?.flash,
    });
    return () => {
      conversationNavigation.cancelNavigation(requestId);
    };
  }, [
    conversationNavigation,
    externalTurnNavigationIndex,
    externalTurnNavigationRequestId,
    loading,
    navigateToTurn,
    turnNavigationRequest?.flash,
  ]);

  const renderTimelineUnit = useCallback((unit: ConversationRenderUnit): ReactNode => {
    if (unit.id === "conversation-runtime:top") {
      return <div className={styles.timelineRuntimeTop}>{olderLoader}{renderedTopNotice}</div>;
    }
    if (unit.id === "conversation-runtime:bottom") {
      return <div className={styles.virtualBottomSpacer} aria-hidden="true" />;
    }
    const block = timeline.runtimeBlockByUnitId.get(unit.id);
    if (!block) return null;
    return renderConversationRuntimeUnit({
      unit,
      block,
      isLastTurn: block.type === "turn" && block.turnIndex === displayTurns.length - 1,
      focusFlash: block.type === "turn" && block.turnIndex === flashingTurnIndex,
      renderMessage,
      assistantTurnFooters,
      turnEndStreamingCursor,
      workspaceRuntime,
      workspaceScope,
      previewContext,
      onApprovalDecision,
      onResolveMcpElicitation,
      a2uiDebugInfoEnabled,
      a2uiRenderSuspended,
      a2uiPlaybackSuppressed: unit.kind === "a2ui"
        && unit.turnIndex !== null
        && unit.turnIndex < displayTurns.length - CONVERSATION_HOT_TAIL_TURNS,
      onA2UISubmit,
      onA2UICancel,
      onFilePreview,
      onLoadToolDetails,
      onTerminateCommand,
      onQuoteSelection,
      onAskSelectionInBtwConversation,
      onForkFromMessage,
      onNavigateToForkSource,
      showForkSourceMarkers,
      onReverseFromMessage,
      isProcessing,
    });
  }, [
    a2uiDebugInfoEnabled,
    a2uiRenderSuspended,
    assistantTurnFooters,
    displayTurns.length,
    flashingTurnIndex,
    isProcessing,
    olderLoader,
    onA2UICancel,
    onA2UISubmit,
    onApprovalDecision,
    onAskSelectionInBtwConversation,
    onFilePreview,
    onForkFromMessage,
    onLoadToolDetails,
    onNavigateToForkSource,
    onQuoteSelection,
    onResolveMcpElicitation,
    onReverseFromMessage,
    onTerminateCommand,
    previewContext,
    renderMessage,
    renderedTopNotice,
    showForkSourceMarkers,
    timeline.runtimeBlockByUnitId,
    turnEndStreamingCursor,
    workspaceRuntime,
    workspaceScope,
  ]);

  const messageListContent = (
    <ConversationTimelineSurface
      runtimeRef={conversationTimelineRef}
      units={virtualRuntimeUnits}
      residentUnitIds={residentTailUnitIds}
      className={`${styles.scroller} ${styles.virtualScroller}`}
      canvasClassName={`${styles.list} ${styles.virtualList} ${styles.timelineRuntimeCanvas}`}
      overscanPx={CONVERSATION_TIMELINE_OVERSCAN_PX}
      variant={variant}
      scrollerRef={setConversationTimelineScroller}
      onPointerDown={handleVirtualPointerDown}
      onScroll={handleVirtualScroll}
      onWheel={handleUserWheel}
      onPublished={handleConversationTimelinePublished}
      onViewportChanged={handleConversationViewportChanged}
      onScrollRequest={autoScroll.applyScrollRequest}
      followBottom={autoScroll.shouldFollowTail}
      renderUnit={renderTimelineUnit}
    />
  );

  const list = (
    <section
      className={styles.root}
      data-list-mode="virtual"
      data-follow-mode={autoScroll.snapshot.mode}
      data-follow-reason={autoScroll.snapshot.reason}
      data-tail-bootstrap={autoScroll.snapshot.bootstrapCommitted ? "committed" : "pending"}
      data-a2ui-count={a2uiRenderPressure.count}
      data-a2ui-live-count={a2uiRenderPressure.liveCount}
      data-a2ui-render-suspended={a2uiRenderSuspended ? "true" : "false"}
      data-a2ui-weight={a2uiRenderPressure.weight}
      data-message-list-variant={variant}
      data-performance-profile={performanceProfile}
      data-turn-navigator={showTurnNavigator ? "true" : "false"}
      data-testid="message-list"
      onPointerLeave={() => setHoveredAgentTurnFooter(null)}
      onPointerOver={handleAgentTurnPointerOver}
    >
      {loading && !visibleMessages.length ? (
        <div className={styles.scroller} data-message-list-variant={variant} data-testid="message-list-scroll">
          <MessageSkeleton />
        </div>
      ) : visibleMessages.length ? (
        messageListContent
      ) : (
        <div
          className={styles.scroller}
          data-empty-layout={renderedTopNotice ? undefined : emptyLayout}
          data-message-list-variant={variant}
          data-testid="message-list-scroll"
        >
          {renderedTopNotice ? (
            <div className={styles.list} role="list" aria-label="Messages">
              {renderedTopNotice}
              <div className={styles.empty} data-testid={emptyTestId}>
                {emptyText}
              </div>
            </div>
          ) : (
            <div className={styles.empty} data-testid={emptyTestId}>
              {emptyText}
            </div>
          )}
        </div>
      )}

      {visibleMessages.length ? (
        <ConversationScrollRail
          scrollElement={timelineScroller}
          onInteractionChange={handleControlledScrollbarInteraction}
        />
      ) : null}

      {visibleMessages.length && !autoScroll.snapshot.bootstrapCommitted && showTailBootstrapSkeleton ? (
        <div className={styles.bootstrapOverlay} data-testid="message-list-tail-bootstrap">
          <MessageSkeleton />
        </div>
      ) : null}

      {scrollButtonMode === "inline" && scrollControls.showScrollToBottom ? (
        <button
          className={styles.scrollButton}
          type="button"
          aria-label="滚动到底"
          onClick={() => scrollToConversationBottom()}
        >
          <ArrowDown size={15} />
          <span>滚动到底</span>
        </button>
      ) : null}

      {visibleMessages.length && showTurnNavigator ? (
        <ConversationTurnNavigator
          turns={turnNavigationItems}
          highlightedIndexes={highlightedTurnNavigationIndexes}
          onNavigate={navigateToTurn}
        />
      ) : null}
    </section>
  );

  return list;
}


function renderOlderLoader({
  canLoadOlder,
  loadingOlder,
  showTrigger,
}: {
  canLoadOlder: boolean;
  loadingOlder: boolean;
  showTrigger: boolean;
}): ReactNode {
  if (!canLoadOlder && !loadingOlder) {
    return null;
  }
  return (
    <div
      className={styles.olderLoader}
      data-loading={loadingOlder ? "true" : "false"}
      data-visible={loadingOlder || showTrigger ? "true" : "false"}
    >
      {loadingOlder ? "加载更早对话..." : showTrigger ? "继续上滑加载更早对话" : ""}
    </div>
  );
}

function renderTopNotice(notice: MessageListTopNotice | null): ReactNode {
  if (!notice) {
    return null;
  }
  const state = notice.tone === "success" ? "success" : "completed";
  return (
    <div
      className={`${styles.contextCompressionNotice} ${styles.topNotice}`}
      data-state={state}
      data-testid={notice.testId ?? "message-list-top-notice"}
      role="status"
      aria-live="polite"
      title={notice.title}
    >
      <span className={styles.contextCompressionNoticeLabel}>
        <span>{notice.content}</span>
      </span>
    </div>
  );
}

function renderConversationRuntimeUnit({
  unit,
  block,
  isLastTurn,
  focusFlash,
  renderMessage,
  assistantTurnFooters,
  turnEndStreamingCursor,
  workspaceRuntime,
  workspaceScope,
  previewContext,
  onApprovalDecision,
  onResolveMcpElicitation,
  a2uiDebugInfoEnabled,
  a2uiRenderSuspended,
  a2uiPlaybackSuppressed,
  onA2UISubmit,
  onA2UICancel,
  onFilePreview,
  onLoadToolDetails,
  onTerminateCommand,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onForkFromMessage,
  onNavigateToForkSource,
  showForkSourceMarkers,
  onReverseFromMessage,
  isProcessing,
}: {
  unit: ConversationRenderUnit;
  block: TimelineBlock;
  isLastTurn: boolean;
  focusFlash: boolean;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  assistantTurnFooters: AssistantTurnFooters;
  turnEndStreamingCursor: TurnEndStreamingCursor;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  previewContext?: PreviewContextValue | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onResolveMcpElicitation?: McpElicitationResolveHandler;
  a2uiDebugInfoEnabled: boolean;
  a2uiRenderSuspended: boolean;
  a2uiPlaybackSuppressed: boolean;
  onA2UISubmit?: A2UISubmitHandler;
  onA2UICancel?: A2UICancelHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string, comment?: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onForkFromMessage?: (message: ConversationMessage) => void;
  onNavigateToForkSource?: (fork: AgentSessionFork) => void;
  showForkSourceMarkers: boolean;
  onReverseFromMessage?: (message: ConversationMessage) => void;
  isProcessing: boolean;
}): ReactNode {
  if (block.type === "event") {
    if (!unit.item) return null;
    return (
      <div
        className={`${styles.item} ${styles.runtimeUnitItem}`}
        data-kind={block.kind}
        data-testid="message-timeline-event"
        role="listitem"
      >
        {renderMessageItem({
          item: unit.item,
          renderMessage,
          showTurnEndStreamingCursor: false,
          streamingCursorActivityKey: "",
          streamingCursorShowImmediately: false,
          suppressStreamingCursorMessageIds: new Set(),
          workspaceRuntime,
          workspaceScope,
          previewContext,
          onApprovalDecision,
          onResolveMcpElicitation,
          a2uiDebugInfoEnabled,
          a2uiRenderSuspended,
          a2uiPlaybackSuppressed,
          onA2UISubmit,
          onA2UICancel,
          onFilePreview,
          onLoadToolDetails,
          onTerminateCommand,
          onQuoteSelection,
          onAskSelectionInBtwConversation,
          onForkFromMessage,
          onNavigateToForkSource,
          showForkSourceMarkers,
          onReverseFromMessage,
        })}
      </div>
    );
  }

  const turn = block.turn;
  if (unit.kind === "turn-shell") {
    return (
      <div className={styles.runtimeTurnShell} aria-hidden={turn.showThreadTaskContinuationNotice ? undefined : "true"}>
        {turn.showThreadTaskContinuationNotice ? (
          <div className={`${styles.item} ${styles.runtimeUnitItem}`} data-kind="thread_task_continue" role="listitem">
            <ThreadTaskContinuationNotice />
          </div>
        ) : null}
      </div>
    );
  }

  if (unit.kind === "footer") {
    const anchorItemId = lastFooterAnchorItemId(turn.items);
    const turnFooter = anchorItemId ? assistantTurnFooters.footerByItemId.get(anchorItemId) : undefined;
    const processingStartedAt = anchorItemId
      ? assistantTurnFooters.processingStartByItemId.get(anchorItemId)
      : undefined;
    const showCursor = Boolean(anchorItemId && turnEndStreamingCursor.cursorAfterItemIds.has(anchorItemId));
    return (
      <div className={styles.runtimeTurnFooter} data-testid="message-turn-footer">
        {withTurnProcessingDuration(
          withTurnEndStreamingCursor(
            withTurnActionFooter(
              null,
              turnFooter,
              onForkFromMessage,
              onReverseFromMessage,
              onNavigateToForkSource,
              showForkSourceMarkers,
            ),
            showCursor,
            turnEndStreamingCursor.activityKey,
            turnEndStreamingCursor.showImmediately,
          ),
          processingStartedAt,
        )}
      </div>
    );
  }

  if (unit.kind === "task-status") {
    const firstStatusItem = turn.items.find(isThreadTaskStatusItem);
    if (unit.item?.id !== firstStatusItem?.id || (isProcessing && isLastTurn)) {
      return <div className={styles.runtimeTurnShell} aria-hidden="true" />;
    }
    const statusMessages = threadTaskStatusMessagesFromTurn(turn);
    return (
      <div
        className={`${styles.item} ${styles.runtimeUnitItem}`}
        data-kind="thread_task_status_summary"
        data-testid="thread-task-status-summary"
        role="listitem"
      >
        {statusMessages.map((message) => <ThreadTaskStatusBlock message={message} key={message.id} />)}
      </div>
    );
  }

  if (!unit.item) return <div className={styles.runtimeTurnShell} aria-hidden="true" />;
  const renderableItems = turn.items.filter((item) => !isThreadTaskStatusItem(item) && !isTurnMarkerItem(item));
  const focusAssistantItemId = focusFlash ? findLastAssistantItemId(renderableItems) : null;
  return (
    <div
      className={`${styles.item} ${styles.runtimeUnitItem}`}
      data-focus-flash={unit.item.id === focusAssistantItemId ? "true" : undefined}
      data-kind={itemKind(unit.item)}
      role="listitem"
    >
      {renderMessageItem({
        item: unit.item,
        renderMessage,
        showTurnEndStreamingCursor: false,
        streamingCursorActivityKey: "",
        streamingCursorShowImmediately: false,
        suppressStreamingCursorMessageIds: turnEndStreamingCursor.suppressedMessageIds,
        workspaceRuntime,
        workspaceScope,
        previewContext,
        onApprovalDecision,
        onResolveMcpElicitation,
        a2uiDebugInfoEnabled,
        a2uiRenderSuspended,
        a2uiPlaybackSuppressed,
        onA2UISubmit,
        onA2UICancel,
        onFilePreview,
        onLoadToolDetails,
        onTerminateCommand,
        onQuoteSelection,
        onAskSelectionInBtwConversation,
        onForkFromMessage,
        onNavigateToForkSource,
        showForkSourceMarkers,
        onReverseFromMessage,
      })}
    </div>
  );
}

function renderMessageTurn({
  turn,
  hideThreadTaskStatusSummary = false,
  focusFlash = false,
  renderMessage,
  assistantTurnFooters,
  turnEndStreamingCursor,
  workspaceRuntime,
  workspaceScope,
  previewContext,
  onApprovalDecision,
  onResolveMcpElicitation,
  a2uiDebugInfoEnabled,
  a2uiRenderSuspended,
  onA2UISubmit,
  onA2UICancel,
  onFilePreview,
  onLoadToolDetails,
  onTerminateCommand,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onForkFromMessage,
  onNavigateToForkSource,
  showForkSourceMarkers,
  onReverseFromMessage,
}: {
  turn: MessageTurn;
  hideThreadTaskStatusSummary?: boolean;
  focusFlash?: boolean;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  assistantTurnFooters: AssistantTurnFooters;
  turnEndStreamingCursor: TurnEndStreamingCursor;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  previewContext?: PreviewContextValue | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onResolveMcpElicitation?: McpElicitationResolveHandler;
  a2uiDebugInfoEnabled: boolean;
  a2uiRenderSuspended: boolean;
  onA2UISubmit?: A2UISubmitHandler;
  onA2UICancel?: A2UICancelHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string, comment?: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onForkFromMessage?: (message: ConversationMessage) => void;
  onNavigateToForkSource?: (fork: AgentSessionFork) => void;
  showForkSourceMarkers: boolean;
  onReverseFromMessage?: (message: ConversationMessage) => void;
}) {
  const statusMessages = hideThreadTaskStatusSummary ? [] : threadTaskStatusMessagesFromTurn(turn);
  const renderableItems = turn.items.filter((item) => !isThreadTaskStatusItem(item) && !isTurnMarkerItem(item));
  const focusAssistantItemId = focusFlash ? findLastAssistantItemId(renderableItems) : null;
  const renderedItems = renderableItems.map((item) => (
    <div
      className={styles.item}
      data-focus-flash={item.id === focusAssistantItemId ? "true" : undefined}
      data-kind={itemKind(item)}
      role="listitem"
      key={item.id}
    >
      {renderMessageItem({
        item,
        renderMessage,
        turnFooter: assistantTurnFooters.footerByItemId.get(item.id),
        processingStartedAt: assistantTurnFooters.processingStartByItemId.get(item.id),
        showTurnEndStreamingCursor: turnEndStreamingCursor.cursorAfterItemIds.has(item.id),
        streamingCursorActivityKey: turnEndStreamingCursor.activityKey,
        streamingCursorShowImmediately: turnEndStreamingCursor.showImmediately,
        suppressStreamingCursorMessageIds: turnEndStreamingCursor.suppressedMessageIds,
        workspaceRuntime,
        workspaceScope,
        previewContext,
        onApprovalDecision,
        onResolveMcpElicitation,
        a2uiDebugInfoEnabled,
        a2uiRenderSuspended,
        onA2UISubmit,
        onA2UICancel,
        onFilePreview,
        onLoadToolDetails,
        onTerminateCommand,
        onQuoteSelection,
        onAskSelectionInBtwConversation,
        onForkFromMessage,
        onNavigateToForkSource,
        showForkSourceMarkers,
        onReverseFromMessage,
      })}
    </div>
  ));
  const summaryItem = statusMessages.length ? (
    <div
      className={styles.item}
      data-kind="thread_task_status_summary"
      data-testid="thread-task-status-summary"
      role="listitem"
      key={`${turn.id}:thread-task-status-summary`}
    >
      {statusMessages.map((message) => (
        <ThreadTaskStatusBlock message={message} key={message.id} />
      ))}
    </div>
  ) : null;
  const turnItems = summaryItem ? [...renderedItems, summaryItem] : renderedItems;
  if (!turn.showThreadTaskContinuationNotice) {
    return turnItems;
  }
  return [
    <div
      className={styles.item}
      data-kind="thread_task_continue"
      role="listitem"
      key={`${turn.id}:thread-task-continue`}
    >
      <ThreadTaskContinuationNotice />
    </div>,
    ...turnItems,
  ];
}

function renderMessageItem({
  item,
  renderMessage,
  turnFooter,
  processingStartedAt,
  showTurnEndStreamingCursor,
  streamingCursorActivityKey,
  streamingCursorShowImmediately,
  suppressStreamingCursorMessageIds,
  workspaceRuntime,
  workspaceScope,
  previewContext,
  onApprovalDecision,
  onResolveMcpElicitation,
  a2uiDebugInfoEnabled,
  a2uiRenderSuspended,
  a2uiPlaybackSuppressed = false,
  onA2UISubmit,
  onA2UICancel,
  onFilePreview,
  onLoadToolDetails,
  onTerminateCommand,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onForkFromMessage,
  onNavigateToForkSource,
  showForkSourceMarkers,
  onReverseFromMessage,
}: {
  item: ProcessedMessageItem;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  turnFooter?: AssistantTurnFooter;
  processingStartedAt?: string;
  showTurnEndStreamingCursor: boolean;
  streamingCursorActivityKey: string;
  streamingCursorShowImmediately: boolean;
  suppressStreamingCursorMessageIds: Set<string>;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  previewContext?: PreviewContextValue | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onResolveMcpElicitation?: McpElicitationResolveHandler;
  a2uiDebugInfoEnabled: boolean;
  a2uiRenderSuspended: boolean;
  a2uiPlaybackSuppressed?: boolean;
  onA2UISubmit?: A2UISubmitHandler;
  onA2UICancel?: A2UICancelHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string, comment?: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onForkFromMessage?: (message: ConversationMessage) => void;
  onNavigateToForkSource?: (fork: AgentSessionFork) => void;
  showForkSourceMarkers: boolean;
  onReverseFromMessage?: (message: ConversationMessage) => void;
}) {
  if (item.type === "message") {
    const renderedMessage = renderMessage ? (
      renderMessage(item.message)
    ) : (
      <DefaultMessage
        message={item.message}
        webSourceRegistry={item.webSourceRegistry}
        suppressStreamingCursor={suppressStreamingCursorMessageIds.has(item.message.id)}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={workspaceScope}
        previewContext={previewContext}
        onApprovalDecision={onApprovalDecision}
        onResolveMcpElicitation={onResolveMcpElicitation}
        a2uiDebugInfoEnabled={a2uiDebugInfoEnabled}
        a2uiRenderSuspended={a2uiRenderSuspended}
        a2uiPlaybackSuppressed={a2uiPlaybackSuppressed}
        onA2UISubmit={onA2UISubmit}
        onA2UICancel={onA2UICancel}
        onFilePreview={onFilePreview}
        onLoadToolDetails={onLoadToolDetails}
        onTerminateCommand={onTerminateCommand}
        onQuoteSelection={onQuoteSelection}
        onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
        onReverseFromMessage={onReverseFromMessage}
      />
    );
    return withTurnProcessingDuration(
      withTurnEndStreamingCursor(
        withTurnActionFooter(
          renderedMessage,
          turnFooter,
          onForkFromMessage,
          onReverseFromMessage,
          onNavigateToForkSource,
          showForkSourceMarkers,
        ),
        showTurnEndStreamingCursor,
        streamingCursorActivityKey,
        streamingCursorShowImmediately,
      ),
      processingStartedAt,
    );
  }

  const renderedGroup = (
    <MessageGroupBlock
      count={item.messages.length}
      groupKind={item.groupKind}
      messages={item.messages}
      sourceMessageIds={item.sourceMessageIds}
    >
      {item.messages.map((message) => (
        <DefaultMessage
          message={message}
          webSourceRegistry={item.webSourceRegistry}
          workspaceRuntime={workspaceRuntime}
          workspaceScope={workspaceScope}
          previewContext={previewContext}
          onApprovalDecision={onApprovalDecision}
          onResolveMcpElicitation={onResolveMcpElicitation}
          onA2UISubmit={onA2UISubmit}
          onA2UICancel={onA2UICancel}
          onFilePreview={onFilePreview}
          onLoadToolDetails={onLoadToolDetails}
          onTerminateCommand={onTerminateCommand}
          onQuoteSelection={onQuoteSelection}
          onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
          onReverseFromMessage={onReverseFromMessage}
          key={message.id}
        />
      ))}
    </MessageGroupBlock>
  );
  return withTurnProcessingDuration(
    withTurnEndStreamingCursor(
      withTurnActionFooter(
        renderedGroup,
        turnFooter,
        onForkFromMessage,
        onReverseFromMessage,
        onNavigateToForkSource,
        showForkSourceMarkers,
      ),
      showTurnEndStreamingCursor,
      streamingCursorActivityKey,
      streamingCursorShowImmediately,
    ),
    processingStartedAt,
  );
}

function withTurnActionFooter(
  content: ReactNode,
  turnFooter?: AssistantTurnFooter,
  onForkFromMessage?: (message: ConversationMessage) => void,
  onReverseFromMessage?: (message: ConversationMessage) => void,
  onNavigateToForkSource?: (fork: AgentSessionFork) => void,
  showForkSourceMarkers = true,
) {
  if (!turnFooter) {
    return content;
  }
  const { message, copyContent } = turnFooter;
  const forkSource = forkSourceFromMessage(message);
  return (
    <>
      {content}
      <div className={styles.turnActionRow}>
        <MessageActionFooter
          message={message}
          copyContent={copyContent}
          placement="turn"
          onForkFromMessage={onForkFromMessage}
          onReverseFromMessage={onReverseFromMessage}
        />
      </div>
      {forkSource && showForkSourceMarkers ? (
        <ForkMarker fork={forkSource} onNavigateToForkSource={onNavigateToForkSource} />
      ) : null}
    </>
  );
}

function ForkMarker({
  fork,
  onNavigateToForkSource,
}: {
  fork: AgentSessionFork;
  onNavigateToForkSource?: (fork: AgentSessionFork) => void;
}) {
  return (
    <div
      className={`${styles.contextCompressionNotice} ${styles.forkMarker}`}
      data-state="fork"
      data-testid="message-fork-marker"
      title="从源会话中派生"
    >
      <span className={styles.contextCompressionNoticeLabel}>
        <span>
          从「
          {onNavigateToForkSource ? (
            <button
              className={styles.forkSourceButton}
              type="button"
              aria-label="查看源会话"
              onClick={() => onNavigateToForkSource(fork)}
            >
              源会话
            </button>
          ) : (
            <span>源会话</span>
          )}
          」中派生
        </span>
      </span>
    </div>
  );
}

function forkSourceFromMessage(message: ConversationMessage): AgentSessionFork | null {
  const value = message.payload.forkSource;
  return isSessionFork(value) ? value : null;
}

function isSessionFork(value: unknown): value is AgentSessionFork {
  if (!value || typeof value !== "object") {
    return false;
  }
  const fork = value as Partial<AgentSessionFork>;
  return (
    typeof fork.id === "string" &&
    typeof fork.source_session_id === "string" &&
    typeof fork.target_session_id === "string" &&
    typeof fork.source_message_event_id === "string" &&
    typeof fork.target_message_event_id === "string"
  );
}

function withTurnEndStreamingCursor(
  content: ReactNode,
  showCursor: boolean,
  activityKey: string,
  showImmediately: boolean,
) {
  if (!showCursor) {
    return content;
  }
  return (
    <>
      {content}
      <TurnEndStreamingCursor activityKey={activityKey} showImmediately={showImmediately} />
    </>
  );
}

function TurnEndStreamingCursor({
  activityKey,
  showImmediately,
}: {
  activityKey: string;
  showImmediately: boolean;
}) {
  const previousActivityKeyRef = useRef<string | null>(null);
  const [visible, setVisible] = useState(showImmediately);

  useLayoutEffect(() => {
    const firstActivity = previousActivityKeyRef.current === null;
    if (!firstActivity && previousActivityKeyRef.current === activityKey) {
      return;
    }
    previousActivityKeyRef.current = activityKey;
    if (firstActivity && showImmediately) {
      return;
    }
    setVisible(false);
    const timeoutId = window.setTimeout(() => setVisible(true), STREAMING_CURSOR_IDLE_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [activityKey, showImmediately]);

  return (
    <div
      className={styles.turnEndStreamingCursor}
      data-streaming-cursor-visible={visible ? "true" : "false"}
      data-testid="turn-end-streaming-cursor"
    >
      <StreamingCursor />
    </div>
  );
}

function withTurnProcessingDuration(content: ReactNode, startedAt?: string) {
  if (!startedAt) {
    return content;
  }
  return (
    <>
      {content}
      <div className={styles.turnProcessingRow}>
        <ProcessingDuration startedAt={startedAt} live />
      </div>
    </>
  );
}

function DefaultMessage({
  message,
  suppressStreamingCursor = false,
  workspaceRuntime,
  workspaceScope,
  previewContext,
  onApprovalDecision,
  onResolveMcpElicitation,
  a2uiDebugInfoEnabled,
  a2uiRenderSuspended,
  a2uiPlaybackSuppressed,
  onA2UISubmit,
  onA2UICancel,
  onFilePreview,
  onLoadToolDetails,
  onTerminateCommand,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onReverseFromMessage,
  webSourceRegistry,
}: {
  message: ConversationMessage;
  suppressStreamingCursor?: boolean;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  previewContext?: PreviewContextValue | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onResolveMcpElicitation?: McpElicitationResolveHandler;
  a2uiDebugInfoEnabled?: boolean;
  a2uiRenderSuspended?: boolean;
  a2uiPlaybackSuppressed?: boolean;
  onA2UISubmit?: A2UISubmitHandler;
  onA2UICancel?: A2UICancelHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string, comment?: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onReverseFromMessage?: (message: ConversationMessage) => void;
  webSourceRegistry?: import("./webSourceRegistry").WebTurnSourceRegistry;
}) {
  if (message.kind === "thinking") {
    return <MessageThinking message={message} />;
  }
  if (message.kind === "tool") {
    return <ToolCallBlock message={message} onPreviewFile={onFilePreview} onLoadDetails={onLoadToolDetails} />;
  }
  if (message.kind === "web_activity") {
    return webActivityFromMessage(message) ? (
      <WebActivityBlock message={message} />
    ) : (
      <ToolCallBlock message={message} onPreviewFile={onFilePreview} onLoadDetails={onLoadToolDetails} />
    );
  }
  if (message.kind === "skill") {
    return (
      <SkillActivationBlock
        message={message}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={workspaceScope}
        previewContextOverride={previewContext}
        onQuoteSelection={onQuoteSelection}
      />
    );
  }
  if (message.kind === "thread_task_status") {
    return <ThreadTaskStatusBlock message={message} />;
  }
  if (message.kind === "command") {
    return (
      <CommandExecutionBlock
        message={message}
        onLoadDetails={onLoadToolDetails}
        onTerminateCommand={onTerminateCommand}
      />
    );
  }
  if (message.kind === "file_change") {
    return <FileChangeBlock message={message} onPreviewFile={onFilePreview} onLoadDetails={onLoadToolDetails} />;
  }
  if (message.kind === "approval") {
    return <ApprovalPrompt message={message} onDecision={onApprovalDecision} />;
  }
  if (message.kind === "mcp_elicitation") {
    return <McpElicitationPrompt message={message} onResolve={onResolveMcpElicitation} />;
  }
  if (message.kind === "a2ui") {
    return (
      <A2UIBlock
        message={message}
        debugInfoEnabled={a2uiDebugInfoEnabled}
        renderSuspended={a2uiRenderSuspended}
        playbackSuppressed={a2uiPlaybackSuppressed}
        onSubmit={onA2UISubmit}
        onCancel={onA2UICancel}
      />
    );
  }
  if (message.kind === "error") {
    return <ErrorItem message={message} />;
  }
  if (message.kind === "context_compression") {
    return <ContextCompressionNotice message={message} />;
  }
  if (message.kind === "turn_marker") {
    return null;
  }
  if (message.kind === "llm_retry") {
    return <LLMRetryNotice message={message} />;
  }
  if (message.kind === "cancelled") {
    return <ConversationCancelledNotice />;
  }
  return (
    <MessageText
      message={message}
      showActionRow={message.kind !== "assistant"}
      suppressStreamingCursor={suppressStreamingCursor}
      workspaceRuntime={workspaceRuntime}
      workspaceScope={workspaceScope}
      previewContextOverride={previewContext}
      onQuoteSelection={onQuoteSelection}
      onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
      onReverseFromMessage={onReverseFromMessage}
      webSourceRegistry={webSourceRegistry}
    />
  );
}

function ConversationCancelledNotice() {
  return (
    <div
      className={styles.contextCompressionNotice}
      data-state="cancelled"
      data-testid="conversation-cancelled-notice"
      role="status"
      aria-live="polite"
    >
      <span className={styles.contextCompressionNoticeLabel}>对话已取消</span>
    </div>
  );
}

function ContextCompressionNotice({ message }: { message: ConversationMessage }) {
  const state = message.status === "running" ? "running" : message.status === "failed" ? "failed" : "completed";
  const showLoading = isContextCompressionLoadingNotice(message);
  return (
    <div
      className={styles.contextCompressionNotice}
      data-state={state}
      data-testid="context-compression-notice"
      role="status"
      aria-live="polite"
    >
      <span className={styles.contextCompressionNoticeLabel}>
        {showLoading ? <AgentLoadingIcon className={styles.contextCompressionNoticeSpinner} size={12} /> : null}
        <span>{normalizeMessageContent(message.content)}</span>
      </span>
    </div>
  );
}

function isContextCompressionLoadingNotice(message: ConversationMessage): boolean {
  const metadata = message.payload.metadata;
  const compression =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as { compression?: unknown }).compression
      : null;
  if (!compression || typeof compression !== "object" || Array.isArray(compression)) {
    return isRunningCompressionText(message);
  }
  const stage = (compression as { stage?: unknown }).stage;
  return (
    message.status === "running" &&
    (isRunningCompressionStage(stage) || isRunningCompressionText(message))
  );
}

function isRunningCompressionStage(stage: unknown): boolean {
  return stage === "compression_started";
}

function isRunningCompressionText(message: ConversationMessage): boolean {
  const content = normalizeMessageContent(message.content);
  return message.status === "running" && content.startsWith("正在") && content.includes("压缩");
}

function LLMRetryNotice({ message }: { message: ConversationMessage }) {
  const state = message.status === "running" ? "running" : message.status === "failed" ? "failed" : "completed";
  return (
    <div
      className={styles.contextCompressionNotice}
      data-notice-kind="llm_retry"
      data-state={state}
      data-testid="llm-retry-notice"
      role="status"
      aria-live="polite"
    >
      <span className={styles.contextCompressionNoticeLabel}>
        <span>{normalizeMessageContent(message.content)}</span>
      </span>
    </div>
  );
}

function ThreadTaskContinuationNotice() {
  return (
    <div
      className={styles.contextCompressionNotice}
      data-notice-kind="thread_task_continue"
      data-state="completed"
      data-testid="thread-task-continuation-notice"
      role="status"
      aria-live="polite"
    >
      <span className={styles.contextCompressionNoticeLabel}>
        <span>目标继续执行</span>
      </span>
    </div>
  );
}

function itemKind(item: ProcessedMessageItem): ConversationMessage["kind"] | string {
  return item.type === "message" ? item.message.kind : item.groupKind;
}

interface A2UIRenderPressure {
  count: number;
  liveCount: number;
  weight: number;
}

function calculateA2UIRenderPressure(blocks: TimelineBlock[]): A2UIRenderPressure {
  let count = 0;
  let liveCount = 0;
  let weight = 0;
  for (const block of blocks) {
    const messages =
      block.type === "event"
        ? messagesFromProcessedItem(block.item)
        : block.turn.items.flatMap(messagesFromProcessedItem);
    for (const message of messages) {
      if (message.kind !== "a2ui") {
        continue;
      }
      count += 1;
      if (isLiveA2UIStreamMessage(message)) {
        liveCount += 1;
      }
      weight += a2uiMessageRenderWeight(message);
    }
  }
  return { count, liveCount, weight };
}

function a2uiMessageRenderWeight(message: ConversationMessage): number {
  const renderKey = a2uiMessageRenderKey(message);
  if (renderKey === "chart") {
    const chartCount = a2uiChartCount(message);
    const dataUnits = a2uiChartDataUnitCount(message);
    return Math.max(3, chartCount * 2 + Math.ceil(dataUnits / 16));
  }
  if (renderKey === "choice" || renderKey === "form") {
    return 2;
  }
  if (renderKey === "table") {
    const payload = a2uiChartPayload(message);
    return Math.max(3, 2 + Math.ceil(arrayLength(payload?.rows) / 40) + Math.ceil(arrayLength(payload?.columns) / 8));
  }
  return 1;
}

function a2uiMessageRenderKey(message: ConversationMessage): string {
  const a2ui = recordValue(message.payload.a2ui);
  const debug = recordValue(message.payload.a2uiDebug);
  return (
    stringRecordValue(message.payload.renderKey) ||
    stringRecordValue(message.payload.render_key) ||
    stringRecordValue(a2ui?.render_key) ||
    stringRecordValue(debug?.renderKey) ||
    stringRecordValue(debug?.render_key)
  );
}

function a2uiChartCount(message: ConversationMessage): number {
  const payload = a2uiChartPayload(message);
  const charts = payload?.charts;
  return Array.isArray(charts) && charts.length ? charts.length : 1;
}

function a2uiChartDataUnitCount(message: ConversationMessage): number {
  const charts = a2uiChartPayload(message)?.charts;
  if (!Array.isArray(charts)) {
    return 0;
  }
  return charts.reduce((total, chart) => total + chartDataUnitCount(recordValue(chart)), 0);
}

function a2uiChartPayload(message: ConversationMessage): Record<string, unknown> | null {
  const a2ui = recordValue(message.payload.a2ui);
  const debug = recordValue(message.payload.a2uiDebug);
  return (
    recordValue(a2ui?.payload) ??
    recordValue(debug?.payload) ??
    recordValue(debug?.parsedArgs) ??
    recordValue(message.payload.payload)
  );
}

function chartDataUnitCount(chart: Record<string, unknown> | null): number {
  if (!chart) {
    return 0;
  }
  const series = Array.isArray(chart.series) ? chart.series : [];
  const seriesUnits = series.reduce((total, item) => {
    const record = recordValue(item);
    return total + Math.max(
      arrayLength(record?.items),
      arrayLength(record?.data),
      arrayLength(record?.values),
    );
  }, 0);
  const structuralUnits = arrayLength(chart.nodes) + arrayLength(chart.links);
  const directUnits = Math.max(
    arrayLength(chart.items),
    arrayLength(chart.points),
    arrayLength(chart.data),
    arrayLength(chart.values),
  );
  return Math.max(seriesUnits, directUnits, structuralUnits);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function conversationSessionIdentity(messages: ConversationMessage[]): string {
  const sessionIdentity = messages
    .map((message) => (
      stringRecordValue(message.threadId) ||
      stringRecordValue(message.payload.sessionId) ||
      stringRecordValue(message.payload.session_id)
    ))
    .find(Boolean);
  return sessionIdentity || messages[0]?.id || "empty";
}

function isNativeScrollbarPointerStart(
  event: { clientX: number; clientY: number },
  scroller: HTMLElement,
): boolean {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    return false;
  }
  const scrollbarInlineSize = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
  if (scrollbarInlineSize <= 0) {
    return false;
  }
  const rect = scroller.getBoundingClientRect();
  const edgeSize = Math.max(12, Math.min(24, scrollbarInlineSize));
  return event.clientX >= rect.right - edgeSize && event.clientX <= rect.right;
}

function clampTurnIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), count - 1);
}

function normalizeVisibleTurnIndexes(indexes: Set<number>, count: number): Set<number> {
  if (count <= 0) {
    return new Set();
  }
  const normalized = new Set<number>();
  indexes.forEach((index) => {
    if (index >= 0 && index < count) {
      normalized.add(index);
    }
  });
  return areNumberSetsEqual(indexes, normalized) ? indexes : normalized;
}

function areNumberSetsEqual(left: Set<number>, right: Set<number>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export function visibleTurnIndexesFromMountedTurns(scroller: HTMLElement | null, turnCount: number): Set<number> {
  const visibleIndexes = new Set<number>();
  if (!scroller || turnCount <= 0) {
    return visibleIndexes;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  if (scrollerRect.height <= 0) {
    return visibleIndexes;
  }

  const mountedTurns = Array.from(scroller.querySelectorAll<HTMLElement>("[data-turn-index]"));
  for (const turn of mountedTurns) {
    const turnIndex = Number(turn.dataset.turnIndex ?? turn.dataset.index);
    if (!Number.isInteger(turnIndex)) {
      continue;
    }
    const turnRect = turn.getBoundingClientRect();
    if (turnRect.bottom > scrollerRect.top && turnRect.top < scrollerRect.bottom) {
      visibleIndexes.add(clampTurnIndex(turnIndex, turnCount));
    }
  }

  return visibleIndexes;
}

export function buildTurnNavigationItemsFromMessages(messages: ConversationMessage[]): ConversationTurnNavigationItem[] {
  return buildTurnNavigationItems(buildConversationTimeline(processMessages(messages)).turns);
}

function findVisibleTurnNavigationIndexes(
  items: ConversationTurnNavigationItem[],
  visibleTurnIndexes: Set<number>,
): number[] {
  if (!items.length || !visibleTurnIndexes.size) {
    return [];
  }
  const visibleNavigationIndexes: number[] = [];
  items.forEach((item, index) => {
    if (visibleTurnIndexes.has(item.targetIndex)) {
      visibleNavigationIndexes.push(index);
    }
  });
  return visibleNavigationIndexes;
}

type MessageTurn = ConversationRenderTurn;

interface ConversationTimeline {
  blocks: TimelineBlock[];
  turns: MessageTurn[];
  turnBlockIndexes: number[];
  runtimeUnits: readonly ConversationRenderUnit[];
  runtimeBlockByUnitId: ReadonlyMap<string, TimelineBlock>;
  turnUnitIds: readonly string[];
}

type TimelineBlock =
  | {
      type: "turn";
      id: string;
      turn: MessageTurn;
      turnIndex: number;
    }
  | {
      type: "event";
      id: string;
      item: ProcessedMessageItem;
      kind: ConversationMessage["kind"] | string;
    };

interface AssistantTurnFooters {
  footerByItemId: Map<string, AssistantTurnFooter>;
  processingStartByItemId: Map<string, string>;
}

interface AssistantTurnFooter {
  message: ConversationMessage;
  copyContent: string;
}

interface TurnEndStreamingCursor {
  suppressedMessageIds: Set<string>;
  cursorAfterItemIds: Set<string>;
  activityKey: string;
  showImmediately: boolean;
}

function buildConversationTimeline(displayItems: ProcessedMessageItem[]): ConversationTimeline {
  const projection = projectConversationRenderUnits(displayItems);
  const blocks: TimelineBlock[] = projection.segments.map((segment) => segment.type === "event"
    ? {
        type: "event" as const,
        id: segment.id,
        item: segment.item,
        kind: itemKind(segment.item),
      }
    : {
        type: "turn" as const,
        id: segment.id,
        turn: segment.turn,
        turnIndex: segment.turnIndex,
      });
  const turns: MessageTurn[] = [...projection.turns];
  const turnBlockIndexes: number[] = [];
  blocks.forEach((block, blockIndex) => {
    if (block.type === "turn") turnBlockIndexes[block.turnIndex] = blockIndex;
  });
  const runtimeBlockByUnitId = new Map<string, TimelineBlock>();
  const turnUnitIds: string[] = [];
  const turnUnitPriorities: number[] = [];
  for (const unit of projection.units) {
    const block = unit.turnIndex === null
      ? blocks.find((candidate) => candidate.type === "event" && candidate.item.id === unit.item?.id)
      : blocks[turnBlockIndexes[unit.turnIndex]];
    if (block) runtimeBlockByUnitId.set(unit.id, block);
    if (unit.turnIndex !== null) {
      const priority = turnNavigationUnitPriority(unit.kind);
      if (turnUnitIds[unit.turnIndex] === undefined || priority < (turnUnitPriorities[unit.turnIndex] ?? Infinity)) {
        turnUnitIds[unit.turnIndex] = unit.id;
        turnUnitPriorities[unit.turnIndex] = priority;
      }
    }
  }

  return {
    blocks,
    turns,
    turnBlockIndexes,
    runtimeUnits: projection.units,
    runtimeBlockByUnitId,
    turnUnitIds: Object.freeze(turnUnitIds),
  };
}

function tailUnitIds(
  units: readonly ConversationRenderUnit[],
  turnCount: number,
  tailTurns: number,
  maxUnits = Number.POSITIVE_INFINITY,
): readonly string[] {
  const firstHotTurn = Math.max(0, turnCount - tailTurns);
  const ids = units
    .filter((unit) => unit.turnIndex !== null && unit.turnIndex >= firstHotTurn)
    .map((unit) => unit.id);
  return Object.freeze(Number.isFinite(maxUnits) ? ids.slice(-maxUnits) : ids);
}

function turnNavigationUnitPriority(kind: ConversationRenderUnit["kind"]): number {
  if (kind === "user-markdown") return 0;
  if (kind === "assistant-markdown") return 1;
  if (kind !== "turn-shell" && kind !== "footer") return 2;
  return 3;
}

function buildConversationHydrationCandidates(
  items: readonly ProcessedMessageItem[],
  _units: readonly ConversationRenderUnit[],
): ConversationHydrationCandidate[] {
  const candidates: ConversationHydrationCandidate[] = [];
  let order = 0;
  for (const item of items) {
    for (const message of messagesFromProcessedItem(item)) {
      const messageOrder = order++;
      if (message.kind !== "user" && message.kind !== "assistant") continue;
      const source = normalizeMessageContent(message.content);
      candidates.push(Object.freeze({
        sessionId: message.threadId,
        // ConversationMessage already satisfies the adapter's narrower input
        // contract. Reusing it avoids one duplicate object per history item.
        message,
        source,
        order: messageOrder,
        unitId: `unit:${message.kind}-markdown:${message.id}`,
      }));
    }
  }
  return candidates;
}

function isTimelineEventItem(item: ProcessedMessageItem): boolean {
  return item.type === "message" && item.message.kind === "context_compression";
}

function groupDisplayItemsByTurn(displayItems: ProcessedMessageItem[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let items: ProcessedMessageItem[] = [];
  let turnBusinessIndex: number | null = null;
  let turnMarker: ConversationMessage | null = null;

  const flush = () => {
    if (!items.length) {
      turnMarker = null;
      turnBusinessIndex = null;
      return;
    }
    turns.push({
      id: turnIdFromItems(items, turnMarker),
      items,
      turnMarker,
      showThreadTaskContinuationNotice: isGoalContinuationTurnMarker(turnMarker),
    });
    items = [];
    turnBusinessIndex = null;
    turnMarker = null;
  };

  displayItems.forEach((item) => {
    if (isTurnMarkerItem(item)) {
      const markerTurnIndex = messageBusinessTurnIndex(item.message);
      if (isGoalContinuationTurnMarker(item.message)) {
        flush();
        turnMarker = item.message;
        turnBusinessIndex = markerTurnIndex;
        return;
      }
      if (
        items.length &&
        markerTurnIndex !== null &&
        turnBusinessIndex !== null &&
        markerTurnIndex !== turnBusinessIndex
      ) {
        flush();
      }
      turnMarker = item.message;
      if (markerTurnIndex !== null) {
        turnBusinessIndex = markerTurnIndex;
      }
      return;
    }

    if (isUserItem(item)) {
      flush();
    }
    const itemTurnIndex = itemBusinessTurnIndex(item);
    if (
      items.length &&
      itemTurnIndex !== null &&
      turnBusinessIndex !== null &&
      itemTurnIndex !== turnBusinessIndex
    ) {
      flush();
    }
    items.push(item);
    if (itemTurnIndex !== null) {
      turnBusinessIndex = itemTurnIndex;
    }
  });
  flush();

  return turns;
}

function isUserItem(item: ProcessedMessageItem): boolean {
  return item.type === "message" && item.message.kind === "user";
}

function itemBusinessTurnIndex(item: ProcessedMessageItem): number | null {
  for (const message of messagesFromProcessedItem(item)) {
    const turnIndex = messageBusinessTurnIndex(message);
    if (turnIndex !== null) {
      return turnIndex;
    }
  }
  return null;
}

function isTurnMarkerItem(item: ProcessedMessageItem): item is Extract<ProcessedMessageItem, { type: "message" }> {
  return item.type === "message" && item.message.kind === "turn_marker";
}

function isGoalContinuationTurnMarker(message: ConversationMessage | null): boolean {
  if (!message || message.kind !== "turn_marker") {
    return false;
  }
  const metadata = recordValue(message.payload.metadata);
  const source = stringRecordValue(metadata?.source) || stringRecordValue(message.payload.source);
  const threadTask = turnMarkerThreadTaskContext(message);
  return (
    source === "thread_task" &&
    stringRecordValue(threadTask?.trigger) === "task_continue" &&
    stringRecordValue(threadTask?.type) === "goal"
  );
}

function turnMarkerThreadTaskContext(message: ConversationMessage): Record<string, unknown> | null {
  const metadata = recordValue(message.payload.metadata);
  const runtimeParams =
    recordValue(message.payload.runtime_params) ??
    recordValue(message.payload.runtimeParams) ??
    recordValue(metadata?.runtime_params) ??
    recordValue(metadata?.runtimeParams);
  return (
    recordValue(message.payload.thread_task) ??
    recordValue(message.payload.threadTask) ??
    recordValue(metadata?.thread_task) ??
    recordValue(metadata?.threadTask) ??
    recordValue(runtimeParams?.thread_task) ??
    recordValue(runtimeParams?.threadTask)
  );
}

function turnIdFromItems(items: ProcessedMessageItem[], turnMarker?: ConversationMessage | null): string {
  const firstUserItem = items.find((item) => item.type === "message" && item.message.kind === "user");
  return `turn:${firstUserItem?.id ?? turnMarker?.id ?? items[0].id}`;
}

function buildTurnNavigationItems(turns: MessageTurn[]): ConversationTurnNavigationItem[] {
  return turns.flatMap((turn, index) => {
    const messages = turn.items.flatMap(messagesFromProcessedItem);
    const userMessage = messages.find((message) => message.kind === "user");
    if (!userMessage) {
      return [];
    }
    const assistantLines = messages
      .filter((message) => message.kind === "assistant")
      .flatMap((message) => previewLines(message.content, 3))
      .slice(0, 3);
    return [
      {
        id: turn.id,
        targetIndex: index,
        userPreview: previewLine(userMessage.content) || `第 ${index + 1} 轮对话`,
        assistantPreview: assistantLines,
      },
    ];
  });
}

function messagesFromProcessedItem(item: ProcessedMessageItem): ConversationMessage[] {
  return item.type === "message" ? [item.message] : item.messages;
}

function isThreadTaskStatusItem(item: ProcessedMessageItem): boolean {
  return item.type === "message" && item.message.kind === "thread_task_status";
}

function threadTaskStatusMessagesFromTurn(turn: MessageTurn): ConversationMessage[] {
  const messages = turn.items
    .flatMap(messagesFromProcessedItem)
    .filter((message) => message.kind === "thread_task_status");
  return coalesceThreadTaskStatusMessages(messages);
}

function coalesceThreadTaskStatusMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const coalesced: ConversationMessage[] = [];
  const indexByKey = new Map<string, number>();

  for (const message of messages) {
    const keys = threadTaskStatusCoalesceKeys(message);
    if (!keys.length) {
      coalesced.push(message);
      continue;
    }
    const existingIndex = keys.map((key) => indexByKey.get(key)).find((index) => index !== undefined);
    if (existingIndex === undefined) {
      keys.forEach((key) => indexByKey.set(key, coalesced.length));
      coalesced.push(message);
      continue;
    }
    coalesced[existingIndex] = mergeThreadTaskStatusAttempt(coalesced[existingIndex], message);
    keys.forEach((key) => indexByKey.set(key, existingIndex));
  }

  return coalesced;
}

function mergeThreadTaskStatusAttempt(previous: ConversationMessage, next: ConversationMessage): ConversationMessage {
  const previousAttempt = threadTaskStatusAttemptSummary(previous);
  const hiddenAttempts = previousAttempt.hiddenAttempts + 1;
  const failedAttempts = previousAttempt.failedAttempts + (isFailedThreadTaskStatusMessage(previous) ? 1 : 0);
  return {
    ...next,
    payload: {
      ...next.payload,
      _coalesced_thread_task_status: {
        hidden_attempts: hiddenAttempts,
        failed_attempts: failedAttempts,
      },
    },
  };
}

function threadTaskStatusAttemptSummary(message: ConversationMessage): {
  failedAttempts: number;
  hiddenAttempts: number;
} {
  const summary = recordValue(message.payload._coalesced_thread_task_status);
  return {
    failedAttempts: numberValue(summary?.failed_attempts) ?? 0,
    hiddenAttempts: numberValue(summary?.hidden_attempts) ?? 0,
  };
}

function threadTaskStatusCoalesceKeys(message: ConversationMessage): string[] {
  const call = recordValue(message.payload.call);
  const toolName =
    stringRecordValue(call?.name) ||
    stringRecordValue(message.payload.tool) ||
    stringRecordValue(message.payload.tool_name) ||
    message.content.trim();
  if (toolName !== "update_thread_task" && toolName !== "get_thread_task") {
    return [];
  }
  const keys: string[] = [];
  const taskIdentity = threadTaskStatusTaskIdentity(message);
  if (taskIdentity) {
    keys.push(`${toolName}:task:${taskIdentity}`);
  }
  const requestedStatus = threadTaskRequestedStatus(message);
  if (requestedStatus) {
    keys.push(`${toolName}:status:${requestedStatus}`);
  }
  if (!keys.length) {
    keys.push(`${toolName}:active`);
  }
  return keys;
}

function threadTaskStatusTaskIdentity(message: ConversationMessage): string {
  const call = recordValue(message.payload.call);
  const args = recordValue(call?.arguments) ?? recordValue(message.payload.arguments) ?? recordValue(message.payload.params);
  const result = recordValue(message.payload.result);
  const uiPayload = recordValue(result?.ui_payload) ?? recordValue(message.payload.ui_payload);
  const task = recordValue(uiPayload?.task) ?? recordValue(result?.task);
  return (
    stringRecordValue(args?.task_id) ||
    stringRecordValue(args?.taskId) ||
    stringRecordValue(task?.id) ||
    stringRecordValue(task?.task_id)
  );
}

function threadTaskRequestedStatus(message: ConversationMessage): string {
  const call = recordValue(message.payload.call);
  const args = recordValue(call?.arguments) ?? recordValue(message.payload.arguments) ?? recordValue(message.payload.params);
  const result = recordValue(message.payload.result);
  const uiPayload = recordValue(result?.ui_payload) ?? recordValue(message.payload.ui_payload);
  const task = recordValue(uiPayload?.task) ?? recordValue(result?.task);
  return stringRecordValue(args?.status) || stringRecordValue(task?.status);
}

function isFailedThreadTaskStatusMessage(message: ConversationMessage): boolean {
  const result = recordValue(message.payload.result);
  return message.status === "failed" || stringRecordValue(result?.status) === "error";
}

function findLastAssistantItemId(items: ProcessedMessageItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && itemKind(item) === "assistant") {
      return item.id;
    }
  }
  return null;
}

function resolveTurnNavigationIndex(
  request: MessageListTurnNavigationRequest | null | undefined,
  turns: MessageTurn[],
): number | null {
  if (!request) {
    return null;
  }
  if (typeof request.targetTurnIndex === "number" && Number.isFinite(request.targetTurnIndex)) {
    const turnIndex = turns.findIndex((turn) =>
      turn.items
        .flatMap(messagesFromProcessedItem)
        .some((message) => messageBusinessTurnIndex(message) === request.targetTurnIndex),
    );
    if (turnIndex >= 0) {
      return turnIndex;
    }
  }
  if (
    typeof request.targetIndex === "number" &&
    Number.isInteger(request.targetIndex) &&
    request.targetIndex >= 0 &&
    request.targetIndex < turns.length
  ) {
    return request.targetIndex;
  }
  return null;
}

function messageBusinessTurnIndex(message: ConversationMessage): number | null {
  const value = message.payload.turnIndex ?? message.payload.turn_index;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringRecordValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function previewLine(content: unknown): string {
  return normalizePreviewText(content).split("\n").find(Boolean) ?? "";
}

function previewLines(content: unknown, limit: number): string[] {
  return normalizePreviewText(content).split("\n").filter(Boolean).slice(0, limit);
}

function normalizePreviewText(content: unknown): string {
  return normalizeMessageContent(content)
    .slice(0, TURN_PREVIEW_SOURCE_LIMIT)
    .replace(/```[\s\S]*?```/g, "代码块")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[[^\]]*]\(([^)]+)\)/g, "$1")
    .replace(/[#*_>~-]+/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().slice(0, TURN_PREVIEW_LINE_LIMIT))
    .filter(Boolean)
    .join("\n");
}

const TURN_PREVIEW_SOURCE_LIMIT = 8 * 1024;
const TURN_PREVIEW_LINE_LIMIT = 240;

function collectAssistantTurnFooters(
  turns: MessageTurn[],
  turnRuntimeActive: boolean,
  turnFirstTokenAtMs: number | null,
): AssistantTurnFooters {
  const footerByItemId = new Map<string, AssistantTurnFooter>();
  const processingStartByItemId = new Map<string, string>();

  turns.forEach((turn, turnIndex) => {
    const turnMessages = turn.items.flatMap(messagesFromProcessedItem);
    const lastItemId = lastFooterAnchorItemId(turn.items);
    if (!lastItemId) {
      return;
    }
    const assistantMessages = turnMessages.filter(
      (message) => message.kind === "assistant" && normalizeMessageContent(message.content).trim(),
    );
    if (turnRuntimeActive && turnIndex === turns.length - 1) {
      const firstOutput = turnMessages.find(isTurnProcessingOutput);
      const strictStartedAt = timestampIso(turnFirstTokenAtMs);
      const startedAt = strictStartedAt ?? firstOutput?.createdAt;
      if (startedAt) {
        processingStartByItemId.set(lastItemId, startedAt);
      }
      return;
    }
    const message = assistantMessages.at(-1);
    if (!message) {
      return;
    }
    footerByItemId.set(lastItemId, {
      message,
      copyContent: assistantMessages
        .map((assistantMessage) => normalizeMessageContent(assistantMessage.content))
        .join("\n\n"),
    });
  });

  return { footerByItemId, processingStartByItemId };
}

function isTurnProcessingOutput(message: ConversationMessage): boolean {
  if (message.kind === "assistant" || message.kind === "thinking") {
    return Boolean(normalizeMessageContent(message.content).trim());
  }
  return (
    message.kind === "tool" ||
    message.kind === "command" ||
    message.kind === "file_change" ||
    message.kind === "skill" ||
    message.kind === "a2ui"
  );
}

function timestampIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return new Date(value).toISOString();
}

function collectTurnEndStreamingCursor(
  turns: MessageTurn[],
  isProcessing: boolean,
): TurnEndStreamingCursor {
  const empty = {
    suppressedMessageIds: new Set<string>(),
    cursorAfterItemIds: new Set<string>(),
    activityKey: "",
    showImmediately: false,
  };
  if (!isProcessing) {
    return empty;
  }
  const activeTurn = turns.at(-1);
  if (!activeTurn) {
    return empty;
  }
  const activeTurnMessages = activeTurn.items.flatMap(messagesFromProcessedItem);
  const anchorItemId = lastFooterAnchorItemId(activeTurn.items);
  if (!anchorItemId) {
    return empty;
  }
  return {
    suppressedMessageIds: new Set(
      activeTurnMessages
        .filter((message) => message.kind === "assistant" && isStreamingStatus(message.status))
        .map((message) => message.id),
    ),
    cursorAfterItemIds: new Set([anchorItemId]),
    activityKey: activeTurnMessages
      .map((message) => `${message.id}:${message.status ?? ""}:${message.content.length}:${message.updatedAt}`)
      .join("|"),
    showImmediately: activeTurnMessages.every(
      (message) => message.kind === "user" || message.kind === "turn_marker" || message.kind === "thread_task_status",
    ),
  };
}

function lastFooterAnchorItemId(items: readonly ProcessedMessageItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (
      item.type === "message" &&
      (item.message.kind === "thread_task_status" || item.message.kind === "turn_marker")
    ) {
      continue;
    }
    return item.id;
  }
  return null;
}

function isStreamingStatus(status: ConversationMessage["status"]): boolean {
  return status === "pending" || status === "running";
}

function isActiveTurnRuntimeState(runtimeState: ConversationRuntimeState | undefined): boolean {
  return (
    runtimeState === "starting" ||
    runtimeState === "running" ||
    runtimeState === "waiting_approval" ||
    runtimeState === "waiting_input" ||
    runtimeState === "cancelling"
  );
}

function MessageSkeleton() {
  return (
    <LoadingSkeleton
      aria-label="正在加载消息"
      className={styles.skeletonWrap}
      lineCount={3}
      testId="message-skeleton"
    />
  );
}
