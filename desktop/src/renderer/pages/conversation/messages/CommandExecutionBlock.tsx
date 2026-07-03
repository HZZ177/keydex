import { Check, ChevronDown, Clipboard, LoaderCircle, Square, SquareTerminal, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  onTerminateCommand?: (commandId: string) => Promise<void> | void;
}

type CopyTarget = "input" | "output";
type CopyStatus = "idle" | "copied" | "failed";

export function CommandExecutionBlock({
  message,
  onLoadDetails,
  onTerminateCommand,
}: CommandExecutionBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [terminatingCommandId, setTerminatingCommandId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ target: CopyTarget; status: Exclude<CopyStatus, "idle"> } | null>(null);
  const details = useLazyToolDetails(message, onLoadDetails);
  const command = useMemo(() => parseCommandPayload(details.message), [details.message]);
  const running = isRunningCommand(command, details.message.status);
  const pendingApproval = command.status === "approval_pending";
  const rejected = command.status === "rejected";
  const failed = isFailedCommand(command);
  const negative = rejected || failed;
  const statusKind = negative ? "failed" : pendingApproval ? "pending" : running ? "running" : "done";
  const footerState = details.error ? "failed" : details.loading ? "running" : statusKind;
  const footerLabel = details.loading
    ? "加载中"
    : details.error
      ? "加载失败"
      : commandFooterLabel(command, running, negative);
  const outputText = command.outputText;
  const outputMotion = useDeferredUnmount<HTMLElement>(detailsOpen);
  const captureExpansionAnchor = useExpansionScrollAnchor();
  const canTerminate = running && command.canTerminate && Boolean(command.commandId) && Boolean(onTerminateCommand);
  const terminating = terminatingCommandId === command.commandId;

  useEffect(() => {
    if (!terminatingCommandId) {
      return;
    }
    if (terminatingCommandId !== command.commandId || !running || !command.canTerminate) {
      setTerminatingCommandId(null);
    }
  }, [command.canTerminate, command.commandId, running, terminatingCommandId]);

  const handleCopy = async (target: CopyTarget, text: string) => {
    try {
      await copyText(text);
      setCopyState({ target, status: "copied" });
    } catch {
      setCopyState({ target, status: "failed" });
    }
  };

  const handleTerminate = async () => {
    if (!canTerminate || terminating) {
      return;
    }
    setTerminatingCommandId(command.commandId);
    try {
      await onTerminateCommand?.(command.commandId);
    } catch {
      setTerminatingCommandId(null);
    }
  };

  const inputCopyStatus = copyStatus(copyState, "input");
  const outputCopyStatus = copyStatus(copyState, "output");

  return (
    <article
      className={styles.block}
      data-collapsed={detailsOpen ? "false" : "true"}
      data-status={statusKind}
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
        <span className={styles.leadingIcon} aria-hidden="true">
          <span className={styles.icon}>
            {negative ? <XCircle size={16} /> : running ? <LoaderCircle size={16} /> : <SquareTerminal size={16} />}
          </span>
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.command}>{command.title}</div>
          <div className={styles.meta}>
            <span className={styles.statusMeta} aria-hidden="true">
              <span className={styles.statusDot} data-state={statusKind} />
            </span>
            {command.shellLabel ? <span>{command.shellLabel}</span> : null}
            {command.duration ? <span>{command.duration}</span> : null}
            {command.cwd ? <span>{command.cwd}</span> : null}
            {typeof command.exitCode === "number" ? <span>退出码 {command.exitCode}</span> : null}
            {command.statusLabel ? <span>{command.statusLabel}</span> : null}
            {command.outputTruncated ? <span>输出已截断</span> : null}
            {command.approvalLabel ? <span>{command.approvalLabel}</span> : null}
          </div>
        </div>
        <span className={styles.trailingIcon} aria-hidden="true">
          <ChevronDown className={styles.chevron} size={14} />
        </span>
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
              <div className={styles.toolNameRow}>
                <div className={styles.toolNameMain}>
                  <span className={styles.toolNameLabel}>工具</span>
                  <code className={styles.toolNameValue}>{command.name}</code>
                </div>
              </div>
              <div className={styles.sectionHeader} data-kind="input">
                <div className={styles.outputHeader}>入参</div>
                <div className={styles.sectionHeaderActions}>
                  {canTerminate ? (
                    <button
                      className={styles.terminateIconButton}
                      type="button"
                      disabled={terminating}
                      aria-label={terminating ? "正在终止命令" : "终止命令"}
                      data-tooltip-label={terminating ? "正在终止命令" : "终止命令"}
                      data-terminating={terminating ? "true" : undefined}
                      title={terminating ? "正在终止命令" : "终止命令"}
                      onClick={() => void handleTerminate()}
                    >
                      <Square size={12} fill="currentColor" strokeWidth={0} />
                    </button>
                  ) : null}
                  <button
                    className={styles.copyButton}
                    type="button"
                    aria-label={copyAriaLabel("入参", inputCopyStatus)}
                    data-tooltip-label={copyAriaLabel("入参", inputCopyStatus)}
                    title={copyAriaLabel("入参", inputCopyStatus)}
                    onClick={() => void handleCopy("input", command.inputText)}
                    disabled={details.loading}
                  >
                    {inputCopyStatus === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                  </button>
                </div>
              </div>
              <div className={styles.codeViewport}>
                <pre data-stream="input">{details.loading ? "正在加载命令详情" : command.inputText}</pre>
              </div>
            </section>
            <section className={styles.detailSection} aria-label="命令输出">
              <div className={styles.sectionHeader} data-kind="output">
                <div className={styles.outputHeader}>{running ? "实时输出" : "输出"}</div>
                <button
                  className={styles.copyButton}
                  type="button"
                  aria-label={copyAriaLabel("输出", outputCopyStatus)}
                  data-tooltip-label={copyAriaLabel("输出", outputCopyStatus)}
                  title={copyAriaLabel("输出", outputCopyStatus)}
                  onClick={() => void handleCopy("output", outputText)}
                  disabled={!outputText || details.loading}
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
              ) : outputText ? (
                <div className={styles.codeViewport}>
                  {command.stdout ? <pre data-stream="stdout">{command.stdout}</pre> : null}
                  {command.stderr ? <pre data-stream="stderr">{command.stderr}</pre> : null}
                  {!command.stdout && !command.stderr ? <pre data-stream="stdout">{command.combinedTail}</pre> : null}
                </div>
              ) : (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyOutput}>{running ? "等待命令输出" : "无输出"}</p>
                </div>
              )}
              <div className={styles.panelFooter} data-state={footerState}>
                {footerLabel}
              </div>
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
  name: string;
  commandId: string;
  command: string;
  inputText: string;
  title: string;
  cwd: string;
  shellLabel: string;
  stdout: string;
  stderr: string;
  combinedTail: string;
  outputText: string;
  exitCode: number | null;
  duration: string;
  status: string;
  statusLabel: string;
  outputTruncated: boolean;
  outputLimitExceeded: boolean;
  canTerminate: boolean;
  approvalLabel: string;
  rejectMessage: string;
  errorPreview: string;
}

