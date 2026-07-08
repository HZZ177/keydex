import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type {
  A2UICancelHandler,
  A2UISubmitHandler,
  ParsedA2UIMessage,
} from "./A2UIBlock";
import styles from "./A2ChoiceBlock.module.css";
import {
  A2UIMotionItem,
  A2UIMotionRoot,
} from "./A2UIMotion";
import revealStyles from "./A2UIReveal.module.css";

export interface A2ChoiceBlockProps {
  message: ConversationMessage;
  parsed: ParsedA2UIMessage;
  onSubmit?: A2UISubmitHandler;
  onCancel?: A2UICancelHandler;
}

interface ChoiceOption {
  label: string;
  value: string;
  description: string;
}

interface ChoiceModel {
  description: string;
  multiple: boolean;
  minSelected: number;
  maxSelected: number | null;
  options: ChoiceOption[];
  status: string;
  selectedValues: string[];
  note: string;
  cancelReason: string;
  resumeStatus: string;
}

export function A2ChoiceBlock({ message, parsed, onSubmit, onCancel }: A2ChoiceBlockProps) {
  const model = useMemo(() => choiceModel(parsed), [parsed]);
  const [selectedValues, setSelectedValues] = useState<string[]>(() => initialSelection(model));
  const [note, setNote] = useState("");
  const [localSubmitting, setLocalSubmitting] = useState<"submit" | "cancel" | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionable =
    model.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false &&
    !localSubmitted;
  const validation = validateSelection(selectedValues, model);
  const canSubmit = actionable && Boolean(onSubmit) && !localSubmitting && !validation;
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;

  useEffect(() => {
    setSelectedValues(initialSelection(model));
    setNote("");
    setLocalSubmitting(null);
    setLocalSubmitted(false);
    setError(null);
  }, [parsed.interactionId, model.status]);

  const toggle = (value: string) => {
    if (!actionable || localSubmitting) {
      return;
    }
    setSelectedValues((current) => {
      if (!model.multiple) {
        return [value];
      }
      if (current.includes(value)) {
        return current.filter((item) => item !== value);
      }
      if (model.maxSelected !== null && current.length >= model.maxSelected) {
        return current;
      }
      return [...current, value];
    });
  };

  const submit = async () => {
    if (!canSubmit || !onSubmit || !parsed.interactionId) {
      return;
    }
    setLocalSubmitting("submit");
    setError(null);
    try {
      const trimmed = note.trim();
      await onSubmit(
        parsed.interactionId,
        {
          selected_values: selectedValues,
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
    <A2UIMotionRoot as="section" className={styles.choice} data-testid="a2ui-choice" {...parsed.streamPlayer?.rootProps}>
      {model.description ? (
        <A2UIMotionItem as="p" className={styles.description} motionKey="choice:description" motionKind="choice-description">
          {model.description}
        </A2UIMotionItem>
      ) : null}
      {model.status === "waiting_input" ? (
        <>
          <div className={styles.options} role={model.multiple ? "group" : "radiogroup"} aria-label="选项">
            {model.options.map((option, index) => {
              const unitKey = choiceOptionUnitKey(option, index);
              const selected = selectedValues.includes(option.value);
              return (
                <A2UIMotionItem
                  as="label"
                  className={[styles.option, revealStyles.revealItem].join(" ")}
                  data-selected={selected ? "true" : "false"}
                  data-disabled={!actionable ? "true" : "false"}
                  key={option.value}
                  motionKey={unitKey}
                  motionKind="choice-option"
                >
                  <input
                    type={model.multiple ? "checkbox" : "radio"}
                    name={`${message.id}:choice`}
                    value={option.value}
                    checked={selected}
                    disabled={!actionable || Boolean(localSubmitting)}
                    onChange={() => toggle(option.value)}
                  />
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>{option.label}</span>
                    {option.description ? <span className={styles.optionDescription}>{option.description}</span> : null}
                  </span>
                </A2UIMotionItem>
              );
            })}
          </div>
          <A2UIMotionItem
            as="div"
            className={[styles.help, revealStyles.revealCompactItem].join(" ")}
            motionKey="choice:help"
            motionKind="choice-help"
          >
            {choiceHelp(model)}
          </A2UIMotionItem>
          <A2UIMotionItem
            as="div"
            className={[styles.note, revealStyles.revealCompactItem].join(" ")}
            motionKey="choice:note"
            motionKind="choice-note"
          >
            <label htmlFor={`${message.id}:a2ui-choice-note`}>备注</label>
            <textarea
              id={`${message.id}:a2ui-choice-note`}
              value={note}
              maxLength={500}
              disabled={!actionable || Boolean(localSubmitting)}
              placeholder="可选"
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </A2UIMotionItem>
          {validation ? <div className={styles.error}>{validation}</div> : null}
          <A2UIMotionItem
            as="div"
            className={[styles.actions, revealStyles.revealCompactItem].join(" ")}
            aria-label="选择操作"
            motionKey="choice:actions"
            motionKind="choice-actions"
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
              <span>{localSubmitting === "submit" ? "正在提交" : "提交选择"}</span>
            </button>
          </A2UIMotionItem>
        </>
      ) : (
        <ChoiceResult model={model} />
      )}
      {error ? <div className={styles.error}>{error}</div> : null}
    </A2UIMotionRoot>
  );
}

function ChoiceResult({ model }: { model: ChoiceModel }) {
  if (model.status === "cancelled") {
    return (
      <div className={styles.result} data-testid="a2ui-choice-result">
        <strong>已取消</strong>
        {model.cancelReason ? <span>原因：{model.cancelReason}</span> : null}
        {model.resumeStatus ? <span>恢复状态：{model.resumeStatus}</span> : null}
      </div>
    );
  }
  if (model.status === "submitted") {
    const selectedLabels = model.selectedValues.map((value) => labelForValue(model.options, value));
    return (
      <div className={styles.result} data-testid="a2ui-choice-result">
        <strong>已提交选择</strong>
        <div className={styles.selectedList}>
          {selectedLabels.map((label) => (
            <span className={styles.selectedPill} key={label}>
              {label}
            </span>
          ))}
        </div>
        {model.note ? <span>备注：{model.note}</span> : null}
        {model.resumeStatus ? <span>恢复状态：{model.resumeStatus}</span> : null}
      </div>
    );
  }
  return (
    <div className={styles.result} data-testid="a2ui-choice-result">
      <strong>等待状态更新</strong>
    </div>
  );
}

function choiceModel(parsed: ParsedA2UIMessage): ChoiceModel {
  const payload = parsed.payload;
  const interaction = parsed.interaction;
  const selectedResult = selectedValuesFrom(interaction?.submit_result);
  return {
    description: scalarText(payload.description) || scalarText(payload.desc) || scalarText(payload.message),
    multiple: booleanValue(payload.multiple) || scalarText(payload.selection_type) === "multiple",
    minSelected: numberValue(payload.min_selected) ?? 1,
    maxSelected: numberValue(payload.max_selected),
    options: choiceOptions(payload.options),
    status: normalizeStatus(interaction?.status ?? parsed.status),
    selectedValues: selectedResult,
    note: noteFrom(interaction?.submit_result),
    cancelReason: scalarText(interaction?.cancel_reason),
    resumeStatus: scalarText(interaction?.resume_status),
  };
}

function choiceOptionUnitKey(option: ChoiceOption, index: number): string {
  return `choice:option:${option.value || index}`;
}

function initialSelection(model: ChoiceModel): string[] {
  if (model.status === "submitted") {
    return model.selectedValues;
  }
  return [];
}

function validateSelection(selectedValues: string[], model: ChoiceModel): string | null {
  if (selectedValues.length < model.minSelected) {
    return model.minSelected <= 1 ? "请选择一个选项" : `请至少选择 ${model.minSelected} 个选项`;
  }
  if (model.maxSelected !== null && selectedValues.length > model.maxSelected) {
    return `最多选择 ${model.maxSelected} 个选项`;
  }
  return null;
}

function choiceHelp(model: ChoiceModel): string {
  if (!model.multiple) {
    return "单选";
  }
  if (model.maxSelected !== null) {
    return `多选，最多 ${model.maxSelected} 项`;
  }
  if (model.minSelected > 1) {
    return `多选，至少 ${model.minSelected} 项`;
  }
  return "多选";
}

function choiceOptions(value: unknown): ChoiceOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const option = asRecord(item);
      const valueText = scalarText(option?.value);
      const label = scalarText(option?.label) || scalarText(option?.title) || valueText;
      if (!valueText || !label) {
        return null;
      }
      return {
        value: valueText,
        label,
        description: scalarText(option?.description) || scalarText(option?.desc),
      };
    })
    .filter((item): item is ChoiceOption => Boolean(item));
}

function selectedValuesFrom(value: unknown): string[] {
  const record = asRecord(value);
  const selected = record?.selected_values ?? record?.selectedValues ?? record?.selected_options ?? record?.selectedOptions;
  if (!Array.isArray(selected)) {
    return [];
  }
  return selected.map((item) => scalarText(item)).filter(Boolean);
}

function noteFrom(value: unknown): string {
  const record = asRecord(value);
  return scalarText(record?.note) || scalarText(record?.comment);
}

function labelForValue(options: ChoiceOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
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

function booleanValue(value: unknown): boolean {
  return value === true;
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
