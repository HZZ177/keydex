import { ChevronDown, Copy, FileDiff, FilePenLine, FileX2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { FileReviewCard } from "@/renderer/components/review/FileReviewDiff";
import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

import { formatErrorText, readableErrorText } from "./errorText";
import styles from "./FileChangeBlock.module.css";
import { LineChangeTicker } from "./LineChangeTicker";
import { useLazyToolDetails, type ToolDetailsLoader } from "./useLazyToolDetails";
import { useDeferredUnmount } from "./useDeferredUnmount";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";

export interface FileChangeBlockProps {
  message: ConversationMessage;
  onPreviewFile?: (file: FileChangePreview) => void;
  onLoadDetails?: ToolDetailsLoader;
}

export interface FileChangePreview {
  path: string;
  diff: string;
  files?: FileReviewChange[];
  message?: ConversationMessage;
  messages?: ConversationMessage[];
  title?: string;
}

export function FileChangeBlock({ message, onPreviewFile, onLoadDetails }: FileChangeBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const details = useLazyToolDetails(message, onLoadDetails);
  const change = useMemo(() => parseFileChange(details.message), [details.message]);
  const failed = details.message.status === "failed" || change.status === "failed";
  const statusKind = failed ? "failed" : change.status === "running" ? "running" : "done";
  const singleFile = change.files.length === 1 ? change.files[0] : null;
  const expandedFile = singleFile ? null : change.files.find((file) => file.path === expandedPath) ?? null;
  const primaryOperation = singleFile?.operation ?? commonOperation(change.files);
  const title = change.files.length ? `${summaryVerb(change.status, primaryOperation)} ${change.files.length} 个文件` : "文件变更";
  const headerStatusLabel = singleFile
    ? inlineStatusLabel(change.status, primaryOperation)
    : statusLabel(change.status, primaryOperation);
  const detailsMotion = useDeferredUnmount<HTMLDivElement>(detailsOpen);
  const captureExpansionAnchor = useExpansionScrollAnchor();
  const toggleDetails = (target: HTMLElement) => {
    captureExpansionAnchor(target);
    setDetailsOpen((open) => {
      if (!open) {
        void details.load();
      }
      return !open;
    });
  };

  return (
    <article className={styles.block} data-status={failed ? "failed" : change.status} data-testid="file-change-block">
      <div
        className={styles.header}
        data-expanded={detailsOpen ? "true" : "false"}
        data-single={singleFile ? "true" : "false"}
        role="button"
        tabIndex={0}
        aria-expanded={detailsOpen}
        aria-label={detailsOpen ? "收起文件变更详情" : "展开文件变更详情"}
        onClick={(event) => toggleDetails(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          toggleDetails(event.currentTarget);
        }}
      >
        <span className={styles.toggleGlyph} aria-hidden="true">
          <span className={styles.icon} data-operation={primaryOperation} data-state={statusKind} aria-hidden="true">
            {changeIcon(primaryOperation, failed)}
          </span>
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.statusLine}>
            <span className={styles.statusMeta}>
              <span className={styles.statusDot} data-state={statusKind} />
              <span>{headerStatusLabel}</span>
            </span>
            {singleFile ? (
              <button
                className={styles.pathButton}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPreviewFile?.({
                    path: singleFile.path,
                    diff: singleFile.diff,
                    files: change.files,
                    message: details.message,
                    title,
                  });
                }}
              >
                <FileChangePathIcon path={singleFile.path} />
                <span className={styles.pathLabel}>{singleFile.path}</span>
              </button>
            ) : (
              <span className={styles.title}>{title}</span>
            )}
            {singleFile && !failed ? (
              <LineChangeTicker
                className={styles.inlineTicker}
                label=""
                added={singleFile.additions}
                removed={singleFile.deletions}
                unit=""
              />
            ) : null}
          </div>
        </div>
        <span className={styles.chevronGlyph} aria-hidden="true">
          <ChevronDown className={styles.chevron} size={14} />
        </span>
      </div>

      {detailsMotion.shouldRender ? (
        <div
          className={styles.details}
          data-motion={detailsMotion.phase}
          ref={detailsMotion.ref}
          style={detailsMotion.style}
          aria-hidden={!detailsOpen}
        >
          <div className={styles.detailsInner}>
            {details.loading ? (
              <ToolDetailNotice text="正在加载文件变更详情" />
            ) : details.error ? (
              <ToolDetailNotice text="文件变更详情加载失败" />
            ) : singleFile ? (
              failed ? (
                <FileChangeErrorPanel paramsText={change.paramsText} errorMessage={change.errorMessage} files={change.files} />
              ) : (
                <FileDiffPreview file={singleFile} />
              )
            ) : failed ? (
              <FileChangeErrorPanel paramsText={change.paramsText} errorMessage={change.errorMessage} files={change.files} />
            ) : (
              <>
                <ul className={styles.fileList} aria-label="变更文件">
                  {change.files.map((file) => {
                    const open = expandedPath === file.path;
                    return (
                      <li key={file.path} className={styles.fileItem}>
                        <button
                          className={styles.fileButton}
                          type="button"
                          aria-expanded={open}
                          onClick={() => setExpandedPath(open ? null : file.path)}
                        >
                          <ChevronDown size={14} data-expanded={open ? "true" : "false"} />
                          <FileChangePathIcon path={file.path} />
                          <span className={styles.path}>{file.path}</span>
                          <span className={styles.fileStats}>+{file.additions} -{file.deletions}</span>
                        </button>
                        <button
                          className={styles.previewButton}
                          type="button"
                          onClick={() =>
                            onPreviewFile?.({
                              path: file.path,
                              diff: file.diff,
                              files: change.files,
                              message: details.message,
                              title,
                            })
                          }
                        >
                          预览
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {expandedFile ? <FileReviewCard file={expandedFile} /> : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function FileChangePathIcon({ path }: { path: string }) {
  const icon = useMaterialEntryIcon(path, "file");
  return (
    <img
      alt=""
      aria-hidden="true"
      className={styles.pathIcon}
      data-icon-id={icon.id}
      data-file-change-path-icon="true"
      draggable={false}
      src={icon.src}
    />
  );
}

function ToolDetailNotice({ text }: { text: string }) {
  return (
    <section className={styles.previewBlock} data-empty="true" aria-label={text}>
      <header className={styles.previewHeader}>
        <span className={styles.previewTitle}>{text}</span>
      </header>
    </section>
  );
}

interface ParsedFileChange {
  files: FileChangeFile[];
  additions: number;
  deletions: number;
  status: "pending" | "running" | "applied" | "rejected" | "failed";
  paramsText: string;
  errorMessage: string;
}

interface FileChangeFile {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  content: string;
  operation: FileChangeOperation;
}

type FileChangeOperation = "add" | "update" | "delete" | "append" | "write" | "unknown";

function FileDiffPreview({ file }: { file: FileChangeFile }) {
  return <FileReviewCard file={file} />;
}

function FileChangeErrorPanel({
  paramsText,
  errorMessage,
  files,
}: {
  paramsText: string;
  errorMessage: string;
  files: FileChangeFile[];
}) {
  const fileLabel = files.map((file) => file.path).filter(Boolean).join("\n");
  const copySource = [
    paramsText ? `入参\n${paramsText}` : "",
    errorMessage ? `错误信息\n${errorMessage}` : "",
    fileLabel ? `相关文件\n${fileLabel}` : "",
  ].filter(Boolean).join("\n\n");

  return (
    <section className={styles.errorBlock} aria-label="文件变更错误">
      <header className={styles.errorHeader}>
        <span>工具执行失败</span>
        <button
          className={styles.copyButton}
          type="button"
          aria-label="复制错误信息"
          data-tooltip-label="复制错误信息"
          title="复制错误信息"
          disabled={!copySource}
          onClick={() => void navigator.clipboard?.writeText(copySource)}
        >
          <Copy size={14} />
        </button>
      </header>
      <div className={styles.errorSection}>
        <span className={styles.errorSectionTitle}>入参</span>
        <pre className={styles.errorParams}>{paramsText || "{}"}</pre>
      </div>
      <div className={styles.errorSection}>
        <span className={styles.errorSectionTitle}>错误信息</span>
        <pre className={styles.errorText}>{errorMessage || "工具执行失败，未返回详细错误信息"}</pre>
      </div>
      {files.length ? (
        <ul className={styles.errorFileList} aria-label="失败文件">
          {files.map((file) => (
            <li key={file.path}>{file.path}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function parseFileChange(message: ConversationMessage): ParsedFileChange {
  const result = asRecord(message.payload.result);
  const source = result?.files ?? message.payload.files;
  const toolOperation = operationFromToolName(toolNameFromMessage(message));
  const forcedOperation = toolOperation !== "unknown" ? toolOperation : null;
  const fallbackOperation = forcedOperation ?? operationFromRecord(result ?? message.payload, "unknown");
  const files = parseFiles(source, message.payload, fallbackOperation, forcedOperation);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    files,
    additions,
    deletions,
    status: changeStatus(message, result),
    paramsText: paramsTextFromPayload(message),
    errorMessage: errorMessageFromPayload(message, result),
  };
}

function parseFiles(
  source: unknown,
  payload: Record<string, unknown>,
  fallbackOperation: FileChangeOperation,
  forcedOperation: FileChangeOperation | null,
): FileChangeFile[] {
  if (Array.isArray(source)) {
    return source
      .map((item, index) => fileFromRecord(asRecord(item), index, fallbackOperation, forcedOperation))
      .filter(isDefined);
  }
  const single = fileFromRecord(payload, 0, fallbackOperation, forcedOperation);
  return single ? [single] : [];
}

function fileFromRecord(
  record: Record<string, unknown> | null,
  index: number,
  fallbackOperation: FileChangeOperation,
  forcedOperation: FileChangeOperation | null,
): FileChangeFile | null {
  if (!record) {
    return null;
  }
  const path = stringValue(record.path) || `文件 ${index + 1}`;
  return {
    path,
    additions: numberValue(record.additions) ?? numberValue(record.added_lines) ?? countDiff(record.diff, "+"),
    deletions:
      numberValue(record.deletions) ??
      numberValue(record.deleted_lines) ??
      numberValue(record.removed_lines) ??
      countDiff(record.diff, "-"),
    diff: stringValue(record.diff),
    content: stringValue(record.new_content) || stringValue(record.newContent) || stringValue(record.content),
    operation: forcedOperation ?? operationFromRecord(record, fallbackOperation),
  };
}

function changeStatus(message: ConversationMessage, result: Record<string, unknown> | null): ParsedFileChange["status"] {
  if (message.status === "failed") {
    return "failed";
  }
  if (message.status === "running" || message.status === "pending") {
    return "running";
  }
  const applied = result?.applied ?? message.payload.applied;
  const rejected = result?.rejected ?? message.payload.rejected;
  if (rejected === true) {
    return "rejected";
  }
  if (applied === true) {
    return "applied";
  }
  const resultStatus = stringValue(result?.status ?? message.payload.status);
  if (resultStatus === "error" || resultStatus === "failed") {
    return "failed";
  }
  if (resultStatus === "success" || message.status === "completed") {
    return "applied";
  }
  return "pending";
}

function errorMessageFromPayload(
  message: ConversationMessage,
  result: Record<string, unknown> | null,
): string {
  const resultError = formatErrorText(result?.error);
  if (resultError) {
    return resultError;
  }
  const payloadError = formatErrorText(message.payload.error);
  if (payloadError) {
    return payloadError;
  }
  const modelContent = stringValue(result?.model_content ?? message.payload.model_content);
  if (modelContent) {
    return readableErrorText(modelContent);
  }
  const resultText = stringValue(message.payload.result_text);
  if (resultText) {
    return readableErrorText(resultText);
  }
  return "";
}

function paramsTextFromPayload(message: ConversationMessage): string {
  const call = asRecord(message.payload.call);
  const params =
    call?.arguments ??
    message.payload.arguments ??
    message.payload.params ??
    message.payload.input_data ??
    null;
  if (params === null || params === undefined) {
    return "";
  }
  if (typeof params === "string") {
    return params.trim();
  }
  return stringifyJson(params);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function inlineStatusLabel(status: ParsedFileChange["status"], operation: FileChangeOperation): string {
  switch (status) {
    case "applied":
      return inlinePastVerb(operation);
    case "rejected":
      return "已拒绝";
    case "failed":
      return `${inlineOperationVerb(operation)}失败`;
    case "running":
      return `正在${inlineOperationVerb(operation)}`;
    case "pending":
      return `等待${inlineOperationVerb(operation)}`;
  }
}

function statusLabel(status: ParsedFileChange["status"], operation: FileChangeOperation): string {
  const verb = operationVerb(operation);
  switch (status) {
    case "applied":
      return `已${verb}`;
    case "rejected":
      return "已拒绝";
    case "failed":
      return `${verb}失败`;
    case "running":
      return `正在${verb}`;
    case "pending":
      return `等待${verb}`;
  }
}

function summaryVerb(status: ParsedFileChange["status"], operation: FileChangeOperation): string {
  const verb = operationVerb(operation);
  switch (status) {
    case "applied":
      return pastVerb(operation);
    case "rejected":
      return "已拒绝";
    case "failed":
      return `${verb}失败`;
    case "running":
      return `正在${verb}`;
    case "pending":
      return `等待${verb}`;
  }
}

function inlineOperationVerb(operation: FileChangeOperation): string {
  switch (operation) {
    case "add":
      return "创建";
    case "delete":
      return "删除";
    case "append":
    case "update":
    case "write":
    case "unknown":
      return "编辑";
  }
}

function inlinePastVerb(operation: FileChangeOperation): string {
  switch (operation) {
    case "add":
      return "已创建";
    case "delete":
      return "已删除";
    case "append":
    case "update":
    case "write":
    case "unknown":
      return "已编辑";
  }
}

function operationVerb(operation: FileChangeOperation): string {
  switch (operation) {
    case "add":
      return "创建文件";
    case "delete":
      return "删除文件";
    case "append":
    case "update":
    case "write":
    case "unknown":
      return "编辑文件";
  }
}

function pastVerb(operation: FileChangeOperation): string {
  switch (operation) {
    case "add":
      return "创建了";
    case "delete":
      return "删除了";
    case "append":
    case "update":
    case "write":
    case "unknown":
      return "编辑了";
  }
}

function commonOperation(files: FileChangeFile[]): FileChangeOperation {
  const first = files[0]?.operation ?? "unknown";
  return first !== "unknown" && files.every((file) => file.operation === first) ? first : "unknown";
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

function toolNameFromMessage(message: ConversationMessage): string {
  const call = asRecord(message.payload.call);
  return (
    stringValue(call?.name) ||
    stringValue(message.payload.tool) ||
    stringValue(message.payload.tool_name) ||
    stringValue(message.payload.toolName)
  );
}

function operationFromToolName(toolName: string): FileChangeOperation {
  if (toolName === "create_file") {
    return "add";
  }
  if (toolName === "write_file") {
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

function changeIcon(operation: FileChangeOperation, failed: boolean) {
  if (failed) {
    return <XCircle size={16} />;
  }
  switch (operation) {
    case "add":
    case "write":
      return <FilePenLine size={16} />;
    case "delete":
      return <FileX2 size={16} />;
    case "append":
    case "update":
      return <FilePenLine size={16} />;
    case "unknown":
      return <FileDiff size={16} />;
  }
}

function countDiff(value: unknown, prefix: "+" | "-"): number {
  const ignored = prefix === "+" ? "+++" : "---";
  return stringValue(value)
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(ignored)).length;
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

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
