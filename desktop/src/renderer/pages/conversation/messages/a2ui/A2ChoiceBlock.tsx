import * as SliderPrimitive from "@radix-ui/react-slider";
import { type CSSProperties, type PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { motion } from "motion/react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type {
  A2UICancelHandler,
  A2UISubmitHandler,
  ParsedA2UIMessage,
} from "./A2UIBlock";
import { A2CorrectionTextarea, A2CorrectionToggle } from "./A2CorrectionToggle";
import { choiceSemanticAdapter } from "./adapters/choiceSemanticAdapter";
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
import { useA2UISemanticStream } from "./runtime/useA2UISemanticStream";

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

type ChoicePresentationMode = "gallery" | "notification_stack";

interface ChoiceModel {
  title: string;
  description: string;
  presentationMode: ChoicePresentationMode;
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
const ACTION_BADGE_LOADING_MS = 120;
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
const IOS_NOTIFICATION_CARD_HEIGHT = 74;
const IOS_NOTIFICATION_EXPANDED_CARD_HEIGHT = 220;
const IOS_NOTIFICATION_GAP = 8;
const IOS_NOTIFICATION_REVEAL = 11;
const IOS_NOTIFICATION_VISIBLE_STACK = 4;
const IOS_NOTIFICATION_EASE = [0.22, 1, 0.36, 1] as const;
const IOS_NOTIFICATION_TRANSITION = {
  type: "spring",
  stiffness: 360,
  damping: 34,
  mass: 0.9,
} as const;
type IosNotificationVariantCustom = {
  closedIndex: number;
  count: number;
  expandedBefore: number;
  index: number;
  messageExpanded: boolean;
};
type IosNotificationBodyVariantCustom = {
  count: number;
  expandedCount: number;
};
const IOS_NOTIFICATION_HEADER_VARIANTS = {
  open: {
    height: 28,
    marginBottom: 8,
    opacity: 1,
    scale: 1,
    y: 0,
    transition: IOS_NOTIFICATION_TRANSITION,
  },
  closed: {
    height: 0,
    marginBottom: 0,
    opacity: 0,
    scale: 0.96,
    y: 8,
    transition: {
      duration: 0.16,
      ease: IOS_NOTIFICATION_EASE,
    },
  },
};
const IOS_NOTIFICATION_BODY_VARIANTS = {
  open: ({ count, expandedCount }: IosNotificationBodyVariantCustom) => ({
    height: iosNotificationOpenHeight(count, expandedCount),
    transition: IOS_NOTIFICATION_TRANSITION,
  }),
  closed: ({ count }: IosNotificationBodyVariantCustom) => ({
    height: iosNotificationClosedHeight(count),
    transition: IOS_NOTIFICATION_TRANSITION,
  }),
};
const IOS_NOTIFICATION_ITEM_VARIANTS = {
  open: ({ count, expandedBefore, index, messageExpanded }: IosNotificationVariantCustom) => ({
    filter: "none",
    height: iosNotificationItemHeight(messageExpanded),
    opacity: 1,
    scale: 1,
    y: iosNotificationOpenY(index, expandedBefore),
    zIndex: count - index,
    transition: IOS_NOTIFICATION_TRANSITION,
  }),
  closed: ({ closedIndex, count }: IosNotificationVariantCustom) => {
    const hidden = closedIndex >= IOS_NOTIFICATION_VISIBLE_STACK;
    const depth = Math.min(closedIndex, IOS_NOTIFICATION_VISIBLE_STACK - 1);
    return {
      filter: "none",
      height: IOS_NOTIFICATION_CARD_HEIGHT,
      opacity: hidden ? 0 : Math.max(0.46, 1 - depth * 0.16),
      scale: hidden ? 0.9 : 1 - depth * 0.035,
      y: hidden ? 0 : depth * IOS_NOTIFICATION_REVEAL,
      zIndex: count - closedIndex,
      transition: IOS_NOTIFICATION_TRANSITION,
    };
  },
};

export function A2ChoiceBlock({ message, parsed, onSubmit, onCancel }: A2ChoiceBlockProps) {
  const semanticStream = useA2UISemanticStream(parsed, choiceSemanticAdapter, {
    scopeKey: message.id,
    maxUnitsPerTick: 3,
  });
  const semanticParsed = useMemo(
    () => ({
      ...parsed,
      payload: semanticStream.payload,
    }),
    [parsed, semanticStream.payload],
  );
  const model = useMemo(() => choiceModel(semanticParsed), [semanticParsed]);
  const [selectedValues, setSelectedValues] = useState<string[]>(() => initialSelection(model));
  const [carouselOptionValue, setCarouselOptionValue] = useState<string | null>(null);
  const [expandedOptionValue, setExpandedOptionValue] = useState<string | null>(null);
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
  const choiceStreaming = semanticStream.running || (isStreamingPreviewStatus(model.status) && !parsed.historyHydrated);
  const motionLive = shouldUseInteractiveChoiceMotion(parsed, model.status, semanticStream.enabled);
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
  const selectedValueSet = useMemo(() => new Set(selectedValues), [selectedValues]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (carouselAnimationFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(carouselAnimationFrameRef.current);
      }
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
    setExpandedOptionValue(null);
    setError(null);
  }, [message.id, parsed.interactionId]);

