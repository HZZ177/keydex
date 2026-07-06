import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import {
  agentAttachmentFromSelected,
  selectedQuoteFromText,
  type SendBoxExternalQuoteRequest,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import {
  isDeepContextCompressionSlashCommand,
  isLightContextCompressionSlashCommand,
  type SlashCommand,
} from "@/renderer/components/chat/SlashCommandMenu";
import { useRuntimeModelSelection, type RuntimeSelectedModel } from "@/renderer/components/model";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";
import { subscribeInsertMcpPromptDraft } from "@/renderer/events/mcpPromptDraft";
import type {
  AgentActionEnvelope,
  AgentSession,
  AgentSessionFork,
  ManualContextCompressionMode,
} from "@/types/protocol";
import type { FileAccessMode } from "@/types/protocol";
import { GoalModeAccessory } from "@/renderer/components/chat/GoalModeAccessory";

import { ChatLayout } from "./ChatLayout";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationPanel, ConversationPanelComposerAccessory } from "./ConversationPanel";
import { useConversationPanelModel } from "./useConversationPanelModel";
import { ComposerApprovalCard } from "./ComposerApprovalCard";
import {
  createBtwConversationHistorySnapshot,
  filterBtwConversationVisibleMessages,
  type BtwConversationHistorySnapshot,
} from "./conversationForkSource";
import { consumeQuickChatSend, type QueuedQuickChatSend } from "./quickSend";
import {
  goalContextItem,
  goalSeedContextMetadata,
  runtimeParamsWithGoalContextItem,
  runtimeParamsWithInitialGoalTask,
} from "./goalSeedContext";
import styles from "./ConversationSessionSurface.module.css";

export type ConversationSessionSurfaceMode = "main" | "sidecar";

export interface ConversationSessionSurfaceProps {
  threadId: string;
  runtime?: RuntimeBridge;
  initialModel?: RuntimeSelectedModel | null;
  quickSendId?: string;
  focusTurnIndex?: number | null;
  focusTurnRequestId?: number;
  mode?: ConversationSessionSurfaceMode;
  previewPanelScopeKey?: string | null;
  sidecarQuoteRequest?: SendBoxExternalQuoteRequest | null;
  sidecarLoadedHistoryTurnCount?: number | null;
  onOpenModelSettings?: () => void;
  onSidecarQuoteRequestHandled?: (requestId: number) => void;
  onQuickSendConsumed?: () => void;
  onNavigateToConversation?: (threadId: string) => void;
}

