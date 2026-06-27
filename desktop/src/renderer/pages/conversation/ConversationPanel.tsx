import type { RuntimeBridge } from "@/runtime";
import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";

import { MessageList, type MessageListTurnNavigationRequest, type MessageListTurnNavigatorMode } from "./messages";
import type { ConversationPanelModel } from "./useConversationPanelModel";

import styles from "./ConversationPanel.module.css";

export type ConversationPanelVariant = "full" | "compact" | "overlay";

export interface ConversationPanelProps {
  model: ConversationPanelModel;
  workspaceRuntime: RuntimeBridge;
  variant?: ConversationPanelVariant;
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
        loading={model.loading}
        isProcessing={model.runtimeState === "running"}
        runtimeState={model.runtimeState}
        runtimeDetail={model.runtimeDetail}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={model.messageWorkspaceScope}
        onFilePreview={model.openFileChangePreview}
        onLoadToolDetails={model.loadToolDetails}
        onQuoteSelection={model.quoteSelection}
        hasMoreOlder={Boolean(model.sessionViewState?.historyHasMoreOlder)}
        loadingOlder={model.loadingOlderHistory}
        onLoadOlder={model.loadOlderHistory}
        scrollButtonMode={scrollButtonMode}
        turnNavigatorMode={turnNavigatorMode}
        turnNavigationRequest={turnNavigationRequest}
        onScrollControlsChange={model.updateScrollControls}
        emptyText={emptyText}
        emptyTestId={emptyTestId}
      />
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
