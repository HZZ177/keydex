import { Check, ChevronDown, ShieldCheck, XCircle } from "lucide-react";
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

      {approval.facts.length ? (
        <dl className={styles.factGrid}>
          {approval.facts.map((fact) => (
            <div className={styles.factItem} key={fact.label}>
              <dt>{fact.label}</dt>
              <dd data-mono={fact.mono ? "true" : "false"} title={fact.value}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <button
        className={styles.detailsToggle}
        type="button"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((value) => !value)}
      >
        <ChevronDown size={14} data-expanded={detailsOpen ? "true" : "false"} />
        <span>确认详情</span>
      </button>
      {detailsOpen ? <pre className={styles.details}>{approval.detailsText}</pre> : null}

      {approval.status === "pending" ? (
        <div className={styles.actions} aria-label="确认操作">
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
  facts: ApprovalFact[];
  detailsText: string;
  status: ApprovalStatus;
}

interface ApprovalFact {
  label: string;
  value: string;
  mono?: boolean;
}

function parseApproval(message: ConversationMessage): ParsedApproval {
  const approvalRecord = asRecord(message.payload.approval);
  const approval = asApproval(message.payload.approval);
  const details = normalizedApprovalDetails(approvalRecord, approval);
  const kind = (approval?.kind || scalarText(approvalRecord?.kind) || "exec") as ApprovalKind;
  return {
    id: approval?.id ?? "",
    kind,
    title: approvalTitle(approval?.title || message.content || "需要确认操作"),
    description: approval?.description ?? "",
    target: targetFromDetails(details, kind),
    facts: factsFromDetails(details, kind),
    detailsText: detailsTextFromDetails(details, kind),
    status: (approval?.status ?? message.status ?? "pending") as ApprovalStatus,
  };
}

function asApproval(value: unknown): ApprovalRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as ApprovalRequest;
}

function normalizedApprovalDetails(
  approvalRecord: Record<string, unknown> | null,
  approval: ApprovalRequest | null,
): Record<string, unknown> {
  const details = { ...(approval?.details ?? {}) };
  const metadata = asRecord(approvalRecord?.metadata);
  const mcp = asRecord(metadata?.mcp);
  if (mcp) {
    mergeMissing(details, mcp);
  }
  [
    "approval_kind",
    "server_id",
    "server_name",
    "raw_tool_name",
    "model_tool_name",
    "snapshot_id",
    "approval_mode",
    "arguments_preview",
    "trust_options",
    "matched_rule",
    "model",
    "requested_model",
    "model_policy",
    "max_tokens",
    "sampling_max_tokens",
    "sampling_approval_mode",
    "sampling_audit_detail",
    "audit_detail",
    "message_count",
    "prompt_preview",
    "messages_preview",
  ].forEach((key) => {
    if (approvalRecord?.[key] !== undefined && details[key] === undefined) {
      details[key] = approvalRecord[key];
    }
  });
  return details;
}

function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>): void {
  Object.entries(source).forEach(([key, value]) => {
    if (target[key] === undefined) {
      target[key] = value;
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function targetFromDetails(details: Record<string, unknown>, kind: ApprovalKind): string {
  if (kind === "mcp_tool_call") {
    const server = scalarText(details.server_name) || scalarText(details.server_id);
    const tool =
      scalarText(details.raw_tool_name) ||
      scalarText(details.tool_name) ||
      scalarText(details.model_tool_name);
    return [server, tool].filter(Boolean).join(" / ");
  }
  if (kind === "mcp_sampling") {
    const server = scalarText(details.server_name) || scalarText(details.server_id);
    const model = scalarText(details.model) || scalarText(details.requested_model) || scalarText(details.model_policy);
    return [server, model].filter(Boolean).join(" / ");
  }
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

function factsFromDetails(details: Record<string, unknown>, kind: ApprovalKind): ApprovalFact[] {
  const facts: ApprovalFact[] = [];
  if (kind === "mcp_tool_call") {
    addFact(facts, "服务", details.server_name ?? details.server_id);
    addFact(facts, "工具", details.raw_tool_name ?? details.tool_name);
    addFact(facts, "参数摘要", previewText(details.arguments_preview), true);
    addFact(facts, "确认方式", approvalModeText(details.approval_mode));
    addFact(facts, "可选信任方式", trustOptionsText(details.trust_options));
    addFact(facts, "命中的信任项", previewText(details.matched_rule), true);
    return facts;
  }
  if (kind === "mcp_sampling") {
    addFact(facts, "服务", details.server_name ?? details.server_id);
    addFact(facts, "模型", details.model ?? details.requested_model ?? details.model_policy);
    addFact(facts, "Token 上限", details.max_tokens ?? details.sampling_max_tokens);
    addFact(facts, "确认方式", approvalModeText(details.approval_mode ?? details.sampling_approval_mode));
    addFact(facts, "审计", details.audit_detail ?? details.sampling_audit_detail);
    addFact(facts, "消息数", details.message_count);
    addFact(facts, "请求摘要", previewText(details.arguments_preview ?? details.prompt_preview ?? details.messages_preview), true);
    return facts;
  }
  addFact(facts, "命令", details.command, true);
  addFact(facts, "工具", details.tool_name ?? details.tool);
  addFact(facts, "Shell", details.shell_label ?? details.shell);
  addFact(facts, "Shell 路径", details.shell_path, true);
  addFact(facts, "工作目录", details.cwd, true);
  addFact(facts, "超时", formatTimeout(details.timeout_seconds));
  addFact(facts, "工作区", details.workspace_root, true);
  return facts;
}

function detailsTextFromDetails(details: Record<string, unknown>, kind: ApprovalKind): string {
  if (kind === "mcp_tool_call") {
    return stringify({
      server: scalarText(details.server_name) || scalarText(details.server_id),
      tool: scalarText(details.raw_tool_name) || scalarText(details.tool_name),
      arguments_preview: previewText(details.arguments_preview),
      approval_mode: approvalModeText(details.approval_mode),
      trust_options: trustOptionsText(details.trust_options),
      matched_rule: previewText(details.matched_rule),
    });
  }
  return stringify(details);
}

function addFact(facts: ApprovalFact[], label: string, value: unknown, mono = false): void {
  const text = scalarText(value);
  if (!text) {
    return;
  }
  facts.push({ label, value: text, mono });
}

function approvalTitle(value: string): string {
  return value.replace(/MCP Sampling/gi, "MCP 模型请求");
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return "";
}

function formatTimeout(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  return `${value}s`;
}

function previewText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trustOptionsText(value: unknown): string {
  if (!Array.isArray(value)) {
    return scalarText(value);
  }
  return value.map((item) => trustOptionLabel(scalarText(item))).filter(Boolean).join("；");
}

function trustOptionLabel(value: string): string {
  switch (value) {
    case "once":
      return "仅本次允许";
    case "session":
      return "本会话信任";
    case "persistent_tool":
      return "始终信任该工具";
    case "persistent_server":
      return "信任此 MCP 服务器";
    default:
      return "";
  }
}

function approvalModeText(value: unknown): string {
  switch (scalarText(value)) {
    case "auto":
    case "approve":
      return "始终允许";
    case "prompt":
      return "每次确认";
    case "deny":
      return "始终拒绝";
    case "inherit":
      return "继承服务器";
    default:
      return scalarText(value);
  }
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
    case "mcp_tool_call":
      return "MCP 工具调用";
    case "mcp_sampling":
      return "MCP 模型请求";
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


function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
