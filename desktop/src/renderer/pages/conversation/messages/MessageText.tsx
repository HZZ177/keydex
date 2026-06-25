import { Check, Copy } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import { useOptionalPreview, type PreviewRenderContext } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentContextItem } from "@/types/protocol";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MessageGhostFooter, type MessageGhostFooterData } from "./MessageGhostFooter";
import { MarkdownImage } from "./MarkdownImage";
import { MarkdownTable } from "./MarkdownTable";
import { SelectionToolbar } from "./SelectionToolbar";
import {
  copyText,
  formatMessageTime,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownContent,
  redactTextualToolProtocol,
  stripThinkTags,
  textualToolProtocolNotice,
} from "./markdown";
import { useTextSelection } from "./useTextSelection";
import { useTypingAnimation } from "./useTypingAnimation";
import styles from "./MessageText.module.css";

export interface MessageTextProps {
  message: ConversationMessage;
  showActionRow?: boolean;
  suppressStreamingCursor?: boolean;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onQuoteSelection?: (text: string) => void;
}

export function MessageText({
  message,
  showActionRow = true,
  suppressStreamingCursor = false,
  workspaceRuntime,
  workspaceScope,
  onQuoteSelection,
}: MessageTextProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previewContext = useOptionalPreview();
  const isUser = message.kind === "user";
  const isStreaming = message.status === "pending" || message.status === "running";
  const selection = useTextSelection(contentRef, Boolean(onQuoteSelection));
  const cancelled = message.status === "cancelled" || message.payload.cancelled === true;
  const fastDrainTyping = !isUser && message.status === "completed" && !cancelled;
  const assistantContent = useMemo(
    () => redactTextualToolProtocol(stripThinkTags(message.content)),
    [message.content],
  );
  const content = isUser ? message.content : assistantContent.content;
  const contextItems = useMemo(
    () => (isUser ? contextItemsFromPayload(message.payload) : []),
    [isUser, message.payload],
  );
  const ghostFooter = useMemo(
    () => (isUser ? null : ghostFooterFromPayload(message.payload)),
    [isUser, message.payload],
  );
  const animationContent = useMemo(() => normalizeMarkdownContent(content), [content]);
  const { displayedContent, isAnimating } = useTypingAnimation({
    content: animationContent,
    enabled: !isUser && isStreaming,
    completeImmediately: isUser || cancelled,
    fastDrain: fastDrainTyping,
    resetKey: message.id,
  });
  const hasPendingDisplayBacklog =
    !isUser &&
    isStreaming &&
    displayedContent.length < animationContent.length &&
    animationContent.startsWith(displayedContent);
  const visuallyStreaming = isStreaming || isAnimating;
  const renderedContent = useMemo(
    () => normalizeMarkdownContent(displayedContent, { streaming: !isUser && visuallyStreaming }),
    [displayedContent, isUser, visuallyStreaming],
  );
  const activeStreamingFence = useMemo(
    () => (!isUser && visuallyStreaming ? findActiveStreamingFence(displayedContent) : null),
    [displayedContent, isUser, visuallyStreaming],
  );
  const markdownRenderStateRef = useRef({
    activeStreamingFence,
    isUser,
    visuallyStreaming,
  });
  markdownRenderStateRef.current = {
    activeStreamingFence,
    isUser,
    visuallyStreaming,
  };
  const showStreamingCursor =
    !suppressStreamingCursor && !isUser && isStreaming && !isAnimating && !hasPendingDisplayBacklog && !cancelled;
  const markdownComponents = useMemo(
    () => ({
      pre: ({ node, ...props }: MarkdownPreProps) => {
        const renderState = markdownRenderStateRef.current;
        return (
          <MarkdownCodeBlock
            {...props}
            streaming={
              !renderState.isUser &&
              renderState.visuallyStreaming &&
              isNodeInsideActiveFence(node, renderState.activeStreamingFence)
            }
          />
        );
      },
      table: MarkdownTable,
      a: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <MarkdownAnchor {...props} />,
      img: (props: Parameters<typeof MarkdownImage>[0]) => (
        <MarkdownImage {...props} runtime={workspaceRuntime} workspaceScope={workspaceScope} />
      ),
    }),
    [workspaceRuntime, workspaceScope],
  );
  const openContextFile = useCallback(
    (item: AgentContextItem) => {
      if (item.type !== "file" || !item.path || !previewContext) {
        return;
      }
      previewContext.openFilePanel(
        item.path,
        previewRenderContextFromWorkspaceScope(
          workspaceScope,
          workspaceRuntime,
          onQuoteSelection,
          previewContext.hostContext,
        ),
      );
    },
    [onQuoteSelection, previewContext, workspaceRuntime, workspaceScope],
  );

  return (
    <article className={isUser ? styles.userMessage : styles.assistantMessage} data-testid="message-text">
      <div className={styles.bubble}>
        {!isUser && assistantContent.redacted ? (
          <div className={styles.protocolNotice} role="note">
            {textualToolProtocolNotice}
          </div>
        ) : null}
        {contextItems.length ? <MessageContextItems items={contextItems} onOpenFile={openContextFile} /> : null}
        {renderedContent || !contextItems.length ? (
          <div className="keydex-markdown" ref={contentRef}>
            <ReactMarkdown
              remarkPlugins={markdownRemarkPlugins}
              rehypePlugins={markdownRehypePlugins}
              components={markdownComponents}
              urlTransform={markdownUrlTransform}
            >
              {renderedContent}
            </ReactMarkdown>
            {showStreamingCursor ? (
              <StreamingCursor />
            ) : null}
          </div>
        ) : (
          <div ref={contentRef} />
        )}
        {cancelled ? <div className={styles.cancelledBadge}>已取消</div> : null}
        {onQuoteSelection ? (
          <SelectionToolbar
            selectedText={selection.selectedText}
            position={selection.selectionPosition}
            onQuote={onQuoteSelection}
            onClear={selection.clearSelection}
          />
        ) : null}
      </div>
      <MessageGhostFooter footer={ghostFooter} />

      {!visuallyStreaming && showActionRow ? (
        <MessageActionFooter message={message} />
      ) : null}
    </article>
  );
}

