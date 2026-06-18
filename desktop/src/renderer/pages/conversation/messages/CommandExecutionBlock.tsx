import { Check, ChevronDown, Clipboard, LoaderCircle, Terminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import styles from "./CommandExecutionBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

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
  const outputMotion = useDeferredUnmount<HTMLElement>(detailsOpen);

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
      <button
        className={styles.header}
        type="button"
        aria-expanded={detailsOpen}
        aria-label={detailsOpen ? "收起命令详情" : "展开命令详情"}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <span className={styles.icon} aria-hidden="true">
          {failed ? <XCircle size={16} /> : running ? <LoaderCircle size={16} /> : <Terminal size={16} />}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.command}>{command.title}</div>
          <div className={styles.meta}>
            <span className={styles.statusMeta} aria-hidden="true">
              <span className={styles.statusDot} data-state={statusKind} />
            </span>
            {command.duration ? <span>{command.duration}</span> : null}
            {command.cwd ? <span>{command.cwd}</span> : null}
            {typeof command.exitCode === "number" ? <span>退出码 {command.exitCode}</span> : null}
          </div>
        </div>
        <ChevronDown className={styles.chevron} size={14} />
      </button>

      {outputMotion.shouldRender ? (
        <section
          className={styles.output}
          data-motion={outputMotion.phase}
          ref={outputMotion.ref}
          style={outputMotion.style}
          aria-hidden={!detailsOpen}
          aria-label="命令输出"
        >
          <div className={styles.outputInner}>
            <div className={styles.outputHeader}>Shell</div>
            {combinedOutput ? (
              <>
                <pre data-stream="command">$ {command.command || "命令执行"}</pre>
                {command.stdout ? <pre data-stream="stdout">{command.stdout}</pre> : null}
                {command.stderr ? <pre data-stream="stderr">{command.stderr}</pre> : null}
                <button className={styles.copyButton} type="button" aria-label="复制命令输出" onClick={handleCopy}>
                  {copyState === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                  <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制输出"}</span>
                </button>
              </>
            ) : (
              <p className={styles.emptyOutput}>{running ? "等待命令输出" : "无输出"}</p>
            )}
          </div>
        </section>
      ) : null}
    </article>
  );
}

interface ParsedCommandPayload {
  command: string;
  title: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: string;
}

function parseCommandPayload(message: ConversationMessage): ParsedCommandPayload {
  const result = asRecord(message.payload.result);
  const merged = { ...message.payload, ...(result?.ui_payload && typeof result.ui_payload === "object" ? result.ui_payload : {}) };
  const command = stringValue(merged.command);
  const exitCode = numberValue(merged.exit_code ?? merged.exitCode);
  return {
    command,
    title: commandTitle(command, message.status, exitCode),
    cwd: stringValue(merged.cwd),
    stdout: stringValue(merged.stdout) || (message.content && !stringValue(merged.stderr) ? message.content : ""),
    stderr: stringValue(merged.stderr),
    exitCode,
    duration: formatDuration(merged.duration_ms ?? merged.durationMs),
  };
}

function commandTitle(command: string, status: ConversationMessage["status"], exitCode: number | null): string {
  if (status === "failed" || (typeof exitCode === "number" && exitCode !== 0)) {
    return command ? `执行命令失败 ${command}` : "执行命令失败";
  }
  if (status === "running" || status === "pending") {
    return command ? `正在执行命令 ${command}` : "正在执行命令";
  }
  if (status === "cancelled") {
    return command ? `已取消命令 ${command}` : "已取消命令";
  }
  return command ? `已执行命令 ${command}` : "已执行命令";
}

function formatDuration(value: unknown): string {
  const ms = numberValue(value);
  if (ms === null) {
    return "";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
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
