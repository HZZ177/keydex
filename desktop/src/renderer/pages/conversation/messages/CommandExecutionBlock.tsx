import { Check, ChevronDown, Clipboard, LoaderCircle, SquareTerminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import styles from "./CommandExecutionBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

const TITLE_INPUT_MAX_CHARS = 96;

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
      await copyText(combinedOutput || command.inputText || command.command);
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
          {failed ? <XCircle size={16} /> : running ? <LoaderCircle size={16} /> : <SquareTerminal size={16} />}
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
            <section className={styles.detailSection} aria-label="命令入参">
              <div className={styles.outputHeader}>Input</div>
              <pre data-stream="input">{command.inputText}</pre>
            </section>
            <section className={styles.detailSection} aria-label="命令输出">
              <div className={styles.outputHeader}>Output</div>
            {combinedOutput ? (
              <>
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
            </section>
          </div>
        </section>
      ) : null}
    </article>
  );
}

interface ParsedCommandPayload {
  command: string;
  inputText: string;
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
  const input = commandInput(merged);
  const command = stringValue(merged.command) || stringValue(input.command);
  const exitCode = numberValue(merged.exit_code ?? merged.exitCode);
  return {
    command,
    inputText: stringifyInput(input),
    title: commandTitleFromInput(inputTitle(input, command), message.status, exitCode),
    cwd: stringValue(merged.cwd),
    stdout: stringValue(merged.stdout) || (message.content && !stringValue(merged.stderr) ? message.content : ""),
    stderr: stringValue(merged.stderr),
    exitCode,
    duration: formatDuration(merged.duration_ms ?? merged.durationMs),
  };
}

function commandInput(payload: Record<string, unknown>): Record<string, unknown> {
  const call = asRecord(payload.call);
  const args = asRecord(call?.arguments) ?? asRecord(payload.arguments) ?? asRecord(payload.params) ?? {};
  return {
    ...args,
    ...(stringValue(payload.command) ? { command: stringValue(payload.command) } : {}),
    ...(stringValue(payload.cwd) ? { cwd: stringValue(payload.cwd) } : {}),
    ...(payload.timeout_seconds !== undefined ? { timeout_seconds: payload.timeout_seconds } : {}),
    ...(payload.timeoutSeconds !== undefined ? { timeoutSeconds: payload.timeoutSeconds } : {}),
  };
}

function stringifyInput(value: Record<string, unknown>): string {
  if (!Object.keys(value).length) {
    return "{}";
  }
  return JSON.stringify(value, null, 2);
}

function inputTitle(input: Record<string, unknown>, command: string): string {
  const summary = command || stringifyCompactInput(input);
  return truncateTitle(summary || "命令执行");
}

function stringifyCompactInput(value: Record<string, unknown>): string {
  if (!Object.keys(value).length) {
    return "";
  }
  return JSON.stringify(value);
}

function truncateTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= TITLE_INPUT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, TITLE_INPUT_MAX_CHARS - 1)}…`;
}

function commandTitleFromInput(
  input: string,
  status: ConversationMessage["status"],
  exitCode: number | null,
): string {
  if (status === "failed" || (typeof exitCode === "number" && exitCode !== 0)) {
    return `执行失败 ${input}`;
  }
  if (status === "running" || status === "pending") {
    return `正在执行 ${input}`;
  }
  if (status === "cancelled") {
    return `已取消 ${input}`;
  }
  return `已执行 ${input}`;
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
