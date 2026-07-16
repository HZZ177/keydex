import { Check, ChevronDown, Search } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { FloatingLayer } from "@/renderer/components/floating";

import styles from "./SearchableModelDropdown.module.css";

export interface SearchableModelDropdownValue {
  providerId: string;
  model: string;
}

export interface SearchableModelDropdownOption extends SearchableModelDropdownValue {
  providerName: string;
}

export interface SearchableModelDropdownProps {
  value: SearchableModelDropdownValue | null;
  options: SearchableModelDropdownOption[];
  onChange: (value: SearchableModelDropdownValue | null) => void;
  ariaLabel?: string;
  containerLabel?: string;
  clearable?: boolean;
  clearLabel?: string;
  disabled?: boolean;
  emptyActionLabel?: string;
  emptyActionSuffix?: string;
  emptyText?: string;
  menuLabel?: string;
  onEmptyAction?: () => void;
  placeholder?: string;
  placement?: "top" | "bottom";
  searchPlaceholder?: string;
  title?: string | null;
  variant?: "pill" | "field";
}

const MENU_EXIT_ANIMATION_MS = 120;

export function SearchableModelDropdown({
  ariaLabel = "选择模型",
  clearable = false,
  clearLabel = "不配置",
  containerLabel,
  disabled = false,
  emptyActionLabel,
  emptyActionSuffix,
  emptyText = "没有匹配模型",
  menuLabel = "模型",
  onEmptyAction,
  onChange,
  options,
  placeholder = "选择模型",
  placement = "bottom",
  searchPlaceholder = "搜索供应商或模型",
  title,
  value,
  variant = "field",
}: SearchableModelDropdownProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const menuCloseTimerRef = useRef<number | null>(null);
  const searchFocusFrameRef = useRef<number | null>(null);
  const searchFocusTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeChoiceIndex, setActiveChoiceIndex] = useState(-1);
  const selectedKey = value ? optionKey(value.providerId, value.model) : "";
  const selectedOption = selectedKey
    ? options.find((option) => optionKey(option.providerId, option.model) === selectedKey)
    : null;
  const displayLabel = selectedOption ? selectedOption.model : placeholder;
  const disabledButton = disabled;

  const filteredModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return options;
    }
    return options.filter((option) =>
      [option.providerName, option.providerId, option.model].some((item) => item.toLowerCase().includes(keyword)),
    );
  }, [options, query]);
  const clearChoiceOffset = clearable ? 1 : 0;
  const choiceCount = clearChoiceOffset + filteredModels.length;
  const rows = useMemo(() => buildRows(filteredModels, clearable), [clearable, filteredModels]);

  const clearMenuCloseTimer = () => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
  };

  const clearSearchFocusTimers = () => {
    if (searchFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(searchFocusFrameRef.current);
      searchFocusFrameRef.current = null;
    }
    if (searchFocusTimerRef.current !== null) {
      window.clearTimeout(searchFocusTimerRef.current);
      searchFocusTimerRef.current = null;
    }
  };

  const focusSearchInput = () => {
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const openMenu = () => {
    clearMenuCloseTimer();
    setMenuClosing(false);
    setQuery("");
    setOpen(true);
  };

  const moveFocusOutsideMenu = (restoreTriggerFocus: boolean) => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !menuRef.current?.contains(activeElement)) {
      return;
    }
    if (restoreTriggerFocus && !disabledButton) {
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    activeElement.blur();
  };

  const closeMenu = ({ restoreTriggerFocus = true } = {}) => {
    if (!open && !menuClosing) {
      return;
    }
    clearMenuCloseTimer();
    moveFocusOutsideMenu(restoreTriggerFocus);
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
      clearSearchFocusTimers();
      return;
    }
    clearSearchFocusTimers();
    focusSearchInput();
    searchFocusFrameRef.current = window.requestAnimationFrame(() => {
      searchFocusFrameRef.current = null;
      focusSearchInput();
    });
    searchFocusTimerRef.current = window.setTimeout(() => {
      searchFocusTimerRef.current = null;
      focusSearchInput();
    }, 0);
    return clearSearchFocusTimers;
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu({ restoreTriggerFocus: false });
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
      closeMenu({ restoreTriggerFocus: false });
      setQuery("");
      setActiveChoiceIndex(-1);
    }
  }, [disabledButton]);

  useEffect(
    () => () => {
      clearMenuCloseTimer();
      clearSearchFocusTimers();
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      setActiveChoiceIndex(-1);
      return;
    }
    setActiveChoiceIndex((current) => {
      if (!choiceCount) {
        return -1;
      }
      if (current >= 0 && current < choiceCount) {
        return current;
      }
      const selectedModelIndex = filteredModels.findIndex(
        (option) => optionKey(option.providerId, option.model) === selectedKey,
      );
      if (selectedModelIndex >= 0) {
        return clearChoiceOffset + selectedModelIndex;
      }
      return 0;
    });
  }, [choiceCount, clearChoiceOffset, filteredModels, open, selectedKey]);

  useEffect(() => {
    if (!open || activeChoiceIndex < 0) {
      return;
    }
    const activeId = choiceIdAt(activeChoiceIndex, filteredModels, clearable);
    if (activeId) {
      optionRefs.current.get(activeId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeChoiceIndex, clearable, filteredModels, open]);

  const toggleMenu = () => {
    if (open) {
      closeMenu();
      return;
    }
    openMenu();
  };

  const chooseModel = (option: SearchableModelDropdownOption) => {
    onChange({ providerId: option.providerId, model: option.model });
    setQuery("");
    setActiveChoiceIndex(-1);
    closeMenu();
  };

  const clearValue = () => {
    onChange(null);
    setQuery("");
    setActiveChoiceIndex(-1);
    closeMenu();
  };

  const chooseActive = () => {
    if (activeChoiceIndex < 0) {
      return;
    }
    if (clearable && activeChoiceIndex === 0) {
      clearValue();
      return;
    }
    const modelIndex = activeChoiceIndex - clearChoiceOffset;
    const activeModel = filteredModels[modelIndex];
    if (activeModel) {
      chooseModel(activeModel);
    }
  };

  const moveActiveChoice = (direction: 1 | -1) => {
    if (!choiceCount) {
      return;
    }
    setActiveChoiceIndex((current) => {
      const base = current >= 0 ? current : direction > 0 ? -1 : 0;
      return (base + direction + choiceCount) % choiceCount;
    });
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveChoice(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveChoice(-1);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      chooseActive();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  const handleEmptyAction = () => {
    closeMenu();
    onEmptyAction?.();
  };

  const activeOptionId =
    open && activeChoiceIndex >= 0 ? `${menuId}-option-${activeChoiceIndex}` : undefined;
  const menuVisible = open || menuClosing;

  return (
    <div className={styles.root} data-variant={variant} ref={rootRef} aria-label={containerLabel}>
      <div className={styles.picker} data-variant={variant}>
        <button
          className={styles.trigger}
          data-variant={variant}
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open ? "true" : "false"}
          aria-controls={menuVisible ? menuId : undefined}
          title={title ?? ariaLabel}
          disabled={disabledButton}
          ref={triggerRef}
          onPointerDown={(event) => {
            if (!disabledButton) {
              event.preventDefault();
            }
          }}
          onClick={toggleMenu}
        >
          <span className={styles.triggerText}>{displayLabel}</span>
          <ChevronDown size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>

      </div>
      {menuVisible ? (
        <FloatingLayer
          alignment={variant === "field" ? "end" : "start"}
          anchorRef={rootRef}
          className={styles.menu}
          floatingRef={menuRef}
          matchAnchorWidth={variant === "field"}
          placement={placement}
          data-state={menuClosing ? "closing" : "open"}
          data-variant={variant}
          aria-hidden={menuClosing ? "true" : undefined}
          inert={menuClosing ? true : undefined}
        >
          <div className={styles.menuLabel}>{menuLabel}</div>
          <label className={styles.searchBox}>
            <Search size={13} strokeWidth={1.9} aria-hidden="true" />
            <input
              aria-label="筛选模型"
              aria-activedescendant={activeOptionId}
              aria-controls={menuId}
              ref={searchInputRef}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </label>
          <div className={styles.optionList} id={menuId} role="listbox" aria-label={menuLabel}>
            {rows.length ? (
              rows.map((row) => {
                if (row.kind === "clear") {
                  const active = activeChoiceIndex === 0;
                  return (
                    <button
                      className={styles.option}
                      data-clear="true"
                      data-active={active ? "true" : undefined}
                      key="clear"
                      id={`${menuId}-option-0`}
                      type="button"
                      role="option"
                      aria-selected={!value ? "true" : "false"}
                      ref={(element) => setOptionRef(optionIdForClear(), element, optionRefs.current)}
                      onClick={clearValue}
                    >
                      <span>{clearLabel}</span>
                      {!value ? <Check size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
                    </button>
                  );
                }
                if (row.kind === "provider") {
                  return (
                    <div className={styles.providerHeader} key={`provider:${row.providerId}`}>
                      {row.providerName}
                    </div>
                  );
                }
                const key = optionKey(row.option.providerId, row.option.model);
                const selected = key === selectedKey;
                const active = row.choiceIndex === activeChoiceIndex;
                return (
                  <button
                    className={styles.option}
                    key={key}
                    id={`${menuId}-option-${row.choiceIndex}`}
                    type="button"
                    role="option"
                    aria-selected={selected ? "true" : "false"}
                    data-active={active ? "true" : undefined}
                    ref={(element) => setOptionRef(key, element, optionRefs.current)}
                    onClick={() => chooseModel(row.option)}
                  >
                    <span>{row.option.model}</span>
                    {selected ? <Check size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
                  </button>
                );
              })
            ) : (
              <EmptyState
                actionLabel={emptyActionLabel}
                actionSuffix={emptyActionSuffix}
                onAction={onEmptyAction ? handleEmptyAction : undefined}
                text={emptyText}
              />
            )}
          </div>
        </FloatingLayer>
      ) : null}
    </div>
  );
}

function EmptyState({
  actionLabel,
  actionSuffix,
  onAction,
  text,
}: {
  actionLabel?: string;
  actionSuffix?: string;
  onAction?: () => void;
  text: string;
}) {
  if (!actionLabel || !onAction) {
    return <div className={styles.empty}>{text}</div>;
  }
  return (
    <div className={styles.empty} data-action="true">
      <span>{text}</span>
      <button type="button" onClick={onAction}>
        {actionLabel}
      </button>
      {actionSuffix ? <span>{actionSuffix}</span> : null}
    </div>
  );
}

type ModelRow =
  | { kind: "clear" }
  | { kind: "provider"; providerId: string; providerName: string }
  | { kind: "model"; option: SearchableModelDropdownOption; choiceIndex: number };

function buildRows(options: SearchableModelDropdownOption[], clearable: boolean): ModelRow[] {
  const rows: ModelRow[] = clearable ? [{ kind: "clear" }] : [];
  let previousProviderId = "";
  const offset = clearable ? 1 : 0;
  options.forEach((option, optionIndex) => {
    if (option.providerId !== previousProviderId) {
      rows.push({ kind: "provider", providerId: option.providerId, providerName: option.providerName });
      previousProviderId = option.providerId;
    }
    rows.push({ kind: "model", option, choiceIndex: offset + optionIndex });
  });
  return rows;
}

function optionIdForClear(): string {
  return "__clear__";
}

function optionKey(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`;
}

function choiceIdAt(
  choiceIndex: number,
  options: SearchableModelDropdownOption[],
  clearable: boolean,
): string | null {
  if (clearable && choiceIndex === 0) {
    return optionIdForClear();
  }
  const option = options[choiceIndex - (clearable ? 1 : 0)];
  return option ? optionKey(option.providerId, option.model) : null;
}

function setOptionRef(
  key: string,
  element: HTMLButtonElement | null,
  optionRefs: Map<string, HTMLButtonElement>,
) {
  if (element) {
    optionRefs.set(key, element);
  } else {
    optionRefs.delete(key);
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
