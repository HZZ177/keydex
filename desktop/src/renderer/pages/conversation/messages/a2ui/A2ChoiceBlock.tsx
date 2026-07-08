import * as SliderPrimitive from "@radix-ui/react-slider";
import { type MouseEvent as ReactMouseEvent, type PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

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
  type A2InteractiveMotionTransition,
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
type ChoiceDetailPreview = {
  left: number;
  maxHeight: number;
  option: ChoiceOption;
  placement: "bottom" | "top";
  state: "closing" | "open";
  top: number;
};
type ChoiceCarouselDragState = {
  lastTime: number;
  lastX: number;
  moved: boolean;
  optionElement: HTMLElement | null;
  optionValue: string | null;
  pointerId: number;
  startTrackX: number;
  startX: number;
  velocityX: number;
};

const ACTION_BADGE_DONE_MS = 420;
const DETAIL_POPOVER_CLOSE_GRACE_MS = 260;
const DETAIL_POPOVER_GAP = 10;
const DETAIL_POPOVER_HOVER_DELAY_MS = 500;
const DETAIL_POPOVER_MAX_HEIGHT = 240;
const DETAIL_POPOVER_OUT_MS = 160;
const DETAIL_POPOVER_WIDTH = 360;
const CHOICE_CAROUSEL_SLIDER_THRESHOLD = 10;
const OPTION_CARD_DESCRIPTION_LIMIT = 96;
const CHOICE_CARD_LAYOUT_TRANSITION: A2InteractiveMotionTransition = {
  layout: {
    duration: 0.62,
    ease: [0.22, 1, 0.36, 1],
  },
  opacity: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
};

export function A2ChoiceBlock({ message, parsed, onSubmit, onCancel }: A2ChoiceBlockProps) {
  const rawModel = useMemo(() => choiceModel(parsed), [parsed]);
  const model = useStableChoiceModel(rawModel, parsed);
  const [selectedValues, setSelectedValues] = useState<string[]>(() => initialSelection(model));
  const [carouselOptionValue, setCarouselOptionValue] = useState<string | null>(null);
  const [detailPreview, setDetailPreview] = useState<ChoiceDetailPreview | null>(null);
  const [correctionMode, setCorrectionMode] = useState(false);
  const [note, setNote] = useState("");
  const [localSubmitting, setLocalSubmitting] = useState<"submit" | "cancel" | null>(null);
  const [actionPhase, setActionPhase] = useState<ActionBadgePhase | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const actionTokenRef = useRef(0);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const optionTrackRef = useRef<HTMLDivElement | null>(null);
  const carouselTrackXRef = useRef(0);
  const carouselAnimationFrameRef = useRef<number | null>(null);
  const detailHideTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const detailHoverTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const detailRemoveTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const carouselDragRef = useRef<ChoiceCarouselDragState | null>(null);
  const suppressCarouselClickRef = useRef(false);
  const actionable =
    model.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false &&
    !localSubmitted;
  const validation = correctionMode ? validateCorrectionNote(note) : validateSelection(selectedValues, model);
  const canSubmit = actionable && Boolean(onSubmit) && !localSubmitting && !validation;
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;
  const showInputPreview = model.status === "waiting_input" || isStreamingPreviewStatus(model.status);
  const choiceStreaming = isChoiceStreaming(model.status, parsed.streamPlayer, parsed.historyHydrated);
  const motionLive = shouldUseInteractiveChoiceMotion(parsed, model.status);
  const motionState = choiceMotionState({
    error,
    localSubmitted,
    localSubmitting,
    selectedCount: selectedValues.length + (correctionMode ? 1 : 0),
    status: model.status,
  });
  const cancelBadgeStage = actionBadgeStage(actionPhase, "cancel");
  const submitBadgeStage = actionBadgeStage(actionPhase, "submit");
  const cancelButtonLabel = actionBadgeLabel(cancelBadgeStage, "取消", "取消中", "已取消");
  const submitButtonLabel = actionBadgeLabel(submitBadgeStage, "提交选择", "提交中", "已提交");
  const actionState =
    actionPhase?.kind ?? localSubmitting ?? (localSubmitted ? "submitted" : selectedValues.length || correctionMode ? "dirty" : "idle");
  const visibleValidation =
    (correctionMode ? submitAttempted : selectedValues.length > 0) ? validation : null;
  const cardDensity = choiceCardDensity(model.options.length);
  const latestStreamingOptionValue = choiceStreaming ? latestChoiceOptionValue(model.options) : null;
  const centeredOptionValue =
    latestStreamingOptionValue ?? choiceCarouselCenterValue(model, carouselOptionValue);
  const centeredOptionIndex = centeredOptionValue
    ? model.options.findIndex((option) => option.value === centeredOptionValue)
    : -1;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (carouselAnimationFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(carouselAnimationFrameRef.current);
      }
      clearDetailTimer(detailHoverTimerRef);
      clearDetailTimer(detailHideTimerRef);
      clearDetailTimer(detailRemoveTimerRef);
    };
  }, []);

  useEffect(() => {
    actionTokenRef.current += 1;
    setSelectedValues(initialSelection(model));
    setCorrectionMode(false);
    setNote("");
    setLocalSubmitting(null);
    setActionPhase(null);
    setLocalSubmitted(false);
    setSubmitAttempted(false);
    setCarouselOptionValue(null);
    setDetailPreview(null);
    clearDetailTimer(detailHoverTimerRef);
    clearDetailTimer(detailHideTimerRef);
    clearDetailTimer(detailRemoveTimerRef);
    setError(null);
  }, [parsed.interactionId, model.status]);

  useEffect(() => {
    if (!carouselOptionValue || model.options.some((option) => option.value === carouselOptionValue)) {
      return;
    }
    setCarouselOptionValue(null);
  }, [carouselOptionValue, model.options]);

  useEffect(() => {
    if (!detailPreview || model.options.some((option) => option.value === detailPreview.option.value)) {
      return;
    }
    setDetailPreview(null);
  }, [detailPreview, model.options]);

  useEffect(() => {
    if (!choiceStreaming || !latestStreamingOptionValue) {
      return;
    }
    setCarouselOptionValue((current) => current === latestStreamingOptionValue ? current : latestStreamingOptionValue);
  }, [choiceStreaming, latestStreamingOptionValue]);

  useLayoutEffect(() => {
    if (!centeredOptionValue || !optionsRef.current) {
      return;
    }
    alignCarouselOption(optionsRef.current, optionTrackRef.current, centeredOptionValue, true, carouselTrackXRef);
  }, [centeredOptionValue, model.options.length]);

  const handleCarouselPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !optionTrackRef.current) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("button, input, textarea, select, a")) {
      return;
    }
    const optionElement = target?.closest<HTMLElement>("[data-option-value]") ?? null;
    suppressCarouselClickRef.current = false;
    carouselDragRef.current = {
      lastTime: performance.now(),
      lastX: event.clientX,
      moved: false,
      optionElement,
      optionValue: optionElement?.dataset.optionValue ?? null,
      pointerId: event.pointerId,
      startTrackX: carouselTrackXRef.current,
      startX: event.clientX,
      velocityX: 0,
    };
    event.currentTarget.dataset.dragging = "true";
    setCarouselTrackX(event.currentTarget, optionTrackRef.current, carouselTrackXRef.current, false, carouselTrackXRef);
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handleCarouselPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = carouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const track = optionTrackRef.current;
    if (!track) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) > 4) {
      drag.moved = true;
      suppressCarouselClickRef.current = true;
    }
    if (!drag.moved) {
      return;
    }
    event.preventDefault();
    const now = performance.now();
    const elapsed = Math.max(1, now - drag.lastTime);
    drag.velocityX = (event.clientX - drag.lastX) / elapsed;
    drag.lastX = event.clientX;
    drag.lastTime = now;
    const nextX = clampCarouselTrackX(event.currentTarget, track, drag.startTrackX + deltaX);
    setCarouselTrackX(event.currentTarget, track, nextX, false, carouselTrackXRef);
  };

  const finishCarouselPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = carouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    carouselDragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      typeof event.currentTarget.releasePointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      event.preventDefault();
      const track = optionTrackRef.current;
      const projectedX = track
        ? clampCarouselTrackX(event.currentTarget, track, carouselTrackXRef.current + drag.velocityX * 280)
        : carouselTrackXRef.current;
      const closestValue = closestCarouselOptionValue(event.currentTarget, track, projectedX);
      if (closestValue) {
        setCarouselOptionValue(closestValue);
        alignCarouselOption(event.currentTarget, track, closestValue, true, carouselTrackXRef);
      }
      globalThis.setTimeout(() => {
        suppressCarouselClickRef.current = false;
      }, 0);
      return;
    }
    if (drag.optionValue && drag.optionElement) {
      event.preventDefault();
      suppressCarouselClickRef.current = true;
      focusCarouselOption(drag.optionValue, drag.optionElement);
      globalThis.setTimeout(() => {
        suppressCarouselClickRef.current = false;
      }, 0);
    }
  };

  const focusCarouselOption = (value: string, target?: HTMLElement | null, persist = true) => {
    if (persist) {
      setCarouselOptionValue(value);
    }
    const container = optionsRef.current;
    if (!container || !optionTrackRef.current) {
      return;
    }
    if (carouselAnimationFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(carouselAnimationFrameRef.current);
    }
    if (target) {
      alignCarouselElement(container, optionTrackRef.current, target, true, carouselTrackXRef);
      return;
    }
    carouselAnimationFrameRef.current = globalThis.requestAnimationFrame(() => {
      carouselAnimationFrameRef.current = null;
      alignCarouselOption(container, optionTrackRef.current, value, true, carouselTrackXRef);
    });
  };

  const toggle = (value: string) => {
    if (!actionable || localSubmitting) {
      return;
    }
    if (model.options.find((option) => option.value === value)?.disabled) {
      return;
    }
    const nextSelection = nextChoiceSelection(selectedValues, value, model);
    setCorrectionMode(false);
    setNote("");
    setSubmitAttempted(false);
    setSelectedValues(nextSelection);
  };

  const toggleCorrectionMode = () => {
    if (!actionable || localSubmitting) {
      return;
    }
    setCorrectionMode((current) => {
      const next = !current;
      if (next) {
        setSelectedValues([]);
      } else {
        setNote("");
      }
      setSubmitAttempted(false);
      return next;
    });
  };

  const scheduleDetailPreview = (option: ChoiceOption, target: HTMLElement) => {
    if (!choiceOptionExpandable(option)) {
      return;
    }
    clearDetailTimer(detailHoverTimerRef);
    clearDetailTimer(detailHideTimerRef);
    clearDetailTimer(detailRemoveTimerRef);
    detailHoverTimerRef.current = globalThis.setTimeout(() => {
      detailHoverTimerRef.current = null;
      if (!mountedRef.current || !target.isConnected) {
        return;
      }
      setDetailPreview({
        option,
        state: "open",
        ...choiceDetailPopoverPosition(target),
      });
    }, DETAIL_POPOVER_HOVER_DELAY_MS);
  };

  const scheduleDetailPreviewClose = () => {
    clearDetailTimer(detailHoverTimerRef);
    clearDetailTimer(detailHideTimerRef);
    clearDetailTimer(detailRemoveTimerRef);
    detailHideTimerRef.current = globalThis.setTimeout(() => {
      detailHideTimerRef.current = null;
      if (mountedRef.current) {
        setDetailPreview((current) => current ? { ...current, state: "closing" } : null);
        detailRemoveTimerRef.current = globalThis.setTimeout(() => {
          detailRemoveTimerRef.current = null;
          if (mountedRef.current) {
            setDetailPreview(null);
          }
        }, DETAIL_POPOVER_OUT_MS);
      }
    }, DETAIL_POPOVER_CLOSE_GRACE_MS);
  };

  const keepDetailPreviewOpen = () => {
    clearDetailTimer(detailHideTimerRef);
    clearDetailTimer(detailRemoveTimerRef);
    setDetailPreview((current) => current ? { ...current, state: "open" } : null);
  };

  const handleOptionContentEnter = (option: ChoiceOption, event: ReactMouseEvent<HTMLElement>) => {
    scheduleDetailPreview(option, event.currentTarget);
  };

  const submit = async () => {
    setSubmitAttempted(true);
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
          selected_values: correctionMode ? [] : selectedValues,
          ...(correctionMode && trimmed ? { result_type: "correction", correction_note: trimmed } : {}),
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
              <ChoiceCarouselSlider
                ariaLabel="快速定位选项"
                count={model.options.length}
                currentIndex={centeredOptionIndex}
                disabled={choiceStreaming}
                onChange={(index) => {
                  const option = model.options[index];
                  if (option) {
                    focusCarouselOption(option.value);
                  }
                }}
              />
              <div
                ref={optionsRef}
                className={styles.options}
                data-a2ui-choice-layout="coverflow"
                data-choice-density={cardDensity}
                role={model.multiple ? "group" : "radiogroup"}
                aria-label="选项"
                onPointerCancel={finishCarouselPointerDrag}
                onPointerDown={handleCarouselPointerDown}
                onPointerMove={handleCarouselPointerMove}
                onPointerUp={finishCarouselPointerDrag}
              >
                <div ref={optionTrackRef} className={styles.optionTrack} data-a2ui-choice-track="true">
                  {model.options.map((option, index) => {
                    const unitKey = choiceOptionUnitKey(option, index);
                    const selected = selectedValues.includes(option.value);
                    const interactive = actionable && !localSubmitting && !option.disabled;
                    const coverflowOffset = centeredOptionIndex >= 0 ? index - centeredOptionIndex : index;
                    const coverflowPosition = choiceCoverflowPosition(coverflowOffset);
                    return (
                      <A2InteractiveMotionItem
                        as="div"
                        className={styles.option}
                        data-option-value={option.value}
                        data-coverflow-position={coverflowPosition}
                        data-selected={selected ? "true" : "false"}
                        data-disabled={!actionable || option.disabled ? "true" : "false"}
                        data-recommended={option.recommended ? "true" : "false"}
                        interactive={interactive}
                        key={option.value}
                        live={motionLive}
                        motionLayout
                        motionTransition={CHOICE_CARD_LAYOUT_TRANSITION}
                        motionKey={unitKey}
                        motionKind="choice-option"
                        onClick={(event) => {
                          event.preventDefault();
                          if (suppressCarouselClickRef.current) {
                            event.stopPropagation();
                            return;
                          }
                          focusCarouselOption(option.value, event.currentTarget);
                        }}
                        order={index + 1}
                        selected={selected}
                        variant="option"
                      >
                        <span className={styles.optionFace} data-a2ui-choice-card="true">
                          <span className={styles.optionCorner} aria-hidden="true">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <input
                            type={model.multiple ? "checkbox" : "radio"}
                            aria-hidden="true"
                            name={`${message.id}:choice`}
                            value={option.value}
                            checked={selected}
                            disabled={!actionable || option.disabled || Boolean(localSubmitting)}
                            readOnly
                            tabIndex={-1}
                          />
                          <span
                            className={styles.optionText}
                            data-a2ui-choice-content="true"
                            onMouseEnter={(event) => handleOptionContentEnter(option, event)}
                            onMouseLeave={scheduleDetailPreviewClose}
                          >
                            <span className={styles.optionHeader}>
                              <span className={styles.optionLabel}>{option.label}</span>
                              {option.recommended ? <span className={styles.recommendedBadge}>推荐</span> : null}
                              {option.badge ? <span className={styles.optionBadge}>{option.badge}</span> : null}
                            </span>
                            {option.description ? (
                              <span className={styles.optionDescription}>
                                {optionSummary(option.description)}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <button
                          aria-label={selected ? `取消选择 ${option.label}` : `选择 ${option.label}`}
                          className={styles.optionStateButton}
                          data-a2ui-choice-action="true"
                          data-a2ui-choice-morph="true"
                          disabled={!interactive}
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const optionElement = event.currentTarget.closest<HTMLElement>("[data-option-value]");
                            focusCarouselOption(option.value, optionElement, false);
                            toggle(option.value);
                          }}
                        >
                          <span className={styles.optionStateIcon} aria-hidden="true">
                            <span className={styles.optionStateDot} />
                            <span className={styles.optionStateDot} />
                            <span className={styles.optionStateDot} />
                            <span className={styles.optionStateDot} />
                          </span>
                          <span className={styles.optionStateLabel}>{selected ? "已选" : "选择"}</span>
                        </button>
                      </A2InteractiveMotionItem>
                    );
                  })}
                </div>
              </div>
            </div>
            {!model.options.length && !choiceStreaming ? (
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
            {model.options.length || choiceStreaming ? (
              <div className={styles.actionStatus}>
                <A2InteractiveMotionItem
                  className={styles.help}
                  live={motionLive}
                  motionKey="choice:help"
                  motionKind="choice-help"
                  variant="tray"
                >
                  {choiceStreaming ? "正在生成选项中，请稍后..." : choiceHelp(model, selectedValues.length, correctionMode, note)}
                </A2InteractiveMotionItem>
                {model.status === "waiting_input" && visibleValidation ? <div className={styles.error}>{visibleValidation}</div> : null}
              </div>
            ) : null}
            <div className={styles.workflowFooter}>
              <A2InteractiveMotionItem
                className={styles.correctionPanel}
                live={motionLive}
                motionKey="choice:correction"
                motionKind="choice-correction"
                variant="field"
              >
                <button
                  aria-expanded={correctionMode}
                  aria-controls={`${message.id}:a2ui-choice-correction`}
                  className={styles.correctionToggle}
                  data-selected={correctionMode ? "true" : "false"}
                  disabled={!actionable || Boolean(localSubmitting)}
                  type="button"
                  onClick={toggleCorrectionMode}
                >
                  以上都不对！我来告诉keydex应该怎么做
                </button>
                {correctionMode ? (
                  <textarea
                    aria-label="我来告诉keydex应该怎么做"
                    autoFocus
                    id={`${message.id}:a2ui-choice-correction`}
                    value={note}
                    maxLength={500}
                    disabled={!actionable || Boolean(localSubmitting)}
                    placeholder="例如：换一组更保守的选项，或者补充一个新的判断条件..."
                    onChange={(event) => setNote(event.currentTarget.value)}
                  />
                ) : null}
              </A2InteractiveMotionItem>
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
      {detailPreview && typeof document !== "undefined"
        ? createPortal(
          <div
            className={styles.optionDetailPopover}
            data-placement={detailPreview.placement}
            data-state={detailPreview.state}
            data-testid="a2ui-choice-detail"
            style={{
              left: detailPreview.left,
              maxHeight: detailPreview.maxHeight,
              top: detailPreview.top,
            }}
            onMouseEnter={keepDetailPreviewOpen}
            onMouseLeave={scheduleDetailPreviewClose}
          >
            <div className={styles.optionDetailHeader}>
              <span>{detailPreview.option.label}</span>
              {detailPreview.option.badge ? <span>{detailPreview.option.badge}</span> : null}
            </div>
            <p>{detailPreview.option.description}</p>
          </div>,
          document.body,
        )
        : null}
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

function ChoiceCarouselSlider({
  ariaLabel,
  count,
  currentIndex,
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  count: number;
  currentIndex: number;
  disabled?: boolean;
  onChange: (index: number) => void;
}) {
  if (count <= CHOICE_CAROUSEL_SLIDER_THRESHOLD) {
    return null;
  }
  const index = Math.round(clampNumber(currentIndex >= 0 ? currentIndex : 0, 0, count - 1));
  const progressLabel = `${index + 1}/${count}`;
  return (
    <div className={styles.carouselSlider}>
      <SliderPrimitive.Root
        className={styles.carouselSliderRoot}
        disabled={disabled}
        max={count - 1}
        min={0}
        step={1}
        value={[index]}
        onValueChange={(value) => {
          const nextIndex = value[0];
          if (typeof nextIndex === "number") {
            onChange(nextIndex);
          }
        }}
      >
        <SliderPrimitive.Track className={styles.carouselSliderTrack}>
          <SliderPrimitive.Range className={styles.carouselSliderRange} />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={ariaLabel}
          aria-valuetext={progressLabel}
          className={styles.carouselSliderThumb}
        >
          <span className={styles.carouselSliderValue} aria-hidden="true">
            <AnimateNumber value={index + 1} />
            <span>/</span>
            <span>{count}</span>
          </span>
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Root>
    </div>
  );
}

function AnimateNumber({ value }: { value: number }) {
  return (
    <motion.span
      key={value}
      animate={{ opacity: 1, y: 0 }}
      className={styles.carouselSliderNumber}
      initial={{ opacity: 0.46, y: 4 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
    >
      {value}
    </motion.span>
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
  const [carouselOptionValue, setCarouselOptionValue] = useState<string | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const optionTrackRef = useRef<HTMLDivElement | null>(null);
  const carouselTrackXRef = useRef(0);
  const carouselDragRef = useRef<ChoiceCarouselDragState | null>(null);
  const initializedRef = useRef(false);
  const centerValue = readonlyChoiceCenterValue(model, selectedValues, carouselOptionValue);

  useLayoutEffect(() => {
    if (!centerValue || !optionsRef.current) {
      return;
    }
    alignCarouselOption(optionsRef.current, optionTrackRef.current, centerValue, initializedRef.current, carouselTrackXRef);
    initializedRef.current = true;
  }, [centerValue, model.options.length]);

  useEffect(() => {
    if (!carouselOptionValue || model.options.some((option) => option.value === carouselOptionValue)) {
      return;
    }
    setCarouselOptionValue(null);
  }, [carouselOptionValue, model.options]);

  if (!model.options.length) {
    return null;
  }
  const hasSelection = selectedValues.size > 0;
  const centerIndex = centerValue ? model.options.findIndex((item) => item.value === centerValue) : -1;

  const handleReadonlyPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button > 0 || !optionTrackRef.current) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    const optionElement = target?.closest<HTMLElement>("[data-option-value]") ?? null;
    carouselDragRef.current = {
      lastTime: performance.now(),
      lastX: event.clientX,
      moved: false,
      optionElement,
      optionValue: optionElement?.dataset.optionValue ?? null,
      pointerId: event.pointerId,
      startTrackX: carouselTrackXRef.current,
      startX: event.clientX,
      velocityX: 0,
    };
    event.currentTarget.dataset.dragging = "true";
    setCarouselTrackX(event.currentTarget, optionTrackRef.current, carouselTrackXRef.current, false, carouselTrackXRef);
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handleReadonlyPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = carouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !optionTrackRef.current) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) > 4) {
      drag.moved = true;
    }
    if (!drag.moved) {
      return;
    }
    event.preventDefault();
    const now = performance.now();
    const elapsed = Math.max(1, now - drag.lastTime);
    drag.velocityX = (event.clientX - drag.lastX) / elapsed;
    drag.lastX = event.clientX;
    drag.lastTime = now;
    const nextX = clampCarouselTrackX(event.currentTarget, optionTrackRef.current, drag.startTrackX + deltaX);
    setCarouselTrackX(event.currentTarget, optionTrackRef.current, nextX, false, carouselTrackXRef);
  };

  const finishReadonlyPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = carouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    carouselDragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      typeof event.currentTarget.releasePointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      event.preventDefault();
      const projectedX = optionTrackRef.current
        ? clampCarouselTrackX(event.currentTarget, optionTrackRef.current, carouselTrackXRef.current + drag.velocityX * 280)
        : carouselTrackXRef.current;
      const closestValue = closestCarouselOptionValue(event.currentTarget, optionTrackRef.current, projectedX);
      if (closestValue) {
        alignCarouselOption(event.currentTarget, optionTrackRef.current, closestValue, true, carouselTrackXRef);
        setCarouselOptionValue(closestValue);
      }
      return;
    }
    if (drag.optionValue && drag.optionElement) {
      event.preventDefault();
      if (optionTrackRef.current) {
        alignCarouselElement(event.currentTarget, optionTrackRef.current, drag.optionElement, true, carouselTrackXRef);
      }
      setCarouselOptionValue(drag.optionValue);
    }
  };

  return (
    <div className={styles.timelineShell}>
      <ChoiceCarouselSlider
        ariaLabel="快速定位历史选项"
        count={model.options.length}
        currentIndex={centerIndex}
        onChange={(index) => {
          const option = model.options[index];
          if (!option) {
            return;
          }
          setCarouselOptionValue(option.value);
          if (optionsRef.current) {
            alignCarouselOption(optionsRef.current, optionTrackRef.current, option.value, true, carouselTrackXRef);
          }
        }}
      />
      <div
        ref={optionsRef}
        className={styles.options}
        data-a2ui-choice-layout="coverflow"
        data-a2ui-choice-draggable="true"
        data-choice-density={choiceCardDensity(model.options.length)}
        onPointerCancel={finishReadonlyPointerDrag}
        onPointerDown={handleReadonlyPointerDown}
        onPointerMove={handleReadonlyPointerMove}
        onPointerUp={finishReadonlyPointerDrag}
      >
        <div ref={optionTrackRef} className={styles.optionTrack} data-a2ui-choice-track="true" role="list" aria-label="历史选项">
          {model.options.map((option, index) => {
            const selected = selectedValues.has(option.value);
            const dimmed = hasSelection && !selected;
            const coverflowOffset = centerIndex >= 0 ? index - centerIndex : index;
            return (
              <div
                className={styles.option}
                data-option-value={option.value}
                data-coverflow-position={choiceCoverflowPosition(coverflowOffset)}
                data-dimmed={dimmed ? "true" : "false"}
                data-readonly="true"
                data-selected={selected ? "true" : "false"}
                data-disabled={option.disabled ? "true" : "false"}
                data-recommended={option.recommended ? "true" : "false"}
                key={option.value || index}
                role="listitem"
              >
                <span className={styles.optionFace} data-a2ui-choice-card="true">
                  <span className={styles.optionCorner} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
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
                    {option.description ? <span className={styles.optionDescription}>{optionSummary(option.description)}</span> : null}
                  </span>
                </span>
                <span className={styles.optionStateButton} data-a2ui-choice-morph="true" aria-hidden="true">
                  <span className={styles.optionStateIcon} aria-hidden="true">
                    <span className={styles.optionStateDot} />
                    <span className={styles.optionStateDot} />
                    <span className={styles.optionStateDot} />
                    <span className={styles.optionStateDot} />
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
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

function validateCorrectionNote(note: string): string | null {
  return note.trim() ? null : "请输入说明";
}

function nextChoiceSelection(current: string[], value: string, model: ChoiceModel): string[] {
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
}

function choiceHelp(model: ChoiceModel, selectedCount: number, correctionMode: boolean, note: string): string {
  if (correctionMode) {
    return note.trim() ? "已选：以上都不对 / 已填写说明" : "已选：以上都不对 / 需输入说明";
  }
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

function choiceCarouselCenterValue(
  model: ChoiceModel,
  carouselOptionValue: string | null,
): string | null {
  if (carouselOptionValue && model.options.some((option) => option.value === carouselOptionValue)) {
    return carouselOptionValue;
  }
  return choiceInitialCenterValue(model.options);
}

function readonlyChoiceCenterValue(
  model: ChoiceModel,
  selectedValues: Set<string>,
  carouselOptionValue: string | null,
): string | null {
  if (carouselOptionValue && model.options.some((option) => option.value === carouselOptionValue)) {
    return carouselOptionValue;
  }
  const selectedValue = model.options.find((option) => selectedValues.has(option.value))?.value;
  return selectedValue ?? choiceInitialCenterValue(model.options);
}

function latestChoiceOptionValue(options: ChoiceOption[]): string | null {
  return options.length ? options[options.length - 1]?.value ?? null : null;
}

function choiceCoverflowPosition(offset: number): "center" | "prev" | "next" | "far-prev" | "far-next" | "offstage" {
  if (offset === 0) {
    return "center";
  }
  if (offset === -1) {
    return "prev";
  }
  if (offset === 1) {
    return "next";
  }
  if (offset < -1) {
    return "far-prev";
  }
  if (offset > 1) {
    return "far-next";
  }
  return "offstage";
}

function alignCarouselOption(
  viewport: HTMLElement,
  track: HTMLElement | null,
  optionValue: string,
  animated: boolean,
  trackXRef: { current: number },
) {
  if (!track) {
    return;
  }
  const target = findCarouselOptionElement(track, optionValue);
  if (!target) {
    return;
  }
  alignCarouselElement(viewport, track, target, animated, trackXRef);
}

function alignCarouselElement(
  viewport: HTMLElement,
  track: HTMLElement,
  target: HTMLElement,
  animated: boolean,
  trackXRef: { current: number },
) {
  const nextX = viewport.clientWidth / 2 - (target.offsetLeft + target.offsetWidth / 2);
  setCarouselTrackX(viewport, track, clampCarouselTrackX(viewport, track, nextX), animated, trackXRef);
}

function closestCarouselOptionValue(
  viewport: HTMLElement | null,
  track: HTMLElement | null,
  projectedX = track ? currentCarouselTrackX(track) : 0,
): string | null {
  if (!viewport || !track) {
    return null;
  }
  const viewportCenter = viewport.clientWidth / 2;
  let closestValue: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const item of track.querySelectorAll<HTMLElement>("[data-option-value]")) {
    const itemCenter = projectedX + item.offsetLeft + item.offsetWidth / 2;
    const distance = Math.abs(itemCenter - viewportCenter);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestValue = item.dataset.optionValue ?? null;
    }
  }
  return closestValue;
}

function findCarouselOptionElement(track: HTMLElement, optionValue: string): HTMLElement | null {
  return Array.from(track.querySelectorAll<HTMLElement>("[data-option-value]"))
    .find((item) => item.dataset.optionValue === optionValue) ?? null;
}

function setCarouselTrackX(
  viewport: HTMLElement,
  track: HTMLElement,
  x: number,
  animated: boolean,
  trackXRef: { current: number },
) {
  trackXRef.current = x;
  track.style.transition = animated ? "transform 520ms cubic-bezier(0.22, 1, 0.36, 1)" : "none";
  track.style.transform = `translate3d(${x}px, 0, 0)`;
  updateCarouselPostures(viewport, track, x);
}

function clampCarouselTrackX(viewport: HTMLElement, track: HTMLElement | null, x: number): number {
  if (!track) {
    return 0;
  }
  const minX = Math.min(0, viewport.clientWidth - track.scrollWidth);
  return Math.min(0, Math.max(minX, x));
}

function updateCarouselPostures(viewport: HTMLElement, track: HTMLElement, x: number) {
  const viewportCenter = viewport.clientWidth / 2;
  for (const item of track.querySelectorAll<HTMLElement>("[data-option-value]")) {
    const width = Math.max(1, item.offsetWidth);
    const itemCenter = x + item.offsetLeft + width / 2;
    const distance = (itemCenter - viewportCenter) / (width * 1.18);
    const clamped = Math.max(-2, Math.min(2, distance));
    const abs = Math.abs(clamped);
    item.style.setProperty("--a2ui-choice-coverflow-rotate-y", `${(-clamped * 32).toFixed(2)}deg`);
    item.style.setProperty("--a2ui-choice-coverflow-scale", `${Math.max(0.82, 1 - abs * 0.09).toFixed(3)}`);
    item.style.setProperty("--a2ui-choice-coverflow-opacity", `${Math.max(0.56, 1 - abs * 0.22).toFixed(3)}`);
    item.style.setProperty("--a2ui-choice-coverflow-shift-x", `${coverflowVisualShift(clamped).toFixed(2)}px`);
  }
}

function currentCarouselTrackX(track: HTMLElement): number {
  const transform = track.style.transform;
  const match = /translate3d\((-?\d+(?:\.\d+)?)px/.exec(transform);
  return match ? Number(match[1]) : 0;
}

function choiceCardDensity(count: number): "normal" | "dense" | "compact" {
  if (count >= 16) {
    return "compact";
  }
  if (count >= 8) {
    return "dense";
  }
  return "normal";
}

function coverflowVisualShift(distance: number): number {
  const abs = Math.abs(distance);
  const sign = Math.sign(distance);
  if (abs <= 1) {
    return sign * abs * 8;
  }
  return sign * (8 - (abs - 1) * 50);
}

function choiceInitialCenterValue(options: ChoiceOption[]): string | null {
  if (!options.length) {
    return null;
  }
  if (options.length >= 5) {
    return options[2]?.value ?? null;
  }
  return options[Math.floor((options.length - 1) / 2)]?.value ?? null;
}

function choiceOptionExpandable(option: ChoiceOption): boolean {
  return optionSummary(option.description) !== option.description.replace(/\s+/g, " ").trim();
}

function choiceDetailPopoverPosition(target: HTMLElement): Pick<ChoiceDetailPreview, "left" | "maxHeight" | "placement" | "top"> {
  const rect = target.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const width = Math.min(DETAIL_POPOVER_WIDTH, Math.max(0, viewportWidth - 32));
  const viewportMargin = 16;
  const left = clampNumber(
    rect.left + rect.width / 2 - width / 2,
    viewportMargin,
    Math.max(viewportMargin, viewportWidth - width - viewportMargin),
  );
  const availableBelow = Math.max(0, viewportHeight - rect.bottom - DETAIL_POPOVER_GAP - viewportMargin);
  const availableAbove = Math.max(0, rect.top - DETAIL_POPOVER_GAP - viewportMargin);
  const desiredHeight = Math.min(DETAIL_POPOVER_MAX_HEIGHT, Math.max(120, viewportHeight - viewportMargin * 2));
  const shouldOpenUp = availableBelow < desiredHeight && availableAbove > availableBelow;
  if (shouldOpenUp) {
    return {
      left,
      maxHeight: Math.max(120, Math.min(DETAIL_POPOVER_MAX_HEIGHT, availableAbove)),
      placement: "top",
      top: Math.max(viewportMargin, rect.top - DETAIL_POPOVER_GAP),
    };
  }
  return {
    left,
    maxHeight: Math.max(120, Math.min(DETAIL_POPOVER_MAX_HEIGHT, availableBelow || desiredHeight)),
    placement: "bottom",
    top: Math.min(viewportHeight - viewportMargin, rect.bottom + DETAIL_POPOVER_GAP),
  };
}

function clearDetailTimer(timerRef: { current: ReturnType<typeof globalThis.setTimeout> | null }) {
  if (timerRef.current === null) {
    return;
  }
  globalThis.clearTimeout(timerRef.current);
  timerRef.current = null;
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function optionSummary(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= OPTION_CARD_DESCRIPTION_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, OPTION_CARD_DESCRIPTION_LIMIT - 3)}...`;
}

function useStableChoiceModel(model: ChoiceModel, parsed: ParsedA2UIMessage): ChoiceModel {
  const previousRef = useRef<ChoiceModel | null>(null);
  const previewing =
    isStreamingPreviewStatus(model.status) ||
    Boolean(parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created");
  const previous = previousRef.current;

  if (!previewing || !previous || model.options.length >= previous.options.length) {
    if (model.options.length > 0 || !previewing) {
      previousRef.current = model;
    }
    return model;
  }

  return {
    ...previous,
    renderState: model.renderState,
    selectedValues: model.selectedValues,
    status: model.status,
  };
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
  return scalarText(record?.correction_note) || scalarText(record?.note) || scalarText(record?.comment);
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

function isChoiceStreaming(
  status: string,
  streamPlayer: ParsedA2UIMessage["streamPlayer"],
  historyHydrated: boolean,
): boolean {
  if (historyHydrated) {
    return false;
  }
  if (isStreamingPreviewStatus(status)) {
    return true;
  }
  return Boolean(streamPlayer?.enabled && streamPlayer.phase !== "created" && streamPlayer.phase !== "failed");
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
  return [messageId, parsed.renderKey || "choice"].filter(Boolean).join(":");
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
