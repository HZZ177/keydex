import { useEffect, useRef, useState, type CompositionEvent, type KeyboardEvent } from "react";
import { Check, X } from "lucide-react";

import styles from "./AnnotationRail.module.css";

export function AnnotationDraftCard({
  body,
  error,
  onBodyChange,
  onCancel,
  onSubmit,
  pending,
  revision,
}: {
  body: string;
  error?: string | null;
  onBodyChange(body: string): void;
  onCancel(): void;
  onSubmit(): void;
  pending: boolean;
  revision: string;
}) {
  const initialRevision = useRef(revision);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (revision !== initialRevision.current) {
      onCancel();
    }
  }, [onCancel, revision]);

  const submit = () => {
    if (!pending && body.trim()) {
      onSubmit();
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  const handleComposition = (event: CompositionEvent<HTMLTextAreaElement>) => {
    setComposing(event.type === "compositionstart");
  };

  return (
    <article aria-label="新建批注" className={`${styles.card} ${styles.draftCard}`} data-annotation-draft="true">
      <div className={styles.cardMeta}><strong>新批注</strong><span>已连接当前选区</span></div>
      <textarea
        aria-label="批注内容"
        autoFocus
        className={styles.editor}
        disabled={pending}
        onChange={(event) => onBodyChange(event.target.value)}
        onCompositionEnd={handleComposition}
        onCompositionStart={handleComposition}
        onKeyDown={handleKeyDown}
        placeholder="输入批注，Enter 提交，Shift+Enter 换行"
        value={body}
      />
      {error ? <div className={styles.cardError} role="alert">{error}</div> : null}
      <div className={styles.cardActions}>
        <button aria-label="取消新建批注" disabled={pending} onClick={onCancel} type="button"><X size={14} /></button>
        <button aria-label="提交新批注" disabled={pending || !body.trim()} onClick={submit} type="button"><Check size={14} /></button>
      </div>
    </article>
  );
}
