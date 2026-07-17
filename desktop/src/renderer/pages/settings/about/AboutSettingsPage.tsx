import { BookOpenText, Download, Info, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import {
  type AppUpdateProgress,
  type PendingAppUpdate,
} from "@/runtime";
import {
  useAppUpdate,
  type AppUpdateStatus,
} from "@/renderer/providers/AppUpdateController";
import { appUpdateProgressPercent } from "@/renderer/utils/appUpdateDisplay";

import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import styles from "./AboutSettingsPage.module.css";

export function AboutSettingsPage() {
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const appUpdate = useAppUpdate();
  const { busy, currentVersion = "...", pendingUpdate, progress, status, updaterAvailable } = appUpdate;

  const statusText = useMemo(
    () => updateStatusText(status, pendingUpdate, progress, updaterAvailable),
    [pendingUpdate, progress, status, updaterAvailable],
  );

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
                onClick={() => setReleaseNotesOpen(true)}
                type="button"
              >
                <BookOpenText size={15} />
                <span>更新日志</span>
              </button>
              <button
                data-settings-secondary
                disabled={busy || !updaterAvailable}
                onClick={() => void appUpdate.checkUpdate({ openDialog: true })}
                type="button"
              >
                <RefreshCw size={15} />
                <span>{status === "checking" ? "检查中" : "检查更新"}</span>
              </button>
              {pendingUpdate ? (
                <button
                  data-settings-primary
                  disabled={busy}
                  onClick={appUpdate.openDialog}
                  type="button"
                >
                  <Download size={15} />
                  <span>查看并更新</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {releaseNotesOpen ? (
        <ReleaseNotesDialog
          currentVersion={currentVersion}
          onClose={() => setReleaseNotesOpen(false)}
        />
      ) : null}
    </main>
  );
}

function updateStatusText(
  status: AppUpdateStatus,
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
    return `正在下载更新 ${appUpdateProgressPercent(progress)}%`;
  }
  if (status === "installed") {
    return "更新已安装，正在重启";
  }
  if (status === "error") {
    return "更新检查失败";
  }
  return "尚未检查更新";
}
