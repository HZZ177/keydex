import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useMemo } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";

import styles from "./MessageList.module.css";
import { ApprovalPrompt, type ApprovalDecisionHandler } from "./ApprovalPrompt";
import { CommandExecutionBlock } from "./CommandExecutionBlock";
import { ErrorItem } from "./ErrorItem";
import { FileChangeBlock, type FileChangePreview } from "./FileChangeBlock";
import { MessageGroupBlock } from "./MessageGroupBlock";
import { MessagePlan } from "./MessagePlan";
import { MessageThinking } from "./MessageThinking";
import { MessageText } from "./MessageText";
import { ToolCallBlock } from "./ToolCallBlock";
import { processMessages } from "./processMessages";
import { useAutoScroll } from "./useAutoScroll";

export interface MessageListProps {
  messages: ConversationMessage[];
  loading?: boolean;
  isProcessing?: boolean;
  emptyText?: string;
  emptyTestId?: string;
  runtimeState?: ConversationRuntimeState;
  runtimeDetail?: string | null;
  renderMessage?: (message: ConversationMessage) => ReactNode;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onQuoteSelection?: (text: string) => void;
  scrollButtonMode?: "inline" | "external";
  onScrollControlsChange?: (controls: MessageListScrollControls) => void;
}

export interface MessageListScrollControls {
  showScrollToBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function MessageList({
  messages,
  loading = false,
  isProcessing = false,
  emptyText = "暂无消息",
  emptyTestId = "message-empty",
  renderMessage,
  onApprovalDecision,
  onFilePreview,
  onQuoteSelection,
  scrollButtonMode = "inline",
  onScrollControlsChange,
}: MessageListProps) {
  const scrollKey = useMemo(
    () => messages.map((message) => `${message.id}:${message.updatedAt}:${message.content.length}`).join("|"),
    [messages],
  );
  const processedMessages = useMemo(() => processMessages(messages), [messages]);
  const pendingAssistantMessage = useMemo(
    () =>
      isProcessing && shouldShowPendingAssistantCursor(messages)
        ? createPendingAssistantMessage(messages)
        : null,
    [isProcessing, messages],
  );
  const assistantActionRowMessageIds = useMemo(
    () => collectAssistantActionRowMessageIds(messages, isProcessing),
    [isProcessing, messages],
  );
  const autoScroll = useAutoScroll({
    deps: [scrollKey, isProcessing, loading],
    itemCount: processedMessages.length,
  });

  useEffect(() => {
    onScrollControlsChange?.({
      showScrollToBottom: autoScroll.showScrollToBottom,
      scrollToBottom: autoScroll.scrollToBottom,
    });
  }, [autoScroll.scrollToBottom, autoScroll.showScrollToBottom, onScrollControlsChange]);

  return (
    <section className={styles.root} data-testid="message-list">
      <div
        ref={autoScroll.containerRef}
        className={styles.scroller}
        data-testid="message-list-scroll"
        onScroll={autoScroll.handleScroll}
        onWheel={autoScroll.handleWheel}
        onPointerDown={autoScroll.handlePointerDown}
      >
        <div ref={autoScroll.contentRef} className={styles.contentSurface}>
          {loading ? (
            <MessageSkeleton />
          ) : messages.length ? (
            <ol className={styles.list} aria-label="消息列表">
              {processedMessages.map((item) => (
                <li
                  className={styles.item}
                  data-kind={item.type === "message" ? item.message.kind : item.groupKind}
                  key={item.id}
                >
                  {item.type === "message" ? (
                    renderMessage ? (
                      renderMessage(item.message)
                    ) : (
                      <DefaultMessage
                        message={item.message}
                        assistantActionRowMessageIds={assistantActionRowMessageIds}
                        onApprovalDecision={onApprovalDecision}
                        onFilePreview={onFilePreview}
                        onQuoteSelection={onQuoteSelection}
                      />
                    )
                  ) : (
                    <MessageGroupBlock
                      count={item.messages.length}
                      groupKind={item.groupKind}
                      messages={item.messages}
                      sourceMessageIds={item.sourceMessageIds}
                    >
                      {item.messages.map((message) => (
                        <DefaultMessage
                          message={message}
                          assistantActionRowMessageIds={assistantActionRowMessageIds}
                          onApprovalDecision={onApprovalDecision}
                          onFilePreview={onFilePreview}
                          onQuoteSelection={onQuoteSelection}
                          key={message.id}
                        />
                      ))}
                    </MessageGroupBlock>
                  )}
                </li>
              ))}
              {pendingAssistantMessage ? (
                <li className={styles.item} data-kind="assistant">
                  <MessageText
                    message={pendingAssistantMessage}
                    showActionRow={false}
                    onQuoteSelection={onQuoteSelection}
                  />
                </li>
              ) : null}
            </ol>
          ) : (
            <div className={styles.empty} data-testid={emptyTestId}>
              {emptyText}
            </div>
          )}
        </div>
      </div>

      {scrollButtonMode === "inline" && autoScroll.showScrollToBottom ? (
        <button className={styles.scrollButton} type="button" onClick={() => autoScroll.scrollToBottom()}>
          <ArrowDown size={15} />
          <span>滚动到底</span>
        </button>
      ) : null}
    </section>
  );
}

function DefaultMessage({
  message,
  assistantActionRowMessageIds,
  onApprovalDecision,
  onFilePreview,
  onQuoteSelection,
}: {
  message: ConversationMessage;
  assistantActionRowMessageIds: Set<string>;
  onApprovalDecision?: ApprovalDecisionHandler;
  onFilePreview?: (file: FileChangePreview) => void;
  onQuoteSelection?: (text: string) => void;
}) {
  if (message.kind === "thinking") {
    return <MessageThinking message={message} />;
  }
  if (message.kind === "plan") {
    return <MessagePlan message={message} />;
  }
  if (message.kind === "tool") {
    return <ToolCallBlock message={message} />;
  }
  if (message.kind === "command") {
    return <CommandExecutionBlock message={message} />;
  }
  if (message.kind === "file_change") {
    return <FileChangeBlock message={message} onPreviewFile={onFilePreview} />;
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
      showActionRow={shouldShowTextActionRow(message, assistantActionRowMessageIds)}
      onQuoteSelection={onQuoteSelection}
    />
  );
}

function collectAssistantActionRowMessageIds(messages: ConversationMessage[], isProcessing: boolean): Set<string> {
  const ids = new Set<string>();
  let pendingAssistantMessageId: string | null = null;

  const flush = () => {
    if (pendingAssistantMessageId) {
      ids.add(pendingAssistantMessageId);
      pendingAssistantMessageId = null;
    }
  };

  for (const message of messages) {
    if (message.kind === "user") {
      flush();
      continue;
    }
    if (message.kind === "assistant") {
      pendingAssistantMessageId = message.id;
    }
  }

  const finalAssistantMessageId = pendingAssistantMessageId;
  flush();
  if (isProcessing && finalAssistantMessageId) {
    ids.delete(finalAssistantMessageId);
  }

  return ids;
}

function shouldShowTextActionRow(message: ConversationMessage, assistantActionRowMessageIds: Set<string>): boolean {
  if (message.kind === "assistant") {
    return assistantActionRowMessageIds.has(message.id);
  }
  return true;
}

function shouldShowPendingAssistantCursor(messages: ConversationMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) {
    return false;
  }
  return !(last.kind === "assistant" && isStreamingStatus(last.status));
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

function MessageSkeleton() {
  return (
    <div className={styles.skeletonWrap} aria-label="正在加载消息">
      {[0, 1, 2].map((item) => (
        <div className={styles.skeleton} data-testid="message-skeleton" key={item}>
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
