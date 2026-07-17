import { AlertTriangle, ChevronRight, FileCode2, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { reverseDocumentFromFiles } from "@/renderer/components/diff/adapters/reverseDocument";
import { ReviewDiffView } from "@/renderer/components/diff/wrappers/ReviewDiffView";
import type {
  SessionReverseDecision,
  SessionReverseFilePreview,
  SessionReverseMode,
} from "@/runtime";

import type { ReverseDialogState } from "./useConversationPanelModel";

import styles from "./ReverseDialog.module.css";

export interface ReverseDialogProps {
  state: ReverseDialogState;
  onCancel: () => void;
  onConfirm: () => void;
  onSelectMode: (mode: SessionReverseMode) => void;
  onExternalConfirmationChange?: (confirmed: boolean) => void;
  onDecision: (decision: SessionReverseDecision) => void;
  onRetryPreview: () => void;
}

const MODES: Array<{
  value: SessionReverseMode;
  label: string;
  description: string;
}> = [
  {
    value: "both",
    label: "同时回溯修改和对话",
    description: "恢复目标消息发送前的文件，并删除该消息及之后的对话。",
  },
  {
    value: "code",
    label: "只回溯修改",
    description: "只恢复文件；对话、消息和输入框保持不变。",
  },
  {
    value: "conversation",
    label: "只回溯对话",
    description: "只删除后续对话并恢复输入；修改过的文件不会回滚。",
  },
];

export function ReverseDialog({
  state,
  onCancel,
  onConfirm,
  onSelectMode,
  onExternalConfirmationChange,
  onDecision,
  onRetryPreview,
}: ReverseDialogProps) {
  const preview = state.preview;
  const summary = state.candidate.content.trim().split(/\r?\n/u).find(Boolean) ?? "这一轮对话";

  return (
    <AppDialog
      title={dialogTitle(state)}
      description={dialogDescription(state)}
      size="form"
      closeOnOverlayClick={!state.executing}
      closeOnEscape={!state.executing}
      onClose={state.executing ? undefined : onCancel}
      panelClassName={styles.dialog}
      bodyClassName={styles.body}
      footer={
        <DialogFooter
          state={state}
          onCancel={onCancel}
          onConfirm={onConfirm}
          onRetryPreview={onRetryPreview}
        />
      }
    >
      <p className={styles.target} title={summary}>
        回溯目标：{summary}
      </p>
      {state.loading ? (
        <div className={styles.loading} role="status">
          <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
          正在检查可回溯的内容…
        </div>
      ) : null}
      {state.error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>
            {errorLabel(state.errorCode)}
            {isBlockedError(state.errorCode) && state.preview ? (
              <IssueDetails operationId={state.preview.operation_id} />
            ) : null}
          </span>
        </div>
      ) : null}
      {preview && state.phase !== "result" ? (
        <>
          <section className={styles.section} aria-labelledby="reverse-mode-heading">
            <h3 id="reverse-mode-heading">选择回溯范围</h3>
            <div className={styles.modeList}>
              {MODES.map((mode) => {
                const disabled = mode.value !== "conversation" && !preview.code_available;
                return (
                  <label className={styles.modeRow} data-disabled={disabled || undefined} key={mode.value}>
                    <input
                      type="radio"
                      name="reverse-mode"
                      value={mode.value}
                      checked={state.mode === mode.value}
                      disabled={disabled || state.executing}
                      onChange={() => onSelectMode(mode.value)}
                    />
                    <span>
                      <strong>{mode.label}</strong>
                      <small>{mode.description}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            {state.mode === "conversation" ? (
              <p className={styles.notice}>
                仅回溯对话，修改过的文件不会回滚。
              </p>
            ) : !preview.code_available ? (
              <p className={styles.notice}>
                这条消息之前没有文件修改记录，因此只能回溯对话。
              </p>
            ) : null}
          </section>
          {state.mode !== "conversation" && preview.requires_external_confirmation ? (
            <label className={styles.externalConfirmation}>
              <input
                type="checkbox"
                checked={state.externalPathsConfirmed ?? false}
                disabled={state.executing}
                onChange={(event) => onExternalConfirmationChange?.(event.currentTarget.checked)}
              />
              <span>
                <strong>确认恢复工作区外文件</strong>
                <small>以下绝对路径将被文件历史版本覆盖：</small>
                {preview.external_paths.map((path) => <code key={path}>{path}</code>)}
              </span>
            </label>
          ) : null}
          {state.mode !== "conversation" ? (
            state.phase === "decision" ? (
              <ReverseDecisionPanel state={state} onDecision={onDecision} />
            ) : (
              <ReverseFilePreview state={state} />
            )
          ) : null}
        </>
      ) : null}
      {state.result ? <ReverseResult state={state} /> : null}
    </AppDialog>
  );
}

type DecisionAction = "cancel" | "safe_partial" | "force_conflicts";

const DECISION_HELP: Record<DecisionAction, string> = {
  cancel: "不回溯文件或对话，保留当前内容。",
  safe_partial: "跳过上方文件，只回溯其他文件；对话按上方选择处理。",
  force_conflicts: "回溯包括上方文件在内的所有文件，并覆盖其他来源的修改。",
};

function ReverseDecisionPanel({
  state,
  onDecision,
}: {
  state: ReverseDialogState;
  onDecision: (decision: SessionReverseDecision) => void;
}) {
  const preview = state.preview;
  const [activeAction, setActiveAction] = useState<DecisionAction | null>(null);
  if (!preview) {
    return null;
  }
  const files = preview.files.filter((file) => file.classification !== "ready");
  const hasReady = preview.files.some((file) => file.classification === "ready");
  const canRestoreAll =
    files.length > 0 && files.every((file) => file.classification === "forceable_conflict");
  const hasUnavailable = files.some((file) => file.classification === "unrecoverable");
  const externalConfirmationMissing =
    preview.requires_external_confirmation && !state.externalPathsConfirmed;
  const actionProps = (action: DecisionAction) => ({
    onBlur: () => setActiveAction(null),
    onFocus: () => setActiveAction(action),
    onMouseEnter: () => setActiveAction(action),
    onMouseLeave: () => setActiveAction(null),
  });

  return (
    <section
      className={`${styles.section} ${styles.fileSection} ${styles.decisionSection}`}
      aria-labelledby="reverse-decision-heading"
      data-testid="reverse-decision-panel"
    >
      <div className={styles.sectionHeading}>
        <h3 id="reverse-decision-heading">需要确认的文件</h3>
        <span>{files.length} 个文件</span>
      </div>
      <p className={styles.decisionIntro}>
        {hasUnavailable
          ? "以下文件无法直接回溯，请选择只处理其他文件或取消。"
          : "以下文件已在其他对话或应用中修改，回溯所有文件会覆盖这些修改。"}
      </p>
        <ReverseFileGroups
          files={files}
          operationId={preview.operation_id}
        className={styles.decisionFileList}
        ariaLabel="需要确认的文件"
      />
      <div className={styles.decisionControls}>
        <div className={styles.decisionActions} role="group" aria-label="选择文件处理方式">
          <DialogButton
            disabled={state.executing}
            onClick={() => onDecision("cancel")}
            {...actionProps("cancel")}
          >
            取消回溯
          </DialogButton>
          <DialogButton
            disabled={state.executing || !hasReady || externalConfirmationMissing}
            onClick={() => onDecision("safe_partial")}
            {...actionProps("safe_partial")}
          >
            仅回溯其他文件
          </DialogButton>
          {canRestoreAll ? (
            <DialogButton
              tone="danger"
              disabled={state.executing || externalConfirmationMissing}
              onClick={() => onDecision("force_conflicts")}
              {...actionProps("force_conflicts")}
            >
              回溯所有文件
            </DialogButton>
          ) : null}
        </div>
        <p className={styles.decisionHelp} aria-live="polite" data-testid="reverse-decision-help">
          {activeAction ? DECISION_HELP[activeAction] : "将鼠标移到选项上查看说明。"}
        </p>
      </div>
    </section>
  );
}

function ReverseFilePreview({ state }: { state: ReverseDialogState }) {
  const preview = state.preview;
  if (!preview) {
    return null;
  }
  return (
    <section className={`${styles.section} ${styles.fileSection}`} aria-labelledby="reverse-files-heading">
      <div className={styles.sectionHeading}>
        <h3 id="reverse-files-heading">预计回溯</h3>
        <span>
          {preview.files.length} 个文件 · 涉及 {preview.insertions + preview.deletions} 行
        </span>
      </div>
      {preview.warnings.map((warning) => (
        <p className={styles.notice} key={warning}>{warningLabel(warning)}</p>
      ))}
      {preview.files.length ? (
        <ReverseFileGroups
          files={preview.files}
          operationId={preview.operation_id}
          className={styles.fileList}
          ariaLabel="预计回溯的文件"
          testId="reverse-file-list"
        />
      ) : (
        <p className={styles.empty}>文件已经是目标状态，无需修改。</p>
      )}
    </section>
  );
}

function ReverseFileGroups({
  files,
  className,
  ariaLabel,
  testId,
  operationId,
}: {
  files: SessionReverseFilePreview[];
  className: string;
  ariaLabel: string;
  testId?: string;
  operationId: string;
}) {
  return (
    <div className={className} aria-label={ariaLabel} data-testid={testId}>
      {groupFilesByScope(files).map((group) => (
        <div className={styles.scopeGroup} data-scope-kind={group.kind} key={group.key}>
          <div className={styles.scopeHeading}>
            <strong>{group.label}</strong>
            <span>{group.kind === "external" ? "工作区外" : "项目"} · {group.files.length} 个文件</span>
          </div>
          <div className={styles.scopeFiles}>
            {group.files.map((file) => (
              <ReverseFilePreviewItem
                file={file}
                key={fileResourceKey(file)}
                operationId={operationId}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function groupFilesByScope(files: SessionReverseFilePreview[]) {
  const groups = new Map<string, {
    key: string;
    kind: "workspace" | "external";
    label: string;
    files: SessionReverseFilePreview[];
  }>();
  for (const file of files) {
    const kind = file.scope_kind ?? "workspace";
    const identity = file.scope_identity || (kind === "workspace" ? "current" : file.absolute_path);
    const key = `${kind}:${identity}`;
    const group = groups.get(key) ?? {
      key,
      kind,
      label: file.scope_label || (kind === "workspace" ? "当前项目" : "外部文件"),
      files: [],
    };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function fileResourceKey(file: SessionReverseFilePreview): string {
  return file.resource_id || `${file.scope_kind ?? "workspace"}:${file.scope_identity ?? "current"}:${file.path}`;
}

function ReverseFilePreviewItem({
  file,
  operationId,
}: {
  file: SessionReverseFilePreview;
  operationId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = classificationLabel(file.classification, file.reason_code);
  const displayPath = file.display_path || file.path;
  const document = useMemo(
    () => reverseDocumentFromFiles([file], operationId),
    [file, operationId],
  );
  return (
    <details
      className={styles.fileRow}
      data-testid="reverse-file-preview"
      open={expanded}
    >
      <summary
        className={styles.fileSummary}
        onClick={(event) => {
          event.preventDefault();
          setExpanded((open) => !open);
        }}
      >
        <ChevronRight aria-hidden="true" className={styles.fileChevron} size={14} />
        <FileCode2 aria-hidden="true" size={14} />
        <code title={file.scope_kind === "external" ? file.absolute_path : displayPath}>{displayPath}</code>
        <span data-classification={file.classification}>{statusLabel}</span>
        <span
          className={styles.fileStats}
          aria-label={`新增 ${file.insertions} 行，删除 ${file.deletions} 行`}
        >
          <b data-kind="added">+{file.insertions}</b>
          <b data-kind="removed">-{file.deletions}</b>
        </span>
      </summary>
      {file.scope_kind === "external" && file.absolute_path ? (
        <p className={styles.externalPath} title={file.absolute_path}>{file.absolute_path}</p>
      ) : null}
      <div className={styles.fileExpanded}>
        {file.binary ? <p>该文件可以回溯，但不提供代码行预览。</p> : null}
        {file.truncated ? <p>内容较多，仅展示部分差异。</p> : null}
        {!file.binary && !file.truncated && !file.diff ? <p>没有需要展示的代码差异。</p> : null}
        {expanded ? (
          <ReviewDiffView
            document={document}
            focusedPath={displayPath}
            scrollScopeKey={`reverse:${operationId}:${fileResourceKey(file)}`}
          />
        ) : null}
      </div>
    </details>
  );
}

function ReverseResult({ state }: { state: ReverseDialogState }) {
  const result = state.result;
  if (!result) {
    return null;
  }
  const succeededFiles = uniqueFiles([...result.restored_files, ...result.forced_files]);
  const skippedFiles = uniqueFiles(result.skipped_files);
  const failedFiles = uniqueFiles(result.failed_files);
  const successfulResources = new Set(succeededFiles);
  const successfulChanges = (state.preview?.files ?? []).reduce(
    (total, file) => {
      if (successfulResources.has(file.resource_id) || successfulResources.has(file.path)) {
        total.insertions += file.insertions;
        total.deletions += file.deletions;
      }
      return total;
    },
    { insertions: 0, deletions: 0 },
  );
  const affectedLines = successfulChanges.insertions + successfulChanges.deletions;
  const conversationOnly = result.mode === "conversation" || result.decision === "conversation_only";
  const rows = [
    ["回溯成功", result.restored_files],
    ["强制回溯", result.forced_files],
    ["已跳过", result.skipped_files],
    ["回溯失败", result.failed_files],
  ] as const;
  return (
    <section className={styles.result} data-status={result.status} aria-live="polite">
      <strong>{resultLabel(result.status)}</strong>
      <p className={styles.resultSummary}>
        {conversationOnly
          ? "对话已恢复，修改过的文件未回滚。"
          : `共成功回溯 ${succeededFiles.length} 个文件，影响 ${affectedLines} 行代码。`}
      </p>
      <div className={styles.resultMetrics} aria-label="回溯结果统计">
        <ResultMetric label="成功文件" value={succeededFiles.length} />
        <ResultMetric label="影响代码行" value={affectedLines} />
        <ResultMetric label="跳过文件" value={skippedFiles.length} />
        <ResultMetric label="失败文件" value={failedFiles.length} />
      </div>
      {!conversationOnly && affectedLines > 0 ? (
        <p className={styles.lineBreakdown}>
          代码变化：增加 {successfulChanges.insertions} 行，删除 {successfulChanges.deletions} 行
        </p>
      ) : null}
      {rows.map(([label, files]) =>
        files.length ? (
          <div className={styles.resultFiles} key={label}>
            <b>{label}</b>
            <ul>
              {files.map((resourceId) => (
                <ResultFile
                  key={resourceId}
                  resourceId={resourceId}
                  previewFiles={state.preview?.files ?? []}
                />
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {result.status === "blocked" || result.status === "compensation_failed" ? (
        <p>部分文件没有恢复完成。请先检查失败文件，确认内容无误后再继续。</p>
      ) : null}
      {result.status !== "full" ? <IssueDetails operationId={result.operation_id} /> : null}
    </section>
  );
}

function ResultFile({
  resourceId,
  previewFiles,
}: {
  resourceId: string;
  previewFiles: SessionReverseFilePreview[];
}) {
  const file = previewFiles.find((item) => item.resource_id === resourceId);
  if (!file) {
    return <li><code>{resourceId}</code></li>;
  }
  const path = file.scope_kind === "external"
    ? file.absolute_path
    : file.display_path || file.path;
  return (
    <li>
      <code>{path}</code>
      <small>{file.scope_label}</small>
    </li>
  );
}

function ResultMetric({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <b>{value}</b>
      <small>{label}</small>
    </span>
  );
}

function IssueDetails({ operationId }: { operationId: string }) {
  return (
    <details className={styles.issueDetails}>
      <summary>查看问题详情</summary>
      <span>问题编号：<code>{operationId}</code></span>
    </details>
  );
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files)];
}

function DialogFooter({
  state,
  onCancel,
  onConfirm,
  onRetryPreview,
}: {
  state: ReverseDialogState;
  onCancel: () => void;
  onConfirm: () => void;
  onRetryPreview: () => void;
}) {
  if (state.phase === "result") {
    return <DialogButton onClick={onCancel}>关闭</DialogButton>;
  }
  if (state.errorCode === "file_preview_stale" || (!state.preview && state.error)) {
    return (
      <>
        <DialogButton onClick={onCancel}>取消</DialogButton>
        <DialogButton tone="primary" onClick={onRetryPreview}>重新预览</DialogButton>
      </>
    );
  }
  if (state.phase === "decision") {
    return null;
  }
  return (
    <>
      <DialogButton disabled={state.executing} onClick={onCancel}>取消</DialogButton>
      <DialogButton
        tone="danger"
        disabled={
          state.loading ||
          state.executing ||
          !state.preview ||
          (state.mode !== "conversation" &&
            state.preview.requires_external_confirmation &&
            !state.externalPathsConfirmed)
        }
        onClick={onConfirm}
      >
        {state.executing ? "正在回溯…" : "回溯到此处"}
      </DialogButton>
    </>
  );
}

function dialogTitle(state: ReverseDialogState): string {
  if (state.phase === "result") return "回溯结果";
  return "回溯到此处";
}

function dialogDescription(state: ReverseDialogState): string {
  if (state.phase === "result") return "查看本次回溯的文件和代码变化。";
  if (state.phase === "decision") return "确认被其他来源修改的文件要如何处理。";
  if (state.mode === "conversation") return "确认需要恢复的对话范围，修改过的文件不会回滚。";
  return "查看预计回溯的内容，再选择需要恢复的范围。";
}

function classificationLabel(classification: string, reason?: string | null): string {
  if (classification === "ready") return "可以回溯";
  if (classification === "forceable_conflict" && reason === "other_session_write") {
    return "另一个对话已修改";
  }
  if (classification === "forceable_conflict" && reason === "external_drift") {
    return "已在对话外修改";
  }
  if (classification === "forceable_conflict") return "已被其他内容修改";
  if (reason?.includes("backup_missing") || reason?.includes("backup_corrupt")) return "历史版本不可用";
  if (reason === "workspace_mismatch") return "不属于当前项目";
  if (reason?.includes("path") || reason?.includes("symlink")) return "文件位置不安全";
  return "无法自动回溯";
}

function warningLabel(warning: string): string {
  if (warning === "file_conflicts_detected" || warning === "shell_mcp_ide_writes_detected_as_drift_only") {
    return "部分文件在其他对话或应用中发生了变化，回溯前需要确认处理方式。";
  }
  if (warning === "file_snapshot_missing" || warning === "file_snapshot_unavailable") {
    return "这条消息之前没有可用的文件修改记录，因此只能回溯对话。";
  }
  if (warning === "file_backup_missing" || warning === "file_backup_corrupt") {
    return "部分文件的历史版本不可用，无法自动回溯。";
  }
  return "部分历史内容无法用于文件回溯。";
}

function resultLabel(status: string): string {
  if (status === "full") return "回溯完成";
  if (status === "partial") return "部分回溯完成";
  if (status === "compensated") return "回溯未完成，文件已恢复原状";
  if (status === "blocked" || status === "compensation_failed") return "回溯未完成";
  return "回溯结果";
}

function errorLabel(code: string | null): string {
  if (code === "file_preview_stale") return "文件状态已经变化，请重新检查后再回溯。";
  if (code === "file_restore_turn_running") return "当前回复仍在进行中，请先停止或等待完成后再回溯。";
  if (code === "file_restore_session_busy" || code === "file_restore_locked") {
    return "正在处理其他文件修改，请稍后再试。";
  }
  if (code === "file_restore_compensated") return "本次回溯未完成，文件已恢复到操作前状态。";
  if (code === "file_restore_compensation_failed" || code === "file_restore_blocked") {
    return "部分文件没有恢复完成，需要你检查后再继续。";
  }
  return "暂时无法完成回溯，请稍后重试。";
}

function isBlockedError(code: string | null): boolean {
  return code === "file_restore_compensation_failed" || code === "file_restore_blocked";
}
