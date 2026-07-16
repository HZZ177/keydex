import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createLifecycleRequestId,
  decodeLifecycleRuntimeError,
  runtimeBridge,
  type LifecycleRuntimeError,
  type RuntimeBridge,
} from "@/runtime";
import {
  agentAttachmentFromSelected,
  selectedQuoteFromText,
  type PastedTextFragment,
  type SendBoxExternalQuoteRequest,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import {
  isContextCompressionSlashCommand,
  type SlashCommand,
} from "@/renderer/components/chat/SlashCommandMenu";
import { AppDialog, ConfirmDialog, DialogButton } from "@/renderer/components/dialog";
import { useRuntimeModelSelection, type RuntimeSelectedModel } from "@/renderer/components/model";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { emitLifecycleEvent } from "@/renderer/events/lifecycleEvents";
import { emitSessionCreated, emitSessionUpdated } from "@/renderer/events/sessionEvents";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useWorkspaceFileWatchScope } from "@/renderer/providers/FileChangeProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import {
  activeProjectDiscoveryFromSession,
  usePublishActiveProjectDiscovery,
} from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";
import {
  buildSessionMarkdown,
  createSessionMarkdownFilename,
  saveSessionMarkdownFile,
} from "@/renderer/utils/sessionMarkdownExport";
import type {
  AgentActionEnvelope,
  AgentChatMessage,
  AgentSession,
  AgentSessionFork,
  PendingInputMode,
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
  latestCompleteForkSource,
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
  a2uiRenderSuspended?: boolean;
  onOpenMcpSettings?: () => void;
  onOpenModelSettings?: () => void;
  onSidecarQuoteRequestHandled?: (requestId: number) => void;
  onQuickSendConsumed?: () => void;
  onNavigateToConversation?: (threadId: string) => void;
  onArchived?: () => void;
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
  a2uiRenderSuspended = false,
  onOpenMcpSettings,
  onOpenModelSettings,
  onSidecarQuoteRequestHandled,
  onQuickSendConsumed,
  onNavigateToConversation,
  onArchived,
}: ConversationSessionSurfaceProps) {
  const isSidecar = mode === "sidecar";
  const [allowPersistentTrust, setAllowPersistentTrust] = useState(true);
  const [fileAccessMode, setFileAccessMode] = useState<FileAccessMode>("workspace_trusted");
  const [conversationSendDefaultMode, setConversationSendDefaultMode] = useState<PendingInputMode>("steer");
  const [a2uiDebugInfoEnabled, setA2UIDebugInfoEnabled] = useState(false);
  const [contextCompressionEnabled, setContextCompressionEnabled] = useState(true);
  const [goalComposerOpen, setGoalComposerOpen] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [goalCreating, setGoalCreating] = useState(false);
  const [contextCompressionRunning, setContextCompressionRunning] = useState(false);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveBlocker, setArchiveBlocker] = useState<LifecycleRuntimeError | null>(null);
  const [forkingSession, setForkingSession] = useState(false);
  const [exportingSession, setExportingSession] = useState(false);
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
    conversationSendDefaultMode,
  });
  const draft = controller.draft;
  const setDraft = controller.setDraft;
  const composerDraft = controller.composerDraft;
  const composerContextRequest = controller.composerContextRequest;
  const fileChipRequest = controller.fileChipRequest;
  const quoteChipRequest = controller.quoteChipRequest;
  const selectedSkill = controller.selectedSkill;
  const setSelectedSkill = controller.setSelectedSkill;
  const loading = controller.loading;
  const session = controller.session;
  const activeProjectDiscovery = useMemo(
    () => activeProjectDiscoveryFromSession(session, loading),
    [loading, session],
  );
  usePublishActiveProjectDiscovery(`conversation:${threadId}`, activeProjectDiscovery, !isSidecar);
  useWorkspaceFileWatchScope(session?.workspace_id);
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

  useEffect(() => {
    setEditingTitle(null);
    setArchiveBlocker(null);
    setArchiveBusy(false);
    setForkingSession(false);
    setExportingSession(false);
  }, [threadId]);

  const renameSession = useCallback(async () => {
    const sessionId = session?.id?.trim() ?? "";
    const cleanedTitle = editingTitle?.trim() ?? "";
    if (!cleanedTitle) {
      notifications.warning("会话标题不能为空");
      return;
    }
    if (!sessionId || typeof runtime.conversation.updateSession !== "function") {
      notifications.warning("当前后端不支持重命名会话");
      return;
    }
    try {
      const updated = await runtime.conversation.updateSession(sessionId, { title: cleanedTitle });
      controller.dispatch({ type: "session/upsert", session: updated });
      emitSessionUpdated(updated);
      setEditingTitle(null);
      notifications.success("已重命名会话");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }, [controller, editingTitle, notifications, runtime, session?.id]);

  const archiveSession = useCallback(async (stopIfActive = false) => {
    const sessionId = session?.id?.trim() ?? "";
    if (!sessionId || typeof runtime.conversation.archiveSession !== "function" || archiveBusy) {
      if (!sessionId) {
        notifications.warning("当前会话不可归档");
      }
      return;
    }
    setArchiveBusy(true);
    try {
      const result = await runtime.conversation.archiveSession(sessionId, {
        requestId: createLifecycleRequestId("session-archive"),
        stopIfActive,
      });
      if (result.event) {
        emitLifecycleEvent(result.event);
      }
      setArchiveBlocker(null);
      notifications.success("已归档");
      onArchived?.();
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind === "archive_requires_stop_confirmation") {
        setArchiveBlocker(decoded);
      } else {
        notifications.error(errorMessage(reason));
      }
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveBusy, notifications, onArchived, runtime, session?.id]);

  const forkSessionFromLatestTurn = useCallback(async () => {
    const sessionId = session?.id?.trim() ?? "";
    if (!sessionId || typeof runtime.conversation.forkSession !== "function" || forkingSession) {
      return;
    }
    setForkingSession(true);
    try {
      const history = await runtime.conversation.loadHistory(sessionId, { pageSize: 100 });
      const source = latestCompleteForkSource(history.list);
      if (!source) {
        notifications.warning("没有可派生的完整回合");
        return;
      }
      const response = await runtime.conversation.forkSession(sessionId, source);
      emitSessionCreated(response.session);
      notifications.success("已创建派生会话");
      onNavigateToConversation?.(response.session.id);
    } catch (reason) {
      notifications.error(`派生失败：${errorMessage(reason)}`);
    } finally {
      setForkingSession(false);
    }
  }, [forkingSession, notifications, onNavigateToConversation, runtime, session?.id]);

  const exportSession = useCallback(async () => {
    const sessionId = session?.id?.trim() ?? "";
    if (!sessionId || exportingSession) {
      return;
    }
    setExportingSession(true);
    try {
      const history = await runtime.conversation.loadHistory(sessionId, {
        allTurns: true,
        direction: "older",
      });
      const markdown = buildSessionMarkdown(title, history.list);
      if (!markdown) {
        notifications.warning("当前会话没有可导出的对话正文");
        return;
      }
      const result = await saveSessionMarkdownFile(markdown, createSessionMarkdownFilename(title));
      if (result !== "cancelled") {
        notifications.success("会话记录已导出");
      }
    } catch (reason) {
      notifications.error(`导出失败：${errorMessage(reason)}`);
    } finally {
      setExportingSession(false);
    }
  }, [exportingSession, notifications, runtime, session?.id, title]);

  const refreshSession = useCallback(() => {
    void controller.reloadHistory().catch((reason: unknown) => {
      notifications.error(errorMessage(reason));
    });
  }, [controller, notifications]);
  const connectionReady = controller.connectionReady;
  const canSend = controller.canSend;
  const canStop = controller.canStop;
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
          setConversationSendDefaultMode(settings.general.conversation_send_default_mode ?? "steer");
        }
      })
      .catch(() => {
        if (active) {
          setAllowPersistentTrust(true);
          setFileAccessMode("workspace_trusted");
          setConversationSendDefaultMode("steer");
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, runtime]);

  useEffect(() => {
    if (!backendReady) {
      setA2UIDebugInfoEnabled(false);
      setContextCompressionEnabled(true);
      return;
    }
    let active = true;
    void runtime.settings
      .getExtensionSettings()
      .then((settings) => {
        if (active) {
          setA2UIDebugInfoEnabled(Boolean(settings.a2ui.debug_info_enabled));
          setContextCompressionEnabled(Boolean(settings.context_compression.enabled));
        }
      })
      .catch(() => {
        if (active) {
          setA2UIDebugInfoEnabled(false);
          setContextCompressionEnabled(true);
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, runtime]);

  const send = useCallback(
    (
      files: SelectedFile[] = [],
      quotes: SelectedQuote[] = [],
      attachments: SelectedImageAttachment[] = [],
      options?: { reverseDeliveryMode?: boolean; deliveryMode?: PendingInputMode },
    ) => controller.send(files, quotes, attachments, modelSelection.selectedModel, options),
    [controller, modelSelection.selectedModel],
  );

  const handleDraftChange = useCallback(
    (value: string) => {
      controller.setComposerDraft({ text: value });
      if (goalError) {
        setGoalError(null);
      }
    },
    [controller.setComposerDraft, goalError],
  );
  const handlePastedTextFragmentsChange = useCallback(
    (pastedTextFragments: PastedTextFragment[], value: string) =>
      controller.setComposerDraft({ text: value, pastedTextFragments }),
    [controller.setComposerDraft],
  );

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
    async () => {
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
      setContextCompressionRunning(true);
      try {
        await runtime.conversation.compressContext(threadId);
        notifications.success("上下文压缩已完成");
        void controller.reloadHistory().catch(() => undefined);
      } catch (reason) {
        notifications.error(contextCompressionErrorMessage(reason));
      } finally {
        setContextCompressionRunning(false);
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
      if (isContextCompressionSlashCommand(command)) {
        void runContextCompression();
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
    (
      files: SelectedFile[] = [],
      quotes: SelectedQuote[] = [],
      attachments: SelectedImageAttachment[] = [],
      options?: { reverseDeliveryMode?: boolean; deliveryMode?: PendingInputMode },
    ) => {
      if (goalComposerOpen) {
        return createGoalTask(files, quotes, attachments);
      }
      return send(files, quotes, attachments, options);
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
      if (!hasQuickSendUserMessage(agentMessages, pending)) {
        controller.dispatch({
          type: "message/addUser",
          sessionId: threadId,
          content: pending.message,
          contextItems: pending.contextItems,
          attachments: pending.attachments,
          id: quickSendUserMessageId(pending),
        });
        controller.dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "running" });
      }
    }

    if (loading) {
      return;
    }
    if (agentMessages.some((message) => isPersistedQuickSendUserMessage(message, pending))) {
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
        skills={panelModel.effectiveSkills}
        skillDiagnostics={panelModel.effectiveSkillDiagnostics}
        allowBypassConversationSlashCommand={!isSidecar}
        allowGoalSlashCommand={!isSidecar}
        allowContextCompressionSlashCommand={!isSidecar}
        selectedSkill={selectedSkill}
        selectedFiles={composerDraft.files}
        selectedQuotes={composerDraft.quotes}
        selectedImageAttachments={composerDraft.attachments}
        pastedTextFragments={composerDraft.pastedTextFragments}
        runtime={runtime}
        sessionId={threadId}
        fileAccessMode={fileAccessMode}
        workspaceRoots={sessionWorkspaceRoots(session)}
        onListWorkspaceDirectory={panelModel.listWorkspaceDirectory}
        onSearchWorkspace={panelModel.searchWorkspace}
        onOpenModelSettings={onOpenModelSettings}
        onChange={handleDraftChange}
        onSelectedFilesChange={(files) => controller.setComposerDraft({ files })}
        onSelectedQuotesChange={(quotes) => controller.setComposerDraft({ quotes })}
        onSelectedImageAttachmentsChange={(attachments) => controller.setComposerDraft({ attachments })}
        onPastedTextFragmentsChange={handlePastedTextFragmentsChange}
        onSkillChange={setSelectedSkill}
        onSend={sendFromComposer}
        onStop={controller.stop}
        onOpenFileReference={panelModel.openFileReference}
        onOpenSkill={panelModel.openSkillResource}
        onSlashCommand={handleSlashCommand}
        onRefreshSkills={() => panelModel.refreshEffectiveSkills({ forceReload: true })}
        externalContextRequest={composerContextRequest}
        externalFileRequest={fileChipRequest}
        externalQuoteRequest={sidecarExternalQuoteRequest ?? quoteChipRequest}
        onExternalQuoteRequestHandled={handleExternalQuoteRequestHandled}
        contextWindowUsage={panelModel.contextWindowUsage}
        contextCompressionEnabled={contextCompressionEnabled}
        modelSelectorPlacement={isSidecar ? "bottom" : "top"}
        autoFocusKey={isSidecar ? `sidecar:${threadId}` : quickSendId || undefined}
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
            a2uiDebugInfoEnabled={a2uiDebugInfoEnabled}
            a2uiRenderSuspended={a2uiRenderSuspended}
          />
        </div>
        <div className={styles.sidecarComposer}>
          <ConversationPanelComposerAccessory model={sidecarPanelModel} runtime={runtime} onOpenMcpSettings={onOpenMcpSettings} />
          {composer}
        </div>
      </section>
    );
  }

  const canMutateSession =
    Boolean(session?.id) &&
    typeof runtime.conversation.updateSession === "function" &&
    typeof runtime.conversation.archiveSession === "function";
  const canForkSession =
    Boolean(session?.id) &&
    typeof runtime.conversation.loadHistory === "function" &&
    typeof runtime.conversation.forkSession === "function";
  const canExportSession = Boolean(session?.id) && typeof runtime.conversation.loadHistory === "function";

  return (
    <>
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
        sessionActions={{
          canExport: canExportSession,
          exporting: exportingSession,
          onExport: () => void exportSession(),
          canFork: canForkSession,
          forking: forkingSession,
          onFork: () => void forkSessionFromLatestTurn(),
          canMutate: canMutateSession,
          onRename: () => setEditingTitle(title),
          archiving: archiveBusy,
          onArchive: () => void archiveSession(false),
          showRefresh: true,
          onRefresh: refreshSession,
        }}
        composerAccessory={
          <ConversationPanelComposerAccessory
            model={panelModel}
            runtime={runtime}
            onOpenMcpSettings={onOpenMcpSettings}
          />
        }
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
          a2uiDebugInfoEnabled={a2uiDebugInfoEnabled}
          a2uiRenderSuspended={a2uiRenderSuspended}
        />
      </ChatLayout>

      {editingTitle !== null ? (
        <AppDialog
          title="重命名会话"
          description="修改后会同步到会话历史。"
          size="form"
          closeLabel="取消重命名"
          closeOnOverlayClick={false}
          onClose={() => setEditingTitle(null)}
        >
          <form
            className={styles.renameDialogForm}
            onSubmit={(event) => {
              event.preventDefault();
              void renameSession();
            }}
          >
            <label className={styles.renameDialogField}>
              <span>会话名称</span>
              <input
                autoFocus
                aria-label="会话名称"
                onChange={(event) => setEditingTitle(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                value={editingTitle}
              />
            </label>
            <footer className={styles.renameDialogActions}>
              <DialogButton type="button" aria-label="取消重命名" onClick={() => setEditingTitle(null)}>
                取消
              </DialogButton>
              <DialogButton tone="primary" type="submit" aria-label="保存重命名">
                保存
              </DialogButton>
            </footer>
          </form>
        </AppDialog>
      ) : null}

      {archiveBlocker ? (
        <ConfirmDialog
          title="停止并归档会话？"
          description="该会话仍有运行、等待、审批、排队输入或任务。确认后会先安全停止这些活动，再归档会话。"
          preview={`受影响活动：${archiveBlockerCount(archiveBlocker)} 项`}
          confirmLabel={archiveBusy ? "正在停止并归档" : "停止并归档"}
          cancelDisabled={archiveBusy}
          confirmDisabled={archiveBusy}
          onCancel={() => setArchiveBlocker(null)}
          onConfirm={() => void archiveSession(true)}
        />
      ) : null}
    </>
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

function archiveBlockerCount(error: LifecycleRuntimeError): number {
  const count = error.details.blocker_count;
  return typeof count === "number" && Number.isFinite(count) ? count : 1;
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

function hasQuickSendUserMessage(messages: AgentChatMessage[], pending: QueuedQuickChatSend): boolean {
  return messages.some((message) => (
    message.role === "user"
    && (message.id === quickSendUserMessageId(pending) || message.content === pending.message)
  ));
}

function isPersistedQuickSendUserMessage(
  message: AgentChatMessage,
  pending: QueuedQuickChatSend,
): boolean {
  if (message.role !== "user" || message.content !== pending.message) {
    return false;
  }
  return message.id !== quickSendUserMessageId(pending);
}

function quickSendUserMessageId(pending: QueuedQuickChatSend): string {
  return `${pending.id}:user`;
}
