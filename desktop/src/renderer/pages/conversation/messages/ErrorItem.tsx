import { Check, ChevronDown, CircleAlert, Copy } from "lucide-react";
import { useMemo, useState } from "react";

import { useCopyFeedback } from "@/renderer/hooks/useCopyFeedback";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import { createErrorDiagnostic, serializeErrorDiagnostic } from "./errorDiagnostics";
import styles from "./ErrorItem.module.css";

export interface ErrorItemProps {
  message: ConversationMessage;
}

export function ErrorItem({ message }: ErrorItemProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { copyState, showCopyFeedback } = useCopyFeedback();
  const diagnostic = useMemo(
    () =>
      createErrorDiagnostic(message.payload, {
        fallbackMessage: message.content || "运行时错误",
        context: {
          thread_id: message.threadId,
          ...(message.turnId ? { turn_id: message.turnId } : {}),
          ...(message.itemId ? { item_id: message.itemId } : {}),
        },
      }),
    [message],
  );
  const { error } = diagnostic;
  const detailsText = stringify(error.details);
  const hasDetails = detailsText !== "{}";

  const handleCopy = async () => {
    try {
      await copyText(serializeErrorDiagnostic(diagnostic));
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
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
              aria-label={detailsOpen ? "收起错误详情" : "展开错误详情"}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              <ChevronDown size={14} data-expanded={detailsOpen ? "true" : "false"} />
              <span>错误详情</span>
            </button>
          ) : null}
          <button
            className={styles.actionButton}
            type="button"
            aria-label="复制错误"
            data-tooltip-label="复制错误"
            onClick={handleCopy}
          >
            {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
            <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制错误"}</span>
          </button>
        </div>
      </header>

      {detailsOpen ? <pre className={styles.details}>{detailsText}</pre> : null}
    </article>
  );
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
