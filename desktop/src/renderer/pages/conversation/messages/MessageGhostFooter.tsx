import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { copyText } from "./markdown";
import styles from "./MessageGhostFooter.module.css";

export interface MessageGhostFooterData {
  traceId?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  duration?: string;
}

export interface MessageGhostFooterProps {
  footer: MessageGhostFooterData | null;
}

export function MessageGhostFooter({ footer }: MessageGhostFooterProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  if (!footer || !hasVisibleFooterData(footer)) {
    return null;
  }

  const tokenParts = tokenSummary(footer);
  const copyTrace = async () => {
    if (!footer.traceId) {
      return;
    }
    try {
      await copyText(footer.traceId);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <footer className={styles.footer} aria-label="轻量 trace 信息" data-testid="message-ghost-footer">
      {footer.traceId ? (
        <button
          className={styles.traceButton}
          type="button"
          aria-label={`复制 trace_id ${footer.traceId}`}
          data-copy-state={copyState}
          onClick={copyTrace}
        >
          {copyState === "copied" ? <Check size={12} /> : <Copy size={12} />}
          <span>追踪</span>
          <code>{footer.traceId}</code>
        </button>
      ) : null}
      {tokenParts.length ? <span className={styles.meta}>令牌 {tokenParts.join(" / ")}</span> : null}
      {footer.duration ? <span className={styles.meta}>耗时 {footer.duration}</span> : null}
      {copyState === "failed" ? <span className={styles.copyError}>复制失败</span> : null}
    </footer>
  );
}

function hasVisibleFooterData(footer: MessageGhostFooterData): boolean {
  return Boolean(footer.traceId || footer.duration || tokenSummary(footer).length);
}

function tokenSummary(footer: MessageGhostFooterData): string[] {
  return [
    formatTokenPart("输入", footer.inputTokens),
    formatTokenPart("缓存", footer.cacheReadTokens),
    formatTokenPart("输出", footer.outputTokens),
  ].filter((part): part is string => Boolean(part));
}

function formatTokenPart(label: string, value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return `${label} ${value}`;
}
