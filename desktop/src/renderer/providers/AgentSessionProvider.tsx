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
  type ReorderPendingInputsPayload,
  type ResumePendingInputsPayload,
  type RuntimeBridge,
  type UpdatePendingInputPayload,
  type WsConnectionStatus,
} from "@/runtime";
import { isFileWatchEventAction } from "@/types/protocol";
import type { A2UICancelActionPayload, A2UISubmitActionPayload, AgentActionEnvelope } from "@/types/protocol";
import type { McpElicitationResolvePayload } from "@/types/protocol";
import type { SubagentRunSnapshot } from "@/types/subagents";
import { emitSessionEventsFromRuntimeEvent } from "@/renderer/events/sessionEvents";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  type AgentConversationAction,
  type AgentConversationState,
} from "@/renderer/stores/agentSessionStore";
import {
  createInitialSubagentRunsState,
  reduceSubagentRunEvent,
  markSubagentRunRead as markSubagentRunReadInState,
  type SubagentRunsState,
} from "@/renderer/stores/subagentRunStore";

export interface AgentSessionRuntimeContextValue {
  runtime: RuntimeBridge;
  state: AgentConversationState;
  subagentState: SubagentRunsState;
  dispatch: Dispatch<AgentConversationAction>;
  wsStatus: WsConnectionStatus;
  runtimeDetail: string | null;
  setRuntimeDetail: (detail: string | null) => void;
  bindSession: (sessionId: string) => void;
  bindSubagentSession: (parentSessionId: string, runId: string, childSessionId: string) => void;
  unbindSubagentSession: (childSessionId: string) => void;
  requestSubagentRuns: (parentSessionId: string) => void;
  applySubagentSnapshot: (snapshot: SubagentRunSnapshot) => void;
  markSubagentRunRead: (runId: string) => void;
  subscribeEvent: (listener: (event: AgentActionEnvelope) => void) => () => void;
  chat: (payload: ChatPayload) => void;
  updatePendingInput: (payload: UpdatePendingInputPayload) => void;
  reorderPendingInputs: (payload: ReorderPendingInputsPayload) => void;
  cancelPendingInput: (sessionId: string, pendingInputId: string, reason?: string | null) => void;
  resumePendingInputs: (payload: ResumePendingInputsPayload) => void;
  submitA2UI: (payload: A2UISubmitActionPayload) => void;
  cancelA2UI: (payload: A2UICancelActionPayload) => void;
  cancel: (sessionId?: string) => void;
  terminateCommand: (sessionId: string, commandId: string) => void;
  resolveMcpElicitation: (payload: McpElicitationResolvePayload) => void;
  ping: () => void;
  bindWorkspaceWatch: (workspaceId: string) => void;
  unbindWorkspaceWatch: (workspaceId: string) => void;
  bindGitRepositoryWatch: (workspaceId: string, projectRoot: string, repositoryId: string) => void;
  unbindGitRepositoryWatch: (repositoryId: string) => void;
  bindLocalFileWatch: (watchId: string, path: string) => void;
  unbindLocalFileWatch: (watchId: string) => void;
}

export const AgentSessionRuntimeContext = createContext<AgentSessionRuntimeContextValue | null>(null);

