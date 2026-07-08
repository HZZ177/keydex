import { Check, ChevronDown } from "lucide-react";
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
  A2ActionMotionButton,
  A2FloatingMotionItem,
  A2FloatingMotionPanel,
  A2InteractiveMotionItem,
  A2InteractiveMotionRoot,
  A2MotionPresence,
} from "./A2UIMotion";

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
type ActionKind = "submit" | "cancel";
type ActionBadgeStage = "idle" | "loading" | "done";
type ActionBadgePhase = {
  kind: ActionKind;
  stage: Exclude<ActionBadgeStage, "idle">;
};

const ACTION_BADGE_DONE_MS = 420;

export function A2FormBlock({ message, parsed, onSubmit, onCancel }: A2FormBlockProps) {
  const model = useMemo(() => formModel(parsed), [parsed]);
  const [values, setValues] = useState<FormValues>(() => initialValues(model));
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localSubmitting, setLocalSubmitting] = useState<"submit" | "cancel" | null>(null);
  const [actionPhase, setActionPhase] = useState<ActionBadgePhase | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const actionTokenRef = useRef(0);
  const actionable =
    model.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false &&
    !localSubmitted;
  const canSubmit = actionable && Boolean(onSubmit) && !localSubmitting;
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;
  const showInputPreview = model.status === "waiting_input" || isStreamingPreviewStatus(model.status);
  const motionLive = shouldUseInteractiveFormMotion(parsed, model.status);
  const motionState = formMotionState({
    error,
    localSubmitted,
    localSubmitting,
    status: model.status,
    values,
  });
  const cancelBadgeStage = actionBadgeStage(actionPhase, "cancel");
  const submitBadgeStage = actionBadgeStage(actionPhase, "submit");
  const cancelButtonLabel = actionBadgeLabel(cancelBadgeStage, "取消", "取消中", "已取消");
  const submitButtonLabel = actionBadgeLabel(submitBadgeStage, model.submitLabel, "提交中", "已提交");
  const actionState =
    actionPhase?.kind ?? localSubmitting ?? (localSubmitted ? "submitted" : hasAnyFormValue(values) ? "dirty" : "idle");

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    actionTokenRef.current += 1;
    setValues(initialValues(model));
    setNote("");
    setErrors({});
    setLocalSubmitting(null);
    setActionPhase(null);
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
    const actionToken = actionTokenRef.current + 1;
    actionTokenRef.current = actionToken;
    setLocalSubmitting("submit");
    setActionPhase({ kind: "submit", stage: "loading" });
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
      if (!mountedRef.current || actionTokenRef.current !== actionToken) {
        return;
      }
      setActionPhase({ kind: "submit", stage: "done" });
      await waitForActionBadgeDone();
      if (mountedRef.current && actionTokenRef.current === actionToken) {
        setLocalSubmitted(true);
      }
    } catch (reason) {
      if (mountedRef.current && actionTokenRef.current === actionToken) {
        setError(errorMessage(reason));
        setActionPhase(null);
      }
    } finally {
      if (mountedRef.current && actionTokenRef.current === actionToken) {
        setLocalSubmitting(null);
      }
    }
  };

  const cancel = async () => {
    if (!canCancel || !onCancel || !parsed.interactionId) {
      return;
    }
    const actionToken = actionTokenRef.current + 1;
    actionTokenRef.current = actionToken;
    setLocalSubmitting("cancel");
    setActionPhase({ kind: "cancel", stage: "loading" });
    setError(null);
    try {
      await onCancel(parsed.interactionId, note.trim() || "用户取消", message.threadId);
      if (!mountedRef.current || actionTokenRef.current !== actionToken) {
        return;
      }
      setActionPhase({ kind: "cancel", stage: "done" });
      await waitForActionBadgeDone();
      if (mountedRef.current && actionTokenRef.current === actionToken) {
        setLocalSubmitted(true);
      }
    } catch (reason) {
      if (mountedRef.current && actionTokenRef.current === actionToken) {
        setError(errorMessage(reason));
        setActionPhase(null);
      }
    } finally {
      if (mountedRef.current && actionTokenRef.current === actionToken) {
        setLocalSubmitting(null);
      }
    }
  };

  return (
    <A2InteractiveMotionRoot
      className={styles.form}
      data-testid="a2ui-form"
      live={motionLive}
      motionScope={interactiveFormMotionScope(message.id, parsed)}
      motionState={motionState}
      {...parsed.streamPlayer?.rootProps}
    >
      <A2InteractiveMotionItem
        className={styles.intro}
        live={motionLive}
        motionKey="form:intro"
        motionKind="form-intro"
        variant="intro"
      >
        <h3 className={styles.title}>{model.title}</h3>
        {model.description ? <p className={styles.description}>{model.description}</p> : null}
        <div className={styles.meta}>{formMeta(model)}</div>
      </A2InteractiveMotionItem>
      <A2MotionPresence>
        {showInputPreview ? (
          <A2InteractiveMotionItem
            className={styles.stage}
            key="form-input"
            live={motionLive}
            motionKey="form:input-stage"
            motionKind="form-stage"
            variant="scene"
          >
            <div className={styles.workspace}>
              <FieldProgressRail
                errors={errors}
                fields={model.fields}
                live={motionLive}
                values={values}
              />
              <div className={styles.fields}>
                {model.fields.map((field, index) => {
                  return (
                    <FormFieldControl
                      disabled={!actionable || Boolean(localSubmitting)}
                      error={errors[field.name]}
                      field={field}
                      idPrefix={message.id}
                      key={field.name}
                      live={motionLive}
                      order={index + 1}
                      value={values[field.name]}
                      onChange={(value) => updateValue(field, value)}
                    />
                  );
                })}
              </div>
            </div>
            {!model.fields.length ? (
              <A2InteractiveMotionItem
                className={styles.previewEmpty}
                live={motionLive}
                motionKey="form:preview-empty"
                motionKind="form-preview-empty"
                variant="compact"
              >
                正在生成字段
              </A2InteractiveMotionItem>
            ) : null}
            <div className={styles.footerComposer}>
              <A2InteractiveMotionItem
                className={styles.correctionPanel}
                live={motionLive}
                motionKey="form:correction"
                motionKind="form-correction"
                variant="field"
              >
                <label htmlFor={`${message.id}:a2ui-form-correction`}>
                  不对！输入信息告诉 Keydex 应该怎么做
                </label>
                <textarea
                  id={`${message.id}:a2ui-form-correction`}
                  value={note}
                  maxLength={500}
                  disabled={!actionable || Boolean(localSubmitting)}
                  placeholder="例如：字段不对、选项不够、或者告诉 Keydex 重新按什么方向生成..."
                  onChange={(event) => setNote(event.currentTarget.value)}
                />
              </A2InteractiveMotionItem>
              <A2InteractiveMotionItem
                className={styles.actions}
                aria-label="表单操作"
                data-action-state={actionState}
                live={motionLive}
                motionKey="form:actions"
                motionKind="form-actions"
                variant="dock"
              >
                <A2ActionMotionButton
                  aria-label={cancelButtonLabel}
                  className={styles.button}
                  data-badge-state={cancelBadgeStage}
                  type="button"
                  disabled={!canCancel}
                  onClick={() => void cancel()}
                >
                  <ActionBadgeContent doneLabel="已取消" idleLabel="取消" loadingLabel="取消中" stage={cancelBadgeStage} />
                </A2ActionMotionButton>
                <A2ActionMotionButton
                  aria-label={submitButtonLabel}
                  className={[styles.button, styles.submitButton].join(" ")}
                  data-badge-state={submitBadgeStage}
                  type="button"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  <ActionBadgeContent doneLabel="已提交" idleLabel={model.submitLabel} loadingLabel="提交中" stage={submitBadgeStage} />
                </A2ActionMotionButton>
              </A2InteractiveMotionItem>
            </div>
          </A2InteractiveMotionItem>
        ) : (
          <FormResult live={motionLive} model={model} />
        )}
      </A2MotionPresence>
      {error ? <div className={styles.error}>{error}</div> : null}
    </A2InteractiveMotionRoot>
  );
}

