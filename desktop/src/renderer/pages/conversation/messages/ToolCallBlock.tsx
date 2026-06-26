import {
  Check,
  ChevronDown,
  Clipboard,
  FilePenLine,
  FileText,
  FileX2,
  FolderOpen,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import styles from "./ToolCallBlock.module.css";
import { useLazyToolDetails, type ToolDetailsLoader } from "./useLazyToolDetails";
import { useDeferredUnmount } from "./useDeferredUnmount";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";

export interface ToolCallBlockProps {
  message: ConversationMessage;
  onLoadDetails?: ToolDetailsLoader;
}

type CopyTarget = "input" | "output";
type CopyStatus = "idle" | "copied" | "failed";

export function ToolCallBlock({ message, onLoadDetails }: ToolCallBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<{ target: CopyTarget; status: Exclude<CopyStatus, "idle"> } | null>(null);
  const details = useLazyToolDetails(message, onLoadDetails);
  const tool = useMemo(() => parseToolPayload(details.message), [details.message]);
  const running = details.message.status === "pending" || details.message.status === "running";
  const failed = details.message.status === "failed" || tool.resultStatus === "error";
  const detailsMotion = useDeferredUnmount<HTMLDivElement>(detailsOpen);
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
      data-status={failed ? "failed" : details.message.status}
      data-testid="tool-call-block"
    >
      <button
        className={styles.header}
        type="button"
        aria-expanded={detailsOpen}
        aria-label={detailsOpen ? "收起工具详情" : "展开工具详情"}
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
          {toolIcon(tool.name, failed)}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>
            {tool.fileTarget && tool.target ? (
              <>
                <span>{tool.actionLabel}</span>
                <span> </span>
                <span className={tool.fileTarget ? styles.fileTarget : undefined}>{tool.target}</span>
              </>
            ) : (
              tool.title
            )}
          </div>
          {tool.duration ? <div className={styles.meta}>{tool.duration}</div> : null}
        </div>
        <ChevronDown className={styles.chevron} size={14} />
      </button>

      {detailsMotion.shouldRender ? (
        <div
          className={styles.details}
          data-motion={detailsMotion.phase}
          ref={detailsMotion.ref}
          style={detailsMotion.style}
          aria-hidden={!detailsOpen}
          aria-label="工具详情"
        >
          <div className={styles.detailsInner}>
            <section className={styles.detailSection} aria-label="工具入参">
              <div className={styles.sectionHeader} data-kind="input">
                <div className={styles.outputHeader}>入参</div>
                <button
                  className={styles.copyButton}
                  type="button"
                  aria-label={copyAriaLabel("入参", inputCopyStatus)}
                  title={copyAriaLabel("入参", inputCopyStatus)}
                  onClick={() => void handleCopy("input", tool.argsText)}
                  disabled={details.loading}
                >
                  {inputCopyStatus === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                </button>
              </div>
              <div className={styles.codeViewport}>
                <pre className={styles.args}>{details.loading ? "正在加载工具详情" : tool.argsText}</pre>
              </div>
            </section>

            <section className={styles.detailSection} aria-label={failed ? "工具错误" : "工具输出"}>
              <div className={styles.sectionHeader} data-kind="output">
                <div className={styles.outputHeader}>输出</div>
                <button
                  className={styles.copyButton}
                  type="button"
                  aria-label={copyAriaLabel("输出", outputCopyStatus)}
                  title={copyAriaLabel("输出", outputCopyStatus)}
                  onClick={() => void handleCopy("output", tool.resultText)}
                  disabled={!tool.resultText || details.loading}
                >
                  {outputCopyStatus === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                </button>
              </div>
              {details.loading ? (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyResult}>正在加载工具详情</p>
                </div>
              ) : details.error ? (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyResult}>工具详情加载失败</p>
                </div>
              ) : tool.resultText ? (
                <div className={styles.codeViewport}>
                  <pre data-kind={failed ? "error" : "result"}>{tool.resultText}</pre>
                </div>
              ) : (
                <div className={styles.codeViewport}>
                  <p className={styles.emptyResult}>{running ? "工具正在执行" : "暂无输出"}</p>
                </div>
              )}
            </section>
          </div>
        </div>
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

interface ParsedToolPayload {
  name: string;
  title: string;
  actionLabel: string;
  target: string;
  fileTarget: boolean;
  argsText: string;
  resultText: string;
  resultStatus: string | null;
  duration: string;
}

function parseToolPayload(message: ConversationMessage): ParsedToolPayload {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const args = asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? {};
  const summary = asRecord(message.payload.toolSummary) ?? {};
  const name = stringValue(call?.name) || stringValue(message.payload.tool) || stringValue(message.payload.tool_name) || message.content || "未知工具";
  const resultStatus = stringValue(result?.status);
  const target = toolTarget(args, message.payload, summary);
  const actionLabel = toolActionLabel(name, message.status, resultStatus);
  return {
    name,
    title: target ? `${actionLabel} ${target}` : actionLabel,
    actionLabel,
    target,
    fileTarget: isFileMutationTool(name),
    argsText: stringify(args),
    resultText: resultText(result, message.payload),
    resultStatus,
    duration: formatDuration(result?.duration_ms ?? result?.durationMs ?? message.payload.duration_ms ?? message.payload.durationMs),
  };
}

function resultText(result: Record<string, unknown> | null, payload: Record<string, unknown>): string {
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
  if (result.status === "running") {
    return "";
  }
  if (result.ui_payload && typeof result.ui_payload === "object") {
    return stringify(result.ui_payload);
  }
  return stringify(result);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toolActionLabel(
  name: string,
  status: ConversationMessage["status"],
  resultStatus: string | null,
): string {
  const action = toolAction(name);
  if (!action) {
    return name || "未知工具";
  }
  const failed = status === "failed" || resultStatus === "error";
  const prefix = failed
    ? action.failed
    : status === "pending"
      ? action.pending
      : status === "running"
        ? action.running
        : status === "cancelled"
          ? action.cancelled
          : action.done;
  return prefix;
}

function toolAction(name: string): ToolAction | null {
  if (["read_file", "read_text_file", "open_file"].includes(name)) {
    return {
      done: "已读取文件",
      running: "正在读取文件",
      pending: "等待读取文件",
      failed: "读取文件失败",
      cancelled: "已取消读取文件",
    };
  }
  if (["list_directory", "list_dir", "read_directory"].includes(name)) {
    return {
      done: "已查看目录",
      running: "正在查看目录",
      pending: "等待查看目录",
      failed: "查看目录失败",
      cancelled: "已取消查看目录",
    };
  }
  if (name === "grep_files") {
    return {
      done: "已搜索文件",
      running: "正在搜索文件",
      pending: "等待搜索文件",
      failed: "搜索文件失败",
      cancelled: "已取消搜索文件",
    };
  }
  if (name === "search_text") {
    return {
      done: "已搜索内容",
      running: "正在搜索内容",
      pending: "等待搜索内容",
      failed: "搜索内容失败",
      cancelled: "已取消搜索内容",
    };
  }
  if (["search_files", "search", "grep"].includes(name)) {
    return {
      done: "已搜索",
      running: "正在搜索",
      pending: "等待搜索",
      failed: "搜索失败",
      cancelled: "已取消搜索",
    };
  }
  if (["write_file", "apply_patch", "edit_file"].includes(name)) {
    return {
      done: "已编辑文件",
      running: "正在编辑文件",
      pending: "等待编辑文件",
      failed: "编辑文件失败",
      cancelled: "已取消编辑文件",
    };
  }
  if (name === "create_file") {
    return {
      done: "已创建文件",
      running: "正在创建文件",
      pending: "等待创建文件",
      failed: "创建文件失败",
      cancelled: "已取消创建文件",
    };
  }
  if (name === "delete_file") {
    return {
      done: "已删除文件",
      running: "正在删除文件",
      pending: "等待删除文件",
      failed: "删除文件失败",
      cancelled: "已取消删除文件",
    };
  }
  return null;
}

function toolIcon(name: string, failed: boolean) {
  if (failed) {
    return <XCircle size={16} />;
  }
  if (["read_file", "read_text_file", "open_file"].includes(name)) {
    return <FileText size={16} />;
  }
  if (["list_directory", "list_dir", "read_directory"].includes(name)) {
    return <FolderOpen size={16} />;
  }
  if (["search_files", "search_text", "grep_files", "search", "grep"].includes(name)) {
    return <Search size={16} />;
  }
  if (["write_file", "apply_patch", "edit_file"].includes(name)) {
    return <FilePenLine size={16} />;
  }
  if (name === "create_file") {
    return <FilePenLine size={16} />;
  }
  if (name === "delete_file") {
    return <FileX2 size={16} />;
  }
  return <Wrench size={16} />;
}

interface ToolAction {
  done: string;
  running: string;
  pending: string;
  failed: string;
  cancelled: string;
}

function toolTarget(
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
  summary: Record<string, unknown>,
): string {
  return (
    stringValue(args.path) ||
    stringValue(args.file) ||
    patchFileTarget(stringValue(args.patch) || stringValue(args.diff) || stringValue(args.content) || stringValue(payload.patch)) ||
    stringValue(args.query) ||
    stringValue(args.pattern) ||
    stringValue(payload.path) ||
    stringValue(summary.target) ||
    stringValue(summary.path) ||
    stringValue(summary.file) ||
    stringValue(summary.query) ||
    stringValue(summary.pattern)
  );
}

function patchFileTarget(patch: string): string {
  if (!patch) {
    return "";
  }
  const explicit = patch.match(/^\s*\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+?)\s*$/m);
  if (explicit?.[1]) {
    return explicit[1].trim();
  }
  const diffHeader = patch.match(/^\s*(?:\+\+\+\s+b\/|---\s+a\/)(.+?)\s*$/m);
  return diffHeader?.[1]?.trim() ?? "";
}

function isFileMutationTool(name: string): boolean {
  return ["write_file", "apply_patch", "edit_file", "create_file", "delete_file"].includes(name);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
