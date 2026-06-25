import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  runtimeBridge,
  type ChatPayload,
  type ChatChannel,
  type RuntimeBridge,
  type WorkspaceEntry,
  type WorkspaceSearchResult,
  type WsConnectionStatus,
} from "@/runtime";
import { SendBox, selectedQuoteFromText, type SelectedFile, type SelectedQuote } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, type RuntimeModelSelection, useRuntimeModelSelection } from "@/renderer/components/model";
import {
  usePreview,
  type PreviewAnnotationChatRequest,
  type PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  selectAgentMessages,
  selectAgentRuntimeState,
  selectAgentSessionState,
  type AgentConversationAction,
  type AgentSessionRuntimeState,
} from "@/renderer/stores/agentSessionStore";
import type { ConversationMessage, ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";
import type { AgentActionEnvelope, AgentChatMessage, CommandApprovalDecisionPayload } from "@/types/protocol";

import { ChatLayout } from "./ChatLayout";
import { ConversationComposerAccessory } from "./ComposerAccessory";
import { MessageList, type FileChangePreview, type MessageListScrollControls } from "./messages";
import { ComposerApprovalCard } from "./ComposerApprovalCard";
import { consumeQuickChatSend } from "./quickSend";

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
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const sharedRuntimeContext = optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime : null;
  const [localState, localDispatch] = useReducer(agentConversationReducer, createInitialAgentConversationState());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [fileChipRequest, setFileChipRequest] = useState<{ requestId: number; file: SelectedFile } | null>(null);
  const [quoteChipRequest, setQuoteChipRequest] = useState<{ requestId: number; quote: SelectedQuote } | null>(null);
  const [requestState, setRequestState] = useState<AgentSessionRuntimeState | null>(null);
  const [localRuntimeDetail, setLocalRuntimeDetail] = useState<string | null>(null);
  const [localWsStatus, setLocalWsStatus] = useState<WsConnectionStatus>("idle");
  const [allowPersistentTrust, setAllowPersistentTrust] = useState(true);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const channelRef = useRef<ChatChannel | null>(null);
  const quickSendConsumedRef = useRef<string | null>(null);
  const sendScrollFrameRef = useRef<number | null>(null);
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null);
  const { openFilePanel, openPreview: openPreviewRequest, setPreviewHostContext } = usePreview();
  const notifications = useNotifications();
  const modelSelection = useRuntimeModelSelection(runtime, initialModel);
  const state = sharedRuntimeContext?.state ?? localState;
  const dispatch = sharedRuntimeContext?.dispatch ?? localDispatch;
  const wsStatus = sharedRuntimeContext?.wsStatus ?? localWsStatus;
  const runtimeDetail = sharedRuntimeContext?.runtimeDetail ?? localRuntimeDetail;
  const setRuntimeDetail = sharedRuntimeContext?.setRuntimeDetail ?? setLocalRuntimeDetail;
  const usingSharedRuntime = Boolean(sharedRuntimeContext);
  const sharedBindSession = sharedRuntimeContext?.bindSession;

  const session = state.sessionsById[threadId] ?? null;
  const sessionViewState = selectAgentSessionState(state, threadId);
  const pendingApproval = sessionViewState?.pendingApproval ?? null;
  const agentMessages = selectAgentMessages(state, threadId);
  const messages = useMemo(
    () => agentMessages.filter((message) => message.role !== "approval").map(agentMessageToConversationMessage),
    [agentMessages],
  );
  const runtimeState = toConversationRuntimeState(requestState ?? selectAgentRuntimeState(state, threadId));
  const title = session?.title || (threadId ? `对话 ${threadId}` : "对话");
  const messageWorkspaceScope = useMemo(() => ({ sessionId: threadId }), [threadId]);
  const workspaceUnavailable = Boolean(session && session.session_type === "workspace" && !session.workspace);
  const workspaceAvailable = Boolean(session?.session_type === "workspace" && session.workspace && !workspaceUnavailable);
  const workspaceLabel = session?.workspace?.root_path ?? session?.workspace?.name ?? session?.cwd ?? undefined;
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
  const connectionReady = wsStatus === "open";
  const canSend = draft.trim().length > 0 && !isBusy(runtimeState) && connectionReady;
  const canStop = runtimeState === "running" && connectionReady;
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);

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
    return () => {
      if (sendScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(sendScrollFrameRef.current);
      }
    };
  }, []);

  const quoteSelection = useCallback((request: string | PreviewQuoteSelectionRequest) => {
    const quote =
      typeof request === "string"
        ? selectedQuoteFromText(request, "selection")
        : selectedQuoteFromText(request.selectedText, {
            source: "selection",
            file: {
              path: request.path,
              name: fileName(request.path),
              lineStart: request.lineStart ?? null,
              lineEnd: request.lineEnd ?? null,
              sourceStart: request.sourceStart ?? null,
              sourceEnd: request.sourceEnd ?? null,
            },
          });
    if (!quote) {
      return;
    }
    setQuoteChipRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      quote,
    }));
  }, []);

  const startChatFromAnnotation = useCallback((request: PreviewAnnotationChatRequest) => {
    const path = request.path.trim();
    const comment = request.comment.trim();
    if (!path || !comment) {
      return;
    }
    const selectedText = request.selectedText?.trim() ?? "";
    const quote = selectedText
      ? selectedQuoteFromText(selectedText, {
          source: "annotation",
          file: {
            path,
            name: fileName(path),
            lineStart: request.lineStart ?? null,
            lineEnd: request.lineEnd ?? null,
            sourceStart: request.sourceStart ?? null,
            sourceEnd: request.sourceEnd ?? null,
          },
        })
      : null;
    if (quote) {
      setQuoteChipRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        quote,
      }));
    } else {
      setFileChipRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        file: {
          path,
          name: fileName(path),
          type: "file",
          source: "workspace",
        },
      }));
    }
    setDraft((current) => appendDraftText(current, comment));
  }, []);

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
      });
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
    if (!usingSharedRuntime || !sharedBindSession || !threadId) {
      return;
    }

    let active = true;
    setLoading(true);
    setLoadingOlderHistory(false);
    setRuntimeDetail(null);
    dispatch({ type: "session/select", sessionId: threadId });
    sharedBindSession(threadId);

    const loadHistory = async () => {
      try {
        const history = await runtime.conversation.loadHistory(threadId, {
          direction: "older",
          pageSize: 5,
        });
        if (!active) {
          return;
        }
        dispatch({ type: "history/loaded", sessionId: threadId, history });
      } catch (reason) {
        if (!active) {
          return;
        }
        const message = errorMessage(reason);
        const publicMessage = publicRuntimeDetail(message);
        setRuntimeDetail(publicMessage);
        notifications.error(publicMessage);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadHistory();
    return () => {
      active = false;
    };
  }, [dispatch, notifications, runtime, setRuntimeDetail, sharedBindSession, threadId, usingSharedRuntime]);

  useEffect(() => {
    if (usingSharedRuntime) {
      return;
    }
    if (!threadId) {
      return;
    }

    let active = true;
    setLoading(true);
    setLoadingOlderHistory(false);
    setRuntimeDetail(null);
    dispatch({ type: "session/select", sessionId: threadId });

    const channel = runtime.conversation.openChatChannel(
      (event) => {
        if (active) {
          dispatch({ type: "event/receive", event });
        }
      },
      {
        sessionId: threadId,
        onStatus: (status) => {
          if (active) {
            setLocalWsStatus(status);
          }
        },
        onError: (reason) => {
          if (!active) {
            return;
          }
          const message = errorMessage(reason);
          setRuntimeDetail(publicRuntimeDetail(message));
        },
      },
    );
    channelRef.current = channel;

    const loadHistory = async () => {
      try {
        const history = await runtime.conversation.loadHistory(threadId, {
          direction: "older",
          pageSize: 5,
        });
        if (!active) {
          return;
        }
        dispatch({ type: "history/loaded", sessionId: threadId, history });
      } catch (reason) {
        if (!active) {
          return;
        }
        const message = errorMessage(reason);
        const publicMessage = publicRuntimeDetail(message);
        setRuntimeDetail(publicMessage);
        notifications.error(publicMessage);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadHistory();
    return () => {
      active = false;
      channel.close();
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
    };
  }, [dispatch, notifications, runtime, setRuntimeDetail, threadId, usingSharedRuntime]);

  const loadOlderHistory = useCallback(async () => {
    const cursor = sessionViewState?.historyCursor;
    if (!threadId || !cursor || !sessionViewState?.historyHasMoreOlder || loadingOlderHistory) {
      return;
    }
    setLoadingOlderHistory(true);
    try {
      const history = await runtime.conversation.loadHistory(threadId, {
        cursor,
        direction: "older",
        pageSize: 5,
      });
      dispatch({ type: "history/olderLoaded", sessionId: threadId, history });
    } catch (reason) {
      const message = errorMessage(reason);
      const publicMessage = publicRuntimeDetail(message);
      setRuntimeDetail(publicMessage);
      notifications.error(publicMessage);
    } finally {
      setLoadingOlderHistory(false);
    }
  }, [
    loadingOlderHistory,
    notifications,
    runtime,
    sessionViewState?.historyCursor,
    sessionViewState?.historyHasMoreOlder,
    threadId,
  ]);

  const sendText = useCallback(
    (
      text: string,
      model: string,
      options: {
        clearDraft?: boolean;
        contextItems?: ChatPayload["contextItems"];
        runtimeParams?: ChatPayload["runtime_params"];
      } = {},
    ) => {
      const trimmedText = text.trim();
      const trimmedModel = model.trim();
      const contextItems = options.contextItems ?? [];
      if ((!trimmedText && !contextItems.length) || !threadId || isBusy(runtimeState)) {
        return false;
      }
      if (!trimmedModel) {
        const message = "请先选择模型";
        setRuntimeDetail(message);
        notifications.error(message);
        onOpenModelSettings?.();
        return false;
      }
      if (wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        notifications.warning(message);
        return false;
      }

      setRuntimeDetail(null);
      try {
        dispatch({
          type: "message/addUser",
          sessionId: threadId,
          content: trimmedText,
          contextItems,
        });
        dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "running" });
        const payload: ChatPayload = {
          session_id: threadId,
          message: trimmedText,
          model: trimmedModel,
          ...(options.runtimeParams ? { runtime_params: options.runtimeParams } : {}),
        };
        if (sharedRuntimeContext) {
          sharedRuntimeContext.chat(payload);
        } else {
          const channel = channelRef.current;
          if (!channel) {
            throw new Error("对话连接尚未就绪");
          }
          channel.chat(payload);
        }
        scrollToBottomAfterSend();
        if (options.clearDraft) {
          setDraft("");
        }
        return true;
      } catch (reason) {
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        appendLocalError(dispatch, threadId, message);
        return false;
      }
    },
    [
      dispatch,
      notifications,
      onOpenModelSettings,
      runtimeState,
      setRuntimeDetail,
      sharedRuntimeContext,
      scrollToBottomAfterSend,
      threadId,
      wsStatus,
    ],
  );

  const send = (files: SelectedFile[] = [], quotes: SelectedQuote[] = []) => {
    const prepared = prepareComposerMessage(draft, files, { quotes });
    if (!prepared.message && !prepared.contextItems.length) {
      return false;
    }
    const model = modelSelection.selectedModel.trim();
    const sent = sendText(prepared.message, model, {
      clearDraft: true,
      contextItems: prepared.contextItems,
      runtimeParams: prepared.runtimeParams,
    });
    return sent;
  };

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
    const sent = sendText(pending.message, pending.model || modelSelection.selectedModel, {
      contextItems: pending.contextItems,
      runtimeParams: pending.runtimeParams,
    });
    if (!sent) {
      setDraft((current) => (current.trim() ? current : pending.message));
    }
  }, [
    agentMessages.length,
    connectionReady,
    loading,
    modelSelection.selectedModel,
    onQuickSendConsumed,
    quickSendId,
    sendText,
    threadId,
  ]);

  const stop = () => {
    if (!threadId || !canStop) {
      return;
    }
    if (wsStatus !== "open") {
      const message = "对话连接尚未就绪";
      setRuntimeDetail(message);
      notifications.warning(message);
      return;
    }

    setRequestState("cancelling");
    setRuntimeDetail(null);
    try {
      dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "cancelling" });
      if (sharedRuntimeContext) {
        sharedRuntimeContext.cancel(threadId);
      } else {
        const channel = channelRef.current;
        if (!channel) {
          throw new Error("对话连接尚未就绪");
        }
        channel.cancel(threadId);
      }
    } catch (reason) {
      const message = errorMessage(reason);
      setRuntimeDetail(publicRuntimeDetail(message));
      appendLocalError(dispatch, threadId, message);
    } finally {
      setRequestState(null);
    }
  };

  const submitApproval = useCallback(
    async (decision: CommandApprovalDecisionPayload) => {
      if (!pendingApproval) {
        return;
      }
      setApprovalSubmitting(true);
      setApprovalError(null);
      try {
        const approval = await runtime.settings.resolveApproval(pendingApproval.id, decision);
        dispatch({
          type: "event/receive",
          event: {
            action: "approval_resolved",
            data: {
              id: approval.id,
              approval_id: approval.id,
              session_id: approval.session_id,
              approval,
            },
          },
        });
      } catch (reason) {
        const message = errorMessage(reason);
        setApprovalError(publicRuntimeDetail(message));
      } finally {
        setApprovalSubmitting(false);
      }
    },
    [dispatch, pendingApproval, runtime],
  );

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
            error={approvalError}
            submitting={approvalSubmitting}
            onSubmit={submitApproval}
          />
        ) : (
          <ConversationComposer
            value={draft}
            runtimeState={runtimeState}
            canSend={canSend}
            canStop={canStop}
            connectionReady={connectionReady}
            modelSelection={modelSelection}
            onListWorkspaceDirectory={listWorkspaceDirectory}
            onSearchWorkspace={searchWorkspace}
            onOpenModelSettings={onOpenModelSettings}
            onChange={setDraft}
            onSend={send}
            onStop={stop}
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
        onQuoteSelection={quoteSelection}
        hasMoreOlder={Boolean(sessionViewState?.historyHasMoreOlder)}
        loadingOlder={loadingOlderHistory}
        onLoadOlder={loadOlderHistory}
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
  onSearchWorkspace,
  onListWorkspaceDirectory,
  onOpenModelSettings,
  onChange,
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
  onSearchWorkspace?: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
  onListWorkspaceDirectory?: (path: string) => Promise<WorkspaceSearchResult[]>;
  onOpenModelSettings?: () => void;
  onChange: (value: string) => void;
  onSend: (files?: SelectedFile[], quotes?: SelectedQuote[]) => boolean;
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

function appendDraftText(current: string, addition: string): string {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) {
    return current;
  }
  return current.trim() ? `${current.trimEnd()}\n\n${trimmedAddition}` : trimmedAddition;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function appendLocalError(
  dispatch: (action: AgentConversationAction) => void,
  sessionId: string,
  content: string,
) {
  const event: AgentActionEnvelope<"error"> = {
    action: "error",
    data: {
      id: `local-error:${Date.now()}`,
      session_id: sessionId,
      code: "frontend_runtime_error",
      message: content,
      details: {},
    },
  };
  dispatch({ type: "event/receive", event });
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
    reasoningKind: message.reasoningKind,
    reasoning_kind: message.reasoningKind,
    ghostStats: message.ghostStats,
    traceId: message.traceId,
    traceQueryContext: message.traceQueryContext,
    cancelled: message.cancelled,
    contextItems: message.contextItems,
  };

  if (message.role === "tool") {
    return {
      ...base,
      call: {
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

function toConversationRuntimeState(state: AgentSessionRuntimeState): ConversationRuntimeState {
  if (state === "running") {
    return "running";
  }
  if (state === "waiting_approval") {
    return "waiting_approval";
  }
  if (state === "cancelling") {
    return "cancelling";
  }
  if (state === "failed") {
    return "failed";
  }
  return "idle";
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

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "对话操作失败";
}

function publicRuntimeDetail(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return "对话操作失败";
  }
  if (looksLikeStackTrace(lines)) {
    const businessLine = lines.find((line) => !isStackTraceLine(line));
    return businessLine && !isStackTraceLine(businessLine) ? businessLine : "运行失败，详细信息已折叠";
  }
  return lines[0];
}

function looksLikeStackTrace(lines: string[]): boolean {
  return lines.some(isStackTraceLine) || lines.length > 1;
}

function isStackTraceLine(line: string): boolean {
  return (
    line.startsWith("Traceback ") ||
    /^File ".+", line \d+/i.test(line) ||
    /^\s*at\s+\S+/i.test(line) ||
    /^[A-Za-z_][\w.]*Error:/.test(line)
  );
}

function isoFromTimestamp(timestamp: number, index: number): string {
  if (timestamp > 1_000_000_000_000) {
    return new Date(timestamp).toISOString();
  }
  return new Date(Date.now() + index).toISOString();
}
