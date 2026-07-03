import { ArrowDown } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  type PointerEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Virtuoso,
  type Components,
  type ItemProps,
  type ListProps,
  type ScrollerProps,
} from "react-virtuoso";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { normalizeMessageContent } from "@/renderer/utils/messageContent";
import type { AgentSessionFork } from "@/types/protocol";

import styles from "./MessageList.module.css";
import { ApprovalPrompt, type ApprovalDecisionHandler } from "./ApprovalPrompt";
import { CommandExecutionBlock } from "./CommandExecutionBlock";
import { ConversationTurnNavigator, type ConversationTurnNavigationItem } from "./ConversationTurnNavigator";
import { ErrorItem } from "./ErrorItem";
import { FileChangeBlock, type FileChangePreview } from "./FileChangeBlock";
import { MessageGroupBlock } from "./MessageGroupBlock";
import { MessageThinking } from "./MessageThinking";
import { MessageActionFooter, MessageText, StreamingCursor } from "./MessageText";
import { SkillActivationBlock } from "./SkillActivationBlock";
import { ThreadTaskStatusBlock } from "./ThreadTaskStatusBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { processMessages, type ProcessedMessageItem } from "./processMessages";
import type { ToolDetailsLoader } from "./useLazyToolDetails";
import { useAutoScroll } from "./useAutoScroll";
import { useVirtuosoAutoScroll } from "./useVirtuosoAutoScroll";

const STATIC_MESSAGE_LIST_ITEM_LIMIT = 160;
const INTERACTIVE_PANEL_STATIC_MESSAGE_LIST_ITEM_LIMIT = 48;
const VIRTUAL_MESSAGE_VIEWPORT_BUFFER = { bottom: 2600, top: 1800 } as const;
const LOAD_OLDER_TRIGGER_PX = 44;
const LOAD_OLDER_ARM_PX = 120;
const TURN_NAVIGATION_RETRY_FRAMES = 8;
const TURN_FOCUS_FLASH_DURATION_MS = 1300;

