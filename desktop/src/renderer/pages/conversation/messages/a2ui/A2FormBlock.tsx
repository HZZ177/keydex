import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type {
  A2UICancelHandler,
  A2UISubmitHandler,
  ParsedA2UIMessage,
} from "./A2UIBlock";
import styles from "./A2FormBlock.module.css";
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
}

interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  placeholder: string;
  options: FormOption[];
}

interface FormModel {
  description: string;
  submitLabel: string;
  fields: FormField[];
  status: string;
  submittedValues: Record<string, unknown>;
  submittedNote: string;
  cancelReason: string;
  resumeStatus: string;
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
      {model.description ? (
        <A2UIMotionItem as="p" className={styles.description} motionKey="form:description" motionKind="form-description">
          {model.description}
        </A2UIMotionItem>
      ) : null}
      {model.status === "waiting_input" ? (
        <>
          <div className={styles.fields}>
            {model.fields.map((field) => {
              return (
                <FormFieldControl
                  disabled={!actionable || Boolean(localSubmitting)}
                  error={errors[field.name]}
                  field={field}
                  key={field.name}
                  value={values[field.name]}
                  onChange={(value) => updateValue(field, value)}
                />
              );
            })}
          </div>
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
  value,
  disabled,
  error,
  onChange,
}: {
  field: FormField;
  value: unknown;
  disabled: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = `a2ui-form:${field.name}`;
  return (
    <A2UIMotionItem
      as="div"
      className={[styles.field, revealStyles.revealItem].join(" ")}
      motionKey={formFieldUnitKey(field)}
      motionKind="form-field"
    >
      {field.type === "boolean" ? (
        <label className={styles.checkboxLabel} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
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
      <select
        id={id}
        value={stringValue(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">请选择</option>
        {field.options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(stringValue) : [];
    return (
      <div className={styles.multiOptions} role="group" aria-label={field.label}>
        {field.options.map((option) => (
          <label className={styles.checkboxLabel} key={option.value}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              disabled={disabled}
              onChange={(event) => {
                if (event.currentTarget.checked) {
                  onChange([...selected, option.value]);
                } else {
                  onChange(selected.filter((item) => item !== option.value));
                }
              }}
            />
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

function FormResult({ model }: { model: FormModel }) {
  if (model.status === "cancelled") {
    return (
      <div className={styles.result} data-testid="a2ui-form-result">
        <strong>已取消</strong>
        {model.cancelReason ? <span>原因：{model.cancelReason}</span> : null}
        {model.resumeStatus ? <span>恢复状态：{model.resumeStatus}</span> : null}
      </div>
    );
  }
  if (model.status === "submitted") {
    return (
      <div className={styles.result} data-testid="a2ui-form-result">
        <strong>已提交表单</strong>
        <dl className={styles.valueGrid}>
          {model.fields.map((field) => (
            <div className={styles.valueItem} key={field.name}>
              <dt>{field.label}</dt>
              <dd title={formatValue(model.submittedValues[field.name], field)}>
                {formatValue(model.submittedValues[field.name], field)}
              </dd>
            </div>
          ))}
        </dl>
        {model.submittedNote ? <span>备注：{model.submittedNote}</span> : null}
        {model.resumeStatus ? <span>恢复状态：{model.resumeStatus}</span> : null}
      </div>
    );
  }
  return (
    <div className={styles.result} data-testid="a2ui-form-result">
      <strong>等待状态更新</strong>
    </div>
  );
}

function formModel(parsed: ParsedA2UIMessage): FormModel {
  const payload = parsed.payload;
  const interaction = parsed.interaction;
  const submitResult = asRecord(interaction?.submit_result);
  return {
    description: scalarText(payload.description) || scalarText(payload.message),
    submitLabel: scalarText(payload.submit_label) || scalarText(payload.submitLabel) || "提交表单",
    fields: formFields(payload.fields),
    status: normalizeStatus(interaction?.status ?? parsed.status),
    submittedValues: asRecord(submitResult?.values) ?? asRecord(submitResult) ?? {},
    submittedNote: scalarText(submitResult?.note) || scalarText(submitResult?.comment),
    cancelReason: scalarText(interaction?.cancel_reason),
    resumeStatus: scalarText(interaction?.resume_status),
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
      return valueText && label ? { label, value: valueText } : null;
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

function validateValues(fields: FormField[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.required) {
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
    }
  }
  return errors;
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

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return "提交失败";
}
