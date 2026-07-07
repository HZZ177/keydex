import type { RuntimeBridge } from "@/runtime";
import { ConfirmDialog } from "@/renderer/components/dialog";
import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";

import {
  MessageList,
  type MessageListEmptyLayout,
  type MessageListPerformanceProfile,
  type MessageListTopNotice,
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
  topNotice?: MessageListTopNotice | null;
  showForkSourceMarkers?: boolean;
  showForkActions?: boolean;
  onAskSelectionInBtwConversation?: (text: string) => void;
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
  topNotice = null,
  showForkSourceMarkers = true,
  showForkActions = true,
  onAskSelectionInBtwConversation,
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
        onTerminateCommand={model.terminateCommand}
        onResolveMcpElicitation={model.resolveMcpElicitation}
        onQuoteSelection={model.quoteSelection}
        onAskSelectionInBtwConversation={onAskSelectionInBtwConversation}
        onForkFromMessage={showForkActions ? model.forkFromMessage : undefined}
        onNavigateToForkSource={model.navigateToForkSource}
        showForkSourceMarkers={showForkSourceMarkers}
        onReverseFromMessage={model.reverseFromMessage}
        hasMoreOlder={Boolean(model.sessionViewState?.historyHasMoreOlder)}
        loadingOlder={model.loadingOlderHistory}
        onLoadOlder={model.loadOlderHistory}
        scrollButtonMode={scrollButtonMode}
        turnNavigatorMode={turnNavigatorMode}
        turnNavigationRequest={turnNavigationRequest}
        topNotice={topNotice}
        onScrollControlsChange={model.updateScrollControls}
        emptyLayout={emptyLayout}
        emptyText={emptyText}
        emptyTestId={emptyTestId}
      />
      {model.forkConfirmation ? (
        <ForkConfirmDialog
          preview={model.forkConfirmation.content}
          onCancel={model.cancelForkFromMessage}
          onConfirm={model.confirmForkFromMessage}
        />
      ) : null}
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

function ForkConfirmDialog({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const summary = preview.trim().split(/\r?\n/u).find(Boolean) ?? "这条回复";
  return (
    <ConfirmDialog
      title="确认从该轮派生对话？"
      description="会以当前对话截至这条回复的上下文创建新的派生会话，并切换到新会话。当前对话不会被修改。"
      preview={summary}
      confirmLabel="派生对话"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
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
    <ConfirmDialog
      title="确认回溯到此处？"
      description="会删除这条用户消息以及之后的回复、工具调用和后续消息，并把这条用户消息重新填充到输入框。"
      preview={summary}
      confirmLabel="确认回溯"
      confirmTone="danger"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export interface ConversationPanelComposerAccessoryProps {
  model: ConversationPanelModel;
  runtime?: RuntimeBridge;
  showScrollButton?: boolean;
  onOpenMcpSettings?: () => void;
}

export function ConversationPanelComposerAccessory({
  model,
  runtime,
  showScrollButton = true,
  onOpenMcpSettings,
}: ConversationPanelComposerAccessoryProps) {
  return (
    <ConversationComposerAccessory
      messages={model.messages}
      activeTask={model.activeTask}
      runningTaskRun={model.taskRunState?.runningTaskRun ?? null}
      mcpRuntime={
        runtime && model.sessionId
          ? {
              runtime,
              sessionId: model.sessionId,
              runtimeState: model.runtimeState,
            }
          : null
      }
      onUpdateTask={model.updateThreadTask}
      onDeleteTask={model.deleteThreadTask}
      onOpenMcpSettings={onOpenMcpSettings}
      showScrollToBottom={model.showScrollToBottom}
      showScrollButton={showScrollButton}
      onFilePreview={model.openFileChangePreview}
      onScrollToBottom={model.scrollToBottom}
    />
  );
}
