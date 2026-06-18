import { ChevronDown, Circle } from "lucide-react";

import type { ModelLoadState } from "./useRuntimeModelSelection";
import styles from "./RuntimeModelSelector.module.css";

export interface RuntimeModelSelectorProps {
  model: string;
  modelOptions: string[];
  modelLoadState: ModelLoadState;
  modelError: string | null;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onOpenModelSettings?: () => void;
}

export function RuntimeModelSelector({
  model,
  modelOptions,
  modelLoadState,
  modelError,
  disabled = false,
  onModelChange,
  onOpenModelSettings,
}: RuntimeModelSelectorProps) {
  const hasModels = modelOptions.length > 0;
  const modelHint = getModelHint(model, modelOptions, modelLoadState, modelError);
  const showSettingsAction = Boolean(onOpenModelSettings) && (modelLoadState === "error" || (!model && !modelOptions.length));

  return (
    <div className={styles.modelCluster} aria-label="运行模型">
      <label className={styles.modelPill} title={modelHint ?? "选择模型"}>
        <Circle size={13} strokeWidth={2.1} className={styles.modelDot} aria-hidden="true" />
        <select
          className={styles.select}
          aria-label="选择模型"
          value={hasModels ? model : ""}
          disabled={disabled || !hasModels}
          onChange={(event) => onModelChange(event.target.value)}
        >
          {hasModels ? null : <option value="">暂无模型</option>}
          {modelOptions.map((modelId) => (
            <option key={modelId} value={modelId}>
              {compactModelName(modelId)}
            </option>
          ))}
        </select>
        <ChevronDown size={16} strokeWidth={1.9} aria-hidden="true" />
      </label>

      {showSettingsAction ? (
        <button className={styles.settingsButton} type="button" disabled={disabled} onClick={onOpenModelSettings}>
          打开模型设置
        </button>
      ) : null}
    </div>
  );
}

function getModelHint(
  model: string,
  modelOptions: string[],
  modelLoadState: ModelLoadState,
  modelError: string | null,
): string | null {
  if (modelLoadState === "loading") {
    return "正在读取模型列表";
  }
  if (modelError) {
    return modelError;
  }
  if (!modelOptions.length) {
    return model ? "当前使用已保存模型；刷新模型列表后可切换" : "暂无可用模型，请先到设置中刷新模型列表";
  }
  if (model && !modelOptions.includes(model)) {
    return "当前模型不在已刷新列表中，请到设置中确认";
  }
  return null;
}

function compactModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.length <= 18) {
    return trimmed;
  }
  return `${trimmed.slice(0, 15)}...`;
}
