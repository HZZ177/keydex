import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type {
  A2UICancelHandler,
  A2UISubmitHandler,
  ParsedA2UIMessage,
} from "./A2UIBlock";
import styles from "./A2FormBlock.module.css";
import type { A2UIRenderState } from "./A2UIState";
import { A2UIStateLine } from "./A2UIStateLine";
import {
  A2UIMotionItem,
  A2UIMotionRoot,
} from "./A2UIMotion";
import revealStyles from "./A2UIReveal.module.css";

export interface A2FormBlockProps {
  message: ConversationMessage;
  parsed: ParsedA2UIMessage;
  onSubmit?: A2UISubmitHandler;
  onCancel?: A2UICancelHandler;
}

type FormFieldType = "text" | "textarea" | "number" | "boolean" | "select" | "multiselect" | "date";

interface FormOption {
  label: string;
  value: string;
  disabled: boolean;
}

interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  placeholder: string;
  help: string;
  defaultValue: unknown;
  min: number | null;
  max: number | null;
  step: number | null;
  options: FormOption[];
}

interface FormModel {
  title: string;
  description: string;
  submitLabel: string;
  fields: FormField[];
  status: string;
  submittedValues: Record<string, unknown>;
  submittedNote: string;
  renderState: A2UIRenderState;
}

type FormValues = Record<string, unknown>;

