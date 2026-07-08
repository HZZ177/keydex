import { useEffect, useMemo, useRef, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type {
  A2UICancelHandler,
  A2UISubmitHandler,
  ParsedA2UIMessage,
} from "./A2UIBlock";
import styles from "./A2ChoiceBlock.module.css";
import type { A2UIRenderState } from "./A2UIState";
import { A2UIStateLine } from "./A2UIStateLine";
import {
  A2ActionMotionButton,
  A2InteractiveMotionItem,
  A2InteractiveMotionRoot,
  A2MotionPresence,
} from "./A2UIMotion";

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
  badge: string;
  disabled: boolean;
  recommended: boolean;
}

interface ChoiceModel {
  title: string;
  description: string;
  multiple: boolean;
  minSelected: number;
  maxSelected: number | null;
  defaultValues: string[];
  options: ChoiceOption[];
  status: string;
  selectedValues: string[];
  note: string;
  renderState: A2UIRenderState;
}

type ActionKind = "submit" | "cancel";
type ActionBadgeStage = "idle" | "loading" | "done";
type ActionBadgePhase = {
  kind: ActionKind;
  stage: Exclude<ActionBadgeStage, "idle">;
};

const ACTION_BADGE_DONE_MS = 420;

export function A2ChoiceBlock({ message, parsed, onSubmit, onCancel }: A2ChoiceBlockProps) {
  const model = useMemo(() => choiceModel(parsed), [parsed]);
  const [selectedValues, setSelectedValues] = useState<string[]>(() => initialSelection(model));
  const [note, setNote] = useState("");
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
  const validation = validateSelection(selectedValues, model);
  const canSubmit = actionable && Boolean(onSubmit) && !localSubmitting && !validation;
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;
  const showInputPreview = model.status === "waiting_input" || isStreamingPreviewStatus(model.status);
  const motionLive = shouldUseInteractiveChoiceMotion(parsed, model.status);
  const motionState = choiceMotionState({
    error,
    localSubmitted,
    localSubmitting,
    selectedCount: selectedValues.length,
    status: model.status,
  });
  const cancelBadgeStage = actionBadgeStage(actionPhase, "cancel");
  const submitBadgeStage = actionBadgeStage(actionPhase, "submit");
  const cancelButtonLabel = actionBadgeLabel(cancelBadgeStage, "取消", "取消中", "已取消");
  const submitButtonLabel = actionBadgeLabel(submitBadgeStage, "提交选择", "提交中", "已提交");
  const actionState =
    actionPhase?.kind ?? localSubmitting ?? (localSubmitted ? "submitted" : selectedValues.length ? "dirty" : "idle");

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    actionTokenRef.current += 1;
    setSelectedValues(initialSelection(model));
    setNote("");
    setLocalSubmitting(null);
    setActionPhase(null);
    setLocalSubmitted(false);
    setError(null);
  }, [parsed.interactionId, model.status]);

  const toggle = (value: string) => {
    if (!actionable || localSubmitting) {
      return;
    }
    if (model.options.find((option) => option.value === value)?.disabled) {
      return;
    }
    setSelectedValues((current) => {
      if (!model.multiple) {
        return current.includes(value) ? [] : [value];
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
          selected_values: selectedValues,
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
      className={styles.choice}
      data-testid="a2ui-choice"
      live={motionLive}
      motionScope={interactiveChoiceMotionScope(message.id, parsed)}
      motionState={motionState}
      {...parsed.streamPlayer?.rootProps}
    >
      <A2InteractiveMotionItem
        className={styles.intro}
        live={motionLive}
        motionKey="choice:intro"
        motionKind="choice-intro"
        variant="intro"
      >
        <h3 className={styles.title}>{model.title}</h3>
        {model.description ? <p className={styles.description}>{model.description}</p> : null}
      </A2InteractiveMotionItem>
      <A2MotionPresence>
        {showInputPreview ? (
          <A2InteractiveMotionItem
            className={styles.stage}
            key="choice-input"
            live={motionLive}
            motionKey="choice:input-stage"
            motionKind="choice-stage"
            variant="scene"
          >
            <div className={styles.timelineShell}>
              <div className={styles.options} role={model.multiple ? "group" : "radiogroup"} aria-label="选项">
                {model.options.map((option, index) => {
                  const unitKey = choiceOptionUnitKey(option, index);
                  const selected = selectedValues.includes(option.value);
                  const interactive = actionable && !localSubmitting && !option.disabled;
                  return (
                    <A2InteractiveMotionItem
                      as="label"
                      className={styles.option}
                      data-selected={selected ? "true" : "false"}
                      data-disabled={!actionable || option.disabled ? "true" : "false"}
                      data-recommended={option.recommended ? "true" : "false"}
                      interactive={interactive}
                      key={option.value}
                      live={motionLive}
                      motionKey={unitKey}
                      motionKind="choice-option"
                      onClick={(event) => {
                        event.preventDefault();
                        toggle(option.value);
                      }}
                      order={index + 1}
                      selected={selected}
                      variant="option"
                    >
                      <span className={styles.optionEffect} aria-hidden="true" />
                      <OptionMorphIndicator />
                      <input
                        type={model.multiple ? "checkbox" : "radio"}
                        name={`${message.id}:choice`}
                        value={option.value}
                        checked={selected}
                        disabled={!actionable || option.disabled || Boolean(localSubmitting)}
                        readOnly
                      />
                      <span className={styles.optionText}>
                        <span className={styles.optionHeader}>
                          <span className={styles.optionLabel}>{option.label}</span>
                          {option.recommended ? <span className={styles.recommendedBadge}>推荐</span> : null}
                          {option.badge ? <span className={styles.optionBadge}>{option.badge}</span> : null}
                        </span>
                        {option.description ? <span className={styles.optionDescription}>{option.description}</span> : null}
                      </span>
                    </A2InteractiveMotionItem>
                  );
                })}
              </div>
            </div>
            {!model.options.length ? (
              <A2InteractiveMotionItem
                className={styles.previewEmpty}
                live={motionLive}
                motionKey="choice:preview-empty"
                motionKind="choice-preview-empty"
                variant="compact"
              >
                正在生成选项
              </A2InteractiveMotionItem>
            ) : null}
            <div className={styles.workflowFooter}>
              <A2InteractiveMotionItem
                className={styles.correctionPanel}
                live={motionLive}
                motionKey="choice:correction"
                motionKind="choice-correction"
                variant="field"
              >
                <label htmlFor={`${message.id}:a2ui-choice-correction`}>
                  不对！输入信息告诉 Keydex 应该怎么做
                </label>
                <textarea
                  id={`${message.id}:a2ui-choice-correction`}
                  value={note}
                  maxLength={500}
                  disabled={!actionable || Boolean(localSubmitting)}
                  placeholder="例如：换一组更保守的选项，或者补充一个新的判断条件..."
                  onChange={(event) => setNote(event.currentTarget.value)}
                />
              </A2InteractiveMotionItem>
              <div className={styles.actionStatus}>
                <A2InteractiveMotionItem
                  className={styles.help}
                  live={motionLive}
                  motionKey="choice:help"
                  motionKind="choice-help"
                  variant="tray"
                >
                  {choiceHelp(model, selectedValues.length)}
                </A2InteractiveMotionItem>
                {model.status === "waiting_input" && validation ? <div className={styles.error}>{validation}</div> : null}
              </div>
              <A2InteractiveMotionItem
                className={styles.actions}
                aria-label="选择操作"
                data-action-state={actionState}
                live={motionLive}
                motionKey="choice:actions"
                motionKind="choice-actions"
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
                  <ActionBadgeContent doneLabel="已提交" idleLabel="提交选择" loadingLabel="提交中" stage={submitBadgeStage} />
                </A2ActionMotionButton>
              </A2InteractiveMotionItem>
            </div>
          </A2InteractiveMotionItem>
        ) : (
          <ChoiceResult live={motionLive} model={model} />
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

function ChoiceResult({ live, model }: { live: boolean; model: ChoiceModel }) {
  const selectedValues = new Set(model.selectedValues);
  const resultStatus = model.status === "submitted" ? "submitted" : model.status === "cancelled" ? "cancelled" : "pending";
  if (model.status === "submitted") {
    return (
      <A2InteractiveMotionItem
        className={styles.readonlyState}
        data-result-status={resultStatus}
        data-testid="a2ui-choice-result"
        key="choice-result"
        live={live}
        motionKey="choice:result"
        motionKind="choice-result"
        variant="result"
      >
        <ReadonlyChoiceOptions model={model} selectedValues={selectedValues} />
        <ChoiceOutcomeLine model={model} selectedCount={selectedValues.size} />
        {model.note ? <ReadonlyNote value={model.note} /> : null}
      </A2InteractiveMotionItem>
    );
  }
  return (
    <A2InteractiveMotionItem
      className={styles.readonlyState}
      data-result-status={resultStatus}
      data-testid="a2ui-choice-result"
      key="choice-result"
      live={live}
      motionKey="choice:result"
      motionKind="choice-result"
      variant="result"
    >
      <ReadonlyChoiceOptions model={model} selectedValues={selectedValues} />
      <ChoiceOutcomeLine model={model} selectedCount={selectedValues.size} />
    </A2InteractiveMotionItem>
  );
}

function OptionMorphIndicator() {
  return (
    <span className={styles.optionMorph} data-a2ui-choice-morph="true" aria-hidden="true">
      <span />
      <span />
    </span>
  );
}

function ChoiceOutcomeLine({ model, selectedCount }: { model: ChoiceModel; selectedCount: number }) {
  if (model.renderState.outcome === "submitted") {
    return (
      <A2UIStateLine tone="success" testId="a2ui-choice-state-line">
        {selectedCount ? `本次选择已提交 · ${selectedCount} 项` : "本次选择已提交"}
      </A2UIStateLine>
    );
  }
  if (model.renderState.outcome === "cancelled_by_user") {
    return (
      <A2UIStateLine tone="warning" testId="a2ui-choice-state-line">
        已取消本次选择
      </A2UIStateLine>
    );
  }
  return null;
}

function ReadonlyChoiceOptions({ model, selectedValues }: { model: ChoiceModel; selectedValues: Set<string> }) {
  if (!model.options.length) {
    return null;
  }
  const hasSelection = selectedValues.size > 0;
  return (
    <div className={styles.options} role="list" aria-label="历史选项">
      {model.options.map((option, index) => {
        const selected = selectedValues.has(option.value);
        const dimmed = hasSelection && !selected;
        return (
          <div
            className={styles.option}
            data-dimmed={dimmed ? "true" : "false"}
            data-readonly="true"
            data-selected={selected ? "true" : "false"}
            data-disabled={option.disabled ? "true" : "false"}
            data-recommended={option.recommended ? "true" : "false"}
            key={option.value || index}
            role="listitem"
          >
            <span className={styles.optionEffect} aria-hidden="true" />
            <OptionMorphIndicator />
            <input
              aria-hidden="true"
              checked={selected}
              readOnly
              tabIndex={-1}
              type={model.multiple ? "checkbox" : "radio"}
              value={option.value}
            />
            <span className={styles.optionText}>
              <span className={styles.optionHeader}>
                <span className={styles.optionLabel}>{option.label}</span>
                {option.recommended ? <span className={styles.recommendedBadge}>推荐</span> : null}
                {option.badge ? <span className={styles.optionBadge}>{option.badge}</span> : null}
              </span>
              {option.description ? <span className={styles.optionDescription}>{option.description}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReadonlyNote({ value }: { value: string }) {
  return (
    <div className={styles.readonlyNote}>
      <span>给 Keydex 的补充信息</span>
      <p>{value}</p>
    </div>
  );
}

function choiceModel(parsed: ParsedA2UIMessage): ChoiceModel {
  const payload = parsed.payload;
  const interaction = parsed.interaction;
  const selectedResult = selectedValuesFrom(interaction?.submit_result);
  const options = choiceOptions(payload.options);
  return {
    title: scalarText(payload.title) || "请选择",
    description: scalarText(payload.description) || scalarText(payload.desc) || scalarText(payload.message),
    multiple: booleanValue(payload.multiple) || scalarText(payload.selection_type) === "multiple",
    minSelected: numberValue(payload.min_selected) ?? 1,
    maxSelected: numberValue(payload.max_selected),
    defaultValues: normalizeDefaultValues(payload.default_values ?? payload.defaultValues ?? payload.default_value, options),
    options,
    status: normalizeStatus(interaction?.status ?? parsed.status),
    selectedValues: selectedResult,
    note: noteFrom(interaction?.submit_result),
    renderState: parsed.renderState,
  };
}

function choiceOptionUnitKey(option: ChoiceOption, index: number): string {
  return `choice:option:${option.value || index}`;
}

function initialSelection(model: ChoiceModel): string[] {
  if (model.status === "submitted") {
    return model.selectedValues;
  }
  if (!model.defaultValues.length) {
    return [];
  }
  return model.multiple ? model.defaultValues : model.defaultValues.slice(0, 1);
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

function choiceHelp(model: ChoiceModel, selectedCount: number): string {
  const selectedText = selectedCount ? `已选 ${selectedCount} 项` : "未选择";
  if (!model.multiple) {
    return `${selectedText} / 单选`;
  }
  if (model.maxSelected !== null) {
    return `${selectedText} / 多选，最多 ${model.maxSelected} 项`;
  }
  if (model.minSelected > 1) {
    return `${selectedText} / 多选，至少 ${model.minSelected} 项`;
  }
  return `${selectedText} / 多选`;
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
        badge: scalarText(option?.badge) || scalarText(option?.tag),
        disabled: option?.disabled === true,
        recommended: option?.recommended === true,
      };
    })
    .filter((item): item is ChoiceOption => Boolean(item));
}

function normalizeDefaultValues(value: unknown, options: ChoiceOption[]): string[] {
  const rawValues = Array.isArray(value) ? value : scalarText(value) ? [value] : [];
  const allowedValues = new Set(options.filter((option) => !option.disabled).map((option) => option.value));
  return rawValues
    .map((item) => scalarText(item))
    .filter((item) => allowedValues.has(item));
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

function isStreamingPreviewStatus(status: string): boolean {
  return status === "started" || status === "streaming" || status === "finished";
}

function shouldUseInteractiveChoiceMotion(parsed: ParsedA2UIMessage, status: string): boolean {
  if (parsed.historyHydrated) {
    return false;
  }
  return Boolean(parsed.streamPlayer?.enabled) ||
    status === "waiting_input" ||
    status === "submitted" ||
    status === "cancelled" ||
    isStreamingPreviewStatus(status);
}

function interactiveChoiceMotionScope(messageId: string, parsed: ParsedA2UIMessage): string {
  return [
    parsed.a2ui?.stream_id,
    parsed.debug?.streamId,
    parsed.interactionId,
    messageId,
    "choice",
  ].filter(Boolean).join(":");
}

function choiceMotionState({
  error,
  localSubmitted,
  localSubmitting,
  selectedCount,
  status,
}: {
  error: string | null;
  localSubmitted: boolean;
  localSubmitting: "submit" | "cancel" | null;
  selectedCount: number;
  status: string;
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
  if (selectedCount) {
    return "dirty";
  }
  return "active";
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
