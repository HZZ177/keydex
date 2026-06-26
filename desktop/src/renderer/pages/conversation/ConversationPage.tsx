import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  runtimeBridge,
  type RuntimeBridge,
  type WorkspaceEntry,
  type WorkspaceSearchResult,
  type WorkspaceSkillSummary,
  type WsConnectionStatus,
} from "@/runtime";
import { SendBox, type SelectedFile, type SelectedQuote } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, type RuntimeModelSelection, useRuntimeModelSelection } from "@/renderer/components/model";
import {
  usePreview,
  type PreviewAnnotationChatRequest,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";
import type { ConversationMessage, ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type { AgentActionEnvelope, AgentChatMessage, AgentErrorData } from "@/types/protocol";

import { ChatLayout } from "./ChatLayout";
import { ConversationComposerAccessory } from "./ComposerAccessory";
import { MessageList, type FileChangePreview, type MessageListScrollControls, type ToolDetailsLoader } from "./messages";
import { ComposerApprovalCard } from "./ComposerApprovalCard";
import { consumeQuickChatSend } from "./quickSend";
import type { AgentToolDetailRef, AgentToolDetails } from "@/types/protocol";

export interface ConversationPageProps {
  threadId: string;
  runtime?: RuntimeBridge;
  initialModel?: string;
  quickSendId?: string;
  onOpenModelSettings?: () => void;
  onQuickSendConsumed?: () => void;
}

export function ConversationPage({
  threadId,
  runtime = runtimeBridge,
  initialModel = "",
  quickSendId = "",
  onOpenModelSettings,
  onQuickSendConsumed,
}: ConversationPageProps) {
  const [allowPersistentTrust, setAllowPersistentTrust] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const quickSendConsumedRef = useRef<string | null>(null);
  const sendScrollFrameRef = useRef<number | null>(null);
  const scrollToBottomAfterSendRef = useRef<(() => void) | null>(null);
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null);
  const runtimeEventSideEffectsRef = useRef<(event: AgentActionEnvelope) => void>(() => undefined);
  const runtimeErrorRef = useRef<(reason: unknown) => boolean | void>(() => false);
  const toolDetailCacheRef = useRef(
    new Map<string, Promise<Partial<ConversationMessage>> | Partial<ConversationMessage>>(),
  );
  const { openFilePanel, openPreview: openPreviewRequest, setPreviewHostContext } = usePreview();
  const notifications = useNotifications();
  const modelSelection = useRuntimeModelSelection(runtime, initialModel);
  const notifyRuntime = useCallback(
    (message: string, level: "error" | "warning") => {
      if (level === "warning") {
        notifications.warning(message);
      } else {
        notifications.error(message);
      }
    },
    [notifications],
  );
  const handleControllerRuntimeEvent = useCallback((event: AgentActionEnvelope) => {
    runtimeEventSideEffectsRef.current(event);
  }, []);
  const handleControllerRuntimeError = useCallback((reason: unknown) => runtimeErrorRef.current(reason), []);
  const controller = useAgentSessionController({
    runtime,
    sessionId: threadId,
    onRuntimeEvent: handleControllerRuntimeEvent,
    onRuntimeError: handleControllerRuntimeError,
    onNotice: notifyRuntime,
    onOpenModelSettings,
    onAfterSend: () => scrollToBottomAfterSendRef.current?.(),
  });
  const draft = controller.draft;
  const setDraft = controller.setDraft;
  const fileChipRequest = controller.fileChipRequest;
  const quoteChipRequest = controller.quoteChipRequest;
  const selectedSkill = controller.selectedSkill;
  const setSelectedSkill = controller.setSelectedSkill;
  const loading = controller.loading;
  const loadingOlderHistory = controller.loadingOlderHistory;
  const wsStatus = controller.wsStatus;
  const runtimeDetail = controller.runtimeDetail;

  const session = controller.session;
  const sessionViewState = controller.sessionViewState;
  const pendingApproval = controller.pendingApproval;
  const agentMessages = controller.agentMessages;
  const messages = useMemo(
    () => agentMessages.filter((message) => message.role !== "approval").map(agentMessageToConversationMessage),
    [agentMessages],
  );
  const runtimeState = controller.runtimeState;
  const title = session?.title || (threadId ? `对话 ${threadId}` : "对话");
  const messageWorkspaceScope = useMemo(() => ({ sessionId: threadId }), [threadId]);
  const workspaceUnavailable = Boolean(session && session.session_type === "workspace" && !session.workspace);
  const workspaceAvailable = Boolean(session?.session_type === "workspace" && session.workspace && !workspaceUnavailable);
  const workspaceLabel = session?.workspace?.root_path ?? session?.workspace?.name ?? session?.cwd ?? undefined;
  const workspaceSkillScope = useMemo(
    () => (workspaceAvailable ? { sessionId: threadId } : null),
    [threadId, workspaceAvailable],
  );
  const { state: workspaceSkillsState, refresh: refreshWorkspaceSkills } = useWorkspaceSkills({
    runtime,
    scope: workspaceSkillScope,
    enabled: workspaceAvailable,
  });
  const workspaceSkills = workspaceAvailable ? workspaceSkillsState.skills : [];
  const searchWorkspace =
    session?.session_type === "workspace" && session.workspace && !workspaceUnavailable
      ? (query: string, options?: { signal?: AbortSignal }) =>
          runtime.workspace.search({ sessionId: threadId }, query, options)
      : undefined;
  const listWorkspaceDirectory =
    session?.session_type === "workspace" && session.workspace && !workspaceUnavailable
      ? (path: string) =>
          runtime.workspace
            .listDirectory({ sessionId: threadId }, path)
            .then((response) => workspaceEntriesToSearchResults(response.entries))
      : undefined;
  const connectionReady = controller.connectionReady;
  const canSend = controller.canSend;
  const canStop = controller.canStop;

  const updateScrollControls = useCallback((controls: MessageListScrollControls) => {
    scrollToBottomRef.current = controls.scrollToBottom;
    setShowScrollToBottom(controls.showScrollToBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollToBottomRef.current?.("smooth");
  }, []);

  const scrollToBottomAfterSend = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (sendScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(sendScrollFrameRef.current);
    }
    sendScrollFrameRef.current = window.requestAnimationFrame(() => {
      sendScrollFrameRef.current = null;
      scrollToBottomRef.current?.("smooth");
    });
  }, []);

  useEffect(() => {
    scrollToBottomAfterSendRef.current = scrollToBottomAfterSend;
  }, [scrollToBottomAfterSend]);

  const handleSkillRuntimeError = useCallback(
    (reason: unknown) => {
      const code = runtimeErrorCode(reason);
      if (!code) {
        return false;
      }
      if (code === "skill_not_found") {
        setSelectedSkill(null);
        void refreshWorkspaceSkills({ forceReload: true });
        notifications.warning("Skill 不存在或已被删除，已刷新 Skill 列表");
        return true;
      }
      if (code === "skill_activation_invalid") {
        setSelectedSkill(null);
        notifications.warning("Skill 选择参数无效，请重新选择 Skill");
        return true;
      }
      if (code === "skill_source_unsupported") {
        setSelectedSkill(null);
        notifications.warning("系统级 Skill 暂未启用");
        return true;
      }
      if (code === "skill_session_unsupported") {
        setSelectedSkill(null);
        notifications.warning("请切换到工作空间会话后再使用 Skill");
        return true;
      }
      return false;
    },
    [notifications, refreshWorkspaceSkills],
  );

  const handleRuntimeEventSideEffects = useCallback(
    (event: AgentActionEnvelope) => {
      if (event.action === "workspaceSkillsChanged") {
        void refreshWorkspaceSkills({ forceReload: true });
      }
      if (event.action === "error") {
        handleSkillRuntimeError(event.data as AgentErrorData);
      }
    },
    [handleSkillRuntimeError, refreshWorkspaceSkills],
  );

  useEffect(() => {
    runtimeEventSideEffectsRef.current = handleRuntimeEventSideEffects;
    runtimeErrorRef.current = handleSkillRuntimeError;
  }, [handleRuntimeEventSideEffects, handleSkillRuntimeError]);

  useEffect(() => {
    if (!selectedSkill) {
      return;
    }
    if (
      !workspaceAvailable ||
      !workspaceSkills.some((skill) => skill.name === selectedSkill.name && skill.source === selectedSkill.source)
    ) {
      setSelectedSkill(null);
    }
  }, [selectedSkill, setSelectedSkill, workspaceAvailable, workspaceSkills]);

  useEffect(() => {
    return () => {
      if (sendScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(sendScrollFrameRef.current);
      }
    };
  }, []);

  const quoteSelection: (request: string | PreviewQuoteSelectionRequest) => void = controller.quoteSelection;
  const startChatFromAnnotation: (request: PreviewAnnotationChatRequest) => void = controller.startChatFromAnnotation;

  useEffect(() => {
    setPreviewHostContext({
      sessionId: threadId,
      workspaceAvailable,
      workspaceLabel,
      runtime,
      onQuoteSelection: quoteSelection,
      onStartChatFromAnnotation: startChatFromAnnotation,
    });
    return () => {
      setPreviewHostContext(null);
    };
  }, [
    quoteSelection,
    runtime,
    setPreviewHostContext,
    startChatFromAnnotation,
    threadId,
    workspaceAvailable,
    workspaceLabel,
  ]);

  useEffect(() => {
    let active = true;
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (active) {
          setAllowPersistentTrust(settings.command.allow_persistent_trust);
        }
      })
      .catch(() => {
        if (active) {
          setAllowPersistentTrust(true);
        }
      });
    return () => {
      active = false;
    };
  }, [runtime]);

  const openPreview = useCallback(
    (request: PreviewRequest) => {
      openPreviewRequest(request, {
        sessionId: threadId,
        workspaceAvailable,
        workspaceLabel,
        runtime,
        onQuoteSelection: quoteSelection,
        onStartChatFromAnnotation: startChatFromAnnotation,
      });
    },
    [openPreviewRequest, quoteSelection, runtime, startChatFromAnnotation, threadId, workspaceAvailable, workspaceLabel],
  );

  const openFileReference = useCallback(
    (file: SelectedFile) => {
      if (!workspaceAvailable || !file.path) {
        return;
      }
      openFilePanel(file.path, {
        sessionId: threadId,
        workspaceAvailable,
        workspaceLabel,
        runtime,
        onQuoteSelection: quoteSelection,
        onStartChatFromAnnotation: startChatFromAnnotation,
      }, selectedFileRevealTarget(file));
    },
    [openFilePanel, quoteSelection, runtime, startChatFromAnnotation, threadId, workspaceAvailable, workspaceLabel],
  );

  const openFileChangePreview = useCallback(
    (file: FileChangePreview) => {
      if (!workspaceAvailable || !file.path) {
        return;
      }
      openFilePanel(file.path, {
        sessionId: threadId,
        workspaceAvailable,
        workspaceLabel,
        runtime,
        onQuoteSelection: quoteSelection,
        onStartChatFromAnnotation: startChatFromAnnotation,
      });
    },
    [openFilePanel, quoteSelection, runtime, startChatFromAnnotation, threadId, workspaceAvailable, workspaceLabel],
  );

  useEffect(() => {
    toolDetailCacheRef.current.clear();
  }, [runtime, threadId]);

  const loadToolDetails = useCallback<ToolDetailsLoader>(
    async (message) => {
      const ref = toolDetailRefFromMessage(message);
      if (!ref) {
        return {};
      }
      const key = toolDetailCacheKey(threadId, ref);
      const cached = toolDetailCacheRef.current.get(key);
      if (cached) {
        return cached instanceof Promise ? await cached : cached;
      }
      const promise = runtime.conversation
        .loadToolDetails(threadId, ref)
        .then((detail) => conversationPatchFromToolDetails(message, detail));
      toolDetailCacheRef.current.set(key, promise);
      try {
        const patch = await promise;
        toolDetailCacheRef.current.set(key, patch);
        return patch;
      } catch (error) {
        toolDetailCacheRef.current.delete(key);
        throw error;
      }
    },
    [runtime, threadId],
  );

  const send = useCallback(
    (files: SelectedFile[] = [], quotes: SelectedQuote[] = []) =>
      controller.send(files, quotes, modelSelection.selectedModel.trim()),
    [controller, modelSelection.selectedModel],
  );

  useEffect(() => {
    if (!quickSendId || !threadId || loading || quickSendConsumedRef.current === quickSendId) {
      return;
    }
    if (agentMessages.length > 0) {
      quickSendConsumedRef.current = quickSendId;
      consumeQuickChatSend(quickSendId, threadId);
      onQuickSendConsumed?.();
      return;
    }
    if (!connectionReady) {
      return;
    }

    quickSendConsumedRef.current = quickSendId;
    const pending = consumeQuickChatSend(quickSendId, threadId);
    onQuickSendConsumed?.();
    if (!pending) {
      return;
    }
    void controller.sendText(pending.message, pending.model || modelSelection.selectedModel, {
      contextItems: pending.contextItems,
      runtimeParams: pending.runtimeParams,
    }).then((sent) => {
      if (!sent) {
        setDraft((current) => (current.trim() ? current : pending.message));
      }
    });
  }, [
    agentMessages.length,
    connectionReady,
    controller,
    loading,
    modelSelection.selectedModel,
    onQuickSendConsumed,
    quickSendId,
    setDraft,
    threadId,
  ]);

  return (
    <ChatLayout
      title={title}
      subtitle={connectionSubtitle(wsStatus)}
      composerAccessory={
        <ConversationComposerAccessory
          messages={messages}
          showScrollToBottom={showScrollToBottom}
          onFilePreview={openFileChangePreview}
          onScrollToBottom={scrollToBottom}
        />
      }
      composer={
        pendingApproval ? (
          <ComposerApprovalCard
            allowPersistentTrust={allowPersistentTrust}
            approval={pendingApproval}
            error={controller.approvalError}
            submitting={controller.approvalSubmitting}
            onSubmit={controller.submitApproval}
          />
        ) : (
          <ConversationComposer
            value={draft}
            runtimeState={runtimeState}
            canSend={canSend}
            canStop={canStop}
            connectionReady={connectionReady}
            modelSelection={modelSelection}
            workspaceSkills={workspaceSkills}
            selectedSkill={selectedSkill}
            onListWorkspaceDirectory={listWorkspaceDirectory}
            onSearchWorkspace={searchWorkspace}
            onOpenModelSettings={onOpenModelSettings}
            onChange={setDraft}
            onSkillChange={setSelectedSkill}
            onSend={send}
            onStop={controller.stop}
            onOpenFileReference={openFileReference}
            externalFileRequest={fileChipRequest}
            externalQuoteRequest={quoteChipRequest}
          />
        )
      }
    >
      <MessageList
        messages={messages}
        loading={loading}
        isProcessing={runtimeState === "running"}
        runtimeState={runtimeState}
        runtimeDetail={runtimeDetail}
        workspaceRuntime={runtime}
        workspaceScope={messageWorkspaceScope}
        onFilePreview={openFileChangePreview}
        onLoadToolDetails={loadToolDetails}
        onQuoteSelection={quoteSelection}
        hasMoreOlder={Boolean(sessionViewState?.historyHasMoreOlder)}
        loadingOlder={loadingOlderHistory}
        onLoadOlder={controller.loadOlderHistory}
        scrollButtonMode="external"
        onScrollControlsChange={updateScrollControls}
        emptyText="还没有消息，输入需求开始对话。"
        emptyTestId="conversation-empty"
      />
    </ChatLayout>
  );
}

