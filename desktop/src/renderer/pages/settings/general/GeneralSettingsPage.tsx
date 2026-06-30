import { Check, ChevronDown, Download, Laptop, Power, Type } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { useFontPreference, type AppFontFamily, type FontDownloadProgress } from "@/renderer/providers/FontProvider";
import type { CloseWindowBehavior, GeneralSettings } from "@/types/protocol";

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

const closeBehaviorOptions: Array<{ value: CloseWindowBehavior; label: string; description: string }> = [
  {
    value: "exit",
    label: "退出程序",
    description: "关闭窗口时结束 Keydex 和本地服务",
  },
  {
    value: "minimize_to_tray",
    label: "最小化到托盘",
    description: "关闭窗口后保留后台运行，可从右下角托盘恢复",
  },
];

const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  close_window_behavior: null,
};

export interface GeneralSettingsPageProps {
  runtime?: RuntimeBridge;
}

export function GeneralSettingsPage({ runtime = runtimeBridge }: GeneralSettingsPageProps) {
  const font = useFontPreference();
  const [general, setGeneral] = useState<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  const [generalLoading, setGeneralLoading] = useState(true);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [closeBehaviorMenuOpen, setCloseBehaviorMenuOpen] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const downloading = font.status === "downloading";
  const showProgress = downloading && font.downloadingFamily !== null;
  const currentCloseBehaviorOption =
    closeBehaviorOptions.find((option) => option.value === general.close_window_behavior) ?? null;

  useEffect(() => {
    let active = true;
    setGeneralLoading(true);
    setGeneralError(null);
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (!active) {
          return;
        }
        setGeneral(settings.general ?? DEFAULT_GENERAL_SETTINGS);
      })
      .catch((reason) => {
        if (active) {
          setGeneralError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setGeneralLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [runtime]);

  const chooseCloseBehavior = (behavior: CloseWindowBehavior) => {
    setCloseBehaviorMenuOpen(false);
    if (generalSaving || general.close_window_behavior === behavior) {
      return;
    }
    const previousGeneral = general;
    const nextGeneral = { close_window_behavior: behavior };
    setGeneral(nextGeneral);
    setGeneralSaving(true);
    setGeneralError(null);
    void runtime.settings
      .saveGeneralSettings(nextGeneral)
      .then((settings) => {
        setGeneral(settings.general ?? nextGeneral);
      })
      .catch((reason) => {
        setGeneral(previousGeneral);
        setGeneralError(errorMessage(reason));
      })
      .finally(() => {
        setGeneralSaving(false);
      });
  };

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
          <h1>常规</h1>
          <p>管理本地应用偏好</p>
        </div>
      </header>

      <section
        className={styles.section}
        data-layer={closeBehaviorMenuOpen ? "raised" : undefined}
        aria-labelledby="behavior-settings-title"
      >
        <h2 className={styles.groupTitle} id="behavior-settings-title">应用行为</h2>
        <div className={styles.settingsPanel}>
          <div className={styles.settingRow}>
            <header className={styles.sectionHeader}>
              <span className={styles.settingIcon} aria-hidden="true">
                <Power size={17} />
              </span>
              <div>
                <h3>关闭窗口后行为</h3>
                <p>{closeBehaviorSummary(general.close_window_behavior)}</p>
              </div>
            </header>

            <div
              className={styles.policyMenu}
              data-open={closeBehaviorMenuOpen ? "true" : "false"}
              onBlur={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  setCloseBehaviorMenuOpen(false);
                }
              }}
            >
              <button
                aria-expanded={closeBehaviorMenuOpen}
                aria-haspopup="listbox"
                aria-label={`关闭窗口后行为：${currentCloseBehaviorOption?.label ?? "选择默认策略"}`}
                className={styles.policyTrigger}
                disabled={generalLoading || generalSaving}
                type="button"
                onClick={() => setCloseBehaviorMenuOpen((open) => !open)}
              >
                <span className={styles.policyTriggerText}>
                  <strong>{currentCloseBehaviorOption?.label ?? "选择默认策略"}</strong>
                </span>
                <ChevronDown aria-hidden="true" data-open={closeBehaviorMenuOpen ? "true" : "false"} size={16} />
              </button>
              {closeBehaviorMenuOpen ? (
                <div className={styles.policyDropdown} role="listbox" aria-label="关闭窗口后行为选项">
                  {closeBehaviorOptions.map((option) => {
                    const active = option.value === general.close_window_behavior;
                    return (
                      <button
                        aria-selected={active}
                        className={styles.policyOption}
                        data-active={active ? "true" : "false"}
                        key={option.value}
                        role="option"
                        type="button"
                        onClick={() => chooseCloseBehavior(option.value)}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                        {active ? <Check aria-hidden="true" size={15} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          {generalError ? (
            <p className={styles.error} role="alert">
              {generalError}
            </p>
          ) : null}
        </div>
      </section>

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

function closeBehaviorSummary(behavior: CloseWindowBehavior | null): string {
  if (behavior === "exit") {
    return "关闭窗口时退出程序";
  }
  if (behavior === "minimize_to_tray") {
    return "关闭窗口时最小化到系统托盘";
  }
  return "首次关闭窗口时会询问默认策略";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return "设置保存失败";
}
