import { ChevronDown, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import styles from "./MessageThinking.module.css";

export interface MessageThinkingProps {
  message: ConversationMessage;
}

export function MessageThinking({ message }: MessageThinkingProps) {
  const status = message.status ?? "running";
  const running = status === "running" || status === "pending";
  const failed = status === "failed";
  const defaultExpanded = false;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [touched, setTouched] = useState(false);
  const duration = useMemo(() => formatDuration(message), [message]);
  const title = useMemo(() => titleFromMessage(message, running, failed), [failed, message, running]);

  useEffect(() => {
    if (!touched) {
      setExpanded(defaultExpanded);
    }
  }, [defaultExpanded, touched]);

  const toggle = () => {
    setTouched(true);
    setExpanded((value) => !value);
  };

  if (!message.content.trim() && !running) {
    return null;
  }

  return (
    <article className={styles.thinking} data-status={status} data-testid="message-thinking">
      <button className={styles.summary} type="button" aria-expanded={expanded} onClick={toggle}>
        <span className={styles.statusIcon} aria-hidden="true">
          {running ? <LoaderCircle size={15} /> : failed ? <TriangleAlert size={15} /> : <Sparkles size={15} />}
        </span>
        <span className={styles.title}>{title}</span>
        {duration ? <span className={styles.duration}>{duration}</span> : null}
        <ChevronDown size={15} className={styles.chevron} data-expanded={expanded ? "true" : "false"} />
      </button>

      {expanded ? <div className={styles.content}>{message.content || "等待模型返回推理内容"}</div> : null}
    </article>
  );
}

function titleFromMessage(message: ConversationMessage, running: boolean, failed: boolean): string {
  const reasoningKind = stringPayload(message.payload.reasoning_kind) || stringPayload(message.payload.reasoningKind);
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
    case "reasoning":
      return "推理";
    case "subagent":
      return "子任务";
    default:
      return "思考";
  }
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatDuration(message: ConversationMessage): string {
  const durationMs = durationFromPayload(message.payload);
  if (durationMs !== null) {
    return `${formatSeconds(durationMs)} 秒`;
  }
  const start = new Date(message.createdAt).getTime();
  const end = new Date(message.updatedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return "";
  }
  return `${formatSeconds(end - start)} 秒`;
}

function durationFromPayload(payload: Record<string, unknown>): number | null {
  const value = payload.duration_ms ?? payload.durationMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
}
