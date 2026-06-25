import { Check, ChevronDown, CircleAlert, Copy } from "lucide-react";
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
          <CircleAlert size={16} />
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>{error.message}</div>
          <div className={styles.meta}>
            <span>{error.code}</span>
            {error.status ? <span>HTTP {error.status}</span> : null}
          </div>
        </div>
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
      </header>

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
  const gatewayError = parseGatewayError(rawMessage);
  const publicMessage = gatewayPublicMessage(gatewayError) ?? publicErrorMessage(rawMessage);
  const details = asRecord(source.details) ?? {};
  const safeDetails = publicMessage === rawMessage ? details : { ...details, raw_message: rawMessage };
  const sourceCode = stringValue(source.code);
  return {
    code: meaningfulCode(sourceCode, gatewayError?.code),
    message: publicMessage,
    details: safeDetails,
    status: numberValue(source.status) ?? gatewayError?.status,
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

function meaningfulCode(sourceCode: string, parsedCode: string | undefined): string {
  if (parsedCode && (!sourceCode || sourceCode === "runtime_error")) {
    return parsedCode;
  }
  return sourceCode || parsedCode || "runtime_error";
}

interface ParsedGatewayError {
  status?: number;
  code?: string;
  message?: string;
}

function parseGatewayError(value: string): ParsedGatewayError | null {
  const statusMatch = /^Error code:\s*(\d+)/i.exec(value.trim());
  const messageMatch = /['"]message['"]\s*:\s*(['"])(.*?)\1/i.exec(value);
  const codeMatch = /['"]code['"]\s*:\s*(['"])(.*?)\1/i.exec(value);
  if (!statusMatch && !messageMatch && !codeMatch) {
    return null;
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : undefined,
    code: codeMatch?.[2],
    message: messageMatch?.[2],
  };
}

function gatewayPublicMessage(error: ParsedGatewayError | null): string | null {
  if (!error) {
    return null;
  }
  const message = error.message?.trim() ?? "";
  if (error.status === 429 || /rate limit exceeded/i.test(message)) {
    const dimension = /dimension:\s*([a-z0-9_-]+)/i.exec(message)?.[1];
    return dimension ? `请求过于频繁（${dimension} 限流），请稍后再试` : "请求过于频繁，请稍后再试";
  }
  if (message) {
    return message;
  }
  return error.status ? `请求失败：HTTP ${error.status}` : null;
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