function ActionBadgeContent({
  doneLabel,
  idleLabel,
  loadingLabel,
  stage,
}: {
  doneLabel: string;
  idleLabel: string;
  loadingLabel: string;
  stage: ActionBadgeStage;
}) {
  return (
    <>
      <span className={styles.buttonSignal} aria-hidden="true" />
      <span className={styles.buttonLabel} aria-hidden="true">
        <span data-active={stage === "idle" ? "true" : "false"}>{idleLabel}</span>
        <span data-active={stage === "loading" ? "true" : "false"}>{loadingLabel}</span>
        <span data-active={stage === "done" ? "true" : "false"}>{doneLabel}</span>
      </span>
    </>
  );
}

function FieldProgressRail({
  errors,
  fields,
  live,
  values,
}: {
  errors: Record<string, string>;
  fields: FormField[];
  live: boolean;
  values: FormValues;
}) {
  if (!fields.length) {
    return null;
  }
  const filledCount = fields.filter((field) => isFieldFilled(field, values[field.name])).length;
  return (
    <A2InteractiveMotionItem
      className={styles.progressRail}
      live={live}
      motionKey="form:progress-rail"
      motionKind="form-progress-rail"
      variant="tray"
    >
      <div className={styles.progressSummary}>
        <span>信息轨道</span>
        <strong>{filledCount}/{fields.length}</strong>
      </div>
      <div className={styles.progressItems}>
        {fields.map((field, index) => {
          const filled = isFieldFilled(field, values[field.name]);
          const hasError = Boolean(errors[field.name]);
          return (
            <span
              className={styles.progressItem}
              data-error={hasError ? "true" : "false"}
              data-filled={filled ? "true" : "false"}
              key={field.name}
              title={field.label}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{field.label}</strong>
            </span>
          );
        })}
      </div>
    </A2InteractiveMotionItem>
  );
}

