import { useMemo, useState } from "react";
import { Link2, Trash2 } from "lucide-react";

import type { AmbiguousTextAnnotation, ChangedTextAnnotation } from "../domain/resolutions";
import styles from "./AnnotationRail.module.css";

export type UnresolvedAnnotation = AmbiguousTextAnnotation | ChangedTextAnnotation;

export function AnnotationStatusSection({ items, onDelete, onRetarget }: {
  items: readonly UnresolvedAnnotation[];
  onDelete(annotationId: string): Promise<boolean>;
  onRetarget(annotationId: string): void;
}) {
  const ordered = useMemo(() => stableOrder(items), [items]);
  if (ordered.length === 0) {
    return null;
  }
  return (
    <section aria-label="需要重新关联的批注" className={styles.annotationSection} data-annotation-section="unresolved">
      <h3>需要重新关联 <span>{ordered.length}</span></h3>
      {ordered.map((item) => <StatusCard item={item} key={item.record.id} onDelete={onDelete} onRetarget={onRetarget} />)}
    </section>
  );
}

function StatusCard({ item, onDelete, onRetarget }: {
  item: UnresolvedAnnotation;
  onDelete(annotationId: string): Promise<boolean>;
  onRetarget(annotationId: string): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setPending(true);
    setError(null);
    const success = await onDelete(item.record.id);
    setPending(false);
    if (!success) setError("删除失败");
  };
  return (
    <article aria-label={`失效批注：${item.record.body}`} className={`${styles.card} ${styles.statusCard}`} data-annotation-card-id={item.record.id} data-resolution-status={item.status}>
      <div className={styles.cardMeta}><strong>{item.status === "ambiguous" ? "存在多个相同文本" : "原批注文字已变化"}</strong><span>{item.status}</span></div>
      <p className={styles.cardBody}>{item.record.body}</p>
      <p className={styles.statusHint}>{item.status === "ambiguous" ? "无法唯一确定原位置，请选择新的文字。" : "找不到原批注文字，请选择新的文字。"}</p>
      {error ? <div className={styles.cardError} role="alert">{error}</div> : null}
      <div className={styles.cardActions}>
        <button aria-label="重新关联批注" disabled={pending} onClick={() => onRetarget(item.record.id)} type="button"><Link2 size={14} /></button>
        <button aria-label="删除失效批注" disabled={pending} onClick={() => void remove()} type="button"><Trash2 size={14} /></button>
      </div>
    </article>
  );
}

function stableOrder<T extends UnresolvedAnnotation>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.record.created_at.localeCompare(right.record.created_at) || left.record.id.localeCompare(right.record.id));
}