function ConversationComposer({
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
  onOpenFileReference,
  externalFileRequest,
  externalQuoteRequest,
}: {
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
  onOpenFileReference?: (file: SelectedFile) => void;
  externalFileRequest: { requestId: number; file: SelectedFile } | null;
  externalQuoteRequest: { requestId: number; quote: SelectedQuote } | null;
}) {
  return (
    <SendBox
      value={value}
      runtimeState={runtimeState}
      canSend={canSend}
      canStop={canStop}
      statusText={composerStatusText(runtimeState, connectionReady)}
      variant="keydex"
      rightControls={
        <RuntimeModelSelector
          model={modelSelection.selectedModel}
          modelOptions={modelSelection.modelOptions}
          modelLoadState={modelSelection.modelLoadState}
          modelError={modelSelection.modelError}
          disabled={isBusy(runtimeState)}
          placement="top"
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
      onOpenFileReference={onOpenFileReference}
      externalFileRequest={externalFileRequest}
      externalQuoteRequest={externalQuoteRequest}
      allowFileSelection={Boolean(onSearchWorkspace || onListWorkspaceDirectory)}
      onListWorkspaceDirectory={onListWorkspaceDirectory}
      onSearchWorkspace={onSearchWorkspace}
    />
  );
}

function workspaceEntriesToSearchResults(entries: WorkspaceEntry[]): WorkspaceSearchResult[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    type: entry.type,
  }));
}

