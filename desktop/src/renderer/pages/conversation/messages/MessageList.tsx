import { ArrowDown } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
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
  type ListRange,
  type ListProps,
  type ScrollerProps,
} from "react-virtuoso";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";

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
import { ToolCallBlock } from "./ToolCallBlock";
import { processMessages, type ProcessedMessageItem } from "./processMessages";
import type { ToolDetailsLoader } from "./useLazyToolDetails";
import { useAutoScroll } from "./useAutoScroll";
import { useVirtuosoAutoScroll } from "./useVirtuosoAutoScroll";

const STATIC_MESSAGE_LIST_ITEM_LIMIT = 160;
const VIRTUAL_MESSAGE_VIEWPORT_BUFFER = { bottom: 2600, top: 1800 } as const;
const LOAD_OLDER_TRIGGER_PX = 44;
const LOAD_OLDER_ARM_PX = 120;
const ACTIVE_TURN_ANCHOR_RATIO = 0.35;
const SCROLL_BOUNDARY_EPSILON_PX = 2;

export interface MessageListProps {
  messages: ConversationMessage[];
  loading?: boolean;
  isProcessing?: boolean;
  variant?: MessageListVariant;
  turnNavigatorMode?: MessageListTurnNavigatorMode;
  turnNavigationRequest?: MessageListTurnNavigationRequest | null;
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
  onQuoteSelection?: (text: string) => void;
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

export type MessageListVariant = "full" | "compact" | "overlay";
export type MessageListTurnNavigatorMode = "auto" | "hidden";
export interface MessageListTurnNavigationRequest {
  requestId: number;
  targetIndex: number;
}

export function MessageList({
  messages,
  loading = false,
  isProcessing = false,
  variant = "full",
  turnNavigatorMode,
  turnNavigationRequest,
  emptyText = "暂无消息",
  emptyTestId = "message-empty",
  renderMessage,
  workspaceRuntime,
  workspaceScope,
  onApprovalDecision,
  onFilePreview,
  onLoadToolDetails,
  onQuoteSelection,
  hasMoreOlder = false,
  loadingOlder = false,
  onLoadOlder,
  scrollButtonMode = "inline",
  onScrollControlsChange,
}: MessageListProps) {
  const olderLoadAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const olderLoadRequestedRef = useRef(false);
  const olderLoadArmedRef = useRef(false);
  const virtualScrollerRef = useRef<HTMLElement | null>(null);
  const staticTurnRefsRef = useRef<Array<HTMLDivElement | null>>([]);
  const previousTurnSummaryRef = useRef<{ count: number; lastId: string | null } | null>(null);
  const [showOlderTrigger, setShowOlderTrigger] = useState(false);
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
    () => collectAssistantTurnFooters(visibleMessages, displayItems, isProcessing),
    [displayItems, isProcessing, visibleMessages],
  );
  const turnEndStreamingCursor = useMemo(
    () => collectTurnEndStreamingCursor(visibleMessages, displayItems, isProcessing),
    [displayItems, isProcessing, visibleMessages],
  );
  const useStaticList = shouldUseStaticMessageList(displayItems.length);
  const [activeTurnIndex, setActiveTurnIndex] = useState(0);
  const listMode = useStaticList ? "static" : "virtual";
  const staticAutoScroll = useAutoScroll({ deps: [displayTurns, isProcessing], itemCount: displayTurns.length });
  const autoScroll = useVirtuosoAutoScroll(displayTurns.length);
  const scrollControls = useStaticList ? staticAutoScroll : autoScroll;
  const canLoadOlder = Boolean(hasMoreOlder && onLoadOlder);
  const olderLoader = renderOlderLoader({ canLoadOlder, loadingOlder, showTrigger: showOlderTrigger });
  const activeTurnNavigationIndex = useMemo(
    () => findActiveTurnNavigationIndex(turnNavigationItems, activeTurnIndex),
    [activeTurnIndex, turnNavigationItems],
  );

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

