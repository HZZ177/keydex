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

import { FileReviewCard } from "@/renderer/components/review/FileReviewDiff";
import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import {
  fileReviewChangesFromMessage,
  isFileMutationToolName,
  type FileReviewChange,
} from "@/renderer/utils/fileReview";

import { formatErrorText, readableErrorText } from "./errorText";
import type { FileChangePreview } from "./FileChangeBlock";
import { LineChangeTicker } from "./LineChangeTicker";
import { copyText } from "./markdown";
import styles from "./ToolCallBlock.module.css";
import { useLazyToolDetails, type ToolDetailsLoader } from "./useLazyToolDetails";
import { useDeferredUnmount } from "./useDeferredUnmount";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";

const INLINE_ERROR_MAX_CHARS = 240;

export interface ToolCallBlockProps {
  message: ConversationMessage;
  onPreviewFile?: (file: FileChangePreview) => void;
  onLoadDetails?: ToolDetailsLoader;
}

type CopyTarget = "input" | "output";
type CopyStatus = "idle" | "copied" | "failed";

export function ToolCallBlock({ message, onPreviewFile, onLoadDetails }: ToolCallBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedReviewPath, setExpandedReviewPath] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ target: CopyTarget; status: Exclude<CopyStatus, "idle"> } | null>(null);
  const details = useLazyToolDetails(message, onLoadDetails);
  const tool = useMemo(() => parseToolPayload(details.message), [details.message]);
  const running = details.message.status === "pending" || details.message.status === "running";
  const failed = details.message.status === "failed" || tool.resultStatus === "error";
  const footerLabel = details.loading
    ? "加载中"
    : details.error
      ? "加载失败"
      : running
        ? "运行中"
        : failed
          ? "失败"
          : "成功";
  const footerState = details.error || failed ? "failed" : details.loading || running ? "running" : "done";
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
      <div
        className={styles.header}
        role="button"
        tabIndex={0}
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
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
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
            {toolIcon(tool.name, failed)}
          </span>
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>
            {tool.fileTarget && tool.target ? (
              <>
                <span>{tool.actionLabel}</span>
                  <span> </span>
                  <FileTarget
                    diff={tool.fileChange?.diff ?? ""}
                    files={tool.fileChanges}
                    message={details.message}
                    onPreviewFile={onPreviewFile}
                    path={tool.target}
                    title={tool.title}
                  />
                </>
              ) : (
              tool.title
            )}
          </div>
          {tool.fileChange && !failed && hasLineDeltas(tool.fileChange) ? (
            <LineChangeTicker
              className={styles.inlineTicker}
              label=""
              added={tool.fileChange.additions}
              removed={tool.fileChange.deletions}
              unit=""
            />
          ) : null}
          {tool.duration ? <div className={styles.meta}>{tool.duration}</div> : null}
        </div>
        <span className={styles.trailingIcon} aria-hidden="true">
          <ChevronDown className={styles.chevron} size={14} />
        </span>
      </div>

      {failed && tool.errorPreview ? (
        <p className={styles.errorMessage}>错误信息：{tool.errorPreview}</p>
      ) : null}

      {detailsMotion.shouldRender ? (
        <div
          className={styles.details}
          data-motion={detailsMotion.phase}
          ref={detailsMotion.ref}
          style={detailsMotion.style}
          aria-hidden={!detailsOpen}
          aria-label="工具详情"
        >
          <div className={styles.detailsInner} data-kind={tool.fileTarget ? "file-review" : "raw"}>
            {tool.fileTarget ? (
              <FileMutationDetails
                detailsError={Boolean(details.error)}
                detailsLoading={details.loading}
                errorText={tool.errorPreview || readableErrorText(tool.resultText)}
                expandedPath={expandedReviewPath}
                failed={failed}
                footerLabel={footerLabel}
                footerState={footerState}
                running={running}
                tool={tool}
                onExpandedPathChange={setExpandedReviewPath}
              />
            ) : (
              <>
                <section className={styles.detailSection} aria-label="工具入参">
                  <div className={styles.toolNameRow}>
                    <span className={styles.toolNameLabel}>工具</span>
                    <code className={styles.toolNameValue}>{tool.name}</code>
                  </div>
                  <div className={styles.sectionHeader} data-kind="input">
                    <div className={styles.outputHeader}>入参</div>
                    <button
                      className={styles.copyButton}
                      type="button"
                      aria-label={copyAriaLabel("入参", inputCopyStatus)}
                      data-tooltip-label={copyAriaLabel("入参", inputCopyStatus)}
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
                      data-tooltip-label={copyAriaLabel("输出", outputCopyStatus)}
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
                  <div className={styles.panelFooter} data-state={footerState}>
                    {footerLabel}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function hasLineDeltas(file: ToolFileChange): boolean {
  return file.additions > 0 || file.deletions > 0;
}

function FileTarget({
  diff,
  files,
  message,
  onPreviewFile,
  path,
  title,
}: {
  diff: string;
  files: ToolFileChange[];
  message: ConversationMessage;
  onPreviewFile?: (file: FileChangePreview) => void;
  path: string;
  title: string;
}) {
  if (!onPreviewFile) {
    return (
      <span className={styles.fileTarget}>
        <ToolFileTargetIcon path={path} />
        <span className={styles.fileTargetLabel}>{path}</span>
      </span>
    );
  }
  return (
    <button
      className={styles.fileTargetButton}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onPreviewFile({ path, diff, files, message, title });
      }}
    >
      <ToolFileTargetIcon path={path} />
      <span className={styles.fileTargetLabel}>{path}</span>
    </button>
  );
}

function ToolFileTargetIcon({ path }: { path: string }) {
  const icon = useMaterialEntryIcon(path, "file");
  return (
    <img
      alt=""
      aria-hidden="true"
      className={styles.fileTargetIcon}
      data-icon-id={icon.id}
      data-tool-file-target-icon="true"
      draggable={false}
      src={icon.src}
    />
  );
}

function FileMutationDetails({
  detailsError,
  detailsLoading,
  errorText,
  expandedPath,
  failed,
  footerLabel,
  footerState,
  running,
  tool,
  onExpandedPathChange,
}: {
  detailsError: boolean;
  detailsLoading: boolean;
  errorText: string;
  expandedPath: string | null;
  failed: boolean;
  footerLabel: string;
  footerState: "failed" | "running" | "done";
  running: boolean;
  tool: ParsedToolPayload;
  onExpandedPathChange: (path: string | null) => void;
}) {
  if (detailsLoading) {
    return <ToolDetailNotice text="正在加载文件变更详情" state={footerState} footerLabel={footerLabel} />;
  }
  if (detailsError) {
    return <ToolDetailNotice text="文件变更详情加载失败" state="failed" footerLabel={footerLabel} />;
  }
  if (failed) {
    return <FileMutationErrorPanel tool={tool} errorText={errorText} footerLabel={footerLabel} footerState={footerState} />;
  }
  if (!tool.fileChanges.length) {
    return (
      <ToolDetailNotice
        text={running ? "正在等待文件变更" : "这次工具调用没有可审阅的文件变更"}
        state={footerState}
        footerLabel={footerLabel}
      />
    );
  }

  const selectedFile =
    tool.fileChanges.find((file) => file.path === expandedPath) ??
    tool.fileChanges[0];

  return (
    <section className={styles.fileReviewSection} aria-label={fileReviewHeading(tool)}>
      {tool.fileChanges.length > 1 ? (
        <ul className={styles.fileReviewList} aria-label="变更文件">
          {tool.fileChanges.map((file) => {
            const active = file.path === selectedFile.path;
            return (
              <li key={file.path}>
                <button
                  className={styles.fileReviewListButton}
                  data-active={active ? "true" : "false"}
                  type="button"
                  onClick={() => onExpandedPathChange(active ? null : file.path)}
                >
                  <span className={styles.fileReviewPath}>
                    <ToolFileTargetIcon path={file.path} />
                    <span>{file.path}</span>
                  </span>
                  <span className={styles.fileReviewStats}>+{file.additions} -{file.deletions}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <FileReviewCard file={selectedFile} />
      <div className={styles.panelFooter} data-state={footerState}>
        {footerLabel}
      </div>
    </section>
  );
}

function ToolDetailNotice({
  text,
  state,
  footerLabel,
}: {
  text: string;
  state: "failed" | "running" | "done";
  footerLabel: string;
}) {
  return (
    <section className={styles.fileReviewSection} aria-label={text}>
      <div className={styles.fileReviewNotice}>{text}</div>
      <div className={styles.panelFooter} data-state={state}>
        {footerLabel}
      </div>
    </section>
  );
}

function FileMutationErrorPanel({
  errorText,
  footerLabel,
  footerState,
  tool,
}: {
  errorText: string;
  footerLabel: string;
  footerState: "failed" | "running" | "done";
  tool: ParsedToolPayload;
}) {
  return (
    <section className={styles.fileReviewSection} aria-label="文件编辑错误">
      <header className={styles.fileReviewHeading}>
        <span>{fileReviewHeading(tool)}</span>
      </header>
      <div className={styles.fileReviewError}>
        <span>工具执行失败</span>
        <pre>{errorText || "工具执行失败，未返回详细错误信息"}</pre>
      </div>
      {tool.fileChanges.length ? (
        <ul className={styles.fileReviewList} aria-label="失败文件">
          {tool.fileChanges.map((file) => (
            <li key={file.path}>
              <span className={styles.fileReviewFailedPath}>{file.path}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.panelFooter} data-state={footerState}>
        {footerLabel}
      </div>
    </section>
  );
}

function fileReviewHeading(tool: ParsedToolPayload): string {
  if (tool.name === "create_file" || tool.name === "write_file") {
    return "已创建的文件";
  }
  if (tool.name === "delete_file") {
    return "已删除的文件";
  }
  return "已编辑的文件";
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
  fileChange: ToolFileChange | null;
  fileChanges: ToolFileChange[];
  argsText: string;
  resultText: string;
  resultStatus: string | null;
  duration: string;
  errorPreview: string;
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
  const outputText = resultText(result, message.payload);
  const fileChanges = isFileMutationTool(name) ? fileReviewChangesFromMessage(message, target) : [];
  const fileChange = fileChanges.length === 1 ? fileChanges[0] : null;
  return {
    name,
    title: target ? `${actionLabel} ${target}` : actionLabel,
    actionLabel,
    target,
    fileTarget: isFileMutationTool(name),
    fileChange,
    fileChanges,
    argsText: stringify(args),
    resultText: outputText,
    resultStatus,
    duration: formatDuration(result?.duration_ms ?? result?.durationMs ?? message.payload.duration_ms ?? message.payload.durationMs),
    errorPreview: truncateInlineError(errorText(result, message.payload, outputText)),
  };
}

type ToolFileChange = FileReviewChange;

function errorText(
  result: Record<string, unknown> | null,
  payload: Record<string, unknown>,
  outputText: string,
): string {
  return (
    formatErrorText(result?.error) ||
    formatErrorText(payload.error) ||
    readableErrorText(outputText)
  );
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
  if (["grep_files", "search_files"].includes(name)) {
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
  if (["search", "grep"].includes(name)) {
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
  return isFileMutationToolName(name);
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

function truncateInlineError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= INLINE_ERROR_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, INLINE_ERROR_MAX_CHARS - 1)}…`;
}
