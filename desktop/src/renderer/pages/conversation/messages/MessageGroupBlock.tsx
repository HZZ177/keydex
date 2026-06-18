import { ChevronDown, FileDiff, Wrench } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type { MessageGroupKind } from "./processMessages";
import styles from "./MessageGroupBlock.module.css";

export interface MessageGroupBlockProps {
  groupKind: MessageGroupKind;
  count: number;
  messages?: ConversationMessage[];
  sourceMessageIds: string[];
  children: ReactNode;
}

export function MessageGroupBlock({ groupKind, count, messages = [], sourceMessageIds, children }: MessageGroupBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const label = groupLabel(groupKind, count);
  const sourceText = useMemo(() => sourceMessageIds.join(", "), [sourceMessageIds]);
  const summaries = useMemo(() => messages.map((message) => summarizeMessage(message)), [messages]);

  return (
    <article className={styles.block} data-testid="message-group-block" data-kind={groupKind}>
      <button
        className={styles.header}
        type="button"
        aria-expanded={expanded}
        aria-label={`${label}详情`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.icon} aria-hidden="true">
          {groupKind === "file_changes" ? <FileDiff size={16} /> : <Wrench size={16} />}
        </span>
        <span className={styles.title}>{label}</span>
        <span className={styles.source} title={sourceText}>
          {count} 条来源
        </span>
        <ChevronDown size={14} data-expanded={expanded ? "true" : "false"} />
      </button>

      {summaries.length ? (
        <div className={styles.summaryList} aria-label="步骤摘要">
          {summaries.map((summary) => (
            <div className={styles.summaryItem} data-state={summary.state} key={summary.id}>
              <span className={styles.statusDot} data-state={summary.state} />
              <span className={styles.summaryTitle}>{summary.title}</span>
              {summary.detail ? <span className={styles.summaryDetail}>{summary.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {expanded ? <div className={styles.children}>{children}</div> : null}
    </article>
  );
}

function groupLabel(kind: MessageGroupKind, count: number): string {
  if (kind === "file_changes") {
    return `${count} 个文件变更`;
  }
  return `${count} 个工具步骤`;
}

interface GroupSummary {
  id: string;
  title: string;
  detail: string;
  state: "done" | "running" | "failed" | "pending";
}

function summarizeMessage(message: ConversationMessage): GroupSummary {
  if (message.kind === "command") {
    return summarizeCommand(message);
  }
  if (message.kind === "file_change") {
    return summarizeFileChange(message);
  }
  return summarizeTool(message);
}

function summarizeTool(message: ConversationMessage): GroupSummary {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const name = stringValue(call?.name) || message.content || "工具调用";
  const resultText = compactText(resultTextFromPayload(result, message.payload));
  return {
    id: message.id,
    title: name,
    detail: resultText || statusLabel(message),
    state: summaryState(message),
  };
}

function summarizeCommand(message: ConversationMessage): GroupSummary {
  const result = asRecord(message.payload.result);
  const merged = {
    ...message.payload,
    ...(result?.ui_payload && typeof result.ui_payload === "object" ? result.ui_payload : {}),
  };
  const command = stringValue(merged.command) || message.content || "命令执行";
  const output = compactText([stringValue(merged.stdout), stringValue(merged.stderr)].filter(Boolean).join(" "));
  const exitCode = numberValue(merged.exit_code ?? merged.exitCode);
  const failed = message.status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  return {
    id: message.id,
    title: command,
    detail: output || (typeof exitCode === "number" ? `退出码 ${exitCode}` : statusLabel(message)),
    state: failed ? "failed" : summaryState(message),
  };
}

function summarizeFileChange(message: ConversationMessage): GroupSummary {
  const path = stringValue(message.payload.path) || message.content || "文件变更";
  const additions = numberValue(message.payload.additions);
  const deletions = numberValue(message.payload.deletions);
  const changes = [
    typeof additions === "number" ? `+${additions}` : "",
    typeof deletions === "number" ? `-${deletions}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: message.id,
    title: path,
    detail: changes || statusLabel(message),
    state: summaryState(message),
  };
}

function summaryState(message: ConversationMessage): GroupSummary["state"] {
  if (message.status === "failed") {
    return "failed";
  }
  if (message.status === "running") {
    return "running";
  }
  if (message.status === "pending") {
    return "pending";
  }
  return "done";
}

function statusLabel(message: ConversationMessage): string {
  switch (message.status) {
    case "pending":
      return "等待中";
    case "running":
      return "执行中";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "completed":
      return "已完成";
    default:
      return "";
  }
}

function resultTextFromPayload(result: Record<string, unknown> | null, payload: Record<string, unknown>): string {
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

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
