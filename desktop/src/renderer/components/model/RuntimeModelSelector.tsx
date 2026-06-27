import { Check, ChevronDown, Search } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

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

const MENU_EXIT_ANIMATION_MS = 120;

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
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const menuCloseTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeModelIndex, setActiveModelIndex] = useState(-1);
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

  const clearMenuCloseTimer = () => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
  };

  const openMenu = () => {
    clearMenuCloseTimer();
    setMenuClosing(false);
    setQuery("");
    setOpen(true);
  };

  const closeMenu = () => {
    if (!open && !menuClosing) {
      return;
    }
    clearMenuCloseTimer();
    setOpen(false);
    if (prefersReducedMotion()) {
      setMenuClosing(false);
      return;
    }
    setMenuClosing(true);
    menuCloseTimerRef.current = window.setTimeout(() => {
      setMenuClosing(false);
      menuCloseTimerRef.current = null;
    }, MENU_EXIT_ANIMATION_MS);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
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
      closeMenu();
      setQuery("");
      setActiveModelIndex(-1);
    }
  }, [disabledButton]);

  useEffect(() => () => clearMenuCloseTimer(), []);

  useEffect(() => {
    if (!open) {
      setActiveModelIndex(-1);
      return;
    }
    setActiveModelIndex((current) => {
      if (!filteredModels.length) {
        return -1;
      }
      if (current >= 0 && current < filteredModels.length) {
        return current;
      }
      const selectedIndex = filteredModels.indexOf(selectedModel);
      return selectedIndex >= 0 ? selectedIndex : 0;
    });
  }, [filteredModels, open, selectedModel]);

  useEffect(() => {
    if (!open || activeModelIndex < 0) {
      return;
    }
    const activeModel = filteredModels[activeModelIndex];
    optionRefs.current.get(activeModel)?.scrollIntoView?.({ block: "nearest" });
  }, [activeModelIndex, filteredModels, open]);

  const toggleMenu = () => {
    if (open) {
      closeMenu();
      return;
    }
    openMenu();
  };

  const chooseModel = (modelId: string) => {
    onModelChange(modelId);
    setQuery("");
    setActiveModelIndex(-1);
    closeMenu();
  };

  const moveActiveModel = (direction: 1 | -1) => {
    if (!filteredModels.length) {
      return;
    }
    setActiveModelIndex((current) => {
      const base = current >= 0 ? current : direction > 0 ? -1 : 0;
      return (base + direction + filteredModels.length) % filteredModels.length;
    });
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveModel(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveModel(-1);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      const activeModel = activeModelIndex >= 0 ? filteredModels[activeModelIndex] : null;
      if (activeModel) {
        event.preventDefault();
        chooseModel(activeModel);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  const activeOptionId =
    open && activeModelIndex >= 0 && filteredModels[activeModelIndex]
      ? `${menuId}-option-${activeModelIndex}`
      : undefined;
  const menuVisible = open || menuClosing;

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

        {menuVisible ? (
          <div
            className={styles.menu}
            data-placement={placement}
            data-state={menuClosing ? "closing" : "open"}
            aria-hidden={menuClosing ? "true" : undefined}
          >
            <div className={styles.menuLabel}>模型</div>
            <label className={styles.searchBox}>
              <Search size={13} strokeWidth={1.9} aria-hidden="true" />
              <input
                aria-label="筛选模型"
                aria-activedescendant={activeOptionId}
                aria-controls={menuId}
                autoFocus
                placeholder="搜索模型"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </label>
            <div className={styles.optionList} id={menuId} role="listbox" aria-label="模型">
              {filteredModels.length ? (
                filteredModels.map((modelId, index) => {
                  const selected = modelId === selectedModel;
                  const active = index === activeModelIndex;
                  return (
                    <button
                      className={styles.option}
                      key={modelId}
                      id={`${menuId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected ? "true" : "false"}
                      data-active={active ? "true" : undefined}
                      ref={(element) => {
                        if (element) {
                          optionRefs.current.set(modelId, element);
                        } else {
                          optionRefs.current.delete(modelId);
                        }
                      }}
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

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
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