export function AgentSessionProvider({
  children,
  runtime = runtimeBridge,
}: PropsWithChildren<{ runtime?: RuntimeBridge }>) {
  const [state, dispatch] = useReducer(agentConversationReducer, createInitialAgentConversationState());
  const [subagentState, dispatchSubagentEvent] = useReducer(
    (
      current: SubagentRunsState,
      action: AgentActionEnvelope | { type: "mark-read"; runId: string },
    ) =>
      "type" in action
        ? markSubagentRunReadInState(current, action.runId)
        : reduceSubagentRunEvent(current, action),
    createInitialSubagentRunsState(),
  );
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>("idle");
  const [runtimeDetail, setRuntimeDetail] = useState<string | null>(null);
  const channelRef = useRef<ChatChannel | null>(null);
  const pendingBindSessionIdsRef = useRef(new Set<string>());
  const desiredSubagentSessionBindingsRef = useRef(
    new Map<string, { parentSessionId: string; runId: string }>(),
  );
  const desiredWorkspaceWatchIdsRef = useRef(new Set<string>());
  const desiredGitRepositoryWatchesRef = useRef(
    new Map<string, { workspaceId: string; projectRoot: string }>(),
  );
  const desiredLocalFileWatchesRef = useRef(new Map<string, string>());
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
      channel.requestSubagentRuns?.(sessionId);
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

  const requestSubagentRuns = useCallback((parentSessionId: string) => {
    const cleaned = parentSessionId.trim();
    const channel = channelRef.current;
    if (!cleaned || !channel || channel.getStatus() !== "open") return;
    channel.requestSubagentRuns?.(cleaned);
  }, []);

  const applySubagentSnapshot = useCallback((snapshot: SubagentRunSnapshot) => {
    dispatchSubagentEvent({
      action: "subagent_run_snapshot",
      data: { session_id: snapshot.parent_session_id, run: snapshot },
    });
  }, []);

  const markSubagentRunRead = useCallback((runId: string) => {
    dispatchSubagentEvent({ type: "mark-read", runId });
  }, []);

  const bindSubagentSession = useCallback(
    (parentSessionId: string, runId: string, childSessionId: string) => {
      const binding = { parentSessionId: parentSessionId.trim(), runId: runId.trim() };
      const childId = childSessionId.trim();
      if (!binding.parentSessionId || !binding.runId || !childId) return;
      desiredSubagentSessionBindingsRef.current.set(childId, binding);
      channelRef.current?.bindSubagentSession?.(binding.parentSessionId, binding.runId, childId);
    },
    [],
  );

  const unbindSubagentSession = useCallback((childSessionId: string) => {
    const childId = childSessionId.trim();
    if (!childId || !desiredSubagentSessionBindingsRef.current.delete(childId)) return;
    channelRef.current?.unbindSubagentSession?.(childId);
  }, []);

  const subscribeEvent = useCallback((listener: (event: AgentActionEnvelope) => void) => {
    eventListenersRef.current.add(listener);
    return () => {
      eventListenersRef.current.delete(listener);
    };
  }, []);

  const receiveRuntimeEvent = useCallback((event: AgentActionEnvelope) => {
    dispatchSubagentEvent(event);
    if (!isFileWatchEventAction(event.action)) {
      dispatch({ type: "event/receive", event });
      emitSessionEventsFromRuntimeEvent(event);
    }
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
    for (const [childSessionId, binding] of desiredSubagentSessionBindingsRef.current) {
      channel.bindSubagentSession?.(binding.parentSessionId, binding.runId, childSessionId);
    }
    for (const workspaceId of desiredWorkspaceWatchIdsRef.current) {
      channel.bindWorkspaceWatch?.(workspaceId);
    }
    for (const [repositoryId, scope] of desiredGitRepositoryWatchesRef.current) {
      channel.bindGitRepositoryWatch?.(scope.workspaceId, scope.projectRoot, repositoryId);
    }
    for (const [watchId, path] of desiredLocalFileWatchesRef.current) {
      channel.bindLocalFileWatch?.(watchId, path);
    }
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

  const updatePendingInput = useCallback((payload: UpdatePendingInputPayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    if (!channel.updatePendingInput) {
      throw new Error("待发送消息通道未启用");
    }
    channel.updatePendingInput(payload);
  }, []);

  const reorderPendingInputs = useCallback((payload: ReorderPendingInputsPayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    if (!channel.reorderPendingInputs) {
      throw new Error("待发送消息排序通道未启用");
    }
    channel.reorderPendingInputs(payload);
  }, []);

  const cancelPendingInput = useCallback((sessionId: string, pendingInputId: string, reason?: string | null) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    if (!channel.cancelPendingInput) {
      throw new Error("待发送消息通道未启用");
    }
    channel.cancelPendingInput(sessionId, pendingInputId, reason);
  }, []);

  const resumePendingInputs = useCallback((payload: ResumePendingInputsPayload) => {
    const channel = channelRef.current;
    if (!channel || channel.getStatus() !== "open") {
      throw new Error("对话连接尚未就绪");
    }
    if (!channel.resumePendingInputs) {
      throw new Error("待发送消息恢复通道未启用");
    }
    channel.resumePendingInputs(payload);
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

  const bindWorkspaceWatch = useCallback((workspaceId: string) => {
    const cleaned = workspaceId.trim();
    if (!cleaned || desiredWorkspaceWatchIdsRef.current.has(cleaned)) {
      return;
    }
    desiredWorkspaceWatchIdsRef.current.add(cleaned);
    channelRef.current?.bindWorkspaceWatch?.(cleaned);
  }, []);

  const unbindWorkspaceWatch = useCallback((workspaceId: string) => {
    const cleaned = workspaceId.trim();
    if (!desiredWorkspaceWatchIdsRef.current.delete(cleaned)) {
      return;
    }
    channelRef.current?.unbindWorkspaceWatch?.(cleaned);
  }, []);

  const bindGitRepositoryWatch = useCallback(
    (workspaceId: string, projectRoot: string, repositoryId: string) => {
      const scope = { workspaceId: workspaceId.trim(), projectRoot: projectRoot.trim() };
      const cleanedRepositoryId = repositoryId.trim();
      if (!scope.workspaceId || !scope.projectRoot || !cleanedRepositoryId) return;
      const existing = desiredGitRepositoryWatchesRef.current.get(cleanedRepositoryId);
      if (
        existing &&
        (existing.workspaceId !== scope.workspaceId || existing.projectRoot !== scope.projectRoot)
      ) {
        throw new Error("The same repository_id cannot be rebound to another project");
      }
      if (existing) return;
      desiredGitRepositoryWatchesRef.current.set(cleanedRepositoryId, scope);
      channelRef.current?.bindGitRepositoryWatch?.(
        scope.workspaceId,
        scope.projectRoot,
        cleanedRepositoryId,
      );
    },
    [],
  );

  const unbindGitRepositoryWatch = useCallback((repositoryId: string) => {
    const cleaned = repositoryId.trim();
    if (!desiredGitRepositoryWatchesRef.current.delete(cleaned)) return;
    channelRef.current?.unbindGitRepositoryWatch?.(cleaned);
  }, []);

  const bindLocalFileWatch = useCallback((watchId: string, path: string) => {
    const cleanedWatchId = watchId.trim();
    const cleanedPath = path.trim();
    if (!cleanedWatchId || !cleanedPath) {
      return;
    }
    const existing = desiredLocalFileWatchesRef.current.get(cleanedWatchId);
    if (existing === cleanedPath) {
      return;
    }
    if (existing) {
      throw new Error("同一 watch_id 不能绑定不同文件");
    }
    desiredLocalFileWatchesRef.current.set(cleanedWatchId, cleanedPath);
    channelRef.current?.bindLocalFileWatch?.(cleanedWatchId, cleanedPath);
  }, []);

  const unbindLocalFileWatch = useCallback((watchId: string) => {
    const cleaned = watchId.trim();
    if (!desiredLocalFileWatchesRef.current.delete(cleaned)) {
      return;
    }
    channelRef.current?.unbindLocalFileWatch?.(cleaned);
  }, []);

  const value = useMemo<AgentSessionRuntimeContextValue>(
    () => ({
      runtime,
      state,
      subagentState,
      dispatch,
      wsStatus,
      runtimeDetail,
      setRuntimeDetail,
      bindSession,
      bindSubagentSession,
      unbindSubagentSession,
      requestSubagentRuns,
      applySubagentSnapshot,
      markSubagentRunRead,
      subscribeEvent,
      chat,
      updatePendingInput,
      reorderPendingInputs,
      cancelPendingInput,
      resumePendingInputs,
      submitA2UI,
      cancelA2UI,
      cancel,
      terminateCommand,
      resolveMcpElicitation,
      ping,
      bindWorkspaceWatch,
      unbindWorkspaceWatch,
      bindGitRepositoryWatch,
      unbindGitRepositoryWatch,
      bindLocalFileWatch,
      unbindLocalFileWatch,
    }),
    [applySubagentSnapshot, bindGitRepositoryWatch, bindLocalFileWatch, bindSession, bindSubagentSession, bindWorkspaceWatch, cancel, cancelA2UI, cancelPendingInput, chat, markSubagentRunRead, ping, reorderPendingInputs, requestSubagentRuns, resolveMcpElicitation, resumePendingInputs, runtime, runtimeDetail, state, subagentState, submitA2UI, subscribeEvent, terminateCommand, unbindGitRepositoryWatch, unbindLocalFileWatch, unbindSubagentSession, unbindWorkspaceWatch, updatePendingInput, wsStatus],
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
