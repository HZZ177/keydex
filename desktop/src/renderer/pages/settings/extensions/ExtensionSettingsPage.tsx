import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type {
  A2UIRuntimeSettings,
  AgentRuntimeSettings,
  AutoTitleRuntimeSettings,
  ContextCompressionRuntimeSettings,
  DuplicateToolCallGuardRuntimeSettings,
  ModelDefaultsResponse,
} from "@/types/protocol";

import styles from "./ExtensionSettingsPage.module.css";

export interface ExtensionSettingsPageProps {
  runtime?: RuntimeBridge;
  onOpenModelConfig?: () => void;
}

type ExtensionDrafts = {
  autoTitle: AutoTitleRuntimeSettings;
  duplicateGuard: DuplicateToolCallGuardRuntimeSettings;
  compression: ContextCompressionRuntimeSettings;
  a2ui: A2UIRuntimeSettings;
};

const MIN_COMPRESSION_TRIGGER_FRACTION = 0.1;
const MAX_COMPRESSION_TRIGGER_FRACTION = 0.95;
const COMPRESSION_TRIGGER_STEP = 0.01;

export function ExtensionSettingsPage({
  runtime = runtimeBridge,
  onOpenModelConfig,
}: ExtensionSettingsPageProps) {
  const notifications = useNotifications();
  const [drafts, setDrafts] = useState<ExtensionDrafts | null>(null);
  const [defaults, setDefaults] = useState<ModelDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([runtime.settings.getExtensionSettings(), runtime.settings.getModelDefaults()])
      .then(([nextSettings, nextDefaults]) => {
        if (!active) {
          return;
        }
        setDrafts(draftsFromSettings(nextSettings));
        setDefaults(nextDefaults);
      })
      .catch((reason: unknown) => {
        if (active) {
          notifications.error(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [notifications, runtime]);

  const fastConfigured = Boolean(defaults?.defaults.fast.configured);
  const defaultChatConfigured = Boolean(defaults?.defaults.default_chat.configured);
  const titleDraft = drafts?.autoTitle ?? null;
  const duplicateGuardDraft = drafts?.duplicateGuard ?? null;
  const compressionDraft = drafts?.compression ?? null;
  const a2uiDraft = drafts?.a2ui ?? null;
  const titleDependencyMissing = Boolean(titleDraft?.enabled && !fastConfigured);
  const compressionDependencyMissing = Boolean(compressionDraft?.enabled && !defaultChatConfigured);
  const titleLengthInvalid = titleDraft ? titleDraft.max_title_length < 4 || titleDraft.max_title_length > 50 : false;
  const duplicateGuardInvalid = duplicateGuardDraft
    ? duplicateGuardDraft.max_repeats < 1 || duplicateGuardDraft.max_repeats > 20
    : false;
  const compressionTriggerInvalid = compressionDraft
    ? compressionDraft.trigger_fraction < MIN_COMPRESSION_TRIGGER_FRACTION ||
      compressionDraft.trigger_fraction > MAX_COMPRESSION_TRIGGER_FRACTION
    : false;
  const compressionWindowInvalid = compressionDraft
    ? compressionDraft.context_window_tokens < 1000 || compressionDraft.context_window_tokens > 2_000_000
    : false;
  const canSave =
    Boolean(drafts) &&
    !saving &&
    !titleDependencyMissing &&
    !compressionDependencyMissing &&
    !titleLengthInvalid &&
    !duplicateGuardInvalid &&
    !compressionTriggerInvalid &&
    !compressionWindowInvalid;

  const updateDrafts = (updater: (current: ExtensionDrafts) => ExtensionDrafts) => {
    setDrafts((current) => (current ? updater(current) : current));
  };

  const updateTitleDraft = (patch: Partial<AutoTitleRuntimeSettings>) => {
    updateDrafts((current) => ({ ...current, autoTitle: { ...current.autoTitle, ...patch } }));
  };

  const updateDuplicateGuardDraft = (patch: Partial<DuplicateToolCallGuardRuntimeSettings>) => {
    updateDrafts((current) => ({
      ...current,
      duplicateGuard: { ...current.duplicateGuard, ...patch },
    }));
  };

  const updateCompressionDraft = (patch: Partial<ContextCompressionRuntimeSettings>) => {
    updateDrafts((current) => ({ ...current, compression: { ...current.compression, ...patch } }));
  };

  const updateA2UIDraft = (patch: Partial<A2UIRuntimeSettings>) => {
    updateDrafts((current) => ({ ...current, a2ui: { ...current.a2ui, ...patch } }));
  };

  const saveExtensionPage = async () => {
    if (!drafts || !canSave) {
      return;
    }
    setSaving(true);
    try {
      const nextSettings = await runtime.settings.saveExtensionSettings(settingsFromDrafts(drafts));
      setDrafts(draftsFromSettings(nextSettings));
      notifications.success("扩展功能配置已保存");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className={styles.page} data-settings-page data-testid="extension-settings-page">
      <header className={styles.header} data-settings-header>
        <div>
          <h1>扩展功能</h1>
          <p>配置基础增强能力</p>
        </div>
      </header>

      {loading ? <div className={styles.muted} data-settings-muted>正在读取扩展功能配置</div> : null}

      {!loading && drafts && titleDraft && duplicateGuardDraft && compressionDraft && a2uiDraft ? (
        <section className={styles.settingsGroup} data-settings-group aria-labelledby="extension-feature-title">
          <div className={styles.groupHeader} data-settings-group-header>
            <h2 id="extension-feature-title">功能模块</h2>
          </div>

          <div className={styles.settingsPanel} data-settings-panel>
            <FeatureSettingRow
              title="标题生成"
              description="自动为新会话生成标题"
              controls={
                <InlineNumberControl label="期望标题最大长度">
                  <NumberInput
                    label="期望标题最大长度"
                    max={50}
                    min={4}
                    onChange={(max_title_length) => updateTitleDraft({ max_title_length })}
                    value={titleDraft.max_title_length}
                  />
                </InlineNumberControl>
              }
              switchControl={
                <ToggleSwitch
                  checked={titleDraft.enabled}
                  label="启用标题生成"
                  onChange={(enabled) => updateTitleDraft({ enabled })}
                />
              }
            />
            {titleDependencyMissing ? (
              <DependencyWarning message="快速模型未配置，标题生成不可用" onOpenModelConfig={onOpenModelConfig} />
            ) : null}
            {titleLengthInvalid ? (
              <div className={styles.fieldError}>期望标题最大长度必须在 4 到 50 之间</div>
            ) : null}
          </div>

          <div className={styles.settingsPanel} data-settings-panel>
            <FeatureSettingRow
              title="重复工具调用保护"
              description="连续相同工具和参数超过阈值后终止本轮对话"
              controls={
                <InlineNumberControl label="连续重复阈值">
                  <NumberInput
                    label="连续重复阈值"
                    max={20}
                    min={1}
                    onChange={(max_repeats) => updateDuplicateGuardDraft({ max_repeats })}
                    value={duplicateGuardDraft.max_repeats}
                  />
                </InlineNumberControl>
              }
              switchControl={
                <ToggleSwitch
                  checked={duplicateGuardDraft.enabled}
                  label="启用重复保护"
                  onChange={(enabled) => updateDuplicateGuardDraft({ enabled })}
                />
              }
            />
            {duplicateGuardInvalid ? (
              <div className={styles.fieldError}>连续重复阈值必须在 1 到 20 之间</div>
            ) : null}
          </div>

          <div className={styles.settingsPanel} data-settings-panel>
            <SettingRow
              title="上下文压缩"
              description="在上下文接近窗口上限时压缩历史内容"
              control={
                <ToggleSwitch
                  checked={compressionDraft.enabled}
                  label="启用上下文压缩"
                  onChange={(enabled) => updateCompressionDraft({ enabled })}
                />
              }
            />
            {compressionDependencyMissing ? (
              <DependencyWarning message="默认对话模型未配置，上下文压缩不可用" onOpenModelConfig={onOpenModelConfig} />
            ) : null}
            <CompressionConfigurator
              contextWindowTokens={compressionDraft.context_window_tokens}
              onContextWindowChange={(context_window_tokens) => updateCompressionDraft({ context_window_tokens })}
              onTriggerFractionChange={(trigger_fraction) => updateCompressionDraft({ trigger_fraction })}
              triggerFraction={compressionDraft.trigger_fraction}
            />
            {compressionTriggerInvalid ? (
              <div className={styles.fieldError}>触发阈值必须在 10% 到 95% 之间</div>
            ) : null}
            {compressionWindowInvalid ? (
              <div className={styles.fieldError}>上下文窗口必须在 1000 到 2000000 token 之间</div>
            ) : null}
          </div>

          <div className={styles.settingsPanel} data-settings-panel>
            <SettingRow
              title="A2UI 交互组件"
              description="允许智能体在对话中生成确认、选择、表单、图表四类内置 A2UI 卡片；关闭后只影响后续新对话能力"
              control={
                <ToggleSwitch
                  checked={a2uiDraft.enabled}
                  label="启用 A2UI"
                  onChange={(enabled) => updateA2UIDraft({ enabled })}
                />
              }
            />
            <SettingRow
              title="调试入口"
              description="在 A2UI 组件右上角显示调试感叹号入口，用于查看流式缓冲、事件块和渲染状态"
              control={
                <ToggleSwitch
                  checked={a2uiDraft.debug_info_enabled}
                  label="显示 A2UI 调试入口"
                  onChange={(debug_info_enabled) => updateA2UIDraft({ debug_info_enabled })}
                />
              }
            />
            <div className={styles.a2uiSummary} aria-label="当前支持的 A2UI 类型">
              <span>确认</span>
              <span>选择</span>
              <span>表单</span>
              <span>图表</span>
            </div>
          </div>

          <div className={styles.actions}>
            <button data-settings-primary disabled={!canSave} onClick={() => void saveExtensionPage()} type="button">
              {saving ? "保存中" : "保存"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function FeatureSettingRow({
  controls,
  description,
  switchControl,
  title,
}: {
  controls: ReactNode;
  description: string;
  switchControl: ReactNode;
  title: string;
}) {
  return (
    <div className={styles.featureRow} data-settings-row>
      <div className={styles.settingText} data-settings-row-text>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className={styles.featureControls}>
        {controls}
        {switchControl}
      </div>
    </div>
  );
}

function SettingRow({
  control,
  description,
  title,
}: {
  control: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className={styles.settingRow} data-settings-row>
      <div className={styles.settingText} data-settings-row-text>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className={styles.settingControl}>{control}</div>
    </div>
  );
}

function InlineNumberControl({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className={styles.inlineNumberControl}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function ToggleSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={styles.toggle}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className={styles.toggleTrack} data-checked={checked ? "true" : "false"}>
        <span className={styles.toggleThumb} />
      </span>
    </button>
  );
}

function CompressionConfigurator({
  contextWindowTokens,
  onContextWindowChange,
  onTriggerFractionChange,
  triggerFraction,
}: {
  contextWindowTokens: number;
  onContextWindowChange: (value: number) => void;
  onTriggerFractionChange: (value: number) => void;
  triggerFraction: number;
}) {
  const triggerTokenCount = Math.max(0, Math.round(contextWindowTokens * triggerFraction));

  return (
    <div className={styles.compressionConfigurator}>
      <div className={styles.contextWindowRow}>
        <div className={styles.contextWindowText}>
          <h3>模型上下文窗口</h3>
          <p>用于估算压缩触发点，按当前模型的上下文窗口填写</p>
        </div>
        <NumberInput
          label="模型上下文窗口"
          max={2000000}
          min={1000}
          onChange={onContextWindowChange}
          step={1000}
          value={contextWindowTokens}
        />
      </div>

      <div className={styles.thresholdControl}>
        <div className={styles.thresholdHeader}>
          <div>
            <h3>压缩触发阈值</h3>
            <p>达到窗口占用比例后压缩历史上下文</p>
          </div>
          <strong>{formatPercent(triggerFraction)}</strong>
        </div>
        <CompressionThresholdSlider
          ariaValueText={`${formatPercent(triggerFraction)}，约 ${formatTokenCount(
            triggerTokenCount,
          )} token 时自动压缩上下文`}
          label="触发阈值"
          max={MAX_COMPRESSION_TRIGGER_FRACTION}
          min={MIN_COMPRESSION_TRIGGER_FRACTION}
          onChange={onTriggerFractionChange}
          step={COMPRESSION_TRIGGER_STEP}
          value={triggerFraction}
        />
      <div className={styles.thresholdMeta}>
        <span>
          约 {formatTokenCount(triggerTokenCount)} token 时自动压缩上下文
        </span>
      </div>
      </div>
    </div>
  );
}

function CompressionThresholdSlider({
  ariaValueText,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  ariaValueText: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartXRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const sliderValue = clampSliderValue(value, min, max);
  const sliderPercent = valueToPercent(sliderValue, min, max);
  const sliderStyle = { "--threshold-slider-percent": `${sliderPercent}%` } as CSSProperties;

  const updateFromClientX = (clientX: number) => {
    const bounds = sliderRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) {
      return;
    }
    const ratio = clampNumber((clientX - bounds.left) / bounds.width, 0, 1);
    onChange(snapSliderValue(min + ratio * (max - min), min, max, step));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    pointerIdRef.current = event.pointerId;
    pointerStartXRef.current = event.clientX;
    setDragging(false);
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }
    if (pointerStartXRef.current !== null && Math.abs(event.clientX - pointerStartXRef.current) > 2) {
      setDragging(true);
    }
    updateFromClientX(event.clientX);
  };

  const finishPointerInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }
    pointerIdRef.current = null;
    pointerStartXRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = clampSliderValue(value, min, max);
    const largeStep = step * 10;
    let nextValue: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nextValue = current - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        nextValue = current + step;
        break;
      case "PageDown":
        nextValue = current - largeStep;
        break;
      case "PageUp":
        nextValue = current + largeStep;
        break;
      case "Home":
        nextValue = min;
        break;
      case "End":
        nextValue = max;
        break;
      default:
        break;
    }
    if (nextValue === null) {
      return;
    }
    event.preventDefault();
    onChange(snapSliderValue(nextValue, min, max, step));
  };

  return (
    <div
      aria-label={label}
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={sliderValue}
      aria-valuetext={ariaValueText}
      className={styles.thresholdSlider}
      data-dragging={dragging ? "true" : "false"}
      onKeyDown={handleKeyDown}
      onPointerCancel={finishPointerInteraction}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerInteraction}
      ref={sliderRef}
      role="slider"
      style={sliderStyle}
      tabIndex={0}
    >
      <span aria-hidden="true" className={styles.sliderTrack}>
        <span className={styles.sliderRange} />
      </span>
      <span aria-hidden="true" className={styles.sliderThumb} />
    </div>
  );
}

function NumberInput({
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  return (
    <input
      aria-label={label}
      className={styles.numberInput}
      max={max}
      min={min}
      onChange={(event) => onChange(Number(event.target.value))}
      step={step}
      type="number"
      value={value}
    />
  );
}

function DependencyWarning({
  message,
  onOpenModelConfig,
}: {
  message: string;
  onOpenModelConfig?: () => void;
}) {
  return (
    <div className={styles.warning} role="alert">
      <span>{message}</span>
      {onOpenModelConfig ? (
        <button data-settings-secondary type="button" onClick={onOpenModelConfig}>
          配置模型
        </button>
      ) : null}
    </div>
  );
}

function draftsFromSettings(settings: AgentRuntimeSettings): ExtensionDrafts {
  return {
    autoTitle: { ...settings.auto_title, only_when_default_title: true },
    duplicateGuard: settings.duplicate_tool_call_guard,
    compression: settings.context_compression,
    a2ui: settings.a2ui,
  };
}

function settingsFromDrafts(drafts: ExtensionDrafts): AgentRuntimeSettings {
  return {
    auto_title: { ...drafts.autoTitle, only_when_default_title: true },
    duplicate_tool_call_guard: drafts.duplicateGuard,
    context_compression: drafts.compression,
    a2ui: drafts.a2ui,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampSliderValue(value: number, min: number, max: number): number {
  return clampNumber(value, min, max);
}

function snapSliderValue(value: number, min: number, max: number, step: number): number {
  const steppedValue = min + Math.round((value - min) / step) * step;
  return Number(clampSliderValue(steppedValue, min, max).toFixed(decimalPlaces(step)));
}

function valueToPercent(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0;
  }
  return clampNumber(((value - min) / (max - min)) * 100, 0, 100);
}

function decimalPlaces(value: number): number {
  const [, decimals = ""] = String(value).split(".");
  return decimals.length;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取扩展功能配置失败";
}
