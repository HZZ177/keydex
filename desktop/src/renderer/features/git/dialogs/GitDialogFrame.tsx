import { useId, type FormEvent, type ReactNode } from "react";

import { AppDialog, ConfirmDialog, DialogButton } from "@/renderer/components/dialog";

import styles from "./GitDialogFrame.module.css";

export function GitFormDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  valid = true,
  error = null,
  confirmTone = "default",
  children,
  onCancel,
  onSubmit,
}: {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  valid?: boolean;
  error?: string | null;
  confirmTone?: "default" | "danger";
  children: ReactNode;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const formId = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !valid) return;
    void onSubmit();
  };

  return (
    <AppDialog
      title={title}
      description={description}
      size="form"
      backdrop="plain"
      closeOnOverlayClick={false}
      showClose={false}
      closeOnEscape={!busy}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <DialogButton type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</DialogButton>
          <DialogButton
            type="submit"
            form={formId}
            tone={confirmTone === "danger" ? "danger" : "primary"}
            disabled={busy || !valid}
          >
            {confirmLabel}
          </DialogButton>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit}>
        {children}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </form>
    </AppDialog>
  );
}

export function GitDialogField({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {error ? <small className={styles.fieldError}>{error}</small> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function GitDialogOptions({ children }: { children: ReactNode }) {
  return <div className={styles.options}>{children}</div>;
}

export function GitDialogSummary({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "warning" | "danger" }) {
  return <div className={styles.summary} data-tone={tone}>{children}</div>;
}

export function GitConfirmActionDialog({
  title,
  description,
  target,
  details = [],
  confirmLabel,
  confirmTone = "danger",
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: ReactNode;
  description?: ReactNode;
  target?: ReactNode;
  details?: readonly ReactNode[];
  confirmLabel: string;
  confirmTone?: "default" | "danger";
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const preview = target || details.length > 0 ? (
    <div className={styles.confirmDetails}>
      {target ? <strong>{target}</strong> : null}
      {details.map((detail, index) => <span key={index}>{detail}</span>)}
    </div>
  ) : undefined;
  return (
    <ConfirmDialog
      title={title}
      description={description}
      preview={preview}
      confirmLabel={confirmLabel}
      confirmTone={confirmTone}
      cancelDisabled={busy}
      confirmDisabled={busy}
      onCancel={busy ? () => undefined : onCancel}
      onConfirm={busy ? () => undefined : onConfirm}
    />
  );
}

export function GitChoiceDialog({
  title,
  description,
  busy = false,
  error = null,
  children,
  actions,
  onCancel,
}: {
  title: ReactNode;
  description?: ReactNode;
  busy?: boolean;
  error?: string | null;
  children?: ReactNode;
  actions: readonly { label: string; tone?: "secondary" | "primary" | "danger"; disabled?: boolean; onSelect: () => void }[];
  onCancel: () => void;
}) {
  return (
    <AppDialog
      title={title}
      description={description}
      size="confirm"
      backdrop="plain"
      closeOnOverlayClick={false}
      showClose={false}
      closeOnEscape={!busy}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          {actions.map((action) => (
            <DialogButton
              key={action.label}
              type="button"
              tone={action.tone}
              disabled={busy || action.disabled}
              onClick={action.onSelect}
            >
              {action.label}
            </DialogButton>
          ))}
          <DialogButton type="button" disabled={busy} onClick={onCancel}>取消</DialogButton>
        </>
      }
    >
      {children}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </AppDialog>
  );
}
