import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  type ChatChannel,
  type ChatPayload,
  type RuntimeBridge,
  type WorkspaceSkillSummary,
  type WsConnectionStatus,
} from "@/runtime";
import {
  agentAttachmentFromSelected,
  selectedQuoteFromText,
  type SendBoxExternalFileRequest,
  type SendBoxExternalQuoteRequest,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import { subscribeAddWorkspaceFileToChat } from "@/renderer/events/workspaceFileContext";
import { buildA2UICancelPayload, buildA2UISubmitPayload } from "@/renderer/pages/conversation/messages/a2ui";
import type { RuntimeSelectedModel } from "@/renderer/components/model";
import { emitSessionEventsFromRuntimeEvent } from "@/renderer/events/sessionEvents";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  selectAgentActiveThreadTask,
  selectAgentMessages,
  selectAgentRuntimeState,
  selectAgentSessionState,
  selectAgentThreadTaskRuns,
  selectAgentThreadTasks,
  type AgentConversationAction,
  type AgentSessionRuntimeState,
} from "@/renderer/stores/agentSessionStore";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";
import type {
  AgentActionEnvelope,
  AgentContextItem,
  AgentErrorData,
  AgentSession,
  CommandApprovalRequest,
  CommandApprovalDecisionPayload,
  McpElicitationResolvePayload,
} from "@/types/protocol";

export type AgentSessionControllerNoticeLevel = "error" | "warning";

export interface AgentSessionControllerEnsureSessionRequest {
  title: string;
  message: string;
  contextItems: AgentContextItem[];
  model?: RuntimeSelectedModel | null;
}

export type AgentSessionControllerEnsureSessionResult = string | AgentSession | null;

