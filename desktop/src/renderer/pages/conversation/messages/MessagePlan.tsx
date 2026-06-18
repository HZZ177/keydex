import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, ListChecks } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import styles from "./MessagePlan.module.css";

export interface MessagePlanProps {
  message: ConversationMessage;
}

type PlanStatus = "pending" | "in_progress" | "completed";

interface PlanEntry {
  content: string;
  status: PlanStatus;
}

export function MessagePlan({ message }: MessagePlanProps) {
  const [expanded, setExpanded] = useState(true);
  const plan = useMemo(() => parsePlan(message), [message]);

  if (!plan.entries.length) {
    return null;
  }

  const completedCount = plan.entries.filter((entry) => entry.status === "completed").length;
  const activeEntry = plan.entries.find((entry) => entry.status === "in_progress");

  return (
    <article className={styles.plan} data-testid="message-plan">
      <button
        className={styles.header}
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "收起计划详情" : "展开计划详情"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className={styles.titleIcon} aria-hidden="true">
          <ListChecks size={14} />
        </span>
        <span className={styles.titleGroup}>
          <span className={styles.title}>计划</span>
          <span className={styles.summary}>
            {completedCount}/{plan.entries.length} 已完成
            {activeEntry ? ` · 正在进行：${activeEntry.content}` : ""}
          </span>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded ? (
        <div className={styles.body}>
          {plan.explanation ? <p className={styles.explanation}>{plan.explanation}</p> : null}
          <ol className={styles.entries} aria-label="计划步骤">
            {plan.entries.map((entry, index) => (
              <li className={styles.entry} data-status={entry.status} key={`${entry.status}-${index}-${entry.content}`}>
                <span className={styles.statusIcon} aria-hidden="true">
                  {entry.status === "completed" ? (
                    <CircleCheck size={16} />
                  ) : entry.status === "in_progress" ? (
                    <CircleDot size={16} />
                  ) : (
                    <Circle size={16} />
                  )}
                </span>
                <span className={styles.entryText}>{entry.content}</span>
                <span className={styles.entryStatus}>{statusLabel(entry.status)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </article>
  );
}

function parsePlan(message: ConversationMessage): { explanation: string | null; entries: PlanEntry[] } {
  const payload = message.payload;
  const directUiPayload = asRecord(payload.ui_payload);
  const result = asRecord(payload.result);
  const resultUiPayload = asRecord(result?.ui_payload);
  const call = asRecord(payload.call);
  const callArguments = parseMaybeJson(call?.arguments);

  const source = directUiPayload ?? resultUiPayload ?? callArguments ?? {};
  const explanation = stringValue(source.explanation);
  const rawEntries = Array.isArray(source.entries) ? source.entries : Array.isArray(source.plan) ? source.plan : [];

  return {
    explanation,
    entries: rawEntries.map(normalizeEntry).filter((entry): entry is PlanEntry => Boolean(entry)),
  };
}

function normalizeEntry(value: unknown): PlanEntry | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const content = stringValue(record.content) ?? stringValue(record.step);
  if (!content) {
    return null;
  }
  const status = normalizeStatus(record.status);
  return { content, status };
}

function normalizeStatus(value: unknown): PlanStatus {
  if (value === "completed" || value === "in_progress" || value === "pending") {
    return value;
  }
  return "pending";
}

function statusLabel(status: PlanStatus): string {
  if (status === "completed") {
    return "已完成";
  }
  if (status === "in_progress") {
    return "进行中";
  }
  return "待处理";
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
