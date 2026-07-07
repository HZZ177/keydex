import { Download, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import {
  appUpdateProgressPercent,
  appUpdateProgressText,
} from "@/renderer/utils/appUpdateDisplay";
import {
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  type AppUpdateProgress,
  type PendingAppUpdate,
} from "@/runtime";

import styles from "./AppUpdateController.module.css";

type UpdateDialogStatus = "idle" | "available" | "downloading" | "installed" | "error";

const EMPTY_PROGRESS: AppUpdateProgress = {
  downloadedBytes: 0,
  totalBytes: null,
  finished: false,
};

export function AppUpdateController() {
  const [status, setStatus] = useState<UpdateDialogStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<PendingAppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canUseAppUpdater()) {
      return;
    }

    let active = true;
    void checkForAppUpdate()
      .then((update) => {
        if (!active || !update) {
          return;
        }
        setPendingUpdate(update);
        setStatus("available");
      })
      .catch(() => {
        // Startup checks are intentionally silent unless an update is available.
      });

    return () => {
      active = false;
    };
  }, []);

  const progressPercent = useMemo(() => appUpdateProgressPercent(progress), [progress]);
  const canDismiss = status !== "downloading" && status !== "installed";

  if (!pendingUpdate || status === "idle") {
    return null;
  }

  const closeDialog = () => {
    if (!canDismiss) {
      return;
    }
    setStatus("idle");
    setPendingUpdate(null);
    setProgress(EMPTY_PROGRESS);
    setError("");
  };

  const installUpdate = async () => {
    if (!pendingUpdate || status === "downloading" || status === "installed") {
      return;
    }
    setStatus("downloading");
    setProgress(EMPTY_PROGRESS);
    setError("");
    try {
      await downloadAndInstallAppUpdate(pendingUpdate, setProgress);
      setStatus("installed");
    } catch (reason) {
      setStatus("error");
      setError(errorMessage(reason));
    }
  };

  return (
    <AppDialog
      title="发现新版本"
      description={`当前版本 ${pendingUpdate.currentVersion}，可更新到 ${pendingUpdate.version}`}
      size="confirm"
      backdrop="plain"
      closeOnEscape={canDismiss}
      closeOnOverlayClick={canDismiss}
      showClose={canDismiss}
      onClose={canDismiss ? closeDialog : undefined}
      footer={
        <>
          {canDismiss ? (
            <DialogButton type="button" onClick={closeDialog}>
              稍后
            </DialogButton>
          ) : null}
          <DialogButton
            className={styles.actionButton}
            tone="primary"
            type="button"
            disabled={status === "downloading" || status === "installed"}
            onClick={() => void installUpdate()}
          >
            {status === "downloading" ? <RotateCcw size={15} /> : <Download size={15} />}
            <span>{updateActionLabel(status)}</span>
          </DialogButton>
        </>
      }
    >
      <div className={styles.details}>
        <div className={styles.versionLine}>
          <strong>Keydex {pendingUpdate.version}</strong>
          {pendingUpdate.date ? <span>{pendingUpdate.date}</span> : null}
        </div>
        {status === "available" ? <p className={styles.status}>新版本已准备好，可以下载并重启完成更新。</p> : null}
        {status === "installed" ? <p className={styles.status}>更新已安装，正在重启应用。</p> : null}
        {status === "error" && error ? <p className={styles.error}>更新安装失败：{error}</p> : null}

        {status === "downloading" ? (
          <div
            aria-label="更新下载进度"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progressPercent}
            className={`${styles.progress} ${progress.totalBytes ? "" : styles.progressIndeterminate}`}
            role="progressbar"
          >
            <span className={styles.progressTrack}>
              <span className={styles.progressValue} style={{ width: `${progressPercent}%` }} />
            </span>
            <span className={styles.progressText}>
              正在下载更新 {progressPercent}% · {appUpdateProgressText(progress)}
            </span>
          </div>
        ) : null}

        {pendingUpdate.body ? (
          <div className={styles.notes}>
            <span className={styles.notesTitle}>更新说明</span>
            <div className={styles.notesBody}>{pendingUpdate.body}</div>
          </div>
        ) : null}
      </div>
    </AppDialog>
  );
}

function updateActionLabel(status: UpdateDialogStatus): string {
  if (status === "downloading") {
    return "下载中";
  }
  if (status === "installed") {
    return "正在重启";
  }
  if (status === "error") {
    return "重试下载并重启";
  }
  return "下载并重启";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === "string" && reason) {
    return reason;
  }
  return "操作失败";
}