export interface AgentSessionControllerQuoteSelectionRequest {
  selectedText: string;
  path: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface AgentSessionControllerAnnotationRequest {
  path: string;
  comment: string;
  annotationId?: string | null;
  selectedText?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface UseAgentSessionControllerOptions {
  runtime: RuntimeBridge;
  sessionId?: string;
  enabled?: boolean;
  historyPageSize?: number;
  loadFullHistory?: boolean;
  onRuntimeEvent?: (event: AgentActionEnvelope) => void;
  onRuntimeError?: (reason: unknown) => boolean | void;
  onNotice?: (message: string, level: AgentSessionControllerNoticeLevel) => void;
  onOpenModelSettings?: () => void;
  onAfterSend?: () => void;
  syncThreadTasks?: boolean;
  ensureSession?: (request: AgentSessionControllerEnsureSessionRequest) => Promise<AgentSessionControllerEnsureSessionResult>;
}

export interface AgentSessionController {
  state: ReturnType<typeof createInitialAgentConversationState>;
  dispatch: (action: AgentConversationAction) => void;
  session: AgentSession | null;
  sessionViewState: ReturnType<typeof selectAgentSessionState>;
  threadTasks: ReturnType<typeof selectAgentThreadTasks>;
  activeTask: ReturnType<typeof selectAgentActiveThreadTask>;
  taskRunState: ReturnType<typeof selectAgentThreadTaskRuns>;
  agentMessages: ReturnType<typeof selectAgentMessages>;
  runtimeState: ConversationRuntimeState;
  pendingApproval: CommandApprovalRequest | null;
  draft: string;
  setDraft: (value: string | ((current: string) => string)) => void;
  selectedSkill: WorkspaceSkillSummary | null;
  setSelectedSkill: (skill: WorkspaceSkillSummary | null) => void;
  fileChipRequest: SendBoxExternalFileRequest | null;
  quoteChipRequest: SendBoxExternalQuoteRequest | null;
  loading: boolean;
  loadingOlderHistory: boolean;
  wsStatus: WsConnectionStatus;
  runtimeDetail: string | null;
  setRuntimeDetail: (detail: string | null) => void;
  connectionReady: boolean;
  canSend: boolean;
  canStop: boolean;
  usingSharedRuntime: boolean;
  quoteSelection: (request: string | AgentSessionControllerQuoteSelectionRequest) => void;
  startChatFromAnnotation: (request: AgentSessionControllerAnnotationRequest | AgentSessionControllerAnnotationRequest[]) => void;
  reloadHistory: () => Promise<void>;
  loadOlderHistory: () => Promise<void>;
  sendText: (
    text: string,
    model: RuntimeSelectedModel | null,
    options?: {
      clearDraft?: boolean;
      contextItems?: ChatPayload["contextItems"];
      runtimeParams?: ChatPayload["runtime_params"];
      attachments?: ChatPayload["attachments"];
      skipOptimistic?: boolean;
      allowWhileBusy?: boolean;
      targetSessionId?: string | null;
    },
  ) => Promise<boolean>;
  send: (
    files?: SelectedFile[],
    quotes?: SelectedQuote[],
    attachments?: SelectedImageAttachment[],
    model?: RuntimeSelectedModel | null,
  ) => Promise<boolean>;
  stop: () => void;
  terminateCommand: (commandId: string) => Promise<void>;
  submitA2UI: (
    interactionId: string,
    submitResult: Record<string, unknown>,
    targetSessionId?: string | null,
  ) => Promise<void>;
  cancelA2UI: (
    interactionId: string,
    cancelReason?: string | null,
    targetSessionId?: string | null,
  ) => Promise<void>;
  resolveMcpElicitation: (payload: McpElicitationResolvePayload) => Promise<void>;
  submitApproval: (decision: CommandApprovalDecisionPayload) => Promise<void>;
  approvalSubmitting: boolean;
  approvalError: string | null;
}

export function useAgentSessionController({
  runtime,
  sessionId = "",
  enabled = true,
  historyPageSize = 5,
  loadFullHistory = true,
  onRuntimeEvent,
  onRuntimeError,
  onNotice,
  onOpenModelSettings,
  onAfterSend,
  syncThreadTasks = true,
  ensureSession,
}: UseAgentSessionControllerOptions): AgentSessionController {
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const sharedRuntimeContext = optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime : null;
  const [localState, localDispatch] = useReducer(agentConversationReducer, createInitialAgentConversationState());
  const [draft, setDraft] = useState("");
  const [fileChipRequest, setFileChipRequest] = useState<SendBoxExternalFileRequest | null>(null);
  const [quoteChipRequest, setQuoteChipRequest] = useState<SendBoxExternalQuoteRequest | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<WorkspaceSkillSummary | null>(null);
  const [requestState, setRequestState] = useState<AgentSessionRuntimeState | null>(null);
  const [localRuntimeDetail, setLocalRuntimeDetail] = useState<string | null>(null);
  const [localWsStatus, setLocalWsStatus] = useState<WsConnectionStatus>("idle");
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const channelRef = useRef<ChatChannel | null>(null);
  const syncPersistedHistoryRef = useRef<() => void>(() => undefined);
  const syncThreadTasksRef = useRef<() => void>(() => undefined);
  const state = sharedRuntimeContext?.state ?? localState;
  const dispatch = sharedRuntimeContext?.dispatch ?? localDispatch;
  const wsStatus = sharedRuntimeContext?.wsStatus ?? localWsStatus;
  const runtimeDetail = sharedRuntimeContext?.runtimeDetail ?? localRuntimeDetail;
  const setRuntimeDetail = sharedRuntimeContext?.setRuntimeDetail ?? setLocalRuntimeDetail;
  const usingSharedRuntime = Boolean(sharedRuntimeContext);
  const sharedBindSession = sharedRuntimeContext?.bindSession;
  const sharedSubscribeEvent = sharedRuntimeContext?.subscribeEvent;
  const session = sessionId ? state.sessionsById[sessionId] ?? null : null;
  const sessionViewState = sessionId ? selectAgentSessionState(state, sessionId) : null;
  const threadTasks = sessionId ? selectAgentThreadTasks(state, sessionId) : [];
  const activeTask = sessionId ? selectAgentActiveThreadTask(state, sessionId) : null;
  const taskRunState = sessionId ? selectAgentThreadTaskRuns(state, sessionId) : { runningTaskRun: null, recentTaskRun: null };
  const pendingApproval = sessionViewState?.pendingApproval ?? null;
  const agentMessages = sessionId ? selectAgentMessages(state, sessionId) : [];
  const runtimeState = toConversationRuntimeState(
    requestState ?? (sessionId ? selectAgentRuntimeState(state, sessionId) : "idle"),
  );
  const connectionReady = wsStatus === "open";
  const canSend = draft.trim().length > 0 && !isBusy(runtimeState) && connectionReady && Boolean(sessionId || ensureSession);
  const canStop = runtimeState === "running" && connectionReady && Boolean(sessionId);

  const syncThreadTasksForSession = useCallback(async () => {
    if (!enabled || !sessionId || !syncThreadTasks) {
      return;
    }
    if (typeof runtime.conversation.listThreadTasks !== "function") {
      dispatch({ type: "tasks/loaded", sessionId, tasks: [] });
      return;
    }
    try {
      const tasks = await runtime.conversation.listThreadTasks(sessionId);
      dispatch({ type: "tasks/loaded", sessionId, tasks });
    } catch {
      dispatch({ type: "tasks/loaded", sessionId, tasks: [] });
    }
  }, [dispatch, enabled, runtime, sessionId, syncThreadTasks]);

  useEffect(() => {
    syncThreadTasksRef.current = () => {
      void syncThreadTasksForSession();
    };
  }, [syncThreadTasksForSession]);

  const handleRuntimeEvent = useCallback(
    (event: AgentActionEnvelope) => {
      onRuntimeEvent?.(event);
      dispatch({ type: "event/receive", event });
      emitSessionEventsFromRuntimeEvent(event);
      if (syncThreadTasks && event.action === "bind_ok" && runtimeEventSessionId(event) === sessionId) {
        syncThreadTasksRef.current();
      }
      if (shouldSyncHistoryAfterRuntimeEvent(event, sessionId)) {
        syncPersistedHistoryRef.current();
      }
    },
    [dispatch, onRuntimeEvent, sessionId, syncThreadTasks],
  );

  useEffect(() => {
    if (!usingSharedRuntime || !sharedSubscribeEvent) {
      return;
    }
    return sharedSubscribeEvent((event) => {
      onRuntimeEvent?.(event);
      if (syncThreadTasks && event.action === "bind_ok" && runtimeEventSessionId(event) === sessionId) {
        syncThreadTasksRef.current();
      }
      if (shouldSyncHistoryAfterRuntimeEvent(event, sessionId)) {
        syncPersistedHistoryRef.current();
      }
    });
  }, [onRuntimeEvent, sessionId, sharedSubscribeEvent, syncThreadTasks, usingSharedRuntime]);

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setLoadingOlderHistory(false);
      dispatch({ type: "session/select", sessionId: null });
      return;
    }

    if (!enabled) {
      setLoading(true);
      setLoadingOlderHistory(false);
      setRuntimeDetail(null);
      dispatch({ type: "session/select", sessionId });
      return;
    }

    let active = true;
    setLoading(true);
    setLoadingOlderHistory(false);
    setRuntimeDetail(null);
    dispatch({ type: "session/select", sessionId });

    if (usingSharedRuntime && sharedBindSession) {
      sharedBindSession(sessionId);
    }

    let channel: ChatChannel | null = null;
    if (!usingSharedRuntime) {
      channel = runtime.conversation.openChatChannel(
        (event) => {
          if (active) {
            handleRuntimeEvent(event);
          }
        },
        {
          sessionId,
          onStatus: (status) => {
            if (active) {
              setLocalWsStatus(status);
            }
          },
          onError: (reason) => {
            if (!active) {
              return;
            }
            setRuntimeDetail(publicRuntimeDetail(errorMessage(reason)));
          },
        },
      );
      channelRef.current = channel;
    }

    const loadHistory = async () => {
      try {
        const history = await runtime.conversation.loadHistory(sessionId, {
          allTurns: loadFullHistory,
          direction: "older",
          pageSize: loadFullHistory ? undefined : historyPageSize,
        });
        if (active) {
          dispatch({ type: "history/loaded", sessionId, history });
          void syncThreadTasksForSession();
        }
      } catch (reason) {
        if (!active) {
          return;
        }
        const message = publicRuntimeDetail(errorMessage(reason));
        setRuntimeDetail(message);
        onNotice?.(message, "error");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadHistory();
    return () => {
      active = false;
      if (channel) {
        channel.close();
        if (channelRef.current === channel) {
          channelRef.current = null;
        }
      }
    };
  }, [
    dispatch,
    enabled,
    handleRuntimeEvent,
    historyPageSize,
    loadFullHistory,
    onNotice,
    runtime,
    sessionId,
    setRuntimeDetail,
    sharedBindSession,
    syncThreadTasksForSession,
    usingSharedRuntime,
  ]);

  const reloadHistory = useCallback(async () => {
    if (!enabled || !sessionId) {
      return;
    }
    setLoading(true);
    try {
      const history = await runtime.conversation.loadHistory(sessionId, {
        allTurns: loadFullHistory,
        direction: "older",
        pageSize: loadFullHistory ? undefined : historyPageSize,
      });
      dispatch({ type: "history/loaded", sessionId, history });
      void syncThreadTasksForSession();
    } catch (reason) {
      const message = publicRuntimeDetail(errorMessage(reason));
      setRuntimeDetail(message);
      onNotice?.(message, "error");
    } finally {
      setLoading(false);
    }
  }, [
    dispatch,
    enabled,
    historyPageSize,
    loadFullHistory,
    onNotice,
    runtime,
    sessionId,
    setRuntimeDetail,
    syncThreadTasksForSession,
  ]);

  const syncPersistedHistory = useCallback(async () => {
    if (!enabled || !sessionId) {
      return;
    }
    try {
      const history = await runtime.conversation.loadHistory(sessionId, {
        allTurns: loadFullHistory,
        direction: "older",
        pageSize: loadFullHistory ? undefined : historyPageSize,
      });
      if (history.list.length === 0) {
        return;
      }
      dispatch({ type: "history/loaded", sessionId, history });
    } catch (reason) {
      const message = publicRuntimeDetail(errorMessage(reason));
      setRuntimeDetail(message);
      onNotice?.(message, "error");
    }
  }, [
    dispatch,
    enabled,
    historyPageSize,
    loadFullHistory,
    onNotice,
    runtime,
    sessionId,
    setRuntimeDetail,
  ]);

  useEffect(() => {
    syncPersistedHistoryRef.current = () => {
      void syncPersistedHistory();
    };
  }, [syncPersistedHistory]);

  const loadOlderHistory = useCallback(async () => {
    const cursor = sessionViewState?.historyCursor;
    if (!enabled || !sessionId || !cursor || !sessionViewState?.historyHasMoreOlder || loadingOlderHistory) {
      return;
    }
    setLoadingOlderHistory(true);
    try {
      const history = await runtime.conversation.loadHistory(sessionId, {
        cursor,
        direction: "older",
        pageSize: historyPageSize,
      });
      dispatch({ type: "history/olderLoaded", sessionId, history });
    } catch (reason) {
      const message = publicRuntimeDetail(errorMessage(reason));
      setRuntimeDetail(message);
      onNotice?.(message, "error");
    } finally {
      setLoadingOlderHistory(false);
    }
  }, [
    dispatch,
    enabled,
    historyPageSize,
    loadingOlderHistory,
    onNotice,
    runtime,
    sessionId,
    sessionViewState?.historyCursor,
    sessionViewState?.historyHasMoreOlder,
    setRuntimeDetail,
  ]);

  const quoteSelection = useCallback((request: string | AgentSessionControllerQuoteSelectionRequest) => {
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

  const startChatFromAnnotation = useCallback((
    requestOrRequests: AgentSessionControllerAnnotationRequest | AgentSessionControllerAnnotationRequest[],
  ) => {
    const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests];
    const files: SelectedFile[] = [];
    const quotes: SelectedQuote[] = [];

    requests.forEach((request) => {
      const path = request.path.trim();
      const comment = request.comment.trim();
      if (!path || !comment) {
        return;
      }
      const annotationId = request.annotationId?.trim() ?? "";
      const selectedText = request.selectedText?.trim() ?? "";
      const quote = selectedText
        ? selectedQuoteFromText(selectedText, {
            source: "annotation",
            annotationId,
            annotationComment: comment,
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
        quotes.push(quote);
        return;
      }
      files.push({
        id: annotationId ? `annotation:${annotationId}` : null,
        path,
        name: fileName(path),
        type: "file",
        source: "workspace",
        annotationId: annotationId || null,
        annotationComment: comment,
      });
    });

    if (quotes.length) {
      setQuoteChipRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        quotes,
      }));
    }
    if (files.length) {
      setFileChipRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        files,
      }));
    }
  }, []);

  useEffect(() => {
    return subscribeAddWorkspaceFileToChat((detail) => {
      if (detail.file.type !== "file") {
        return;
      }
      if (detail.sessionId && sessionId && detail.sessionId !== sessionId) {
        return;
      }
      if (detail.workspaceId && session?.workspace_id && detail.workspaceId !== session.workspace_id) {
        return;
      }
      setFileChipRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        file: detail.file,
      }));
    });
  }, [session?.workspace_id, sessionId]);

  const resolveSessionId = useCallback(
    async (message: string, contextItems: AgentContextItem[], model: RuntimeSelectedModel | null) => {
      if (sessionId) {
        return sessionId;
      }
      if (!ensureSession) {
        return null;
      }
      const ensured = await ensureSession({
        title: sessionTitleFromPreparedMessage(message, contextItems),
        message,
        contextItems,
        model,
      });
      if (!ensured) {
        return null;
      }
      if (typeof ensured === "string") {
        return ensured;
      }
      dispatch({ type: "session/upsert", session: ensured });
      return ensured.id;
    },
    [dispatch, ensureSession, sessionId],
  );

  const sendText = useCallback(
    async (
      text: string,
      model: RuntimeSelectedModel | null,
      options: {
        clearDraft?: boolean;
        contextItems?: ChatPayload["contextItems"];
        runtimeParams?: ChatPayload["runtime_params"];
        attachments?: ChatPayload["attachments"];
        skipOptimistic?: boolean;
        allowWhileBusy?: boolean;
        targetSessionId?: string | null;
      } = {},
    ) => {
      const trimmedText = text.trim();
      const providerId = model?.providerId.trim() ?? "";
      const trimmedModel = model?.model.trim() ?? "";
      const contextItems = options.contextItems ?? [];
      const attachments = options.attachments ?? [];
      if ((!trimmedText && !contextItems.length && !attachments.length) || (!options.allowWhileBusy && isBusy(runtimeState))) {
        return false;
      }
      if (!providerId || !trimmedModel) {
        const message = "请先选择模型";
        setRuntimeDetail(message);
        onNotice?.(message, "error");
        onOpenModelSettings?.();
        return false;
      }
      if (wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        onNotice?.(message, "warning");
        return false;
      }

      let targetSessionId: string | null = options.targetSessionId?.trim() || sessionId || null;
      if (!targetSessionId) {
        try {
          targetSessionId = await resolveSessionId(trimmedText, contextItems, model);
        } catch (reason) {
          const message = publicRuntimeDetail(errorMessage(reason));
          setRuntimeDetail(message);
          onNotice?.(message, "error");
          return false;
        }
      }
      if (!targetSessionId) {
        return false;
      }

      setRuntimeDetail(null);
      try {
        if (!options.skipOptimistic) {
          dispatch({
            type: "message/addUser",
            sessionId: targetSessionId,
            content: trimmedText,
            contextItems,
            attachments,
          });
        }
        dispatch({ type: "runtime/setState", sessionId: targetSessionId, runtimeState: "running" });
        const payload: ChatPayload = {
          session_id: targetSessionId,
          message: trimmedText,
          provider_id: providerId,
          model: trimmedModel,
          ...(attachments.length ? { attachments } : {}),
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
        onAfterSend?.();
        if (options.clearDraft) {
          setDraft("");
        }
        return true;
      } catch (reason) {
        onRuntimeError?.(reason);
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        appendLocalError(dispatch, targetSessionId, message);
        return false;
      }
    },
    [
      dispatch,
      onAfterSend,
      onNotice,
      onOpenModelSettings,
      onRuntimeError,
      resolveSessionId,
      runtimeState,
      sessionId,
      setRuntimeDetail,
      sharedRuntimeContext,
      wsStatus,
    ],
  );

  const send = useCallback(
    async (
      files: SelectedFile[] = [],
      quotes: SelectedQuote[] = [],
      imageAttachments: SelectedImageAttachment[] = [],
      model: RuntimeSelectedModel | null = null,
    ) => {
      const prepared = prepareComposerMessage(draft, files, { quotes, selectedSkill });
      const attachments = imageAttachments.map(agentAttachmentFromSelected);
      if (!prepared.message && !prepared.contextItems.length && !attachments.length) {
        return false;
      }
      const sent = await sendText(prepared.message, model, {
        clearDraft: true,
        contextItems: prepared.contextItems,
        runtimeParams: prepared.runtimeParams,
        attachments,
      });
      if (sent) {
        setSelectedSkill(null);
      }
      return sent;
    },
    [draft, selectedSkill, sendText],
  );

  const stop = useCallback(() => {
    if (!sessionId || !canStop) {
      return;
    }
    if (wsStatus !== "open") {
      const message = "对话连接尚未就绪";
      setRuntimeDetail(message);
      onNotice?.(message, "warning");
      return;
    }

    setRequestState("cancelling");
    setRuntimeDetail(null);
    try {
      dispatch({ type: "runtime/setState", sessionId, runtimeState: "cancelling" });
      if (sharedRuntimeContext) {
        sharedRuntimeContext.cancel(sessionId);
      } else {
        const channel = channelRef.current;
        if (!channel) {
          throw new Error("对话连接尚未就绪");
        }
        channel.cancel(sessionId);
      }
    } catch (reason) {
      const message = errorMessage(reason);
      setRuntimeDetail(publicRuntimeDetail(message));
      appendLocalError(dispatch, sessionId, message);
    } finally {
      setRequestState(null);
    }
  }, [canStop, dispatch, onNotice, sessionId, setRuntimeDetail, sharedRuntimeContext, wsStatus]);

  const terminateCommand = useCallback(
    async (commandId: string) => {
      if (!sessionId || !commandId.trim()) {
        return;
      }
      if (wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        onNotice?.(message, "warning");
        return;
      }

      setRuntimeDetail(null);
      try {
        if (sharedRuntimeContext) {
          sharedRuntimeContext.terminateCommand(sessionId, commandId);
        } else {
          const channel = channelRef.current;
          if (!channel) {
            throw new Error("对话连接尚未就绪");
          }
          channel.terminateCommand(sessionId, commandId);
        }
      } catch (reason) {
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        appendLocalError(dispatch, sessionId, message);
      }
    },
    [dispatch, onNotice, sessionId, setRuntimeDetail, sharedRuntimeContext, wsStatus],
  );

  const submitA2UI = useCallback(
    async (
      interactionId: string,
      submitResult: Record<string, unknown>,
      targetSessionId?: string | null,
    ) => {
      const sid = targetSessionId?.trim() || sessionId;
      if (!sid || !interactionId.trim()) {
        return;
      }
      if (wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        onNotice?.(message, "warning");
        return;
      }

      setRuntimeDetail(null);
      try {
        const payload = buildA2UISubmitPayload(sid, interactionId, submitResult);
        if (sharedRuntimeContext) {
          sharedRuntimeContext.submitA2UI(payload);
        } else {
          const channel = channelRef.current;
          if (!channel) {
            throw new Error("对话连接尚未就绪");
          }
          channel.submitA2UI(payload);
        }
      } catch (reason) {
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        appendLocalError(dispatch, sid, message);
      }
    },
    [dispatch, onNotice, sessionId, setRuntimeDetail, sharedRuntimeContext, wsStatus],
  );

  const cancelA2UI = useCallback(
    async (
      interactionId: string,
      cancelReason?: string | null,
      targetSessionId?: string | null,
    ) => {
      const sid = targetSessionId?.trim() || sessionId;
      if (!sid || !interactionId.trim()) {
        return;
      }
      if (wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        onNotice?.(message, "warning");
        return;
      }

      setRuntimeDetail(null);
      try {
        const payload = buildA2UICancelPayload(sid, interactionId, cancelReason);
        if (sharedRuntimeContext) {
          sharedRuntimeContext.cancelA2UI(payload);
        } else {
          const channel = channelRef.current;
          if (!channel) {
            throw new Error("对话连接尚未就绪");
          }
          channel.cancelA2UI(payload);
        }
      } catch (reason) {
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        appendLocalError(dispatch, sid, message);
      }
    },
    [dispatch, onNotice, sessionId, setRuntimeDetail, sharedRuntimeContext, wsStatus],
  );

  const resolveMcpElicitation = useCallback(
    async (payload: McpElicitationResolvePayload) => {
      if (!payload.elicitation_id.trim()) {
        return;
      }
      if (wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        onNotice?.(message, "warning");
        return;
      }

      setRuntimeDetail(null);
      try {
        if (sharedRuntimeContext) {
          sharedRuntimeContext.resolveMcpElicitation(payload);
        } else {
          const channel = channelRef.current;
          if (!channel) {
            throw new Error("对话连接尚未就绪");
          }
          if (!channel.resolveMcpElicitation) {
            throw new Error("MCP elicitation 通道未启用");
          }
          channel.resolveMcpElicitation(payload);
        }
      } catch (reason) {
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        if (sessionId) {
          appendLocalError(dispatch, sessionId, message);
        }
      }
    },
    [dispatch, onNotice, sessionId, setRuntimeDetail, sharedRuntimeContext, wsStatus],
  );

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
        setApprovalError(publicRuntimeDetail(errorMessage(reason)));
      } finally {
        setApprovalSubmitting(false);
      }
    },
    [dispatch, pendingApproval, runtime],
  );

  return useMemo(
    () => ({
      state,
    dispatch,
    session,
    sessionViewState,
    threadTasks,
    activeTask,
    taskRunState,
    agentMessages,
      runtimeState,
      pendingApproval,
      draft,
      setDraft,
      selectedSkill,
      setSelectedSkill,
      fileChipRequest,
      quoteChipRequest,
      loading,
      loadingOlderHistory,
      wsStatus,
      runtimeDetail,
      setRuntimeDetail,
      connectionReady,
      canSend,
      canStop,
      usingSharedRuntime,
      quoteSelection,
      startChatFromAnnotation,
      reloadHistory,
      loadOlderHistory,
      sendText,
      send,
      stop,
      terminateCommand,
      submitA2UI,
      cancelA2UI,
      resolveMcpElicitation,
      submitApproval,
      approvalSubmitting,
      approvalError,
    }),
    [
      agentMessages,
      approvalError,
      approvalSubmitting,
      canSend,
      canStop,
      cancelA2UI,
      connectionReady,
      dispatch,
      draft,
      fileChipRequest,
      loadOlderHistory,
      loading,
      loadingOlderHistory,
      pendingApproval,
      quoteChipRequest,
      quoteSelection,
      reloadHistory,
      runtimeDetail,
      runtimeState,
      resolveMcpElicitation,
      selectedSkill,
      send,
      sendText,
      session,
      sessionViewState,
      setRuntimeDetail,
      startChatFromAnnotation,
      state,
      stop,
      submitA2UI,
      submitApproval,
      terminateCommand,
      usingSharedRuntime,
      wsStatus,
    ],
  );
}

