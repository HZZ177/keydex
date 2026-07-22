import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import type { WebAnnotationTypedProperty } from "../api";

import styles from "./WebAnnotationDrawer.module.css";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_TAGS = 20;
const MAX_PROPERTIES = 20;
const MAX_PROPERTIES_BYTES = 16 * 1024;

export interface WebAnnotationEditorValue {
  readonly bodyMarkdown: string;
  readonly tags: readonly string[];
  readonly properties: readonly WebAnnotationTypedProperty[];
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
  const [tagsText, setTagsText] = useState((initialValue?.tags ?? []).join(", "));
  const [properties, setProperties] = useState<readonly WebAnnotationTypedProperty[]>(
    initialValue?.properties ?? [],
  );
  const validation = useMemo(
    () => validateEditor(body, tagsText, properties),
    [body, properties, tagsText],
  );
  const submit = () => {
    if (pending || !validation.ok) return;
    onSubmit({ bodyMarkdown: body.trim(), tags: validation.tags, properties });
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
          maxLength={MAX_BODY_BYTES}
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder="记录这段网页内容为什么重要…"
          rows={5}
          value={body}
        />
        <small>{utf8Bytes(body).toLocaleString()} / {MAX_BODY_BYTES.toLocaleString()} 字节</small>
      </label>
      <label className={styles.field}>
        <span>标签</span>
        <input
          aria-label="批注标签"
          disabled={pending}
          onChange={(event) => setTagsText(event.currentTarget.value)}
          placeholder="研究, 待确认（用逗号分隔）"
          value={tagsText}
        />
        <small>最多 {MAX_TAGS} 个，每个不超过 64 字符</small>
      </label>
      <div className={styles.properties}>
        <div className={styles.propertiesHeader}>
          <span>结构化属性</span>
          <button
            aria-label="添加结构化属性"
            disabled={pending || properties.length >= MAX_PROPERTIES}
            onClick={() => setProperties((current) => [
              ...current,
              { key: "", type: "text", value: "" },
            ])}
            type="button"
          >
            <Plus size={13} /> 添加
          </button>
        </div>
        {properties.map((property, index) => (
          <PropertyRow
            disabled={pending}
            index={index}
            key={`${index}:${property.type}`}
            property={property}
            onChange={(next) => setProperties((current) => current.map((entry, entryIndex) =>
              entryIndex === index ? next : entry))}
            onDelete={() => setProperties((current) => current.filter((_, entryIndex) => entryIndex !== index))}
          />
        ))}
        {properties.length === 0 ? <p className={styles.propertiesEmpty}>可选；用于记录负责人、日期、结论等字段。</p> : null}
      </div>
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

function PropertyRow({
  disabled,
  index,
  property,
  onChange,
  onDelete,
}: {
  readonly disabled: boolean;
  readonly index: number;
  readonly property: WebAnnotationTypedProperty;
  onChange(value: WebAnnotationTypedProperty): void;
  onDelete(): void;
}) {
  const setType = (type: WebAnnotationTypedProperty["type"]) => {
    const key = property.key;
    if (type === "number") onChange({ key, type, value: 0 });
    else if (type === "boolean") onChange({ key, type, value: false });
    else onChange({ key, type, value: "" });
  };
  return (
    <div className={styles.propertyRow}>
      <input
        aria-label={`属性 ${index + 1} 名称`}
        disabled={disabled}
        maxLength={64}
        onChange={(event) => onChange({ ...property, key: event.currentTarget.value })}
        placeholder="字段名"
        value={property.key}
      />
      <select
        aria-label={`属性 ${index + 1} 类型`}
        disabled={disabled}
        onChange={(event) => setType(event.currentTarget.value as WebAnnotationTypedProperty["type"])}
        value={property.type}
      >
        <option value="text">文本</option>
        <option value="number">数字</option>
        <option value="boolean">布尔</option>
        <option value="date">日期</option>
        <option value="url">链接</option>
      </select>
      {property.type === "boolean" ? (
        <select
          aria-label={`属性 ${index + 1} 值`}
          disabled={disabled}
          onChange={(event) => onChange({ ...property, value: event.currentTarget.value === "true" })}
          value={String(property.value)}
        >
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      ) : (
        <input
          aria-label={`属性 ${index + 1} 值`}
          disabled={disabled}
          maxLength={property.type === "text" ? 8 * 1024 : undefined}
          onChange={(event) => onChange(property.type === "number"
            ? { ...property, value: event.currentTarget.valueAsNumber }
            : { ...property, value: event.currentTarget.value })}
          type={property.type === "number" ? "number" : property.type === "date" ? "date" : "text"}
          value={String(property.value)}
        />
      )}
      <button aria-label={`删除属性 ${index + 1}`} disabled={disabled} onClick={onDelete} type="button">
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function validateEditor(
  body: string,
  tagsText: string,
  properties: readonly WebAnnotationTypedProperty[],
): { readonly ok: true; readonly tags: readonly string[] } | { readonly ok: false; readonly message: string; readonly tags: readonly string[] } {
  const tags = normalizedTags(tagsText);
  if (!body.trim()) return { ok: false, message: "批注内容不能为空", tags };
  if (utf8Bytes(body) > MAX_BODY_BYTES) return { ok: false, message: "批注内容超过 32 KiB", tags };
  if (tags.length > MAX_TAGS) return { ok: false, message: `标签不能超过 ${MAX_TAGS} 个`, tags };
  if (tags.some((tag) => tag.length > 64)) return { ok: false, message: "每个标签不能超过 64 字符", tags };
  if (properties.length > MAX_PROPERTIES) return { ok: false, message: `结构化属性不能超过 ${MAX_PROPERTIES} 个`, tags };
  const keys = properties.map((property) => property.key.trim().toLocaleLowerCase());
  if (keys.some((key) => !key)) return { ok: false, message: "结构化属性名称不能为空", tags };
  if (new Set(keys).size !== keys.length) return { ok: false, message: "结构化属性名称不能重复", tags };
  if (properties.some((property) => property.type === "number" && !Number.isFinite(property.value))) {
    return { ok: false, message: "数字属性必须是有效数字", tags };
  }
  if (utf8Bytes(JSON.stringify(properties)) > MAX_PROPERTIES_BYTES) {
    return { ok: false, message: "结构化属性总量超过 16 KiB", tags };
  }
  return { ok: true, tags };
}

function normalizedTags(value: string): readonly string[] {
  const seen = new Set<string>();
  return value.split(/[,，]/u).map((tag) => tag.trim()).filter((tag) => {
    if (!tag) return false;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
