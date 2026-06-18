import { AlertTriangle, Check, ChevronDown, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { ApprovalDecision, ApprovalKind, ApprovalRequest, ApprovalStatus } from "@/types/protocol";

import styles from "./ApprovalPrompt.module.css";

export type ApprovalDecisionHandler = (
  approvalId: string,
  decision: ApprovalDecision,
) => Promise<void> | void;

export interface ApprovalPromptProps {
  message: ConversationMessage;
  onDecision?: ApprovalDecisionHandler;
}

export function ApprovalPrompt({ message, onDecision }: ApprovalPromptProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [submitted, setSubmitted] = useState<ApprovalDecision | null>(null);
  const approval = useMemo(() => parseApproval(message), [message]);
  const actionable = approval.status === "pending" && Boolean(onDecision) && !submitting && !submitted;
  const status = submitted && approval.status === "pending" ? "submitted" : approval.status;

  useEffect(() => {
    setSubmitting(null);
    setSubmitted(null);
  }, [approval.id, approval.status]);

  const respond = async (decision: ApprovalDecision) => {
    if (!approval.id || !onDecision || !actionable) {
      return;
    }
    setSubmitting(decision);
    try {
      await onDecision(approval.id, decision);
      setSubmitted(decision);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <article className={styles.block} data-status={status} data-testid="approval-prompt">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {approval.status === "rejected" || approval.status === "expired" || approval.status === "cancelled" ? (
            <XCircle size={16} />
          ) : approval.riskLevel === "high" ? (
            <AlertTriangle size={16} />
          ) : (
            <ShieldCheck size={16} />
          )}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>{approval.title}</div>
          <div className={styles.meta}>
            <span>{kindLabel(approval.kind)}</span>
            <span>{statusLabel(status, submitted)}</span>
            {approval.target ? <span className={styles.target}>{approval.target}</span> : null}
          </div>
        </div>
      </header>

      {approval.description ? <p className={styles.description}>{approval.description}</p> : null}

      <div className={styles.riskLine}>
        <span>风险</span>
        <strong>{riskLabel(approval.riskLevel)}</strong>
      </div>

      <button
        className={styles.detailsToggle}
        type="button"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((value) => !value)}
      >
        <ChevronDown size={14} data-expanded={detailsOpen ? "true" : "false"} />
        <span>审批详情</span>
      </button>
      {detailsOpen ? <pre className={styles.details}>{approval.detailsText}</pre> : null}

      {approval.status === "pending" ? (
        <div className={styles.actions} aria-label="审批操作">
          <button
            className={styles.rejectButton}
            type="button"
            disabled={!actionable || submitting === "approved"}
            onClick={() => void respond("rejected")}
          >
            <XCircle size={14} />
            <span>{submitting === "rejected" ? "正在拒绝" : "拒绝"}</span>
          </button>
          <button
            className={styles.approveButton}
            type="button"
            disabled={!actionable || submitting === "rejected"}
            onClick={() => void respond("approved")}
          >
            <Check size={14} />
            <span>{submitting === "approved" ? "正在允许" : "允许"}</span>
          </button>
        </div>
      ) : null}
    </article>
  );
}

interface ParsedApproval {
  id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  target: string;
  detailsText: string;
  riskLevel: "low" | "medium" | "high";
  status: ApprovalStatus;
}

function parseApproval(message: ConversationMessage): ParsedApproval {
  const approval = asApproval(message.payload.approval);
  const details = approval?.details ?? {};
  return {
    id: approval?.id ?? "",
    kind: approval?.kind ?? "exec",
    title: approval?.title || message.content || "需要确认操作",
    description: approval?.description ?? "",
    target: targetFromDetails(details),
    detailsText: stringify(details),
    riskLevel: riskFromDetails(details),
    status: (approval?.status ?? message.status ?? "pending") as ApprovalStatus,
  };
}

function asApproval(value: unknown): ApprovalRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as ApprovalRequest;
}

function targetFromDetails(details: Record<string, unknown>): string {
  const candidates = [details.command, details.path, details.cwd, details.target, details.reason]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (candidates.length) {
    return candidates[0];
  }
  const paths = details.paths;
  if (Array.isArray(paths)) {
    const first = paths.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return first ?? "";
  }
  return "";
}

function riskFromDetails(details: Record<string, unknown>): ParsedApproval["riskLevel"] {
  const risk = details.risk ?? details.risk_level ?? details.level;
  if (risk === "high" || risk === "medium" || risk === "low") {
    return risk;
  }
  if (details.command || details.path || details.paths) {
    return "medium";
  }
  return "low";
}

function kindLabel(kind: ApprovalKind): string {
  switch (kind) {
    case "exec":
      return "执行命令";
    case "file_change":
      return "文件变更";
    case "read_external":
      return "读取外部路径";
    case "write_external":
      return "写入外部路径";
  }
}

function statusLabel(status: ApprovalStatus | "submitted", submitted: ApprovalDecision | null): string {
  if (status === "submitted") {
    return submitted === "approved" ? "已提交允许，等待确认" : "已提交拒绝，等待确认";
  }
  switch (status) {
    case "pending":
      return "等待确认";
    case "approved":
      return "已允许";
    case "rejected":
      return "已拒绝";
    case "expired":
      return "已过期";
    case "cancelled":
      return "已取消";
  }
}

function riskLabel(level: ParsedApproval["riskLevel"]): string {
  switch (level) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
