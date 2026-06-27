import { Check, Download, Laptop, Type } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useFontPreference, type AppFontFamily, type FontDownloadProgress } from "@/renderer/providers/FontProvider";

import styles from "./GeneralSettingsPage.module.css";

const fontOptions: Array<{
  id: AppFontFamily;
  label: string;
  icon: LucideIcon;
}> = [
  {
    id: "system",
    label: "系统默认",
    icon: Laptop,
  },
  {
    id: "maple-mono",
    label: "Maple Mono",
    icon: Type,
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    icon: Type,
  },
];

const fontStatusLabels: Partial<Record<AppFontFamily, string>> = {
  "maple-mono": "Maple Mono CN 已启用",
  "jetbrains-mono": "JetBrains Mono 已启用",
};

export function GeneralSettingsPage() {
  const font = useFontPreference();
  const downloading = font.status === "downloading";
  const showProgress = downloading && font.downloadingFamily !== null;

  const chooseFont = (family: AppFontFamily) => {
    if (downloading || font.family === family) {
      return;
    }
    void font.setFamily(family).catch(() => undefined);
  };

  return (
    <main className={styles.page} data-testid="general-settings-page">
      <header className={styles.header}>
        <div>
          <h1>外观</h1>
          <p>管理本地应用偏好</p>
        </div>
      </header>

      <section className={styles.section} aria-labelledby="display-settings-title">
        <h2 className={styles.groupTitle} id="display-settings-title">应用显示</h2>
        <div className={styles.settingsPanel}>
          <div className={styles.settingRow}>
          <header className={styles.sectionHeader}>
            <span className={styles.settingIcon} aria-hidden="true">
              <Type size={17} />
            </span>
            <div>
              <h3>UI 字体</h3>
              <p>{fontStatusText(font.family, font.status)}</p>
            </div>
          </header>

          <div className={styles.optionGrid} role="radiogroup" aria-label="系统字体">
            {fontOptions.map((option) => {
              const Icon = option.icon;
              const selected = font.family === option.id;
              const isFontAssetOption = option.id !== "system";
              const cached = Boolean(font.cachedFamilies[option.id]);
              const isOptionDownloading = isFontAssetOption && font.downloadingFamily === option.id && downloading;
              const optionDescription = fontOptionDescription({
                id: option.id,
                selected,
                downloading: isOptionDownloading,
                cached,
                progress: font.progress,
              });
              return (
                <button
                  aria-checked={selected}
                  className={styles.option}
                  data-selected={selected ? "true" : "false"}
                  disabled={downloading}
                  key={option.id}
                  onClick={() => chooseFont(option.id)}
                  role="radio"
                  type="button"
                >
                  <span className={styles.optionIcon}>
                    <Icon size={16} />
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>{option.label}</span>
                    <span className={styles.optionDescription}>{optionDescription}</span>
                  </span>
                  <span className={styles.optionState} aria-hidden="true">
                    {selected ? (
                      <Check size={15} />
                    ) : isFontAssetOption && !cached ? (
                      <Download size={15} />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          </div>

          {showProgress ? (
            <div
              className={styles.progress}
              aria-label="字体下载进度"
              aria-valuemax={font.progress.totalBytes}
              aria-valuemin={0}
              aria-valuenow={font.progress.downloadedBytes}
              role="progressbar"
            >
              <span className={styles.progressTrack}>
                <span className={styles.progressValue} style={{ width: `${font.progress.percent}%` }} />
              </span>
              <span className={styles.progressText}>
                {`已下载 ${formatBytes(font.progress.downloadedBytes)} / ${formatBytes(font.progress.totalBytes)}（${font.progress.downloadedAssets}/${font.progress.totalAssets}）`}
              </span>
            </div>
          ) : null}

          {font.error ? (
            <p className={styles.error} role="alert">
              {font.error}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function fontOptionDescription({
  id,
  selected,
  downloading,
  cached,
  progress,
}: {
  id: AppFontFamily;
  selected: boolean;
  downloading: boolean;
  cached: boolean;
  progress: FontDownloadProgress;
}): string {
  if (id === "system") {
    return selected ? "当前使用应用默认字体栈" : "使用应用默认字体栈";
  }
  if (downloading) {
    return `下载中 ${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }
  if (selected) {
    return "已启用";
  }
  if (cached) {
    return "已下载到本地，点击启用";
  }
  return "点击下载到本地后使用";
}

function fontStatusText(family: AppFontFamily, status: string): string {
  if (status === "downloading") {
    return "正在下载字体";
  }
  if (status === "error") {
    return "字体下载失败";
  }
  return fontStatusLabels[family] ?? "使用系统默认";
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
