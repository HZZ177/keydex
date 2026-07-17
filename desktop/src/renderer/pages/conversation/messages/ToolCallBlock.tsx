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
import { lazy, Suspense, useMemo, useState } from "react";

import { fileReviewDocumentFromMessage } from "@/renderer/components/diff/adapters/fileReviewDocument";
import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import { useTargetedCopyFeedback, type CopyFeedbackStatus } from "@/renderer/hooks/useCopyFeedback";
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
const MCP_UNKNOWN_SERVER_LABEL = "未知 MCP 服务";
const LazyCompactDiffView = lazy(async () => {
  const module = await import("@/renderer/components/diff/wrappers/CompactDiffView");
  return { default: module.CompactDiffView };
});

export interface ToolCallBlockProps {
  message: ConversationMessage;
  onPreviewFile?: (file: FileChangePreview) => void;
  onLoadDetails?: ToolDetailsLoader;
}

type CopyTarget = "input" | "output";
type CopyStatus = CopyFeedbackStatus;

export function ToolCallBlock({ message, onPreviewFile, onLoadDetails }: ToolCallBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedReviewPath, setExpandedReviewPath] = useState<string | null>(null);
  const { getCopyStatus, showCopyFeedback } = useTargetedCopyFeedback<CopyTarget>();
  const details = useLazyToolDetails(message, onLoadDetails);
  const tool = useMemo(() => parseToolPayload(details.message), [details.message]);
  const diffDocument = useMemo(
    () => fileReviewDocumentFromMessage(details.message, tool.target, {
      sessionId: details.message.threadId,
      requestId: details.message.itemId ?? details.message.id,
    }),
    [details.message, tool.fileChanges, tool.target],
  );
  const running = details.message.status === "pending" || details.message.status === "running";
  const cancelled = details.message.status === "cancelled" || tool.resultStatus === "cancelled";
  const failed = details.message.status === "failed" || tool.resultStatus === "error";
  const footerLabel = details.loading
    ? "加载中"
    : details.error
      ? "加载失败"
      : running
        ? "运行中"
        : cancelled
          ? "已取消"
          : failed
            ? tool.mcp?.errorLabel || "失败"
            : "成功";
  const footerState = details.error || failed ? "failed" : details.loading || running ? "running" : "done";
  const detailsMotion = useDeferredUnmount<HTMLDivElement>(detailsOpen);
  const captureExpansionAnchor = useExpansionScrollAnchor();

  const handleCopy = async (target: CopyTarget, text: string) => {
    try {
      await copyText(text);
      showCopyFeedback(target, "copied");
    } catch {
      showCopyFeedback(target, "failed");
    }
  };
  const inputCopyStatus = getCopyStatus("input");
  const outputCopyStatus = getCopyStatus("output");

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
                    document={diffDocument}
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
          {tool.mcp ? <div className={styles.mcpMeta}>{mcpInlineLabel(tool.mcp)}</div> : null}
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
                document={diffDocument}
                detailsError={Boolean(details.error)}
                detailsLoading={details.loading}
                errorText={tool.errorPreview || readableErrorText(tool.resultText)}
                expandedPath={expandedReviewPath}
                failed={failed}
                footerLabel={footerLabel}
                footerState={footerState}
                message={details.message}
                running={running}
                tool={tool}
                onExpandedPathChange={setExpandedReviewPath}
                onPreviewFile={onPreviewFile}
              />
            ) : (
              <>
                <section className={styles.detailSection} aria-label="工具入参">
                  <div className={styles.toolNameRow}>
                    <span className={styles.toolNameLabel}>工具</span>
                    <code className={styles.toolNameValue}>{tool.name}</code>
                  </div>
                  {tool.mcp ? <McpToolDetails mcp={tool.mcp} /> : null}
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
  document,
  files,
  message,
  onPreviewFile,
  path,
  title,
}: {
  diff: string;
  document: ReturnType<typeof fileReviewDocumentFromMessage>;
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
        onPreviewFile({ path, diff, files, document, message, title });
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
  document,
  detailsError,
  detailsLoading,
  errorText,
  expandedPath,
  failed,
  footerLabel,
  footerState,
  message,
  running,
  tool,
  onExpandedPathChange,
  onPreviewFile,
}: {
  document: ReturnType<typeof fileReviewDocumentFromMessage>;
  detailsError: boolean;
  detailsLoading: boolean;
  errorText: string;
  expandedPath: string | null;
  failed: boolean;
  footerLabel: string;
  footerState: "failed" | "running" | "done";
  message: ConversationMessage;
  running: boolean;
  tool: ParsedToolPayload;
  onExpandedPathChange: (path: string | null) => void;
  onPreviewFile?: (file: FileChangePreview) => void;
}) {
  const diffDocument = document;
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
  const activeFileId = diffDocument.files.find((file) => [
    file.displayPath,
    file.oldPath,
    file.newPath,
  ].includes(selectedFile.path))?.id ?? diffDocument.files[0]?.id ?? null;

  return (
    <section
      className={styles.fileReviewSection}
      aria-label={fileReviewHeading(tool)}
    >
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
                  onClick={() => onExpandedPathChange(file.path)}
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
      <Suspense fallback={<div className={styles.fileReviewNotice}>正在加载文件差异</div>}>
        <LazyCompactDiffView
          document={diffDocument}
          activeFileId={activeFileId}
          defaultExpanded
          onActiveFileChange={(fileId) => {
            const file = diffDocument.files.find((item) => item.id === fileId);
            if (file) onExpandedPathChange(file.displayPath);
          }}
          actions={{
            copyPatch: copyText,
            ...(onPreviewFile ? {
              openFile: (path: string) => {
                const file = tool.fileChanges.find((item) => [item.path, item.oldPath, item.newPath].includes(path))
                  ?? selectedFile;
                onPreviewFile({
                  path: file.path,
                  diff: file.diff,
                  files: tool.fileChanges,
                  document: diffDocument,
                  message,
                  title: tool.title,
                });
              },
            } : {}),
          }}
        />
      </Suspense>
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
  if (tool.name === "move_file" || tool.fileChanges.some((file) => file.operation === "move")) {
    return "已移动的文件";
  }
  return "已编辑的文件";
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
  mcp: ParsedMcpToolMetadata | null;
}

interface ParsedMcpToolMetadata {
  serverId: string;
  serverName: string;
  rawToolName: string;
  modelToolName: string;
  approvalMode: string;
  snapshotId: string;
  errorType: string;
  errorLabel: string;
}

function parseToolPayload(message: ConversationMessage): ParsedToolPayload {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const args = asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? {};
  const summary = asRecord(message.payload.toolSummary) ?? {};
  const name = stringValue(call?.name) || stringValue(message.payload.tool) || stringValue(message.payload.tool_name) || message.content || "未知工具";
  const resultStatus = stringValue(result?.status);
  const mcp = mcpMetadataFromMessage(message, name, result);
  const target = toolTarget(args, message.payload, summary);
  const fileChanges = isFileMutationTool(name) ? fileReviewChangesFromMessage(message, target) : [];
  const actionLabel = mcp
    ? mcpToolActionLabel(mcp.rawToolName || name, message.status, resultStatus)
    : toolActionLabel(name, message.status, resultStatus, fileChanges);
  const outputText = resultText(result, message.payload);
  const fileChange = fileChanges.length === 1 ? fileChanges[0] : null;
  const rawErrorText = errorText(result, message.payload, outputText);
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
    errorPreview: truncateInlineError(mcpErrorPreview(mcp, rawErrorText)),
    mcp,
  };
}

