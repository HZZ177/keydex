import { ArrowRight, RefreshCw } from "lucide-react";

import type { WebAnnotationItem } from "../api";
import type { WebAnnotationDraft } from "../state/WebAnnotationSession";

import styles from "./WebAnnotationDrawer.module.css";

export function RetargetFlow({
  item,
  draft,
  pending,
  conflictMessage,
  onCancel,
  onConfirm,
}: {
  readonly item: WebAnnotationItem;
  readonly draft: WebAnnotationDraft;
  readonly pending: boolean;
  readonly conflictMessage: string | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const waitingForEvidence = draft.target.type === "region" && draft.evidence?.status !== "ready";

  return (
    <section className={styles.retargetFlow} aria-label="重新绑定网页批注">
      <div className={styles.sectionHeading}>
        <strong>确认新目标</strong>
        <span>修订 {item.annotation.revision}</span>
      </div>
      <div className={styles.retargetComparison}>
        <TargetPreview label="原目标" summary={targetSummary(item.annotation.target)} />
        <ArrowRight aria-hidden="true" size={15} />
        <TargetPreview label="新目标" summary={targetSummary(draft.target)} />
      </div>
      <p className={styles.retargetPreserved}>仅更新定位目标；批注正文、标签和结构化属性保持不变。</p>
      {draft.evidence?.status === "capturing" ? (
        <p className={styles.retargetStatus} role="status">正在保存新区域的截图证据…</p>
      ) : null}
      {draft.evidence?.status === "failed" ? (
        <div className={styles.validationError} role="alert">
          新区域证据保存失败：{draft.evidence.errorCategory}
        </div>
      ) : null}
      {conflictMessage ? (
        <div className={styles.retargetConflict} role="alert">
          <RefreshCw aria-hidden="true" size={13} />
          <span>{conflictMessage}</span>
        </div>
      ) : null}
      <div className={styles.editorActions}>
        <button disabled={pending} onClick={onCancel} type="button">取消</button>
        <button
          className={styles.primaryButton}
          disabled={pending || waitingForEvidence}
          onClick={onConfirm}
          type="button"
        >
          {conflictMessage ? "使用最新修订确认" : "确认重新绑定"}
        </button>
      </div>
    </section>
  );
}

function TargetPreview({ label, summary }: { readonly label: string; readonly summary: string }) {
  return (
    <div>
      <span>{label}</span>
      <blockquote>{summary}</blockquote>
    </div>
  );
}

function targetSummary(target: WebAnnotationItem["annotation"]["target"]): string {
  if (target.type === "text") return target.quote.exact;
  if (target.type === "element") return target.accessibleName || target.textSummary || `<${target.tag}>`;
  return `页面区域 ${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`;
}
