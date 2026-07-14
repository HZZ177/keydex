import { useState } from "react";

import type { ArchivedWorkspaceItem, WorkspaceRestoreMode, WorkspaceRestoreResult } from "@/runtime";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";

import styles from "../ManagementPages.module.css";

export function ProjectRestoreDialog({
  project,
  onCancel,
  onRestore,
}: {
  project: ArchivedWorkspaceItem;
  onCancel: () => void;
  onRestore: (mode: WorkspaceRestoreMode) => Promise<WorkspaceRestoreResult>;
}) {
  const [busyMode, setBusyMode] = useState<WorkspaceRestoreMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (mode: WorkspaceRestoreMode) => {
    if (busyMode) return;
    setBusyMode(mode);
    setError(null);
    try {
      await onRestore(mode);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "恢复项目失败");
    } finally {
      setBusyMode(null);
    }
  };

  return (
    <AppDialog
      title="恢复归档项目"
      description="请选择恢复范围。手动归档的会话不会被项目恢复操作自动恢复。"
      size="form"
      closeOnOverlayClick={false}
      bodyClassName={styles.dialogBody}
      footerClassName={styles.dialogFooter}
      onClose={onCancel}
      footer={
        <>
          <DialogButton type="button" disabled={Boolean(busyMode)} onClick={onCancel}>取消</DialogButton>
          <DialogButton type="button" disabled={Boolean(busyMode)} onClick={() => void restore("project_only")}>
            {busyMode === "project_only" ? "正在恢复" : "仅恢复项目"}
          </DialogButton>
          <DialogButton tone="primary" type="button" disabled={Boolean(busyMode)} onClick={() => void restore("with_project_sessions")}>
            {busyMode === "with_project_sessions" ? "正在恢复" : "恢复项目及随项目归档的会话"}
          </DialogButton>
        </>
      }
    >
      <div className={styles.form} aria-busy={Boolean(busyMode)}>
        <strong className={styles.dialogEntity}>{project.name}</strong>
        <div className={styles.dialogStats}>
          <div className={styles.dialogStat}><strong>{project.project_session_count} 个</strong><span>随项目归档，可随项目恢复</span></div>
          <div className={styles.dialogStat}><strong>{project.manual_session_count} 个</strong><span>手动归档，保持归档</span></div>
        </div>
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
      </div>
    </AppDialog>
  );
}