  useEffect(() => {
    if (correctionMode || selectedValues.length > 0 || localSubmitting || localSubmitted) {
      return;
    }
    const nextInitialSelection = initialSelection(model);
    if (nextInitialSelection.length) {
      setSelectedValues(nextInitialSelection);
    }
  }, [correctionMode, localSubmitted, localSubmitting, model, selectedValues.length]);

  useEffect(() => {
    if (!carouselOptionValue || model.options.some((option) => option.value === carouselOptionValue)) {
      return;
    }
    setCarouselOptionValue(null);
  }, [carouselOptionValue, model.options]);

  useEffect(() => {
    if (!expandedOptionValue || model.options.some((option) => option.value === expandedOptionValue)) {
      return;
    }
    setExpandedOptionValue(null);
  }, [expandedOptionValue, model.options]);

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

  const syncOptionDetailFocus = (option: ChoiceOption, target?: HTMLElement | null) => {
    setCarouselOptionValue(option.value);
    const optionElement = target?.closest<HTMLElement>("[data-option-value]");
    globalThis.requestAnimationFrame(() => {
      focusCarouselOption(option.value, optionElement, false);
    });
  };

  const expandOptionDetail = (option: ChoiceOption, target?: HTMLElement | null) => {
    if (!choiceOptionExpandable(option)) {
      return;
    }
    setExpandedOptionValue(option.value);
    syncOptionDetailFocus(option, target);
  };

