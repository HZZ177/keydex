import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  RuntimeBridge,
  SkillSummary,
  WorkspaceEntry,
  WorkspaceScope,
  WorkspaceSearchResult,
} from "@/runtime";
import { openSkillResourcePreview, skillResourcePreviewError } from "@/renderer/utils/skillResourcePreview";
import type {
  SessionReverseDecision,
  SessionReverseMode,
  SessionReversePreview,
  SessionReverseResult,
} from "@/runtime/conversation";
import {
  selectedImageAttachmentFromAgent,
  selectedQuoteFromText,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import {
  skillSelectionStatus,
  useEffectiveSkills,
} from "@/renderer/hooks/useEffectiveSkills";
import type {
  AgentSessionController,
  AgentSessionControllerComposerDraft,
} from "@/renderer/hooks/useAgentSessionController";
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
  AgentPendingInput,
  AgentChatMessage,
  AgentContextItem,
  AgentFileAttachment,
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
  fallbackWorkspaceScope?: {
    workspaceId: string;
    workspaceRoot?: string | null;
  } | null;
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
  remainingToThresholdTokens: number;
  callPhase: string;
  callStatus: string;
  tokenSource: string;
  updatedAtMs: number;
}

export interface ReverseDialogState {
  sessionId: string;
  candidate: ConversationMessage;
  messageEventId: string;
  phase: "preview" | "decision" | "result";
  loading: boolean;
  executing: boolean;
  mode: SessionReverseMode;
  externalPathsConfirmed: boolean;
  preview: SessionReversePreview | null;
  result: SessionReverseResult | null;
  error: string | null;
  errorCode: string | null;
}

export type ConversationPanelModel = ReturnType<typeof useConversationPanelModel>;