function selectedFileRevealTarget(file: SelectedFile): PreviewFileRevealTarget | null {
  if (!file.lineStart && !file.lineEnd && file.sourceStart == null && file.sourceEnd == null) {
    return null;
  }
  return {
    selectedText: file.selectedText ?? null,
    lineStart: file.lineStart ?? null,
    lineEnd: file.lineEnd ?? null,
    sourceStart: file.sourceStart ?? null,
    sourceEnd: file.sourceEnd ?? null,
  };
}

function agentMessageToConversationMessage(message: AgentChatMessage, index: number): ConversationMessage {
  const kind = conversationKindFromAgent(message);
  const status = conversationStatusFromAgent(message);
  const payload = payloadFromAgentMessage(message);
  const createdAt = isoFromTimestamp(message.timestamp, index);
  return {
    id: `agent:${message.id}`,
    threadId: message.sessionId,
    turnId: null,
    itemId: message.runId ?? message.id,
    kind,
    status,
    content: message.content,
    payload: { ...payload, _sortSeq: index + 1 },
    createdAt,
    updatedAt: createdAt,
  };
}

function conversationKindFromAgent(message: AgentChatMessage): ConversationMessage["kind"] {
  if (message.role === "user") {
    return "user";
  }
  if (message.role === "assistant") {
    return "assistant";
  }
  if (message.role === "reasoning" || message.role === "subagent") {
    return "thinking";
  }
  if (message.role === "tool") {
    if (message.toolName === "update_plan") {
      return "plan";
    }
    if (message.toolName === "load_skill") {
      return "skill";
    }
    if (isEditToolName(message.toolName) && hasFileChanges(message)) {
      return "file_change";
    }
    return message.toolName === "run_command" ? "command" : "tool";
  }
  if (message.role === "approval") {
    return "approval";
  }
  if (message.role === "error") {
    return "error";
  }
  return "status";
}

