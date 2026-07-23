import { useMemo, useState, type KeyboardEvent } from "react";

import styles from "./WebAnnotationDrawer.module.css";

const MAX_BODY_CHARACTERS = 32 * 1024;

export interface WebAnnotationEditorValue {
  readonly bodyMarkdown: string;
}

export function WebAnnotationEditor({
  initialValue,
  pending,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  readonly initialValue?: Partial<WebAnnotationEditorValue>;
  readonly pending: boolean;
  readonly submitLabel: string;
  onCancel(): void;
  onSubmit(value: WebAnnotationEditorValue): void;
}) {
  const [body, setBody] = useState(initialValue?.bodyMarkdown ?? "");
  const characterCount = useMemo(() => unicodeCharacterCount(body), [body]);
  const validation = useMemo(() => validateEditor(body, characterCount), [body, characterCount]);
  const submit = () => {
    if (pending || !validation.ok) return;
    onSubmit({ bodyMarkdown: body.trim() });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.editor} onKeyDown={onKeyDown}>
      <label className={styles.field}>
        <span>批注内容</span>
        <textarea
          autoFocus
          aria-label="批注内容"
          disabled={pending}
          onChange={(event) => setBody(limitUnicodeCharacters(
            event.currentTarget.value,
            MAX_BODY_CHARACTERS,
          ))}
          placeholder="记录这段网页内容为什么重要…"
          rows={5}
          value={body}
        />
        <small>{characterCount.toLocaleString()} / {MAX_BODY_CHARACTERS.toLocaleString()} 字符</small>
      </label>
      {!validation.ok ? <div className={styles.validationError} role="alert">{validation.message}</div> : null}
      <div className={styles.editorActions}>
        <span>Ctrl/⌘ + Enter 保存 · Esc 取消</span>
        <button disabled={pending} onClick={onCancel} type="button">取消</button>
        <button
          className={styles.primaryButton}
          disabled={pending || !validation.ok}
          onClick={submit}
          type="button"
        >
          {pending ? "正在保存…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function validateEditor(
  body: string,
  characterCount: number,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (!body.trim()) return { ok: false, message: "批注内容不能为空" };
  if (characterCount > MAX_BODY_CHARACTERS) {
    return { ok: false, message: `批注内容不能超过 ${MAX_BODY_CHARACTERS.toLocaleString()} 字符` };
  }
  return { ok: true };
}

function unicodeCharacterCount(value: string): number {
  return Array.from(value).length;
}

function limitUnicodeCharacters(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : characters.slice(0, limit).join("");
}