function parseCommandPayload(message: ConversationMessage): ParsedCommandPayload {
  const result = asRecord(message.payload.result);
  const resultUiPayload = asRecord(result?.ui_payload);
  const directUiPayload = asRecord(message.payload.ui_payload) ?? asRecord(message.payload.uiPayload);
  const merged = {
    ...message.payload,
    ...(directUiPayload ?? {}),
    ...(resultUiPayload ?? {}),
  };
  const call = asRecord(merged.call);
  const input = commandInput(merged);
  const command = stringValue(merged.command) || stringValue(input.command);
  const name = stringValue(call?.name) || stringValue(merged.tool) || stringValue(merged.tool_name) || "command";
  const exitCode = numberValue(merged.exit_code ?? merged.exitCode);
  const status = commandStatus(merged, message.status);
  const approval = asRecord(merged.approval);
  const stdout = stringValue(merged.stdout);
  const stderr = stringValue(merged.stderr) || fallbackErrorText(message, result, merged);
  const combinedTail =
    stringValue(merged.combined_tail) ||
    [stringValue(merged.stdout_tail), stringValue(merged.stderr_tail)].filter(Boolean).join("\n");
  const outputText = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "") || combinedTail;
  const errorPreview = commandErrorPreview(message, status, exitCode, stderr);
  return {
    name,
    commandId: stringValue(merged.command_id),
    command,
    inputText: commandDisplayInput(input, command),
    title: commandTitleFromInput(inputTitle(input, command), message.status, status),
    cwd: stringValue(merged.cwd),
    shellLabel: stringValue(merged.shell_label) || shellLabel(stringValue(merged.shell)),
    stdout,
    stderr,
    combinedTail,
    outputText,
    exitCode,
    duration: formatDuration(merged.duration_ms ?? merged.durationMs),
    status,
    statusLabel: commandStatusLabel(status),
    outputTruncated: Boolean(merged.output_truncated ?? merged.outputTruncated),
    outputLimitExceeded: Boolean(merged.output_limit_exceeded ?? merged.outputLimitExceeded),
    canTerminate: Boolean(merged.can_terminate),
    approvalLabel: approvalLabel(approval),
    rejectMessage: stringValue(approval?.reject_message),
    errorPreview,
  };
}

function commandStatus(payload: Record<string, unknown>, messageStatus: ConversationMessage["status"]): string {
  const status = stringValue(payload.status);
  if (status) {
    return status;
  }
  if (messageStatus === "running" || messageStatus === "pending") {
    return "running";
  }
  if (messageStatus === "cancelled") {
    return "cancelled";
  }
  if (messageStatus === "failed") {
    return "failed_to_start";
  }
  return "completed";
}

function isRunningCommand(command: ParsedCommandPayload, messageStatus: ConversationMessage["status"]): boolean {
  if (command.status === "approval_pending") {
    return false;
  }
  if (command.status === "running" || command.status === "terminating") {
    return true;
  }
  if (isTerminalCommandStatus(command.status)) {
    return false;
  }
  return messageStatus === "pending" || messageStatus === "running";
}