function McpToolDetails({ mcp }: { mcp: ParsedMcpToolMetadata }) {
  const rawRows: Array<[string, string, boolean]> = [
    ["服务", mcp.serverName || mcp.serverId || MCP_UNKNOWN_SERVER_LABEL, false],
    ["工具", mcp.rawToolName, true],
    ["工具名称", mcp.modelToolName, true],
    ["确认方式", mcpApprovalModeLabel(mcp.approvalMode), false],
    ["本次工具版本", mcp.snapshotId, true],
  ];
  const rows = rawRows.filter(([, value]) => Boolean(value));

  if (!rows.length) {
    return null;
  }
  return (
    <dl className={styles.mcpDetailGrid} aria-label="MCP 工具元信息">
      {rows.map(([label, value, mono]) => (
        <div className={styles.mcpDetailItem} key={String(label)}>
          <dt>{label}</dt>
          <dd data-mono={mono ? "true" : "false"} title={String(value)}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function mcpMetadataFromMessage(
  message: ConversationMessage,
  toolName: string,
  result: Record<string, unknown> | null,
): ParsedMcpToolMetadata | null {
  const call = asRecord(message.payload.call);
  const metadata = asRecord(message.payload.metadata);
  const callMetadata = asRecord(call?.metadata);
  const resultMetadata = asRecord(result?.metadata);
  const resultUiPayload = asRecord(result?.ui_payload);
  const resultUiPayloadMetadata = asRecord(resultUiPayload?.metadata);
  const resultModelContent = parseJsonRecord(stringValue(result?.model_content));
  const resultModelContentMetadata = asRecord(resultModelContent?.metadata);
  const mcpRecords = [
    asRecord(metadata?.mcp),
    asRecord(callMetadata?.mcp),
    asRecord(resultMetadata?.mcp),
    asRecord(resultUiPayloadMetadata?.mcp),
    asRecord(resultUiPayload?.mcp),
    asRecord(resultModelContentMetadata?.mcp),
    asRecord(resultModelContent?.mcp),
    asRecord(message.payload.mcp),
    asRecord(call?.mcp),
    asRecord(result?.mcp),
    mcpLikeRecord(message.payload),
    mcpLikeRecord(call ?? {}),
    mcpLikeRecord(result ?? {}),
  ].filter((record): record is Record<string, unknown> => Boolean(record));
  const merged = Object.assign({}, ...mcpRecords);
  const kind = stringValue(merged.kind) || stringValue(message.payload.kind) || stringValue(call?.kind) || stringValue(result?.kind);
  const modelToolName =
    stringValue(merged.model_tool_name) ||
    stringValue(merged.modelToolName) ||
    stringValue(merged.model_name) ||
    (toolName.startsWith("mcp__") ? toolName : "");
  const rawToolName =
    stringValue(merged.raw_tool_name) ||
    stringValue(merged.rawToolName) ||
    stringValue(merged.tool_name) ||
    stringValue(merged.toolName) ||
    rawToolNameFromModelName(modelToolName) ||
    (toolName.startsWith("mcp__") ? rawToolNameFromModelName(toolName) : "");
  const serverId = stringValue(merged.server_id) || stringValue(merged.serverId);
  const serverName = nullableString(merged.server_name) ?? nullableString(merged.serverName) ?? "";
  const hasMcpSignal =
    kind === "mcp_tool" ||
    kind === "mcp_tool_call" ||
    Boolean(serverId || serverName || rawToolName || modelToolName || toolName.startsWith("mcp__"));
  if (!hasMcpSignal) {
    return null;
  }
  const errorType = mcpErrorTypeFromRecords([result ?? {}, message.payload, merged]);
  return {
    serverId,
    serverName: serverName || serverId || MCP_UNKNOWN_SERVER_LABEL,
    rawToolName: rawToolName || toolName,
    modelToolName: modelToolName || toolName,
    approvalMode: stringValue(merged.approval_mode) || stringValue(merged.approvalMode),
    snapshotId: stringValue(merged.snapshot_id) || stringValue(merged.snapshotId),
    errorType,
    errorLabel: mcpErrorLabel(errorType),
  };
}

function mcpLikeRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  if (
    record.kind === "mcp_tool" ||
    record.kind === "mcp_tool_call" ||
    record.server_id ||
    record.serverName ||
    record.raw_tool_name ||
    record.model_tool_name
  ) {
    return record;
  }
  return null;
}

function rawToolNameFromModelName(name: string): string {
  const match = name.match(/^mcp__.+__(.+)$/);
  return match?.[1] ?? "";
}

function mcpInlineLabel(mcp: ParsedMcpToolMetadata): string {
  return `MCP · ${mcp.serverName || MCP_UNKNOWN_SERVER_LABEL} · ${mcp.rawToolName || mcp.modelToolName || "未知工具"}`;
}

function mcpToolActionLabel(
  rawToolName: string,
  status: ConversationMessage["status"],
  resultStatus: string | null,
): string {
  const failed = status === "failed" || resultStatus === "error";
  const prefix = failed
    ? "MCP 工具调用失败"
    : status === "pending"
      ? "等待调用 MCP 工具"
      : status === "running"
        ? "正在调用 MCP 工具"
        : status === "cancelled" || resultStatus === "cancelled"
          ? "已取消 MCP 工具"
          : "已调用 MCP 工具";
  return `${prefix} ${rawToolName || "未知工具"}`;
}

function mcpErrorPreview(mcp: ParsedMcpToolMetadata | null, rawText: string): string {
  const label = mcp?.errorLabel ?? "";
  if (!label) {
    return rawText;
  }
  if (!rawText || rawText === label) {
    return label;
  }
  return `${label}：${rawText}`;
}

function mcpErrorTypeFromRecords(records: Array<Record<string, unknown>>): string {
  for (const record of records) {
    const direct =
      stringValue(record.error_type) ||
      stringValue(record.errorType) ||
      stringValue(record.error_code) ||
      stringValue(record.errorCode) ||
      stringValue(record.code) ||
      stringValue(record.type);
    if (direct) {
      return direct;
    }
    const error = asRecord(record.error);
    if (error) {
      const nested =
        stringValue(error.error_type) ||
        stringValue(error.errorType) ||
        stringValue(error.error_code) ||
        stringValue(error.errorCode) ||
        stringValue(error.code) ||
        stringValue(error.type);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

function mcpErrorLabel(type: string): string {
  switch (type) {
    case "server_disabled":
      return "MCP 服务已停用";
    case "server_offline":
      return "MCP 服务离线";
    case "tool_disabled_by_policy":
      return "该 MCP 工具已停用";
    case "tool_disabled_by_session":
      return "当前会话已禁用该 MCP 工具";
    case "approval_rejected":
      return "用户未批准该 MCP 工具调用";
    case "auth_required":
      return "MCP 服务需要重新授权";
    case "timeout":
      return "MCP 工具调用超时";
    case "cancelled_by_user":
      return "MCP 工具调用已停止";
    case "protocol_error":
      return "MCP 协议响应异常";
    case "result_too_large":
      return "MCP 工具结果过大";
    default:
      return "";
  }
}

function mcpApprovalModeLabel(mode: string): string {
  switch (mode) {
    case "auto":
      return "始终允许";
    case "approve":
      return "始终允许";
    case "prompt":
      return "每次确认";
    case "trusted":
      return "信任名单允许";
    case "inherit":
      return "继承服务器";
    case "disabled":
    case "deny":
      return "拒绝调用";
    default:
      return "未知";
  }
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

function parseJsonRecord(value: string): Record<string, unknown> | null {
  if (!value.trim()) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function toolActionLabel(
  name: string,
  status: ConversationMessage["status"],
  resultStatus: string | null,
  fileChanges: ToolFileChange[] = [],
): string {
  const action = toolActionForFileChanges(name, fileChanges) ?? toolAction(name);
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

function toolActionForFileChanges(name: string, fileChanges: ToolFileChange[]): ToolAction | null {
  if (!["apply_patch", "edit_file"].includes(name) || fileChanges.length === 0) {
    return null;
  }
  const operations = new Set(fileChanges.map((change) => change.operation));
  if (operations.size !== 1) {
    return null;
  }
  const [operation] = [...operations];
  if (operation === "add") {
    return toolAction("create_file");
  }
  if (operation === "delete") {
    return toolAction("delete_file");
  }
  if (operation === "move") {
    return toolAction("move_file");
  }
  return null;
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
  if (name === "move_file") {
    return {
      done: "已移动文件",
      running: "正在移动文件",
      pending: "等待移动文件",
      failed: "移动文件失败",
      cancelled: "已取消移动文件",
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
  if (name === "move_file") {
    return <FilePenLine size={16} />;
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
    stringValue(args.new_path) ||
    stringValue(args.newPath) ||
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

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() ? value : null;
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
