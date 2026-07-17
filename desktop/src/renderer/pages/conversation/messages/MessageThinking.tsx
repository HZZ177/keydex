import { ChevronDown, Sparkles, TriangleAlert } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { normalizeMessageContent } from "@/renderer/utils/messageContent";

import { formatConversationDuration } from "./duration";
import styles from "./MessageThinking.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

export interface MessageThinkingProps {
  message: ConversationMessage;
}

export function MessageThinking({ message }: MessageThinkingProps) {
  const status = message.status ?? "running";
  const running = status === "running" || status === "pending";
  const failed = status === "failed";
  const defaultExpanded = running;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [touched, setTouched] = useState(false);
  const durationMs = useThinkingDuration(message, running);
  const duration = durationMs === null ? "" : `思考了 ${formatConversationDuration(durationMs)}`;
  const title = useMemo(() => titleFromMessage(message, running, failed), [failed, message, running]);
  const content = useMemo(() => normalizeMessageContent(message.content), [message.content]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const previousStatusRef = useRef(status);
  const contentMotion = useDeferredUnmount<HTMLDivElement>(expanded, 180, 220);

  useEffect(() => {
    if (!touched && defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded, touched]);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    if (previousStatus !== "completed" && status === "completed") {
      setExpanded(false);
    }
  }, [status]);

  useLayoutEffect(() => {
    const viewport = contentRef.current;
    if (!running || !expanded || !viewport || !followLatestRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [content, expanded, running]);

  const handleContentScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    followLatestRef.current = distanceToBottom <= 24;
  }, []);

  const toggle = () => {
    setTouched(true);
    setExpanded((value) => {
      const next = !value;
      if (next && running) {
        followLatestRef.current = true;
      }
      return next;
    });
  };

  if (!content.trim() && !running) {
    return null;
  }

  return (
    <article className={styles.thinking} data-status={status} data-testid="message-thinking">
      <button className={styles.summary} type="button" aria-expanded={expanded} onClick={toggle}>
        <span className={styles.statusIcon} aria-hidden="true">
          {failed ? <TriangleAlert size={15} /> : <Sparkles size={15} />}
        </span>
        <span className={styles.title}>{title}</span>
        {duration ? <span className={styles.duration}>{duration}</span> : null}
        <ChevronDown size={15} className={styles.chevron} data-expanded={expanded ? "true" : "false"} />
      </button>

      {contentMotion.shouldRender ? (
        <div
          className={styles.contentShell}
          data-motion={contentMotion.phase}
          ref={contentMotion.ref}
          style={contentMotion.style}
          aria-hidden={!expanded}
          data-testid="message-thinking-content"
        >
          <div className={styles.content} ref={contentRef} onScroll={handleContentScroll}>
            {content || "等待模型返回思考内容"}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function titleFromMessage(message: ConversationMessage, running: boolean, failed: boolean): string {
  const reasoningKind = stringPayload(message.payload.reasoning_kind) || stringPayload(message.payload.reasoningKind);
  if (reasoningKind === "reasoning") {
    if (running) {
      return "正在思考";
    }
    return failed ? "思考失败" : "已完成思考";
  }
  if (reasoningKind) {
    const label = reasoningKindLabel(reasoningKind);
    if (running) {
      return `${label}中`;
    }
    return failed ? `${label}失败` : `已完成${label}`;
  }
  if (running) {
    return "正在思考";
  }
  return failed ? "思考失败" : "已完成思考";
}

function reasoningKindLabel(kind: string): string {
  switch (kind) {
    case "initial_response":
      return "起始响应";
    case "status_update":
      return "状态更新";
    case "progress_fact":
      return "进展事实";
    case "subagent":
      return "子任务";
    default:
      return "思考";
  }
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function useThinkingDuration(message: ConversationMessage, running: boolean): number | null {
  const persistedDurationMs = durationFromPayload(message.payload);
  const startMs = timestampMs(message.createdAt);
  const endMs = timestampMs(message.updatedAt);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running || persistedDurationMs !== null || startMs === null) {
      return undefined;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [message.id, persistedDurationMs, running, startMs]);

  if (persistedDurationMs !== null) {
    return persistedDurationMs;
  }
  if (startMs === null) {
    return null;
  }
  if (running) {
    return Math.max(0, nowMs - startMs);
  }
  if (endMs === null || endMs <= startMs) {
    return null;
  }
  return endMs - startMs;
}

function durationFromPayload(payload: Record<string, unknown>): number | null {
  const value = payload.duration_ms ?? payload.durationMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampMs(value: string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
