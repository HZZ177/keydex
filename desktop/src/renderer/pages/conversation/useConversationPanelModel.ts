import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceSearchResult } from "@/runtime";
import type { SelectedFile } from "@/renderer/components/chat/SendBox";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import {
  usePreview,
  type PreviewAnnotationChatRequest,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
  type PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import {
  fileReviewChangesFromMessage,
  normalizeFileReviewChange,
  type FileReviewChange,
} from "@/renderer/utils/fileReview";
import { shouldDisplayAgentTranscriptMessage } from "@/renderer/utils/agentTranscriptVisibility";
import type {
  AgentActionEnvelope,
  AgentErrorData,
  AgentMiddlewareProgressData,
  AgentSession,
  AgentSessionFork,
  ThreadTask,
} from "@/types/protocol";

import { agentMessageToConversationMessage } from "./conversationMessageAdapter";
import {
  conversationPatchFromToolDetails,
  toolDetailCacheKey,
  toolDetailRefFromMessage,
} from "./conversationToolDetails";
import type { FileChangePreview, MessageListScrollControls, ToolDetailsLoader } from "./messages";

export interface UseConversationPanelModelOptions {
  runtime: RuntimeBridge;
  sessionId: string;
  controller: AgentSessionController;
  registerPreviewHost?: boolean;
  previewPanelScopeKey?: string | null;
  emitForkSessionCreated?: boolean;
  validateSelectedSkill?: boolean;
  onBranchSessionCreated?: (sessionId: string) => void;
  onForkSessionCreated?: (session: AgentSession) => void;
  onNavigateToForkSource?: (fork: AgentSessionFork) => void;
}

export interface ContextWindowUsageStatus {
  sessionId: string;
  activeSessionId: string;
  tokenCount: number;
  contextWindow: number;
  windowFraction: number;
  thresholdFraction: number;
  thresholdTokenCount: number;
  thresholdUsageFraction: number;
  emergencyFraction: number | null;
  remainingToThresholdTokens: number;
  callPhase: string;
  callStatus: string;
  tokenSource: string;
  updatedAtMs: number;
}

export type ConversationPanelModel = ReturnType<typeof useConversationPanelModel>;

export function useConversationPanelModel({
  runtime,
  sessionId,
  controller,
  registerPreviewHost = false,
  previewPanelScopeKey = null,
  emitForkSessionCreated = true,
  validateSelectedSkill = true,
  onBranchSessionCreated,
  onForkSessionCreated,
  onNavigateToForkSource,
}: UseConversationPanelModelOptions) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [contextWindowUsage, setContextWindowUsage] = useState<ContextWindowUsageStatus | null>(null);
  const appliedContextWindowSnapshotKeyRef = useRef<string | null>(null);
  const contextWindowSessionIdRef = useRef<string | null>(null);
  const [forkCandidate, setForkCandidate] = useState<ConversationMessage | null>(null);
  const [reverseCandidate, setReverseCandidate] = useState<ConversationMessage | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const handledRuntimeSideEffectKeysRef = useRef(new Set<string>());
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null);
  const toolDetailCacheRef = useRef(
    new Map<string, Promise<Partial<ConversationMessage>> | Partial<ConversationMessage>>(),
  );
  const {
    openFilePanel,
    openPreview: openPreviewRequest,
    openReviewPanel,
    setPreviewHostContext,
  } = usePreview();
  const notifications = useNotifications();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const sharedSubscribeEvent = optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime.subscribeEvent : null;

  const session = controller.session;
  const messages = useMemo(
    () =>
      controller.agentMessages
        .filter((message) => message.role !== "approval" && shouldDisplayAgentTranscriptMessage(message))
        .map(agentMessageToConversationMessage),
    [controller.agentMessages],
  );
  const messageWorkspaceScope = useMemo(() => ({ sessionId }), [sessionId]);
  const workspaceUnavailable = Boolean(session && session.session_type === "workspace" && !session.workspace);
  const workspaceAvailable = Boolean(session?.session_type === "workspace" && session.workspace && !workspaceUnavailable);
  const workspaceLabel = session?.workspace?.root_path ?? session?.workspace?.name ?? session?.cwd ?? undefined;
  const workspaceId = workspaceAvailable ? (session?.workspace?.id ?? session?.workspace_id ?? undefined) : undefined;
  const workspaceSkillScope = useMemo(
    () => (workspaceAvailable ? { sessionId } : null),
    [sessionId, workspaceAvailable],
  );
  const { state: workspaceSkillsState, refresh: refreshWorkspaceSkills } = useWorkspaceSkills({
    runtime,
    scope: workspaceSkillScope,
    enabled: backendReady && workspaceAvailable,
  });
  const workspaceSkills = workspaceAvailable ? workspaceSkillsState.skills : [];

  useEffect(() => {
    if (contextWindowSessionIdRef.current !== sessionId) {
      contextWindowSessionIdRef.current = sessionId;
      appliedContextWindowSnapshotKeyRef.current = null;
      setContextWindowUsage(null);
    }
    if (!session || session.id !== sessionId) {
      appliedContextWindowSnapshotKeyRef.current = null;
      setContextWindowUsage(null);
      return;
    }
    const snapshotKey = contextWindowSnapshotKey(session.context_window_usage);
    if (!snapshotKey || appliedContextWindowSnapshotKeyRef.current === snapshotKey) {
      return;
    }
    const restoredUsage = contextWindowUsageFromSession(session, sessionId);
    if (!restoredUsage) {
      return;
    }
    appliedContextWindowSnapshotKeyRef.current = snapshotKey;
    setContextWindowUsage((current) => {
      if (
        current &&
        current.sessionId === restoredUsage.sessionId &&
        current.activeSessionId === restoredUsage.activeSessionId &&
        current.updatedAtMs > restoredUsage.updatedAtMs
      ) {
        return current;
      }
      return restoredUsage;
    });
  }, [session, sessionId]);

  const searchWorkspace = useMemo(
    () =>
      workspaceAvailable
        ? (query: string, options?: { signal?: AbortSignal }) =>
            runtime.workspace.search({ sessionId }, query, options)
        : undefined,
    [runtime, sessionId, workspaceAvailable],
  );
  const listWorkspaceDirectory = useMemo(
    () =>
      workspaceAvailable
        ? (path: string) =>
            runtime.workspace
              .listDirectory({ sessionId }, path)
              .then((response) => workspaceEntriesToSearchResults(response.entries))
        : undefined,
    [runtime, sessionId, workspaceAvailable],
  );

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
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollToBottomRef.current?.("smooth");
    });
  }, []);

  const handleRuntimeError = useCallback(
    (reason: unknown) => {
      const code = runtimeErrorCode(reason);
      if (!code) {
        return false;
      }
      if (code === "skill_not_found") {
        controller.setSelectedSkill(null);
        void refreshWorkspaceSkills({ forceReload: true });
        notifications.warning("Skill 不存在或已被删除，已刷新 Skill 列表");
        return true;
      }
      if (code === "skill_activation_invalid") {
        controller.setSelectedSkill(null);
        notifications.warning("Skill 选择参数无效，请重新选择 Skill");
        return true;
      }
      if (code === "skill_source_unsupported") {
        controller.setSelectedSkill(null);
        notifications.warning("系统级 Skill 暂未启用");
        return true;
      }
      if (code === "skill_session_unsupported") {
        controller.setSelectedSkill(null);
        notifications.warning("请切换到工作空间会话后再使用 Skill");
        return true;
      }
      return false;
    },
    [controller, notifications, refreshWorkspaceSkills],
  );

  const handleRuntimeEventSideEffects = useCallback(
    (event: AgentActionEnvelope) => {
      const sideEffectKey = runtimeSideEffectKey(event);
      if (sideEffectKey) {
        const handledKeys = handledRuntimeSideEffectKeysRef.current;
        if (handledKeys.has(sideEffectKey)) {
          return;
        }
        handledKeys.add(sideEffectKey);
        if (handledKeys.size > 512) {
          const oldestKey = handledKeys.values().next().value;
          if (oldestKey) {
            handledKeys.delete(oldestKey);
          }
        }
      }
      if (event.action === "workspaceSkillsChanged") {
        void refreshWorkspaceSkills({ forceReload: true });
      }
      if (event.action === "error") {
        handleRuntimeError(event.data as AgentErrorData);
      }
      if (event.action === "middleware_progress") {
        const data = event.data as AgentMiddlewareProgressData;
        const contextStatus = contextWindowUsageFromProgress(data, sessionId);
        if (contextStatus) {
          setContextWindowUsage(contextStatus);
        }
        const message = backgroundCompressionFailureMessage(data);
        if (message) {
          notifications.error(message);
        }
      }
    },
    [handleRuntimeError, notifications, refreshWorkspaceSkills, sessionId],
  );

  useEffect(() => {
    if (!sharedSubscribeEvent) {
      return;
    }
    return sharedSubscribeEvent(handleRuntimeEventSideEffects);
  }, [handleRuntimeEventSideEffects, sharedSubscribeEvent]);

  useEffect(() => {
    if (!validateSelectedSkill) {
      return;
    }
    if (!controller.selectedSkill) {
      return;
    }
    if (!workspaceAvailable) {
      controller.setSelectedSkill(null);
      return;
    }
    if (
      workspaceSkillsState.status === "ready" &&
      !workspaceSkills.some(
        (skill) => skill.name === controller.selectedSkill?.name && skill.source === controller.selectedSkill?.source,
      )
    ) {
      controller.setSelectedSkill(null);
    }
  }, [controller, validateSelectedSkill, workspaceAvailable, workspaceSkills, workspaceSkillsState.status]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const quoteSelection: (request: string | PreviewQuoteSelectionRequest) => void = controller.quoteSelection;
  const startChatFromAnnotation: (request: PreviewAnnotationChatRequest | PreviewAnnotationChatRequest[]) => void =
    controller.startChatFromAnnotation;

  const previewRenderContext = useMemo<PreviewRenderContext>(
    () => ({
      panelScopeKey: previewPanelScopeKey ?? undefined,
      sessionId,
      workspaceId,
      workspaceAvailable,
      workspaceLabel,
      runtime,
      onQuoteSelection: quoteSelection,
      onStartChatFromAnnotation: startChatFromAnnotation,
    }),
    [
      previewPanelScopeKey,
      quoteSelection,
      runtime,
      sessionId,
      startChatFromAnnotation,
      workspaceAvailable,
      workspaceId,
      workspaceLabel,
    ],
  );

  useEffect(() => {
    if (!registerPreviewHost) {
      return;
    }
    setPreviewHostContext(previewRenderContext);
    return () => {
      setPreviewHostContext(null);
    };
  }, [previewRenderContext, registerPreviewHost, setPreviewHostContext]);

  const openPreview = useCallback(
    (request: PreviewRequest) => {
      openPreviewRequest(request, previewRenderContext);
    },
    [openPreviewRequest, previewRenderContext],
  );

  const openFileReference = useCallback(
    (file: SelectedFile) => {
      if (!workspaceAvailable || !file.path) {
        return;
      }
      openFilePanel(file.path, previewRenderContext, selectedFileRevealTarget(file));
    },
    [openFilePanel, previewRenderContext, workspaceAvailable],
  );

  useEffect(() => {
    toolDetailCacheRef.current.clear();
  }, [runtime, sessionId]);

  useEffect(() => {
    setForkCandidate(null);
    setReverseCandidate(null);
  }, [sessionId]);

  const loadToolDetails = useCallback<ToolDetailsLoader>(
    async (message) => {
      const ref = toolDetailRefFromMessage(message);
      if (!ref) {
        return {};
      }
      const key = toolDetailCacheKey(sessionId, ref);
      const cached = toolDetailCacheRef.current.get(key);
      if (cached) {
        return cached instanceof Promise ? await cached : cached;
      }
      const promise = runtime.conversation
        .loadToolDetails(sessionId, ref)
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
    [runtime, sessionId],
  );

  const openFileChangePreview = useCallback(
    (file: FileChangePreview) => {
      if (!file.path) {
        return;
      }

      const openResolvedReview = (files: FileReviewChange[], title?: string | null) => {
        const focusedPath = file.path;
        openReviewPanel(
          {
            files,
            focusedPath,
            panelKey: file.message?.id ?? file.title ?? focusedPath,
            sourceMessageId: file.message?.id ?? null,
            title: title || file.title || "审阅",
            toolCallId: toolCallIdFromPreviewMessage(file.message),
          },
          previewRenderContext,
        );
      };

      const initialFiles = reviewFilesFromPreview(file);
      const targetFile = initialFiles.find((change) => change.path === file.path);
      const previewMessages = previewMessagesFromFileChangePreview(file);
      const shouldLoadDetails = previewMessages.some((message) => message.payload.toolDetailsDeferred === true);
      if (!shouldLoadDetails) {
        openResolvedReview(initialFiles, file.title);
        return;
      }

      void Promise.all(
        previewMessages.map(async (message) => {
          if (message.payload.toolDetailsDeferred !== true) {
            return message;
          }
          const patch = await loadToolDetails(message);
          return mergeConversationPatch(message, patch);
        }),
      )
        .then((hydratedMessages) => {
          const files = mergeFileReviewChanges(
            hydratedMessages
              .flatMap((message) => fileReviewChangesFromMessage(message, file.path))
              .filter((change) => !file.messages?.length || isTargetReviewChange(change, file.path)),
          );
          const targetHasDiff = files.some((change) => change.path === file.path && change.diff);
          openResolvedReview(files.length && (targetHasDiff || !targetFile?.diff) ? files : initialFiles, file.title);
        })
        .catch(() => {
          notifications.warning("文件变更详情加载失败");
          openResolvedReview(initialFiles, file.title);
        });
    },
    [loadToolDetails, notifications, openReviewPanel, previewRenderContext],
  );

  const branchFromMessage = useCallback(
    async (message: ConversationMessage, mode: "fork" | "reverse") => {
      const messageEventId = typeof message.payload.messageEventId === "string" ? message.payload.messageEventId : "";
      if (!messageEventId) {
        notifications.warning(mode === "fork" ? "该消息还不能派生对话" : "该消息还不能回溯");
        return;
      }

      try {
        const response =
          mode === "fork"
            ? await runtime.conversation.forkSession(sessionId, { messageEventId })
            : await runtime.conversation.reverseSession(sessionId, { messageEventId });
        notifications.success(mode === "fork" ? "已创建派生会话" : "已回溯到此处");
        if (mode === "fork") {
          controller.dispatch({ type: "session/upsert", session: response.session });
          if (emitForkSessionCreated) {
            emitSessionCreated(response.session);
          }
          onBranchSessionCreated?.(response.session.id);
          onForkSessionCreated?.(response.session);
        } else {
          controller.dispatch({ type: "session/upsert", session: response.session });
          await controller.reloadHistory();
          controller.setDraft(message.content);
        }
      } catch (reason) {
        notifications.error(branchActionErrorMessage(mode, reason));
      }
    },
    [controller, emitForkSessionCreated, notifications, onBranchSessionCreated, onForkSessionCreated, runtime, sessionId],
  );

  const forkFromMessage = useCallback(
    (message: ConversationMessage) => {
      setReverseCandidate(null);
      setForkCandidate(message);
    },
    [],
  );

  const reverseFromMessage = useCallback(
    (message: ConversationMessage) => {
      setForkCandidate(null);
      setReverseCandidate(message);
    },
    [],
  );

  const navigateToForkSource = useCallback(
    (fork: AgentSessionFork) => {
      onNavigateToForkSource?.(fork);
    },
    [onNavigateToForkSource],
  );

  const cancelForkFromMessage = useCallback(() => {
    setForkCandidate(null);
  }, []);

  const confirmForkFromMessage = useCallback(() => {
    const message = forkCandidate;
    if (!message) {
      return;
    }
    setForkCandidate(null);
    void branchFromMessage(message, "fork");
  }, [branchFromMessage, forkCandidate]);

  const cancelReverseFromMessage = useCallback(() => {
    setReverseCandidate(null);
  }, []);

  const confirmReverseFromMessage = useCallback(() => {
    const message = reverseCandidate;
    if (!message) {
      return;
    }
    setReverseCandidate(null);
    void branchFromMessage(message, "reverse");
  }, [branchFromMessage, reverseCandidate]);

  const upsertThreadTask = useCallback(
    (task: ThreadTask) => {
      controller.dispatch({
        type: "event/receive",
        event: {
          action: "task_updated",
          data: {
            session_id: sessionId,
            task_id: task.id,
            task,
          },
        },
      });
    },
    [controller, sessionId],
  );

  const updateThreadTask = useCallback(
    async (
      taskId: string,
      payload: Parameters<RuntimeBridge["conversation"]["updateThreadTask"]>[2],
    ) => {
      try {
        const task = await runtime.conversation.updateThreadTask(sessionId, taskId, payload);
        upsertThreadTask(task);
        return task;
      } catch (reason) {
        notifications.error(errorMessage(reason));
        throw reason;
      }
    },
    [notifications, runtime, sessionId, upsertThreadTask],
  );

  const deleteThreadTask = useCallback(
    async (taskId: string) => {
      try {
        const task = await runtime.conversation.deleteThreadTask(sessionId, taskId);
        controller.dispatch({
          type: "event/receive",
          event: {
            action: "task_deleted",
            data: {
              session_id: sessionId,
              task_id: task.id,
              task,
            },
          },
        });
        return task;
      } catch (reason) {
        notifications.error(errorMessage(reason));
        throw reason;
      }
    },
    [controller, notifications, runtime, sessionId],
  );

  return {
    sessionId,
    messages,
    session,
    sessionViewState: controller.sessionViewState,
    threadTasks: controller.threadTasks,
    activeTask: controller.activeTask,
    taskRunState: controller.taskRunState,
    pendingApproval: controller.pendingApproval,
    runtimeState: controller.runtimeState,
    runtimeDetail: controller.runtimeDetail,
    loading: controller.loading,
    loadingOlderHistory: controller.loadingOlderHistory,
    loadOlderHistory: controller.loadOlderHistory,
    terminateCommand: controller.terminateCommand,
    resolveMcpElicitation: controller.resolveMcpElicitation,
    messageWorkspaceScope,
    workspaceAvailable,
    workspaceUnavailable,
    workspaceLabel,
    workspaceSkills,
    refreshWorkspaceSkills,
    searchWorkspace,
    listWorkspaceDirectory,
    showScrollToBottom,
    updateScrollControls,
    scrollToBottom,
    scrollToBottomAfterSend,
    handleRuntimeError,
    handleRuntimeEventSideEffects,
    quoteSelection,
    startChatFromAnnotation,
    previewRenderContext,
    openPreview,
    openFileReference,
    openFileChangePreview,
    loadToolDetails,
    contextWindowUsage,
    forkFromMessage,
    forkConfirmation: forkCandidate,
    cancelForkFromMessage,
    confirmForkFromMessage,
    navigateToForkSource,
    reverseFromMessage,
    reverseConfirmation: reverseCandidate,
    cancelReverseFromMessage,
    confirmReverseFromMessage,
    updateThreadTask,
    deleteThreadTask,
  };
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

function backgroundCompressionFailureMessage(data: AgentMiddlewareProgressData): string {
  if (data.middleware !== "ContextCompressionMiddleware") {
    return "";
  }
  const stage = typeof data.stage === "string" ? data.stage : "";
  if (stage === "background_failed") {
    return "上下文压缩失败，当前对话将继续使用未压缩上下文。";
  }
  if (stage === "background_fork_failed") {
    return "上下文压缩未能切换到压缩分支，当前对话将继续使用原上下文。";
  }
  if (stage === "staging_failed") {
    return "上下文压缩结果应用失败，当前对话将继续使用原上下文。";
  }
  if (stage === "manual_light_failed") {
    return "上下文压缩失败，当前对话将继续使用原上下文。";
  }
  if (stage === "manual_deep_failed") {
    return "全量压缩失败，当前对话将继续使用原上下文。";
  }
  return "";
}

function contextWindowUsageFromProgress(
  data: AgentMiddlewareProgressData,
  currentSessionId: string,
): ContextWindowUsageStatus | null {
  return contextWindowUsageFromSnapshot(data, currentSessionId, Date.now(), {
    requireProgressMarker: true,
  });
}

function contextWindowUsageFromSession(
  session: AgentSession,
  currentSessionId: string,
): ContextWindowUsageStatus | null {
  return contextWindowUsageFromSnapshot(session.context_window_usage, currentSessionId, 0, {
    requireProgressMarker: false,
  });
}

function contextWindowUsageFromSnapshot(
  data: AgentMiddlewareProgressData | null | undefined,
  currentSessionId: string,
  fallbackUpdatedAtMs: number,
  options: { requireProgressMarker: boolean },
): ContextWindowUsageStatus | null {
  if (!data) {
    return null;
  }
  if (
    options.requireProgressMarker &&
    (data.middleware !== "ContextCompressionMiddleware" || data.stage !== "context_window_snapshot")
  ) {
    return null;
  }
  const payloadSessionId = stringValue(data.session_id);
  const payloadActiveSessionId = stringValue(data.active_session_id);
  if (
    currentSessionId &&
    (payloadSessionId || payloadActiveSessionId) &&
    payloadSessionId !== currentSessionId &&
    payloadActiveSessionId !== currentSessionId
  ) {
    return null;
  }
  const tokenCount = nonNegativeNumber(data.token_count);
  const contextWindow = positiveNumber(data.context_window);
  if (tokenCount === null || contextWindow === null) {
    return null;
  }
  const thresholdFraction =
    positiveNumber(data.threshold_fraction) ?? positiveNumber(data.trigger_fraction) ?? 0.75;
  const thresholdTokenCount =
    positiveNumber(data.threshold_token_count) ?? Math.max(1, Math.round(contextWindow * thresholdFraction));
  const thresholdUsageFraction =
    nonNegativeNumber(data.threshold_usage_fraction) ?? tokenCount / thresholdTokenCount;
  const resolvedSessionId = payloadSessionId || currentSessionId;
  const resolvedActiveSessionId = payloadActiveSessionId || resolvedSessionId;

  return {
    sessionId: resolvedSessionId,
    activeSessionId: resolvedActiveSessionId,
    tokenCount,
    contextWindow,
    windowFraction: nonNegativeNumber(data.window_fraction) ?? tokenCount / contextWindow,
    thresholdFraction,
    thresholdTokenCount,
    thresholdUsageFraction,
    emergencyFraction: positiveNumber(data.emergency_fraction),
    remainingToThresholdTokens:
      numberValue(data.remaining_to_threshold_tokens) ?? thresholdTokenCount - tokenCount,
    callPhase: stringValue(data.call_phase) || "after",
    callStatus: stringValue(data.call_status) || "completed",
    tokenSource: stringValue(data.token_source) || "estimated",
    updatedAtMs: nonNegativeNumber(data.timestamp_ms) ?? fallbackUpdatedAtMs,
  };
}

function contextWindowSnapshotKey(data: AgentMiddlewareProgressData | null | undefined): string {
  if (!data) {
    return "";
  }
  return [
    stringValue(data.session_id),
    stringValue(data.active_session_id),
    numberValue(data.timestamp_ms) ?? "",
    numberValue(data.token_count) ?? "",
    numberValue(data.context_window) ?? "",
    numberValue(data.threshold_token_count) ?? "",
    numberValue(data.threshold_usage_fraction) ?? "",
    stringValue(data.token_source),
  ].join(":");
}

function runtimeSideEffectKey(event: AgentActionEnvelope): string {
  const data = event.data;
  const explicitId = stringValue(data.event_id) || stringValue(data.id);
  if (explicitId) {
    return `${event.action}:${explicitId}`;
  }
  if (event.action === "middleware_progress") {
    return [
      event.action,
      stringValue(data.middleware),
      stringValue(data.stage),
      stringValue(data.session_id),
      stringValue(data.active_session_id),
      stringValue(data.notice_id),
      stringValue(data.trace_id),
      numberValue(data.timestamp_ms) ?? "",
      numberValue(data.token_count) ?? "",
      stringValue(data.reason),
    ].join(":");
  }
  if (event.action === "error") {
    return [
      event.action,
      stringValue(data.session_id),
      stringValue(data.code),
      stringValue(data.message),
      stringValue(data.trace_id),
    ].join(":");
  }
  return "";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  const record = objectRecord(reason);
  if (typeof record?.message === "string") {
    return record.message;
  }
  const detail = objectRecord(record?.detail);
  if (typeof detail?.message === "string") {
    return detail.message;
  }
  return "操作失败";
}

function branchActionErrorMessage(mode: "fork" | "reverse", reason: unknown): string {
  const message = errorMessage(reason);
  if (mode === "fork") {
    return message;
  }
  return message === "操作失败" ? "回溯失败" : `回溯失败：${message}`;
}

function reviewFilesFromPreview(file: FileChangePreview): FileReviewChange[] {
  const files = file.files?.length
    ? file.files.map((change) => normalizeFileReviewChange(change))
    : [];
  if (!files.length) {
    return [
      normalizeFileReviewChange({
        path: file.path,
        diff: file.diff,
        operation: "unknown",
      }),
    ];
  }
  if (!file.diff) {
    return files;
  }
  return files.map((change) =>
    change.path === file.path && !change.diff
      ? normalizeFileReviewChange({ ...change, diff: file.diff })
      : change,
  );
}

function previewMessagesFromFileChangePreview(file: FileChangePreview): ConversationMessage[] {
  return uniqueConversationMessages([...(file.messages ?? []), file.message].filter(isConversationMessage));
}

function uniqueConversationMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const keys = new Set<string>();
  const unique: ConversationMessage[] = [];
  messages.forEach((message) => {
    const key = conversationMessageKey(message);
    if (keys.has(key)) {
      return;
    }
    keys.add(key);
    unique.push(message);
  });
  return unique;
}

function conversationMessageKey(message: ConversationMessage): string {
  return message.id || message.itemId || `${message.kind}:${message.createdAt}`;
}

function isConversationMessage(value: ConversationMessage | undefined): value is ConversationMessage {
  return Boolean(value);
}

function isTargetReviewChange(change: FileReviewChange, path: string): boolean {
  return change.path === path || change.newPath === path || change.oldPath === path;
}

function mergeFileReviewChanges(changes: FileReviewChange[]): FileReviewChange[] {
  const merged = new Map<string, FileReviewChange>();
  changes.forEach((change) => {
    const normalized = normalizeFileReviewChange(change);
    const existing = merged.get(normalized.path);
    if (!existing) {
      merged.set(normalized.path, normalized);
      return;
    }
    merged.set(normalized.path, {
      ...existing,
      ...normalized,
      additions: existing.additions + normalized.additions,
      deletions: existing.deletions + normalized.deletions,
      diff: joinReviewDiffs(existing.diff, normalized.diff),
      content: normalized.content || existing.content,
      operation: mergedReviewOperation(existing.operation, normalized.operation),
      oldPath: normalized.oldPath ?? existing.oldPath ?? null,
      newPath: normalized.newPath ?? existing.newPath ?? null,
      source: normalized.source ?? existing.source ?? "unknown",
    });
  });
  return [...merged.values()];
}

function joinReviewDiffs(...diffs: string[]): string {
  return diffs.map((diff) => diff.trim()).filter(Boolean).join("\n");
}

function mergedReviewOperation(
  existing: FileReviewChange["operation"],
  next: FileReviewChange["operation"],
): FileReviewChange["operation"] {
  if (existing === "add" || next === "add") {
    return "add";
  }
  return next === "unknown" ? existing : next;
}

function mergeConversationPatch(
  message: ConversationMessage,
  patch: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    ...message,
    ...patch,
    payload: {
      ...message.payload,
      ...(patch.payload ?? {}),
    },
  };
}

function toolCallIdFromPreviewMessage(message: ConversationMessage | undefined): string | null {
  if (!message) {
    return null;
  }
  const call = objectRecord(message.payload.call);
  return stringValue(call?.id) || stringValue(message.payload.toolCallId) || null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null || number < 0) {
    return null;
  }
  return number;
}

function positiveNumber(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null || number <= 0) {
    return null;
  }
  return number;
}