function FormFieldControl({
  field,
  idPrefix,
  value,
  disabled,
  error,
  live,
  order,
  onChange,
}: {
  field: FormField;
  idPrefix: string;
  value: unknown;
  disabled: boolean;
  error?: string;
  live: boolean;
  order: number;
  onChange: (value: unknown) => void;
}) {
  const id = `${idPrefix}:a2ui-form:${field.name}`;
  const filled = isFieldFilled(field, value);
  return (
    <A2InteractiveMotionItem
      className={styles.field}
      data-error={error ? "true" : "false"}
      data-field-type={field.type}
      data-filled={filled ? "true" : "false"}
      data-required={field.required ? "true" : "false"}
      interactive={!disabled}
      live={live}
      motionKey={formFieldUnitKey(field)}
      motionKind="form-field"
      order={order}
      selected={filled}
      variant="field"
    >
      <span className={styles.fieldIndex} aria-hidden="true">
        {String(order).padStart(2, "0")}
      </span>
      <div className={styles.fieldBrief}>
        {field.type === "boolean" ? (
          <span className={styles.label}>
            <span>{field.label}</span>
            {field.required ? <span className={styles.required}>*</span> : null}
          </span>
        ) : (
          <label className={styles.label} htmlFor={id}>
            <span>{field.label}</span>
            {field.required ? <span className={styles.required}>*</span> : null}
          </label>
        )}
        <div className={styles.fieldMetaLine}>
          <span>{fieldTypeLabel(field)}</span>
          {field.required ? <span>必填</span> : <span>可选</span>}
        </div>
        {field.help ? <div className={styles.helpText}>{field.help}</div> : null}
        {error ? <div className={styles.fieldError}>{error}</div> : null}
      </div>
      <div className={styles.controlArea}>
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
            <span>{value === true ? `${field.label} · 已确认` : field.label}</span>
          </label>
        ) : (
          renderFieldInput(field, id, value, disabled, onChange)
        )}
      </div>
    </A2InteractiveMotionItem>
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
      <A2MotionPresence preserveExit>
        {open ? (
          <A2FloatingMotionPanel className={styles.selectMenu} id={listboxId} role="listbox" aria-labelledby={id}>
          <A2FloatingMotionItem
            aria-selected={!value}
            className={styles.selectOption}
            data-selected={!value ? "true" : "false"}
            role="option"
            type="button"
            onClick={() => choose("")}
          >
            <span className={styles.selectOptionCheck}>{!value ? <Check aria-hidden="true" size={13} /> : null}</span>
            <span>请选择</span>
          </A2FloatingMotionItem>
          {field.options.map((option) => {
            const selected = option.value === value;
            return (
              <A2FloatingMotionItem
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
              </A2FloatingMotionItem>
            );
          })}
          </A2FloatingMotionPanel>
        ) : null}
      </A2MotionPresence>
    </div>
  );
}

