import { DatabaseBackup, Files, MessagesSquare, Power } from "lucide-react";
import { useEffect, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type { CloseWindowBehavior, ConversationSendDefaultMode, GeneralSettings } from "@/types/protocol";
import { SettingsSelect } from "@/renderer/pages/settings/components";
import { AnnualUsageOverview } from "@/renderer/pages/settings/usage/AnnualUsageOverview";
import { closeWindowBehaviorStore } from "@/runtime/closeWindowBehaviorStore";
import { isCloseWindowBehavior } from "@/runtime/windowLifecycle";

import styles from "./GeneralSettingsPage.module.css";

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

const sendDefaultModeOptions: Array<{ value: ConversationSendDefaultMode; label: string; description: string }> = [
  {
    value: "steer",
    label: "引导当前回复",
    description: "Agent 回复中发送会作为运行中引导；Ctrl+Enter 加入等待队列",
  },
  {
    value: "queue",
    label: "加入等待队列",
    description: "Agent 回复中发送会排队等待；Ctrl+Enter 改为引导当前回复",
  },
];

const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  close_window_behavior: null,
  conversation_send_default_mode: "steer",
  file_history_enabled: true,
  file_history_max_storage_bytes: 1_073_741_824,
  file_history_max_versions_per_file: 1_000,
  file_history_max_rewind_points: 100,
  file_history_retention_days: 30,
};

const fileHistoryEnabledOptions = [
  { value: "enabled", label: "已开启", description: "受控文件修改会记录可回溯版本" },
  { value: "disabled", label: "已关闭", description: "受控代码修改会明确报错，不会静默失去历史" },
] as const;

export interface GeneralSettingsPageProps {
  runtime?: RuntimeBridge;
}

