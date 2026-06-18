import { CheckCircle2, ChevronDown, FileDiff, LoaderCircle, Terminal, XCircle } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type { MessageGroupKind } from "./processMessages";
import styles from "./MessageGroupBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

export interface MessageGroupBlockProps {
  groupKind: MessageGroupKind;
  count: number;
  messages?: ConversationMessage[];
  sourceMessageIds: string[];
  children: ReactNode;
}

export function MessageGroupBlock({ groupKind, count, messages = [], sourceMessageIds, children }: MessageGroupBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const sourceText = useMemo(() => sourceMessageIds.join(", "), [sourceMessageIds]);
  const summaries = useMemo(() => messages.map((message) => summarizeMessage(message)), [messages]);
  const state = groupState(summaries);
  const label = groupLabel(groupKind, count, messages, state);
  const childrenMotion = useDeferredUnmount<HTMLDivElement>(expanded);

  return (
    <article className={styles.block} data-testid="message-group-block" data-kind={groupKind} data-state={state}>
      <button
        className={styles.header}
        type="button"
        aria-expanded={expanded}
        aria-label={`${label}详情`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.icon} aria-hidden="true">
          {groupIcon(groupKind, messages, state)}
        </span>
        <span className={styles.title}>{label}</span>
        {expanded ? (
          <span className={styles.source} title={sourceText}>
            收起
          </span>
        ) : null}
        <ChevronDown size={14} data-expanded={expanded ? "true" : "false"} />
      </button>

      {childrenMotion.shouldRender ? (
        <div
          className={styles.children}
          data-motion={childrenMotion.phase}
          ref={childrenMotion.ref}
          style={childrenMotion.style}
          aria-hidden={!expanded}
        >
          <div className={styles.childrenInner}>{children}</div>
        </div>
      ) : null}
    </article>
  );
}

function groupLabel(
  kind: MessageGroupKind,
  count: number,
  messages: ConversationMessage[],
  state: GroupSummary["state"],
): string {
  if (kind === "file_changes") {
    return fileChangeLabel(messages, state, count);
  }
  return toolActivityLabel(messages, state, count);
}

function groupIcon(
  kind: MessageGroupKind,
  messages: ConversationMessage[],
  state: GroupSummary["state"],
) {
  if (state === "running" || state === "pending") {
    return <LoaderCircle size={15} />;
  }
  if (state === "failed") {
    return <XCircle size={15} />;
  }
  if (kind === "file_changes") {
    return <FileDiff size={15} />;
  }
  if (messages.length && messages.every((message) => message.kind === "command")) {
    return <Terminal size={15} />;
  }
  return <CheckCircle2 size={15} />;
}

interface GroupSummary {
  id: string;
  state: "done" | "running" | "failed" | "pending";
}

function groupState(summaries: GroupSummary[]): GroupSummary["state"] {
  if (summaries.some((summary) => summary.state === "failed")) {
    return "failed";
  }
  if (summaries.some((summary) => summary.state === "running")) {
    return "running";
  }
  if (summaries.some((summary) => summary.state === "pending")) {
    return "pending";
  }
  return "done";
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
  return {
    id: message.id,
    state: summaryState(message),
  };
}

function summarizeCommand(message: ConversationMessage): GroupSummary {
  const result = asRecord(message.payload.result);
  const merged = {
    ...message.payload,
    ...(result?.ui_payload && typeof result.ui_payload === "object" ? result.ui_payload : {}),
  };
  const exitCode = numberValue(merged.exit_code ?? merged.exitCode);
  const failed = message.status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  return {
    id: message.id,
    state: failed ? "failed" : summaryState(message),
  };
}

