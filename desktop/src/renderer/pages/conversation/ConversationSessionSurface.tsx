import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { runtimeBridge, type RuntimeBridge, type WsConnectionStatus } from "@/runtime";
import type { SelectedFile, SelectedImageAttachment, SelectedQuote } from "@/renderer/components/chat/SendBox";
import type { SlashCommand } from "@/renderer/components/chat/SlashCommandMenu";
import { useRuntimeModelSelection, type RuntimeSelectedModel } from "@/renderer/components/model";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { AgentActionEnvelope, AgentSession, AgentSessionFork } from "@/types/protocol";
import type { FileAccessMode } from "@/types/protocol";

import { ChatLayout } from "./ChatLayout";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationPanel, ConversationPanelComposerAccessory } from "./ConversationPanel";
import { useConversationPanelModel } from "./useConversationPanelModel";
import { ComposerApprovalCard } from "./ComposerApprovalCard";
import { countLoadedConversationTurns } from "./conversationForkSource";
import { consumeQuickChatSend } from "./quickSend";
import styles from "./ConversationSessionSurface.module.css";

export type ConversationSessionSurfaceMode = "main" | "sidecar";

export interface ConversationSessionSurfaceProps {
  threadId: string;
  runtime?: RuntimeBridge;
  initialModel?: RuntimeSelectedModel | null;
  quickSendId?: string;
  mode?: ConversationSessionSurfaceMode;
  previewPanelScopeKey?: string | null;
  onOpenModelSettings?: () => void;
  onQuickSendConsumed?: () => void;
  onNavigateToConversation?: (threadId: string) => void;
}

interface SidecarHistorySnapshot {
  sessionId: string;
  messageIds: Set<string>;
}

