import { createContext, useContext } from "react";

import type { RuntimeBridge } from "@/runtime";
import type { SelectedQuote } from "@/renderer/components/chat/SendBox";
import type { AgentSession } from "@/types/protocol";
import type { SubagentRole, SubagentRunSnapshot } from "@/types/subagents";

export interface SubagentInvocationPanelDetails {
  invocationId: string;
  parentSessionId: string;
  role: SubagentRole;
  task: string;
  state: "queued" | "running" | "completed" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
}

export interface OpenRightSidebarConversationRequest {
  session: AgentSession;
  sourceSessionId?: string | null;
  title?: string | null;
  quote?: SelectedQuote | null;
  loadedHistoryTurnCount?: number | null;
}

export interface OpenBtwConversationRequest {
  sessionId: string;
  runtime: RuntimeBridge;
  quote?: SelectedQuote | null;
}

export interface RightSidebarConversationContextValue {
  openConversationPanel: (request: OpenRightSidebarConversationRequest) => void;
  openSubagentList: (parentSessionId: string) => void;
  openSubagentPanel: (run: SubagentRunSnapshot) => void;
  openSubagentInvocationPanel: (details: SubagentInvocationPanelDetails) => void;
  openBtwConversationFromSession: (request: OpenBtwConversationRequest) => Promise<AgentSession | null>;
}

export const RightSidebarConversationContext = createContext<RightSidebarConversationContextValue | null>(null);

export function useOptionalRightSidebarConversation() {
  return useContext(RightSidebarConversationContext);
}
