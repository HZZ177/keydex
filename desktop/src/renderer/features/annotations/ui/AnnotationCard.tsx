import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { Check, MessageSquare, Pencil, Trash2, X } from "lucide-react";

import type { ResolvedTextAnnotation } from "../domain/resolutions";
import styles from "./AnnotationRail.module.css";

export function AnnotationCard({
  active,
  hovered,
  item,
  onDelete,
  onNavigate,
  onHoverChange,
  onSave,
  onStartChat,
}: {
  active: boolean;
  hovered: boolean;
  item: ResolvedTextAnnotation;
  onDelete(annotationId: string): Promise<boolean>;
  onNavigate(item: ResolvedTextAnnotation): void;
  onHoverChange(annotationId: string | null): void;
  onSave(annotationId: string, body: string): Promise<boolean>;
  onStartChat?(item: ResolvedTextAnnotation): void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.record.body);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = (event: MouseEvent) => event.stopPropagation();

  const save = async () => {
    if (!body.trim() || pending) {
      return;
    }
    setPending(true);
    setError(null);
    const saved = await onSave(item.record.id, body.trim());
    setPending(false);
    if (saved) {
      setEditing(false);
    } else {
      setError("保存失败");
    }
  };

  const remove = async () => {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    const deleted = await onDelete(item.record.id);
    setPending(false);
    if (!deleted) {
      setError("删除失败");
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!editing && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onNavigate(item);
    }
  };

  return (
    <article
      aria-label={`批注：${item.record.body}`}
      className={styles.card}
      data-active={active ? "true" : "false"}
      data-annotation-card-id={item.record.id}
      data-hovered={hovered ? "true" : "false"}
      onClick={() => !editing && onNavigate(item)}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => onHoverChange(item.record.id)}
      onPointerLeave={() => onHoverChange(null)}
      tabIndex={0}
    >
      <div className={styles.cardMeta}>
        <span>文字批注</span>
        <time dateTime={item.record.created_at}>{formatTime(item.record.created_at)}</time>
      </div>
      {editing ? (
        <textarea
          aria-label="编辑批注"
          autoFocus
          className={styles.editor}
          disabled={pending}
          onChange={(event) => setBody(event.target.value)}
          onClick={stop}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setBody(item.record.body);
              setEditing(false);
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          value={body}
        />
      ) : (
        <p className={styles.cardBody}>{item.record.body}</p>
      )}
      {error ? <div className={styles.cardError} role="alert">{error}</div> : null}
      <div className={styles.cardActions} onClick={stop}>
        {editing ? (
          <>
            <button aria-label="保存批注" disabled={pending || !body.trim()} onClick={() => void save()} type="button">
              <Check size={14} />
            </button>
            <button aria-label="取消编辑" disabled={pending} onClick={() => {
              setBody(item.record.body);
              setEditing(false);
            }} type="button">
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <button aria-label="编辑批注" onClick={() => setEditing(true)} type="button"><Pencil size={14} /></button>
            <button aria-label="删除批注" disabled={pending} onClick={() => void remove()} type="button"><Trash2 size={14} /></button>
            {onStartChat ? (
              <button aria-label="将批注加入对话" onClick={() => onStartChat(item)} type="button"><MessageSquare size={14} /></button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