export function ConversationSessionSurface({
  threadId,
  runtime = runtimeBridge,
  initialModel = null,
  quickSendId = "",
  mode = "main",
  previewPanelScopeKey = null,
  onOpenModelSettings,
  onQuickSendConsumed,
  onNavigateToConversation,
}: ConversationSessionSurfaceProps) {
  const isSidecar = mode === "sidecar";
  const [allowPersistentTrust, setAllowPersistentTrust] = useState(true);
  const [fileAccessMode, setFileAccessMode] = useState<FileAccessMode>("workspace_trusted");
  const quickSendConsumedRef = useRef<string | null>(null);
  const scrollToBottomAfterSendRef = useRef<(() => void) | null>(null);
  const runtimeEventSideEffectsRef = useRef<(event: AgentActionEnvelope) => void>(() => undefined);
  const runtimeErrorRef = useRef<(reason: unknown) => boolean | void>(() => false);
  const [sidecarHistorySnapshot, setSidecarHistorySnapshot] = useState<SidecarHistorySnapshot | null>(null);
  const notifications = useNotifications();
  const rightSidebarConversation = useOptionalRightSidebarConversation();
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
    historyPageSize: isSidecar ? 2 : 5,
    loadFullHistory: !isSidecar,
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
  const wsStatus = controller.wsStatus;
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
  const sidecarHiddenHistoryMessageIds =
    isSidecar && sidecarHistorySnapshot?.sessionId === threadId ? sidecarHistorySnapshot.messageIds : null;
  const sidecarMessages = useMemo(() => {
    if (!isSidecar) {
      return panelModel.messages;
    }
    if (!sidecarHiddenHistoryMessageIds) {
      return [];
    }
    return panelModel.messages.filter((message) => !sidecarHiddenHistoryMessageIds.has(message.id));
  }, [isSidecar, panelModel.messages, sidecarHiddenHistoryMessageIds]);
  const sidecarLoadedHistoryTurnCount = useMemo(() => {
    if (!isSidecar || !sidecarHiddenHistoryMessageIds) {
      return 0;
    }
    return countLoadedConversationTurns(
      panelModel.messages.filter((message) => sidecarHiddenHistoryMessageIds.has(message.id)),
    );
  }, [isSidecar, panelModel.messages, sidecarHiddenHistoryMessageIds]);
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
  const sidecarHistoryNotice = useMemo(
    () =>
      isSidecar
        ? {
            content: `该会话前置${sidecarLoadedHistoryTurnCount}轮历史消息已加载`,
            tone: "success" as const,
            testId: "btw-conversation-history-notice",
            title: `该会话前置${sidecarLoadedHistoryTurnCount}轮历史消息已加载`,
          }
        : null,
    [isSidecar, sidecarLoadedHistoryTurnCount],
  );
  const title = session?.title || (threadId ? `对话 ${threadId}` : "对话");
  const workspaceMeta = conversationWorkspaceMeta(session);
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
        return current;
      }
      return {
        sessionId: threadId,
        messageIds: new Set(panelModel.messages.map((message) => message.id)),
      };
    });
  }, [isSidecar, loading, panelModel.messages, threadId]);

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
  }, [runtime]);

  const send = useCallback(
    (files: SelectedFile[] = [], quotes: SelectedQuote[] = [], attachments: SelectedImageAttachment[] = []) =>
      controller.send(files, quotes, attachments, modelSelection.selectedModel),
    [controller, modelSelection.selectedModel],
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

  const handleSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.id === "bypass-conversation") {
        openBtwConversation();
      }
    },
    [openBtwConversation],
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
    void controller
      .sendText(pending.message, pending.model || modelSelection.selectedModel, {
        contextItems: pending.contextItems,
        runtimeParams: pending.runtimeParams,
        attachments: pending.attachments,
      })
      .then((sent) => {
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

  const composer = pendingApproval ? (
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
      modelSelection={{ ...modelSelection, setSelectedModel: changeModel }}
      workspaceSkills={panelModel.workspaceSkills}
      allowBypassConversationSlashCommand={!isSidecar}
      selectedSkill={selectedSkill}
      runtime={runtime}
      sessionId={threadId}
      fileAccessMode={fileAccessMode}
      workspaceRoots={sessionWorkspaceRoots(session)}
      onListWorkspaceDirectory={panelModel.listWorkspaceDirectory}
      onSearchWorkspace={panelModel.searchWorkspace}
      onOpenModelSettings={onOpenModelSettings}
      onChange={setDraft}
      onSkillChange={setSelectedSkill}
      onSend={send}
      onStop={controller.stop}
      onOpenFileReference={panelModel.openFileReference}
      onSlashCommand={handleSlashCommand}
      externalFileRequest={fileChipRequest}
      externalQuoteRequest={quoteChipRequest}
      contextWindowUsage={panelModel.contextWindowUsage}
      modelSelectorPlacement={isSidecar ? "bottom" : "top"}
    />
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
          <ConversationPanelComposerAccessory model={sidecarPanelModel} />
          {composer}
        </div>
      </section>
    );
  }

  return (
    <ChatLayout
      title={title}
      subtitle={conversationSubtitle(wsStatus, session)}
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
      composerAccessory={<ConversationPanelComposerAccessory model={panelModel} />}
      composer={composer}
    >
      <ConversationPanel
        model={panelModel}
        workspaceRuntime={runtime}
        scrollButtonMode="external"
        emptyText="还没有消息，输入需求开始对话。"
        emptyTestId="conversation-empty"
      />
    </ChatLayout>
  );
}

function conversationSubtitle(status: WsConnectionStatus, session: AgentSession | null): string {
  const base = connectionSubtitle(status);
  if (session?.fork_source) {
    return `派生会话 - ${base}`;
  }
  if (session?.active_session_id && session.active_session_id !== session.id) {
    return `已切换到分支 - ${base}`;
  }
  return base;
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

function connectionSubtitle(status: WsConnectionStatus): string {
  switch (status) {
    case "open":
      return "已连接";
    case "connecting":
    case "reconnecting":
      return "正在连接";
    case "error":
      return "连接异常";
    case "closed":
      return "已断开";
    case "idle":
      return "等待连接";
  }
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
