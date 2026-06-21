import { Check, Copy } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

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
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onQuoteSelection?: (text: string) => void;
}

export function MessageText({
  message,
  showActionRow = true,
  workspaceRuntime,
  workspaceScope,
  onQuoteSelection,
}: MessageTextProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const isUser = message.kind === "user";
  const isStreaming = message.status === "pending" || message.status === "running";
  const selection = useTextSelection(contentRef, Boolean(onQuoteSelection));
  const time = formatMessageTime(message.updatedAt || message.createdAt);
  const cancelled = message.status === "cancelled" || message.payload.cancelled === true;
  const assistantContent = useMemo(
    () => redactTextualToolProtocol(stripThinkTags(message.content)),
    [message.content],
  );
  const content = isUser ? message.content : assistantContent.content;
  const ghostFooter = useMemo(
    () => (isUser ? null : ghostFooterFromPayload(message.payload)),
    [isUser, message.payload],
  );
  const normalizedContent = useMemo(
    () => normalizeMarkdownContent(content, { streaming: !isUser && isStreaming }),
    [content, isStreaming, isUser],
  );
  const { displayedContent, isAnimating } = useTypingAnimation({
    content: normalizedContent,
    enabled: !isUser && isStreaming,
    completeImmediately: isUser || cancelled,
  });
  const hasPendingDisplayBacklog =
    !isUser &&
    isStreaming &&
    displayedContent.length < normalizedContent.length &&
    normalizedContent.startsWith(displayedContent);
  const showStreamingCursor = !isUser && isStreaming && !isAnimating && !hasPendingDisplayBacklog && !cancelled;
  const visuallyStreaming = isStreaming || isAnimating;
  const markdownComponents = useMemo(
    () => ({
      pre: MarkdownCodeBlock,
      table: MarkdownTable,
      img: (props: Parameters<typeof MarkdownImage>[0]) => (
        <MarkdownImage {...props} runtime={workspaceRuntime} workspaceScope={workspaceScope} />
      ),
    }),
    [workspaceRuntime, workspaceScope],
  );

  const handleCopy = async () => {
    try {
      await copyText(message.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <article className={isUser ? styles.userMessage : styles.assistantMessage} data-testid="message-text">
      <div className={styles.bubble}>
        {!isUser && assistantContent.redacted ? (
          <div className={styles.protocolNotice} role="note">
            {textualToolProtocolNotice}
          </div>
        ) : null}
        <div className="codex-markdown" ref={contentRef}>
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={markdownComponents}
          >
            {displayedContent}
          </ReactMarkdown>
          {showStreamingCursor ? (
            <span className={styles.streamingCursor} data-testid="streaming-cursor" aria-hidden="true">
              <span className={styles.streamingDot} />
              <span className={styles.streamingDot} />
              <span className={styles.streamingDot} />
            </span>
          ) : null}
        </div>
        {cancelled ? <div className={styles.cancelledBadge}>已中断</div> : null}
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
        <footer className={styles.actions} data-copy-state={copyState}>
          <button className={styles.actionButton} type="button" aria-label="复制消息" onClick={handleCopy}>
            {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
            <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制"}</span>
          </button>
          {time ? <time dateTime={message.updatedAt || message.createdAt}>{time}</time> : null}
        </footer>
      ) : null}
    </article>
  );
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