  const updateActiveStaticTurn = useCallback((scroller: HTMLElement | null) => {
    if (!scroller) {
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    if (scrollerRect.height <= 0) {
      return;
    }
    if (isAtScrollTop(scroller)) {
      setActiveTurnIndex((current) => (current === 0 ? current : 0));
      return;
    }
    if (isAtScrollBottom(scroller)) {
      const lastIndex = Math.max(0, staticTurnRefsRef.current.length - 1);
      setActiveTurnIndex((current) => (current === lastIndex ? current : lastIndex));
      return;
    }
    const anchorY = scrollerRect.top + scrollerRect.height * ACTIVE_TURN_ANCHOR_RATIO;
    let nextActiveIndex = 0;

    for (let index = 0; index < staticTurnRefsRef.current.length; index += 1) {
      const turn = staticTurnRefsRef.current[index];
      if (!turn) {
        continue;
      }
      if (turn.getBoundingClientRect().top > anchorY) {
        break;
      }
      nextActiveIndex = index;
    }

    setActiveTurnIndex((current) => (current === nextActiveIndex ? current : nextActiveIndex));
  }, []);

  const handleStaticScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      staticAutoScroll.handleScroll(event);
      updateOlderLoadTrigger(event.currentTarget);
      updateActiveStaticTurn(event.currentTarget);
    },
    [staticAutoScroll, updateActiveStaticTurn, updateOlderLoadTrigger],
  );

  const handleVirtualScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      updateOlderLoadTrigger(event.currentTarget);
    },
    [updateOlderLoadTrigger],
  );

  const handleVirtualRangeChanged = useCallback((range: ListRange) => {
    setActiveTurnIndex((current) => (current === range.startIndex ? current : range.startIndex));
  }, []);

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
      if (atBottom) {
        setActiveTurnIndex((current) => {
          const lastIndex = Math.max(0, displayTurns.length - 1);
          return current === lastIndex ? current : lastIndex;
        });
      }
    },
    [autoScroll.handleAtBottomStateChange, displayTurns.length],
  );

  const handleVirtualAtTopStateChange = useCallback(
    (atTop: boolean) => {
      if (atTop) {
        setActiveTurnIndex((current) => (current === 0 ? current : 0));
        updateOlderLoadTrigger(virtualScrollerRef.current);
      }
    },
    [updateOlderLoadTrigger],
  );

  useEffect(() => {
    if (loading || !canLoadOlder) {
      olderLoadArmedRef.current = false;
      olderLoadRequestedRef.current = false;
      olderLoadAnchorRef.current = null;
      setShowOlderTrigger(false);
    }
  }, [canLoadOlder, isProcessing, listMode, loading, visibleMessages[0]?.id]);

  useEffect(() => {
    setActiveTurnIndex((current) => clampTurnIndex(current, displayTurns.length));
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
    updateActiveStaticTurn(staticAutoScroll.containerRef.current);
  }, [displayTurns.length, staticAutoScroll.containerRef, updateActiveStaticTurn, useStaticList]);

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
    setActiveTurnIndex(displayTurns.length - 1);
  }, [displayTurns, isProcessing]);

  const virtualComponents = useMemo<Components<MessageTurn>>(
    () => ({
      ...messageVirtuosoComponents,
      Scroller: forwardRef<HTMLDivElement, ScrollerProps>(function MessageScroller(
        { children, style, ...props },
        ref,
      ) {
        const { onScroll, ...scrollerProps } = props as typeof props & {
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
            onScroll={(event) => {
              onScroll?.(event);
              handleVirtualScroll(event);
            }}
          >
            {children}
          </div>
        );
      }),
      Header: function MessageListTopLoader() {
        return olderLoader;
      },
    }),
    [handleVirtualScroll, olderLoader, variant],
  );

  useEffect(() => {
    onScrollControlsChange?.({
      showScrollToBottom: scrollControls.showScrollToBottom,
      scrollToBottom: scrollControls.scrollToBottom,
    });
  }, [onScrollControlsChange, scrollControls.scrollToBottom, scrollControls.showScrollToBottom]);

  const navigateToTurn = useCallback(
    (index: number) => {
      if (index < 0 || index >= displayTurns.length) {
        return;
      }
      if (!useStaticList) {
        autoScroll.virtuosoRef.current?.scrollToIndex({
          align: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          index,
        });
        return;
      }

      const target = staticTurnRefsRef.current[index];
      if (typeof target?.scrollIntoView === "function") {
        target.scrollIntoView({
          block: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      }
    },
    [autoScroll.virtuosoRef, displayTurns.length, useStaticList],
  );

  useEffect(() => {
    if (!turnNavigationRequest) {
      return;
    }
    if (typeof window === "undefined") {
      navigateToTurn(turnNavigationRequest.targetIndex);
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      navigateToTurn(turnNavigationRequest.targetIndex);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [navigateToTurn, turnNavigationRequest]);

  const messageListContent = useStaticList ? (
    <div
      ref={staticAutoScroll.containerRef}
      className={styles.scroller}
      data-message-list-scroll="true"
      data-message-list-variant={variant}
      data-testid="message-list-scroll"
      onPointerDown={staticAutoScroll.handlePointerDown}
      onScroll={handleStaticScroll}
      onWheel={staticAutoScroll.handleWheel}
    >
      <div ref={staticAutoScroll.contentRef} className={styles.list} role="list" aria-label="Messages">
        {olderLoader}
        {displayTurns.map((turn, index) => (
          <div
            className={styles.turnGroup}
            data-testid="message-turn"
            key={turn.id}
            ref={(node) => {
              staticTurnRefsRef.current[index] = node;
            }}
          >
            {renderMessageTurn({
              turn,
              renderMessage,
              assistantTurnFooters,
              turnEndStreamingCursor,
              workspaceRuntime,
              workspaceScope,
              onApprovalDecision,
              onFilePreview,
              onLoadToolDetails,
              onQuoteSelection,
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
      initialTopMostItemIndex={{ align: "end", index: Math.max(0, displayTurns.length - 1) }}
      followOutput={autoScroll.followOutput}
      atBottomThreshold={8}
      atTopThreshold={LOAD_OLDER_TRIGGER_PX}
      atBottomStateChange={handleVirtualAtBottomStateChange}
      atTopStateChange={handleVirtualAtTopStateChange}
      totalListHeightChanged={autoScroll.handleTotalListHeightChanged}
      scrollerRef={setVirtualScrollerRef}
      startReached={handleVirtualStartReached}
      rangeChanged={handleVirtualRangeChanged}
      itemContent={(_, turn) =>
        renderMessageTurn({
          turn,
          renderMessage,
          assistantTurnFooters,
          turnEndStreamingCursor,
          workspaceRuntime,
          workspaceScope,
          onApprovalDecision,
          onFilePreview,
          onLoadToolDetails,
          onQuoteSelection,
        })
      }
    />
  );

  const list = (
    <section
      className={styles.root}
      data-list-mode={listMode}
      data-message-list-variant={variant}
      data-turn-navigator={showTurnNavigator ? "true" : "false"}
      data-testid="message-list"
    >
      {loading ? (
        <div className={styles.scroller} data-message-list-variant={variant} data-testid="message-list-scroll">
          <MessageSkeleton />
        </div>
      ) : visibleMessages.length ? (
        messageListContent
      ) : (
        <div className={styles.scroller} data-message-list-variant={variant} data-testid="message-list-scroll">
          <div className={styles.empty} data-testid={emptyTestId}>
            {emptyText}
          </div>
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
          activeIndex={activeTurnNavigationIndex}
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
    return (
      <div {...props} className={styles.turnGroup} data-testid="message-turn" style={style}>
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

function renderMessageTurn({
  turn,
  renderMessage,
  assistantTurnFooters,
  turnEndStreamingCursor,
  workspaceRuntime,
  workspaceScope,
  onApprovalDecision,
  onFilePreview,
  onLoadToolDetails,
  onQuoteSelection,
}: {
  turn: MessageTurn;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  assistantTurnFooters: AssistantTurnFooters;
  turnEndStreamingCursor: TurnEndStreamingCursor;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onQuoteSelection?: (text: string) => void;
}) {
  return turn.items.map((item) => (
    <div className={styles.item} data-kind={itemKind(item)} role="listitem" key={item.id}>
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
        onQuoteSelection,
      })}
    </div>
  ));
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
  onQuoteSelection,
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
  onQuoteSelection?: (text: string) => void;
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
        onQuoteSelection={onQuoteSelection}
      />
    );
    return withTurnEndStreamingCursor(withTurnActionFooter(renderedMessage, footerMessage), showTurnEndStreamingCursor);
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
          onQuoteSelection={onQuoteSelection}
          key={message.id}
        />
      ))}
    </MessageGroupBlock>
  );
  return withTurnEndStreamingCursor(withTurnActionFooter(renderedGroup, footerMessage), showTurnEndStreamingCursor);
}

function withTurnActionFooter(content: ReactNode, footerMessage?: ConversationMessage) {
  if (!footerMessage) {
    return content;
  }
  return (
    <>
      {content}
      <div className={styles.turnActionRow}>
        <MessageActionFooter message={footerMessage} placement="turn" />
      </div>
    </>
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
  onQuoteSelection,
}: {
  message: ConversationMessage;
  suppressStreamingCursor?: boolean;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onLoadToolDetails?: ToolDetailsLoader;
  onQuoteSelection?: (text: string) => void;
}) {
  if (message.kind === "thinking") {
    return <MessageThinking message={message} />;
  }
  if (message.kind === "tool") {
    return <ToolCallBlock message={message} onLoadDetails={onLoadToolDetails} />;
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
  if (message.kind === "command") {
    return <CommandExecutionBlock message={message} onLoadDetails={onLoadToolDetails} />;
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
  return (
    <MessageText
      message={message}
      showActionRow={message.kind !== "assistant"}
      suppressStreamingCursor={suppressStreamingCursor}
      workspaceRuntime={workspaceRuntime}
      workspaceScope={workspaceScope}
      onQuoteSelection={onQuoteSelection}
    />
  );
}

function itemKind(item: ProcessedMessageItem): ConversationMessage["kind"] | string {
  return item.type === "message" ? item.message.kind : item.groupKind;
}

function shouldUseStaticMessageList(itemCount: number): boolean {
  const userAgent =
    typeof navigator === "undefined" || typeof navigator.userAgent !== "string"
      ? ""
      : navigator.userAgent.toLowerCase();
  if (typeof ResizeObserver === "undefined" || userAgent.includes("jsdom")) {
    return true;
  }
  return itemCount <= STATIC_MESSAGE_LIST_ITEM_LIMIT;
}

function clampTurnIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), count - 1);
}

function isAtScrollTop(scroller: HTMLElement): boolean {
  return scroller.scrollTop <= SCROLL_BOUNDARY_EPSILON_PX;
}

function isAtScrollBottom(scroller: HTMLElement): boolean {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - SCROLL_BOUNDARY_EPSILON_PX;
}

export function buildTurnNavigationItemsFromMessages(messages: ConversationMessage[]): ConversationTurnNavigationItem[] {
  return buildTurnNavigationItems(groupDisplayItemsByTurn(processMessages(messages)));
}

function findActiveTurnNavigationIndex(items: ConversationTurnNavigationItem[], activeTurnIndex: number): number | null {
  if (!items.length) {
    return null;
  }
  let activeNavigationIndex = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].targetIndex > activeTurnIndex) {
      break;
    }
    activeNavigationIndex = index;
  }
  return activeNavigationIndex;
}

interface MessageTurn {
  id: string;
  items: ProcessedMessageItem[];
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

  const flush = () => {
    if (!items.length) {
      return;
    }
    turns.push({
      id: turnIdFromItems(items),
      items,
    });
    items = [];
  };

  displayItems.forEach((item) => {
    if (item.type === "message" && item.message.kind === "user") {
      flush();
    }
    items.push(item);
  });
  flush();

  return turns;
}

function turnIdFromItems(items: ProcessedMessageItem[]): string {
  const firstUserItem = items.find((item) => item.type === "message" && item.message.kind === "user");
  return `turn:${firstUserItem?.id ?? items[0].id}`;
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

function previewLine(content: string): string {
  return normalizePreviewText(content).split("\n").find(Boolean) ?? "";
}

function previewLines(content: string, limit: number): string[] {
  return normalizePreviewText(content).split("\n").filter(Boolean).slice(0, limit);
}

function normalizePreviewText(content: string): string {
  return content
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
  messages: ConversationMessage[],
  displayItems: ProcessedMessageItem[],
  isProcessing: boolean,
): AssistantTurnFooters {
  const footerByItemId = new Map<string, ConversationMessage>();
  const itemIdByMessageId = mapMessageIdsToDisplayItems(displayItems);
  const activeTurnStart = messages.findLastIndex((message) => message.kind === "user") + 1;

  const placeTurnActionRow = (start: number, end: number) => {
    if (end < start || (isProcessing && end >= activeTurnStart)) {
      return;
    }
    const turnMessages = messages.slice(start, end + 1);
    const assistantMessage = [...turnMessages].reverse().find((message) => message.kind === "assistant");
    if (!assistantMessage) {
      return;
    }
    const lastDisplayMessage = [...turnMessages].reverse().find((message) => itemIdByMessageId.has(message.id));
    if (!lastDisplayMessage) {
      return;
    }
    const lastItemId = itemIdByMessageId.get(lastDisplayMessage.id);
    if (!lastItemId) {
      return;
    }
    footerByItemId.set(lastItemId, assistantMessage);
  };

  let turnStart = 0;
  messages.forEach((message, index) => {
    if (message.kind !== "user") {
      return;
    }
    placeTurnActionRow(turnStart, index - 1);
    turnStart = index + 1;
  });
  placeTurnActionRow(turnStart, messages.length - 1);

  return { footerByItemId };
}

function collectTurnEndStreamingCursor(
  messages: ConversationMessage[],
  displayItems: ProcessedMessageItem[],
  isProcessing: boolean,
): TurnEndStreamingCursor {
  const empty = {
    suppressedMessageIds: new Set<string>(),
    cursorAfterItemIds: new Set<string>(),
  };
  if (!isProcessing) {
    return empty;
  }
  const activeTurnStart = messages.findLastIndex((message) => message.kind === "user") + 1;
  const activeTurnMessages = messages.slice(activeTurnStart);
  const streamingAssistantIndex = activeTurnMessages.findLastIndex(
    (message) => message.kind === "assistant" && isStreamingStatus(message.status),
  );
  if (streamingAssistantIndex < 0) {
    return empty;
  }
  const itemIdByMessageId = mapMessageIdsToDisplayItems(displayItems);
  const laterDisplayMessages = activeTurnMessages
    .slice(streamingAssistantIndex + 1)
    .filter((message) => itemIdByMessageId.has(message.id));
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
