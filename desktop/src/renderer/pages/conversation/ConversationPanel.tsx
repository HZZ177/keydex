import type { RuntimeBridge } from "@/runtime";
import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";

import {
  MessageList,
  type MessageListEmptyLayout,
  type MessageListPerformanceProfile,
  type MessageListTurnNavigationRequest,
  type MessageListTurnNavigatorMode,
} from "./messages";
import type { ConversationPanelModel } from "./useConversationPanelModel";

import styles from "./ConversationPanel.module.css";

export type ConversationPanelVariant = "full" | "compact" | "overlay";

export interface ConversationPanelProps {
  model: ConversationPanelModel;
  workspaceRuntime: RuntimeBridge;
  variant?: ConversationPanelVariant;
  performanceProfile?: MessageListPerformanceProfile;
  emptyLayout?: MessageListEmptyLayout;
  emptyText?: string;
  emptyTestId?: string;
  scrollButtonMode?: "inline" | "external";
  turnNavigatorMode?: MessageListTurnNavigatorMode;
  turnNavigationRequest?: MessageListTurnNavigationRequest | null;
  className?: string;
}

export function ConversationPanel({
  model,
  workspaceRuntime,
  variant = "full",
  performanceProfile = "default",
  emptyLayout,
  emptyText = "暂无消息",
  emptyTestId = "message-empty",
  scrollButtonMode = "inline",
  turnNavigatorMode,
  turnNavigationRequest,
  className = "",
}: ConversationPanelProps) {
  return (
    <div
      className={[styles.panel, className].filter(Boolean).join(" ")}
      data-testid="conversation-panel"
      data-conversation-panel-variant={variant}
    >
      <MessageList
        messages={model.messages}
        variant={variant}
        performanceProfile={performanceProfile}
        loading={model.loading}
        isProcessing={model.runtimeState === "running"}
        runtimeState={model.runtimeState}
        runtimeDetail={model.runtimeDetail}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={model.messageWorkspaceScope}
        onFilePreview={model.openFileChangePreview}
        onLoadToolDetails={model.loadToolDetails}
        onQuoteSelection={model.quoteSelection}
        onForkFromMessage={model.forkFromMessage}
        onReverseFromMessage={model.reverseFromMessage}
        hasMoreOlder={Boolean(model.sessionViewState?.historyHasMoreOlder)}
        loadingOlder={model.loadingOlderHistory}
        onLoadOlder={model.loadOlderHistory}
        scrollButtonMode={scrollButtonMode}
        turnNavigatorMode={turnNavigatorMode}
        turnNavigationRequest={turnNavigationRequest}
        onScrollControlsChange={model.updateScrollControls}
        emptyLayout={emptyLayout}
        emptyText={emptyText}
        emptyTestId={emptyTestId}
      />
      {model.reverseConfirmation ? (
        <ReverseConfirmDialog
          preview={model.reverseConfirmation.content}
          onCancel={model.cancelReverseFromMessage}
          onConfirm={model.confirmReverseFromMessage}
        />
      ) : null}
    </div>
  );
}

function ReverseConfirmDialog({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const summary = preview.trim().split(/\r?\n/u).find(Boolean) ?? "这一轮对话";
  return (
    <div className={styles.confirmBackdrop} role="presentation">
      <section
        aria-labelledby="reverse-confirm-title"
        aria-modal="true"
        className={styles.confirmPanel}
        role="dialog"
      >
        <header className={styles.confirmHeader}>
          <h2 id="reverse-confirm-title">确认回退到这一轮？</h2>
          <p>会删除这条用户消息以及之后的回复、工具调用和后续消息，并恢复到这一轮发送前的上下文。</p>
        </header>
        <div className={styles.confirmPreview}>{summary}</div>
        <div className={styles.confirmActions}>
          <button className={styles.confirmSecondary} type="button" onClick={onCancel}>
            取消
          </button>
          <button className={styles.confirmDanger} type="button" onClick={onConfirm}>
            确认回退
          </button>
        </div>
      </section>
    </div>
  );
}

export interface ConversationPanelComposerAccessoryProps {
  model: ConversationPanelModel;
  showScrollButton?: boolean;
}

export function ConversationPanelComposerAccessory({
  model,
  showScrollButton = true,
}: ConversationPanelComposerAccessoryProps) {
  return (
    <ConversationComposerAccessory
      messages={model.messages}
      showScrollToBottom={model.showScrollToBottom}
      showScrollButton={showScrollButton}
      onFilePreview={model.openFileChangePreview}
      onScrollToBottom={model.scrollToBottom}
    />
  );
}
