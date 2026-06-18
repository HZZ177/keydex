import { Check, ChevronDown, Clipboard, LoaderCircle, Wrench, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import styles from "./ToolCallBlock.module.css";

export interface ToolCallBlockProps {
  message: ConversationMessage;
}

export function ToolCallBlock({ message }: ToolCallBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const tool = useMemo(() => parseToolPayload(message), [message]);
  const running = message.status === "pending" || message.status === "running";
  const failed = message.status === "failed" || tool.resultStatus === "error";
  const statusText = statusLabel(message.status, tool.resultStatus);
  const statusKind = failed ? "failed" : running ? "running" : "done";
  const resultLabel = failed ? "错误" : "结果";

  const handleCopyResult = async () => {
    try {
      await copyText(tool.resultText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <article
      className={styles.block}
      data-collapsed={detailsOpen ? "false" : "true"}
      data-status={failed ? "failed" : message.status}
      data-testid="tool-call-block"
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {failed ? <XCircle size={16} /> : running ? <LoaderCircle size={16} /> : <Wrench size={16} />}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>{tool.name}</div>
          <div className={styles.status}>
            <span className={styles.statusDot} data-state={statusKind} />
            <span>{statusText}</span>
            {tool.duration ? <span>{tool.duration}</span> : null}
          </div>
        </div>
        <button
          className={styles.detailsToggle}
          type="button"
          aria-expanded={detailsOpen}
          aria-label={detailsOpen ? "收起工具详情" : "展开工具详情"}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <ChevronDown size={14} />
          <span>{detailsOpen ? "收起" : "详情"}</span>
        </button>
      </header>

      {detailsOpen ? (
        <div className={styles.details} aria-label="工具详情">
          <section className={styles.detailSection} aria-label="工具参数">
            <h3>参数</h3>
            <pre className={styles.args}>{tool.argsText}</pre>
          </section>

          <section className={styles.detailSection} aria-label={failed ? "工具错误" : "工具结果"}>
            <h3>{resultLabel}</h3>
            {tool.resultText ? (
              <>
                <pre data-kind={failed ? "error" : "result"}>{tool.resultText}</pre>
                <button className={styles.copyButton} type="button" aria-label="复制工具结果" onClick={handleCopyResult}>
                  {copyState === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                  <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制结果"}</span>
                </button>
              </>
            ) : (
              <p className={styles.emptyResult}>{running ? "工具正在执行" : "暂无结果"}</p>
            )}
          </section>
        </div>
      ) : null}
    </article>
  );
}

interface ParsedToolPayload {
  name: string;
  argsText: string;
  resultText: string;
  resultStatus: string | null;
  duration: string;
}

function parseToolPayload(message: ConversationMessage): ParsedToolPayload {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const args = call?.arguments ?? message.payload.arguments ?? {};
  return {
    name: stringValue(call?.name) || message.content || "未知工具",
    argsText: stringify(args),
    resultText: resultText(result, message.payload),
    resultStatus: stringValue(result?.status),
    duration: formatDuration(result?.duration_ms ?? result?.durationMs ?? message.payload.duration_ms ?? message.payload.durationMs),
  };
}

function resultText(result: Record<string, unknown> | null, payload: Record<string, unknown>): string {
  if (!result) {
    return stringValue(payload.result_text) || stringValue(payload.model_content) || "";
  }
  if (typeof result.model_content === "string" && result.model_content.trim()) {
    return result.model_content;
  }
  if (typeof result.text === "string") {
    return result.text;
  }
  if (typeof result.error === "string") {
    return result.error;
  }
  if (result.ui_payload && typeof result.ui_payload === "object") {
    return stringify(result.ui_payload);
  }
  return stringify(result);
}

function statusLabel(status: ConversationMessage["status"], resultStatus: string | null): string {
  if (resultStatus === "error" || status === "failed") {
    return "执行失败";
  }
  switch (status) {
    case "pending":
      return "等待执行";
    case "running":
      return "正在执行";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return "工具调用";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(value: unknown): string {
  const ms = numberValue(value);
  if (ms === null) {
    return "";
  }
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} 秒`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
