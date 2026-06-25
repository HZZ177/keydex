import { Check, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  CommandApprovalDecisionPayload,
  CommandApprovalRequest,
  TrustedCommandRuleMatchType,
} from "@/types/protocol";

import styles from "./ComposerApprovalCard.module.css";

export interface ComposerApprovalCardProps {
  approval: CommandApprovalRequest;
  allowPersistentTrust: boolean;
  submitting?: boolean;
  error?: string | null;
  onSubmit: (decision: CommandApprovalDecisionPayload) => Promise<void> | void;
}

export function ComposerApprovalCard({
  approval,
  allowPersistentTrust,
  submitting = false,
  error = null,
  onSubmit,
}: ComposerApprovalCardProps) {
  const [rejectMessage, setRejectMessage] = useState("");
  const command = stringValue(approval.details.command);
  const cwd = stringValue(approval.details.cwd) || ".";
  const exactRule = stringValue(approval.details.suggested_exact_rule) || command;
  const prefixRule = stringValue(approval.details.suggested_prefix_rule) || command;
  const description = approval.description || "命令将在当前工作区执行。";
  const persistentActions = useMemo(
    () => [
      {
        label: "是，且以后相同命令不再询问",
        matchType: "exact" as TrustedCommandRuleMatchType,
        hint: exactRule,
      },
      {
        label: "是，且以后以该前缀开头的命令不再询问",
        matchType: "prefix" as TrustedCommandRuleMatchType,
        hint: prefixRule,
      },
    ],
    [exactRule, prefixRule],
  );

  const submit = (decision: CommandApprovalDecisionPayload) => {
    if (submitting) {
      return;
    }
    void onSubmit(decision);
  };

  return (
    <section className={styles.card} aria-label="命令执行审批" data-testid="composer-approval-card">
      <header className={styles.header}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <div className={styles.title}>{approval.title || "是否允许执行命令？"}</div>
          <div className={styles.description}>{description}</div>
        </div>
      </header>

      <div className={styles.meta}>
        <span>工作目录</span>
        <strong>{cwd}</strong>
      </div>
      <pre className={styles.command}>{command || "未提供命令"}</pre>

      <div className={styles.actions}>
        <button
          className={styles.primaryAction}
          disabled={submitting}
          type="button"
          onClick={() => submit({ decision: "approved", trust_scope: "once" })}
        >
          <Check size={15} />
          <span>是，仅允许本次</span>
        </button>

        {allowPersistentTrust
          ? persistentActions.map((action) => (
              <button
                className={styles.secondaryAction}
                disabled={submitting}
                key={action.matchType}
                title={action.hint}
                type="button"
                onClick={() =>
                  submit({
                    decision: "approved",
                    trust_scope: "persistent",
                    rule_match_type: action.matchType,
                  })
                }
              >
                <Check size={15} />
                <span>{action.label}</span>
              </button>
            ))
          : null}
      </div>

      <label className={styles.rejectBox}>
        <span>拒绝说明</span>
        <textarea
          disabled={submitting}
          onChange={(event) => setRejectMessage(event.target.value)}
          placeholder="告诉 agent 如何调整"
          rows={2}
          value={rejectMessage}
        />
      </label>

      <footer className={styles.footer}>
        {error ? <span className={styles.error}>{error}</span> : <span />}
        <button
          className={styles.rejectAction}
          disabled={submitting}
          type="button"
          onClick={() =>
            submit({
              decision: "rejected",
              trust_scope: "once",
              reject_message: rejectMessage,
            })
          }
        >
          <X size={15} />
          <span>否，请告知 agent 如何调整</span>
        </button>
      </footer>
    </section>
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
