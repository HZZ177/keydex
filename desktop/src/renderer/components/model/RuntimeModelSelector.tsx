import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { ModelLoadState } from "./useRuntimeModelSelection";
import styles from "./RuntimeModelSelector.module.css";

export interface RuntimeModelSelectorProps {
  model: string;
  modelOptions: string[];
  modelLoadState: ModelLoadState;
  modelError: string | null;
  disabled?: boolean;
  placement?: "top" | "bottom";
  onModelChange: (model: string) => void;
  onOpenModelSettings?: () => void;
}

export function RuntimeModelSelector({
  model,
  modelOptions,
  modelLoadState,
  modelError,
  disabled = false,
  placement = "bottom",
  onModelChange,
  onOpenModelSettings,
}: RuntimeModelSelectorProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hasModels = modelOptions.length > 0;
  const modelHint = getModelHint(model, modelOptions, modelLoadState, modelError);
  const showSettingsAction = Boolean(onOpenModelSettings) && (modelLoadState === "error" || (!model && !modelOptions.length));
  const selectedModel = hasModels ? model : "";
  const displayModel = useMemo(
    () => (selectedModel ? selectedModel : modelLoadState === "loading" ? "读取模型" : "暂无模型"),
    [modelLoadState, selectedModel],
  );
  const disabledButton = disabled || !hasModels;
  const filteredModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return modelOptions;
    }
    return modelOptions.filter((modelId) => modelId.toLowerCase().includes(keyword));
  }, [modelOptions, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabledButton) {
      setOpen(false);
      setQuery("");
    }
  }, [disabledButton]);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setOpen(true);
  };

  const chooseModel = (modelId: string) => {
    onModelChange(modelId);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={styles.modelCluster} ref={rootRef} aria-label="运行模型">
      <div className={styles.modelPicker}>
        <button
          className={styles.modelPill}
          type="button"
          aria-label="选择模型"
          aria-haspopup="listbox"
          aria-expanded={open ? "true" : "false"}
          aria-controls={open ? menuId : undefined}
          title={modelHint ?? "选择模型"}
          disabled={disabledButton}
          onClick={toggleMenu}
        >
          <span className={styles.modelName}>{displayModel}</span>
          <ChevronDown size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>

        {open ? (
          <div className={styles.menu} data-placement={placement}>
            <div className={styles.menuLabel}>模型</div>
            <label className={styles.searchBox}>
              <Search size={13} strokeWidth={1.9} aria-hidden="true" />
              <input
                aria-label="筛选模型"
                autoFocus
                placeholder="搜索模型"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className={styles.optionList} id={menuId} role="listbox" aria-label="模型">
              {filteredModels.length ? (
                filteredModels.map((modelId) => {
                  const selected = modelId === selectedModel;
                  return (
                    <button
                      className={styles.option}
                      key={modelId}
                      type="button"
                      role="option"
                      aria-selected={selected ? "true" : "false"}
                      onClick={() => chooseModel(modelId)}
                    >
                      <span>{modelId}</span>
                      {selected ? <Check size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
                    </button>
                  );
                })
              ) : (
                <div className={styles.empty}>没有匹配模型</div>
              )}
            </div>
          </div>
        ) : null}
      </div>

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
