import {
  CheckCircle2,
  ChevronDown,
  FileDiff,
  FilePenLine,
  FileText,
  FileX2,
  FolderOpen,
  LoaderCircle,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { fileReviewChangesFromMessage, isFileMutationToolName } from "@/renderer/utils/fileReview";

import type { MessageGroupKind } from "./processMessages";
import { LineChangeTicker } from "./LineChangeTicker";
import styles from "./MessageGroupBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";

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
  const iconKind = groupIconKind(groupKind, messages, state);
  const lineDeltas = useMemo(() => groupLineDeltas(groupKind, messages), [groupKind, messages]);
  const childrenMotion = useDeferredUnmount<HTMLDivElement>(expanded);
  const captureExpansionAnchor = useExpansionScrollAnchor();

  return (
    <article className={styles.block} data-testid="message-group-block" data-kind={groupKind} data-state={state}>
      <button
        className={styles.header}
        type="button"
        aria-expanded={expanded}
        aria-label={`${label}详情`}
        onClick={(event) => {
          captureExpansionAnchor(event.currentTarget);
          setExpanded((value) => !value);
        }}
      >
        <span className={styles.icon} data-icon-kind={iconKind} aria-hidden="true">
          {groupIcon(iconKind)}
        </span>
        <span className={styles.titleGroup}>
          <span className={styles.title}>{label}</span>
          {hasLineDeltas(lineDeltas) ? (
            <LineChangeTicker
              className={styles.inlineTicker}
              label=""
              added={lineDeltas.added}
              removed={lineDeltas.removed}
              unit=""
            />
          ) : null}
        </span>
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

type GroupIconKind =
  | "done"
  | "running"
  | "failed"
  | "file_change"
  | "read"
  | "directory"
  | "search"
  | "command"
  | "edit"
  | "create"
  | "delete"
  | "mcp"
  | "other";

function groupIconKind(
  kind: MessageGroupKind,
  messages: ConversationMessage[],
  state: GroupSummary["state"],
): GroupIconKind {
  if (state === "failed") {
    return "failed";
  }
  if (kind === "file_changes") {
    return fileChangeGroupIconKind(messages);
  }
  if (state === "running" || state === "pending") {
    return "running";
  }
  const toolKinds = new Set(messages.map(toolIconKindFromMessage));
  if (toolKinds.size === 1) {
    return [...toolKinds][0] ?? "done";
  }
  return "done";
}

function groupIcon(kind: GroupIconKind) {
  switch (kind) {
    case "running":
      return <LoaderCircle size={16} />;
    case "failed":
      return <XCircle size={16} />;
    case "file_change":
      return <FileDiff size={16} />;
    case "read":
      return <FileText size={16} />;
    case "directory":
      return <FolderOpen size={16} />;
    case "search":
      return <Search size={16} />;
    case "command":
      return <SquareTerminal size={16} />;
    case "edit":
      return <FilePenLine size={16} />;
    case "create":
      return <FilePenLine size={16} />;
    case "delete":
      return <FileX2 size={16} />;
    case "mcp":
      return <Wrench size={16} />;
    case "other":
      return <Wrench size={16} />;
    case "done":
      return <CheckCircle2 size={16} />;
  }
}

interface GroupSummary {
  id: string;
  state: "done" | "running" | "failed" | "pending";
}

type CountState = "done" | "running" | "failed";

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
  const result = asRecord(message.payload.result);
  const resultStatus = stringValue(result?.status);
  const failed =
    message.status === "failed" ||
    resultStatus === "error" ||
    Boolean(message.payload.error) ||
    Boolean(result?.error);
  return {
    id: message.id,
    state: failed ? "failed" : summaryState(message),
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

function toolIconKindFromMessage(message: ConversationMessage): GroupIconKind {
  if (message.kind === "command") {
    return "command";
  }
  if (isMcpToolMessage(message)) {
    return "mcp";
  }
  const toolName = toolNameFromMessage(message);
  if (isReadTool(toolName)) {
    return "read";
  }
  if (isDirectoryTool(toolName)) {
    return "directory";
  }
  if (isSearchTool(toolName)) {
    return "search";
  }
  if (["write_file", "create_file"].includes(toolName)) {
    return "create";
  }
  if (["apply_patch", "edit_file"].includes(toolName)) {
    return "edit";
  }
  if (toolName === "delete_file") {
    return "delete";
  }
  return "other";
}

function fileChangeGroupIconKind(messages: ConversationMessage[]): GroupIconKind {
  const iconKinds = new Set<GroupIconKind>();
  messages.forEach((message, index) => {
    fileChangesFromMessage(message, index).forEach((change) => {
      iconKinds.add(iconKindForFileOperation(change.operation));
    });
  });
  if (iconKinds.size === 1) {
    return [...iconKinds][0] ?? "file_change";
  }
  return "file_change";
}

function iconKindForFileOperation(operation: FileChangeOperation): GroupIconKind {
  switch (operation) {
    case "add":
      return "create";
    case "delete":
      return "delete";
    case "append":
    case "update":
    case "write":
      return "edit";
    case "unknown":
      return "file_change";
  }
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
  const stats = createToolStats();

  messages.forEach((message, index) => {
    const countState = countStateFromSummary(summarizeMessage(message).state);
    if (message.kind === "command") {
      stats.commands[countState] += 1;
      return;
    }
    if (isMcpToolMessage(message)) {
      stats.mcpTools[countState] += 1;
      return;
    }
    const toolName = toolNameFromMessage(message);
    const args = toolArgsFromMessage(message);
    const target = toolTarget(args, index);
    if (isReadTool(toolName)) {
      stats.readFiles[countState].add(target);
      return;
    }
    if (isDirectoryTool(toolName)) {
      stats.listedDirectories[countState].add(target);
      return;
    }
    if (toolName === "grep_files" || toolName === "search_files") {
      stats.fileSearches[countState] += 1;
      return;
    }
    if (toolName === "search_text") {
      stats.contentSearches[countState] += 1;
      return;
    }
    if (isSearchTool(toolName)) {
      stats.searches[countState] += 1;
      return;
    }
    if (isEditTool(toolName)) {
      fileChangesFromMessage(message, index, operationFromToolName(toolName)).forEach((change) => {
        stats[fileSummaryKindForOperation(change.operation)][countState].add(change.path);
      });
      return;
    }
    stats.otherTools[countState] += 1;
  });

  const parts = [
    ...countSetPhrases("readFiles", stats.readFiles),
    ...countSetPhrases("listedDirectories", stats.listedDirectories),
    ...countNumberPhrases("fileSearches", stats.fileSearches),
    ...countNumberPhrases("contentSearches", stats.contentSearches),
    ...countNumberPhrases("searches", stats.searches),
    ...countNumberPhrases("commands", stats.commands),
    ...countNumberPhrases("mcpTools", stats.mcpTools),
    ...countSetPhrases("createdFiles", stats.createdFiles),
    ...countSetPhrases("editedFiles", stats.editedFiles),
    ...countSetPhrases("deletedFiles", stats.deletedFiles),
    ...countNumberPhrases("otherTools", stats.otherTools),
  ];

  if (parts.length) {
    return parts.join("，");
  }
  return countPhrase("otherTools", fallbackCount, countStateFromSummary(state)) || "执行了工具";
}

function fileChangeLabel(messages: ConversationMessage[], state: GroupSummary["state"], fallbackCount: number): string {
  const files = createFileChangeStats();
  messages.forEach((message, index) => {
    const countState = countStateFromSummary(summarizeFileChange(message).state);
    fileChangesFromMessage(message, index).forEach((change) => {
      files[fileSummaryKindForOperation(change.operation)][countState].add(change.path);
    });
  });
  const parts = [
    ...countSetPhrases("createdFiles", files.createdFiles),
    ...countSetPhrases("editedFiles", files.editedFiles),
    ...countSetPhrases("deletedFiles", files.deletedFiles),
  ];
  if (parts.length) {
    return parts.join("，");
  }
  return countPhrase("editedFiles", fallbackCount, countStateFromSummary(state)) || "编辑了文件";
}

type ToolSummaryKind =
  | "readFiles"
  | "listedDirectories"
  | "fileSearches"
  | "contentSearches"
  | "searches"
  | "commands"
  | "mcpTools"
  | "createdFiles"
  | "editedFiles"
  | "deletedFiles"
  | "otherTools";

type FileChangeOperation = "add" | "update" | "delete" | "append" | "write" | "unknown";

interface FileChangeSummary {
  path: string;
  operation: FileChangeOperation;
}

interface LineDeltas {
  added: number;
  removed: number;
}

function groupLineDeltas(kind: MessageGroupKind, messages: ConversationMessage[]): LineDeltas {
  if (kind !== "tool_activity") {
    return { added: 0, removed: 0 };
  }

  return messages.reduce<LineDeltas>((total, message) => {
    if (message.kind !== "tool" || summarizeMessage(message).state === "failed") {
      return total;
    }
    if (!isFileMutationToolName(toolNameFromMessage(message))) {
      return total;
    }

    fileReviewChangesFromMessage(message).forEach((change) => {
      total.added += change.additions;
      total.removed += change.deletions;
    });
    return total;
  }, { added: 0, removed: 0 });
}

function hasLineDeltas(deltas: LineDeltas): boolean {
  return deltas.added > 0 || deltas.removed > 0;
}

function countPhrase(kind: ToolSummaryKind, count: number, state: CountState): string {
  if (!count) {
    return "";
  }
  const verb = verbForKind(kind, state);
  switch (kind) {
    case "readFiles":
      return `${verb} ${count} 个文件`;
    case "listedDirectories":
      return `${verb} ${count} 个目录`;
    case "fileSearches":
    case "contentSearches":
    case "searches":
      return `${verb} ${count} 次`;
    case "commands":
      return `${verb} ${count} 条命令`;
    case "mcpTools":
      return `${verb} ${count} 个 MCP 工具`;
    case "createdFiles":
    case "editedFiles":
    case "deletedFiles":
      return `${verb} ${count} 个文件`;
    case "otherTools":
      return `${verb} ${count} 个工具`;
  }
}

function verbForKind(kind: ToolSummaryKind, state: CountState): string {
  const running = state === "running";
  const failed = state === "failed";
  switch (kind) {
    case "readFiles":
      return failed ? "读取失败" : running ? "正在读取" : "读取了";
    case "listedDirectories":
      return failed ? "查看失败" : running ? "正在查看" : "查看了";
    case "fileSearches":
      return failed ? "搜索文件失败" : running ? "正在搜索文件" : "已搜索文件";
    case "contentSearches":
      return failed ? "搜索内容失败" : running ? "正在搜索内容" : "已搜索内容";
    case "searches":
      return failed ? "搜索失败" : running ? "正在搜索" : "搜索了";
    case "commands":
      return failed ? "运行失败" : running ? "正在运行" : "已运行";
    case "mcpTools":
      return failed ? "调用失败" : running ? "正在调用" : "调用了";
    case "createdFiles":
      return failed ? "创建失败" : running ? "正在创建" : "创建了";
    case "editedFiles":
      return failed ? "编辑失败" : running ? "正在编辑" : "编辑了";
    case "deletedFiles":
      return failed ? "删除失败" : running ? "正在删除" : "删除了";
    case "otherTools":
      return failed ? "调用失败" : running ? "正在调用" : "调用了";
  }
}

type StateSetBuckets = Record<CountState, Set<string>>;
type StateNumberBuckets = Record<CountState, number>;

function createToolStats() {
  return {
    readFiles: createStateSetBuckets(),
    listedDirectories: createStateSetBuckets(),
    fileSearches: createStateNumberBuckets(),
    contentSearches: createStateNumberBuckets(),
    searches: createStateNumberBuckets(),
    commands: createStateNumberBuckets(),
    mcpTools: createStateNumberBuckets(),
    createdFiles: createStateSetBuckets(),
    editedFiles: createStateSetBuckets(),
    deletedFiles: createStateSetBuckets(),
    otherTools: createStateNumberBuckets(),
  };
}

function createFileChangeStats() {
  return {
    createdFiles: createStateSetBuckets(),
    editedFiles: createStateSetBuckets(),
    deletedFiles: createStateSetBuckets(),
  };
}

function createStateSetBuckets(): StateSetBuckets {
  return {
    failed: new Set<string>(),
    running: new Set<string>(),
    done: new Set<string>(),
  };
}

function createStateNumberBuckets(): StateNumberBuckets {
  return {
    failed: 0,
    running: 0,
    done: 0,
  };
}

function countSetPhrases(kind: ToolSummaryKind, buckets: StateSetBuckets): string[] {
  return orderedCountStates()
    .map((state) => countPhrase(kind, buckets[state].size, state))
    .filter(Boolean);
}

function countNumberPhrases(kind: ToolSummaryKind, buckets: StateNumberBuckets): string[] {
  return orderedCountStates()
    .map((state) => countPhrase(kind, buckets[state], state))
    .filter(Boolean);
}

function orderedCountStates(): CountState[] {
  return ["failed", "running", "done"];
}

function countStateFromSummary(state: GroupSummary["state"]): CountState {
  if (state === "failed") {
    return "failed";
  }
  if (state === "running" || state === "pending") {
    return "running";
  }
  return "done";
}

function toolNameFromMessage(message: ConversationMessage): string {
  const call = asRecord(message.payload.call);
  return stringValue(call?.name) || stringValue(message.payload.tool) || stringValue(message.payload.tool_name) || message.content;
}

function isMcpToolMessage(message: ConversationMessage): boolean {
  if (message.kind !== "tool") {
    return false;
  }
  const metadata = asRecord(message.payload.metadata);
  const mcp = asRecord(metadata?.mcp) ?? asRecord(message.payload.mcp);
  const toolName = toolNameFromMessage(message);
  return (
    toolName.startsWith("mcp__") ||
    mcp?.kind === "mcp_tool" ||
    Boolean(mcp?.server_id || mcp?.serverName || mcp?.raw_tool_name || mcp?.model_tool_name)
  );
}

function toolArgsFromMessage(message: ConversationMessage): Record<string, unknown> | null {
  const call = asRecord(message.payload.call);
  return asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? asRecord(message.payload.params);
}

function toolTarget(args: Record<string, unknown> | null, index: number): string {
  return stringValue(args?.path) || stringValue(args?.file) || stringValue(args?.query) || `item-${index}`;
}

function fileChangesFromMessage(
  message: ConversationMessage,
  index: number,
  fallbackOperation: FileChangeOperation = "unknown",
): FileChangeSummary[] {
  const result = asRecord(message.payload.result);
  const toolOperation = operationFromToolName(toolNameFromMessage(message));
  const forcedOperation = toolOperation !== "unknown" ? toolOperation : null;
  const effectiveFallback = forcedOperation ?? fallbackOperation;
  const changes = new Map<string, FileChangeSummary>();
  fileChangesFromPayload(message.payload, index, effectiveFallback, forcedOperation).forEach((change) => changes.set(change.path, change));
  fileChangesFromPayload(result ?? {}, index, operationFromRecord(result, effectiveFallback), forcedOperation).forEach((change) => {
    const existing = changes.get(change.path);
    changes.set(change.path, {
      path: change.path,
      operation: forcedOperation ?? (change.operation !== "unknown" ? change.operation : existing?.operation ?? effectiveFallback),
    });
  });
  if (!changes.size) {
    const path = toolTarget(toolArgsFromMessage(message), index);
    changes.set(path, { path, operation: effectiveFallback });
  }
  return [...changes.values()];
}

function fileChangesFromPayload(
  payload: Record<string, unknown>,
  index: number,
  fallbackOperation: FileChangeOperation,
  forcedOperation: FileChangeOperation | null,
): FileChangeSummary[] {
  const changes = new Map<string, FileChangeSummary>();
  const parentOperation = forcedOperation ?? operationFromRecord(payload, fallbackOperation);
  const directPath = stringValue(payload.path);
  if (directPath) {
    changes.set(directPath, { path: directPath, operation: parentOperation });
  }
  if (Array.isArray(payload.files)) {
    payload.files.forEach((item, fileIndex) => {
      const record = asRecord(item);
      const path = stringValue(record?.path) || `file-${index}-${fileIndex}`;
      changes.set(path, { path, operation: forcedOperation ?? operationFromRecord(record, parentOperation) });
    });
  }
  return [...changes.values()];
}

function fileSummaryKindForOperation(operation: FileChangeOperation): "createdFiles" | "editedFiles" | "deletedFiles" {
  switch (operation) {
    case "add":
      return "createdFiles";
    case "delete":
      return "deletedFiles";
    case "append":
    case "update":
    case "write":
    case "unknown":
      return "editedFiles";
  }
}

function operationFromToolName(toolName: string): FileChangeOperation {
  if (["write_file", "create_file"].includes(toolName)) {
    return "add";
  }
  if (toolName === "delete_file") {
    return "delete";
  }
  if (["apply_patch", "edit_file"].includes(toolName)) {
    return "update";
  }
  return "unknown";
}

function operationFromRecord(
  record: Record<string, unknown> | null,
  fallbackOperation: FileChangeOperation,
): FileChangeOperation {
  if (!record) {
    return fallbackOperation;
  }
  const explicit = normalizeOperation(
    record.operation ??
      record.action ??
      record.kind ??
      record.change_type ??
      record.changeType,
  );
  if (explicit !== "unknown") {
    return explicit;
  }
  if (record.created === true || record.is_new === true || record.isNew === true) {
    return "add";
  }
  return fallbackOperation;
}

function normalizeOperation(value: unknown): FileChangeOperation {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["add", "create", "created", "new", "new_file", "insert"].includes(normalized)) {
    return "add";
  }
  if (["delete", "deleted", "remove", "removed"].includes(normalized)) {
    return "delete";
  }
  if (["append", "append_file"].includes(normalized)) {
    return "append";
  }
  if (["write", "write_file", "overwrite"].includes(normalized)) {
    return "add";
  }
  if (["update", "edit", "modify", "modified", "patch", "apply_patch"].includes(normalized)) {
    return "update";
  }
  return "unknown";
}

function isReadTool(toolName: string): boolean {
  return ["read_file", "read_text_file", "open_file"].includes(toolName);
}

function isDirectoryTool(toolName: string): boolean {
  return ["list_directory", "list_dir", "read_directory"].includes(toolName);
}

function isSearchTool(toolName: string): boolean {
  return ["search_files", "search_text", "grep_files", "search", "grep"].includes(toolName);
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