export function toConversationRuntimeState(state: string): ConversationRuntimeState {
  if (state === "running") {
    return "running";
  }
  if (state === "waiting_approval") {
    return "waiting_approval";
  }
  if (state === "waiting_input") {
    return "waiting_input";
  }
  if (state === "cancelling") {
    return "cancelling";
  }
  if (state === "failed") {
    return "failed";
  }
  return "idle";
}

export function isAgentControllerBusy(state: ConversationRuntimeState): boolean {
  return isBusy(state);
}

function isBusy(state: ConversationRuntimeState): boolean {
  return state === "starting"
    || state === "running"
    || state === "waiting_approval"
    || state === "waiting_input"
    || state === "cancelling";
}

function sessionTitleFromPreparedMessage(text: string, contextItems: AgentContextItem[]): string {
  const title = text.trim() || contextItems[0]?.label || "工作台对话";
  return title.slice(0, 32);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function appendLocalError(
  dispatch: (action: AgentConversationAction) => void,
  sessionId: string,
  content: string,
) {
  const event: AgentActionEnvelope = {
    action: "error",
    data: {
      session_id: sessionId,
      code: "frontend_runtime_error",
      message: content,
      details: {},
    },
  };
  dispatch({ type: "event/receive", event });
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
  return lines[0] || "对话操作失败";
}

function shouldSyncHistoryAfterRuntimeEvent(event: AgentActionEnvelope, sessionId: string): boolean {
  if (!sessionId || !["completed", "cancelled", "error"].includes(event.action)) {
    return false;
  }
  const dataSessionId = runtimeEventSessionId(event);
  return dataSessionId === sessionId;
}

function runtimeEventSessionId(event: AgentActionEnvelope): string {
  const data = event.data;
  const value = data.session_id ?? data.id;
  return typeof value === "string" ? value : "";
}
