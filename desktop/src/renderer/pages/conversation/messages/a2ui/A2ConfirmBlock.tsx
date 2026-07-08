import { AlertTriangle, Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type {
  A2UICancelHandler,
  A2UISubmitHandler,
  ParsedA2UIMessage,
} from "./A2UIBlock";
import styles from "./A2ConfirmBlock.module.css";
import {
  A2UIMotionItem,
  A2UIMotionRoot,
} from "./A2UIMotion";
import revealStyles from "./A2UIReveal.module.css";

export interface A2ConfirmBlockProps {
  message: ConversationMessage;
  parsed: ParsedA2UIMessage;
  onSubmit?: A2UISubmitHandler;
  onCancel?: A2UICancelHandler;
}

export function A2ConfirmBlock({ message, parsed, onSubmit, onCancel }: A2ConfirmBlockProps) {
  const model = useMemo(() => confirmModel(parsed), [parsed]);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [localSubmitting, setLocalSubmitting] = useState<"confirm" | "cancel" | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionable =
    model.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false &&
    !localSubmitted;
  const canConfirm = actionable && Boolean(onSubmit) && !localSubmitting && (!model.danger || acknowledged);
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;

  useEffect(() => {
    setLocalSubmitting(null);
    setLocalSubmitted(false);
    setError(null);
  }, [parsed.interactionId, model.status]);

  const submitConfirmed = async () => {
    if (!canConfirm || !onSubmit || !parsed.interactionId) {
      return;
    }
    setLocalSubmitting("confirm");
    setError(null);
    try {
      const trimmed = note.trim();
      await onSubmit(
        parsed.interactionId,
        {
          confirmed: true,
          ...(trimmed ? { note: trimmed } : {}),
        },
        message.threadId,
      );
      setLocalSubmitted(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLocalSubmitting(null);
    }
  };

  const cancel = async () => {
    if (!canCancel || !onCancel || !parsed.interactionId) {
      return;
    }
    setLocalSubmitting("cancel");
    setError(null);
    try {
      await onCancel(parsed.interactionId, note.trim() || "用户取消", message.threadId);
      setLocalSubmitted(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLocalSubmitting(null);
    }
  };

  return (
    <A2UIMotionRoot as="section" className={styles.confirm} data-testid="a2ui-confirm" {...parsed.streamPlayer?.rootProps}>
      {model.description ? (
        <A2UIMotionItem
          as="p"
          className={[styles.description, revealStyles.revealCompactItem].join(" ")}
          motionKey="confirm:description"
          motionKind="confirm-description"
        >
          {model.description}
        </A2UIMotionItem>
      ) : null}
      {model.danger ? (
        <A2UIMotionItem
          as="div"
          className={[styles.dangerNotice, revealStyles.revealItem].join(" ")}
          data-testid="a2ui-confirm-danger"
          motionKey="confirm:danger"
          motionKind="confirm-danger"
        >
          <AlertTriangle size={14} aria-hidden="true" />
          <span>此操作被标记为高风险，请确认后继续。</span>
        </A2UIMotionItem>
      ) : null}
      {model.riskTags.length ? (
        <div className={styles.riskTags} aria-label="风险标签">
          {model.riskTags.map((tag, index) => {
            const unitKey = confirmRiskTagUnitKey(tag, index);
            return (
              <A2UIMotionItem
                as="span"
                className={[styles.riskTag, revealStyles.revealCompactItem].join(" ")}
                key={tag}
                motionKey={unitKey}
                motionKind="confirm-risk-tag"
              >
                {tag}
              </A2UIMotionItem>
            );
          })}
        </div>
      ) : null}

      {model.status === "waiting_input" ? (
        <>
          {model.danger ? (
            <A2UIMotionItem
              as="label"
              className={[styles.acknowledge, revealStyles.revealCompactItem].join(" ")}
              motionKey="confirm:acknowledge"
              motionKind="confirm-acknowledge"
            >
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={!actionable || Boolean(localSubmitting)}
                onChange={(event) => setAcknowledged(event.currentTarget.checked)}
              />
              <span>我已了解风险</span>
            </A2UIMotionItem>
          ) : null}
          <A2UIMotionItem
            as="div"
            className={[styles.note, revealStyles.revealCompactItem].join(" ")}
            motionKey="confirm:note"
            motionKind="confirm-note"
          >
            <label htmlFor={`${message.id}:a2ui-confirm-note`}>备注</label>
            <textarea
              id={`${message.id}:a2ui-confirm-note`}
              value={note}
              maxLength={500}
              disabled={!actionable || Boolean(localSubmitting)}
              placeholder="可选"
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </A2UIMotionItem>
          <A2UIMotionItem
            as="div"
            className={[styles.actions, revealStyles.revealCompactItem].join(" ")}
            aria-label="确认操作"
            motionKey="confirm:actions"
            motionKind="confirm-actions"
          >
            <button className={styles.button} type="button" disabled={!canCancel} onClick={() => void cancel()}>
              <X size={13} aria-hidden="true" />
              <span>{localSubmitting === "cancel" ? "正在取消" : model.cancelLabel}</span>
            </button>
            <button
              className={[styles.button, styles.confirmButton].join(" ")}
              data-danger={model.danger ? "true" : "false"}
              type="button"
              disabled={!canConfirm}
              onClick={() => void submitConfirmed()}
            >
              <Check size={13} aria-hidden="true" />
              <span>{localSubmitting === "confirm" ? "正在提交" : model.confirmLabel}</span>
            </button>
          </A2UIMotionItem>
        </>
      ) : (
        <ConfirmResult model={model} />
      )}
      {error ? <div className={styles.error}>{error}</div> : null}
    </A2UIMotionRoot>
  );
}

interface ConfirmModel {
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  riskTags: string[];
  status: string;
  submittedResult: Record<string, unknown> | null;
  cancelReason: string;
  resumeStatus: string;
  resumeError: string;
}

function ConfirmResult({ model }: { model: ConfirmModel }) {
  if (model.status === "cancelled") {
    return (
      <div className={styles.result} data-testid="a2ui-confirm-result">
        <strong>已取消</strong>
        {model.cancelReason ? <span>原因：{model.cancelReason}</span> : null}
        {model.resumeStatus ? <span>恢复状态：{model.resumeStatus}</span> : null}
      </div>
    );
  }
  if (model.status === "submitted") {
    const confirmed = booleanValue(model.submittedResult?.confirmed);
    const note = scalarText(model.submittedResult?.note) || scalarText(model.submittedResult?.comment);
    return (
      <div className={styles.result} data-testid="a2ui-confirm-result">
        <strong>{confirmed === false ? "已提交拒绝" : "已提交确认"}</strong>
        {note ? <span>备注：{note}</span> : null}
        {model.resumeStatus ? <span>恢复状态：{model.resumeStatus}</span> : null}
      </div>
    );
  }
  if (model.status === "failed") {
    return (
      <div className={styles.result} data-testid="a2ui-confirm-result">
        <strong>处理失败</strong>
        {model.resumeError ? <span>{model.resumeError}</span> : null}
      </div>
    );
  }
  return (
    <div className={styles.result} data-testid="a2ui-confirm-result">
      <strong>等待状态更新</strong>
    </div>
  );
}

function confirmModel(parsed: ParsedA2UIMessage): ConfirmModel {
  const payload = parsed.payload;
  const interaction = parsed.interaction;
  const riskTags = stringList(payload.risk_tags ?? payload.riskTags);
  const status = normalizeStatus(interaction?.status ?? parsed.status);
  return {
    description: scalarText(payload.description) || scalarText(payload.content) || scalarText(payload.message),
    confirmLabel: scalarText(payload.confirm_label) || scalarText(payload.confirmLabel) || "确认",
    cancelLabel: scalarText(payload.cancel_label) || scalarText(payload.cancelLabel) || "取消",
    danger: booleanValue(payload.danger) || riskTags.some((tag) => tag.includes("不可逆") || tag.includes("高风险")),
    riskTags,
    status,
    submittedResult: asRecord(interaction?.submit_result),
    cancelReason: scalarText(interaction?.cancel_reason),
    resumeStatus: scalarText(interaction?.resume_status),
    resumeError: scalarText(interaction?.resume_error || interaction?.error),
  };
}

function confirmRiskTagUnitKey(tag: string, index: number): string {
  return `confirm:risk:${tag || index}`;
}

function normalizeStatus(value: unknown): string {
  const status = scalarText(value).toLowerCase();
  if (status === "waiting_user_input") {
    return "waiting_input";
  }
  if (status === "missing") {
    return "failed";
  }
  return status || "created";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => scalarText(item))
    .filter((item) => item.length > 0);
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

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return "提交失败";
}