function conversationStatusFromAgent(message: AgentChatMessage): ConversationMessage["status"] {
  if (message.cancelled) {
    return "cancelled";
  }
  if (message.streaming || message.status === "streaming" || message.status === "running") {
    return "running";
  }
  if (message.status === "failed" || message.status === "error") {
    return "failed";
  }
  if (message.status === "cancelled") {
    return "cancelled";
  }
  if (message.role === "approval") {
    return message.status === "pending" ? "pending" : "completed";
  }
  if (message.role === "tool" || message.role === "assistant" || message.role === "reasoning" || message.role === "subagent") {
    return "completed";
  }
  return undefined;
}

function payloadFromAgentMessage(message: AgentChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    messageEventId: message.messageEventId,
    reasoningKind: message.reasoningKind,
    reasoning_kind: message.reasoningKind,
    ghostStats: message.ghostStats,
    traceId: message.traceId,
    traceQueryContext: message.traceQueryContext,
    cancelled: message.cancelled,
    contextItems: message.contextItems,
    toolDetailRef: message.toolDetailRef,
    toolDetailsDeferred: message.toolDetailsDeferred,
    toolSummary: message.toolSummary,
  };

  if (message.role === "tool") {
    return {
      ...base,
      call: {
        id: message.toolCallId,
        name: message.toolName,
        arguments: message.toolParams ?? {},
      },
      result: {
        status:
          message.toolError || message.status === "error"
            ? "error"
            : message.status === "running" || message.streaming
              ? "running"
              : "success",
        model_content: message.toolResult ?? "",
        duration_ms: message.toolDurationMs,
        error: message.toolError,
        ui_payload: message.uiPayload,
        files: message.fileChanges ?? fileChangesFromUiPayload(message.uiPayload),
      },
      files: message.fileChanges ?? fileChangesFromUiPayload(message.uiPayload),
      duration_ms: message.toolDurationMs,
      metadata: message.metadata,
      messageEventId: message.messageEventId,
      toolCallId: message.toolCallId,
      runId: message.runId,
      toolDetailRef: message.toolDetailRef,
      toolDetailsDeferred: message.toolDetailsDeferred,
      toolSummary: message.toolSummary,
    };
  }

  if (message.role === "approval") {
    return {
      ...base,
      approval: message.approval,
    };
  }

  if (message.role === "error") {
    return {
      ...base,
      error: {
        code: typeof message.status === "string" ? message.status : "runtime_error",
        message: message.content,
        details: {},
      },
    };
  }

  if (message.role === "subagent") {
    return {
      ...base,
      reasoningKind: "subagent",
      reasoning_kind: "subagent",
      subagentName: message.subagentName,
      subagentTask: message.subagentTask,
      subagentItems: message.subagentItems,
    };
  }

  return base;
}

