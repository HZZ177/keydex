import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { runtimeBridge, type ChatChannel, type RuntimeBridge, type WsConnectionStatus } from "@/runtime";
import { SendBox } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, type RuntimeModelSelection, useRuntimeModelSelection } from "@/renderer/components/model";
import { FilePreview, type FilePreviewRequest } from "@/renderer/components/workspace";
import { useRuntimeTypingMetrics } from "@/renderer/hooks/useRuntimeTypingSpeed";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  selectAgentMessages,
  selectAgentRuntimeState,
  type AgentConversationAction,
  type AgentSessionRuntimeState,
} from "@/renderer/stores/agentSessionStore";
import type { ConversationMessage, ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type { AgentActionEnvelope, AgentChatMessage } from "@/types/protocol";

import { ChatLayout } from "./ChatLayout";
import { MessageList, type MessageListScrollControls } from "./messages";
import styles from "./ConversationPage.module.css";

export interface ConversationPageProps {
  threadId: string;
  runtime?: RuntimeBridge;
  initialModel?: string;
  initialMessage?: string;
  onOpenModelSettings?: () => void;
}

export function ConversationPage({
  threadId,
  runtime = runtimeBridge,
  initialModel = "",
  initialMessage = "",
  onOpenModelSettings,
}: ConversationPageProps) {
  const [state, dispatch] = useReducer(agentConversationReducer, createInitialAgentConversationState());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [requestState, setRequestState] = useState<AgentSessionRuntimeState | null>(null);
  const [runtimeDetail, setRuntimeDetail] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>("idle");
  const [preview, setPreview] = useState<FilePreviewRequest | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const channelRef = useRef<ChatChannel | null>(null);
  const initialMessageSentRef = useRef<string | null>(null);
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null);
  const previewContext = useOptionalPreview();
  const modelSelection = useRuntimeModelSelection(runtime, initialModel);

  const session = state.sessionsById[threadId] ?? null;
  const agentMessages = selectAgentMessages(state, threadId);
  const messages = useMemo(() => agentMessages.map(agentMessageToConversationMessage), [agentMessages]);
  const runtimeState = toConversationRuntimeState(requestState ?? selectAgentRuntimeState(state, threadId));
  const title = session?.title || (threadId ? `对话 ${threadId}` : "对话");
  const connectionReady = wsStatus === "open";
  const canSend = draft.trim().length > 0 && !isBusy(runtimeState) && connectionReady;
  const canStop = runtimeState === "running" && connectionReady;
  const activePreview = previewContext ? previewContext.request : preview;

  const updateScrollControls = useCallback((controls: MessageListScrollControls) => {
    scrollToBottomRef.current = controls.scrollToBottom;
    setShowScrollToBottom(controls.showScrollToBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollToBottomRef.current?.("smooth");
  }, []);

  const openPreview = (request: FilePreviewRequest) => {
    setPreview(request);
    previewContext?.openPreview(request);
  };

  const quoteSelection = (text: string) => {
    const quotedText = formatQuotedSelection(text);
    if (!quotedText) {
      return;
    }
    setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${quotedText}` : quotedText));
  };

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let active = true;
    setLoading(true);
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
            setWsStatus(status);
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
        const history = await runtime.conversation.loadHistory(threadId, { order: "asc" });
        if (!active) {
          return;
        }
        dispatch({ type: "history/loaded", sessionId: threadId, history });
      } catch (reason) {
        if (!active) {
          return;
        }
        const message = errorMessage(reason);
        setRuntimeDetail(publicRuntimeDetail(message));
        appendLocalError(dispatch, threadId, message);
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
  }, [runtime, threadId]);

  const sendText = useCallback(
    (text: string, model: string, options: { clearDraft?: boolean } = {}) => {
      const trimmedText = text.trim();
      const trimmedModel = model.trim();
      if (!trimmedText || !threadId || isBusy(runtimeState)) {
        return false;
      }
      if (!trimmedModel) {
        const message = "请先选择模型";
        setRuntimeDetail(message);
        onOpenModelSettings?.();
        return false;
      }
      const channel = channelRef.current;
      if (!channel || wsStatus !== "open") {
        const message = "对话连接尚未就绪";
        setRuntimeDetail(message);
        return false;
      }

      setRuntimeDetail(null);
      try {
        dispatch({ type: "message/addUser", sessionId: threadId, content: trimmedText });
        dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "running" });
        channel.chat({ session_id: threadId, message: trimmedText, model: trimmedModel });
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
    [onOpenModelSettings, runtimeState, threadId, wsStatus],
  );

  useEffect(() => {
    const text = initialMessage.trim();
    const model = modelSelection.selectedModel.trim();
    const key = `${threadId}:${model}:${text}`;
    if (!text || !threadId || loading || !connectionReady || initialMessageSentRef.current === key) {
      return;
    }
    const sent = sendText(text, model);
    if (sent) {
      initialMessageSentRef.current = key;
    }
  }, [connectionReady, initialMessage, loading, modelSelection.selectedModel, sendText, threadId]);

  const send = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    const model = modelSelection.selectedModel.trim();
    sendText(text, model, { clearDraft: true });
  };

  const stop = () => {
    if (!threadId || !canStop) {
      return;
    }
    const channel = channelRef.current;
    if (!channel || wsStatus !== "open") {
      setRuntimeDetail("对话连接尚未就绪");
      return;
    }

    setRequestState("cancelling");
    setRuntimeDetail(null);
    try {
      dispatch({ type: "runtime/setState", sessionId: threadId, runtimeState: "cancelling" });
      channel.cancel(threadId);
    } catch (reason) {
      const message = errorMessage(reason);
      setRuntimeDetail(publicRuntimeDetail(message));
      appendLocalError(dispatch, threadId, message);
    } finally {
      setRequestState(null);
    }
  };

  return (
    <ChatLayout
      title={title}
      subtitle={connectionSubtitle(wsStatus)}
      composerAccessory={
        <ConversationComposerAccessory
          showScrollToBottom={showScrollToBottom}
          onScrollToBottom={scrollToBottom}
        />
      }
      composer={
        <ConversationComposer
          value={draft}
          runtimeState={runtimeState}
          canSend={canSend}
          canStop={canStop}
          connectionReady={connectionReady}
          modelSelection={modelSelection}
          onOpenModelSettings={onOpenModelSettings}
          onChange={setDraft}
          onSend={send}
          onStop={stop}
        />
      }
      previewPanel={
        activePreview ? (
          <FilePreview root={undefined} request={activePreview} runtime={runtime} onQuoteSelection={quoteSelection} />
        ) : null
      }
    >
      <MessageList
        messages={messages}
        loading={loading}
        isProcessing={runtimeState === "running"}
        runtimeState={runtimeState}
        runtimeDetail={runtimeDetail}
        onFilePreview={(file) => openPreview({ type: "diff", path: file.path, diff: file.diff })}
        onQuoteSelection={quoteSelection}
        scrollButtonMode="external"
        onScrollControlsChange={updateScrollControls}
        emptyText="还没有消息，输入需求开始对话。"
        emptyTestId="conversation-empty"
      />
    </ChatLayout>
  );
}

function ConversationComposerAccessory({
  showScrollToBottom,
  onScrollToBottom,
}: {
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
}) {
  const runtimeTypingMetrics = useRuntimeTypingMetrics();
  return (
    <div className={styles.composerAccessoryBar} aria-label="输入框状态">
      <span className={styles.typingSpeedPill} data-testid="typing-speed-pill">
        打字机 {runtimeTypingMetrics.speed} 字符/s - 待输出 {runtimeTypingMetrics.backlog} 字
      </span>
      <button
        className={styles.scrollBottomButton}
        type="button"
        aria-label="滚动到底"
        title="滚动到底"
        disabled={!showScrollToBottom}
        onClick={onScrollToBottom}
      >
        <ArrowDown size={15} />
      </button>
    </div>
  );
}

function ConversationComposer({
  value,
  runtimeState,
  canSend,
  canStop,
  connectionReady,
  modelSelection,
  onOpenModelSettings,
  onChange,
  onSend,
  onStop,
}: {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  connectionReady: boolean;
  modelSelection: RuntimeModelSelection;
  onOpenModelSettings?: () => void;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <SendBox
      value={value}
      runtimeState={runtimeState}
      canSend={canSend}
      canStop={canStop}
      statusText={composerStatusText(runtimeState, connectionReady)}
      variant="codex"
      controls={
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
      allowFileSelection={false}
    />
  );
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
    return message.toolName === "run_command" ? "command" : "tool";
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
  };

  if (message.role === "tool") {
    return {
      ...base,
      call: {
        name: message.toolName,
        arguments: message.toolParams ?? {},
      },
      result: {
        status: message.toolError || message.status === "error" ? "error" : "success",
        model_content: message.toolResult ?? "",
        duration_ms: message.toolDurationMs,
        error: message.toolError,
        ui_payload: message.uiPayload,
      },
      duration_ms: message.toolDurationMs,
      metadata: message.metadata,
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

function toConversationRuntimeState(state: AgentSessionRuntimeState): ConversationRuntimeState {
  if (state === "running") {
    return "running";
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
  if (state === "idle") {
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

function formatQuotedSelection(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
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
  return new Date(index + 1).toISOString();
}
