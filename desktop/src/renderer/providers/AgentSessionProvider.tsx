import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type PropsWithChildren,
} from "react";

import {
  runtimeBridge,
  type ChatChannel,
  type ChatPayload,
  type RuntimeBridge,
  type WsConnectionStatus,
} from "@/runtime";
import type { A2UICancelActionPayload, A2UISubmitActionPayload, AgentActionEnvelope } from "@/types/protocol";
import type { McpElicitationResolvePayload } from "@/types/protocol";
import { emitSessionEventsFromRuntimeEvent } from "@/renderer/events/sessionEvents";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  type AgentConversationAction,
  type AgentConversationState,
} from "@/renderer/stores/agentSessionStore";

export interface AgentSessionRuntimeContextValue {
  runtime: RuntimeBridge;
  state: AgentConversationState;
  dispatch: Dispatch<AgentConversationAction>;
  wsStatus: WsConnectionStatus;
  runtimeDetail: string | null;
  setRuntimeDetail: (detail: string | null) => void;
  bindSession: (sessionId: string) => void;
  subscribeEvent: (listener: (event: AgentActionEnvelope) => void) => () => void;
  chat: (payload: ChatPayload) => void;
  submitA2UI: (payload: A2UISubmitActionPayload) => void;
  cancelA2UI: (payload: A2UICancelActionPayload) => void;
  cancel: (sessionId?: string) => void;
  terminateCommand: (sessionId: string, commandId: string) => void;
  resolveMcpElicitation: (payload: McpElicitationResolvePayload) => void;
  ping: () => void;
}

const AgentSessionRuntimeContext = createContext<AgentSessionRuntimeContextValue | null>(null);

export function AgentSessionProvider({
  children,
  runtime = runtimeBridge,
}: PropsWithChildren<{ runtime?: RuntimeBridge }>) {
  const [state, dispatch] = useReducer(agentConversationReducer, createInitialAgentConversationState());
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>("idle");
  const [runtimeDetail, setRuntimeDetail] = useState<string | null>(null);
  const channelRef = useRef<ChatChannel | null>(null);
  const pendingBindSessionIdsRef = useRef(new Set<string>());
  const eventListenersRef = useRef(new Set<(event: AgentActionEnvelope) => void>());
  const requestedStatusRef = useRef(false);
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const setRuntimeWsStatus = runtimeConnection?.setWsStatus;

  const flushPendingBinds = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      return;
    }
    for (const sessionId of pendingBindSessionIdsRef.current) {
      channel.bindSession(sessionId);
    }
    pendingBindSessionIdsRef.current.clear();
  }, []);

  const bindSession = useCallback(
    (sessionId: string) => {
      const cleaned = sessionId.trim();
      if (!cleaned) {
        return;
      }
      pendingBindSessionIdsRef.current.add(cleaned);
      flushPendingBinds();
    },
    [flushPendingBinds],
  );

  const subscribeEvent = useCallback((listener: (event: AgentActionEnvelope) => void) => {
    eventListenersRef.current.add(listener);
    return () => {
      eventListenersRef.current.delete(listener);
    };
  }, []);

  const receiveRuntimeEvent = useCallback((event: AgentActionEnvelope) => {
    dispatch({ type: "event/receive", event });
    emitSessionEventsFromRuntimeEvent(event);
    for (const listener of eventListenersRef.current) {
      listener(event);
    }
  }, []);

  useEffect(() => {
    if (!backendReady) {
      setWsStatus("idle");
      setRuntimeDetail(null);
      return;
    }
    const channel = runtime.conversation.openChatChannel(receiveRuntimeEvent, {
      onStatus: setWsStatus,
      onError: (reason) => {
        const message = reason instanceof Error ? reason.message : String(reason || "连接异常");
        setRuntimeDetail(message);
      },
    });
    channelRef.current = channel;
    return () => {
      channel.close();
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
    };
  }, [backendReady, receiveRuntimeEvent, runtime]);

  useEffect(() => {
    setRuntimeWsStatus?.(wsStatus);
  }, [setRuntimeWsStatus, wsStatus]);

  useEffect(() => {
    if (wsStatus === "open") {
      flushPendingBinds();
      if (!requestedStatusRef.current) {
        channelRef.current?.requestStatus();
        requestedStatusRef.current = true;
      }
    } else {
      requestedStatusRef.current = false;
    }
  }, [flushPendingBinds, wsStatus]);

  const chat = useCallback((payload: ChatPayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
    if (sessionId) {
      pendingBindSessionIdsRef.current.add(sessionId);
      channel.bindSession(sessionId);
    }
    channel.chat(payload);
  }, []);

  const cancel = useCallback((sessionId?: string) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    channel.cancel(sessionId);
  }, []);

  const submitA2UI = useCallback((payload: A2UISubmitActionPayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    channel.submitA2UI(payload);
  }, []);

  const cancelA2UI = useCallback((payload: A2UICancelActionPayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    channel.cancelA2UI(payload);
  }, []);

  const terminateCommand = useCallback((sessionId: string, commandId: string) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    channel.terminateCommand(sessionId, commandId);
  }, []);

  const resolveMcpElicitation = useCallback((payload: McpElicitationResolvePayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    if (!channel.resolveMcpElicitation) {
      throw new Error("MCP elicitation 通道未启用");
    }
    channel.resolveMcpElicitation(payload);
  }, []);

  const ping = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      return;
    }
    channel.ping();
  }, []);

  const value = useMemo<AgentSessionRuntimeContextValue>(
    () => ({
      runtime,
      state,
      dispatch,
      wsStatus,
      runtimeDetail,
      setRuntimeDetail,
      bindSession,
      subscribeEvent,
      chat,
      submitA2UI,
      cancelA2UI,
      cancel,
      terminateCommand,
      resolveMcpElicitation,
      ping,
    }),
    [bindSession, cancel, cancelA2UI, chat, ping, resolveMcpElicitation, runtime, runtimeDetail, state, submitA2UI, subscribeEvent, terminateCommand, wsStatus],
  );

  return (
    <AgentSessionRuntimeContext.Provider value={value}>
      {children}
    </AgentSessionRuntimeContext.Provider>
  );
}

export function useAgentSessionRuntime() {
  const value = useContext(AgentSessionRuntimeContext);
  if (!value) {
    throw new Error("useAgentSessionRuntime 必须在 AgentSessionProvider 内使用");
  }
  return value;
}

export function useOptionalAgentSessionRuntime() {
  return useContext(AgentSessionRuntimeContext);
}
