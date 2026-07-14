import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type { RuntimeSelectedModel } from "@/renderer/components/model";

import { ConversationSessionSurface } from "./ConversationSessionSurface";

export interface ConversationPageProps {
  threadId: string;
  runtime?: RuntimeBridge;
  initialModel?: RuntimeSelectedModel | null;
  quickSendId?: string;
  focusTurnIndex?: number | null;
  focusTurnRequestId?: number;
  onOpenMcpSettings?: () => void;
  onOpenModelSettings?: () => void;
  onQuickSendConsumed?: () => void;
  onNavigateToConversation?: (threadId: string) => void;
  onArchived?: () => void;
}

export function ConversationPage({
  threadId,
  runtime = runtimeBridge,
  initialModel = null,
  quickSendId = "",
  focusTurnIndex = null,
  focusTurnRequestId,
  onOpenMcpSettings,
  onOpenModelSettings,
  onQuickSendConsumed,
  onNavigateToConversation,
  onArchived,
}: ConversationPageProps) {
  return (
    <ConversationSessionSurface
      threadId={threadId}
      runtime={runtime}
      initialModel={initialModel}
      quickSendId={quickSendId}
      focusTurnIndex={focusTurnIndex}
      focusTurnRequestId={focusTurnRequestId}
      onOpenMcpSettings={onOpenMcpSettings}
      onOpenModelSettings={onOpenModelSettings}
      onQuickSendConsumed={onQuickSendConsumed}
      onNavigateToConversation={onNavigateToConversation}
      onArchived={onArchived}
    />
  );
}
