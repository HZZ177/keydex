import type { ReactNode } from "react";

import { AppDialog } from "./AppDialog";
import { DialogButton } from "./DialogButton";
import styles from "./AppDialog.module.css";

export interface ConfirmDialogProps {
  title: ReactNode;
  description?: ReactNode;
  preview?: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  confirmTone?: "default" | "danger";
  cancelDisabled?: boolean;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  description,
  preview,
  cancelLabel = "取消",
  confirmLabel,
  confirmTone = "default",
  cancelDisabled = false,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AppDialog
      title={title}
      description={description}
      size="confirm"
      backdrop="plain"
      closeOnOverlayClick={false}
      showClose={false}
      onClose={onCancel}
      footer={
        <>
          <DialogButton type="button" disabled={cancelDisabled} onClick={onCancel}>
            {cancelLabel}
          </DialogButton>
          <DialogButton
            tone={confirmTone === "danger" ? "danger" : "primary"}
            type="button"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </DialogButton>
        </>
      }
    >
      {preview ? <div className={styles.confirmPreview}>{preview}</div> : null}
    </AppDialog>
  );
}
