import { useMemo, useState } from "react";
import { Check, ChevronRight, MessageSquare, Pencil, Trash2, X } from "lucide-react";

import type { DocumentAnnotationResolution } from "../domain/resolutions";
import styles from "./AnnotationRail.module.css";

export function DocumentAnnotationSection({
  collapsed,
  items,
  onCollapsedChange,
  onDelete,
  onSave,
  onStartChat,
}: {
  collapsed: boolean;
  items: readonly DocumentAnnotationResolution[];
  onCollapsedChange(collapsed: boolean): void;
  onDelete(annotationId: string): Promise<boolean>;
  onSave(annotationId: string, body: string): Promise<boolean>;
  onStartChat?(item: DocumentAnnotationResolution): void;
}) {
  const ordered = useMemo(() => stableOrder(items), [items]);
  if (ordered.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="全文批注"
      className={styles.annotationSection}
      data-annotation-section="document"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <h3 className={styles.documentSectionHeader}>
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开全文批注" : "收起全文批注"}
          className={styles.documentSectionToggle}
          onClick={() => onCollapsedChange(!collapsed)}
          type="button"
        >
          <span className={styles.documentSectionTitle}>
            <ChevronRight
              aria-hidden="true"
              className={styles.documentSectionChevron}
              data-expanded={collapsed ? "false" : "true"}
              size={14}
            />
            <span>全文批注</span>
          </span>
          <span className={styles.documentSectionCount}>{ordered.length}</span>
        </button>
      </h3>
      <div
        aria-hidden={collapsed}
        className={styles.documentSectionCollapse}
        data-collapsed={collapsed ? "true" : "false"}
        inert={collapsed}
      >
        <div className={styles.documentSectionViewport}>
          <div className={styles.documentSectionBody}>
            {ordered.map((item) => (
              <DocumentCard key={item.record.id} item={item} onDelete={onDelete} onSave={onSave} onStartChat={onStartChat} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function DocumentCard({ item, onDelete, onSave, onStartChat }: {
  item: DocumentAnnotationResolution;
  onDelete(annotationId: string): Promise<boolean>;
  onSave(annotationId: string, body: string): Promise<boolean>;
  onStartChat?(item: DocumentAnnotationResolution): void;
}) {
  const [body, setBody] = useState(item.record.body);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (pending || !body.trim()) return;
    setPending(true);
    setError(null);
    const success = await onSave(item.record.id, body.trim());
    setPending(false);
    setEditing(!success);
    if (!success) setError("保存失败");
  };
  const remove = async () => {
    setPending(true);
    setError(null);
    const success = await onDelete(item.record.id);
    setPending(false);
    if (!success) setError("删除失败");
  };
  return (
    <article aria-label={`全文批注：${item.record.body}`} className={styles.card} data-annotation-card-id={item.record.id}>
      <div className={styles.cardMeta}><span>全文</span><time dateTime={item.record.created_at}>{formatTime(item.record.created_at)}</time></div>
      {editing ? <textarea aria-label="编辑全文批注" autoFocus className={styles.editor} disabled={pending} onChange={(event) => setBody(event.target.value)} placeholder="写下针对整份文档的批注…" value={body} /> : <p className={styles.cardBody}>{item.record.body}</p>}
      {error ? <div className={styles.cardError} role="alert">{error}</div> : null}
      <div className={styles.cardActions}>
        {editing ? <>
          <button aria-label="取消编辑全文批注" disabled={pending} onClick={() => { setBody(item.record.body); setEditing(false); }} type="button"><X size={14} /></button>
          <button aria-label="保存全文批注" className={styles.confirmAction} disabled={pending || !body.trim()} onClick={() => void save()} type="button"><Check size={14} /></button>
        </> : <>
          <button aria-label="编辑全文批注" onClick={() => setEditing(true)} type="button"><Pencil size={14} /></button>
          <button aria-label="删除全文批注" disabled={pending} onClick={() => void remove()} type="button"><Trash2 size={14} /></button>
          {onStartChat ? <button aria-label="将全文批注加入对话" onClick={() => onStartChat(item)} type="button"><MessageSquare size={14} /></button> : null}
        </>}
      </div>
    </article>
  );
}

function stableOrder<T extends DocumentAnnotationResolution>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.record.created_at.localeCompare(right.record.created_at) || left.record.id.localeCompare(right.record.id));
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
