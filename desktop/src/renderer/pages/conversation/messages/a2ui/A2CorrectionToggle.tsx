import { ChevronDown, ChevronUp, CircleAlert, PencilLine } from "lucide-react";
import type { TextareaHTMLAttributes } from "react";

import styles from "./A2CorrectionToggle.module.css";

interface A2CorrectionToggleProps {
  controlsId: string;
  disabled?: boolean;
  expanded: boolean;
  idleDescription: string;
  idleTitle: string;
  returnLabel: string;
  onToggle: () => void;
}

interface A2CorrectionTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  onConfirm: () => void | Promise<void>;
}

export function A2CorrectionTextarea({
  onConfirm,
  onKeyDown,
  title = "Enter 提交，Shift+Enter 换行",
  ...textareaProps
}: A2CorrectionTextareaProps) {
  return (
    <textarea
      {...textareaProps}
      title={title}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void onConfirm();
      }}
    />
  );
}

export function A2CorrectionToggle({
  controlsId,
  disabled = false,
  expanded,
  idleDescription,
  idleTitle,
  returnLabel,
  onToggle,
}: A2CorrectionToggleProps) {
  const accessibleLabel = expanded
    ? returnLabel
    : `${idleTitle}！${idleDescription}`;

  return (
    <button
      aria-controls={controlsId}
      aria-expanded={expanded}
      aria-label={accessibleLabel}
      className={styles.toggle}
      data-expanded={expanded ? "true" : "false"}
      disabled={disabled}
      type="button"
      onClick={onToggle}
    >
      {expanded ? (
        <>
          <PencilLine aria-hidden="true" className={styles.leadingIcon} size={14} />
          <span className={styles.returnLabel}>{returnLabel}</span>
          <ChevronUp aria-hidden="true" className={styles.chevron} size={14} />
        </>
      ) : (
        <>
          <CircleAlert aria-hidden="true" className={styles.leadingIcon} size={14} />
          <span className={styles.copy}>
            <strong>{idleTitle}</strong>
            <small>{idleDescription}</small>
          </span>
          <ChevronDown aria-hidden="true" className={styles.chevron} size={14} />
        </>
      )}
    </button>
  );
}
