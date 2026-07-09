import { Download, RotateCcw } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
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

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installed"
  | "error";

export interface AppUpdateCheckOptions {
  notify?: boolean;
  openDialogOnAvailable?: boolean;
}

export interface AppUpdateInstallOptions {
  notify?: boolean;
}

export interface AppUpdateContextValue {
  updaterAvailable: boolean;
  status: AppUpdateStatus;
  pendingUpdate: PendingAppUpdate | null;
  progress: AppUpdateProgress;
  error: string;
  busy: boolean;
  checkUpdate(options?: AppUpdateCheckOptions): Promise<PendingAppUpdate | null>;
  installUpdate(options?: AppUpdateInstallOptions): Promise<void>;
  dismissDialog(): void;
  openDialog(): void;
}

const EMPTY_PROGRESS: AppUpdateProgress = {
  downloadedBytes: 0,
  totalBytes: null,
  finished: false,
};

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

export function AppUpdateController({ children }: PropsWithChildren) {
  const notifications = useNotifications();
  const updaterAvailable = canUseAppUpdater();
  const startupCheckStartedRef = useRef(false);
  const [status, setStatus] = useState<AppUpdateStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<PendingAppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const busy = status === "checking" || status === "downloading";

  const checkUpdate = useCallback(
    async (options: AppUpdateCheckOptions = {}) => {
      const notify = options.notify === true;
      const openDialogOnAvailable = options.openDialogOnAvailable !== false;
      if (busy) {
        return pendingUpdate;
      }
      if (!updaterAvailable) {
        const message = "当前环境不支持应用内更新";
        setStatus("error");
        setError(message);
        if (notify) {
          notifications.error(`更新检查失败：${message}`);
        }
        return null;
      }

      setStatus("checking");
      setError("");
      setProgress(EMPTY_PROGRESS);
      try {
        const update = await checkForAppUpdate();
        if (!update) {
          setPendingUpdate(null);
          setStatus("current");
          setDialogOpen(false);
          if (notify) {
            notifications.success("已是最新版本");
          }
          return null;
        }

        setPendingUpdate(update);
        setStatus("available");
        setDialogOpen(openDialogOnAvailable);
        if (notify) {
          notifications.info(`发现新版本 ${update.version}`);
        }
        return update;
      } catch (reason) {
        const message = errorMessage(reason);
        setStatus("error");
        setError(message);
        if (notify) {
          notifications.error(`更新检查失败：${message}`);
        }
        return null;
      }
    },
    [busy, notifications, pendingUpdate, updaterAvailable],
  );

  const installUpdate = useCallback(
    async (options: AppUpdateInstallOptions = {}) => {
      if (!pendingUpdate || status === "downloading" || status === "installed") {
        return;
      }

      setStatus("downloading");
      setDialogOpen(true);
      setProgress(EMPTY_PROGRESS);
      setError("");
      if (options.notify === true) {
        notifications.info("开始下载更新");
      }

      try {
        await downloadAndInstallAppUpdate(pendingUpdate, setProgress);
        setStatus("installed");
      } catch (reason) {
        const message = errorMessage(reason);
        setStatus("error");
        setError(message);
        setDialogOpen(true);
        if (options.notify === true) {
          notifications.error(`更新安装失败：${message}`);
        }
      }
    },
    [notifications, pendingUpdate, status],
  );

  const dismissDialog = useCallback(() => {
    if (status === "downloading" || status === "installed") {
      return;
    }
    setDialogOpen(false);
  }, [status]);

  const openDialog = useCallback(() => {
    if (pendingUpdate) {
      setDialogOpen(true);
    }
  }, [pendingUpdate]);

  useEffect(() => {
    if (startupCheckStartedRef.current || !updaterAvailable) {
      return;
    }
    startupCheckStartedRef.current = true;
    void checkUpdate({ openDialogOnAvailable: true });
  }, [checkUpdate, updaterAvailable]);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      updaterAvailable,
      status,
      pendingUpdate,
      progress,
      error,
      busy,
      checkUpdate,
      installUpdate,
      dismissDialog,
      openDialog,
    }),
    [
      busy,
      checkUpdate,
      dismissDialog,
      error,
      installUpdate,
      openDialog,
      pendingUpdate,
      progress,
      status,
      updaterAvailable,
    ],
  );

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <AppUpdateDialog
        dialogOpen={dialogOpen}
        error={error}
        pendingUpdate={pendingUpdate}
        progress={progress}
        status={status}
        onClose={dismissDialog}
        onInstall={() => void installUpdate()}
      />
    </AppUpdateContext.Provider>
  );
}

export function useAppUpdate(): AppUpdateContextValue {
  const value = useContext(AppUpdateContext);
  if (!value) {
    throw new Error("useAppUpdate must be used inside AppUpdateController");
  }
  return value;
}

interface AppUpdateDialogProps {
  dialogOpen: boolean;
  status: AppUpdateStatus;
  pendingUpdate: PendingAppUpdate | null;
  progress: AppUpdateProgress;
  error: string;
  onClose: () => void;
  onInstall: () => void;
}

function AppUpdateDialog({
  dialogOpen,
  status,
  pendingUpdate,
  progress,
  error,
  onClose,
  onInstall,
}: AppUpdateDialogProps) {
  const progressPercent = useMemo(() => appUpdateProgressPercent(progress), [progress]);
  const canDismiss = status !== "downloading" && status !== "installed";

  if (!dialogOpen || !pendingUpdate || status === "idle" || status === "current" || status === "checking") {
    return null;
  }

  return (
    <AppDialog
      title="发现新版本"
      description={`当前版本 ${pendingUpdate.currentVersion}，可更新到 ${pendingUpdate.version}`}
      size="confirm"
      backdrop="plain"
      closeOnEscape={canDismiss}
      closeOnOverlayClick={canDismiss}
      showClose={canDismiss}
      onClose={canDismiss ? onClose : undefined}
      footer={
        <>
          {canDismiss ? (
            <DialogButton type="button" onClick={onClose}>
              稍后
            </DialogButton>
          ) : null}
          <DialogButton
            className={styles.actionButton}
            tone="primary"
            type="button"
            disabled={status === "downloading" || status === "installed"}
            onClick={onInstall}
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

function updateActionLabel(status: AppUpdateStatus): string {
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
