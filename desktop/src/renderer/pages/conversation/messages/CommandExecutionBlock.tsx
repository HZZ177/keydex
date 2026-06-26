import { Check, ChevronDown, Clipboard, LoaderCircle, SquareTerminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { formatErrorText, readableErrorText } from "./errorText";
import { copyText } from "./markdown";
import styles from "./CommandExecutionBlock.module.css";
import { useLazyToolDetails, type ToolDetailsLoader } from "./useLazyToolDetails";
import { useDeferredUnmount } from "./useDeferredUnmount";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";

const TITLE_INPUT_MAX_CHARS = 96;
const INLINE_ERROR_MAX_CHARS = 240;

export interface CommandExecutionBlockProps {
  message: ConversationMessage;
  onLoadDetails?: ToolDetailsLoader;
}

type CopyTarget = "input" | "output";
type CopyStatus = "idle" | "copied" | "failed";

export function CommandExecutionBlock({ message, onLoadDetails }: CommandExecutionBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<{ target: CopyTarget; status: Exclude<CopyStatus, "idle"> } | null>(null);
  const details = useLazyToolDetails(message, onLoadDetails);
  const command = useMemo(() => parseCommandPayload(details.message), [details.message]);
  const running = details.message.status === "pending" || details.message.status === "running";
  const rejected = command.status === "rejected";
  const failed = details.message.status === "failed" || command.status === "timed_out" || command.status === "disabled";
  const negative = rejected || failed;
  const statusKind = negative ? "failed" : running ? "running" : "done";
  const combinedOutput = [command.stdout, command.stderr].filter(Boolean).join(command.stdout && command.stderr ? "\n" : "");
  const outputMotion = useDeferredUnmount<HTMLElement>(detailsOpen);
  const captureExpansionAnchor = useExpansionScrollAnchor();

  const handleCopy = async (target: CopyTarget, text: string) => {
    try {
      await copyText(text);
      setCopyState({ target, status: "copied" });
    } catch {
      setCopyState({ target, status: "failed" });
    }
  };
  const inputCopyStatus = copyStatus(copyState, "input");
  const outputCopyStatus = copyStatus(copyState, "output");

  return (
    <article
      className={styles.block}
      data-collapsed={detailsOpen ? "false" : "true"}
      data-status={negative ? "failed" : details.message.status}
      data-testid="command-execution-block"
    >
      <button
        className={styles.header}
        type="button"
        aria-expanded={detailsOpen}
        aria-label={detailsOpen ? "收起命令详情" : "展开命令详情"}
        onClick={(event) => {
          captureExpansionAnchor(event.currentTarget);
          setDetailsOpen((open) => {
            if (!open) {
              void details.load();
            }
            return !open;
          });
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {negative ? <XCircle size={16} /> : running ? <LoaderCircle size={16} /> : <SquareTerminal size={16} />}
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
            {command.statusLabel ? <span>{command.statusLabel}</span> : null}
            {command.truncated ? <span>输出已截断</span> : null}
            {command.trustedRuleId ? <span>已信任规则</span> : null}
          </div>
        </div>
        <ChevronDown className={styles.chevron} size={14} />
      </button>

      {rejected && command.rejectMessage ? (
        <p className={styles.rejectMessage}>拒绝说明：{command.rejectMessage}</p>
      ) : command.errorPreview ? (
        <p className={styles.rejectMessage}>错误信息：{command.errorPreview}</p>
      ) : null}

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
              <div className={styles.sectionHeader} data-kind="input">
                <div className={styles.outputHeader}>入参</div>
                <button
                  className={styles.copyButton}
                  type="button"
                  aria-label={copyAriaLabel("入参", inputCopyStatus)}
                  title={copyAriaLabel("入参", inputCopyStatus)}
                  onClick={() => void handleCopy("input", command.inputText)}
                  disabled={details.loading}
                >
                  {inputCopyStatus === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                </button>
              </div>
              <div className={styles.codeViewport}>
                <pre data-stream="input">{details.loading ? "正在加载命令详情" : command.inputText}</pre>
              </div>
            </section>
            <section className={styles.detailSection} aria-label="命令输出">
              <div className={styles.sectionHeader} data-kind="output">
                <div className={styles.outputHeader}>输出</div>
                <button
                  className={styles.copyButton}
                  type="button"
                  aria-label={copyAriaLabel("输出", outputCopyStatus)}
                  title={copyAriaLabel("输出", outputCopyStatus)}
                  onClick={() => void handleCopy("output", combinedOutput)}
                  disabled={!combinedOutput || details.loading}
                >
                  {outputCopyStatus === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                </button>
              </div>
              {details.loading ? (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyOutput}>正在加载命令详情</p>
                </div>
              ) : details.error ? (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyOutput}>命令详情加载失败</p>
                </div>
              ) : combinedOutput ? (
                <div className={styles.codeViewport}>
                  {command.stdout ? <pre data-stream="stdout">{command.stdout}</pre> : null}
                  {command.stderr ? <pre data-stream="stderr">{command.stderr}</pre> : null}
                </div>
              ) : (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyOutput}>{running ? "等待命令输出" : "无输出"}</p>
                </div>
              )}
            </section>
          </div>
        </section>
      ) : null}
    </article>
  );
}

