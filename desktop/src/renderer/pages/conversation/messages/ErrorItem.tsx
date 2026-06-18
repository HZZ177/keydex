import { Check, ChevronDown, Copy, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { TurnError } from "@/types/protocol";

import { copyText } from "./markdown";
import styles from "./ErrorItem.module.css";

export interface ErrorItemProps {
  message: ConversationMessage;
}

export function ErrorItem({ message }: ErrorItemProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const error = useMemo(() => parseError(message), [message]);
  const detailsText = stringify(error.details);
  const hasDetails = detailsText !== "{}";

  const handleCopy = async () => {
    try {
      await copyText(stringify(error));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <article className={styles.block} data-testid="error-item">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <XCircle size={16} />
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>{error.message}</div>
          <div className={styles.meta}>
            <span>{error.code}</span>
            {error.status ? <span>HTTP {error.status}</span> : null}
          </div>
        </div>
      </header>

      <div className={styles.actions}>
        {hasDetails ? (
          <button
            className={styles.actionButton}
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            <ChevronDown size={14} data-expanded={detailsOpen ? "true" : "false"} />
            <span>错误详情</span>
          </button>
        ) : null}
        <button className={styles.actionButton} type="button" aria-label="复制错误" onClick={handleCopy}>
          {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
          <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制错误"}</span>
        </button>
      </div>

      {detailsOpen ? <pre className={styles.details}>{detailsText}</pre> : null}
    </article>
  );
}

interface ParsedError extends TurnError {
  status?: number;
}

function parseError(message: ConversationMessage): ParsedError {
  const source = asRecord(message.payload.error) ?? message.payload;
  const rawMessage = stringValue(source.message) || message.content || "运行时错误";
  const publicMessage = publicErrorMessage(rawMessage);
  const details = asRecord(source.details) ?? {};
  const safeDetails = publicMessage === rawMessage ? details : { ...details, raw_message: rawMessage };
  return {
    code: stringValue(source.code) || "runtime_error",
    message: publicMessage,
    details: safeDetails,
    status: numberValue(source.status),
  };
}

function publicErrorMessage(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return "运行时错误";
  }
  if (looksLikeStackTrace(lines)) {
    const firstBusinessLine = lines.find((line) => !isStackTraceLine(line));
    return firstBusinessLine && !isStackTraceLine(firstBusinessLine) ? firstBusinessLine : "运行失败，详细信息已折叠";
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