export function ConversationSessionSurface({
  threadId,
  runtime = runtimeBridge,
  initialModel = null,
  quickSendId = "",
  focusTurnIndex = null,
  focusTurnRequestId,
  mode = "main",
  previewPanelScopeKey = null,
  sidecarQuoteRequest = null,
  sidecarLoadedHistoryTurnCount = null,
  onOpenModelSettings,
  onSidecarQuoteRequestHandled,
  onQuickSendConsumed,
  onNavigateToConversation,
}: ConversationSessionSurfaceProps) {
  const isSidecar = mode === "sidecar";
  const [allowPersistentTrust, setAllowPersistentTrust] = useState(true);
  const [fileAccessMode, setFileAccessMode] = useState<FileAccessMode>("workspace_trusted");
  const [goalComposerOpen, setGoalComposerOpen] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [goalCreating, setGoalCreating] = useState(false);
  const [contextCompressionMode, setContextCompressionMode] = useState<ManualContextCompressionMode | null>(null);
  const quickSendConsumedRef = useRef<string | null>(null);
  const pendingQuickSendRef = useRef<QueuedQuickChatSend | null>(null);
  const scrollToBottomAfterSendRef = useRef<(() => void) | null>(null);
  const runtimeEventSideEffectsRef = useRef<(event: AgentActionEnvelope) => void>(() => undefined);
  const runtimeErrorRef = useRef<(reason: unknown) => boolean | void>(() => false);
  const [sidecarHistorySnapshot, setSidecarHistorySnapshot] = useState<BtwConversationHistorySnapshot | null>(null);
  const notifications = useNotifications();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const rightSidebarConversation = useOptionalRightSidebarConversation();
  const modelSelection = useRuntimeModelSelection(runtime, initialModel, { enabled: backendReady });
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
    enabled: backendReady,
    historyPageSize: isSidecar ? 2 : 5,
    loadFullHistory: !isSidecar,
    onRuntimeEvent: handleControllerRuntimeEvent,
    onRuntimeError: handleControllerRuntimeError,
    onNotice: notifyRuntime,
    onOpenModelSettings,
    onAfterSend: () => scrollToBottomAfterSendRef.current?.(),
    syncThreadTasks: !isSidecar,
  });
  const draft = controller.draft;
  const setDraft = controller.setDraft;
  const fileChipRequest = controller.fileChipRequest;
  const quoteChipRequest = controller.quoteChipRequest;
  const selectedSkill = controller.selectedSkill;
  const setSelectedSkill = controller.setSelectedSkill;
  const loading = controller.loading;
  const session = controller.session;
  const pendingApproval = controller.pendingApproval;
  const agentMessages = controller.agentMessages;

  const navigateToForkSource = useCallback(
    (fork: AgentSessionFork | null | undefined) => {
      const sourceSessionId = fork?.source_session_id?.trim() ?? "";
      if (!sourceSessionId) {
        notifications.warning("源会话信息不完整");
        return;
      }
      onNavigateToConversation?.(sourceSessionId);
    },
    [notifications, onNavigateToConversation],
  );

  const panelModel = useConversationPanelModel({
    runtime,
    sessionId: threadId,
    controller,
    registerPreviewHost: !isSidecar,
    previewPanelScopeKey: isSidecar ? previewPanelScopeKey : null,
    emitForkSessionCreated: !isSidecar,
    onBranchSessionCreated: isSidecar ? undefined : onNavigateToConversation,
    onForkSessionCreated: isSidecar
      ? (forkedSession) =>
          rightSidebarConversation?.openConversationPanel({
            session: forkedSession,
            sourceSessionId: threadId,
          })
      : undefined,
    onNavigateToForkSource: onNavigateToConversation ? navigateToForkSource : undefined,
  });
  const runtimeState = panelModel.runtimeState;
  const activeSidecarHistorySnapshot =
    isSidecar && sidecarHistorySnapshot?.sessionId === threadId ? sidecarHistorySnapshot : null;
  const sidecarMessages = useMemo(() => {
    if (!isSidecar) {
      return panelModel.messages;
    }
    if (!activeSidecarHistorySnapshot) {
      return [];
    }
    return filterBtwConversationVisibleMessages(panelModel.messages, activeSidecarHistorySnapshot);
  }, [activeSidecarHistorySnapshot, isSidecar, panelModel.messages]);
  const resolvedSidecarLoadedHistoryTurnCount = activeSidecarHistorySnapshot?.loadedTurnCount ?? 0;
  const sidecarPanelModel = useMemo(() => {
    if (!isSidecar) {
      return panelModel;
    }
    return {
      ...panelModel,
      messages: sidecarMessages,
      loading: false,
      loadingOlderHistory: false,
      sessionViewState: panelModel.sessionViewState
        ? {
            ...panelModel.sessionViewState,
            historyHasMoreOlder: false,
          }
        : panelModel.sessionViewState,
    };
  }, [isSidecar, panelModel, sidecarMessages]);
  const focusTurnNavigationRequest = useMemo(() => {
    if (typeof focusTurnIndex !== "number" || !Number.isFinite(focusTurnIndex)) {
      return null;
    }
    return {
      flash: true,
      requestId: focusTurnRequestId ?? focusTurnIndex,
      targetTurnIndex: focusTurnIndex,
    };
  }, [focusTurnIndex, focusTurnRequestId]);
  const sidecarHistoryNotice = useMemo(
    () =>
      isSidecar && activeSidecarHistorySnapshot
        ? {
            content: `该会话前置${resolvedSidecarLoadedHistoryTurnCount}轮历史消息已加载`,
            tone: "success" as const,
            testId: "btw-conversation-history-notice",
            title: `该会话前置${resolvedSidecarLoadedHistoryTurnCount}轮历史消息已加载`,
          }
        : null,
    [activeSidecarHistorySnapshot, isSidecar, resolvedSidecarLoadedHistoryTurnCount],
  );
  const title = session?.title || (threadId ? `对话 ${threadId}` : "对话");
  const workspaceMeta = conversationWorkspaceMeta(session);
  const connectionReady = controller.connectionReady;
  const canSend = controller.canSend;
  const canStop = controller.canStop;
  const contextCompressionRunning = contextCompressionMode !== null;
  const selectedModelProviderId = modelSelection.selectedModel?.providerId ?? "";
  const selectedModelName = modelSelection.selectedModel?.model ?? "";
  const setSelectedRuntimeModel = modelSelection.setSelectedModel;

  useEffect(() => {
    const providerId = session?.current_model_provider_id?.trim() ?? "";
    const model = session?.current_model?.trim() ?? "";
    if (providerId && model && (providerId !== selectedModelProviderId || model !== selectedModelName)) {
      setSelectedRuntimeModel({ providerId, model });
    }
  }, [
    selectedModelName,
    selectedModelProviderId,
    session?.current_model,
    session?.current_model_provider_id,
    setSelectedRuntimeModel,
  ]);

  useEffect(() => {
    if (!isSidecar || loading) {
      return;
    }
    setSidecarHistorySnapshot((current) => {
      if (current?.sessionId === threadId) {
        if (
          sidecarLoadedHistoryTurnCount !== null &&
          current.loadedTurnCount !== sidecarLoadedHistoryTurnCount
        ) {
          return {
            ...current,
            loadedTurnCount: sidecarLoadedHistoryTurnCount,
          };
        }
        return current;
      }
      return createBtwConversationHistorySnapshot(threadId, panelModel.messages, {
        loadedTurnCount: sidecarLoadedHistoryTurnCount,
      });
    });
  }, [isSidecar, loading, panelModel.messages, sidecarLoadedHistoryTurnCount, threadId]);

  const changeModel = useCallback(
    (selection: RuntimeSelectedModel | null) => {
      modelSelection.setSelectedModel(selection);
      if (!selection || !session?.id) {
        return;
      }
      void runtime.conversation
        .updateSession(session.id, {
          current_model_provider_id: selection.providerId,
          current_model: selection.model,
        })
        .then((updated) => {
          controller.dispatch({ type: "session/upsert", session: updated });
        })
        .catch((reason: unknown) => {
          notifications.error(errorMessage(reason));
        });
    },
    [controller, modelSelection, notifications, runtime, session?.id],
  );

  useEffect(() => {
    scrollToBottomAfterSendRef.current = panelModel.scrollToBottomAfterSend;
  }, [panelModel.scrollToBottomAfterSend]);

  useEffect(() => {
    runtimeEventSideEffectsRef.current = panelModel.handleRuntimeEventSideEffects;
    runtimeErrorRef.current = panelModel.handleRuntimeError;
  }, [panelModel.handleRuntimeError, panelModel.handleRuntimeEventSideEffects]);

  useEffect(() => {
    if (!backendReady) {
      return;
    }
    let active = true;
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (active) {
          setAllowPersistentTrust(settings.command.allow_persistent_trust);
          setFileAccessMode(settings.command.file_access_mode);
        }
      })
      .catch(() => {
        if (active) {
          setAllowPersistentTrust(true);
          setFileAccessMode("workspace_trusted");
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, runtime]);

  const send = useCallback(
    (files: SelectedFile[] = [], quotes: SelectedQuote[] = [], attachments: SelectedImageAttachment[] = []) =>
      controller.send(files, quotes, attachments, modelSelection.selectedModel),
    [controller, modelSelection.selectedModel],
  );

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      if (goalError) {
        setGoalError(null);
      }
    },
    [goalError, setDraft],
  );

  useEffect(() => {
    return subscribeInsertMcpPromptDraft((detail) => {
      if (!detail.text.trim()) {
        return false;
      }
      if (detail.sessionId && detail.sessionId !== threadId) {
        return false;
      }
      if (!detail.sessionId && isSidecar) {
        return false;
      }
      setDraft((current) => (current.trim() ? `${current}\n\n${detail.text}` : detail.text));
      if (goalError) {
        setGoalError(null);
      }
      notifications.success(`已插入 MCP Prompt：${detail.rawName}`);
      return true;
    });
  }, [goalError, isSidecar, notifications, setDraft, threadId]);

  const openBtwConversation = useCallback(() => {
    if (!threadId || !rightSidebarConversation) {
      notifications.warning("当前会话无法开启旁路对话");
      return;
    }
    void rightSidebarConversation.openBtwConversationFromSession({
      sessionId: threadId,
      runtime,
    });
  }, [notifications, rightSidebarConversation, runtime, threadId]);

  const askSelectionInBtwConversation = useCallback(
    (text: string) => {
      const quote = selectedQuoteFromText(text, "selection");
      if (!quote) {
        return;
      }
      if (!threadId || !rightSidebarConversation) {
        notifications.warning("当前会话无法开启旁路对话");
        return;
      }
      void rightSidebarConversation.openBtwConversationFromSession({
        sessionId: threadId,
        runtime,
        quote,
      });
    },
    [notifications, rightSidebarConversation, runtime, threadId],
  );

  const runContextCompression = useCallback(
    async (mode: ManualContextCompressionMode) => {
      if (contextCompressionRunning) {
        notifications.warning("上下文压缩正在执行");
        return;
      }
      if (!threadId || isSidecar) {
        notifications.warning("当前会话无法压缩上下文");
        return;
      }
      if (!backendReady) {
        notifications.warning("本地服务尚未就绪");
        return;
      }
      setContextCompressionMode(mode);
      try {
        await runtime.conversation.compressContext(threadId, { mode });
        notifications.success(mode === "deep" ? "全量压缩已完成" : "上下文压缩已完成");
        void controller.reloadHistory().catch(() => undefined);
      } catch (reason) {
        notifications.error(contextCompressionErrorMessage(reason));
      } finally {
        setContextCompressionMode(null);
      }
    },
    [
      backendReady,
      contextCompressionRunning,
      controller,
      isSidecar,
      notifications,
      runtime,
      threadId,
    ],
  );

  const handleSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.id === "bypass-conversation") {
        openBtwConversation();
        return;
      }
      if (isLightContextCompressionSlashCommand(command)) {
        void runContextCompression("light");
        return;
      }
      if (isDeepContextCompressionSlashCommand(command)) {
        void runContextCompression("deep");
        return;
      }
      if (command.id === "goal") {
        if (controller.activeTask) {
          notifications.warning("当前已有进行中的目标");
          return;
        }
        setGoalComposerOpen(true);
        setGoalError(null);
      }
    },
    [controller.activeTask, notifications, openBtwConversation, runContextCompression],
  );

  const closeGoalComposer = useCallback(() => {
    if (goalCreating) {
      return;
    }
    setGoalComposerOpen(false);
    setGoalError(null);
  }, [goalCreating]);

  const createGoalTask = useCallback(async (files: SelectedFile[] = [], quotes: SelectedQuote[] = [], imageAttachments: SelectedImageAttachment[] = []) => {
    const prepared = prepareComposerMessage(draft, files, { quotes, selectedSkill });
    const attachments = imageAttachments.map(agentAttachmentFromSelected);
    const objective = prepared.message;
    if (!objective) {
      setGoalError("目标不能为空");
      return false;
    }
    if (!threadId) {
      setGoalError("当前会话无法创建目标");
      return false;
    }
    if (controller.activeTask) {
      setGoalError("当前已有进行中的目标");
      return false;
    }
    setGoalCreating(true);
    setGoalError(null);
    try {
      const task = await runtime.conversation.createThreadTask(threadId, {
        type: "goal",
        objective,
        metadata: goalSeedContextMetadata({
          message: prepared.message,
          contextItems: prepared.contextItems,
          runtimeParams: prepared.runtimeParams,
          attachments,
        }),
      });
      const goalItem = goalContextItem(objective);
      const runtimeParams = runtimeParamsWithInitialGoalTask(
        runtimeParamsWithGoalContextItem(prepared.runtimeParams, goalItem),
        task,
      );
      controller.dispatch({
        type: "event/receive",
        event: {
          action: "task_updated",
          data: {
            session_id: threadId,
            task_id: task.id,
            task,
          },
        },
      });
      const sent = await controller.sendText(prepared.message, modelSelection.selectedModel, {
        clearDraft: true,
        contextItems: [...prepared.contextItems, goalItem],
        runtimeParams,
        attachments,
      });
      if (!sent) {
        await runtime.conversation.deleteThreadTask(threadId, task.id).catch(() => null);
        controller.dispatch({
          type: "event/receive",
          event: {
            action: "task_deleted",
            data: {
              session_id: threadId,
              task_id: task.id,
              task,
            },
          },
        });
        setGoalError("目标消息发送失败，请处理发送问题后重试");
        return false;
      }
      setGoalComposerOpen(false);
      setSelectedSkill(null);
      notifications.success("目标已创建");
      return true;
    } catch (reason) {
      if (isTaskAlreadyOpenError(reason)) {
        try {
          const tasks = await runtime.conversation.listThreadTasks(threadId);
          controller.dispatch({ type: "tasks/loaded", sessionId: threadId, tasks });
          setGoalError("当前已有进行中的目标");
        } catch {
          setGoalError("当前已有进行中的目标，请刷新后再试");
        }
        return false;
      }
      setGoalError(errorMessage(reason));
      return false;
    } finally {
      setGoalCreating(false);
    }
  }, [controller, draft, modelSelection.selectedModel, notifications, runtime, selectedSkill, setSelectedSkill, threadId]);

  const sendFromComposer = useCallback(
    (files: SelectedFile[] = [], quotes: SelectedQuote[] = [], attachments: SelectedImageAttachment[] = []) => {
      if (goalComposerOpen) {
        return createGoalTask(files, quotes, attachments);
      }
      return send(files, quotes, attachments);
    },
    [createGoalTask, goalComposerOpen, send],
  );

  const sidecarExternalQuoteRequest = useMemo<SendBoxExternalQuoteRequest | null>(() => {
    if (!isSidecar || !sidecarQuoteRequest) {
      return null;
    }
    return {
      ...sidecarQuoteRequest,
      requestId: -Math.abs(sidecarQuoteRequest.requestId),
    };
  }, [isSidecar, sidecarQuoteRequest]);

  const goalModeAccessory = useMemo(() => {
    if (!goalComposerOpen || isSidecar) {
      return null;
    }
    return (
      <GoalModeAccessory creating={goalCreating} error={goalError} onClose={closeGoalComposer} />
    );
  }, [closeGoalComposer, goalComposerOpen, goalCreating, goalError, isSidecar]);

  const handleExternalQuoteRequestHandled = useCallback(
    (requestId: number) => {
      if (!isSidecar || !sidecarQuoteRequest || requestId !== -Math.abs(sidecarQuoteRequest.requestId)) {
        return;
      }
      onSidecarQuoteRequestHandled?.(sidecarQuoteRequest.requestId);
    },
    [isSidecar, onSidecarQuoteRequestHandled, sidecarQuoteRequest],
  );

  useEffect(() => {
    if (!quickSendId || !threadId || quickSendConsumedRef.current === quickSendId) {
      return;
    }
    let pending = pendingQuickSendRef.current;
    if (pending && pending.id !== quickSendId) {
      pendingQuickSendRef.current = null;
      pending = null;
    }
    if (!pending) {
      pending = consumeQuickChatSend(quickSendId, threadId);
      pendingQuickSendRef.current = pending;
      if (!pending) {
        quickSendConsumedRef.current = quickSendId;
        onQuickSendConsumed?.();
        return;
      }
      if (agentMessages.length === 0) {
        controller.dispatch({
          type: "message/addUser",
          sessionId: threadId,
          content: pending.message,
          contextItems: pending.contextItems,
          attachments: pending.attachments,
          id: `${pending.id}:user`,
        });
        controller.dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "running" });
      }
    }

    if (loading) {
      return;
    }
    if (agentMessages.some(isPersistedAgentMessage)) {
      pendingQuickSendRef.current = null;
      quickSendConsumedRef.current = quickSendId;
      onQuickSendConsumed?.();
      return;
    }
    if (!connectionReady) {
      return;
    }

    pendingQuickSendRef.current = null;
    quickSendConsumedRef.current = quickSendId;
    onQuickSendConsumed?.();
    void controller
      .sendText(pending.message, pending.model || modelSelection.selectedModel, {
        contextItems: pending.contextItems,
        runtimeParams: pending.runtimeParams,
        attachments: pending.attachments,
        skipOptimistic: true,
        allowWhileBusy: true,
      })
      .then((sent) => {
        if (!sent) {
          controller.dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "idle" });
          setDraft((current) => (current.trim() ? current : pending.message));
        }
      });
  }, [
    agentMessages,
    connectionReady,
    controller,
    loading,
    modelSelection.selectedModel,
    onQuickSendConsumed,
    quickSendId,
    setDraft,
    threadId,
  ]);

  const composer = pendingApproval ? (
    <ComposerApprovalCard
      allowPersistentTrust={allowPersistentTrust}
      approval={pendingApproval}
      error={controller.approvalError}
      submitting={controller.approvalSubmitting}
      onSubmit={controller.submitApproval}
    />
  ) : (
    <div className={styles.composerStack}>
      <ConversationComposer
        value={draft}
        runtimeState={runtimeState}
        canSend={
          contextCompressionRunning
            ? false
            : goalComposerOpen
              ? Boolean(draft.trim()) && !goalCreating && Boolean(threadId)
              : canSend
        }
        canStop={canStop}
        connectionReady={connectionReady}
        modelSelection={{ ...modelSelection, setSelectedModel: changeModel }}
        workspaceSkills={panelModel.workspaceSkills}
        allowBypassConversationSlashCommand={!isSidecar}
        allowGoalSlashCommand={!isSidecar}
        allowContextCompressionSlashCommand={!isSidecar}
        selectedSkill={selectedSkill}
        runtime={runtime}
        sessionId={threadId}
        fileAccessMode={fileAccessMode}
        workspaceRoots={sessionWorkspaceRoots(session)}
        onListWorkspaceDirectory={panelModel.listWorkspaceDirectory}
        onSearchWorkspace={panelModel.searchWorkspace}
        onOpenModelSettings={onOpenModelSettings}
        onChange={handleDraftChange}
        onSkillChange={setSelectedSkill}
        onSend={sendFromComposer}
        onStop={controller.stop}
        onOpenFileReference={panelModel.openFileReference}
        onSlashCommand={handleSlashCommand}
        onRefreshWorkspaceSkills={() => panelModel.refreshWorkspaceSkills({ forceReload: true })}
        externalFileRequest={fileChipRequest}
        externalQuoteRequest={sidecarExternalQuoteRequest ?? quoteChipRequest}
        onExternalQuoteRequestHandled={handleExternalQuoteRequestHandled}
        contextWindowUsage={panelModel.contextWindowUsage}
        modelSelectorPlacement={isSidecar ? "bottom" : "top"}
        autoFocusKey={isSidecar ? `sidecar:${threadId}` : undefined}
        leftAccessory={goalModeAccessory}
        placeholder={goalComposerOpen ? "Keydex 应继续朝哪个目标努力？" : undefined}
      />
    </div>
  );

  if (isSidecar) {
    return (
      <section className={styles.sidecar} data-testid="btw-conversation-panel">
        <div className={styles.sidecarBody}>
          <ConversationPanel
            model={sidecarPanelModel}
            workspaceRuntime={runtime}
            variant="compact"
            performanceProfile="interactivePanel"
            scrollButtonMode="external"
            topNotice={sidecarHistoryNotice}
            showForkSourceMarkers={false}
            showForkActions={false}
            emptyText="旁路对话暂无消息"
            emptyTestId="btw-conversation-empty"
          />
        </div>
        <div className={styles.sidecarComposer}>
          <ConversationPanelComposerAccessory model={sidecarPanelModel} runtime={runtime} />
          {composer}
        </div>
      </section>
    );
  }

  return (
    <ChatLayout
      title={title}
      workspaceLabel={workspaceMeta?.label}
      workspaceTitle={workspaceMeta?.title}
      sourceSessionAction={
        session?.fork_source && onNavigateToConversation
          ? {
              title: "查看源会话",
              onClick: () => navigateToForkSource(session.fork_source),
            }
          : undefined
      }
      composerAccessory={<ConversationPanelComposerAccessory model={panelModel} runtime={runtime} />}
      composer={composer}
    >
      <ConversationPanel
        model={panelModel}
        workspaceRuntime={runtime}
        scrollButtonMode="external"
        turnNavigationRequest={focusTurnNavigationRequest}
        onAskSelectionInBtwConversation={rightSidebarConversation ? askSelectionInBtwConversation : undefined}
        emptyText="还没有消息，输入需求开始对话。"
        emptyTestId="conversation-empty"
      />
    </ChatLayout>
  );
}