function copyStatus(
  state: { target: CopyTarget; status: Exclude<CopyStatus, "idle"> } | null,
  target: CopyTarget,
): CopyStatus {
  return state?.target === target ? state.status : "idle";
}

function copyAriaLabel(label: "入参" | "输出", status: CopyStatus): string {
  if (status === "copied") {
    return `已复制${label}`;
  }
  if (status === "failed") {
    return `复制${label}失败`;
  }
  return `复制${label}`;
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
  status: string;
  statusLabel: string;
  truncated: boolean;
  trustedRuleId: string;
  rejectMessage: string;
  errorPreview: string;
}

function parseCommandPayload(message: ConversationMessage): ParsedCommandPayload {
  const result = asRecord(message.payload.result);
  const resultUiPayload = asRecord(result?.ui_payload);
  const merged = { ...message.payload, ...(resultUiPayload ?? {}) };
  const input = commandInput(merged);
  const command = stringValue(merged.command) || stringValue(input.command);
  const exitCode = numberValue(merged.exit_code ?? merged.exitCode);
  const status = stringValue(merged.status) || String(message.status ?? "");
  const approval = asRecord(merged.approval);
  const stdout = stringValue(merged.stdout) || (message.content && !stringValue(merged.stderr) ? message.content : "");
  const stderr = stringValue(merged.stderr) || fallbackErrorText(message, result, merged);
  const errorPreview = commandErrorPreview(message, status, exitCode, stderr);
  return {
    command,
    inputText: stringifyInput(input),
    title: commandTitleFromInput(inputTitle(input, command), message.status, status),
    cwd: stringValue(merged.cwd),
    stdout,
    stderr,
    exitCode,
    duration: formatDuration(merged.duration_ms ?? merged.durationMs),
    status,
    statusLabel: commandStatusLabel(status),
    truncated: Boolean(merged.truncated),
    trustedRuleId: stringValue(approval?.trusted_rule_id),
    rejectMessage: stringValue(approval?.reject_message),
    errorPreview,
  };
}

function commandErrorPreview(
  message: ConversationMessage,
  commandStatus: string,
  exitCode: number | null,
  stderr: string,
): string {
  if (!stderr.trim()) {
    return "";
  }
  const failed =
    message.status === "failed" ||
    commandStatus === "failed" ||
    commandStatus === "error" ||
    commandStatus === "timed_out" ||
    commandStatus === "disabled" ||
    (exitCode !== null && exitCode !== 0);
  return failed ? truncateInlineError(stderr) : "";
}

function fallbackErrorText(
  message: ConversationMessage,
  result: Record<string, unknown> | null,
  merged: Record<string, unknown>,
): string {
  if (message.status !== "failed") {
    return "";
  }
  return firstText([
    formatErrorText(merged),
    formatErrorText(merged.error),
    formatErrorText(result?.error),
    formatErrorText(message.payload.error),
    readableErrorText(stringValue(result?.model_content)),
    readableErrorText(stringValue(message.payload.model_content)),
    readableErrorText(stringValue(message.payload.result_text)),
    readableErrorText(stringValue(message.payload.result)),
  ]);
}

function commandInput(payload: Record<string, unknown>): Record<string, unknown> {
  const call = asRecord(payload.call);
  const summary = asRecord(payload.toolSummary);
  const args = asRecord(call?.arguments) ?? asRecord(payload.arguments) ?? asRecord(payload.params) ?? {};
  return {
    ...(summary ?? {}),
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
  commandStatus: string,
): string {
  if (commandStatus === "rejected") {
    return `已拒绝 ${input}`;
  }
  if (commandStatus === "timed_out") {
    return `命令超时 ${input}`;
  }
  if (commandStatus === "disabled") {
    return `命令已禁用 ${input}`;
  }
  if (commandStatus === "failed" || commandStatus === "error") {
    return `执行失败 ${input}`;
  }
  if (status === "failed") {
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

function commandStatusLabel(status: string): string {
  switch (status) {
    case "rejected":
      return "已拒绝";
    case "timed_out":
      return "已超时";
    case "disabled":
      return "已禁用";
    case "failed":
    case "error":
      return "执行失败";
    default:
      return "";
  }
}

function truncateInlineError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= INLINE_ERROR_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, INLINE_ERROR_MAX_CHARS - 1)}…`;
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

function firstText(values: string[]): string {
  return values.find((value) => value.trim()) ?? "";
}
