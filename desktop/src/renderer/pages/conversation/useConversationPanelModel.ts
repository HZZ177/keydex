import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceSearchResult } from "@/runtime";
import type { SelectedFile } from "@/renderer/components/chat/SendBox";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import {
  usePreview,
  type PreviewAnnotationChatRequest,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
  type PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentActionEnvelope, AgentErrorData, AgentMiddlewareProgressData } from "@/types/protocol";

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
  onBranchSessionCreated?: (sessionId: string) => void;
}

export interface ContextWindowUsageStatus {
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
  onBranchSessionCreated,
}: UseConversationPanelModelOptions) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [contextWindowUsage, setContextWindowUsage] = useState<ContextWindowUsageStatus | null>(null);
  const [reverseCandidate, setReverseCandidate] = useState<ConversationMessage | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null);
  const toolDetailCacheRef = useRef(
    new Map<string, Promise<Partial<ConversationMessage>> | Partial<ConversationMessage>>(),
  );
  const { openFilePanel, openPreview: openPreviewRequest, setPreviewHostContext } = usePreview();
  const notifications = useNotifications();

  const session = controller.session;
  const messages = useMemo(
    () => controller.agentMessages.filter((message) => message.role !== "approval").map(agentMessageToConversationMessage),
    [controller.agentMessages],
  );
  const messageWorkspaceScope = useMemo(() => ({ sessionId }), [sessionId]);
  const workspaceUnavailable = Boolean(session && session.session_type === "workspace" && !session.workspace);
  const workspaceAvailable = Boolean(session?.session_type === "workspace" && session.workspace && !workspaceUnavailable);
  const workspaceLabel = session?.workspace?.root_path ?? session?.workspace?.name ?? session?.cwd ?? undefined;
  const workspaceSkillScope = useMemo(
    () => (workspaceAvailable ? { sessionId } : null),
    [sessionId, workspaceAvailable],
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
          runtime.workspace.search({ sessionId }, query, options)
      : undefined;
  const listWorkspaceDirectory =
    session?.session_type === "workspace" && session.workspace && !workspaceUnavailable
      ? (path: string) =>
          runtime.workspace
            .listDirectory({ sessionId }, path)
            .then((response) => workspaceEntriesToSearchResults(response.entries))
      : undefined;

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
  }, [controller, workspaceAvailable, workspaceSkills, workspaceSkillsState.status]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const quoteSelection: (request: string | PreviewQuoteSelectionRequest) => void = controller.quoteSelection;
  const startChatFromAnnotation: (request: PreviewAnnotationChatRequest) => void = controller.startChatFromAnnotation;

  const previewRenderContext = useMemo<PreviewRenderContext>(
    () => ({
      sessionId,
      workspaceAvailable,
      workspaceLabel,
      runtime,
      onQuoteSelection: quoteSelection,
      onStartChatFromAnnotation: startChatFromAnnotation,
    }),
    [quoteSelection, runtime, sessionId, startChatFromAnnotation, workspaceAvailable, workspaceLabel],
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

  const openFileChangePreview = useCallback(
    (file: FileChangePreview) => {
      if (!workspaceAvailable || !file.path) {
        return;
      }
      openFilePanel(file.path, previewRenderContext);
    },
    [openFilePanel, previewRenderContext, workspaceAvailable],
  );

  useEffect(() => {
    toolDetailCacheRef.current.clear();
  }, [runtime, sessionId]);

  useEffect(() => {
    setContextWindowUsage(null);
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

  const branchFromMessage = useCallback(
    async (message: ConversationMessage, mode: "fork" | "reverse") => {
      const messageEventId = typeof message.payload.messageEventId === "string" ? message.payload.messageEventId : "";
      if (!messageEventId) {
        notifications.warning(mode === "fork" ? "该消息还不能从这里继续" : "该消息还不能回退");
        return;
      }

      try {
        const response =
          mode === "fork"
            ? await runtime.conversation.forkSession(sessionId, { messageEventId })
            : await runtime.conversation.reverseSession(sessionId, { messageEventId });
        notifications.success(mode === "fork" ? "已创建分支会话" : "回退成功");
        if (mode === "fork") {
          onBranchSessionCreated?.(response.session.id);
        } else {
          controller.dispatch({ type: "session/upsert", session: response.session });
          await controller.reloadHistory();
        }
      } catch (reason) {
        notifications.error(branchActionErrorMessage(mode, reason));
      }
    },
    [controller, notifications, onBranchSessionCreated, runtime, sessionId],
  );

  const forkFromMessage = useCallback(
    (message: ConversationMessage) => {
      void branchFromMessage(message, "fork");
    },
    [branchFromMessage],
  );

  const reverseFromMessage = useCallback(
    (message: ConversationMessage) => {
      setReverseCandidate(message);
    },
    [],
  );

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

  return {
    messages,
    session,
    sessionViewState: controller.sessionViewState,
    pendingApproval: controller.pendingApproval,
    runtimeState: controller.runtimeState,
    runtimeDetail: controller.runtimeDetail,
    loading: controller.loading,
    loadingOlderHistory: controller.loadingOlderHistory,
    loadOlderHistory: controller.loadOlderHistory,
    messageWorkspaceScope,
    workspaceAvailable,
    workspaceUnavailable,
    workspaceLabel,
    workspaceSkills,
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
    reverseFromMessage,
    reverseConfirmation: reverseCandidate,
    cancelReverseFromMessage,
    confirmReverseFromMessage,
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
    return "后台上下文压缩失败，当前对话将继续使用未压缩上下文。";
  }
  if (stage === "background_fork_failed") {
    return "后台上下文压缩未能切换到压缩分支，当前对话将继续使用原上下文。";
  }
  if (stage === "staging_failed") {
    return "上下文压缩结果应用失败，当前对话将继续使用原上下文。";
  }
  return "";
}

function contextWindowUsageFromProgress(
  data: AgentMiddlewareProgressData,
  currentSessionId: string,
): ContextWindowUsageStatus | null {
  if (data.middleware !== "ContextCompressionMiddleware" || data.stage !== "context_window_snapshot") {
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

  return {
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
    updatedAtMs: Date.now(),
  };
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
  return message === "操作失败" ? "回退失败" : `回退失败：${message}`;
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