export function A2FormBlock({ message, parsed, onSubmit, onCancel }: A2FormBlockProps) {
  const model = useMemo(() => formModel(parsed), [parsed]);
  const [values, setValues] = useState<FormValues>(() => initialValues(model));
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localSubmitting, setLocalSubmitting] = useState<"submit" | "cancel" | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionable =
    model.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false &&
    !localSubmitted;
  const canSubmit = actionable && Boolean(onSubmit) && !localSubmitting;
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;
  const showInputPreview = model.status === "waiting_input" || isStreamingPreviewStatus(model.status);

  useEffect(() => {
    setValues(initialValues(model));
    setNote("");
    setErrors({});
    setLocalSubmitting(null);
    setLocalSubmitted(false);
    setError(null);
  }, [parsed.interactionId, model.status]);

  const updateValue = (field: FormField, value: unknown) => {
    setValues((current) => ({ ...current, [field.name]: value }));
    setErrors((current) => {
      if (!current[field.name]) {
        return current;
      }
      const next = { ...current };
      delete next[field.name];
      return next;
    });
  };

  const submit = async () => {
    if (!canSubmit || !onSubmit || !parsed.interactionId) {
      return;
    }
    const nextErrors = validateValues(model.fields, values);
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    setLocalSubmitting("submit");
    setError(null);
    try {
      const trimmed = note.trim();
      await onSubmit(
        parsed.interactionId,
        {
          values: normalizedSubmitValues(model.fields, values),
          ...(trimmed ? { note: trimmed } : {}),
        },
        message.threadId,
      );
      setLocalSubmitted(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLocalSubmitting(null);
    }
  };

  const cancel = async () => {
    if (!canCancel || !onCancel || !parsed.interactionId) {
      return;
    }
    setLocalSubmitting("cancel");
    setError(null);
    try {
      await onCancel(parsed.interactionId, note.trim() || "用户取消", message.threadId);
      setLocalSubmitted(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLocalSubmitting(null);
    }
  };

  return (
    <A2UIMotionRoot as="section" className={styles.form} data-testid="a2ui-form" {...parsed.streamPlayer?.rootProps}>
      <A2UIMotionItem
        as="div"
        className={[styles.intro, revealStyles.revealCompactItem].join(" ")}
        motionKey="form:intro"
        motionKind="form-intro"
      >
        <h3 className={styles.title}>{model.title}</h3>
        {model.description ? <p className={styles.description}>{model.description}</p> : null}
        <div className={styles.meta}>{formMeta(model)}</div>
      </A2UIMotionItem>
      {showInputPreview ? (
        <>
          <div className={styles.fields}>
            {model.fields.map((field) => {
              return (
                <FormFieldControl
                  disabled={!actionable || Boolean(localSubmitting)}
                  error={errors[field.name]}
                  field={field}
                  idPrefix={message.id}
                  key={field.name}
                  value={values[field.name]}
                  onChange={(value) => updateValue(field, value)}
                />
              );
            })}
          </div>
          {!model.fields.length ? (
            <A2UIMotionItem
              as="div"
              className={[styles.previewEmpty, revealStyles.revealCompactItem].join(" ")}
              motionKey="form:preview-empty"
              motionKind="form-preview-empty"
            >
              正在生成字段
            </A2UIMotionItem>
          ) : null}
          <A2UIMotionItem
            as="div"
            className={[styles.note, revealStyles.revealCompactItem].join(" ")}
            motionKey="form:note"
            motionKind="form-note"
          >
            <label htmlFor={`${message.id}:a2ui-form-note`}>备注</label>
            <textarea
              id={`${message.id}:a2ui-form-note`}
              value={note}
              maxLength={500}
              disabled={!actionable || Boolean(localSubmitting)}
              placeholder="可选"
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </A2UIMotionItem>
          <A2UIMotionItem
            as="div"
            className={[styles.actions, revealStyles.revealCompactItem].join(" ")}
            aria-label="表单操作"
            motionKey="form:actions"
            motionKind="form-actions"
          >
            <button className={styles.button} type="button" disabled={!canCancel} onClick={() => void cancel()}>
              <X size={13} aria-hidden="true" />
              <span>{localSubmitting === "cancel" ? "正在取消" : "取消"}</span>
            </button>
            <button
              className={[styles.button, styles.submitButton].join(" ")}
              type="button"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              <Check size={13} aria-hidden="true" />
              <span>{localSubmitting === "submit" ? "正在提交" : model.submitLabel}</span>
            </button>
          </A2UIMotionItem>
        </>
      ) : (
        <FormResult model={model} />
      )}
      {error ? <div className={styles.error}>{error}</div> : null}
    </A2UIMotionRoot>
  );
}

function FormFieldControl({
  field,
  idPrefix,
  value,
  disabled,
  error,
  onChange,
}: {
  field: FormField;
  idPrefix: string;
  value: unknown;
  disabled: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = `${idPrefix}:a2ui-form:${field.name}`;
  return (
    <A2UIMotionItem
      as="div"
      className={[styles.field, revealStyles.revealItem].join(" ")}
      data-field-type={field.type}
      motionKey={formFieldUnitKey(field)}
      motionKind="form-field"
    >
      {field.type === "boolean" ? (
        <label
          className={styles.checkboxLabel}
          data-disabled={disabled ? "true" : "false"}
          data-selected={value === true ? "true" : "false"}
          htmlFor={id}
        >
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <span aria-hidden="true" className={styles.checkboxMark} />
          <span>
            {field.label}
            {field.required ? <span className={styles.required}>*</span> : null}
          </span>
        </label>
      ) : (
        <>
          <label className={styles.label} htmlFor={id}>
            <span>{field.label}</span>
            {field.required ? <span className={styles.required}>*</span> : null}
          </label>
          {renderFieldInput(field, id, value, disabled, onChange)}
        </>
      )}
      {field.help ? <div className={styles.helpText}>{field.help}</div> : null}
      {error ? <div className={styles.fieldError}>{error}</div> : null}
    </A2UIMotionItem>
  );
}

function renderFieldInput(
  field: FormField,
  id: string,
  value: unknown,
  disabled: boolean,
  onChange: (value: unknown) => void,
) {
  if (field.type === "textarea") {
    return (
      <textarea
        id={id}
        value={stringValue(value)}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  if (field.type === "number") {
    return (
      <input
        id={id}
        type="number"
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        step={field.step ?? undefined}
        value={stringValue(value)}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  if (field.type === "date") {
    return (
      <input
        id={id}
        type="date"
        value={stringValue(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  if (field.type === "select") {
    return (
      <SelectField
        disabled={disabled}
        field={field}
        id={id}
        value={stringValue(value)}
        onChange={onChange}
      />
    );
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(stringValue) : [];
    return (
      <div className={styles.multiOptions} role="group" aria-label={field.label}>
        {field.options.map((option) => (
          <label
            className={styles.checkboxLabel}
            data-disabled={disabled || option.disabled ? "true" : "false"}
            data-selected={selected.includes(option.value) ? "true" : "false"}
            key={option.value}
          >
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              disabled={disabled || option.disabled}
              onChange={(event) => {
                if (event.currentTarget.checked) {
                  onChange([...selected, option.value]);
                } else {
                  onChange(selected.filter((item) => item !== option.value));
                }
              }}
            />
            <span aria-hidden="true" className={styles.checkboxMark} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      id={id}
      type="text"
      value={stringValue(value)}
      disabled={disabled}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function SelectField({
  field,
  id,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = `${id}:listbox`;
  const selectedOption = field.options.find((option) => option.value === value);
  const placeholder = field.placeholder || "请选择";

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div className={styles.selectRoot} data-disabled={disabled ? "true" : "false"} data-open={open ? "true" : "false"} ref={rootRef}>
      <button
        id={id}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={styles.selectTrigger}
        disabled={disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selectedOption ? styles.selectValue : styles.selectPlaceholder}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div className={styles.selectMenu} id={listboxId} role="listbox" aria-labelledby={id}>
          <button
            aria-selected={!value}
            className={styles.selectOption}
            data-selected={!value ? "true" : "false"}
            role="option"
            type="button"
            onClick={() => choose("")}
          >
            <span className={styles.selectOptionCheck}>{!value ? <Check aria-hidden="true" size={13} /> : null}</span>
            <span>请选择</span>
          </button>
          {field.options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                aria-selected={selected}
                className={styles.selectOption}
                data-selected={selected ? "true" : "false"}
                disabled={option.disabled}
                key={option.value}
                role="option"
                type="button"
                onClick={() => choose(option.value)}
              >
                <span className={styles.selectOptionCheck}>
                  {selected ? <Check aria-hidden="true" size={13} /> : null}
                </span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function FormResult({ model }: { model: FormModel }) {
  if (model.status === "cancelled") {
    return (
      <div className={styles.result} data-result-status="cancelled" data-testid="a2ui-form-result">
        <ReadonlyFormValues fields={model.fields} values={{}} emptyText="未填写" />
        <FormOutcomeLine model={model} />
      </div>
    );
  }
  if (model.status === "submitted") {
    return (
      <div className={styles.result} data-result-status="submitted" data-testid="a2ui-form-result">
        <ReadonlyFormValues fields={model.fields} values={model.submittedValues} />
        <FormOutcomeLine model={model} />
        {model.submittedNote ? <ReadonlyFormNote value={model.submittedNote} /> : null}
      </div>
    );
  }
  return (
    <div className={styles.result} data-result-status="pending" data-testid="a2ui-form-result">
      <ReadonlyFormValues fields={model.fields} values={{}} emptyText="-" />
    </div>
  );
}

function FormOutcomeLine({ model }: { model: FormModel }) {
  if (model.renderState.outcome === "submitted") {
    return (
      <A2UIStateLine tone="success" testId="a2ui-form-state-line">
        本次填写已提交
      </A2UIStateLine>
    );
  }
  if (model.renderState.outcome === "cancelled_by_user") {
    return (
      <A2UIStateLine tone="warning" testId="a2ui-form-state-line">
        已取消本次填写
      </A2UIStateLine>
    );
  }
  return null;
}

function ReadonlyFormValues({
  fields,
  values,
  emptyText = "-",
}: {
  fields: FormField[];
  values: Record<string, unknown>;
  emptyText?: string;
}) {
  if (!fields.length) {
    return null;
  }
  return (
    <dl className={styles.valueGrid}>
      {fields.map((field) => {
        const value = readonlyFormValue(values[field.name], field, emptyText);
        return (
          <div className={styles.valueItem} key={field.name}>
            <dt>{field.label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function ReadonlyFormNote({ value }: { value: string }) {
  return (
    <div className={styles.readonlyNote}>
      <span>备注</span>
      <p>{value}</p>
    </div>
  );
}

function readonlyFormValue(value: unknown, field: FormField, emptyText: string): string {
  if (value === undefined || value === null) {
    return emptyText;
  }
  if (Array.isArray(value) && !value.length) {
    return emptyText;
  }
  if (Array.isArray(value)) {
    return formatValue(value, field) || emptyText;
  }
  if (field.type !== "boolean" && stringValue(value) === "") {
    return emptyText;
  }
  return formatValue(value, field) || emptyText;
}

function formMeta(model: FormModel): string {
  const requiredCount = model.fields.filter((field) => field.required).length;
  if (!model.fields.length) {
    return "暂无字段";
  }
  if (!requiredCount) {
    return `${model.fields.length} 个字段`;
  }
  return `${model.fields.length} 个字段，${requiredCount} 个必填`;
}

function formModel(parsed: ParsedA2UIMessage): FormModel {
  const payload = parsed.payload;
  const interaction = parsed.interaction;
  const submitResult = asRecord(interaction?.submit_result);
  return {
    title: scalarText(payload.title) || "请补充信息",
    description: scalarText(payload.description) || scalarText(payload.message),
    submitLabel: scalarText(payload.submit_label) || scalarText(payload.submitLabel) || "提交表单",
    fields: formFields(payload.fields),
    status: normalizeStatus(interaction?.status ?? parsed.status),
    submittedValues: asRecord(submitResult?.values) ?? asRecord(submitResult) ?? {},
    submittedNote: scalarText(submitResult?.note) || scalarText(submitResult?.comment),
    renderState: parsed.renderState,
  };
}

function formFieldUnitKey(field: FormField): string {
  return `form:field:${field.name}`;
}

function formFields(value: unknown): FormField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const field = asRecord(item);
      const name = scalarText(field?.name) || scalarText(field?.key);
      const label = scalarText(field?.label) || name;
      if (!name || !label) {
        return null;
      }
      return {
        name,
        label,
        type: normalizeFieldType(field?.type),
        required: field?.required === true,
        placeholder: scalarText(field?.placeholder),
        help: scalarText(field?.help) || scalarText(field?.description),
        defaultValue: field?.default_value ?? field?.defaultValue,
        min: numberValue(field?.min),
        max: numberValue(field?.max),
        step: numberValue(field?.step),
        options: formOptions(field?.options),
      };
    })
    .filter((item): item is FormField => Boolean(item));
}

function formOptions(value: unknown): FormOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const option = asRecord(item);
      const valueText = scalarText(option?.value);
      const label = scalarText(option?.label) || valueText;
      return valueText && label ? { label, value: valueText, disabled: option?.disabled === true } : null;
    })
    .filter((item): item is FormOption => Boolean(item));
}

function normalizeFieldType(value: unknown): FormFieldType {
  const type = scalarText(value).toLowerCase();
  if (type === "string") {
    return "text";
  }
  if (
    type === "textarea" ||
    type === "number" ||
    type === "boolean" ||
    type === "select" ||
    type === "multiselect" ||
    type === "date"
  ) {
    return type;
  }
  return "text";
}

function initialValues(model: FormModel): FormValues {
  if (model.status === "submitted") {
    return model.submittedValues;
  }
  const values: FormValues = {};
  for (const field of model.fields) {
    if (field.defaultValue !== undefined) {
      values[field.name] = normalizeDefaultFieldValue(field);
      continue;
    }
    if (field.type === "boolean") {
      values[field.name] = false;
    } else if (field.type === "multiselect") {
      values[field.name] = [];
    } else {
      values[field.name] = "";
    }
  }
  return values;
}

function normalizeDefaultFieldValue(field: FormField): unknown {
  const value = field.defaultValue;
  if (field.type === "boolean") {
    return value === true || ["true", "1", "是", "yes"].includes(scalarText(value).toLowerCase());
  }
  if (field.type === "multiselect") {
    const list = Array.isArray(value) ? value : scalarText(value) ? [value] : [];
    const allowed = new Set(field.options.filter((option) => !option.disabled).map((option) => option.value));
    return list.map((item) => stringValue(item)).filter((item) => allowed.has(item));
  }
  if (field.type === "select") {
    const text = stringValue(value);
    return field.options.some((option) => option.value === text && !option.disabled) ? text : "";
  }
  if (field.type === "number") {
    return stringValue(value);
  }
  return stringValue(value);
}

function validateValues(fields: FormField[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.required) {
      if (field.type === "number") {
        addNumberRangeError(errors, field, values[field.name]);
      }
      continue;
    }
    const value = values[field.name];
    if (field.type === "boolean") {
      if (value !== true) {
        errors[field.name] = "请勾选该字段";
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        errors[field.name] = "请选择该字段";
      }
      continue;
    }
    if (!stringValue(value)) {
      errors[field.name] = "请填写该字段";
      continue;
    }
    if (field.type === "number") {
      addNumberRangeError(errors, field, value);
    }
  }
  return errors;
}

function addNumberRangeError(errors: Record<string, string>, field: FormField, value: unknown): void {
  const text = stringValue(value);
  if (!text) {
    return;
  }
  const number = Number(text);
  if (!Number.isFinite(number)) {
    errors[field.name] = "请输入有效数字";
    return;
  }
  if (field.min !== null && number < field.min) {
    errors[field.name] = `不能小于 ${field.min}`;
    return;
  }
  if (field.max !== null && number > field.max) {
    errors[field.name] = `不能大于 ${field.max}`;
  }
}

function normalizedSubmitValues(fields: FormField[], values: FormValues): FormValues {
  const normalized: FormValues = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === "number") {
      normalized[field.name] = stringValue(value) ? Number(value) : null;
      continue;
    }
    normalized[field.name] = value;
  }
  return normalized;
}

function formatValue(value: unknown, field: FormField): string {
  if (field.type === "boolean") {
    return value === true ? "是" : "否";
  }
  if (Array.isArray(value)) {
    return value.map((item) => optionLabel(field, stringValue(item))).join("，");
  }
  if (field.type === "select") {
    return optionLabel(field, stringValue(value));
  }
  return scalarText(value) || "-";
}

function optionLabel(field: FormField, value: string): string {
  return field.options.find((option) => option.value === value)?.label ?? value;
}

function normalizeStatus(value: unknown): string {
  const status = scalarText(value).toLowerCase();
  if (status === "waiting_user_input") {
    return "waiting_input";
  }
  if (status === "missing") {
    return "failed";
  }
  return status || "created";
}

function isStreamingPreviewStatus(status: string): boolean {
  return status === "started" || status === "streaming" || status === "finished";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return "提交失败";
}