function toolDetailRefFromMessage(message: ConversationMessage): AgentToolDetailRef | null {
  const ref = asRecord(message.payload.toolDetailRef);
  if (!ref) {
    return null;
  }
  const startEventId = nullableString(ref.startEventId);
  const endEventId = nullableString(ref.endEventId);
  if (!startEventId && !endEventId) {
    return null;
  }
  return {
    startEventId,
    endEventId,
    runId: nullableString(ref.runId),
    toolCallId: nullableString(ref.toolCallId),
  };
}

function toolDetailCacheKey(sessionId: string, ref: AgentToolDetailRef): string {
  return [
    sessionId,
    ref.startEventId ?? "",
    ref.endEventId ?? "",
    ref.runId ?? "",
    ref.toolCallId ?? "",
  ].join(":");
}

function conversationPatchFromToolDetails(
  message: ConversationMessage,
  detail: AgentToolDetails,
): Partial<ConversationMessage> {
  const currentCall = asRecord(message.payload.call);
  const currentResult = asRecord(message.payload.result);
  const status = conversationStatusFromToolDetail(detail, message.status);
  const resultStatus =
    detail.toolError || detail.status === "error" || detail.status === "failed"
      ? "error"
      : detail.status === "running"
        ? "running"
        : "success";
  const payload: Record<string, unknown> = {
    call: {
      ...currentCall,
      name: detail.toolName ?? stringValue(currentCall?.name),
      arguments: detail.toolParams ?? currentCall?.arguments ?? {},
    },
    result: {
      ...currentResult,
      status: resultStatus,
      model_content: detail.toolResult ?? "",
      duration_ms: detail.toolDurationMs,
      error: detail.toolError ?? undefined,
      ui_payload: detail.uiPayload ?? undefined,
      files: detail.fileChanges ?? [],
    },
    files: detail.fileChanges ?? [],
    duration_ms: detail.toolDurationMs,
    metadata: detail.metadata ?? message.payload.metadata,
    toolDetailRef: detail.detailRef ?? message.payload.toolDetailRef,
    toolDetailsDeferred: false,
    toolSummary: message.payload.toolSummary,
  };
  return {
    status,
    payload,
  };
}

