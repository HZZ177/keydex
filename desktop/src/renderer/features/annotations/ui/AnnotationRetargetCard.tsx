import { useState } from "react";
import { Check, X } from "lucide-react";

import type { LogicalRange } from "../document/DocumentTextModel";
import type { AnnotationRecord, TextSelector } from "@/runtime/annotations";
import styles from "./AnnotationRail.module.css";

export function AnnotationRetargetCard({
  annotation,
  error,
  range,
  selector,
  onCancel,
  onConfirm,
}: {
  annotation: AnnotationRecord;
  error?: string | null;
  range: LogicalRange | null;
  selector: TextSelector | null;
  onCancel(): void;
  onConfirm(annotationId: string, selector: TextSelector): Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const confirm = async () => {
    if (!selector || pending) return;
    setPending(true);
    setLocalError(null);
    const success = await onConfirm(annotation.id, selector);
    setPending(false);
    if (!success) setLocalError("重新关联失败");
  };
  return (
    <article aria-label={`重新关联批注：${annotation.body}`} className={`${styles.card} ${styles.retargetCard}`} data-annotation-retarget-id={annotation.id}>
      <div className={styles.cardMeta}><strong>重新关联</strong><span>{selector ? "待确认" : "请选择文字"}</span></div>
      <p className={styles.cardBody}>{annotation.body}</p>
      {selector ? (
        <div className={styles.retargetSelection}>
          <span>新选区</span>
          <q>{selector.quote.exact}</q>
          {range ? <small>{range.start}–{range.end}</small> : null}
        </div>
      ) : <p className={styles.statusHint}>请在文档中选择新的文字。原批注内容不会改变。</p>}
      {error || localError ? <div className={styles.cardError} role="alert">{error || localError}</div> : null}
      <div className={styles.cardActions}>
        <button aria-label="取消重新关联" disabled={pending} onClick={onCancel} type="button"><X size={14} /></button>
        <button aria-label="确认重新关联" className={styles.confirmAction} disabled={pending || !selector} onClick={() => void confirm()} type="button"><Check size={14} /></button>
      </div>
    </article>
  );
}
