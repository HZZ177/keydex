import {
  CircleAlert,
  CircleCheck,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { StaticMarkdown } from "@/renderer/components/markdown/StaticMarkdown";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import {
  appUpdateProgressPercent,
  appUpdateProgressText,
} from "@/renderer/utils/appUpdateDisplay";
import {
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  getCurrentAppVersion,
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
  openDialog?: boolean;
  openDialogOnAvailable?: boolean;
  /** Preserve visible update state and suppress errors while polling in the background. */
  background?: boolean;
}

export interface AppUpdateInstallOptions {
  notify?: boolean;
}

export interface AppUpdateContextValue {
  updaterAvailable: boolean;
  currentVersion: string;
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

export const APP_UPDATE_POLL_INTERVAL_MS = 5 * 60 * 1000;

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

export function AppUpdateController({ children }: PropsWithChildren) {
  const notifications = useNotifications();
  const updaterAvailable = canUseAppUpdater();
  const startupCheckStartedRef = useRef(false);
  const backgroundCheckInFlightRef = useRef(false);
  const foregroundCheckGenerationRef = useRef(0);
  const [currentVersion, setCurrentVersion] = useState("...");
  const [status, setStatus] = useState<AppUpdateStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<PendingAppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<"check" | "install" | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const busy = status === "checking" || status === "downloading";

  const checkUpdate = useCallback(
    async (options: AppUpdateCheckOptions = {}) => {
      const background = options.background === true;
      const notify = !background && options.notify === true;
      const openDialogForCheck = options.openDialog === true;
      const openDialogOnAvailable = options.openDialogOnAvailable !== false;
      if (!background && openDialogForCheck) {
        setDialogOpen(true);
      }
      if (busy || status === "installed" || (background && (dialogOpen || backgroundCheckInFlightRef.current))) {
        return pendingUpdate;
      }
      if (!updaterAvailable) {
        if (background) {
          return null;
        }
        const message = "当前环境不支持应用内更新";
        setStatus("error");
        setError(message);
        setErrorKind("check");
        if (notify) {
          notifications.error(`更新检查失败：${message}`);
        }
        return null;
      }

      const foregroundGeneration = foregroundCheckGenerationRef.current + (background ? 0 : 1);
      if (background) {
        backgroundCheckInFlightRef.current = true;
      } else {
        foregroundCheckGenerationRef.current = foregroundGeneration;
        setStatus("checking");
        setPendingUpdate(null);
        setError("");
        setErrorKind(null);
        setProgress(EMPTY_PROGRESS);
      }
      try {
        const update = await checkForAppUpdate();
        if (background && foregroundGeneration !== foregroundCheckGenerationRef.current) {
          return update;
        }
        if (!update) {
          setPendingUpdate(null);
          setStatus("current");
          setError("");
          setErrorKind(null);
          if (!background) {
            setDialogOpen(openDialogForCheck);
          }
          if (notify) {
            notifications.success("已是最新版本");
          }
          return null;
        }

        setPendingUpdate(update);
        setCurrentVersion(update.currentVersion);
        setStatus("available");
        setError("");
        setErrorKind(null);
        if (!background) {
          setDialogOpen(openDialogForCheck || openDialogOnAvailable);
        }
        if (notify) {
          notifications.info(`发现新版本 ${update.version}`);
        }
        return update;
      } catch (reason) {
        if (background) {
          return null;
        }
        const message = errorMessage(reason);
        setStatus("error");
        setError(message);
        setErrorKind("check");
        setDialogOpen(openDialogForCheck);
        if (notify) {
          notifications.error(`更新检查失败：${message}`);
        }
        return null;
      } finally {
        if (background) {
          backgroundCheckInFlightRef.current = false;
        }
      }
    },
    [busy, dialogOpen, notifications, pendingUpdate, status, updaterAvailable],
  );

  const installUpdate = useCallback(
    async (options: AppUpdateInstallOptions = {}) => {
      if (!pendingUpdate || status === "downloading" || status === "installed") {
        return;
      }

      foregroundCheckGenerationRef.current += 1;
      setStatus("downloading");
      setDialogOpen(true);
      setProgress(EMPTY_PROGRESS);
      setError("");
      setErrorKind(null);
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
        setErrorKind("install");
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
    let active = true;
    void getCurrentAppVersion().then((version) => {
      if (active) {
        setCurrentVersion(version);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (startupCheckStartedRef.current || !updaterAvailable) {
      return;
    }
    startupCheckStartedRef.current = true;
    void checkUpdate({ openDialogOnAvailable: true });
  }, [checkUpdate, updaterAvailable]);

  useEffect(() => {
    if (!updaterAvailable) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void checkUpdate({ background: true, openDialogOnAvailable: false });
    }, APP_UPDATE_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkUpdate, updaterAvailable]);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      updaterAvailable,
      currentVersion,
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
      currentVersion,
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
        currentVersion={currentVersion}
        dialogOpen={dialogOpen}
        error={error}
        errorKind={errorKind}
        pendingUpdate={pendingUpdate}
        progress={progress}
        status={status}
        onClose={dismissDialog}
        onInstall={() => void installUpdate()}
        onRetry={() => void checkUpdate({ openDialog: true })}
      />
    </AppUpdateContext.Provider>
  );
}

export function useAppUpdate(): AppUpdateContextValue {
  const value = useOptionalAppUpdate();
  if (!value) {
    throw new Error("useAppUpdate must be used inside AppUpdateController");
  }
  return value;
}

export function useOptionalAppUpdate(): AppUpdateContextValue | null {
  return useContext(AppUpdateContext);
}

interface AppUpdateDialogProps {
  currentVersion: string;
  dialogOpen: boolean;
  status: AppUpdateStatus;
  pendingUpdate: PendingAppUpdate | null;
  progress: AppUpdateProgress;
  error: string;
  errorKind: "check" | "install" | null;
  onClose: () => void;
  onInstall: () => void;
  onRetry: () => void;
}

export function AppUpdateDialog({
  currentVersion,
  dialogOpen,
  status,
  pendingUpdate,
  progress,
  error,
  errorKind,
  onClose,
  onInstall,
  onRetry,
}: AppUpdateDialogProps) {
  const progressPercent = useMemo(() => appUpdateProgressPercent(progress), [progress]);
  const canDismiss = status !== "downloading" && status !== "installed";
  const showInstallAction = Boolean(pendingUpdate)
    && (status === "available" || status === "downloading" || status === "installed" || errorKind === "install");
  const showRetryCheck = status === "error" && errorKind === "check";

  if (!dialogOpen || status === "idle") {
    return null;
  }

  return (
    <AppDialog
      title={updateDialogTitle(status, errorKind)}
      description={updateDialogDescription(status, pendingUpdate, currentVersion)}
      size="form"
      backdrop="plain"
      panelClassName={styles.dialog}
      bodyClassName={styles.dialogBody}
      footerClassName={styles.dialogFooter}
      closeOnEscape={canDismiss}
      closeOnOverlayClick={canDismiss}
      showClose={canDismiss}
      onClose={canDismiss ? onClose : undefined}
      footer={
        <div className={styles.footerActions}>
          {canDismiss ? (
            <DialogButton type="button" onClick={onClose}>
              {status === "available" || errorKind === "install" ? "稍后" : "关闭"}
            </DialogButton>
          ) : null}
          {showRetryCheck ? (
            <DialogButton className={styles.actionButton} tone="primary" type="button" onClick={onRetry}>
              <RefreshCw size={15} />
              <span>重新检查</span>
            </DialogButton>
          ) : null}
          {showInstallAction ? (
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
          ) : null}
        </div>
      }
    >
      {status === "checking" ? (
        <UpdateState
          icon={<LoaderCircle className={styles.spin} size={23} />}
          title="正在连接更新服务"
          detail="正在获取最新版本信息，请稍候…"
        />
      ) : status === "current" ? (
        <UpdateState
          icon={<CircleCheck size={23} />}
          title={`Keydex ${currentVersion} 已是最新版本`}
          detail="当前没有需要安装的更新。"
          tone="success"
        />
      ) : status === "error" && errorKind === "check" ? (
        <UpdateState
          icon={<CircleAlert size={23} />}
          title="暂时无法检查更新"
          detail={error || "请检查网络连接后重试。"}
          tone="danger"
        />
      ) : pendingUpdate ? (
        <div className={styles.details}>
          <div className={styles.releaseHeader}>
            <div className={styles.versionLine}>
              <strong>Keydex {pendingUpdate.version}</strong>
              <span>当前版本 {pendingUpdate.currentVersion}</span>
              {pendingUpdate.date ? <time dateTime={pendingUpdate.date}>{formatUpdateDate(pendingUpdate.date)}</time> : null}
            </div>
            {status === "available" ? <span className={styles.readyBadge}>可更新</span> : null}
          </div>

          {status === "available" ? <p className={styles.status}>新版本已准备好。确认更新后会自动下载、安装并重启 Keydex。</p> : null}
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

          <div className={styles.notes}>
            <span className={styles.notesTitle}>本次更新</span>
            <div className={styles.notesViewport}>
              {pendingUpdate.body ? (
                <StaticMarkdown
                  ariaLabel={`${pendingUpdate.version} 更新说明`}
                  className={styles.notesBody}
                  source={pendingUpdate.body}
                />
              ) : (
                <p className={styles.emptyNotes}>此版本没有提供详细更新说明。</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </AppDialog>
  );
}

function UpdateState({
  icon,
  title,
  detail,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div className={styles.updateState} data-tone={tone}>
      <span className={styles.stateIcon} aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function updateDialogTitle(
  status: AppUpdateStatus,
  errorKind: "check" | "install" | null,
): string {
  if (status === "checking") return "检查更新";
  if (status === "current") return "已是最新版本";
  if (status === "error") return errorKind === "install" ? "更新失败" : "检查更新失败";
  if (status === "downloading") return "正在更新 Keydex";
  if (status === "installed") return "正在重启 Keydex";
  return "发现新版本";
}

function updateDialogDescription(
  status: AppUpdateStatus,
  update: PendingAppUpdate | null,
  currentVersion: string,
): string {
  if (update && (status === "available" || status === "downloading" || status === "installed" || status === "error")) {
    return `从 ${update.currentVersion} 更新到 ${update.version}`;
  }
  return `当前版本 ${currentVersion}`;
}

function formatUpdateDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
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
