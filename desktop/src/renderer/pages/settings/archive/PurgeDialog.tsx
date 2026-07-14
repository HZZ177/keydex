import { useRef, useState } from "react";

import {
  createLifecycleRequestId,
  decodeLifecycleRuntimeError,
  type ArchivedSessionItem,
  type ArchivedWorkspaceItem,
  type PurgeResult,
} from "@/runtime";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";

import styles from "../ManagementPages.module.css";

type PurgeTarget =
  | { type: "workspace"; item: ArchivedWorkspaceItem }
  | { type: "workspace_sessions"; item: { id: string; name: string } }
  | { type: "session"; item: ArchivedSessionItem };

export interface PendingPurgeCleanup {
  requestId: string;
  operationId: string | null;
  targetType: "workspace" | "workspace_sessions" | "session";
  entityId: string;
  displayName: string;
  confirmationName?: string;
}

export function PurgeDialog({
  target,
  onCancel,
  onPurge,
  onDatabasePurged,
  onCleanupPending,
  onCleanupCompleted,
}: {
  target: PurgeTarget;
  onCancel: () => void;
  onPurge: (requestId: string, confirmationName?: string) => Promise<PurgeResult>;
  onDatabasePurged: () => void;
  onCleanupPending: (cleanup: PendingPurgeCleanup) => void;
  onCleanupCompleted: (requestId: string) => void;
}) {
  const requestId = useRef(createLifecycleRequestId(`${target.type}-purge`));
  const [confirmationName, setConfirmationName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectReady = target.type === "session" || confirmationName === target.item.name;
  const sessionReady = target.type !== "session" || confirmed;

  const purge = async () => {
    if (busy || !projectReady || !sessionReady) return;
    setBusy(true);
    setError(null);
    try {
      await onPurge(requestId.current, target.type === "session" ? undefined : confirmationName);
      onCleanupCompleted(requestId.current);
      onDatabasePurged();
      onCancel();
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind === "cleanup_failed") {
        setCleanupFailed(true);
        onDatabasePurged();
        onCleanupPending({
          requestId: requestId.current,
          operationId: typeof decoded.details.operation_id === "string" ? decoded.details.operation_id : null,
          targetType: target.type,
          entityId: target.item.id,
          displayName: target.type === "session" ? target.item.title || "未命名会话" : target.item.name,
          confirmationName: target.type === "session" ? undefined : confirmationName,
        });
        setError("Keydex 数据已删除，但受管隔离区清理失败。请使用同一操作重试清理。");
      } else {
        setError(reason instanceof Error && reason.message ? reason.message : "彻底删除失败");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={cleanupFailed ? "清理尚未完成" : "彻底删除 Keydex 数据"}
      description={
        target.type === "workspace"
          ? "将彻底删除该 Keydex 项目记录、全部会话、历史、归档和内部关联数据；不会删除本地目录或其中的文件。"
          : target.type === "workspace_sessions"
            ? "将彻底删除该项目下全部已归档会话、历史和 Keydex 内部关联数据；项目记录、本地目录和其中的文件都会保留。此操作不可恢复。"
            : "将彻底删除该会话历史和 Keydex 内部关联数据。此操作不可恢复。"
      }
      size="form"
      closeOnOverlayClick={false}
      bodyClassName={styles.dialogBody}
      footerClassName={styles.dialogFooter}
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <DialogButton type="button" disabled={busy} onClick={onCancel}>关闭</DialogButton>
          <DialogButton tone="danger" type="button" disabled={busy || !projectReady || !sessionReady} onClick={() => void purge()}>
            {busy ? "正在处理" : cleanupFailed ? "重试清理" : "彻底删除"}
          </DialogButton>
        </>
      }
    >
      <div className={styles.form} aria-busy={busy}>
        <strong className={styles.dialogEntity}>{target.type === "session" ? target.item.title || "未命名会话" : target.item.name}</strong>
        {target.type !== "session" ? (
          <label>
            输入项目名称以确认
            <input autoFocus aria-label="输入项目名称以确认" value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} />
          </label>
        ) : (
          <label className={styles.checkboxLabel}>
            <input aria-label="确认彻底删除会话" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>我理解该会话将无法恢复</span>
          </label>
        )}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
      </div>
    </AppDialog>
  );
}
