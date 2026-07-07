import { Download, Info, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  getCurrentAppVersion,
  type AppUpdateProgress,
  type PendingAppUpdate,
} from "@/runtime";

import styles from "./AboutSettingsPage.module.css";

type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "installed" | "error";

const EMPTY_PROGRESS: AppUpdateProgress = {
  downloadedBytes: 0,
  totalBytes: null,
  finished: false,
};

export function AboutSettingsPage() {
  const [currentVersion, setCurrentVersion] = useState("...");
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<PendingAppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const updaterAvailable = canUseAppUpdater();
  const busy = status === "checking" || status === "downloading";

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

  const statusText = useMemo(
    () => updateStatusText(status, pendingUpdate, progress, updaterAvailable),
    [pendingUpdate, progress, status, updaterAvailable],
  );

  const checkUpdate = async () => {
    if (busy) {
      return;
    }
    setStatus("checking");
    setPendingUpdate(null);
    setProgress(EMPTY_PROGRESS);
    setError(null);
    try {
      const update = await checkForAppUpdate();
      if (!update) {
        setStatus("current");
        return;
      }
      setPendingUpdate(update);
      setStatus("available");
    } catch (reason) {
      setStatus("error");
      setError(errorMessage(reason));
    }
  };

  const installUpdate = async () => {
    if (!pendingUpdate || busy) {
      return;
    }
    setStatus("downloading");
    setProgress(EMPTY_PROGRESS);
    setError(null);
    try {
      await downloadAndInstallAppUpdate(pendingUpdate, setProgress);
      setStatus("installed");
    } catch (reason) {
      setStatus("error");
      setError(errorMessage(reason));
    }
  };

  return (
    <main className={styles.page} data-settings-page data-testid="about-settings-page">
      <header className={styles.header} data-settings-header>
        <div>
          <h1>关于</h1>
          <p>Keydex 桌面端版本与更新</p>
        </div>
      </header>

      <section className={styles.section} data-settings-group aria-labelledby="about-version-title">
        <h2 className={styles.groupTitle} data-settings-group-title id="about-version-title">
          版本信息
        </h2>
        <div className={styles.settingsPanel} data-settings-panel>
          <div className={styles.settingRow}>
            <div className={styles.infoLine}>
              <span className={styles.settingIcon} aria-hidden="true">
                <Info size={17} />
              </span>
              <span className={styles.infoText}>
                <span className={styles.versionLine}>
                  <strong>版本信息</strong>
                  <span>当前版本 {currentVersion}</span>
                </span>
                {status !== "idle" || !updaterAvailable ? (
                  <span className={styles.infoSubtitle}>{statusText}</span>
                ) : null}
              </span>
            </div>

            <div className={styles.actions}>
              <button
                data-settings-secondary
                disabled={busy || !updaterAvailable}
                onClick={checkUpdate}
                type="button"
              >
                <RefreshCw size={15} />
                <span>{status === "checking" ? "检查中" : "检查更新"}</span>
              </button>
              {pendingUpdate ? (
                <button data-settings-primary disabled={busy} onClick={installUpdate} type="button">
                  {status === "downloading" ? <RotateCcw size={15} /> : <Download size={15} />}
                  <span>{status === "downloading" ? "下载中" : "下载更新并重启"}</span>
                </button>
              ) : null}
            </div>
          </div>

          {status === "downloading" ? (
            <div
              aria-label="更新下载进度"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progressPercent(progress)}
              className={`${styles.progress} ${progress.totalBytes ? "" : styles.progressIndeterminate}`}
              role="progressbar"
            >
              <span className={styles.progressTrack}>
                <span className={styles.progressValue} style={{ width: `${progressPercent(progress)}%` }} />
              </span>
              <span className={styles.progressText}>{progressText(progress)}</span>
            </div>
          ) : null}

          {pendingUpdate?.body ? <p className={styles.notes}>{pendingUpdate.body}</p> : null}

          {error ? (
            <p className={styles.error} data-settings-error role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function updateStatusText(
  status: UpdateStatus,
  update: PendingAppUpdate | null,
  progress: AppUpdateProgress,
  updaterAvailable: boolean,
): string {
  if (!updaterAvailable) {
    return "当前环境不支持应用内更新";
  }
  if (status === "checking") {
    return "正在检查更新";
  }
  if (status === "current") {
    return "已是最新版本";
  }
  if (status === "available" && update) {
    return `发现新版本 ${update.version}`;
  }
  if (status === "downloading") {
    return `正在下载更新 ${progressPercent(progress)}%`;
  }
  if (status === "installed") {
    return "更新已安装，正在重启";
  }
  if (status === "error") {
    return "更新检查失败";
  }
  return "尚未检查更新";
}

function progressPercent(progress: AppUpdateProgress): number {
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return progress.finished ? 100 : 0;
  }
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
}

function progressText(progress: AppUpdateProgress): string {
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return `${formatBytes(progress.downloadedBytes)} 已下载`;
  }
  return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${formatNumber(kib)} KB`;
  }
  return `${formatNumber(kib / 1024)} MB`;
}

function formatNumber(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
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