function conversationStatusFromToolDetail(
  detail: AgentToolDetails,
  fallback: ConversationMessage["status"],
): ConversationMessage["status"] {
  if (detail.status === "running") {
    return "running";
  }
  if (detail.status === "cancelled") {
    return "cancelled";
  }
  if (detail.toolError || detail.status === "error" || detail.status === "failed") {
    return "failed";
  }
  return fallback === "pending" || fallback === "running" ? fallback : "completed";
}

function isEditToolName(toolName: string | undefined): boolean {
  return ["write_file", "apply_patch", "edit_file", "create_file", "delete_file"].includes(toolName ?? "");
}

function hasFileChanges(message: AgentChatMessage): boolean {
  return Boolean(message.fileChanges?.length || fileChangesFromUiPayload(message.uiPayload).length);
}

function fileChangesFromUiPayload(uiPayload: Record<string, unknown> | undefined): unknown[] {
  if (!uiPayload) {
    return [];
  }
  if (Array.isArray(uiPayload.files)) {
    return uiPayload.files;
  }
  if (Array.isArray(uiPayload.changes)) {
    return uiPayload.changes;
  }
  return [];
}

function isBusy(state: ConversationRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "waiting_approval" || state === "cancelling";
}

function composerStatusText(state: ConversationRuntimeState, connectionReady: boolean): string {
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

function connectionSubtitle(status: WsConnectionStatus): string {
  switch (status) {
    case "open":
      return "本地 Python 智能体运行时";
    case "connecting":
    case "reconnecting":
      return "正在连接本地智能体运行时";
    case "error":
      return "智能体运行时连接异常";
    case "closed":
      return "智能体运行时已断开";
    case "idle":
      return "等待连接智能体运行时";
  }
}

function runtimeErrorCode(reason: unknown): string | null {
  const record = objectRecord(reason);
  if (typeof record?.code === "string") {
    return record.code;
  }
  const detail = objectRecord(record?.detail);
  if (typeof detail?.code === "string") {
    return detail.code;
  }
  const details = objectRecord(record?.details);
  if (typeof details?.code === "string") {
    return details.code;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isoFromTimestamp(timestamp: number, index: number): string {
  if (timestamp > 1_000_000_000_000) {
    return new Date(timestamp).toISOString();
  }
  return new Date(Date.now() + index).toISOString();
}
