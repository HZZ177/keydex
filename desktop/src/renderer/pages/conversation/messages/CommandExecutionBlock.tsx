import { Check, ChevronDown, Clipboard, LoaderCircle, Terminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import styles from "./CommandExecutionBlock.module.css";

export interface CommandExecutionBlockProps {
  message: ConversationMessage;
}

export function CommandExecutionBlock({ message }: CommandExecutionBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const command = useMemo(() => parseCommandPayload(message), [message]);
  const running = message.status === "pending" || message.status === "running";
  const failed = message.status === "failed" || (typeof command.exitCode === "number" && command.exitCode !== 0);
  const statusKind = failed ? "failed" : running ? "running" : "done";
  const combinedOutput = [command.stdout, command.stderr].filter(Boolean).join(command.stdout && command.stderr ? "\n" : "");

  const handleCopy = async () => {
    try {
      await copyText(combinedOutput || command.command);
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
      data-testid="command-execution-block"
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {failed ? <XCircle size={16} /> : running ? <LoaderCircle size={16} /> : <Terminal size={16} />}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.command}>{command.command || "命令执行"}</div>
          <div className={styles.meta}>
            {command.cwd ? <span>{command.cwd}</span> : null}
            {typeof command.exitCode === "number" ? <span>退出码 {command.exitCode}</span> : null}
            {command.duration ? <span>{command.duration}</span> : null}
            <span className={styles.statusMeta}>
              <span className={styles.statusDot} data-state={statusKind} />
              <span>{statusLabel(message.status, command.exitCode)}</span>
            </span>
          </div>
        </div>
        <button
          className={styles.detailsToggle}
          type="button"
          aria-expanded={detailsOpen}
          aria-label={detailsOpen ? "收起命令详情" : "展开命令详情"}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <ChevronDown size={14} />
          <span>{detailsOpen ? "收起" : "详情"}</span>
        </button>
      </header>

      {detailsOpen ? (
        combinedOutput ? (
          <section className={styles.output} aria-label="命令输出">
            {command.stdout ? <pre data-stream="stdout">{command.stdout}</pre> : null}
            {command.stderr ? <pre data-stream="stderr">{command.stderr}</pre> : null}
            <button className={styles.copyButton} type="button" aria-label="复制命令输出" onClick={handleCopy}>
              {copyState === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
              <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制输出"}</span>
            </button>
          </section>
        ) : (
          <p className={styles.emptyOutput}>{running ? "等待命令输出" : "无输出"}</p>
        )
      ) : null}
    </article>
  );
}

interface ParsedCommandPayload {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: string;
}

function parseCommandPayload(message: ConversationMessage): ParsedCommandPayload {
  const result = asRecord(message.payload.result);
  const merged = { ...message.payload, ...(result?.ui_payload && typeof result.ui_payload === "object" ? result.ui_payload : {}) };
  return {
    command: stringValue(merged.command),
    cwd: stringValue(merged.cwd),
    stdout: stringValue(merged.stdout) || (message.content && !stringValue(merged.stderr) ? message.content : ""),
    stderr: stringValue(merged.stderr),
    exitCode: numberValue(merged.exit_code ?? merged.exitCode),
    duration: formatDuration(merged.duration_ms ?? merged.durationMs),
  };
}

function statusLabel(status: ConversationMessage["status"], exitCode: number | null): string {
  if (status === "failed" || (typeof exitCode === "number" && exitCode !== 0)) {
    return "执行失败";
  }
  if (status === "running" || status === "pending") {
    return "正在执行";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  return "已完成";
}

function formatDuration(value: unknown): string {
  const ms = numberValue(value);
  if (ms === null) {
    return "";
  }
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} 秒`;
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