  const collapseOptionDetail = (option: ChoiceOption, target?: HTMLElement | null) => {
    setExpandedOptionValue((current) => current === option.value ? null : current);
    syncOptionDetailFocus(option, target);
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
      const submitPromise = onSubmit(
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
      void Promise.resolve(submitPromise).catch((reason) => {
        if (mountedRef.current && actionTokenRef.current === actionToken) {
          setError(errorMessage(reason));
          setActionPhase(null);
          setLocalSubmitted(false);
        }
      });
      await waitForActionBadgeLoading();
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
      const cancelPromise = onCancel(parsed.interactionId, note.trim() || "用户取消", message.threadId);
      if (!mountedRef.current || actionTokenRef.current !== actionToken) {
        return;
      }
      void Promise.resolve(cancelPromise).catch((reason) => {
        if (mountedRef.current && actionTokenRef.current === actionToken) {
          setError(errorMessage(reason));
          setActionPhase(null);
          setLocalSubmitted(false);
        }
      });
      await waitForActionBadgeLoading();
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
      {...semanticStream.rootProps}
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
            {model.presentationMode === "notification_stack" ? (
              <ChoiceNotificationStack
                actionable={actionable}
                disabled={Boolean(localSubmitting)}
                live={motionLive}
                model={model}
                onToggle={toggle}
                selectedValues={selectedValueSet}
              />
            ) : (
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
                      const detailExpandable = choiceOptionExpandable(option);
                      const detailExpanded = expandedOptionValue === option.value;
                      return (
                        <A2InteractiveMotionItem
                          as="div"
                          className={styles.option}
                          data-option-value={option.value}
                          data-coverflow-position={coverflowPosition}
                          data-detail-expanded={detailExpanded ? "true" : "false"}
                          data-detail-expandable={detailExpandable ? "true" : "false"}
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
                            >
                              <span className={styles.optionHeader}>
                                <span className={styles.optionLabel}>{option.label}</span>
                                {option.recommended ? <span className={styles.recommendedBadge}>推荐</span> : null}
                                {option.badge ? <span className={styles.optionBadge}>{option.badge}</span> : null}
                              </span>
                              {option.description ? (
                                detailExpandable && !detailExpanded ? (
                                  <button
                                    className={styles.optionDescriptionShell}
                                    type="button"
                                    aria-label={`展开 ${option.label} 完整内容`}
                                    data-detail-expanded="false"
                                    data-detail-expandable="true"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      expandOptionDetail(option, event.currentTarget);
                                    }}
                                  >
                                    <span className={styles.optionDescription} data-detail-expanded="false">
                                      {optionSummary(option.description)}
                                    </span>
                                    <span className={styles.optionDetailReveal} aria-hidden="true">
                                      <Maximize2 size={15} strokeWidth={2.1} />
                                    </span>
                                  </button>
                                ) : (
                                  <span
                                    className={styles.optionDescriptionShell}
                                    data-detail-expanded={detailExpanded ? "true" : "false"}
                                    data-detail-expandable={detailExpandable ? "true" : "false"}
                                  >
                                    <span className={styles.optionDescription} data-detail-expanded={detailExpanded ? "true" : "false"}>
                                      {detailExpanded ? option.description : optionSummary(option.description)}
                                    </span>
                                  </span>
                                )
                              ) : null}
                              {detailExpandable && detailExpanded ? (
                                <button
                                  className={styles.optionDetailToggle}
                                  type="button"
                                  aria-expanded={detailExpanded}
                                  aria-label={`收起 ${option.label} 完整内容`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    collapseOptionDetail(option, event.currentTarget);
                                  }}
                                >
                                  收起
                                </button>
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
            )}
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
                <A2CorrectionToggle
                  controlsId={`${message.id}:a2ui-choice-correction`}
                  disabled={!actionable || Boolean(localSubmitting)}
                  expanded={correctionMode}
                  idleDescription="我来告诉 Keydex 应该怎么做"
                  idleTitle="以上选项都不对"
                  returnLabel="返回选择选项"
                  onToggle={toggleCorrectionMode}
                />
                {correctionMode ? (
                  <A2CorrectionTextarea
                    aria-label="我来告诉 Keydex 应该怎么做"
                    autoFocus
                    id={`${message.id}:a2ui-choice-correction`}
                    value={note}
                    maxLength={500}
                    disabled={!actionable || Boolean(localSubmitting)}
                    placeholder="例如：换一组更保守的选项，或者补充一个新的判断条件..."
                    onChange={(event) => setNote(event.currentTarget.value)}
                    onConfirm={submit}
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

function ChoiceNotificationStack({
  actionable = false,
  disabled = false,
  live,
  model,
  onToggle,
  readOnly = false,
  selectedValues,
}: {
  actionable?: boolean;
  disabled?: boolean;
  live: boolean;
  model: ChoiceModel;
  onToggle?: (value: string) => void;
  readOnly?: boolean;
  selectedValues: Set<string>;
}) {
  const defaultExpanded = !readOnly && (model.status === "waiting_input" || isStreamingPreviewStatus(model.status));
  const [stackExpanded, setStackExpanded] = useState(defaultExpanded);
  const [expandedMessageValues, setExpandedMessageValues] = useState<Set<string>>(() => new Set());
  const [expandableMessageValues, setExpandableMessageValues] = useState<Set<string>>(() => new Set());
  const descriptionRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const expandedMessageValuesRef = useRef(expandedMessageValues);
  const stackState = stackExpanded ? "open" : "closed";
  const optionValueSignature = useMemo(() => model.options.map((option) => option.value).join("\u0000"), [model.options]);
  const optionContentSignature = useMemo(
    () => model.options.map((option) => `${option.value}\u0001${option.label}\u0001${option.description}`).join("\u0000"),
    [model.options],
  );

  useEffect(() => {
    setStackExpanded(defaultExpanded);
    setExpandedMessageValues(new Set());
    setExpandableMessageValues(new Set());
  }, [defaultExpanded]);

  useEffect(() => {
    expandedMessageValuesRef.current = expandedMessageValues;
  }, [expandedMessageValues]);

  useEffect(() => {
    const availableValues = new Set(model.options.map((option) => option.value));
    setExpandedMessageValues((current) => {
      const next = new Set([...current].filter((value) => availableValues.has(value)));
      return next.size === current.size ? current : next;
    });
    setExpandableMessageValues((current) => {
      const next = new Set([...current].filter((value) => availableValues.has(value)));
      return setsEqual(current, next) ? current : next;
    });
  }, [optionValueSignature, model.options]);

  useLayoutEffect(() => {
    if (!stackExpanded) {
      setExpandableMessageValues(new Set());
      return;
    }
    const currentlyExpanded = expandedMessageValuesRef.current;
    const next = new Set<string>();
    for (const option of model.options) {
      const descriptionElement = descriptionRefs.current.get(option.value);
      if (!descriptionElement) {
        continue;
      }
      if (currentlyExpanded.has(option.value) || elementHasOverflow(descriptionElement)) {
        next.add(option.value);
      }
    }
    setExpandableMessageValues((current) => (setsEqual(current, next) ? current : next));
    setExpandedMessageValues((current) => {
      const filtered = new Set([...current].filter((value) => next.has(value)));
      return setsEqual(current, filtered) ? current : filtered;
    });
  }, [optionContentSignature, stackExpanded, model.options]);

  if (!model.options.length) {
    return null;
  }

  const closedIndexByValue = readOnly && selectedValues.size > 0
    ? selectedFirstNotificationIndexMap(model.options, selectedValues)
    : null;

  const closeStack = () => {
    setStackExpanded(false);
    setExpandedMessageValues(new Set());
  };

  const openStack = () => {
    setStackExpanded(true);
  };

  const toggleMessage = (value: string) => {
    if (!stackExpanded) {
      openStack();
      return;
    }
    if (!expandableMessageValues.has(value)) {
      return;
    }
    setExpandedMessageValues((current) => {
      const next = new Set(current);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  return (
    <motion.div
      animate={stackState}
      className={styles.notificationStack}
      data-a2ui-choice-layout="notification_stack"
      data-expanded={stackExpanded ? "true" : "false"}
      data-readonly={readOnly ? "true" : "false"}
      data-testid="a2ui-choice-notification-stack"
      initial={live ? "closed" : false}
      style={{
        "--a2ui-ios-notification-card-height": `${IOS_NOTIFICATION_CARD_HEIGHT}px`,
      } as CSSProperties}
    >
      <motion.div
        aria-hidden={!stackExpanded}
        className={styles.notificationStackHeader}
        variants={IOS_NOTIFICATION_HEADER_VARIANTS}
      >
        <span className={styles.notificationStackTitle}>{model.multiple ? "多选项" : "单选项"}</span>
        <button
          aria-expanded={stackExpanded}
          aria-label={stackExpanded ? "收起选项通知栈" : "展开选项通知栈"}
          className={styles.notificationStackClose}
          type="button"
          onClick={closeStack}
        >
          收起
        </button>
      </motion.div>
      <motion.div
        className={styles.notificationStackBody}
        role={model.multiple ? "group" : "radiogroup"}
        aria-label={readOnly ? "历史选项" : "选项"}
        custom={{ count: model.options.length, expandedCount: expandedMessageValues.size }}
        variants={IOS_NOTIFICATION_BODY_VARIANTS}
      >
        {model.options.map((option, index) => {
          const selected = selectedValues.has(option.value);
          const interactive = actionable && !disabled && !option.disabled;
          const messageExpanded = expandedMessageValues.has(option.value);
          const messageExpandable = expandableMessageValues.has(option.value);
          const expandedBefore = model.options
            .slice(0, index)
            .reduce((count, previous) => count + (expandedMessageValues.has(previous.value) ? 1 : 0), 0);
          const closedIndex = closedIndexByValue?.get(option.value) ?? index;
          return (
            <motion.div
              className={styles.notificationItem}
              custom={{ closedIndex, count: model.options.length, expandedBefore, index, messageExpanded }}
              data-disabled={!readOnly && (!actionable || option.disabled) ? "true" : "false"}
              data-message-expandable={messageExpandable ? "true" : "false"}
              data-message-expanded={messageExpanded ? "true" : "false"}
              data-option-value={option.value}
              data-readonly={readOnly ? "true" : "false"}
              data-recommended={option.recommended ? "true" : "false"}
              data-selected={selected ? "true" : "false"}
              data-stack-front={closedIndex === 0 ? "true" : "false"}
              key={option.value}
              variants={IOS_NOTIFICATION_ITEM_VARIANTS}
            >
              <div
                aria-expanded={stackExpanded ? messageExpanded : false}
                className={styles.notificationCard}
                data-a2ui-notification-card="true"
                role={messageExpandable ? "button" : undefined}
                tabIndex={messageExpandable ? 0 : -1}
                onKeyDown={(event) => {
                  if (messageExpandable && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    toggleMessage(option.value);
                  }
                }}
                onClick={() => toggleMessage(option.value)}
              >
                <A2MotionPresence preserveExit>
                  {stackExpanded || (readOnly && selected) ? (
                    readOnly ? (
                      <span
                        aria-hidden={!selected}
                        className={styles.notificationActionSlot}
                        data-a2ui-notification-action-slot="true"
                        data-readonly-slot="true"
                      >
                        {selected ? <span className={styles.notificationReadonlyBadge}>已选</span> : null}
                      </span>
                    ) : (
                      <motion.span
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        className={styles.notificationActionSlot}
                        data-a2ui-notification-action-slot="true"
                        exit={{ opacity: 0, scale: 0.92, x: -8 }}
                        initial={{ opacity: 0, scale: 0.92, x: -8 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <button
                          aria-label={selected ? `取消选择 ${option.label}` : `选择 ${option.label}`}
                          className={styles.notificationSelectButton}
                          data-a2ui-choice-morph="true"
                          disabled={!interactive}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggle?.(option.value);
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
                      </motion.span>
                    )
                  ) : null}
                </A2MotionPresence>
                <span className={styles.notificationIndex} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className={styles.notificationContent}>
                  <span className={styles.notificationHeader}>
                    <span className={styles.notificationLabel}>{option.label}</span>
                    {option.recommended ? <span className={styles.recommendedBadge}>推荐</span> : null}
                    {option.badge ? <span className={styles.optionBadge}>{option.badge}</span> : null}
                  </span>
                  {stackExpanded && option.description ? (
                    <span
                      className={styles.notificationDescription}
                      data-a2ui-notification-description="true"
                      ref={(node) => {
                        if (node) {
                          descriptionRefs.current.set(option.value, node);
                        } else {
                          descriptionRefs.current.delete(option.value);
                        }
                      }}
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </div>
            </motion.div>
          );
        })}
      </motion.div>
      {!stackExpanded ? (
        <button
          aria-expanded={false}
          aria-label="展开选项通知栈"
          className={styles.notificationStackHitArea}
          type="button"
          onClick={openStack}
        >
          展开选项通知栈
        </button>
      ) : null}
    </motion.div>
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
  if (model.presentationMode === "notification_stack") {
    return (
      <ChoiceNotificationStack
        live={false}
        model={model}
        readOnly
        selectedValues={selectedValues}
      />
    );
  }

  return <ReadonlyChoiceGalleryOptions model={model} selectedValues={selectedValues} />;
}

function ReadonlyChoiceGalleryOptions({ model, selectedValues }: { model: ChoiceModel; selectedValues: Set<string> }) {
  const [carouselOptionValue, setCarouselOptionValue] = useState<string | null>(null);
  const [expandedOptionValue, setExpandedOptionValue] = useState<string | null>(null);
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

  useEffect(() => {
    if (!expandedOptionValue || model.options.some((option) => option.value === expandedOptionValue)) {
      return;
    }
    setExpandedOptionValue(null);
  }, [expandedOptionValue, model.options]);

  if (!model.options.length) {
    return null;
  }
  const hasSelection = selectedValues.size > 0;
  const centerIndex = centerValue ? model.options.findIndex((item) => item.value === centerValue) : -1;
  const alignReadonlyOptionDetail = (option: ChoiceOption) => {
    setCarouselOptionValue(option.value);
    globalThis.requestAnimationFrame(() => {
      if (optionsRef.current) {
        alignCarouselOption(optionsRef.current, optionTrackRef.current, option.value, true, carouselTrackXRef);
      }
    });
  };

  const expandReadonlyOptionDetail = (option: ChoiceOption) => {
    if (!choiceOptionExpandable(option)) {
      return;
    }
    setExpandedOptionValue(option.value);
    alignReadonlyOptionDetail(option);
  };

  const collapseReadonlyOptionDetail = (option: ChoiceOption) => {
    setExpandedOptionValue((current) => current === option.value ? null : current);
    alignReadonlyOptionDetail(option);
  };

  const handleReadonlyPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button > 0 || !optionTrackRef.current) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("button, input, textarea, select, a")) {
      return;
    }
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
            const detailExpandable = choiceOptionExpandable(option);
            const detailExpanded = expandedOptionValue === option.value;
            return (
              <div
                className={styles.option}
                data-option-value={option.value}
                data-coverflow-position={choiceCoverflowPosition(coverflowOffset)}
                data-detail-expanded={detailExpanded ? "true" : "false"}
                data-detail-expandable={detailExpandable ? "true" : "false"}
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
                    {option.description ? (
                      detailExpandable && !detailExpanded ? (
                        <button
                          className={styles.optionDescriptionShell}
                          type="button"
                          aria-label={`展开 ${option.label} 完整内容`}
                          data-detail-expanded="false"
                          data-detail-expandable="true"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            expandReadonlyOptionDetail(option);
                          }}
                        >
                          <span className={styles.optionDescription} data-detail-expanded="false">
                            {optionSummary(option.description)}
                          </span>
                          <span className={styles.optionDetailReveal} aria-hidden="true">
                            <Maximize2 size={15} strokeWidth={2.1} />
                          </span>
                        </button>
                      ) : (
                        <span
                          className={styles.optionDescriptionShell}
                          data-detail-expanded={detailExpanded ? "true" : "false"}
                          data-detail-expandable={detailExpandable ? "true" : "false"}
                        >
                          <span className={styles.optionDescription} data-detail-expanded={detailExpanded ? "true" : "false"}>
                            {detailExpanded ? option.description : optionSummary(option.description)}
                          </span>
                        </span>
                      )
                    ) : null}
                    {detailExpandable && detailExpanded ? (
                      <button
                        className={styles.optionDetailToggle}
                        type="button"
                        aria-expanded={detailExpanded}
                        aria-label={`收起 ${option.label} 完整内容`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          collapseReadonlyOptionDetail(option);
                        }}
                      >
                        收起
                      </button>
                    ) : null}
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
    presentationMode: choicePresentationMode(payload.presentation_mode),
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

function choicePresentationMode(value: unknown): ChoicePresentationMode {
  return scalarText(value).toLowerCase() === "notification_stack" ? "notification_stack" : "gallery";
}

function selectedFirstNotificationIndexMap(options: ChoiceOption[], selectedValues: Set<string>): Map<string, number> {
  const ordered = [
    ...options.filter((option) => selectedValues.has(option.value)),
    ...options.filter((option) => !selectedValues.has(option.value)),
  ];
  return new Map(ordered.map((option, index) => [option.value, index]));
}

function iosNotificationOpenHeight(count: number, expandedCount = 0): number {
  if (count <= 0) {
    return 0;
  }
  return (
    count * IOS_NOTIFICATION_CARD_HEIGHT +
    expandedCount * (IOS_NOTIFICATION_EXPANDED_CARD_HEIGHT - IOS_NOTIFICATION_CARD_HEIGHT) +
    Math.max(0, count - 1) * IOS_NOTIFICATION_GAP
  );
}

function iosNotificationClosedHeight(count: number): number {
  if (count <= 0) {
    return 0;
  }
  return IOS_NOTIFICATION_CARD_HEIGHT + Math.max(0, Math.min(count, IOS_NOTIFICATION_VISIBLE_STACK) - 1) * IOS_NOTIFICATION_REVEAL;
}

function iosNotificationItemHeight(messageExpanded: boolean): number {
  return messageExpanded ? IOS_NOTIFICATION_EXPANDED_CARD_HEIGHT : IOS_NOTIFICATION_CARD_HEIGHT;
}

function iosNotificationOpenY(index: number, expandedBefore: number): number {
  return (
    index * (IOS_NOTIFICATION_CARD_HEIGHT + IOS_NOTIFICATION_GAP) +
    expandedBefore * (IOS_NOTIFICATION_EXPANDED_CARD_HEIGHT - IOS_NOTIFICATION_CARD_HEIGHT)
  );
}

function elementHasOverflow(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
}

function setsEqual(first: Set<string>, second: Set<string>): boolean {
  if (first.size !== second.size) {
    return false;
  }
  for (const value of first) {
    if (!second.has(value)) {
      return false;
    }
  }
  return true;
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
    return note.trim() ? "已选：以上选项都不对 / 已填写说明" : "已选：以上选项都不对 / 需输入说明";
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

function waitForActionBadgeLoading(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ACTION_BADGE_LOADING_MS);
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

function shouldUseInteractiveChoiceMotion(parsed: ParsedA2UIMessage, status: string, semanticStreamEnabled: boolean): boolean {
  if (parsed.historyHydrated) {
    return false;
  }
  return semanticStreamEnabled ||
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