function isTerminalCommandStatus(status: string): boolean {
  return [
    "completed",
    "timed_out",
    "cancelled",
    "failed_to_start",
    "shell_not_available",
    "output_limit_exceeded",
    "rejected",
  ].includes(status);
}

function isFailedCommand(command: ParsedCommandPayload): boolean {
  return (
    command.status === "timed_out" ||
    command.status === "failed_to_start" ||
    command.status === "shell_not_available" ||
    command.status === "output_limit_exceeded" ||
    command.status === "cancelled" ||
    command.outputLimitExceeded ||
    (typeof command.exitCode === "number" && command.exitCode !== 0)
  );
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
    commandStatus === "failed_to_start" ||
    commandStatus === "shell_not_available" ||
    commandStatus === "output_limit_exceeded" ||
    commandStatus === "timed_out" ||
    commandStatus === "rejected" ||
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
  const args = asRecord(call?.arguments) ?? asRecord(payload.arguments) ?? asRecord(payload.params) ?? {};
  return {
    ...args,
    ...(stringValue(payload.command) ? { command: stringValue(payload.command) } : {}),
    ...(stringValue(payload.description) ? { description: stringValue(payload.description) } : {}),
    ...(stringValue(payload.cwd) ? { cwd: stringValue(payload.cwd) } : {}),
    ...(payload.timeout_seconds !== undefined ? { timeout_seconds: payload.timeout_seconds } : {}),
    ...(payload.timeoutSeconds !== undefined ? { timeoutSeconds: payload.timeoutSeconds } : {}),
  };
}

function commandDisplayInput(input: Record<string, unknown>, command: string): string {
  const description = stringValue(input.description);
  const commandText = command || stringValue(input.command);
  return [description, commandText].filter(Boolean).join("\n");
}

function inputTitle(input: Record<string, unknown>, command: string): string {
  const description = stringValue(input.description);
  const summary = description || command || stringifyCompactInput(input);
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
  return `${normalized.slice(0, TITLE_INPUT_MAX_CHARS - 1)}...`;
}

function commandTitleFromInput(
  input: string,
  status: ConversationMessage["status"],
  commandStatus: string,
): string {
  if (commandStatus === "approval_pending") {
    return `等待审批 ${input}`;
  }
  if (commandStatus === "rejected") {
    return `审批拒绝 ${input}`;
  }
  if (commandStatus === "timed_out") {
    return `命令超时 ${input}`;
  }
  if (commandStatus === "shell_not_available") {
    return `环境不可用 ${input}`;
  }
  if (commandStatus === "output_limit_exceeded") {
    return `输出超限 ${input}`;
  }
  if (commandStatus === "failed_to_start" || commandStatus === "failed" || commandStatus === "error") {
    return `启动失败 ${input}`;
  }
  if (commandStatus === "cancelled" || status === "cancelled") {
    return `已终止 ${input}`;
  }
  if (commandStatus === "terminating") {
    return `正在终止 ${input}`;
  }
  if (status === "running" || status === "pending" || commandStatus === "running") {
    return `正在执行 ${input}`;
  }
  return `已执行 ${input}`;
}

function commandStatusLabel(status: string): string {
  switch (status) {
    case "approval_pending":
      return "等待审批";
    case "rejected":
      return "审批拒绝";
    case "timed_out":
      return "已超时";
    case "cancelled":
      return "已终止";
    case "terminating":
      return "正在终止";
    case "failed_to_start":
      return "启动失败";
    case "shell_not_available":
      return "环境不可用";
    case "output_limit_exceeded":
      return "输出超限";
    case "failed":
    case "error":
      return "执行失败";
    default:
      return "";
  }
}

function commandFooterLabel(
  command: ParsedCommandPayload,
  running: boolean,
  negative: boolean,
): string {
  if (command.status === "terminating") {
    return "正在终止";
  }
  if (running) {
    return "运行中";
  }
  if (command.statusLabel) {
    return command.statusLabel;
  }
  if (negative) {
    return "失败";
  }
  if (typeof command.exitCode === "number" && command.exitCode !== 0) {
    return `退出码 ${command.exitCode}`;
  }
  return "成功";
}

function approvalLabel(approval: Record<string, unknown> | null): string {
  if (!approval) {
    return "";
  }
  if (stringValue(approval.status) === "pending") {
    return "";
  }
  if (approval.trusted === true || stringValue(approval.trusted_rule_id)) {
    return "已信任";
  }
  if (stringValue(approval.decision) === "rejected" || stringValue(approval.status) === "rejected") {
    return "审批拒绝";
  }
  if (approval.required === true) {
    return "已审批";
  }
  return "";
}

function shellLabel(shell: string): string {
  switch (shell) {
    case "cmd":
      return "CMD";
    case "powershell":
      return "PowerShell";
    case "git_bash":
      return "Git Bash";
    default:
      return "";
  }
}

function truncateInlineError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= INLINE_ERROR_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, INLINE_ERROR_MAX_CHARS - 1)}...`;
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
