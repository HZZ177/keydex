import { useEffect, useState, type ReactNode } from "react";

import {
  SendBox,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import type { SlashCommand } from "@/renderer/components/chat/SlashCommandMenu";
import { RuntimeModelSelector, type RuntimeModelSelection } from "@/renderer/components/model";
import { runtimeBridge, type RuntimeBridge, type WorkspaceSearchResult, type WorkspaceSkillSummary } from "@/runtime";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type { FileAccessMode } from "@/types/protocol";
import type { ContextWindowUsageStatus } from "./useConversationPanelModel";

import styles from "./ConversationComposer.module.css";

export interface ConversationComposerProps {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  connectionReady: boolean;
  modelSelection: RuntimeModelSelection;
  workspaceSkills: WorkspaceSkillSummary[];
  selectedSkill: WorkspaceSkillSummary | null;
  runtime?: RuntimeBridge;
  sessionId?: string | null;
  fileAccessMode?: FileAccessMode;
  workspaceRoots?: string[];
  allowBypassConversationSlashCommand?: boolean;
  selectedFiles?: SelectedFile[];
  selectedQuotes?: SelectedQuote[];
  onSearchWorkspace?: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
  onListWorkspaceDirectory?: (path: string) => Promise<WorkspaceSearchResult[]>;
  onOpenModelSettings?: () => void;
  onSelectedFilesChange?: (files: SelectedFile[]) => void;
  onSelectedQuotesChange?: (quotes: SelectedQuote[]) => void;
  onChange: (value: string) => void;
  onSkillChange: (skill: WorkspaceSkillSummary | null) => void;
  onSend: (
    files?: SelectedFile[],
    quotes?: SelectedQuote[],
    attachments?: SelectedImageAttachment[],
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onEscape?: () => void;
  onOpenFileReference?: (file: SelectedFile) => void;
  onSlashCommand?: (command: SlashCommand) => void;
  externalFileRequest: { requestId: number; file: SelectedFile } | null;
  externalQuoteRequest: { requestId: number; quote: SelectedQuote } | null;
  controls?: ReactNode;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  inputLabel?: string;
  autoFocusKey?: string;
  modelSelectorPlacement?: "top" | "bottom";
  contextWindowUsage?: ContextWindowUsageStatus | null;
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
  runtime = runtimeBridge,
  sessionId,
  fileAccessMode = "workspace_trusted",
  workspaceRoots = [],
  allowBypassConversationSlashCommand = true,
  selectedFiles,
  selectedQuotes,
  onSearchWorkspace,
  onListWorkspaceDirectory,
  onOpenModelSettings,
  onSelectedFilesChange,
  onSelectedQuotesChange,
  onChange,
  onSkillChange,
  onSend,
  onStop,
  onEscape,
  onOpenFileReference,
  onSlashCommand,
  externalFileRequest,
  externalQuoteRequest,
  controls,
  className,
  placeholder,
  ariaLabel,
  inputLabel,
  autoFocusKey,
  modelSelectorPlacement = "top",
  contextWindowUsage = null,
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
        <>
          <ContextWindowIndicator usage={contextWindowUsage} />
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
        </>
      }
      onChange={onChange}
      workspaceSkills={workspaceSkills}
      allowBypassConversationSlashCommand={allowBypassConversationSlashCommand}
      selectedFiles={selectedFiles}
      selectedQuotes={selectedQuotes}
      selectedSkill={selectedSkill}
      onSelectedFilesChange={onSelectedFilesChange}
      onSelectedQuotesChange={onSelectedQuotesChange}
      onSkillChange={onSkillChange}
      onSend={onSend}
      onStop={onStop}
      runtime={runtime}
      sessionId={sessionId}
      fileAccessMode={fileAccessMode}
      workspaceRoots={workspaceRoots}
      onEscape={onEscape}
      onOpenFileReference={onOpenFileReference}
      onSlashCommand={onSlashCommand}
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

export function conversationComposerStatusText(_state: ConversationRuntimeState, _connectionReady: boolean): string {
  return "";
}

function ContextWindowIndicator({ usage }: { usage: ContextWindowUsageStatus | null }) {
  const thresholdProgress = usage ? clampNonNegative(usage.thresholdUsageFraction) : 0;
  const ringProgress = clamp01(thresholdProgress);
  const [animatedRingProgress, setAnimatedRingProgress] = useState(0);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamp01(animatedRingProgress));
  const level = usage ? (thresholdProgress >= 1 ? "danger" : thresholdProgress >= 0.85 ? "warning" : "normal") : "idle";
  const ariaLabel = usage
    ? `当前已使用上下文 ${formatTokens(usage.tokenCount)} tokens，触发压缩进度 ${formatPercent(thresholdProgress)}`
    : "上下文窗口占用等待下一次模型调用";

  useEffect(() => {
    if (typeof window === "undefined") {
      setAnimatedRingProgress(ringProgress);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setAnimatedRingProgress(ringProgress);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ringProgress]);

  return (
    <span
      className={styles.contextWindowIndicator}
      role="img"
      tabIndex={0}
      aria-label={ariaLabel}
      data-level={level}
      data-testid="context-window-indicator"
    >
      <svg className={styles.contextWindowRing} viewBox="0 0 16 16" aria-hidden="true">
        <circle className={styles.contextWindowTrack} cx="8" cy="8" r={radius} />
        <circle
          className={styles.contextWindowProgress}
          cx="8"
          cy="8"
          r={radius}
          strokeDasharray={circumference}
          style={{ strokeDashoffset: dashOffset }}
        />
      </svg>
      <span className={styles.contextWindowTooltip} role="tooltip">
        <span className={styles.contextWindowTooltipTitle}>上下文窗口</span>
        {usage ? (
          <>
            <span className={styles.contextWindowTooltipSummary}>
              当前已使用 {formatTokens(usage.tokenCount)} tokens
            </span>
            <span className={styles.contextWindowTooltipMeta}>
              触发压缩进度 {formatPercent(thresholdProgress)}
            </span>
          </>
        ) : (
          <span className={styles.contextWindowTooltipMeta}>
            等待下一次模型调用后更新上下文占用和压缩阈值进度。
          </span>
        )}
      </span>
    </span>
  );
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}

function formatPercent(value: number): string {
  const percent = clampNonNegative(value) * 100;
  return `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`;
}

function clamp01(value: number): number {
  return Math.min(1, clampNonNegative(value));
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
