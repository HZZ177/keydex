import type { ReactNode } from "react";

import { SendBox, type SelectedFile, type SelectedQuote } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, type RuntimeModelSelection } from "@/renderer/components/model";
import type { WorkspaceSearchResult, WorkspaceSkillSummary } from "@/runtime";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";

export interface ConversationComposerProps {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  connectionReady: boolean;
  modelSelection: RuntimeModelSelection;
  workspaceSkills: WorkspaceSkillSummary[];
  selectedSkill: WorkspaceSkillSummary | null;
  onSearchWorkspace?: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
  onListWorkspaceDirectory?: (path: string) => Promise<WorkspaceSearchResult[]>;
  onOpenModelSettings?: () => void;
  onChange: (value: string) => void;
  onSkillChange: (skill: WorkspaceSkillSummary | null) => void;
  onSend: (files?: SelectedFile[], quotes?: SelectedQuote[]) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onEscape?: () => void;
  onOpenFileReference?: (file: SelectedFile) => void;
  externalFileRequest: { requestId: number; file: SelectedFile } | null;
  externalQuoteRequest: { requestId: number; quote: SelectedQuote } | null;
  controls?: ReactNode;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  inputLabel?: string;
  autoFocusKey?: string;
  modelSelectorPlacement?: "top" | "bottom";
}

export function ConversationComposer({
  value,
  runtimeState,
  canSend,
  canStop,
  connectionReady,
  modelSelection,
  workspaceSkills,
  selectedSkill,
  onSearchWorkspace,
  onListWorkspaceDirectory,
  onOpenModelSettings,
  onChange,
  onSkillChange,
  onSend,
  onStop,
  onEscape,
  onOpenFileReference,
  externalFileRequest,
  externalQuoteRequest,
  controls,
  className,
  placeholder,
  ariaLabel,
  inputLabel,
  autoFocusKey,
  modelSelectorPlacement = "top",
}: ConversationComposerProps) {
  return (
    <SendBox
      value={value}
      runtimeState={runtimeState}
      canSend={canSend}
      canStop={canStop}
      statusText={conversationComposerStatusText(runtimeState, connectionReady)}
      variant="keydex"
      className={className}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      inputLabel={inputLabel}
      autoFocusKey={autoFocusKey}
      controls={controls}
      rightControls={
        <RuntimeModelSelector
          model={modelSelection.selectedModel}
          modelOptions={modelSelection.modelOptions}
          modelLoadState={modelSelection.modelLoadState}
          modelError={modelSelection.modelError}
          disabled={isConversationBusy(runtimeState)}
          placement={modelSelectorPlacement}
          onModelChange={modelSelection.setSelectedModel}
          onOpenModelSettings={onOpenModelSettings}
        />
      }
      onChange={onChange}
      workspaceSkills={workspaceSkills}
      selectedSkill={selectedSkill}
      onSkillChange={onSkillChange}
      onSend={onSend}
      onStop={onStop}
      onEscape={onEscape}
      onOpenFileReference={onOpenFileReference}
      externalFileRequest={externalFileRequest}
      externalQuoteRequest={externalQuoteRequest}
      allowFileSelection={Boolean(onSearchWorkspace || onListWorkspaceDirectory)}
      onListWorkspaceDirectory={onListWorkspaceDirectory}
      onSearchWorkspace={onSearchWorkspace}
    />
  );
}

export function isConversationBusy(state: ConversationRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "waiting_approval" || state === "cancelling";
}

export function conversationComposerStatusText(state: ConversationRuntimeState, connectionReady: boolean): string {
  if (!connectionReady) {
    return "正在连接后端";
  }
  if (state === "idle" || state === "running") {
    return "";
  }
  return composerHint(state);
}

function composerHint(state: ConversationRuntimeState): string {
  switch (state) {
    case "starting":
      return "正在发起对话";
    case "running":
      return "智能体正在处理";
    case "waiting_approval":
      return "等待审批确认";
    case "cancelling":
      return "正在停止";
    case "failed":
      return "可以修改后重新发送";
    case "idle":
      return "回车发送";
  }
}
