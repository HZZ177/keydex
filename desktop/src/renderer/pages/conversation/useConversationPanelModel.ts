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
import type { AgentActionEnvelope, AgentErrorData } from "@/types/protocol";

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
}

export type ConversationPanelModel = ReturnType<typeof useConversationPanelModel>;

export function useConversationPanelModel({
  runtime,
  sessionId,
  controller,
  registerPreviewHost = false,
}: UseConversationPanelModelOptions) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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
    },
    [handleRuntimeError, refreshWorkspaceSkills],
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