export function GeneralSettingsPage({ runtime = runtimeBridge }: GeneralSettingsPageProps) {
  const [general, setGeneral] = useState<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  const [generalLoading, setGeneralLoading] = useState(true);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

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
        const nextGeneral = { ...DEFAULT_GENERAL_SETTINGS, ...(settings.general ?? {}) };
        setGeneral(nextGeneral);
        syncCloseBehaviorSnapshot(nextGeneral.close_window_behavior);
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
    if (generalSaving || general.close_window_behavior === behavior) {
      return;
    }
    const previousGeneral = general;
    const nextGeneral = { ...general, close_window_behavior: behavior };
    setGeneral(nextGeneral);
    setGeneralSaving(true);
    setGeneralError(null);
    void runtime.settings
      .saveGeneralSettings(nextGeneral)
      .then((settings) => {
        const savedGeneral = { ...DEFAULT_GENERAL_SETTINGS, ...(settings.general ?? nextGeneral) };
        setGeneral(savedGeneral);
        syncCloseBehaviorSnapshot(savedGeneral.close_window_behavior);
      })
      .catch((reason) => {
        setGeneral(previousGeneral);
        setGeneralError(errorMessage(reason));
      })
      .finally(() => {
        setGeneralSaving(false);
      });
  };

  const chooseSendDefaultMode = (mode: ConversationSendDefaultMode) => {
    if (generalSaving || general.conversation_send_default_mode === mode) {
      return;
    }
    const previousGeneral = general;
    const nextGeneral = { ...general, conversation_send_default_mode: mode };
    setGeneral(nextGeneral);
    setGeneralSaving(true);
    setGeneralError(null);
    void runtime.settings
      .saveGeneralSettings(nextGeneral)
      .then((settings) => {
        const savedGeneral = { ...DEFAULT_GENERAL_SETTINGS, ...(settings.general ?? nextGeneral) };
        setGeneral(savedGeneral);
        syncCloseBehaviorSnapshot(savedGeneral.close_window_behavior);
      })
      .catch((reason) => {
        setGeneral(previousGeneral);
        setGeneralError(errorMessage(reason));
      })
      .finally(() => {
        setGeneralSaving(false);
      });
  };

  const saveFileHistorySettings = (patch: Partial<GeneralSettings>) => {
    if (generalSaving) {
      return;
    }
    const previousGeneral = general;
    const nextGeneral = { ...general, ...patch };
    setGeneral(nextGeneral);
    setGeneralSaving(true);
    setGeneralError(null);
    void runtime.settings
      .saveGeneralSettings(nextGeneral)
      .then((settings) => {
        setGeneral({ ...DEFAULT_GENERAL_SETTINGS, ...(settings.general ?? nextGeneral) });
      })
      .catch((reason) => {
        setGeneral(previousGeneral);
        setGeneralError(errorMessage(reason));
      })
      .finally(() => setGeneralSaving(false));
  };

  return (
    <main className={styles.page} data-settings-page data-testid="general-settings-page">
      <header className={styles.header} data-settings-header>
        <div>
          <h1>常规</h1>
          <p>管理本地应用偏好</p>
        </div>
      </header>

      <AnnualUsageOverview runtime={runtime} />

      <section className={styles.section} data-settings-group aria-labelledby="behavior-settings-title">
        <h2 className={styles.groupTitle} data-settings-group-title id="behavior-settings-title">应用行为</h2>
        <div className={styles.settingsPanel} data-settings-panel>
          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true">
                <Power size={17} />
              </span>
              <div className={styles.settingTextBlock}>
                <h3>关闭窗口后行为</h3>
                <p>{closeBehaviorSummary(general.close_window_behavior)}</p>
              </div>
            </header>

            <SettingsSelect
              ariaLabel="关闭窗口后行为"
              disabled={generalLoading || generalSaving}
              onChange={chooseCloseBehavior}
              options={closeBehaviorOptions}
              placeholder="选择默认策略"
              value={general.close_window_behavior}
            />
          </div>

          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true">
                <MessagesSquare size={17} />
              </span>
              <div className={styles.settingTextBlock}>
                <h3>对话中发送消息</h3>
                <p>{sendDefaultModeSummary(general.conversation_send_default_mode ?? "steer")}</p>
              </div>
            </header>

            <SettingsSelect
              ariaLabel="对话中发送消息默认行为"
              disabled={generalLoading || generalSaving}
              onChange={chooseSendDefaultMode}
              options={sendDefaultModeOptions}
              placeholder="选择默认行为"
              value={general.conversation_send_default_mode ?? "steer"}
            />
          </div>

          {generalError ? (
            <p className={styles.error} data-settings-error role="alert">
              {generalError}
            </p>
          ) : null}
        </div>
      </section>

      <section className={styles.section} data-settings-group aria-labelledby="file-history-settings-title">
        <h2 className={styles.groupTitle} data-settings-group-title id="file-history-settings-title">文件回溯</h2>
        <div className={styles.settingsPanel} data-settings-panel>
          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true"><DatabaseBackup size={17} /></span>
              <div className={styles.settingTextBlock}>
                <h3>文件历史</h3>
                <p>关闭后不会静默继续代码修改；重新开启不会删除已有安全快照。</p>
              </div>
            </header>
            <SettingsSelect
              ariaLabel="文件历史开关"
              disabled={generalLoading || generalSaving}
              onChange={(value) => saveFileHistorySettings({ file_history_enabled: value === "enabled" })}
              options={[...fileHistoryEnabledOptions]}
              value={general.file_history_enabled === false ? "disabled" : "enabled"}
            />
          </div>

          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true"><Files size={17} /></span>
              <div className={styles.settingTextBlock}>
                <h3>存储容量上限</h3>
                <p>达到上限时明确拒绝新增备份，不会静默丢失恢复能力。</p>
              </div>
            </header>
            <label className={styles.numberControl}>
              <input
                aria-label="文件历史容量上限 MB"
                type="number"
                min={1}
                disabled={generalLoading || generalSaving}
                defaultValue={Math.round((general.file_history_max_storage_bytes ?? 1_073_741_824) / 1_048_576)}
                key={general.file_history_max_storage_bytes}
                onBlur={(event) => {
                  const megabytes = Math.max(1, Number(event.currentTarget.value) || 1);
                  saveFileHistorySettings({ file_history_max_storage_bytes: Math.round(megabytes * 1_048_576) });
                }}
              />
              <span>MB</span>
            </label>
          </div>

          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true"><Files size={17} /></span>
              <div className={styles.settingTextBlock}>
                <h3>单文件版本上限</h3>
                <p>保护本地磁盘，同时保留 operation 和 active cursor 依赖的版本。</p>
              </div>
            </header>
            <label className={styles.numberControl}>
              <input
                aria-label="单文件历史版本上限"
                type="number"
                min={1}
                disabled={generalLoading || generalSaving}
                defaultValue={general.file_history_max_versions_per_file ?? 1_000}
                key={general.file_history_max_versions_per_file}
                onBlur={(event) => {
                  const versions = Math.max(1, Math.round(Number(event.currentTarget.value) || 1));
                  saveFileHistorySettings({ file_history_max_versions_per_file: versions });
                }}
              />
              <span>版本</span>
            </label>
          </div>

          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true"><Files size={17} /></span>
              <div className={styles.settingTextBlock}>
                <h3>可回溯点上限</h3>
                <p>每个会话最多保留 100 个可选择的输入前文件状态。</p>
              </div>
            </header>
            <label className={styles.numberControl}>
              <input
                aria-label="文件历史可回溯点上限"
                type="number"
                min={1}
                max={100}
                disabled={generalLoading || generalSaving}
                defaultValue={general.file_history_max_rewind_points ?? 100}
                key={general.file_history_max_rewind_points}
                onBlur={(event) => {
                  const points = Math.min(100, Math.max(1, Math.round(Number(event.currentTarget.value) || 1)));
                  saveFileHistorySettings({ file_history_max_rewind_points: points });
                }}
              />
              <span>个</span>
            </label>
          </div>

          <div className={styles.settingRow} data-settings-row>
            <header className={styles.sectionHeader} data-settings-row-text>
              <span className={styles.settingIcon} aria-hidden="true"><DatabaseBackup size={17} /></span>
              <div className={styles.settingTextBlock}>
                <h3>历史保留时间</h3>
                <p>过期且未被活动游标或 operation 使用的版本会在清理阶段删除。</p>
              </div>
            </header>
            <label className={styles.numberControl}>
              <input
                aria-label="文件历史保留天数"
                type="number"
                min={1}
                disabled={generalLoading || generalSaving}
                defaultValue={general.file_history_retention_days ?? 30}
                key={general.file_history_retention_days}
                onBlur={(event) => {
                  const days = Math.max(1, Math.round(Number(event.currentTarget.value) || 1));
                  saveFileHistorySettings({ file_history_retention_days: days });
                }}
              />
              <span>天</span>
            </label>
          </div>
        </div>
      </section>

    </main>
  );
}

function syncCloseBehaviorSnapshot(behavior: CloseWindowBehavior | null): void {
  if (isCloseWindowBehavior(behavior)) {
    closeWindowBehaviorStore.write(behavior);
    return;
  }
  closeWindowBehaviorStore.clear();
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

function sendDefaultModeSummary(mode: ConversationSendDefaultMode): string {
  if (mode === "queue") {
    return "回复中发送时默认加入等待队列，Ctrl+Enter 临时引导当前回复";
  }
  return "回复中发送时默认引导当前回复，Ctrl+Enter 临时加入等待队列";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return "设置保存失败";
}