export function StreamingCursor() {
  return (
    <span className={styles.streamingCursor} data-testid="streaming-cursor" aria-hidden="true">
      <span className={styles.streamingDot} />
      <span className={styles.streamingDot} />
      <span className={styles.streamingDot} />
    </span>
  );
}

function MessageContextItems({
  items,
  onOpenFile,
}: {
  items: AgentContextItem[];
  onOpenFile?: (item: AgentContextItem) => void;
}) {
  return (
    <div className={styles.contextItems} aria-label="附加上下文">
      {items.map((item) => (
        <MessageContextChip item={item} key={item.id} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function MessageContextChip({
  item,
  onOpenFile,
}: {
  item: AgentContextItem;
  onOpenFile?: (item: AgentContextItem) => void;
}) {
  if (item.type === "file") {
    return <MessageFileContextChip item={item} onOpenFile={onOpenFile} />;
  }
  if (item.type === "source_quote") {
    return <MessageSourceQuoteContextChip item={item} onOpenFile={onOpenFile} />;
  }
  if (item.type === "quote") {
    return <MessageQuoteContextChip item={item} />;
  }
  return <MessagePlainContextChip item={item} />;
}

function MessageFileContextChip({
  item,
  onOpenFile,
}: {
  item: AgentContextItem;
  onOpenFile?: (item: AgentContextItem) => void;
}) {
  const canOpen = Boolean(item.path && onOpenFile);
  const pathPreview = item.path || item.content || item.label;
  const chipLabel = contextFileName(item.name || item.label || pathPreview);
  return (
    <FloatingQuotePreview
      quoteText={fileContextKindLabel(item)}
      titleText={pathPreview}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={`${styles.contextItemCard} ${styles.contextItemPathCard}`}
      titleClassName={styles.contextItemPathTitle}
      bodyClassName={styles.contextItemPathMeta}
      chipElement="button"
      chipButtonProps={{
        type: "button",
        "aria-label": `打开文件引用 ${item.path || item.label}`,
        disabled: !canOpen,
        onClick: () => onOpenFile?.(item),
      }}
      chipProps={{
        "data-clickable": canOpen ? "true" : "false",
        "data-context-type": item.type,
      }}
      showCopyAction={false}
    >
      @{chipLabel}
    </FloatingQuotePreview>
  );
}

function fileContextKindLabel(item: AgentContextItem): string {
  return item.fileType === "directory" ? "工作区目录" : "工作区文件";
}

function contextFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function MessageSourceQuoteContextChip({
  item,
  onOpenFile,
}: {
  item: AgentContextItem;
  onOpenFile?: (item: AgentContextItem) => void;
}) {
  const canOpen = Boolean(item.path && onOpenFile);
  const lineLabel = contextItemLineLabel(item);
  const path = item.path || item.label;
  const preview = `${path}${lineLabel ? `\n${lineLabel}` : ""}\n\n${item.content || item.label}`;
  return (
    <FloatingQuotePreview
      quoteText={preview}
      copyValue={item.content || item.path || item.label}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={styles.contextItemCard}
      bodyClassName={styles.contextItemBody}
      actionsClassName={styles.contextItemActions}
      chipElement="button"
      chipButtonProps={{
        type: "button",
        "aria-label": `打开文件引用 ${path}`,
        disabled: !canOpen,
        onClick: () => onOpenFile?.(item),
      }}
      chipProps={{
        "data-clickable": canOpen ? "true" : "false",
        "data-context-type": item.type,
      }}
    >
      {item.label}
    </FloatingQuotePreview>
  );
}

function MessageQuoteContextChip({ item }: { item: AgentContextItem }) {
  const preview = item.content || item.label;
  return (
    <FloatingQuotePreview
      quoteText={preview}
      copyValue={item.content || item.path || item.label}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={styles.contextItemCard}
      bodyClassName={styles.contextItemBody}
      actionsClassName={styles.contextItemActions}
      chipProps={{ "data-context-type": item.type }}
    >
      {item.type === "file" ? "@" : ""}
      {item.label}
    </FloatingQuotePreview>
  );
}

function MessagePlainContextChip({ item }: { item: AgentContextItem }) {
  return (
    <span className={styles.contextItemWrapper}>
      <span className={styles.contextItemChip} tabIndex={0} data-context-type={item.type}>
        {item.label}
      </span>
    </span>
  );
}

function contextItemLineLabel(item: AgentContextItem): string | null {
  const start = numericMetadataValue(item.metadata?.line_start);
  const end = numericMetadataValue(item.metadata?.line_end);
  if (!start || !end) {
    return null;
  }
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

function numericMetadataValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function MessageActionFooter({
  message,
  placement = "inline",
}: {
  message: ConversationMessage;
  placement?: "inline" | "turn";
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const time = formatMessageTime(message.updatedAt || message.createdAt);

  const handleCopy = async () => {
    try {
      await copyText(message.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <footer
      className={styles.actions}
      data-copy-state={copyState}
      data-message-kind={message.kind}
      data-placement={placement}
    >
      <button className={styles.actionButton} type="button" aria-label="复制消息" onClick={handleCopy}>
        {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
        <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制"}</span>
      </button>
      {time ? <time dateTime={message.updatedAt || message.createdAt}>{time}</time> : null}
    </footer>
  );
}

function contextItemsFromPayload(payload: Record<string, unknown>): AgentContextItem[] {
  const raw = payload.contextItems;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const content = stringValue(record.content);
    const path = stringValue(record.path);
    const label = stringValue(record.label) || stringValue(record.name) || path || "上下文";
    return [
      {
        id: stringValue(record.id) || `context:${index}`,
        type: stringValue(record.type) || "follow",
        label,
        content,
        role: stringValue(record.role),
        source: stringValue(record.source),
        path,
        name: stringValue(record.name),
        fileType: stringValue(record.fileType) || stringValue(record.file_type),
        timestamp: numberValue(record.timestamp),
        metadata: objectValue(record.metadata),
      },
    ];
  });
}

function previewRenderContextFromWorkspaceScope(
  workspaceScope: WorkspaceScope | null | undefined,
  runtime: RuntimeBridge | undefined,
  onQuoteSelection: ((text: string) => void) | undefined,
  hostContext: PreviewRenderContext | null | undefined,
): PreviewRenderContext | undefined {
  if (hostContext?.workspaceAvailable && previewContextMatchesWorkspaceScope(hostContext, workspaceScope)) {
    return hostContext;
  }
  if (!workspaceScope) {
    return undefined;
  }
  const context: PreviewRenderContext = {
    workspaceAvailable: true,
  };
  if ("sessionId" in workspaceScope && workspaceScope.sessionId) {
    context.sessionId = workspaceScope.sessionId;
  }
  if ("workspaceId" in workspaceScope && workspaceScope.workspaceId) {
    context.workspaceId = workspaceScope.workspaceId;
  }
  if (runtime) {
    context.runtime = runtime;
  }
  if (onQuoteSelection) {
    context.onQuoteSelection = (request) => onQuoteSelection(request.selectedText);
  }
  return context;
}

function previewContextMatchesWorkspaceScope(
  context: PreviewRenderContext,
  workspaceScope: WorkspaceScope | null | undefined,
): boolean {
  if (!workspaceScope) {
    return false;
  }
  if ("sessionId" in workspaceScope && workspaceScope.sessionId) {
    return context.sessionId === workspaceScope.sessionId;
  }
  if ("workspaceId" in workspaceScope && workspaceScope.workspaceId) {
    return context.workspaceId === workspaceScope.workspaceId;
  }
  return false;
}

function MarkdownAnchor({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}

interface FloatingQuotePosition {
  left: number;
  top: number;
  arrowLeft: number;
  placement: "top" | "bottom";
}

interface FloatingQuotePreviewProps {
  quoteText: string;
  copyValue?: string;
  wrapperClassName: string;
  chipClassName: string;
  cardClassName: string;
  titleText?: string;
  titleClassName?: string;
  bodyClassName: string;
  actionsClassName?: string;
  chipElement?: "span" | "button";
  chipButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  chipProps?: Record<string, string>;
  showCopyAction?: boolean;
  children: ReactNode;
}

function FloatingQuotePreview({
  quoteText,
  copyValue,
  wrapperClassName,
  chipClassName,
  cardClassName,
  titleText,
  titleClassName,
  bodyClassName,
  actionsClassName,
  chipElement = "span",
  chipButtonProps,
  chipProps,
  showCopyAction = true,
  children,
}: FloatingQuotePreviewProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingQuotePosition | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPreview = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  const scheduleClosePreview = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setPosition(null);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer]);

  const shouldKeepOpenOnBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    return Boolean(
      nextTarget &&
        (wrapperRef.current?.contains(nextTarget as Node) || cardRef.current?.contains(nextTarget as Node)),
    );
  }, []);

  const updatePosition = useCallback(() => {
    const chip = chipRef.current;
    if (!chip) {
      return;
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const rect = chip.getBoundingClientRect();
    const card = cardRef.current;
    const cardWidth = Math.min(card?.offsetWidth || 280, Math.max(160, viewportWidth - 24));
    const cardHeight = Math.min(card?.offsetHeight || 132, Math.max(96, viewportHeight - 24));
    const viewportPadding = 12;
    const gap = 8;
    const chipCenter = rect.left + rect.width / 2;
    const left = clamp(chipCenter - cardWidth / 2, viewportPadding, viewportWidth - cardWidth - viewportPadding);
    const spaceAbove = rect.top - viewportPadding;
    const spaceBelow = viewportHeight - rect.bottom - viewportPadding;
    const placement: FloatingQuotePosition["placement"] =
      spaceAbove >= cardHeight + gap || spaceAbove > spaceBelow ? "top" : "bottom";
    const top =
      placement === "top"
        ? clamp(rect.top - cardHeight - gap, viewportPadding, viewportHeight - cardHeight - viewportPadding)
        : clamp(rect.bottom + gap, viewportPadding, viewportHeight - cardHeight - viewportPadding);
    const arrowLeft = clamp(chipCenter - left, 16, cardWidth - 16);

    setPosition({ left, top, arrowLeft, placement });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(
    () => () => {
      clearCloseTimer();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [clearCloseTimer],
  );

  const handleCopy = async () => {
    await copyText(copyValue || quoteText);
    setCopyState("copied");
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyTimerRef.current = null;
    }, 1200);
  };

  const cardStyle = {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    "--quote-reference-arrow-left": `${position?.arrowLeft ?? 20}px`,
  } as CSSProperties;
  const trigger =
    chipElement === "button" ? (
      <button
        {...chipButtonProps}
        {...chipProps}
        ref={(node) => {
          chipRef.current = node;
        }}
        className={chipClassName}
      >
        {children}
      </button>
    ) : (
      <span
        {...chipProps}
        ref={(node) => {
          chipRef.current = node;
        }}
        className={chipClassName}
        tabIndex={0}
      >
        {children}
      </span>
    );

  return (
    <span
      ref={wrapperRef}
      className={wrapperClassName}
      data-preview-open={open ? "true" : "false"}
      onMouseEnter={openPreview}
      onMouseLeave={scheduleClosePreview}
      onFocus={openPreview}
      onBlur={(event) => {
        if (!shouldKeepOpenOnBlur(event)) {
          scheduleClosePreview();
        }
      }}
    >
      {trigger}
      {open
        ? createPortal(
            <span
              ref={cardRef}
              className={cardClassName}
              data-floating-ready={position ? "true" : "false"}
              data-floating-placement={position?.placement ?? "top"}
              style={cardStyle}
              onMouseEnter={openPreview}
              onMouseLeave={scheduleClosePreview}
              onFocus={openPreview}
              onBlur={(event) => {
                if (!shouldKeepOpenOnBlur(event)) {
                  scheduleClosePreview();
                }
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {titleText ? (
                <span className={titleClassName} data-floating-preview-title="true">
                  {titleText}
                </span>
              ) : null}
              <span className={bodyClassName}>{quoteText}</span>
              {showCopyAction && actionsClassName ? (
                <span className={actionsClassName}>
                  <button type="button" onClick={handleCopy}>
                    {copyState === "copied" ? "已复制" : "复制"}
                  </button>
                </span>
              ) : null}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function markdownUrlTransform(url: string): string | null | undefined {
  return defaultUrlTransform(url);
}

function ghostFooterFromPayload(payload: Record<string, unknown>): MessageGhostFooterData | null {
  const footer: MessageGhostFooterData = {
    duration: formatDuration(payload.duration_ms ?? payload.durationMs),
  };

  return footer.duration ? footer : null;
}

function formatDuration(value: unknown): string | undefined {
  const ms = numberValue(value);
  if (ms === undefined) {
    return undefined;
  }
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} 秒`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

interface MarkdownPreProps {
  children?: ReactNode;
  node?: MarkdownNode;
}

interface MarkdownNode {
  position?: MarkdownNodePosition;
}

interface MarkdownNodePosition {
  start?: {
    line?: number;
    offset?: number;
  };
  end?: {
    line?: number;
    offset?: number;
  };
}

interface ActiveStreamingFence {
  contentStartLine: number;
  contentStartOffset: number;
  startLine: number;
  startOffset: number;
}

function findActiveStreamingFence(content: string): ActiveStreamingFence | null {
  const lines = content.split("\n");
  let activeFence:
    | {
        marker: "`" | "~";
        length: number;
        contentStartLine: number;
        contentStartOffset: number;
        startLine: number;
        startOffset: number;
      }
    | null = null;
  let lineStartOffset = 0;

  lines.forEach((line, index) => {
    const match = /^(\s*)(`{3,}|~{3,})/.exec(line);
    const lineNumber = index + 1;
    const nextLineOffset = lineStartOffset + line.length + (index < lines.length - 1 ? 1 : 0);

    if (!match) {
      lineStartOffset = nextLineOffset;
      return;
    }

    const markerText = match[2];
    const marker = markerText[0] as "`" | "~";
    if (!activeFence) {
      activeFence = {
        marker,
        length: markerText.length,
        startLine: lineNumber,
        startOffset: lineStartOffset,
        contentStartLine: lineNumber + 1,
        contentStartOffset: nextLineOffset,
      };
      lineStartOffset = nextLineOffset;
      return;
    }

    if (activeFence.marker === marker && markerText.length >= activeFence.length) {
      activeFence = null;
    }
    lineStartOffset = nextLineOffset;
  });

  return activeFence;
}

function isNodeInsideActiveFence(node: MarkdownNode | undefined, fence: ActiveStreamingFence | null): boolean {
  if (!fence) {
    return false;
  }

  const position = node?.position;
  const startOffset = position?.start?.offset;
  const endOffset = position?.end?.offset;
  if (isFiniteNumber(startOffset) && isFiniteNumber(endOffset)) {
    return startOffset <= fence.contentStartOffset && endOffset >= fence.startOffset;
  }

  const startLine = position?.start?.line;
  const endLine = position?.end?.line;
  if (isFiniteNumber(startLine) && isFiniteNumber(endLine)) {
    return startLine <= fence.contentStartLine && endLine >= fence.startLine;
  }

  return false;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