export function useConversationPanelModel({
  runtime,
  sessionId,
  controller,
  fallbackWorkspaceScope = null,
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
  const [reverseState, setReverseState] = useState<ReverseDialogState | null>(null);
  const reverseRequestGenerationRef = useRef(0);
  const reverseExecuteInFlightRef = useRef(false);
  const reviewPreviewGenerationRef = useRef(0);
  const reviewPreviewSessionIdRef = useRef(sessionId);
  const scrollFrameRef = useRef<number | null>(null);
  const handledRuntimeSideEffectKeysRef = useRef(new Set<string>());
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null);
  const toolDetailCacheRef = useRef(
    new Map<string, Promise<Partial<ConversationMessage>> | Partial<ConversationMessage>>(),
  );
  const a2uiMessageCacheRef = useRef(new Map<string, A2UIConversationMessageCacheEntry>());
  const previewContext = usePreview();
  const {
    openDirectoryPanel,
    openFilePanel,
    openPreview: openPreviewRequest,
    openReviewPanel,
    setPreviewHostContext,
  } = previewContext;
  const notifications = useNotifications();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const sharedSubscribeEvent = optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime.subscribeEvent : null;

  if (reviewPreviewSessionIdRef.current !== sessionId) {
    reviewPreviewSessionIdRef.current = sessionId;
    reviewPreviewGenerationRef.current += 1;
  }

  const session = controller.session;
  const messages = useMemo(
    () => adaptConversationMessages(controller.agentMessages, a2uiMessageCacheRef.current),
    [controller.agentMessages],
  );
  const messageWorkspaceScope = useMemo<WorkspaceScope>(
    () => session
      ? { sessionId }
      : fallbackWorkspaceScope?.workspaceId
        ? { workspaceId: fallbackWorkspaceScope.workspaceId }
        : { sessionId },
    [fallbackWorkspaceScope?.workspaceId, session, sessionId],
  );
  const workspaceUnavailable = Boolean(session && session.session_type === "workspace" && !session.workspace);
  const workspaceAvailable = Boolean(session?.session_type === "workspace" && session.workspace && !workspaceUnavailable);
  const workspaceLabel = session?.workspace?.root_path ?? session?.workspace?.name ?? session?.cwd ?? undefined;
  const workspaceRootPath = session?.workspace?.root_path ?? session?.cwd ?? fallbackWorkspaceScope?.workspaceRoot ?? undefined;
  const workspaceId = workspaceAvailable ? (session?.workspace?.id ?? session?.workspace_id ?? undefined) : undefined;
  const effectiveSkillScope = useMemo(
    () => session
      ? { type: "session" as const, sessionId }
      : fallbackWorkspaceScope?.workspaceId
        ? {
            type: "workspace" as const,
            workspaceId: fallbackWorkspaceScope.workspaceId,
            workspaceRoot: fallbackWorkspaceScope.workspaceRoot,
          }
        : null,
    [fallbackWorkspaceScope?.workspaceId, fallbackWorkspaceScope?.workspaceRoot, session, sessionId],
  );
  const {
    state: effectiveSkillsState,
    isCurrentScope: isCurrentEffectiveSkillScope,
    refresh: refreshEffectiveSkills,
    handleSkillsChanged,
  } = useEffectiveSkills({
    runtime,
    scope: effectiveSkillScope,
    enabled: backendReady && effectiveSkillScope !== null,
  });
  const effectiveSkills = isCurrentEffectiveSkillScope ? effectiveSkillsState.skills : [];

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
        void refreshEffectiveSkills({ forceReload: true });
        notifications.warning("Skill 不存在或已被删除，已刷新 Skill 列表");
        return true;
      }
      if (code === "skill_activation_invalid") {
        controller.setSelectedSkill(null);
        notifications.warning("Skill 选择参数无效，请重新选择 Skill");
        return true;
      }
      if (code === "skill_source_stale") {
        controller.setSelectedSkill(null);
        void refreshEffectiveSkills({ forceReload: true });
        notifications.warning("Skill 的有效来源已变化，已刷新列表，请重新选择");
        return true;
      }
      if (code === "skill_layer_unavailable" || code === "skill_shadow_barrier") {
        controller.setSelectedSkill(null);
        void refreshEffectiveSkills({ forceReload: true });
        notifications.warning(
          session?.session_type === "chat"
            ? "系统级 Skill 配置不可用，请修复后重新选择"
            : "当前项目 Skill 配置不可用，请修复后重新选择",
        );
        return true;
      }
      return false;
    },
    [controller, notifications, refreshEffectiveSkills, session?.session_type],
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
      if (event.action === "keydexWorkspaceChanged") {
        handleSkillsChanged(event.data);
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
        const message = contextCompressionFailureMessage(data);
        if (message) {
          notifications.error(message);
        }
      }
    },
    [handleRuntimeError, handleSkillsChanged, notifications, sessionId],
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
    if (!effectiveSkillScope) {
      controller.setSelectedSkill(null);
      return;
    }
    if (!isCurrentEffectiveSkillScope || effectiveSkillsState.status !== "ready") {
      return;
    }
    const status = skillSelectionStatus(controller.selectedSkill, effectiveSkills);
    if (status === "valid") {
      return;
    }
    controller.setSelectedSkill(null);
    notifications.warning(
      status === "source_changed"
        ? "同名 Skill 的有效来源已变化，请重新选择"
        : "所选 Skill 已不可用，请重新选择",
    );
  }, [
    controller,
    effectiveSkillScope,
    effectiveSkills,
    effectiveSkillsState.status,
    isCurrentEffectiveSkillScope,
    notifications,
    validateSelectedSkill,
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const quoteSelection: (request: string | PreviewQuoteSelectionRequest, comment?: string) => void =
    controller.quoteSelection;
  const startChatFromAnnotation: (request: PreviewAnnotationChatRequest | PreviewAnnotationChatRequest[]) => void =
    controller.startChatFromAnnotation;

  const previewRenderContext = useMemo<PreviewRenderContext>(
    () => ({
      panelScopeKey: previewPanelScopeKey ?? undefined,
      sessionId,
      workspaceId,
      workspaceRootPath,
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
      workspaceRootPath,
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
      if (file.type === "directory") {
        openDirectoryPanel(file.path, previewRenderContext);
        return;
      }
      openFilePanel(file.path, previewRenderContext, selectedFileRevealTarget(file));
    },
    [openDirectoryPanel, openFilePanel, previewRenderContext, workspaceAvailable],
  );
  const openSkillResource = useCallback(
    async (skill: SkillSummary, resourcePath = "SKILL.md") => {
      try {
        await openSkillResourcePreview({
          preview: previewContext,
          renderContext: previewRenderContext,
          runtime,
          scope: messageWorkspaceScope,
          target: {
            skillName: skill.name,
            source: skill.source,
            resourcePath,
          },
        });
      } catch (reason) {
        notifications.error(skillResourcePreviewError(reason));
      }
    },
    [messageWorkspaceScope, notifications, previewContext, previewRenderContext, runtime],
  );

  useEffect(() => {
    toolDetailCacheRef.current.clear();
  }, [runtime, sessionId]);

  useEffect(() => {
    setForkCandidate(null);
    reverseRequestGenerationRef.current += 1;
    reverseExecuteInFlightRef.current = false;
    setReverseState(null);
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

      const requestGeneration = reviewPreviewGenerationRef.current + 1;
      reviewPreviewGenerationRef.current = requestGeneration;
      const requestSessionId = sessionId;
      const requestIsCurrent = () =>
        reviewPreviewGenerationRef.current === requestGeneration &&
        reviewPreviewSessionIdRef.current === requestSessionId;

      const openResolvedReview = (
        files: FileReviewChange[],
        title?: string | null,
        document = file.document ?? null,
      ) => {
        if (!requestIsCurrent()) {
          return;
        }
        const focusedPath = file.path;
        openReviewPanel(
          {
            files,
            document,
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
        openResolvedReview(initialFiles, file.title, file.document ?? null);
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
          const resolvedFiles = files.length && (targetHasDiff || !targetFile?.diff) ? files : initialFiles;
          openResolvedReview(
            resolvedFiles,
            file.title,
            resolvedFiles === initialFiles ? file.document ?? null : null,
          );
        })
        .catch(() => {
          if (!requestIsCurrent()) {
            return;
          }
          notifications.warning("文件变更详情加载失败");
          openResolvedReview(initialFiles, file.title, file.document ?? null);
        });
    },
    [loadToolDetails, notifications, openReviewPanel, previewRenderContext, sessionId],
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
          controller.restoreComposerDraft(composerDraftFromMessage(message));
        }
      } catch (reason) {
        notifications.error(branchActionErrorMessage(mode, reason));
      }
    },
    [controller, emitForkSessionCreated, notifications, onBranchSessionCreated, onForkSessionCreated, runtime, sessionId],
  );

  const loadReversePreview = useCallback(
    (message: ConversationMessage) => {
      const messageEventId =
        typeof message.payload.messageEventId === "string" ? message.payload.messageEventId : "";
      if (!messageEventId) {
        notifications.warning("该消息还不能回溯");
        return;
      }
      setForkCandidate(null);
      const generation = ++reverseRequestGenerationRef.current;
      reverseExecuteInFlightRef.current = false;
      setReverseState({
        sessionId,
        candidate: message,
        messageEventId,
        phase: "preview",
        loading: true,
        executing: false,
        mode: "both",
        externalPathsConfirmed: false,
        preview: null,
        result: null,
        error: null,
        errorCode: null,
      });
      void runtime.conversation
        .previewSessionReverse(sessionId, messageEventId)
        .then((preview) => {
          if (reverseRequestGenerationRef.current !== generation) {
            return;
          }
          setReverseState((current) =>
            current?.sessionId === sessionId && current.messageEventId === messageEventId
              ? { ...current, loading: false, mode: preview.default_mode, preview }
              : current,
          );
        })
        .catch((reason) => {
          if (reverseRequestGenerationRef.current !== generation) {
            return;
          }
          setReverseState((current) =>
            current?.sessionId === sessionId && current.messageEventId === messageEventId
              ? {
                  ...current,
                  loading: false,
                  error: errorMessage(reason),
                  errorCode: runtimeErrorCode(reason),
                }
              : current,
          );
        });
    },
    [notifications, runtime, sessionId],
  );

  const executeReverse = useCallback(
    (decision: SessionReverseDecision) => {
      const state = reverseState;
      const preview = state?.preview;
      if (
        !state ||
        !preview ||
        state.loading ||
        state.executing ||
        (state.mode !== "conversation" &&
          preview.requires_external_confirmation &&
          !state.externalPathsConfirmed) ||
        reverseExecuteInFlightRef.current
      ) {
        return;
      }
      const generation = reverseRequestGenerationRef.current;
      reverseExecuteInFlightRef.current = true;
      const requestId = `reverse-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setReverseState({ ...state, executing: true, error: null, errorCode: null });
      void runtime.conversation
        .executeSessionReverse(sessionId, {
          message_event_id: state.messageEventId,
          operation_id: preview.operation_id,
          preview_token: preview.preview_token,
          request_id: requestId,
          mode: state.mode,
          decision,
          confirm_external_paths:
            state.mode !== "conversation" && state.externalPathsConfirmed,
        })
        .then(async (result) => {
          if (reverseRequestGenerationRef.current !== generation || state.sessionId !== sessionId) {
            return;
          }
          reverseExecuteInFlightRef.current = false;
          setReverseState((current) =>
            current?.sessionId === sessionId
              ? {
                  ...current,
                  phase: "result",
                  executing: false,
                  result,
                  error: null,
                  errorCode: result.error_code ?? null,
                }
              : current,
          );
          if (result.conversation_rewound) {
            try {
              await controller.reloadHistory();
              if (reverseRequestGenerationRef.current !== generation) {
                return;
              }
              controller.restoreComposerDraft({
                ...composerDraftFromMessage(state.candidate),
                value: result.restored_input ?? state.candidate.content,
              });
              const refreshed = await runtime.conversation.getSession(sessionId);
              if (reverseRequestGenerationRef.current !== generation) {
                return;
              }
              controller.dispatch({ type: "session/upsert", session: refreshed });
            } catch {
              notifications.warning("回溯已完成，但本地对话刷新失败，请重新打开会话");
            }
          }
          if (result.status === "partial") {
            notifications.warning("已完成部分回溯，请查看跳过的文件");
          } else {
            notifications.success("已回溯到此处");
          }
        })
        .catch((reason) => {
          if (reverseRequestGenerationRef.current !== generation) {
            return;
          }
          reverseExecuteInFlightRef.current = false;
          const code = runtimeErrorCode(reason);
          void runtime.conversation
            .getSessionReverseStatus(sessionId, preview.operation_id)
            .then((status) => {
              const terminalResult = status.result;
              if (
                reverseRequestGenerationRef.current !== generation ||
                state.sessionId !== sessionId ||
                !terminalResult ||
                !["compensated", "compensation_failed", "blocked"].includes(status.status)
              ) {
                return;
              }
              setReverseState((current) =>
                current?.sessionId === sessionId && current.preview?.operation_id === preview.operation_id
                  ? {
                      ...current,
                      phase: "result",
                      executing: false,
                      result: terminalResult,
                      error: null,
                      errorCode: status.error_code ?? terminalResult.error_code ?? code,
                    }
                  : current,
              );
            })
            .catch(() => undefined);
          setReverseState((current) =>
            current?.sessionId === sessionId
              ? {
                  ...current,
                  executing: false,
                  error: errorMessage(reason),
                  errorCode: code,
                }
              : current,
          );
          notifications.error(reverseActionErrorMessage(code));
        });
    },
    [controller, notifications, reverseState, runtime, sessionId],
  );

  const forkFromMessage = useCallback(
    (message: ConversationMessage) => {
      reverseRequestGenerationRef.current += 1;
      setReverseState(null);
      setForkCandidate(message);
    },
    [],
  );

  const reverseFromMessage = useCallback(
    (message: ConversationMessage) => {
      loadReversePreview(message);
    },
    [loadReversePreview],
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
    reverseRequestGenerationRef.current += 1;
    reverseExecuteInFlightRef.current = false;
    setReverseState(null);
  }, []);

  const selectReverseMode = useCallback((mode: SessionReverseMode) => {
    setReverseState((current) =>
      current && current.phase !== "result" ? { ...current, mode, phase: "preview" } : current,
    );
  }, []);

  const confirmExternalReversePaths = useCallback((confirmed: boolean) => {
    setReverseState((current) =>
      current && current.phase !== "result"
        ? { ...current, externalPathsConfirmed: confirmed }
        : current,
    );
  }, []);

  const confirmReverseFromMessage = useCallback(() => {
    const state = reverseState;
    if (!state?.preview) {
      return;
    }
    const hasFileProblem =
      state.mode !== "conversation" &&
      state.preview.files.some((file) => file.classification !== "ready");
    if (hasFileProblem) {
      setReverseState({ ...state, phase: "decision" });
      return;
    }
    executeReverse("full");
  }, [executeReverse, reverseState]);

  const decideReverseFailure = useCallback(
    (decision: SessionReverseDecision) => {
      if (decision === "cancel") {
        cancelReverseFromMessage();
        return;
      }
      executeReverse(decision);
    },
    [cancelReverseFromMessage, executeReverse],
  );

  const retryReversePreview = useCallback(() => {
    if (reverseState) {
      loadReversePreview(reverseState.candidate);
    }
  }, [loadReversePreview, reverseState]);

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

  const editPendingInput = useCallback(
    async (pendingInput: AgentPendingInput) => {
      const pendingInputId = pendingInput.pending_input_id || pendingInput.id;
      try {
        await controller.cancelPendingInput(pendingInputId);
        controller.dispatch({
          type: "event/receive",
          event: {
            action: "pending_input_cancelled",
            data: {
              ...pendingInput,
              pending_input_id: pendingInputId,
              status: "cancelled",
            },
          },
        });
        controller.restoreComposerDraft(composerDraftFromPendingInput(pendingInput));
      } catch (reason) {
        notifications.error(errorMessage(reason));
      }
    },
    [controller, notifications],
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
    pendingInputs: controller.pendingInputs,
    updatePendingInputMode: controller.updatePendingInputMode,
    reorderPendingInputs: controller.reorderPendingInputs,
    cancelPendingInput: controller.cancelPendingInput,
    resumePendingInputs: controller.resumePendingInputs,
    editPendingInput,
    runtimeState: controller.runtimeState,
    runtimeDetail: controller.runtimeDetail,
    loading: controller.loading,
    loadingOlderHistory: controller.loadingOlderHistory,
    loadOlderHistory: controller.loadOlderHistory,
    terminateCommand: controller.terminateCommand,
    submitA2UI: controller.submitA2UI,
    cancelA2UI: controller.cancelA2UI,
    resolveMcpElicitation: controller.resolveMcpElicitation,
    messageWorkspaceScope,
    workspaceAvailable,
    workspaceUnavailable,
    workspaceLabel,
    effectiveSkills,
    effectiveSkillDiagnostics: isCurrentEffectiveSkillScope ? effectiveSkillsState.diagnostics : [],
    refreshEffectiveSkills,
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
    openSkillResource,
    openFileChangePreview,
    loadToolDetails,
    contextWindowUsage,
    forkFromMessage,
    forkConfirmation: forkCandidate,
    cancelForkFromMessage,
    confirmForkFromMessage,
    navigateToForkSource,
    reverseFromMessage,
    reverseConfirmation: reverseState,
    cancelReverseFromMessage,
    confirmReverseFromMessage,
    selectReverseMode,
    confirmExternalReversePaths,
    decideReverseFailure,
    retryReversePreview,
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
  const annotationId = file.annotationReference?.annotationId.trim() || null;
  if (!annotationId && !file.lineStart && !file.lineEnd && file.sourceStart == null && file.sourceEnd == null) {
    return null;
  }
  return {
    annotationId,
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

function contextCompressionFailureMessage(data: AgentMiddlewareProgressData): string {
  if (data.middleware !== "ContextCompressionMiddleware") {
    return "";
  }
  const stage = typeof data.stage === "string" ? data.stage : "";
  if (stage === "compression_failed") {
    return "上下文压缩失败，当前对话将继续使用原上下文。";
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
    positiveNumber(data.threshold_fraction) ?? positiveNumber(data.trigger_fraction) ?? 0.8;
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

function composerDraftFromMessage(message: ConversationMessage): AgentSessionControllerComposerDraft {
  const contextItems = contextItemsFromMessagePayload(message.payload);
  const contextDraft = composerDraftContextFromItems(contextItems);
  return {
    value: message.content,
    ...contextDraft,
    attachments: imageAttachmentsFromMessagePayload(message.payload),
  };
}

function composerDraftFromPendingInput(input: AgentPendingInput): AgentSessionControllerComposerDraft {
  const runtimeParams = input.runtime_params ?? {};
  const rawContextItems = runtimeParams.message_context_items ?? runtimeParams.messageContextItems;
  const contextItems = Array.isArray(rawContextItems)
    ? rawContextItems.filter((item): item is AgentContextItem => Boolean(item && typeof item === "object"))
    : [];
  return {
    value: input.message,
    ...composerDraftContextFromItems(contextItems),
    attachments: imageAttachmentsFromMessagePayload({ attachments: input.attachments ?? [] }),
  };
}

function contextItemsFromMessagePayload(payload: Record<string, unknown>): AgentContextItem[] {
  const raw = payload.contextItems;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is AgentContextItem => Boolean(item && typeof item === "object"));
}

function composerDraftContextFromItems(
  items: AgentContextItem[],
): Pick<AgentSessionControllerComposerDraft, "files" | "quotes" | "selectedSkill"> {
  const files: SelectedFile[] = [];
  const quotes: SelectedQuote[] = [];
  let selectedSkill: SkillSummary | null = null;

  items.forEach((item, index) => {
    const metadata = objectRecord(item.metadata);
    const type = contextItemType(item, metadata);
    if (type === "skill") {
      selectedSkill ??= selectedSkillFromContextItem(item, metadata);
      return;
    }
    if (type === "source_quote" || type === "quote") {
      const quote = selectedQuoteFromContextItem(item, metadata, type);
      if (quote) {
        quotes.push(quote);
      }
      return;
    }
    if (type === "file") {
      const file = selectedFileFromContextItem(item, metadata, index);
      if (file) {
        files.push(file);
      }
    }
  });

  return { files, quotes, selectedSkill };
}

function contextItemType(item: AgentContextItem, metadata: Record<string, unknown> | null): string {
  return trimmedString(item.type) || trimmedString(metadata?.kind);
}

function selectedSkillFromContextItem(
  item: AgentContextItem,
  metadata: Record<string, unknown> | null,
): SkillSummary | null {
  const name =
    trimmedString(item.skill_name) ||
    trimmedString(item.skillName) ||
    trimmedString(metadata?.skill_name) ||
    trimmedString(metadata?.skillName) ||
    trimmedString(item.label).replace(/^\//, "");
  if (!name) {
    return null;
  }
  const source = skillSource(trimmedString(item.source) || trimmedString(metadata?.source));
  const label = trimmedString(item.label) || `/${name}`;
  const locator = trimmedString(item.locator) || trimmedString(metadata?.locator) || `.keydex/skills/${name}/SKILL.md`;
  return {
    name,
    description: trimmedString(item.description) || trimmedString(metadata?.description) || trimmedString(item.content),
    source,
    label,
    locator,
  };
}

function selectedQuoteFromContextItem(
  item: AgentContextItem,
  metadata: Record<string, unknown> | null,
  type: string,
): SelectedQuote | null {
  const content = trimmedString(item.content);
  if (!content) {
    return null;
  }
  const source: SelectedQuote["source"] = "selection";
  const comment = trimmedString(metadata?.comment);
  const path = trimmedString(item.path) || trimmedString(metadata?.path);
  if (type === "source_quote" && path) {
    return selectedQuoteFromText(content, {
      source,
      comment,
      file: {
        path,
        name: trimmedString(item.name) || trimmedString(metadata?.name) || fileName(path),
        lineStart: optionalNumber(metadata?.line_start, metadata?.lineStart),
        lineEnd: optionalNumber(metadata?.line_end, metadata?.lineEnd),
        sourceStart: optionalNumber(metadata?.source_start, metadata?.sourceStart),
        sourceEnd: optionalNumber(metadata?.source_end, metadata?.sourceEnd),
      },
    });
  }
  return selectedQuoteFromText(content, {
    source,
    comment,
  });
}

function selectedFileFromContextItem(
  item: AgentContextItem,
  metadata: Record<string, unknown> | null,
  index: number,
): SelectedFile | null {
  const path = trimmedString(item.path) || trimmedString(metadata?.path);
  if (!path) {
    return null;
  }
  return {
    id: trimmedString(item.id) || `file:${index}:${path}`,
    path,
    name: trimmedString(item.name) || trimmedString(metadata?.name) || trimmedString(item.label) || fileName(path),
    type: selectedFileType(trimmedString(item.fileType) || trimmedString(metadata?.fileType)),
    source: selectedFileSource(trimmedString(metadata?.source)),
  };
}

function imageAttachmentsFromMessagePayload(payload: Record<string, unknown>): SelectedImageAttachment[] {
  const raw = payload.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const attachment = item as AgentFileAttachment;
    const type = trimmedString(attachment.type);
    const mimeType = trimmedString(attachment.mime_type) || trimmedString(attachment.mimeType);
    if (type !== "image" && !mimeType.startsWith("image/")) {
      return [];
    }
    const selected = selectedImageAttachmentFromAgent(attachment);
    return selected ? [selected] : [];
  });
}

function skillSource(value: string): SkillSummary["source"] {
  return value === "builtin" ? "builtin" : value === "system" ? "system" : "workspace";
}

function selectedFileType(value: string): SelectedFile["type"] {
  return value === "directory" ? "directory" : "file";
}

function selectedFileSource(value: string): SelectedFile["source"] {
  return value === "dropped" || value === "pasted" || value === "picker" ? value : "workspace";
}

function optionalNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
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

function reverseActionErrorMessage(code: string | null): string {
  if (code === "file_preview_stale") {
    return "文件状态已经变化，请重新检查后再回溯";
  }
  if (code === "file_restore_turn_running") {
    return "当前回复仍在进行中，请先停止或等待完成后再回溯";
  }
  if (code === "file_restore_session_busy" || code === "file_restore_locked") {
    return "正在处理其他文件修改，请稍后再试";
  }
  if (code === "file_restore_compensated") {
    return "本次回溯未完成，文件已恢复到操作前状态";
  }
  if (code === "file_restore_compensation_failed" || code === "file_restore_blocked") {
    return "部分文件没有恢复完成，需要你检查后再继续";
  }
  return "暂时无法完成回溯，请稍后重试";
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

interface A2UIConversationMessageCacheEntry {
  a2ui: AgentChatMessage["a2ui"];
  debug: AgentChatMessage["a2uiDebug"];
  index: number;
  message: ConversationMessage;
  revision: string;
}

function adaptConversationMessages(
  agentMessages: AgentChatMessage[],
  a2uiCache: Map<string, A2UIConversationMessageCacheEntry>,
): ConversationMessage[] {
  const activeA2UIIds = new Set<string>();
  const result = agentMessages
    .filter((message) => message.role !== "approval" && shouldDisplayAgentTranscriptMessage(message))
    .map((message, index) => {
      if (!isA2UIAgentMessage(message)) {
        return agentMessageToConversationMessage(message, index);
      }
      activeA2UIIds.add(message.id);
      const revision = a2uiAgentMessageRevision(message);
      const cached = a2uiCache.get(message.id);
      if (
        cached &&
        cached.a2ui === message.a2ui &&
        cached.debug === message.a2uiDebug &&
        cached.index === index &&
        cached.revision === revision
      ) {
        return cached.message;
      }
      const converted = agentMessageToConversationMessage(message, index);
      a2uiCache.set(message.id, {
        a2ui: message.a2ui,
        debug: message.a2uiDebug,
        index,
        message: converted,
        revision,
      });
      return converted;
    });
  for (const messageId of a2uiCache.keys()) {
    if (!activeA2UIIds.has(messageId)) {
      a2uiCache.delete(messageId);
    }
  }
  return result;
}

function isA2UIAgentMessage(message: AgentChatMessage): boolean {
  return message.role === "a2ui" || message.contentType === "a2ui" || message.content_type === "a2ui";
}

function a2uiAgentMessageRevision(message: AgentChatMessage): string {
  return [
    message.id,
    message.sessionId,
    message.role,
    message.status ?? "",
    message.streaming ? "streaming" : "settled",
    message.timestamp,
    message.contentType ?? "",
    message.content_type ?? "",
    message.hydratedFromHistory ? "history" : "live",
    message.turnIndex ?? "",
    message.runId ?? "",
  ].join("|");
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

function trimmedString(value: unknown): string {
  return stringValue(value).trim();
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
