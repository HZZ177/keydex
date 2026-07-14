import { Check, ChevronDown, CircleAlert, Copy, CornerDownLeft, GitBranchPlus, Target, Undo2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  memo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { runtimeBridge, type RuntimeBridge, type WorkspaceScope } from "@/runtime";
import { ContextChipIcon } from "@/renderer/components/chat/ContextChipIcon";
import { ImagePreviewDialog } from "@/renderer/components/workspace/ImagePreviewSurface";
import {
  useOptionalPreview,
  type PreviewContextValue,
  type PreviewFileRevealTarget,
  type PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";
import { useCopyFeedback } from "@/renderer/hooks/useCopyFeedback";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { ImageResourceRuntime } from "@/renderer/markdownRuntime/resources";
import { isAbsoluteFilePath, parseFileLinkTarget } from "@/renderer/utils/fileLinks";
import { normalizeMessageContent } from "@/renderer/utils/messageContent";
import type { AgentContextItem, AgentFileAttachment, TurnError } from "@/types/protocol";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { formatConversationDuration } from "./duration";
import { MessageGhostFooter, type MessageGhostFooterData } from "./MessageGhostFooter";
import { SelectionToolbar } from "./SelectionToolbar";
import {
  copyText,
  formatMessageTime,
  normalizeMarkdownContent,
  redactTextualToolProtocol,
  stripThinkTags,
  textualToolProtocolNotice,
} from "./markdown";
import { previewRenderContextFromWorkspaceScope } from "./previewRenderContext";
import { useTextSelection } from "./useTextSelection";
import { useTypingAnimation } from "./useTypingAnimation";
import { conversationBaselineDiagnostics } from "./conversationBaselineDiagnostics";
import { ConversationMarkdownRuntimeHost } from "./ConversationMarkdownRuntimeHost";
import { createConversationMarkdownRendererRegistry } from "./ConversationMarkdownRendererProfile";
import styles from "./MessageText.module.css";

export interface MessageTextProps {
  message: ConversationMessage;
  showActionRow?: boolean;
  suppressStreamingCursor?: boolean;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  previewContextOverride?: PreviewContextValue | null;
  onQuoteSelection?: (text: string, comment?: string) => void;
  onAskSelectionInBtwConversation?: (text: string) => void;
  onReverseFromMessage?: (message: ConversationMessage) => void;
}

function MessageTextComponent({
  message,
  showActionRow = true,
  suppressStreamingCursor = false,
  workspaceRuntime,
  workspaceScope,
  previewContextOverride,
  onQuoteSelection,
  onAskSelectionInBtwConversation,
  onReverseFromMessage,
}: MessageTextProps) {
  conversationBaselineDiagnostics.record({
    stage: "message-text-render",
    messageId: message.id,
    status: message.status,
    characters: message.content.length,
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const inheritedPreviewContext = useOptionalPreview();
  const previewContext = previewContextOverride === undefined ? inheritedPreviewContext : previewContextOverride;
  const previewContextRef = useRef(previewContext);
  previewContextRef.current = previewContext;
  const previewAvailable = previewContext !== null;
  const previewScopeKey = previewContext?.activeScopeKey ?? null;
  const isUser = message.kind === "user";
  const useConversationRuntime = conversationMarkdownRuntimeEnabled(import.meta.env.MODE, typeof Worker !== "undefined");
  const isStreaming = message.status === "pending" || message.status === "running";
  const selection = useTextSelection(contentRef, Boolean(onQuoteSelection || onAskSelectionInBtwConversation));
  const cancelled = message.status === "cancelled" || message.payload.cancelled === true;
  const fastDrainTyping = !isUser && message.status === "completed" && !cancelled;
  const normalizedContent = useMemo(() => normalizeMessageContent(message.content), [message.content]);
  const assistantProjectionRef = useRef<{
    source: string;
    content: string;
    redacted: boolean;
  } | null>(null);
  const assistantContent = useMemo(() => {
    if (isUser) return { content: normalizedContent, redacted: false };
    const previous = assistantProjectionRef.current;
    if (
      useConversationRuntime
      && previous
      && !previous.redacted
      && previous.content === previous.source
      && isAppendOnlyMessageSnapshot(previous.source, normalizedContent)
    ) {
      const appendedProbe = normalizedContent.slice(Math.max(0, previous.source.length - 128));
      if (!STREAM_PROTOCOL_TAG_BOUNDARY_PATTERN.test(appendedProbe)) {
        const result = { source: normalizedContent, content: normalizedContent, redacted: false };
        assistantProjectionRef.current = result;
        return result;
      }
    }
    const projected = redactTextualToolProtocol(stripThinkTags(normalizedContent));
    const result = { source: normalizedContent, ...projected };
    assistantProjectionRef.current = result;
    return result;
  }, [isUser, normalizedContent, useConversationRuntime]);
  const content = isUser ? normalizedContent : assistantContent.content;
  const contextItems = useMemo(
    () => (isUser ? contextItemsFromPayload(message.payload) : []),
    [isUser, message.payload],
  );
  const goalContextItems = useMemo(
    () => contextItems.filter(isGoalContextItem),
    [contextItems],
  );
  const regularContextItems = useMemo(
    () => contextItems.filter((item) => !isGoalContextItem(item)),
    [contextItems],
  );
  const imageAttachments = useMemo(
    () => (isUser ? imageAttachmentsFromPayload(message.payload) : []),
    [isUser, message.payload],
  );
  const ghostFooter = useMemo(
    () => (isUser ? null : ghostFooterFromPayload(message.payload)),
    [isUser, message.payload],
  );
  const deliveredAsSteer = isUser && isDeliveredSteerMessage(message.payload);
  const turnError = useMemo(
    () => (message.kind === "assistant" && message.status === "failed" ? turnErrorFromPayload(message.payload) : null),
    [message.kind, message.payload, message.status],
  );
  const animationContent = useMemo(
    () => normalizeMarkdownContent(content),
    [content],
  );
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
    isAppendOnlyMessageSnapshot(displayedContent, animationContent);
  const visuallyStreaming = isStreaming || isAnimating;
  const renderedContent = useMemo(
    () => normalizeMarkdownContent(displayedContent, { streaming: isStreaming, repairFence: false }),
    [displayedContent, isStreaming],
  );
  const showStreamingCursor =
    !suppressStreamingCursor && !isUser && isStreaming && !isAnimating && !hasPendingDisplayBacklog && !cancelled;
  const conversationRuntimeRegistry = useMemo(
    () => createConversationMarkdownRendererRegistry({ previewContext: previewContextRef.current }),
    [previewAvailable, previewScopeKey],
  );
  const conversationImageRuntime = useMemo(
    () => new ImageResourceRuntime({
      sourcePathFor: () => null,
      workspaceKeyFor: () => workspaceScope?.sessionId ?? null,
      resourceRevisionFor: (_resource, context) => context.snapshot.revision,
      readWorkspaceImage: workspaceRuntime && workspaceScope
        ? async (path, _context, signal) => {
            if (signal.aborted) throw signal.reason;
            const response = await workspaceRuntime.workspace.readMedia(workspaceScope, path);
            if (signal.aborted) throw signal.reason;
            return {
              dataUrl: response.data_url,
              mediaType: response.media_type,
              bytes: response.size,
            };
          }
        : undefined,
    }),
    [workspaceRuntime, workspaceScope],
  );
  useEffect(() => () => conversationImageRuntime?.destroy(), [conversationImageRuntime]);
  const conversationResourceLifecycle = useMemo(
    () => ({ mount: conversationImageRuntime.mount.bind(conversationImageRuntime) }),
    [conversationImageRuntime],
  );
  const openContextFile = useCallback(
    (item: AgentContextItem) => {
      const path = contextItemOpenPath(item);
      if (!path) {
        return;
      }
      if (!previewContext) {
        return;
      }
      const renderContext = previewRenderContextFromWorkspaceScope(
        workspaceScope,
        workspaceRuntime,
        onQuoteSelection,
        previewContext.hostContext,
      );
      if (item.fileType === "directory") {
        previewContext.openDirectoryPanel(path, renderContext);
        return;
      }
      previewContext.openFilePanel(path, renderContext);
    },
    [onQuoteSelection, previewContext, workspaceRuntime, workspaceScope],
  );
  const openMarkdownFileTarget = useCallback(
    (path: string, line: number | null) => {
      const currentPreviewContext = previewContextRef.current;
      if (!currentPreviewContext) return;
      const revealTarget: PreviewFileRevealTarget | null = line ? { lineStart: line, lineEnd: line } : null;
      const renderContext = messageFilePreviewRenderContext(
        workspaceScope,
        workspaceRuntime,
        onQuoteSelection,
        currentPreviewContext.hostContext,
      );
      currentPreviewContext.openPreview(
        isAbsoluteFilePath(path) ? { type: "local-file", path } : { type: "file", path },
        renderContext,
        revealTarget,
      );
    },
    [onQuoteSelection, workspaceRuntime, workspaceScope],
  );
  const handleMarkdownFileLinkClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const link = target.closest<HTMLAnchorElement>("a[data-keydex-file-link='true']");
      if (!link || !event.currentTarget.contains(link)) {
        return;
      }
      const path = link.dataset.keydexFilePath?.trim();
      if (!path) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const line = positiveIntegerOrNull(link.dataset.keydexFileLine);
      openMarkdownFileTarget(path, line);
    },
    [openMarkdownFileTarget],
  );
  const conversationRuntimeInteractions = useMemo(
    () => ({
      onLinkActivate: (_event: globalThis.MouseEvent, input: { href: string }) => {
        const fileTarget = parseFileLinkTarget(input.href);
        if (fileTarget) {
          openMarkdownFileTarget(decodeFileLinkPath(fileTarget.path), fileTarget.line);
          return;
        }
        if (/^https?:\/\//iu.test(input.href)) window.open(input.href, "_blank", "noopener,noreferrer");
      },
    }),
    [openMarkdownFileTarget],
  );

  const userContextItems = isUser && regularContextItems.length > 0;
  const inlineContextItems = !isUser && regularContextItems.length > 0;
  const showBubble = Boolean(renderedContent || !userContextItems || cancelled);

  return (
    <article
      className={isUser ? styles.userMessage : styles.assistantMessage}
      data-testid="message-text"
      onClickCapture={handleMarkdownFileLinkClick}
    >
      {userContextItems ? (
        <div className={styles.userContextItems}>
          <MessageContextItems items={regularContextItems} onOpenFile={openContextFile} />
        </div>
      ) : null}
      {imageAttachments.length ? (
        <MessageImageAttachments
          attachments={imageAttachments}
          runtime={workspaceRuntime ?? runtimeBridge}
        />
      ) : null}
      {showBubble ? (
        <div
          className={styles.bubble}
          data-runtime-user-bubble={isUser && useConversationRuntime ? "true" : undefined}
          data-testid="message-bubble"
        >
          {!isUser && assistantContent.redacted ? (
            <div className={styles.protocolNotice} role="note">
              {textualToolProtocolNotice}
            </div>
          ) : null}
          {inlineContextItems ? <MessageContextItems items={regularContextItems} onOpenFile={openContextFile} /> : null}
          {isUser && useConversationRuntime && renderedContent ? (
            <span
              aria-hidden="true"
              className={styles.runtimeUserBubbleSizer}
              data-runtime-user-bubble-sizer="true"
              data-runtime-user-bubble-sizer-text={userBubbleIntrinsicSizerText(displayedContent)}
            />
          ) : null}
          {renderedContent || !userContextItems ? (
            <ConversationMarkdownRuntimeHost
                interactions={conversationRuntimeInteractions}
                message={message}
                registry={conversationRuntimeRegistry}
                resourceLifecycle={conversationResourceLifecycle}
                rootRef={contentRef}
                showCursor={showStreamingCursor}
                source={renderedContent}
                testSynchronous={import.meta.env.MODE === "test" && typeof Worker === "undefined"}
              />
          ) : null}
          {turnError ? <TurnErrorNotice error={turnError} /> : null}
          {cancelled ? <div className={styles.cancelledBadge}>已取消</div> : null}
          {onQuoteSelection || onAskSelectionInBtwConversation ? (
            <SelectionToolbar
              selectedText={selection.selectedText}
              position={selection.selectionPosition}
              selectionRange={selection.selectionRange}
              onQuote={onQuoteSelection}
              onAskInBtwConversation={onAskSelectionInBtwConversation}
              onClear={selection.clearSelection}
            />
          ) : null}
        </div>
      ) : null}
      {isUser && goalContextItems.length ? <MessageGoalContextItems items={goalContextItems} /> : null}
      {deliveredAsSteer ? <MessageSteerDeliveryBadge /> : null}
      <MessageGhostFooter footer={ghostFooter} />

      {!visuallyStreaming && showActionRow ? (
        <MessageActionFooter message={message} onReverseFromMessage={onReverseFromMessage} />
      ) : null}
    </article>
  );
}

export function conversationMarkdownRuntimeEnabled(environmentMode: string, workerAvailable: boolean): boolean {
  void environmentMode;
  void workerAvailable;
  return true;
}

export const MessageText = memo(MessageTextComponent);

function userBubbleIntrinsicSizerText(source: string): string {
  // The retained renderer positions its blocks absolutely, so they cannot
  // contribute an intrinsic inline size to the bubble. Keep one bounded,
  // invisible in-flow sample and let the browser's own text layout determine
  // the natural width. Long messages are guaranteed to use the 50% cap without
  // duplicating an unbounded message in the DOM.
  if (source.length > 512) return "宽".repeat(64);
  return source;
}

function isAppendOnlyMessageSnapshot(previous: string, next: string): boolean {
  if (next === previous) return true;
  if (next.length <= previous.length) return false;
  if (previous.length <= 1_024) return next.startsWith(previous);
  const windowSize = 512;
  return next.slice(0, windowSize) === previous.slice(0, windowSize)
    && next.slice(previous.length - windowSize, previous.length) === previous.slice(-windowSize);
}

const STREAM_PROTOCOL_TAG_BOUNDARY_PATTERN = /<\s*\/?\s*(?:think(?:ing)?|tool_call|tool_result)\b/iu;

export function StreamingCursor() {
  return (
    <span
      className={styles.streamingCursor}
      data-streaming-cursor="true"
      data-testid="streaming-cursor"
      aria-hidden="true"
    >
      <span className={styles.streamingDot} data-streaming-cursor-dot="true" />
      <span className={styles.streamingDot} data-streaming-cursor-dot="true" />
      <span className={styles.streamingDot} data-streaming-cursor-dot="true" />
    </span>
  );
}

function TurnErrorNotice({ error }: { error: TurnError }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsText = useMemo(() => stringifyTurnErrorDetails(error.details), [error.details]);
  const hasDetails = detailsText !== "{}";
  return (
    <div className={styles.turnErrorNotice} role="status" aria-live="polite">
      <div className={styles.turnErrorSummary}>
        <CircleAlert size={13} />
        <span className={styles.turnErrorMessage}>{error.message}</span>
        <span className={styles.turnErrorCode}>{error.code}</span>
        {hasDetails ? (
          <button
            className={styles.turnErrorDetailsToggle}
            type="button"
            aria-expanded={detailsOpen}
            aria-label={detailsOpen ? "收起错误详情" : "展开错误详情"}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            <ChevronDown size={13} data-expanded={detailsOpen ? "true" : "false"} />
            <span>错误详情</span>
          </button>
        ) : null}
      </div>
      {hasDetails && detailsOpen ? <pre className={styles.turnErrorDetails}>{detailsText}</pre> : null}
    </div>
  );
}

function MessageImageAttachments({
  attachments,
  runtime,
}: {
  attachments: AgentFileAttachment[];
  runtime: RuntimeBridge;
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [activePreview, setActivePreview] = useState<{
    attachment: AgentFileAttachment;
    url: string;
  } | null>(null);
  const attachmentKey = attachments
    .map((attachment, index) => imageAttachmentId(attachment) || `${index}:${attachment.path || attachment.name || ""}`)
    .join("|");

  useEffect(() => {
    let active = true;
    attachments.forEach((attachment) => {
      const id = imageAttachmentId(attachment);
      if (!id || Object.prototype.hasOwnProperty.call(previews, id) || attachmentPreviewUrl(attachment, previews)) {
        return;
      }
      void runtime.attachments
        .readMedia(id)
        .then((media) => {
          if (active) {
            setPreviews((current) => ({ ...current, [id]: media.data_url }));
          }
        })
        .catch(() => {
          if (active) {
            setPreviews((current) => ({ ...current, [id]: "" }));
          }
        });
    });
    return () => {
      active = false;
    };
  }, [attachmentKey, attachments, previews, runtime]);

  return (
    <div className={styles.messageImageAttachments} aria-label="图片附件">
      {attachments.map((attachment, index) => {
        const id = imageAttachmentId(attachment) || `image:${index}`;
        const previewUrl = attachmentPreviewUrl(attachment, previews);
        const name = attachment.name || attachment.path || "图片";
        return (
          <button
            className={styles.messageImageAttachment}
            key={id}
            type="button"
            title={name}
            aria-label={`预览图片 ${name}`}
            disabled={!previewUrl}
            onClick={() => {
              if (previewUrl) {
                setActivePreview({ attachment, url: previewUrl });
              }
            }}
          >
            {previewUrl ? (
              <img className={styles.messageImageThumb} src={previewUrl} alt="" />
            ) : (
              <span className={styles.messageImageFallback}>{name}</span>
            )}
          </button>
        );
      })}
      {activePreview ? (
        <ImagePreviewDialog
          src={activePreview.url}
          title={activePreview.attachment.name || "图片预览"}
          alt={activePreview.attachment.name || "图片预览"}
          onClose={() => setActivePreview(null)}
        />
      ) : null}
    </div>
  );
}

function messageFilePreviewRenderContext(
  workspaceScope: WorkspaceScope | null | undefined,
  runtime: RuntimeBridge | undefined,
  onQuoteSelection: ((text: string, comment?: string) => void) | undefined,
  hostContext: PreviewRenderContext | null | undefined,
): PreviewRenderContext | undefined {
  const workspaceContext = previewRenderContextFromWorkspaceScope(
    workspaceScope,
    runtime,
    onQuoteSelection,
    hostContext,
  );
  if (workspaceContext) {
    return workspaceContext;
  }
  const context: PreviewRenderContext = hostContext ? { ...hostContext } : {};
  if (runtime) {
    context.runtime = runtime;
  }
  if (onQuoteSelection) {
    context.onQuoteSelection = (request) => onQuoteSelection(request.selectedText, request.comment);
  }
  return Object.keys(context).length ? context : undefined;
}

function positiveIntegerOrNull(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function decodeFileLinkPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
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
  if (item.type === "skill") {
    return <MessageSkillContextChip item={item} onOpenFile={onOpenFile} />;
  }
  if (item.type === "quote") {
    return <MessageQuoteContextChip item={item} />;
  }
  return <MessagePlainContextChip item={item} />;
}

function MessageGoalContextItems({ items }: { items: AgentContextItem[] }) {
  return (
    <div className={styles.goalContextItems} aria-label="目标上下文">
      {items.map((item) => (
        <FloatingQuotePreview
          quoteText={goalContextText(item)}
          titleText={goalContextTitle(item)}
          wrapperClassName={styles.goalContextItemWrapper}
          chipClassName={styles.goalContextItem}
          cardClassName={`${styles.contextItemCard} ${styles.goalContextCard}`}
          titleClassName={styles.contextItemPathTitle}
          bodyClassName={styles.contextItemBody}
          chipProps={{ "data-context-type": "goal" }}
          placement="bottom"
          showCopyAction={false}
          key={item.id || item.label}
        >
          <Target size={12} aria-hidden="true" />
          <span className={styles.goalContextTitle}>{goalContextTitle(item)}</span>
        </FloatingQuotePreview>
      ))}
    </div>
  );
}

function MessageSteerDeliveryBadge() {
  return (
    <div className={styles.steerDeliveryBadgeRow} aria-label="消息投递状态">
      <span className={styles.goalContextItemWrapper}>
        <span className={styles.goalContextItem} data-testid="steer-delivery-badge">
          <CornerDownLeft size={12} aria-hidden="true" />
          <span>已引导当前对话</span>
        </span>
      </span>
    </div>
  );
}

function MessageFileContextChip({
  item,
  onOpenFile,
}: {
  item: AgentContextItem;
  onOpenFile?: (item: AgentContextItem) => void;
}) {
  const isDirectory = item.fileType === "directory";
  const canActivate = Boolean(item.path && onOpenFile);
  const pathPreview = item.path || item.content || item.label;
  const chipLabel = contextFileName(item.name || item.label || pathPreview);
  const description = contextItemDescription(item, pathPreview || fileContextKindLabel(item));
  return (
    <FloatingQuotePreview
      quoteText={description}
      titleText={chipLabel}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={`${styles.contextItemCard} ${styles.contextItemPathCard}`}
      titleClassName={styles.contextItemPathTitle}
      bodyClassName={styles.contextItemPathMeta}
      chipElement="button"
      chipButtonProps={{
        type: "button",
        "aria-label": canActivate
          ? isDirectory
            ? `在文件列表中定位目录 ${item.path || item.label}`
            : `打开文件引用 ${item.path || item.label}`
          : `${isDirectory ? "目录" : "文件"}引用 ${item.path || item.label}`,
        disabled: !canActivate,
        onClick: () => onOpenFile?.(item),
      }}
      chipProps={{
        "data-clickable": canActivate ? "true" : "false",
        "data-context-type": item.type,
      }}
      showCopyAction={false}
    >
      <span className={styles.contextItemIcon} data-context-chip-icon={item.fileType === "directory" ? "directory" : "file"} aria-hidden="true">
        <ContextChipIcon kind={item.fileType === "directory" ? "directory" : "file"} />
      </span>
      <span className={styles.contextItemLabel}>@{chipLabel}</span>
    </FloatingQuotePreview>
  );
}

function fileContextKindLabel(item: AgentContextItem): string {
  const source = stringValue(item.metadata?.source) || stringValue(item.source);
  if (source === "workspace") {
    return item.fileType === "directory" ? "工作区目录" : "工作区文件";
  }
  if (source === "pasted") {
    return "粘贴文件";
  }
  if (source === "dropped") {
    return "拖拽文件";
  }
  return item.fileType === "directory" ? "本地目录" : "本地文件";
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
  const contextKind = contextItemHasComment(item) ? "comment" : "quote";
  const canOpen = Boolean(item.path && onOpenFile);
  const lineLabel = contextItemLineLabel(item);
  const path = item.path || item.label;
  const preview = `${path}${lineLabel ? `\n${lineLabel}` : ""}\n\n${item.content || item.label}`;
  const description = contextItemDescription(item, preview);
  return (
    <FloatingQuotePreview
      quoteText={description}
      titleText={item.label}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={styles.contextItemCard}
      titleClassName={styles.contextItemPathTitle}
      bodyClassName={styles.contextItemBody}
      chipElement="button"
      chipButtonProps={{
        type: "button",
        "aria-label": `${contextKind === "comment" ? "打开评论来源" : "打开文件引用"} ${path}`,
        disabled: !canOpen,
        onClick: () => onOpenFile?.(item),
      }}
      chipProps={{
        "data-clickable": canOpen ? "true" : "false",
        "data-context-type": item.type,
      }}
      showCopyAction={false}
    >
      <span className={styles.contextItemIcon} data-context-chip-icon={contextKind} aria-hidden="true">
        <ContextChipIcon kind={contextKind} />
      </span>
      <span className={styles.contextItemLabel}>{item.label}</span>
    </FloatingQuotePreview>
  );
}

function MessageSkillContextChip({
  item,
  onOpenFile,
}: {
  item: AgentContextItem;
  onOpenFile?: (item: AgentContextItem) => void;
}) {
  const skillName =
    item.skill_name ||
    item.skillName ||
      stringValue(item.metadata?.skill_name) ||
      stringValue(item.metadata?.skillName);
  const label = skillContextLabel(item.label, skillName);
  const canOpen = Boolean(contextItemOpenPath(item) && onOpenFile);
  const description =
    stringValue(item.metadata?.description) ||
    item.description ||
    item.content ||
    "No description";
  return (
    <FloatingQuotePreview
      quoteText={description}
      titleText={label}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={styles.contextItemCard}
      titleClassName={styles.contextItemPathTitle}
      bodyClassName={styles.contextItemBody}
      chipElement={canOpen ? "button" : "span"}
      chipButtonProps={{
        type: "button",
        "aria-label": `打开 Skill ${label}`,
        disabled: !canOpen,
        onClick: () => onOpenFile?.(item),
      }}
      chipProps={{
        "data-context-type": item.type,
        "data-clickable": canOpen ? "true" : "false",
      }}
      showCopyAction={false}
    >
      <span className={styles.contextItemIcon} data-context-chip-icon="skill" aria-hidden="true">
        <ContextChipIcon kind="skill" />
      </span>
      <span className={styles.contextItemLabel}>{label}</span>
    </FloatingQuotePreview>
  );
}

function skillContextLabel(label: string, skillName: string): string {
  const value = skillName || label || "Skill";
  const normalized = value.replace(/^\//, "").trim();
  return normalized || "Skill";
}

function MessageQuoteContextChip({ item }: { item: AgentContextItem }) {
  const contextKind = contextItemHasComment(item) ? "comment" : "quote";
  const preview = contextItemDescription(item, item.content || item.label);
  return (
    <FloatingQuotePreview
      quoteText={preview}
      titleText={item.label}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={styles.contextItemCard}
      titleClassName={styles.contextItemPathTitle}
      bodyClassName={styles.contextItemBody}
      chipProps={{ "data-context-type": item.type }}
      showCopyAction={false}
    >
      <span className={styles.contextItemIcon} data-context-chip-icon={contextKind} aria-hidden="true">
        <ContextChipIcon kind={contextKind} />
      </span>
      <span className={styles.contextItemLabel}>
        {item.type === "file" ? "@" : ""}
        {item.label}
      </span>
    </FloatingQuotePreview>
  );
}

function MessagePlainContextChip({ item }: { item: AgentContextItem }) {
  const description = contextItemDescription(item, item.content || item.label);
  return (
    <FloatingQuotePreview
      quoteText={description}
      titleText={item.label}
      wrapperClassName={styles.contextItemWrapper}
      chipClassName={styles.contextItemChip}
      cardClassName={styles.contextItemCard}
      titleClassName={styles.contextItemPathTitle}
      bodyClassName={styles.contextItemBody}
      chipProps={{ "data-context-type": item.type }}
      showCopyAction={false}
    >
      <span className={styles.contextItemIcon} data-context-chip-icon="context" aria-hidden="true">
        <ContextChipIcon kind="context" />
      </span>
      <span className={styles.contextItemLabel}>{item.label}</span>
    </FloatingQuotePreview>
  );
}

function contextItemHasComment(item: AgentContextItem): boolean {
  return Boolean(stringValue(item.metadata?.comment).trim());
}

function contextItemDescription(item: AgentContextItem, fallback: string): string {
  return stringValue(item.metadata?.description) || item.description || fallback;
}

function contextItemOpenPath(item: AgentContextItem): string {
  return item.path || item.locator || stringValue(item.metadata?.locator);
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

export function ProcessingDuration({
  durationMs,
  startedAt,
  live = false,
}: {
  durationMs?: number | null;
  startedAt?: string;
  live?: boolean;
}) {
  const frozenDurationMs = nonNegativeDuration(durationMs);
  const startedAtMs = timestampMs(startedAt);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!live || frozenDurationMs !== null || startedAtMs === null) {
      return undefined;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [frozenDurationMs, live, startedAtMs]);

  const elapsedMs =
    frozenDurationMs ?? (live && startedAtMs !== null ? Math.max(0, nowMs - startedAtMs) : null);
  if (elapsedMs === null) {
    return null;
  }
  return (
    <span
      className={styles.processingDuration}
      data-live={live ? "true" : "false"}
      data-testid="turn-processing-time"
    >
      已处理 {formatProcessingDuration(elapsedMs)}
    </span>
  );
}

export function formatProcessingDuration(durationMs: number): string {
  return formatConversationDuration(durationMs);
}

export function MessageActionFooter({
  message,
  placement = "inline",
  onForkFromMessage,
  onReverseFromMessage,
}: {
  message: ConversationMessage;
  placement?: "inline" | "turn";
  onForkFromMessage?: (message: ConversationMessage) => void;
  onReverseFromMessage?: (message: ConversationMessage) => void;
}) {
  const { copyState, showCopyFeedback, resetCopyFeedback } = useCopyFeedback();
  const time = formatMessageTime(message.updatedAt || message.createdAt);
  const turnDurationMs = turnDurationFromPayload(message.payload);
  const hasPersistedEvent = typeof message.payload.messageEventId === "string" && message.status !== "running";
  const canFork = hasPersistedEvent && message.kind === "assistant";
  const canReverse = hasPersistedEvent && message.kind === "user";

  const handleCopy = async () => {
    try {
      await copyText(normalizeMessageContent(message.content));
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
  };

  const footerDetails = (
    <>
      <button
        className={styles.actionButton}
        type="button"
        aria-label="复制消息"
        data-tooltip-label="复制消息"
        onClick={handleCopy}
      >
        {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
        <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制"}</span>
      </button>
      {canFork && onForkFromMessage ? (
        <button
          className={styles.actionButton}
          type="button"
          aria-label="从该轮派生对话"
          data-tooltip-label="从该轮派生对话"
          onClick={() => onForkFromMessage(message)}
        >
          <GitBranchPlus size={13} />
          <span>从该轮派生对话</span>
        </button>
      ) : null}
      {canReverse && onReverseFromMessage ? (
        <button
          className={styles.actionButton}
          type="button"
          aria-label="回溯到此处"
          data-tooltip-label="回溯到此处"
          onClick={() => onReverseFromMessage(message)}
        >
          <Undo2 size={13} />
          <span>回溯到此处</span>
        </button>
      ) : null}
      {time ? <time dateTime={message.updatedAt || message.createdAt}>{time}</time> : null}
    </>
  );

  return (
    <footer
      className={styles.actions}
      data-copy-state={copyState}
      data-message-kind={message.kind}
      data-placement={placement}
      onPointerLeave={resetCopyFeedback}
    >
      {placement === "turn" ? (
        <>
          <ProcessingDuration durationMs={turnDurationMs} />
          <span className={styles.turnFooterDetails} data-turn-footer-details="true">
            {footerDetails}
          </span>
        </>
      ) : (
        footerDetails
      )}
    </footer>
  );
}

function turnDurationFromPayload(payload: Record<string, unknown>): number | null {
  return nonNegativeDuration(payload.turnDurationMs ?? payload.turn_duration_ms);
}

function nonNegativeDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
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
    const metadata = objectValue(record.metadata);
    const skillName =
      stringValue(record.skill_name) ||
      stringValue(record.skillName) ||
      stringValue(metadata?.skill_name) ||
      stringValue(metadata?.skillName);
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
        skill_name: skillName,
        skillName,
        description: stringValue(record.description) || stringValue(metadata?.description),
        locator: stringValue(record.locator) || stringValue(metadata?.locator),
        fileType: stringValue(record.fileType) || stringValue(record.file_type),
        timestamp: numberValue(record.timestamp),
        metadata,
      },
    ];
  });
}

function isDeliveredSteerMessage(payload: Record<string, unknown>): boolean {
  const pendingInputId = String(payload.pendingInputId ?? payload.pending_input_id ?? "").trim();
  const deliveryMode = String(payload.deliveryMode ?? payload.delivery_mode ?? "").trim();
  return Boolean(pendingInputId) && deliveryMode === "steer";
}

function isGoalContextItem(item: AgentContextItem): boolean {
  return item.type === "goal" || stringValue(item.metadata?.kind) === "goal";
}

function goalContextTitle(item: AgentContextItem): string {
  return stringValue(item.metadata?.title) || item.label || "目标";
}

function goalContextText(item: AgentContextItem): string {
  return stringValue(item.metadata?.objective) || item.content || item.description || "";
}

function imageAttachmentsFromPayload(payload: Record<string, unknown>): AgentFileAttachment[] {
  const raw = payload.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const type = stringValue(record.type);
    const mimeType = stringValue(record.mime_type) || stringValue(record.mimeType);
    if (type !== "image" && !mimeType.startsWith("image/")) {
      return [];
    }
    return [
      {
        id: stringValue(record.id),
        attachment_id: stringValue(record.attachment_id) || stringValue(record.attachmentId),
        type: "image",
        name: stringValue(record.name),
        path: stringValue(record.path),
        url: stringValue(record.url),
        source: stringValue(record.source),
        mime_type: mimeType,
        size: numericMetadataValue(record.size) ?? undefined,
        data_url: stringValue(record.data_url) || stringValue(record.dataUrl),
      },
    ];
  });
}