function conversationWorkspaceMeta(session: AgentSession | null): { label: string; title: string } | null {
  if (!session) {
    return null;
  }
  const workspaceName = session.workspace?.name?.trim() ?? "";
  const rootPath = (
    session.workspace?.root_path ??
    session.cwd ??
    session.workspace_roots?.find((root) => root.trim()) ??
    ""
  ).trim();
  const label = workspaceName || workspaceNameFromPath(rootPath);
  if (!label) {
    return null;
  }
  return {
    label,
    title: rootPath ? `${label}\n${rootPath}` : label,
  };
}

function workspaceNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function sessionWorkspaceRoots(session: AgentSession | null): string[] {
  if (!session) {
    return [];
  }
  return uniqueStrings([
    session.workspace?.root_path ?? "",
    session.cwd ?? "",
    ...(session.workspace_roots ?? []),
  ]);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

function contextCompressionErrorMessage(reason: unknown): string {
  const code = runtimeErrorCode(reason);
  if (code === "context_compression_disabled") {
    return "上下文压缩未启用";
  }
  if (code === "session_busy") {
    return "当前会话正在运行，无法压缩上下文";
  }
  if (code === "checkpoint_not_found") {
    return "当前会话还没有可压缩的上下文";
  }
  if (code === "no_compressible_messages") {
    return "当前会话没有可压缩的历史上下文";
  }
  if (code === "model_config_error") {
    return "快速模型配置不可用，无法生成压缩摘要";
  }
  if (code === "llm_error") {
    return "压缩摘要生成失败";
  }
  return errorMessage(reason);
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "操作失败";
}

function isTaskAlreadyOpenError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") {
    return false;
  }
  const code = (reason as { code?: unknown }).code;
  if (code === "task_already_open") {
    return true;
  }
  const message = (reason as { message?: unknown }).message;
  return typeof message === "string" && message.includes("task_already_open");
}

function isPersistedAgentMessage(message: { id: string; messageEventId?: string }): boolean {
  return Boolean(message.messageEventId || message.id.startsWith("hist:"));
}
