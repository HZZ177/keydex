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
import { useA2UIRenderSuspension } from "./messages/a2ui/A2UIRenderSuspensionContext";
import { ReverseDialog } from "./ReverseDialog";
import type { ConversationPanelModel } from "./useConversationPanelModel";
import type { SubagentRunSnapshot } from "@/types/subagents";
import { mergeSubagentRunsIntoConversation } from "./subagents/subagentTimeline";

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
  a2uiDebugInfoEnabled?: boolean;
  a2uiRenderSuspended?: boolean;
  showForkSourceMarkers?: boolean;
  showForkActions?: boolean;
  onAskSelectionInBtwConversation?: (text: string) => void;
  className?: string;
  subagentRuns?: SubagentRunSnapshot[];
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
  a2uiDebugInfoEnabled = false,
  a2uiRenderSuspended = false,
  showForkSourceMarkers = true,
  showForkActions = true,
  onAskSelectionInBtwConversation,
  className = "",
  subagentRuns = [],
}: ConversationPanelProps) {
  const inheritedA2UIRenderSuspended = useA2UIRenderSuspension();
  const effectiveA2UIRenderSuspended = a2uiRenderSuspended || inheritedA2UIRenderSuspended;
  const timelineMessages = mergeSubagentRunsIntoConversation(model.messages, subagentRuns);

  return (
    <div
      className={[styles.panel, className].filter(Boolean).join(" ")}
      data-testid="conversation-panel"
      data-conversation-panel-variant={variant}
    >
      <MessageList
        key={model.sessionId || "empty-session"}
        messages={timelineMessages}
        variant={variant}
        performanceProfile={performanceProfile}
        loading={model.loading}
        isProcessing={model.runtimeState === "running"}
        runtimeState={model.runtimeState}
        turnFirstTokenAtMs={model.sessionViewState?.firstTokenAtMs}
        runtimeDetail={model.runtimeDetail}
        workspaceRuntime={workspaceRuntime}
        workspaceScope={model.messageWorkspaceScope}
        onFilePreview={model.openFileChangePreview}
        onLoadToolDetails={model.loadToolDetails}
        onTerminateCommand={model.terminateCommand}
        a2uiDebugInfoEnabled={a2uiDebugInfoEnabled}
        a2uiRenderSuspended={effectiveA2UIRenderSuspended}
        onA2UISubmit={model.submitA2UI}
        onA2UICancel={model.cancelA2UI}
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
        <ReverseDialog
          state={model.reverseConfirmation}
          onCancel={model.cancelReverseFromMessage}
          onConfirm={model.confirmReverseFromMessage}
          onSelectMode={model.selectReverseMode}
          onExternalConfirmationChange={model.confirmExternalReversePaths}
          onDecision={model.decideReverseFailure}
          onRetryPreview={model.retryReversePreview}
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
      pendingInputs={model.pendingInputs}
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
      onPendingInputModeChange={model.updatePendingInputMode}
      onPendingInputReorder={model.reorderPendingInputs}
      onPendingInputCancel={model.cancelPendingInput}
      onPendingInputResume={model.resumePendingInputs}
      onPendingInputEdit={model.editPendingInput}
      onOpenMcpSettings={onOpenMcpSettings}
      showScrollToBottom={model.showScrollToBottom}
      showScrollButton={showScrollButton}
      onFilePreview={model.openFileChangePreview}
      onScrollToBottom={model.scrollToBottom}
    />
  );
}
