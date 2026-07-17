import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import type { KeydexDiffProfileName } from "./profiles";
import styles from "./DiffToolbar.module.css";

export type KeydexDiffActionState = "idle" | "loading" | "success" | "error";

export interface KeydexDiffToolbarProps {
  readonly profile: KeydexDiffProfileName;
  readonly label?: string;
  readonly leading?: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}

export function KeydexDiffToolbar({
  profile,
  label = "差异工具栏",
  leading,
  children,
  trailing,
}: KeydexDiffToolbarProps) {
  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={label}
      data-keydex-diff-toolbar="true"
      data-profile={profile}
    >
      {leading ? <div className={styles.leading}>{leading}</div> : null}
      <div className={styles.actions}>{children}</div>
      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}

export interface KeydexDiffToolbarActionProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  readonly label: string;
  readonly icon: ReactNode;
  readonly showLabel?: boolean;
  readonly pressed?: boolean;
  readonly state?: KeydexDiffActionState;
  readonly disabledReason?: string;
  readonly shortcut?: string;
}

export function KeydexDiffToolbarAction({
  label,
  icon,
  showLabel = false,
  pressed,
  state = "idle",
  disabled = false,
  disabledReason,
  shortcut,
  type = "button",
  ...buttonProps
}: KeydexDiffToolbarActionProps) {
  const busy = state === "loading";
  const unavailable = disabled || busy;
  const stateLabel = actionStateLabel(label, state);
  const tooltip = [disabled && disabledReason ? disabledReason : stateLabel, shortcut]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      {...buttonProps}
      className={[styles.action, buttonProps.className].filter(Boolean).join(" ")}
      type={type}
      aria-label={stateLabel}
      aria-busy={busy || undefined}
      aria-pressed={pressed}
      data-action-state={state}
      data-tooltip-label={tooltip}
      disabled={unavailable}
    >
      <span className={styles.actionIcon} aria-hidden="true">
        {state === "loading" ? <LoaderCircle className={styles.spinner} size={15} /> : null}
        {state === "success" ? <Check size={15} /> : null}
        {state === "error" ? <CircleAlert size={15} /> : null}
        {state === "idle" ? icon : null}
      </span>
      {showLabel ? <span className={styles.actionLabel}>{label}</span> : null}
      {shortcut ? <kbd className={styles.shortcut} aria-hidden="true">{shortcut}</kbd> : null}
    </button>
  );
}

function actionStateLabel(label: string, state: KeydexDiffActionState): string {
  if (state === "loading") return `${label}中`;
  if (state === "success") return `${label}成功`;
  if (state === "error") return `${label}失败`;
  return label;
}
