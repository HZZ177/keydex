import { Check, ChevronDown, Clipboard } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import { copyText } from "./markdown";
import styles from "./ToolCallBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

export interface ToolCallBlockProps {
  message: ConversationMessage;
}

export function ToolCallBlock({ message }: ToolCallBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const tool = useMemo(() => parseToolPayload(message), [message]);
  const running = message.status === "pending" || message.status === "running";
  const failed = message.status === "failed" || tool.resultStatus === "error";
  const statusKind = failed ? "failed" : running ? "running" : "done";
  const resultLabel = failed ? "错误" : "结果";
  const detailsMotion = useDeferredUnmount<HTMLDivElement>(detailsOpen);

  const handleCopyResult = async () => {
    try {
      await copyText(tool.resultText);
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
      data-testid="tool-call-block"
    >
      <button
        className={styles.header}
        type="button"
        aria-expanded={detailsOpen}
        aria-label={detailsOpen ? "收起工具详情" : "展开工具详情"}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <div className={styles.titleGroup}>
          <div className={styles.title}>{tool.title}</div>
          <div className={styles.status}>
            <span className={styles.statusDot} data-state={statusKind} />
            {tool.duration ? <span>{tool.duration}</span> : null}
          </div>
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
            <section className={styles.detailSection} aria-label="工具参数">
              <h3>Input</h3>
              <pre className={styles.args}>{tool.argsText}</pre>
            </section>

            <section className={styles.detailSection} aria-label={failed ? "工具错误" : "工具结果"}>
              <h3>{resultLabel}</h3>
              {tool.resultText ? (
                <>
                  <pre data-kind={failed ? "error" : "result"}>{tool.resultText}</pre>
                  <button className={styles.copyButton} type="button" aria-label="复制工具结果" onClick={handleCopyResult}>
                    {copyState === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
                    <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制结果"}</span>
                  </button>
                </>
              ) : (
                <p className={styles.emptyResult}>{running ? "工具正在执行" : "暂无结果"}</p>
              )}
            </section>
          </div>
        </div>
      ) : null}
    </article>
  );
}

interface ParsedToolPayload {
  name: string;
  title: string;
  argsText: string;
  resultText: string;
  resultStatus: string | null;
  duration: string;
}

function parseToolPayload(message: ConversationMessage): ParsedToolPayload {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const args = asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? {};
  const name = stringValue(call?.name) || stringValue(message.payload.tool) || stringValue(message.payload.tool_name) || message.content || "未知工具";
  const resultStatus = stringValue(result?.status);
  return {
    name,
    title: toolTitle(name, toolTarget(args, message.payload), message.status, resultStatus),
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
  if (result.ui_payload && typeof result.ui_payload === "object") {
    return stringify(result.ui_payload);
  }
  return stringify(result);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toolTitle(
  name: string,
  target: string,
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
  return target ? `${prefix} ${target}` : prefix;
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
  if (["search_files", "search_text", "search", "grep"].includes(name)) {
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

interface ToolAction {
  done: string;
  running: string;
  pending: string;
  failed: string;
  cancelled: string;
}

function toolTarget(args: Record<string, unknown>, payload: Record<string, unknown>): string {
  return (
    stringValue(args.path) ||
    stringValue(args.file) ||
    stringValue(args.query) ||
    stringValue(args.pattern) ||
    stringValue(payload.path)
  );
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