export interface MessageListProps {
  messages: ConversationMessage[];
  loading?: boolean;
  isProcessing?: boolean;
  variant?: MessageListVariant;
  performanceProfile?: MessageListPerformanceProfile;
  turnNavigatorMode?: MessageListTurnNavigatorMode;
  turnNavigationRequest?: MessageListTurnNavigationRequest | null;
  topNotice?: MessageListTopNotice | null;
  emptyLayout?: MessageListEmptyLayout;
  emptyText?: string;
  emptyTestId?: string;
  runtimeState?: ConversationRuntimeState;
  runtimeDetail?: string | null;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string) => void;
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
  variant = "full",
  performanceProfile = "default",
  turnNavigatorMode,
  turnNavigationRequest,
  topNotice = null,
  emptyLayout = "default",
  emptyText = "暂无消息",
  emptyTestId = "message-empty",
  renderMessage,
  workspaceRuntime,
  workspaceScope,
  onApprovalDecision,
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
  const olderLoadAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const olderLoadRequestedRef = useRef(false);
  const olderLoadArmedRef = useRef(false);
  const nativeScrollbarDragRef = useRef(false);
  const virtualVisibleTurnFrameRef = useRef<number | null>(null);
  const virtualScrollerRef = useRef<HTMLElement | null>(null);
  const staticTurnRefsRef = useRef<Array<HTMLDivElement | null>>([]);
  const flashTurnFrameRef = useRef<number | null>(null);
  const flashTurnTimeoutRef = useRef<number | null>(null);
  const previousTurnSummaryRef = useRef<{ count: number; lastId: string | null } | null>(null);
  const [showOlderTrigger, setShowOlderTrigger] = useState(false);
  const [flashingTurnIndex, setFlashingTurnIndex] = useState<number | null>(null);
  const visibleMessages = useMemo(() => messages.filter((message) => message.kind !== "plan"), [messages]);
  const processedMessages = useMemo(() => processMessages(visibleMessages), [visibleMessages]);
  const pendingAssistantMessage = useMemo(
    () =>
      isProcessing && shouldShowPendingAssistantCursor(visibleMessages)
        ? createPendingAssistantMessage(visibleMessages)
        : null,
    [isProcessing, visibleMessages],
  );
  const displayItems = useMemo<ProcessedMessageItem[]>(() => {
    if (!pendingAssistantMessage) {
      return processedMessages;
    }
    return [
      ...processedMessages,
      {
        type: "message",
        id: pendingAssistantMessage.id,
        message: pendingAssistantMessage,
      },
    ];
  }, [pendingAssistantMessage, processedMessages]);
  const displayTurns = useMemo(() => groupDisplayItemsByTurn(displayItems), [displayItems]);
  const turnNavigationItems = useMemo(() => buildTurnNavigationItems(displayTurns), [displayTurns]);
  const effectiveTurnNavigatorMode = turnNavigatorMode ?? (variant === "full" ? "auto" : "hidden");
  const showTurnNavigator = effectiveTurnNavigatorMode === "auto" && turnNavigationItems.length >= 2;
  const assistantTurnFooters = useMemo(
    () => collectAssistantTurnFooters(displayTurns, isProcessing),
    [displayTurns, isProcessing],
  );
  const turnEndStreamingCursor = useMemo(
    () => collectTurnEndStreamingCursor(displayTurns, isProcessing),
    [displayTurns, isProcessing],
  );
  const useStaticList = shouldUseStaticMessageList(displayItems.length, performanceProfile);
  const [visibleTurnIndexes, setVisibleTurnIndexes] = useState<Set<number>>(() => new Set([0]));
  const listMode = useStaticList ? "static" : "virtual";
  const externalTurnNavigationIndex = useMemo(
    () => resolveTurnNavigationIndex(turnNavigationRequest, displayTurns),
    [displayTurns, turnNavigationRequest],
  );
  const externalTurnNavigationRequestId = turnNavigationRequest?.requestId;
  const shouldAutoFollowMessages = externalTurnNavigationIndex === null;
  const staticAutoScroll = useAutoScroll({
    deps: [displayTurns, isProcessing],
    itemCount: displayTurns.length,
    autoFollow: shouldAutoFollowMessages,
  });
  const autoScroll = useVirtuosoAutoScroll(displayTurns.length, { autoFollow: shouldAutoFollowMessages });
  const scrollControls = useStaticList ? staticAutoScroll : autoScroll;
  const canLoadOlder = Boolean(hasMoreOlder && onLoadOlder);
  const olderLoader = renderOlderLoader({ canLoadOlder, loadingOlder, showTrigger: showOlderTrigger });
  const renderedTopNotice = useMemo(() => renderTopNotice(topNotice), [topNotice]);
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
      olderLoadAnchorRef.current = {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
      };
      void onLoadOlder?.();
    },
    [canLoadOlder, loadingOlder, onLoadOlder],
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

  const updateVisibleStaticTurns = useCallback((scroller: HTMLElement | null) => {
    if (!showTurnNavigator || nativeScrollbarDragRef.current) {
      return;
    }
    const nextVisibleIndexes = visibleTurnIndexesFromMountedTurns(scroller, displayTurns.length);
    if (!nextVisibleIndexes.size) {
      return;
    }
    setVisibleTurnIndexesIfChanged(nextVisibleIndexes);
  }, [displayTurns.length, setVisibleTurnIndexesIfChanged, showTurnNavigator]);

  const updateVisibleVirtualTurns = useCallback((scroller: HTMLElement | null) => {
    if (!showTurnNavigator || nativeScrollbarDragRef.current) {
      return;
    }
    const nextVisibleIndexes = visibleTurnIndexesFromMountedTurns(scroller, displayTurns.length);
    if (!nextVisibleIndexes.size) {
      return;
    }
    setVisibleTurnIndexesIfChanged(nextVisibleIndexes);
  }, [displayTurns.length, setVisibleTurnIndexesIfChanged, showTurnNavigator]);

  const markNativeScrollbarDrag = useCallback((event: { clientX: number; clientY: number }, scroller: HTMLElement) => {
    if (isNativeScrollbarPointerStart(event, scroller)) {
      nativeScrollbarDragRef.current = true;
    }
  }, []);

  const handleStaticPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      staticAutoScroll.handlePointerDown();
      markNativeScrollbarDrag(event, event.currentTarget);
    },
    [markNativeScrollbarDrag, staticAutoScroll],
  );

  const handleStaticScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      staticAutoScroll.handleScroll(event);
      updateOlderLoadTrigger(event.currentTarget);
      updateVisibleStaticTurns(event.currentTarget);
    },
    [staticAutoScroll, updateOlderLoadTrigger, updateVisibleStaticTurns],
  );

  const handleVirtualScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      updateOlderLoadTrigger(event.currentTarget);
      updateVisibleVirtualTurns(event.currentTarget);
    },
    [updateOlderLoadTrigger, updateVisibleVirtualTurns],
  );

  const handleVirtualRangeChanged = useCallback(() => {
    if (typeof window === "undefined") {
      updateVisibleVirtualTurns(virtualScrollerRef.current);
      return;
    }
    if (virtualVisibleTurnFrameRef.current !== null) {
      window.cancelAnimationFrame(virtualVisibleTurnFrameRef.current);
    }
    virtualVisibleTurnFrameRef.current = window.requestAnimationFrame(() => {
      virtualVisibleTurnFrameRef.current = null;
      updateVisibleVirtualTurns(virtualScrollerRef.current);
    });
  }, [updateVisibleVirtualTurns]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const finishNativeScrollbarDrag = () => {
      if (!nativeScrollbarDragRef.current) {
        return;
      }
      nativeScrollbarDragRef.current = false;
      window.requestAnimationFrame(() => {
        if (useStaticList) {
          updateVisibleStaticTurns(staticAutoScroll.containerRef.current);
          return;
        }
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
  }, [staticAutoScroll.containerRef, updateVisibleStaticTurns, updateVisibleVirtualTurns, useStaticList]);

  const setVirtualScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const element = ref instanceof HTMLElement ? ref : null;
      virtualScrollerRef.current = element;
      autoScroll.setScrollerRef(ref);
    },
    [autoScroll],
  );

  const handleVirtualStartReached = useCallback(() => {
    updateOlderLoadTrigger(virtualScrollerRef.current);
  }, [updateOlderLoadTrigger]);

  const handleVirtualAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      autoScroll.handleAtBottomStateChange(atBottom);
      if (atBottom && showTurnNavigator) {
        setVisibleTurnIndexesIfChanged(new Set([Math.max(0, displayTurns.length - 1)]));
      }
    },
    [autoScroll.handleAtBottomStateChange, displayTurns.length, setVisibleTurnIndexesIfChanged, showTurnNavigator],
  );

  const handleVirtualAtTopStateChange = useCallback(
    (atTop: boolean) => {
      if (atTop) {
        if (showTurnNavigator) {
          setVisibleTurnIndexesIfChanged(new Set([0]));
        }
        updateOlderLoadTrigger(virtualScrollerRef.current);
      }
    },
    [setVisibleTurnIndexesIfChanged, showTurnNavigator, updateOlderLoadTrigger],
  );

  useEffect(() => {
    return () => {
      if (virtualVisibleTurnFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(virtualVisibleTurnFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (loading || !canLoadOlder) {
      olderLoadArmedRef.current = false;
      olderLoadRequestedRef.current = false;
      olderLoadAnchorRef.current = null;
      setShowOlderTrigger(false);
    }
  }, [canLoadOlder, isProcessing, listMode, loading, visibleMessages[0]?.id]);

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
    const scroller = useStaticList ? staticAutoScroll.containerRef.current : virtualScrollerRef.current;
    if (!scroller) {
      olderLoadAnchorRef.current = null;
      olderLoadRequestedRef.current = false;
      return;
    }
    const nextScrollHeight = scroller.scrollHeight;
    scroller.scrollTop = nextScrollHeight - anchor.scrollHeight + anchor.scrollTop;
    olderLoadAnchorRef.current = null;
    olderLoadRequestedRef.current = false;
  }, [displayTurns.length, loadingOlder, staticAutoScroll.containerRef, useStaticList]);

  useLayoutEffect(() => {
    if (!useStaticList) {
      return;
    }
    updateVisibleStaticTurns(staticAutoScroll.containerRef.current);
  }, [displayTurns.length, staticAutoScroll.containerRef, updateVisibleStaticTurns, useStaticList]);

  useLayoutEffect(() => {
    const previousTurnSummary = previousTurnSummaryRef.current;
    const currentLastTurnId = displayTurns.at(-1)?.id ?? null;
    previousTurnSummaryRef.current = { count: displayTurns.length, lastId: currentLastTurnId };
    if (!previousTurnSummary || displayTurns.length <= previousTurnSummary.count || !currentLastTurnId) {
      return;
    }
    if (currentLastTurnId === previousTurnSummary.lastId) {
      return;
    }
    const lastTurn = displayTurns.at(-1);
    const hasNewUserTurn = Boolean(
      lastTurn?.items.some((item) => messagesFromProcessedItem(item).some((message) => message.kind === "user")),
    );
    if (!hasNewUserTurn && !isProcessing) {
      return;
    }
    if (!showTurnNavigator) {
      return;
    }
    setVisibleTurnIndexesIfChanged(new Set([displayTurns.length - 1]));
  }, [displayTurns, isProcessing, setVisibleTurnIndexesIfChanged, showTurnNavigator]);

  const virtualComponents = useMemo<Components<MessageTurn>>(
    () => ({
      ...messageVirtuosoComponents,
      Scroller: forwardRef<HTMLDivElement, ScrollerProps>(function MessageScroller(
        { children, style, ...props },
        ref,
      ) {
        const { onPointerDown, onScroll, ...scrollerProps } = props as typeof props & {
          onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
          onScroll?: (event: UIEvent<HTMLDivElement>) => void;
        };
        return (
          <div
            {...scrollerProps}
            ref={ref}
            className={styles.scroller}
            data-message-list-scroll="true"
            data-message-list-variant={variant}
            data-testid="message-list-scroll"
            style={style}
            onPointerDown={(event) => {
              onPointerDown?.(event);
              markNativeScrollbarDrag(event, event.currentTarget);
            }}
            onScroll={(event) => {
              onScroll?.(event);
              handleVirtualScroll(event);
            }}
          >
            {children}
          </div>
        );
      }),
      Header: function MessageListHeader() {
        return (
          <>
            {olderLoader}
            {renderedTopNotice}
          </>
        );
      },
      Item: function MessageItem({ children, style, ...props }: ItemProps<MessageTurn>) {
        const turnIndex = (props as { "data-index"?: number | string })["data-index"];
        return (
          <div
            {...props}
            className={styles.turnGroup}
            data-turn-index={turnIndex}
            data-testid="message-turn"
            style={style}
          >
            {children}
          </div>
        );
      },
    }),
    [flashingTurnIndex, handleVirtualScroll, markNativeScrollbarDrag, olderLoader, renderedTopNotice, variant],
  );

  useEffect(() => {
    onScrollControlsChange?.({
      showScrollToBottom: scrollControls.showScrollToBottom,
      scrollToBottom: scrollControls.scrollToBottom,
    });
  }, [onScrollControlsChange, scrollControls.scrollToBottom, scrollControls.showScrollToBottom]);

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
    (index: number) => {
      if (index < 0 || index >= displayTurns.length) {
        return true;
      }
      if (!useStaticList) {
        const virtuoso = autoScroll.virtuosoRef.current;
        if (!virtuoso) {
          return false;
        }
        virtuoso.scrollToIndex({
          align: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          index,
        });
        setVisibleTurnIndexesIfChanged(new Set([index]));
        return true;
      }

      const target = staticTurnRefsRef.current[index];
      if (typeof target?.scrollIntoView === "function") {
        target.scrollIntoView({
          block: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        setVisibleTurnIndexesIfChanged(new Set([index]));
        return true;
      }
      return false;
    },
    [autoScroll.virtuosoRef, displayTurns.length, setVisibleTurnIndexesIfChanged, useStaticList],
  );

  useEffect(() => {
    if (externalTurnNavigationRequestId === undefined || loading || externalTurnNavigationIndex === null) {
      return;
    }
    if (typeof window === "undefined") {
      if (navigateToTurn(externalTurnNavigationIndex)) {
        triggerTurnFlash(externalTurnNavigationIndex);
      }
      return;
    }
    let cancelled = false;
    let frameId: number | null = null;
    let remainingAttempts = TURN_NAVIGATION_RETRY_FRAMES;
    const attemptNavigation = () => {
      frameId = null;
      if (cancelled) {
        return;
      }
      const navigated = navigateToTurn(externalTurnNavigationIndex);
      remainingAttempts -= 1;
      if (navigated || remainingAttempts <= 0) {
        if (navigated) {
          triggerTurnFlash(externalTurnNavigationIndex);
        }
        return;
      }
      frameId = window.requestAnimationFrame(attemptNavigation);
    };
    frameId = window.requestAnimationFrame(attemptNavigation);
    return () => {
      cancelled = true;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    externalTurnNavigationIndex,
    externalTurnNavigationRequestId,
    loading,
    navigateToTurn,
    triggerTurnFlash,
  ]);

  const messageListContent = useStaticList ? (
    <div
      ref={staticAutoScroll.containerRef}
      className={styles.scroller}
      data-message-list-scroll="true"
      data-message-list-variant={variant}
      data-testid="message-list-scroll"
      onPointerDown={handleStaticPointerDown}
      onScroll={handleStaticScroll}
      onWheel={staticAutoScroll.handleWheel}
    >
      <div ref={staticAutoScroll.contentRef} className={styles.list} role="list" aria-label="Messages">
        {olderLoader}
        {renderedTopNotice}
        {displayTurns.map((turn, index) => (
          <div
            className={styles.turnGroup}
            data-turn-index={index}
            data-testid="message-turn"
            key={turn.id}
            ref={(node) => {
              staticTurnRefsRef.current[index] = node;
            }}
          >
            {renderMessageTurn({
              turn,
              hideThreadTaskStatusSummary: isProcessing && index === displayTurns.length - 1,
              focusFlash: index === flashingTurnIndex,
              renderMessage,
              assistantTurnFooters,
              turnEndStreamingCursor,
              workspaceRuntime,
              workspaceScope,
              onApprovalDecision,
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
        ))}
      </div>
    </div>
  ) : (
    <Virtuoso
      ref={autoScroll.virtuosoRef}
      className={styles.virtualScroller}
      data={displayTurns}
      components={virtualComponents}
      computeItemKey={(_, turn) => turn.id}
      defaultItemHeight={120}
      increaseViewportBy={VIRTUAL_MESSAGE_VIEWPORT_BUFFER}
      followOutput={autoScroll.followOutput}
      atBottomThreshold={8}
      atTopThreshold={LOAD_OLDER_TRIGGER_PX}
      atBottomStateChange={handleVirtualAtBottomStateChange}
      atTopStateChange={handleVirtualAtTopStateChange}
      totalListHeightChanged={autoScroll.handleTotalListHeightChanged}
      scrollerRef={setVirtualScrollerRef}
      startReached={handleVirtualStartReached}
      rangeChanged={handleVirtualRangeChanged}
      initialTopMostItemIndex={
        externalTurnNavigationIndex === null
          ? { align: "end", index: Math.max(0, displayTurns.length - 1) }
          : { align: "center", index: externalTurnNavigationIndex }
      }
      itemContent={(index, turn) =>
        renderMessageTurn({
          turn,
          hideThreadTaskStatusSummary: isProcessing && index === displayTurns.length - 1,
          focusFlash: index === flashingTurnIndex,
          renderMessage,
          assistantTurnFooters,
          turnEndStreamingCursor,
          workspaceRuntime,
          workspaceScope,
          onApprovalDecision,
          onFilePreview,
          onLoadToolDetails,
          onTerminateCommand,
          onQuoteSelection,
          onAskSelectionInBtwConversation,
          onForkFromMessage,
          onNavigateToForkSource,
          showForkSourceMarkers,
          onReverseFromMessage,
        })
      }
    />
  );

  const list = (
    <section
      className={styles.root}
      data-list-mode={listMode}
      data-message-list-variant={variant}
      data-performance-profile={performanceProfile}
      data-turn-navigator={showTurnNavigator ? "true" : "false"}
      data-testid="message-list"
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

      {scrollButtonMode === "inline" && scrollControls.showScrollToBottom ? (
        <button
          className={styles.scrollButton}
          type="button"
          aria-label="滚动到底"
          onClick={() => scrollControls.scrollToBottom()}
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

const messageVirtuosoComponents: Components<MessageTurn> = {
  Scroller: forwardRef<HTMLDivElement, ScrollerProps>(function MessageScroller(
    { children, style, ...props },
    ref,
  ) {
    return (
      <div
        {...props}
        ref={ref}
        className={styles.scroller}
        data-message-list-scroll="true"
        data-testid="message-list-scroll"
        style={style}
      >
        {children}
      </div>
    );
  }),
  List: forwardRef<HTMLDivElement, ListProps>(function MessageListSurface({ children, style, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className={`${styles.list} ${styles.virtualList}`}
        role="list"
        aria-label="娑堟伅鍒楄〃"
        style={style}
      >
        {children}
      </div>
    );
  }),
  Footer: function MessageListBottomSpacer() {
    return <div className={styles.virtualBottomSpacer} aria-hidden="true" />;
  },
  Item: function MessageItem({ children, style, ...props }: ItemProps<MessageTurn>) {
    const turnIndex = (props as { "data-index"?: number | string })["data-index"];
    return (
      <div {...props} className={styles.turnGroup} data-turn-index={turnIndex} data-testid="message-turn" style={style}>
        {children}
      </div>
    );
  },
};

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

function renderMessageTurn({
  turn,
  hideThreadTaskStatusSummary = false,
  focusFlash = false,
  renderMessage,
  assistantTurnFooters,
  turnEndStreamingCursor,
  workspaceRuntime,
  workspaceScope,
  onApprovalDecision,
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
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string) => void;
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
        footerMessage: assistantTurnFooters.footerByItemId.get(item.id),
        showTurnEndStreamingCursor: turnEndStreamingCursor.cursorAfterItemIds.has(item.id),
        suppressStreamingCursorMessageIds: turnEndStreamingCursor.suppressedMessageIds,
        workspaceRuntime,
        workspaceScope,
        onApprovalDecision,
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
  footerMessage,
  showTurnEndStreamingCursor,
  suppressStreamingCursorMessageIds,
  workspaceRuntime,
  workspaceScope,
  onApprovalDecision,
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
  footerMessage?: ConversationMessage;
  showTurnEndStreamingCursor: boolean;
  suppressStreamingCursorMessageIds: Set<string>;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string) => void;
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
        suppressStreamingCursor={suppressStreamingCursorMessageIds.has(item.message.id)}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={workspaceScope}
        onApprovalDecision={onApprovalDecision}
        onFilePreview={onFilePreview}
        onLoadToolDetails={onLoadToolDetails}
        onTerminateCommand={onTerminateCommand}
        onQuoteSelection={onQuoteSelection}
        onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
        onReverseFromMessage={onReverseFromMessage}
      />
    );
    return withTurnEndStreamingCursor(
      withTurnActionFooter(
        renderedMessage,
        footerMessage,
        onForkFromMessage,
        onReverseFromMessage,
        onNavigateToForkSource,
        showForkSourceMarkers,
      ),
      showTurnEndStreamingCursor,
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
          workspaceRuntime={workspaceRuntime}
          workspaceScope={workspaceScope}
          onApprovalDecision={onApprovalDecision}
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
  return withTurnEndStreamingCursor(
    withTurnActionFooter(
      renderedGroup,
      footerMessage,
      onForkFromMessage,
      onReverseFromMessage,
      onNavigateToForkSource,
      showForkSourceMarkers,
    ),
    showTurnEndStreamingCursor,
  );
}

function withTurnActionFooter(
  content: ReactNode,
  footerMessage?: ConversationMessage,
  onForkFromMessage?: (message: ConversationMessage) => void,
  onReverseFromMessage?: (message: ConversationMessage) => void,
  onNavigateToForkSource?: (fork: AgentSessionFork) => void,
  showForkSourceMarkers = true,
) {
  if (!footerMessage) {
    return content;
  }
  const forkSource = forkSourceFromMessage(footerMessage);
  return (
    <>
      {content}
      <div className={styles.turnActionRow}>
        <MessageActionFooter
          message={footerMessage}
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

function withTurnEndStreamingCursor(content: ReactNode, showCursor: boolean) {
  if (!showCursor) {
    return content;
  }
  return (
    <>
      {content}
      <div className={styles.turnEndStreamingCursor}>
        <StreamingCursor />
      </div>
    </>
  );
}

function DefaultMessage({
  message,
  suppressStreamingCursor = false,
  workspaceRuntime,
  workspaceScope,
  onApprovalDecision,
  onFilePreview,
  onLoadToolDetails,
  onTerminateCommand,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onReverseFromMessage,
}: {
  message: ConversationMessage;
  suppressStreamingCursor?: boolean;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
  onQuoteSelection?: (text: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onReverseFromMessage?: (message: ConversationMessage) => void;
}) {
  if (message.kind === "thinking") {
    return <MessageThinking message={message} />;
  }
  if (message.kind === "tool") {
    return <ToolCallBlock message={message} onPreviewFile={onFilePreview} onLoadDetails={onLoadToolDetails} />;
  }
  if (message.kind === "skill") {
    return (
      <SkillActivationBlock
        message={message}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={workspaceScope}
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
      onQuoteSelection={onQuoteSelection}
      onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
      onReverseFromMessage={onReverseFromMessage}
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
  return (
    <div
      className={styles.contextCompressionNotice}
      data-state={state}
      data-testid="context-compression-notice"
      role="status"
      aria-live="polite"
    >
      <span className={styles.contextCompressionNoticeLabel}>
        <span>{normalizeMessageContent(message.content)}</span>
      </span>
    </div>
  );
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

function shouldUseStaticMessageList(itemCount: number, performanceProfile: MessageListPerformanceProfile): boolean {
  const userAgent =
    typeof navigator === "undefined" || typeof navigator.userAgent !== "string"
      ? ""
      : navigator.userAgent.toLowerCase();
  if (typeof ResizeObserver === "undefined" || userAgent.includes("jsdom")) {
    return true;
  }
  const staticItemLimit =
    performanceProfile === "interactivePanel"
      ? INTERACTIVE_PANEL_STATIC_MESSAGE_LIST_ITEM_LIMIT
      : STATIC_MESSAGE_LIST_ITEM_LIMIT;
  return itemCount <= staticItemLimit;
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
  if (!normalized.size) {
    normalized.add(Math.max(0, count - 1));
  }
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

  const mountedTurns = Array.from(scroller.querySelectorAll<HTMLElement>('[data-testid="message-turn"]'));
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
  return buildTurnNavigationItems(groupDisplayItemsByTurn(processMessages(messages)));
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

interface MessageTurn {
  id: string;
  items: ProcessedMessageItem[];
  turnMarker: ConversationMessage | null;
  showThreadTaskContinuationNotice: boolean;
}

interface AssistantTurnFooters {
  footerByItemId: Map<string, ConversationMessage>;
}

interface TurnEndStreamingCursor {
  suppressedMessageIds: Set<string>;
  cursorAfterItemIds: Set<string>;
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
    .replace(/```[\s\S]*?```/g, "代码块")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[[^\]]*]\(([^)]+)\)/g, "$1")
    .replace(/[#*_>~-]+/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function collectAssistantTurnFooters(
  turns: MessageTurn[],
  isProcessing: boolean,
): AssistantTurnFooters {
  const footerByItemId = new Map<string, ConversationMessage>();

  for (const turn of turns) {
    const turnMessages = turn.items.flatMap(messagesFromProcessedItem);
    if (isProcessing && turnMessages.some((message) => isStreamingStatus(message.status))) {
      continue;
    }
    const assistantMessage = [...turnMessages].reverse().find((message) => message.kind === "assistant");
    if (!assistantMessage) {
      continue;
    }
    const lastItemId = lastFooterAnchorItemId(turn.items);
    if (!lastItemId) {
      continue;
    }
    footerByItemId.set(lastItemId, assistantMessage);
  }

  return { footerByItemId };
}

function collectTurnEndStreamingCursor(
  turns: MessageTurn[],
  isProcessing: boolean,
): TurnEndStreamingCursor {
  const empty = {
    suppressedMessageIds: new Set<string>(),
    cursorAfterItemIds: new Set<string>(),
  };
  if (!isProcessing) {
    return empty;
  }
  const activeTurn = [...turns]
    .reverse()
    .find((turn) => turn.items.flatMap(messagesFromProcessedItem).some((message) => isStreamingStatus(message.status)));
  if (!activeTurn) {
    return empty;
  }
  const activeTurnMessages = activeTurn.items.flatMap(messagesFromProcessedItem);
  const streamingAssistantIndex = activeTurnMessages.findLastIndex(
    (message) => message.kind === "assistant" && isStreamingStatus(message.status),
  );
  if (streamingAssistantIndex < 0) {
    return empty;
  }
  const itemIdByMessageId = mapMessageIdsToDisplayItems(activeTurn.items);
  const laterDisplayMessages = activeTurnMessages
    .slice(streamingAssistantIndex + 1)
    .filter(
      (message) =>
        message.kind !== "thread_task_status" &&
        message.kind !== "turn_marker" &&
        itemIdByMessageId.has(message.id),
    );
  if (!laterDisplayMessages.length) {
    return empty;
  }
  const lastDisplayMessage = laterDisplayMessages[laterDisplayMessages.length - 1];
  const lastItemId = itemIdByMessageId.get(lastDisplayMessage.id);
  if (!lastItemId) {
    return empty;
  }
  return {
    suppressedMessageIds: new Set(
      activeTurnMessages
        .filter((message) => message.kind === "assistant" && isStreamingStatus(message.status))
        .map((message) => message.id),
    ),
    cursorAfterItemIds: new Set([lastItemId]),
  };
}

function lastFooterAnchorItemId(items: ProcessedMessageItem[]): string | null {
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

function mapMessageIdsToDisplayItems(displayItems: ProcessedMessageItem[]): Map<string, string> {
  const itemIdByMessageId = new Map<string, string>();
  displayItems.forEach((item) => {
    if (item.type === "message") {
      itemIdByMessageId.set(item.message.id, item.id);
      return;
    }
    item.sourceMessageIds.forEach((messageId) => itemIdByMessageId.set(messageId, item.id));
  });
  return itemIdByMessageId;
}

function shouldShowPendingAssistantCursor(messages: ConversationMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) {
    return false;
  }
  if (isStreamingStatus(last.status)) {
    return false;
  }
  const activeTurnStart = messages.findLastIndex((message) => message.kind === "user") + 1;
  const activeTurnMessages = messages.slice(activeTurnStart);
  return !activeTurnMessages.some((message) => message.kind === "assistant" && isStreamingStatus(message.status));
}

function createPendingAssistantMessage(messages: ConversationMessage[]): ConversationMessage {
  const last = messages[messages.length - 1];
  const now = last?.updatedAt ?? new Date(0).toISOString();
  return {
    id: "pending-assistant-cursor",
    threadId: last?.threadId ?? "",
    turnId: last?.turnId ?? null,
    itemId: null,
    kind: "assistant",
    status: "running",
    content: "",
    payload: {},
    createdAt: now,
    updatedAt: now,
  };
}

function isStreamingStatus(status: ConversationMessage["status"]): boolean {
  return status === "pending" || status === "running";
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