function imageAttachmentId(attachment: AgentFileAttachment): string {
  return String(attachment.attachment_id || attachment.id || "").trim();
}

function attachmentPreviewUrl(
  attachment: AgentFileAttachment,
  previews: Record<string, string>,
): string {
  const inlineDataUrl = stringValue(attachment.data_url) || stringValue(attachment.dataUrl);
  if (inlineDataUrl) {
    return inlineDataUrl;
  }
  if (attachment.url) {
    return attachment.url;
  }
  const id = imageAttachmentId(attachment);
  return id ? previews[id] || "" : "";
}

interface FloatingQuotePosition {
  left: number;
  top: number;
  arrowLeft: number;
  placement: "top" | "bottom";
}

type DataAttributes = {
  [key: `data-${string}`]: string | undefined;
};

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
  chipButtonProps?: ButtonHTMLAttributes<HTMLButtonElement> & DataAttributes;
  chipProps?: Record<string, string>;
  placement?: "auto" | "top" | "bottom";
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
  placement = "auto",
  showCopyAction = true,
  children,
}: FloatingQuotePreviewProps) {
  const { copyState, showCopyFeedback } = useCopyFeedback();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingQuotePosition | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);

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
    const resolvedPlacement: FloatingQuotePosition["placement"] =
      placement === "top" || placement === "bottom"
        ? placement
        : spaceAbove >= cardHeight + gap || spaceAbove > spaceBelow
          ? "top"
          : "bottom";
    const top =
      resolvedPlacement === "top"
        ? clamp(rect.top - cardHeight - gap, viewportPadding, viewportHeight - cardHeight - viewportPadding)
        : clamp(rect.bottom + gap, viewportPadding, viewportHeight - cardHeight - viewportPadding);
    const arrowLeft = clamp(chipCenter - left, 16, cardWidth - 16);

    setPosition({ left, top, arrowLeft, placement: resolvedPlacement });
  }, [placement]);

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
    },
    [clearCloseTimer],
  );

  const handleCopy = async () => {
    try {
      await copyText(copyValue || quoteText);
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
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

function ghostFooterFromPayload(payload: Record<string, unknown>): MessageGhostFooterData | null {
  const footer: MessageGhostFooterData = {
    duration: formatDuration(payload.duration_ms ?? payload.durationMs),
  };

  return footer.duration ? footer : null;
}

function turnErrorFromPayload(payload: Record<string, unknown>): TurnError | null {
  const source = objectValue(payload.error);
  if (!source) {
    return null;
  }
  return {
    code: scalarStringValue(source.code) || "runtime_error",
    message: normalizeMessageContent(stringValue(source.message)).trim() || "对话执行失败",
    details: objectValue(source.details) ?? {},
  };
}

function stringifyTurnErrorDetails(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
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

function scalarStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