function summarizeFileChange(message: ConversationMessage): GroupSummary {
  return {
    id: message.id,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toolActivityLabel(
  messages: ConversationMessage[],
  state: GroupSummary["state"],
  fallbackCount: number,
): string {
  const stats = {
    readFiles: new Set<string>(),
    listedDirectories: new Set<string>(),
    searches: 0,
    commands: 0,
    editedFiles: new Set<string>(),
    otherTools: 0,
  };

  messages.forEach((message, index) => {
    if (message.kind === "command") {
      stats.commands += 1;
      return;
    }
    const toolName = toolNameFromMessage(message);
    const args = toolArgsFromMessage(message);
    const target = toolTarget(args, index);
    if (isReadTool(toolName)) {
      stats.readFiles.add(target);
      return;
    }
    if (isDirectoryTool(toolName)) {
      stats.listedDirectories.add(target);
      return;
    }
    if (isSearchTool(toolName)) {
      stats.searches += 1;
      return;
    }
    if (isEditTool(toolName)) {
      editedFilesFromMessage(message, index).forEach((path) => stats.editedFiles.add(path));
      return;
    }
    stats.otherTools += 1;
  });

  const parts = [
    countPhrase("readFiles", stats.readFiles.size, state),
    countPhrase("listedDirectories", stats.listedDirectories.size, state),
    countPhrase("searches", stats.searches, state),
    countPhrase("commands", stats.commands, state),
    countPhrase("editedFiles", stats.editedFiles.size, state),
    countPhrase("otherTools", stats.otherTools, state),
  ].filter(Boolean);

  if (parts.length) {
    return parts.join("，");
  }
  return countPhrase("otherTools", fallbackCount, state) || "执行了工具";
}

function fileChangeLabel(messages: ConversationMessage[], state: GroupSummary["state"], fallbackCount: number): string {
  const fileCount = messages.reduce((total, message, index) => total + filePathsFromPayload(message.payload, index).size, 0);
  return countPhrase("editedFiles", fileCount || fallbackCount, state) || "编辑了文件";
}

type ToolSummaryKind = "readFiles" | "listedDirectories" | "searches" | "commands" | "editedFiles" | "otherTools";

function countPhrase(kind: ToolSummaryKind, count: number, state: GroupSummary["state"]): string {
  if (!count) {
    return "";
  }
  const verb = verbForKind(kind, state);
  switch (kind) {
    case "readFiles":
      return `${verb} ${count} 个文件`;
    case "listedDirectories":
      return `${verb} ${count} 个目录`;
    case "searches":
      return `${verb} ${count} 次`;
    case "commands":
      return `${verb} ${count} 条命令`;
    case "editedFiles":
      return `${verb} ${count} 个文件`;
    case "otherTools":
      return `${verb} ${count} 个工具`;
  }
}

function verbForKind(kind: ToolSummaryKind, state: GroupSummary["state"]): string {
  const running = state === "running" || state === "pending";
  const failed = state === "failed";
  switch (kind) {
    case "readFiles":
      return failed ? "读取失败" : running ? "正在读取" : "读取了";
    case "listedDirectories":
      return failed ? "查看失败" : running ? "正在查看" : "查看了";
    case "searches":
      return failed ? "搜索失败" : running ? "正在搜索" : "搜索了";
    case "commands":
      return failed ? "运行失败" : running ? "正在运行" : "已运行";
    case "editedFiles":
      return failed ? "编辑失败" : running ? "正在编辑" : "编辑了";
    case "otherTools":
      return failed ? "调用失败" : running ? "正在调用" : "调用了";
  }
}

function toolNameFromMessage(message: ConversationMessage): string {
  const call = asRecord(message.payload.call);
  return stringValue(call?.name) || stringValue(message.payload.tool) || stringValue(message.payload.tool_name) || message.content;
}

function toolArgsFromMessage(message: ConversationMessage): Record<string, unknown> | null {
  const call = asRecord(message.payload.call);
  return asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? asRecord(message.payload.params);
}

function toolTarget(args: Record<string, unknown> | null, index: number): string {
  return stringValue(args?.path) || stringValue(args?.file) || stringValue(args?.query) || `item-${index}`;
}

function editedFilesFromMessage(message: ConversationMessage, index: number): Set<string> {
  const result = asRecord(message.payload.result);
  const files = filePathsFromPayload(message.payload, index);
  filePathsFromPayload(result ?? {}, index).forEach((path) => files.add(path));
  if (!files.size) {
    files.add(toolTarget(toolArgsFromMessage(message), index));
  }
  return files;
}

function filePathsFromPayload(payload: Record<string, unknown>, index: number): Set<string> {
  const paths = new Set<string>();
  const directPath = stringValue(payload.path);
  if (directPath) {
    paths.add(directPath);
  }
  if (Array.isArray(payload.files)) {
    payload.files.forEach((item, fileIndex) => {
      const record = asRecord(item);
      paths.add(stringValue(record?.path) || `file-${index}-${fileIndex}`);
    });
  }
  return paths;
}

function isReadTool(toolName: string): boolean {
  return ["read_file", "read_text_file", "open_file"].includes(toolName);
}

function isDirectoryTool(toolName: string): boolean {
  return ["list_directory", "list_dir", "read_directory"].includes(toolName);
}

function isSearchTool(toolName: string): boolean {
  return ["search_files", "search_text", "search", "grep"].includes(toolName);
}

function isEditTool(toolName: string): boolean {
  return ["write_file", "apply_patch", "edit_file", "create_file", "delete_file"].includes(toolName);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
