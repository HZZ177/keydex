import { ChevronDown, Target } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import styles from "./ThreadTaskStatusBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

export interface ThreadTaskStatusBlockProps {
  message: ConversationMessage;
}

interface ThreadTaskStatusViewModel {
  title: string;
  summary: string;
  badge: string;
  state: "running" | "success" | "blocked" | "failed" | "cancelled" | "neutral";
  details: ThreadTaskStatusDetailsModel;
  hasDetails: boolean;
}

interface ThreadTaskStatusDetailsModel {
  objective: string;
  summary: string;
  reason: string;
  checklist: string[];
  evidence: string[];
  attempts: string[];
}

export function ThreadTaskStatusBlock({ message }: ThreadTaskStatusBlockProps) {
  const model = useMemo(() => threadTaskStatusViewModel(message), [message]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsMotion = useDeferredUnmount<HTMLDivElement>(detailsOpen, 180, 240);
  const surface = (
    <>
      <span className={styles.icon} aria-hidden="true">
        <Target size={14} strokeWidth={2} absoluteStrokeWidth focusable="false" />
      </span>
      <span className={styles.content}>
        <span className={styles.header}>
          <span className={styles.title}>{model.title}</span>
          {model.badge ? <span className={styles.badge}>{model.badge}</span> : null}
        </span>
        {model.summary ? <span className={styles.summary}>{model.summary}</span> : null}
      </span>
      {model.hasDetails ? (
        <span className={styles.trailingIcon} aria-hidden="true">
          <ChevronDown className={styles.chevron} size={14} />
        </span>
      ) : null}
    </>
  );

  return (
    <article
      className={styles.block}
      data-expanded={detailsOpen ? "true" : "false"}
      data-state={model.state}
      data-testid="thread-task-status-block"
      role="status"
      aria-live="polite"
    >
      {model.hasDetails ? (
        <button
          className={styles.surface}
          type="button"
          aria-expanded={detailsOpen}
          aria-label={detailsOpen ? "收起目标状态详情" : "展开目标状态详情"}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {surface}
        </button>
      ) : (
        <div className={styles.surface}>{surface}</div>
      )}
      {model.hasDetails && detailsMotion.shouldRender ? (
        <div
          className={styles.detailsShell}
          data-motion={detailsMotion.phase}
          ref={detailsMotion.ref}
          style={detailsMotion.style}
          aria-hidden={!detailsOpen}
          data-testid="thread-task-status-details-shell"
        >
          <ThreadTaskStatusDetails details={model.details} />
        </div>
      ) : null}
    </article>
  );
}

function ThreadTaskStatusDetails({ details }: { details: ThreadTaskStatusDetailsModel }) {
  const overview = [
    { label: "目标", value: details.objective },
    { label: "结果摘要", value: details.summary },
    { label: "状态原因", value: details.reason },
  ].filter((item) => item.value);
  return (
    <div className={styles.details} aria-label="目标状态详情">
      {overview.length ? (
        <dl className={styles.overview} aria-label="目标状态概览">
          {overview.map((item) => (
            <div className={styles.overviewItem} key={item.label}>
              <dt className={styles.overviewLabel}>{item.label}</dt>
              <dd className={styles.overviewValue}>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className={styles.detailPanels}>
        <DetailList kind="checklist" label="检查项" items={details.checklist} />
        <DetailList kind="evidence" label="证据" items={details.evidence} />
        <DetailList kind="attempts" label="尝试记录" items={details.attempts} />
      </div>
    </div>
  );
}

function DetailList({
  kind,
  label,
  items,
}: {
  kind: "checklist" | "evidence" | "attempts";
  label: string;
  items: string[];
}) {
  if (!items.length) {
    return null;
  }
  return (
    <section className={styles.detailPanel} data-kind={kind} aria-label={label}>
      <div className={styles.detailPanelHeader}>
        <span className={styles.detailPanelTitle}>{label}</span>
        <span className={styles.detailPanelCount}>{items.length}</span>
      </div>
      <ul className={styles.detailList}>
        {items.map((item, index) => (
          <li key={`${label}-${index}`}>
            <span className={styles.detailIndex}>{index + 1}</span>
            <span className={styles.detailText}>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function threadTaskStatusViewModel(message: ConversationMessage): ThreadTaskStatusViewModel {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const args = threadTaskToolArgs(call, message.payload);
  const resultPayload = parseToolResultPayload(result, message.payload);
  const uiPayload = firstRecord(
    result?.ui_payload,
    message.payload.ui_payload,
    message.payload.uiPayload,
    resultPayload?.ui_payload,
    resultPayload,
  );
  const task = firstRecord(
    uiPayload?.task,
    resultPayload?.task,
    resultPayload?.thread_task,
    resultPayload?.threadTask,
    result?.task,
  );
  const toolName =
    stringValue(call?.name) ||
    stringValue(message.payload.tool) ||
    stringValue(message.payload.tool_name) ||
    message.content.trim();
  const taskType = stringValue(task?.type) || "goal";
  const taskTypeLabel = stringValue(task?.type_label) || (taskType === "goal" ? "目标" : "任务");
  const requestedStatus = normalizeTaskStatus(stringValue(args.status));
  const taskStatus = normalizeTaskStatus(stringValue(task?.status) || stringValue(resultPayload?.status));
  const effectiveStatus = taskStatus || requestedStatus;
  const resultStatus = stringValue(result?.status);
  const running = message.status === "pending" || message.status === "running" || resultStatus === "running";
  const failed = message.status === "failed" || resultStatus === "error";
  const cancelled = message.status === "cancelled" || resultStatus === "cancelled";
  const summary = statusSummary(args, resultPayload, task, toolName);
  const details = statusDetails(args, resultPayload, task, summary);
  const attemptInfo = coalescedAttemptInfo(message);

  if (failed) {
    return {
      title: `${taskTypeLabel}状态更新失败`,
      summary,
      badge: "",
      state: "failed",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  if (cancelled) {
    return {
      title: `已取消更新${taskTypeLabel}状态`,
      summary,
      badge: "",
      state: "cancelled",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  if (toolName === "get_thread_task") {
    return withCoalescedAttemptInfo(
      statusReadModel({
        taskTypeLabel,
        effectiveStatus,
        running,
        resultPayload,
        task,
        summary,
        details,
      }),
      attemptInfo,
    );
  }
  return withCoalescedAttemptInfo(
    statusUpdateModel({
      taskTypeLabel,
      requestedStatus,
      effectiveStatus,
      running,
      summary,
      details,
    }),
    attemptInfo,
  );
}

function statusReadModel({
  taskTypeLabel,
  effectiveStatus,
  running,
  resultPayload,
  task,
  summary,
  details,
}: {
  taskTypeLabel: string;
  effectiveStatus: string;
  running: boolean;
  resultPayload: Record<string, unknown> | null;
  task: Record<string, unknown> | null;
  summary: string;
  details: ThreadTaskStatusDetailsModel;
}): ThreadTaskStatusViewModel {
  if (running) {
    return {
      title: `正在读取${taskTypeLabel}状态`,
      summary,
      badge: "",
      state: "running",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  if (resultPayload?.has_task === false || stringValue(resultPayload?.status) === "no_active_task" || !task) {
    return {
      title: `当前没有进行中的${taskTypeLabel}`,
      summary: "",
      badge: "",
      state: "neutral",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  const label = taskStatusLabel(effectiveStatus);
  return {
    title: label ? `${taskTypeLabel}状态：${label}` : `${taskTypeLabel}状态已读取`,
    summary,
    badge: label,
    state: taskStatusState(effectiveStatus),
    details,
    hasDetails: hasStatusDetails(details),
  };
}

function statusUpdateModel({
  taskTypeLabel,
  requestedStatus,
  effectiveStatus,
  running,
  summary,
  details,
}: {
  taskTypeLabel: string;
  requestedStatus: string;
  effectiveStatus: string;
  running: boolean;
  summary: string;
  details: ThreadTaskStatusDetailsModel;
}): ThreadTaskStatusViewModel {
  const targetStatus = effectiveStatus || requestedStatus;
  const label = taskStatusLabel(targetStatus);
  if (running) {
    return {
      title: label ? `正在标记${taskTypeLabel}${label}` : `正在更新${taskTypeLabel}状态`,
      summary,
      badge: label,
      state: "running",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  if (targetStatus === "complete") {
    return {
      title: `${taskTypeLabel}已完成`,
      summary,
      badge: "完成",
      state: "success",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  if (targetStatus === "blocked") {
    return {
      title: `${taskTypeLabel}已阻塞`,
      summary,
      badge: "阻塞",
      state: "blocked",
      details,
      hasDetails: hasStatusDetails(details),
    };
  }
  return {
    title: label ? `${taskTypeLabel}已标记${label}` : `${taskTypeLabel}状态已更新`,
    summary,
    badge: label,
    state: taskStatusState(targetStatus),
    details,
    hasDetails: hasStatusDetails(details),
  };
}

function statusSummary(
  args: Record<string, unknown>,
  resultPayload: Record<string, unknown> | null,
  task: Record<string, unknown> | null,
  toolName: string,
): string {
  const summary =
    stringValue(args.summary) ||
    stringValue(resultPayload?.summary) ||
    stringValue(asRecord(resultPayload?.payload)?.summary);
  if (summary) {
    return summary;
  }
  if (toolName === "get_thread_task") {
    return stringValue(task?.objective) || stringValue(resultPayload?.objective);
  }
  return stringValue(args.reason) || stringValue(args.blocked_reason);
}

function threadTaskToolArgs(
  call: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return firstRecord(
    normalizedArgs(call?.arguments),
    normalizedArgs(payload.arguments),
    normalizedArgs(payload.toolParams),
    normalizedArgs(payload.params),
    normalizedArgs(payload.input_data),
    normalizedArgs(payload.inputData),
    normalizedArgs(payload.toolSummary),
  ) ?? {};
}

function normalizedArgs(value: unknown): Record<string, unknown> | null {
  const record = recordFromUnknown(value);
  if (!record) {
    return null;
  }
  return (
    recordFromUnknown(record.args) ??
    recordFromUnknown(record.arguments) ??
    recordFromUnknown(asRecord(record.input)?.args) ??
    recordFromUnknown(asRecord(record.input_data)?.args) ??
    record
  );
}

function statusDetails(
  args: Record<string, unknown>,
  resultPayload: Record<string, unknown> | null,
  task: Record<string, unknown> | null,
  summary: string,
): ThreadTaskStatusDetailsModel {
  return {
    objective: stringValue(task?.objective) || stringValue(resultPayload?.objective),
    summary,
    reason: stringValue(args.reason) || stringValue(args.blocked_reason),
    checklist: listValue(args.checklist),
    evidence: listValue(args.evidence),
    attempts: listValue(args.attempts).concat(listValue(args.attempted_actions)),
  };
}

function hasStatusDetails(details: ThreadTaskStatusDetailsModel): boolean {
  return Boolean(
    details.objective ||
      details.summary ||
      details.reason ||
      details.checklist.length ||
      details.evidence.length ||
      details.attempts.length,
  );
}

function coalescedAttemptInfo(message: ConversationMessage): { failedAttempts: number; hiddenAttempts: number } {
  const summary = asRecord(message.payload._coalesced_thread_task_status);
  return {
    failedAttempts: numberValue(summary?.failed_attempts) ?? 0,
    hiddenAttempts: numberValue(summary?.hidden_attempts) ?? 0,
  };
}

function withCoalescedAttemptInfo(
  model: ThreadTaskStatusViewModel,
  attemptInfo: { failedAttempts: number; hiddenAttempts: number },
): ThreadTaskStatusViewModel {
  if (!attemptInfo.failedAttempts || model.state === "failed" || model.state === "cancelled" || model.state === "running") {
    return model;
  }
  const retryText =
    attemptInfo.failedAttempts === 1
      ? "前一次状态更新失败，已由后续重试成功覆盖。"
      : `前 ${attemptInfo.failedAttempts} 次状态更新失败，已由后续重试成功覆盖。`;
  return {
    ...model,
    badge: model.state === "success" ? "重试后成功" : model.badge,
    details: {
      ...model.details,
      attempts: [...model.details.attempts, retryText],
    },
    hasDetails: true,
  };
}

function listValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(detailItemText).filter(Boolean);
}

function detailItemText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  return (
    stringValue(record.content) ||
    stringValue(record.item) ||
    stringValue(record.step) ||
    stringValue(record.title) ||
    stringValue(record.detail) ||
    stringValue(record.summary) ||
    stringValue(record.text)
  );
}

function parseToolResultPayload(
  result: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const parsedText = firstRecord(
    parseJsonRecord(stringValue(result?.model_content)),
    parseJsonRecord(stringValue(result?.text)),
    parseJsonRecord(stringValue(payload.model_content)),
    parseJsonRecord(stringValue(payload.result_text)),
  );
  return normalizeResultPayload(
    firstRecord(
      result?.ui_payload,
      payload.ui_payload,
      payload.uiPayload,
      result?.result,
      parsedText,
      result,
    ),
  );
}

function normalizeResultPayload(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) {
    return null;
  }
  const nested = asRecord(record.result);
  if (
    nested &&
    (nested.task !== undefined ||
      nested.thread_task !== undefined ||
      nested.threadTask !== undefined ||
      nested.ui_payload !== undefined ||
      nested.status !== undefined)
  ) {
    return normalizeResultPayload(nested);
  }
  return record;
}

function normalizeTaskStatus(status: string): string {
  const cleaned = status.trim();
  return cleaned === "success" ? "" : cleaned;
}

function taskStatusLabel(status: string): string {
  switch (status) {
    case "complete":
      return "完成";
    case "blocked":
      return "阻塞";
    case "active":
      return "进行中";
    case "paused":
      return "暂停";
    case "cancelled":
      return "取消";
    case "system_stopped":
      return "停止";
    default:
      return "";
  }
}

function taskStatusState(status: string): ThreadTaskStatusViewModel["state"] {
  if (status === "complete") {
    return "success";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "cancelled" || status === "system_stopped") {
    return "cancelled";
  }
  return "neutral";
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = recordFromUnknown(value);
    if (record) {
      return record;
    }
  }
  return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    return parseJsonRecord(value);
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
