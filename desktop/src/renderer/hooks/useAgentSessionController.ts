import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  type ChatChannel,
  type ChatPayload,
  type RuntimeBridge,
  type WorkspaceSkillSummary,
  type WsConnectionStatus,
} from "@/runtime";
import {
  selectedQuoteFromText,
  type SelectedFile,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  selectAgentMessages,
  selectAgentRuntimeState,
  selectAgentSessionState,
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
} from "@/types/protocol";

export type AgentSessionControllerNoticeLevel = "error" | "warning";

export interface AgentSessionControllerEnsureSessionRequest {
  title: string;
  message: string;
  contextItems: AgentContextItem[];
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
  selectedText?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface UseAgentSessionControllerOptions {
  runtime: RuntimeBridge;
  sessionId?: string;
  historyPageSize?: number;
  loadFullHistory?: boolean;
  onRuntimeEvent?: (event: AgentActionEnvelope) => void;
  onRuntimeError?: (reason: unknown) => boolean | void;
  onNotice?: (message: string, level: AgentSessionControllerNoticeLevel) => void;
  onOpenModelSettings?: () => void;
  onAfterSend?: () => void;
  ensureSession?: (request: AgentSessionControllerEnsureSessionRequest) => Promise<AgentSessionControllerEnsureSessionResult>;
}

export interface AgentSessionController {
  state: ReturnType<typeof createInitialAgentConversationState>;
  dispatch: (action: AgentConversationAction) => void;
  session: AgentSession | null;
  sessionViewState: ReturnType<typeof selectAgentSessionState>;
  agentMessages: ReturnType<typeof selectAgentMessages>;
  runtimeState: ConversationRuntimeState;
  pendingApproval: CommandApprovalRequest | null;
  draft: string;
  setDraft: (value: string | ((current: string) => string)) => void;
  selectedSkill: WorkspaceSkillSummary | null;
  setSelectedSkill: (skill: WorkspaceSkillSummary | null) => void;
  fileChipRequest: { requestId: number; file: SelectedFile } | null;
  quoteChipRequest: { requestId: number; quote: SelectedQuote } | null;
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
  startChatFromAnnotation: (request: AgentSessionControllerAnnotationRequest) => void;
  loadOlderHistory: () => Promise<void>;
  sendText: (
    text: string,
    model: string,
    options?: {
      clearDraft?: boolean;
      contextItems?: ChatPayload["contextItems"];
      runtimeParams?: ChatPayload["runtime_params"];
    },
  ) => Promise<boolean>;
  send: (files?: SelectedFile[], quotes?: SelectedQuote[], model?: string) => Promise<boolean>;
  stop: () => void;
  submitApproval: (decision: CommandApprovalDecisionPayload) => Promise<void>;
  approvalSubmitting: boolean;
  approvalError: string | null;
}

export function useAgentSessionController({
  runtime,
  sessionId = "",
  historyPageSize = 5,
  loadFullHistory = true,
  onRuntimeEvent,
  onRuntimeError,
  onNotice,
  onOpenModelSettings,
  onAfterSend,
  ensureSession,
}: UseAgentSessionControllerOptions): AgentSessionController {
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const sharedRuntimeContext = optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime : null;
  const [localState, localDispatch] = useReducer(agentConversationReducer, createInitialAgentConversationState());
  const [draft, setDraft] = useState("");
  const [fileChipRequest, setFileChipRequest] = useState<{ requestId: number; file: SelectedFile } | null>(null);
  const [quoteChipRequest, setQuoteChipRequest] = useState<{ requestId: number; quote: SelectedQuote } | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<WorkspaceSkillSummary | null>(null);
  const [requestState, setRequestState] = useState<AgentSessionRuntimeState | null>(null);
  const [localRuntimeDetail, setLocalRuntimeDetail] = useState<string | null>(null);
  const [localWsStatus, setLocalWsStatus] = useState<WsConnectionStatus>("idle");
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const channelRef = useRef<ChatChannel | null>(null);
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
  const pendingApproval = sessionViewState?.pendingApproval ?? null;
  const agentMessages = sessionId ? selectAgentMessages(state, sessionId) : [];
  const runtimeState = toConversationRuntimeState(
    requestState ?? (sessionId ? selectAgentRuntimeState(state, sessionId) : "idle"),
  );
  const connectionReady = wsStatus === "open";
  const canSend = draft.trim().length > 0 && !isBusy(runtimeState) && connectionReady && Boolean(sessionId || ensureSession);
  const canStop = runtimeState === "running" && connectionReady && Boolean(sessionId);

  const handleRuntimeEvent = useCallback(
    (event: AgentActionEnvelope) => {
      onRuntimeEvent?.(event);
      dispatch({ type: "event/receive", event });
    },
    [dispatch, onRuntimeEvent],
  );

  useEffect(() => {
    if (!usingSharedRuntime || !sharedSubscribeEvent || !onRuntimeEvent) {
      return;
    }
    return sharedSubscribeEvent(onRuntimeEvent);
  }, [onRuntimeEvent, sharedSubscribeEvent, usingSharedRuntime]);

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setLoadingOlderHistory(false);
      dispatch({ type: "session/select", sessionId: null });
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
    handleRuntimeEvent,
    historyPageSize,
    loadFullHistory,
    onNotice,
    runtime,
    sessionId,
    setRuntimeDetail,
    sharedBindSession,
    usingSharedRuntime,
  ]);

  const loadOlderHistory = useCallback(async () => {
    const cursor = sessionViewState?.historyCursor;
    if (!sessionId || !cursor || !sessionViewState?.historyHasMoreOlder || loadingOlderHistory) {
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

  const startChatFromAnnotation = useCallback((request: AgentSessionControllerAnnotationRequest) => {
    const path = request.path.trim();
    const comment = request.comment.trim();
    if (!path || !comment) {
      return;
    }
    const selectedText = request.selectedText?.trim() ?? "";
    const quote = selectedText
      ? selectedQuoteFromText(selectedText, {
          source: "annotation",
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
          annotationComment: comment,
        },
      }));
    }
  }, []);

  const resolveSessionId = useCallback(
    async (message: string, contextItems: AgentContextItem[]) => {
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
      if ((!trimmedText && !contextItems.length) || isBusy(runtimeState)) {
        return false;
      }
      if (!trimmedModel) {
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

      let targetSessionId: string | null = sessionId || null;
      if (!targetSessionId) {
        try {
          targetSessionId = await resolveSessionId(trimmedText, contextItems);
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
        dispatch({
          type: "message/addUser",
          sessionId: targetSessionId,
          content: trimmedText,
          contextItems,
        });
        dispatch({ type: "runtime/setState", sessionId: targetSessionId, runtimeState: "running" });
        const payload: ChatPayload = {
          session_id: targetSessionId,
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
    async (files: SelectedFile[] = [], quotes: SelectedQuote[] = [], model = "") => {
      const prepared = prepareComposerMessage(draft, files, { quotes, selectedSkill });
      if (!prepared.message && !prepared.contextItems.length) {
        return false;
      }
      const sent = await sendText(prepared.message, model, {
        clearDraft: true,
        contextItems: prepared.contextItems,
        runtimeParams: prepared.runtimeParams,
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
      loadOlderHistory,
      sendText,
      send,
      stop,
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
      runtimeDetail,
      runtimeState,
      selectedSkill,
      send,
      sendText,
      session,
      sessionViewState,
      setRuntimeDetail,
      startChatFromAnnotation,
      state,
      stop,
      submitApproval,
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
  return state === "starting" || state === "running" || state === "waiting_approval" || state === "cancelling";
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