function FormResult({ live, model }: { live: boolean; model: FormModel }) {
  if (model.status === "cancelled") {
    return (
      <A2InteractiveMotionItem
        className={styles.result}
        data-result-status="cancelled"
        data-testid="a2ui-form-result"
        key="form-result"
        live={live}
        motionKey="form:result"
        motionKind="form-result"
        variant="result"
      >
        <ReadonlyFormValues fields={model.fields} values={{}} emptyText="未填写" />
        <FormOutcomeLine model={model} />
      </A2InteractiveMotionItem>
    );
  }
  if (model.status === "submitted") {
    return (
      <A2InteractiveMotionItem
        className={styles.result}
        data-result-status="submitted"
        data-testid="a2ui-form-result"
        key="form-result"
        live={live}
        motionKey="form:result"
        motionKind="form-result"
        variant="result"
      >
        <ReadonlyFormValues fields={model.fields} values={model.submittedValues} />
        <FormOutcomeLine model={model} />
        {model.submittedNote ? <ReadonlyFormNote value={model.submittedNote} /> : null}
      </A2InteractiveMotionItem>
    );
  }
  return (
    <A2InteractiveMotionItem
      className={styles.result}
      data-result-status="pending"
      data-testid="a2ui-form-result"
      key="form-result"
      live={live}
      motionKey="form:result"
      motionKind="form-result"
      variant="result"
    >
      <ReadonlyFormValues fields={model.fields} values={{}} emptyText="-" />
    </A2InteractiveMotionItem>
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
          <div
            className={styles.valueItem}
            data-empty={value === emptyText ? "true" : "false"}
            key={field.name}
          >
            <dt>
              <span>{field.label}</span>
              <em>{fieldTypeLabel(field)}</em>
            </dt>
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
      <span>给 Keydex 的补充信息</span>
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

function actionBadgeStage(phase: ActionBadgePhase | null, kind: ActionKind): ActionBadgeStage {
  return phase?.kind === kind ? phase.stage : "idle";
}

function actionBadgeLabel(stage: ActionBadgeStage, idle: string, loading: string, done: string): string {
  if (stage === "loading") {
    return loading;
  }
  if (stage === "done") {
    return done;
  }
  return idle;
}

function waitForActionBadgeDone(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ACTION_BADGE_DONE_MS);
  });
}

function fieldTypeLabel(field: FormField): string {
  switch (field.type) {
    case "textarea":
      return "长文本";
    case "number":
      return "数字";
    case "boolean":
      return "确认项";
    case "select":
      return "单选";
    case "multiselect":
      return "多选";
    case "date":
      return "日期";
    default:
      return "文本";
  }
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

function shouldUseInteractiveFormMotion(parsed: ParsedA2UIMessage, status: string): boolean {
  if (parsed.historyHydrated) {
    return false;
  }
  return Boolean(parsed.streamPlayer?.enabled) ||
    status === "waiting_input" ||
    status === "submitted" ||
    status === "cancelled" ||
    isStreamingPreviewStatus(status);
}

function interactiveFormMotionScope(messageId: string, parsed: ParsedA2UIMessage): string {
  return [
    parsed.a2ui?.stream_id,
    parsed.debug?.streamId,
    parsed.interactionId,
    messageId,
    "form",
  ].filter(Boolean).join(":");
}

function formMotionState({
  error,
  localSubmitted,
  localSubmitting,
  status,
  values,
}: {
  error: string | null;
  localSubmitted: boolean;
  localSubmitting: "submit" | "cancel" | null;
  status: string;
  values: FormValues;
}) {
  if (error) {
    return "error";
  }
  if (localSubmitting) {
    return "submitting";
  }
  if (localSubmitted || status === "submitted") {
    return "submitted";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (hasAnyFormValue(values)) {
    return "dirty";
  }
  return "active";
}

function hasAnyFormValue(values: FormValues): boolean {
  return Object.values(values).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    return stringValue(value) !== "";
  });
}

function isFieldFilled(field: FormField, value: unknown): boolean {
  if (field.type === "boolean") {
    return value === true;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return stringValue(value) !== "";
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
